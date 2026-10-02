import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Logger } from "./logger.js";
import type { TasteConfig } from "./config.js";
import type { ArrClient } from "./clients/arr-client.js";

/** One tag change proposed by the taste model. `id` is the *arr library id. */
export interface TagChange {
  id: number;
  title: string;
  [key: string]: unknown;
}

export interface TastePlan {
  runId: number;
  apps: Record<string, { tagLabel: string; add: TagChange[]; remove: TagChange[]; metrics?: unknown }>;
}

/** Runs the taste model and returns its plan. Injectable for tests. */
export type PlanRunner = () => Promise<TastePlan>;

interface TasteState {
  lastSuccessAt?: number;
  lastAttemptAt?: number;
}

const KIND: Record<string, "movie" | "series"> = { radarr: "movie", sonarr: "series" };
const CHECK_EVERY_MS = 15 * 60_000;

/** Spawn `python -m arr_taste plan` and parse the JSON plan from stdout. */
export function pythonRunner(cfg: TasteConfig, logger: Logger): PlanRunner {
  return () =>
    new Promise((resolvePlan, reject) => {
      const cwd = resolve(cfg.cwd);
      execFile(
        resolve(cwd, cfg.python),
        ["-m", "arr_taste", "plan"],
        { cwd, timeout: cfg.timeoutMs, maxBuffer: 32 * 1024 * 1024, env: process.env },
        (err, stdout, stderr) => {
          for (const line of stderr.split("\n").filter(Boolean).slice(-20)) {
            logger.debug({ taste: line }, "taste model output");
          }
          if (err) {
            reject(new Error(`taste model failed: ${err.message}\n${stderr.split("\n").slice(-10).join("\n")}`));
            return;
          }
          try {
            resolvePlan(JSON.parse(stdout) as TastePlan);
          } catch {
            reject(new Error("taste model returned invalid JSON"));
          }
        },
      );
    });
}

/**
 * Periodically runs the taste model and applies its plan: add the `junk` tag to the
 * strongest deletion candidates, remove it where the model or the user (via `keep`)
 * says otherwise. Never deletes anything. Verdict detection and retraining happen in
 * the model, which reads the tags back on its next run.
 */
export class JunkTagger {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    private cfg: TasteConfig,
    private arrClients: Map<string, ArrClient>,
    private dryRun: boolean,
    private logger: Logger,
    private runner: PlanRunner = pythonRunner(cfg, logger),
    private now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (this.isDue()) void this.runOnce().catch(() => {});
    };
    tick();
    this.timer = setInterval(tick, CHECK_EVERY_MS);
  }

  /**
   * Stop scheduling. Deliberately doesn't wait for an in-flight model run (it can take
   * minutes); systemd stops the whole cgroup, and the next start simply re-runs it.
   */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isDue(): boolean {
    const s = this.readState();
    const t = this.now();
    if (s.lastAttemptAt && t - s.lastAttemptAt < this.cfg.retryMs) return false;
    return !s.lastSuccessAt || t - s.lastSuccessAt >= this.cfg.intervalMs;
  }

  /** Run the model and apply its plan once. Single-flight: concurrent calls share one run. */
  runOnce(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.run().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async run(): Promise<void> {
    const started = this.now();
    this.writeState({ ...this.readState(), lastAttemptAt: started });
    this.logger.info({ dryRun: this.dryRun }, "Taste run starting");
    let plan: TastePlan;
    try {
      plan = await this.runner();
    } catch (err) {
      this.logger.error({ err }, "Taste model run failed — will retry later");
      throw err;
    }
    await this.apply(plan);
    this.writeState({ lastAttemptAt: started, lastSuccessAt: started });
    this.logger.info({ runId: plan.runId, seconds: Math.round((this.now() - started) / 1000) }, "Taste run complete");
  }

  async apply(plan: TastePlan): Promise<void> {
    let budget = this.cfg.maxTagChanges;
    // Removals first: honouring `keep` matters more than adding new suggestions.
    for (const mode of ["remove", "add"] as const) {
      for (const [app, p] of Object.entries(plan.apps)) {
        const client = this.arrClients.get(app);
        const kind = KIND[app];
        if (!client || !kind) {
          this.logger.warn({ app }, "Taste plan for an app arrshole has no client for — skipped");
          continue;
        }
        const wanted = p[mode];
        const changes = wanted.slice(0, Math.max(0, budget));
        if (changes.length < wanted.length) {
          this.logger.warn(
            { app, mode, planned: wanted.length, applying: changes.length, maxTagChanges: this.cfg.maxTagChanges },
            "Tag change budget reached — remainder deferred to next run",
          );
        }
        budget -= changes.length;
        if (changes.length === 0) continue;

        const summary = changes.map((c) => ({ id: c.id, title: c.title, ...(mode === "remove" ? { reason: c.reason } : { score: c.score }) }));
        if (this.dryRun) {
          this.logger.info({ app, tag: p.tagLabel, changes: summary }, `[DRY RUN] Would ${mode} tag`);
          continue;
        }
        const tagId = await this.tagId(client, p.tagLabel, mode === "add");
        if (tagId === undefined) continue; // removing a tag that doesn't exist: nothing to do
        await client.editTag(kind, changes.map((c) => c.id), tagId, mode);
        this.logger.info({ app, tag: p.tagLabel, changes: summary, action: `tag_${mode}` }, `Tag ${mode === "add" ? "added" : "removed"}`);
      }
    }
  }

  private async tagId(client: ArrClient, label: string, create: boolean): Promise<number | undefined> {
    const existing = (await client.getTags()).get(label.toLowerCase());
    if (existing !== undefined || !create) return existing;
    const id = await client.createTag(label);
    this.logger.info({ app: client.name, label, id }, "Created tag");
    return id;
  }

  private readState(): TasteState {
    try {
      return JSON.parse(readFileSync(this.cfg.stateFilePath, "utf8")) as TasteState;
    } catch {
      return {};
    }
  }

  private writeState(s: TasteState): void {
    try {
      mkdirSync(dirname(this.cfg.stateFilePath), { recursive: true });
      const tmp = `${this.cfg.stateFilePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(s) + "\n", { mode: 0o600 });
      renameSync(tmp, this.cfg.stateFilePath);
    } catch (err) {
      this.logger.error({ err, path: this.cfg.stateFilePath }, "Failed to persist taste state");
    }
  }
}
