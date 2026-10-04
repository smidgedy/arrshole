import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "./logger.js";
import type { ProwlarrClient, ProwlarrIndexer, ProwlarrIndexerStatus } from "./clients/prowlarr.js";
import type { JackettClient } from "./clients/jackett.js";

export type Status = "ok" | "warn" | "error" | "unknown";

export interface IndexerCheck {
  name: string;
  via: "prowlarr" | "jackett";
  status: Status;
  lastError: string | null;
  failingSince: string | null;
  autoFix: { action: "flaresolverr-tag" | "base-url-switch"; detail: string; at: string } | null;
  needsHuman: boolean;
}

export type FailureKind = "cloudflare" | "redirect" | "auth" | "other";

/** A failure that isn't fixable in code becomes "needs you" once it has lasted this long. */
const HUMAN_AFTER_MS = 24 * 3600_000;

/** Sort a test error into something the doctor can act on. */
export function classifyFailure(error: string): FailureKind {
  if (/cloudflare/i.test(error)) return "cloudflare";
  if (/redirected to https?:\/\//i.test(error)) return "redirect";
  if (/login|\b401\b|\b403\b|unauthori[sz]ed|forbidden|credential|password|captcha|cookie/i.test(error)) return "auth";
  return "other";
}

/**
 * If the site redirected to another of the definition's known URLs, return that URL.
 * Redirects to unknown hosts aren't followed: a changed layout needs a definition update.
 */
export function redirectTarget(error: string, indexerUrls: string[] = [], currentBaseUrl: string | null = null): string | null {
  const m = error.match(/redirected to (https?:\/\/[^\s/]+)/i);
  if (!m) return null;
  const host = new URL(m[1]).host.toLowerCase();
  const known = indexerUrls.find((u) => new URL(u).host.toLowerCase() === host);
  if (!known) return null;
  if (currentBaseUrl && new URL(currentBaseUrl).host.toLowerCase() === host) return null;
  return known;
}

export function baseUrlOf(indexer: ProwlarrIndexer): string | null {
  const v = indexer.fields.find((f) => f.name === "baseUrl")?.value;
  return typeof v === "string" && v ? v : null;
}

export function withFlareTag(indexer: ProwlarrIndexer, tagId: number): ProwlarrIndexer {
  return { ...indexer, tags: [...new Set([...indexer.tags, tagId])] };
}

export function withBaseUrl(indexer: ProwlarrIndexer, url: string): ProwlarrIndexer {
  const fields = indexer.fields.some((f) => f.name === "baseUrl")
    ? indexer.fields.map((f) => (f.name === "baseUrl" ? { ...f, value: url } : f))
    : [...indexer.fields, { name: "baseUrl", value: url }];
  return { ...indexer, fields };
}

/** Prowlarr is backing an indexer off if it's disabled now or failed in the last day. */
export function isBackingOff(s: ProwlarrIndexerStatus | undefined, now: number): boolean {
  if (!s) return false;
  if (s.disabledTill && Date.parse(s.disabledTill) > now) return true;
  return !!s.mostRecentFailure && now - Date.parse(s.mostRecentFailure) < 24 * 3600_000;
}

interface DoctorState {
  /** key = `${via}:${name}` */
  indexers: Record<string, { failingSince: string | null; lastError: string | null; autoFix: IndexerCheck["autoFix"] }>;
  lastRunAt?: string;
}

/**
 * Keeps tracker connections healthy without a human in the loop where it can:
 * tests the indexers Prowlarr is backing off, adds the FlareSolverr proxy tag when a
 * site is behind Cloudflare, switches to another of the definition's own URLs when a
 * site has moved, and flags the rest (logins, broken definitions) as needing a person.
 * Jackett indexers are tested and reported only. DRY_RUN applies to every change.
 */
export class IndexerDoctor {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private checks: IndexerCheck[] = [];
  private state: DoctorState;

  constructor(
    private prowlarr: ProwlarrClient | null,
    private jackett: JackettClient | null,
    private opts: { intervalMs: number; dryRun: boolean; stateFilePath: string },
    private logger: Logger,
    private now: () => number = Date.now,
  ) {
    this.state = this.readState();
  }

  start(firstDelayMs = 120_000): void {
    const loop = async () => {
      try {
        await this.runOnce();
      } catch (err) {
        this.logger.error({ err }, "Indexer doctor run failed");
      }
      this.timer = setTimeout(loop, this.opts.intervalMs);
    };
    this.timer = setTimeout(loop, firstDelayMs);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Latest per-indexer results (from the last full run, refreshed by `refreshProwlarrStatus`). */
  snapshot(): IndexerCheck[] {
    return this.checks;
  }

  lastRunAt(): string | null {
    return this.state.lastRunAt ?? null;
  }

  /**
   * Cheap refresh between full runs: an indexer Prowlarr has stopped backing off is ok
   * again; one it has started backing off becomes a warning until the next full run.
   */
  refreshProwlarrStatus(indexers: ProwlarrIndexer[], statuses: ProwlarrIndexerStatus[]): void {
    const byId = new Map(statuses.map((s) => [s.indexerId, s]));
    const t = this.now();
    for (const ix of indexers.filter((i) => i.enable)) {
      const backingOff = isBackingOff(byId.get(ix.id), t);
      const existing = this.checks.find((c) => c.via === "prowlarr" && c.name === ix.name);
      if (!existing) {
        this.checks.push(this.toCheck("prowlarr", ix.name, backingOff ? "warn" : "ok", null));
      } else if (!backingOff && existing.status !== "ok") {
        Object.assign(existing, this.toCheck("prowlarr", ix.name, "ok", null));
      } else if (backingOff && existing.status === "ok") {
        existing.status = "warn";
      }
    }
    this.checks = this.checks.filter((c) => c.via !== "prowlarr" || indexers.some((i) => i.enable && i.name === c.name));
  }

  async runOnce(): Promise<IndexerCheck[]> {
    const checks: IndexerCheck[] = [];
    if (this.prowlarr) checks.push(...(await this.runProwlarr(this.prowlarr)));
    if (this.jackett) checks.push(...(await this.runJackett(this.jackett)));
    this.checks = checks;
    this.state.lastRunAt = new Date(this.now()).toISOString();
    this.writeState();
    const failing = checks.filter((c) => c.status !== "ok");
    this.logger.info(
      { indexers: checks.length, failing: failing.length, needsHuman: failing.filter((c) => c.needsHuman).map((c) => `${c.via}:${c.name}`) },
      "Indexer doctor run complete",
    );
    return checks;
  }

  private async runProwlarr(client: ProwlarrClient): Promise<IndexerCheck[]> {
    const [indexers, statuses, proxies] = await Promise.all([
      client.getIndexers(), client.getIndexerStatuses(), client.getProxies(),
    ]);
    const flareTag = proxies.find((p) => /flaresolverr/i.test(p.implementation) && p.tags.length > 0)?.tags[0] ?? null;
    const byId = new Map(statuses.map((s) => [s.indexerId, s]));
    const t = this.now();
    const out: IndexerCheck[] = [];

    for (const ix of indexers.filter((i) => i.enable)) {
      const key = `prowlarr:${ix.name}`;
      const known = this.state.indexers[key];
      // Only test what Prowlarr is backing off, or what we last saw failing: tests hit the site.
      if (!isBackingOff(byId.get(ix.id), t) && !known?.failingSince) {
        out.push(this.toCheck("prowlarr", ix.name, "ok", null));
        continue;
      }
      let error = await client.testIndexer(ix);
      if (error) {
        const fixed = await this.tryFix(client, ix, error, flareTag);
        if (fixed) error = null;
      }
      out.push(this.toCheck("prowlarr", ix.name, error ? "error" : "ok", error));
    }
    return out;
  }

  /** Attempt the code-fixable repairs. Returns true when the indexer now tests OK. */
  private async tryFix(client: ProwlarrClient, ix: ProwlarrIndexer, error: string, flareTag: number | null): Promise<boolean> {
    const kind = classifyFailure(error);
    let candidate: ProwlarrIndexer | null = null;
    let fix: NonNullable<IndexerCheck["autoFix"]> | null = null;
    const at = new Date(this.now()).toISOString();

    if (kind === "cloudflare" && flareTag !== null && !ix.tags.includes(flareTag)) {
      candidate = withFlareTag(ix, flareTag);
      fix = { action: "flaresolverr-tag", detail: "routed through FlareSolverr (Cloudflare challenge)", at };
    } else if (kind === "redirect") {
      const target = redirectTarget(error, ix.indexerUrls, baseUrlOf(ix));
      if (target) {
        candidate = withBaseUrl(ix, target);
        fix = { action: "base-url-switch", detail: `switched to ${target}`, at };
      }
    }
    if (!candidate || !fix) return false;

    const retest = await client.testIndexer(candidate);
    if (retest) {
      this.logger.warn({ indexer: ix.name, fix: fix.action, error: retest }, "Indexer doctor: fix didn't help — leaving indexer unchanged");
      return false;
    }
    if (this.opts.dryRun) {
      this.logger.warn({ indexer: ix.name, fix: fix.action, detail: fix.detail }, "[DRY RUN] Indexer doctor would apply fix");
      return false;
    }
    await client.updateIndexer(candidate);
    this.state.indexers[`prowlarr:${ix.name}`] = { ...(this.state.indexers[`prowlarr:${ix.name}`] ?? { failingSince: null, lastError: null }), autoFix: fix };
    this.logger.warn({ action: "indexer_fixed", indexer: ix.name, fix: fix.action, detail: fix.detail }, "Indexer doctor fixed an indexer");
    return true;
  }

  private async runJackett(client: JackettClient): Promise<IndexerCheck[]> {
    const out: IndexerCheck[] = [];
    for (const ix of await client.getConfiguredIndexers()) {
      const error = await client.testIndexer(ix.id);
      out.push(this.toCheck("jackett", ix.name, error ? "error" : "ok", error));
    }
    return out;
  }

  /** Build a check and update the persisted failure history for it. */
  private toCheck(via: IndexerCheck["via"], name: string, status: Status, error: string | null): IndexerCheck {
    const key = `${via}:${name}`;
    const prev = this.state.indexers[key] ?? { failingSince: null, lastError: null, autoFix: null };
    const t = this.now();
    const failing = status === "error";
    const failingSince = failing ? (prev.failingSince ?? new Date(t).toISOString()) : null;
    this.state.indexers[key] = { failingSince, lastError: error ?? (status === "ok" ? null : prev.lastError), autoFix: prev.autoFix };
    const long = !!failingSince && t - Date.parse(failingSince) >= HUMAN_AFTER_MS;
    const kind = error ? classifyFailure(error) : null;
    return {
      name,
      via,
      status,
      lastError: this.state.indexers[key].lastError,
      failingSince,
      autoFix: prev.autoFix,
      needsHuman: failing && (kind === "auth" || long),
    };
  }

  private readState(): DoctorState {
    try {
      return JSON.parse(readFileSync(this.opts.stateFilePath, "utf8")) as DoctorState;
    } catch {
      return { indexers: {} };
    }
  }

  private writeState(): void {
    try {
      mkdirSync(dirname(this.opts.stateFilePath), { recursive: true });
      const tmp = `${this.opts.stateFilePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      renameSync(tmp, this.opts.stateFilePath);
    } catch (err) {
      this.logger.error({ err, path: this.opts.stateFilePath }, "Failed to persist indexer doctor state");
    }
  }
}
