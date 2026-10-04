import { execFile } from "node:child_process";
import { promises as dns } from "node:dns";
import { statfs } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { Logger } from "./logger.js";
import type { QBitClient } from "./clients/qbittorrent.js";
import type { ProwlarrClient } from "./clients/prowlarr.js";
import type { IndexerDoctor, IndexerCheck, Status } from "./indexer-doctor.js";

/** The snapshot served at /api/health — see docs/health-api.md. */
export interface Health {
  generatedAt: string;
  overall: Status;
  chain: Check[];
  network: Check[];
  indexers: IndexerCheck[];
}

export interface Check {
  id: string;
  name: string;
  stage: string;
  status: Status;
  summary: string;
  details: string[];
  metrics: Record<string, number | string | boolean | null>;
  url: string | null;
  checkedAt: string;
}

export interface HealthConfig {
  port: number;
  intervalMs: number;
  arrs: Array<{ id: string; name: string; url: string; apiKey: string; apiVersion: "v1" | "v3" }>;
  prowlarrUrl: string | null;
  jackettUrl: string | null;
  flaresolverrUrl: string | null;
  tdarrUrl: string | null;
  plexUrl: string | null;
  plexToken: string | null;
  qbitUrl: string;
  languarrgeUrl: string | null;
  languarrgeDb: string | null;
  drivepoolPath: string | null;
  /** Below this much free space the pool is a warning (the 1 TB goal); a quarter of it is an error. */
  drivepoolTargetFreeBytes: number;
  tasteStateFile: string | null;
  pollIntervalMs: number;
  dryRun: boolean;
  tailscaleRouter: { host: string; port: number } | null;
  gateway: { host: string; port: number } | null;
  netshPath: string | null;
}

export interface HealthDeps {
  qbit: QBitClient;
  prowlarr: ProwlarrClient | null;
  doctor: IndexerDoctor | null;
  lastCycleAt: () => number | null;
}

const TIMEOUT = 15_000;
const RANK: Record<Status, number> = { ok: 0, unknown: 1, warn: 2, error: 3 };

export function worst(statuses: Status[]): Status {
  return statuses.reduce<Status>((w, s) => (RANK[s] > RANK[w] ? s : w), "ok");
}

/** *arr health messages worth surfacing. TheTVDB dropping a series is routine noise. */
export function arrHealthDetails(items: Array<{ type: string; message: string }>): { status: Status; details: string[] } {
  const relevant = items.filter((i) => !/removed from TheTVDB/i.test(i.message));
  const status: Status = relevant.some((i) => i.type === "error") ? "error" : relevant.length ? "warn" : "ok";
  return { status, details: relevant.map((i) => i.message) };
}

export function drivepoolStatus(freeBytes: number, targetFreeBytes: number): Status {
  if (freeBytes < targetFreeBytes / 4) return "error";
  return freeBytes < targetFreeBytes ? "warn" : "ok";
}

/** qBittorrent seen from the internet at the home WAN address means it's bypassing PIA. */
export function vpnStatus(torrentIp: string | null | undefined, wanIp: string | null): { status: Status; summary: string } {
  if (!torrentIp) return { status: "unknown", summary: "qBittorrent hasn't reported its external IP yet" };
  if (!wanIp) return { status: "unknown", summary: "home WAN IP unknown (internet check failed)" };
  return torrentIp === wanIp
    ? { status: "error", summary: `qBittorrent is NOT on the VPN: peers see the home IP ${wanIp}` }
    : { status: "ok", summary: `qBittorrent exits via ${torrentIp} (home is ${wanIp})` };
}

/** Parse `netsh interface portproxy show v4tov4` into listen port → connect address. */
export function parsePortproxy(output: string): Array<{ listenPort: number; connectAddress: string; connectPort: number }> {
  const rules = [];
  for (const line of output.split(/\r?\n/)) {
    const m = line.trim().match(/^(\S+)\s+(\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+)$/);
    if (m) rules.push({ listenPort: Number(m[2]), connectAddress: m[3], connectPort: Number(m[4]) });
  }
  return rules;
}

export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function tcpPing(host: string, port: number, timeout = 5000): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const socket = connect({ host, port, timeout });
    socket.once("connect", () => { socket.destroy(); resolve(Math.round(performance.now() - started)); });
    socket.once("timeout", () => { socket.destroy(); reject(new Error(`no answer from ${host}:${port}`)); });
    socket.once("error", (err) => { socket.destroy(); reject(err); });
  });
}

async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

/**
 * Builds a health snapshot of the whole media chain and the network on a timer and
 * serves the latest one over HTTP. Read-only: never changes anything it checks.
 */
export class HealthMonitor {
  private latest: Health | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private server: Server | null = null;
  private wanIp: string | null = null;

  constructor(private cfg: HealthConfig, private deps: HealthDeps, private logger: Logger) {}

  start(): void {
    const loop = async () => {
      try {
        this.latest = await this.collect();
      } catch (err) {
        this.logger.error({ err }, "Health snapshot failed");
      }
      this.timer = setTimeout(loop, this.cfg.intervalMs);
    };
    void loop();
    this.server = createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "no-store");
      if (req.method === "GET" && req.url === "/api/health") {
        if (!this.latest) {
          res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "first snapshot not ready" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(this.latest));
        return;
      }
      if (req.method === "GET" && req.url === "/healthz") {
        res.writeHead(200).end("ok");
        return;
      }
      res.writeHead(404).end();
    });
    this.server.on("error", (err) => this.logger.error({ err, port: this.cfg.port }, "Health server error"));
    this.server.listen(this.cfg.port, "0.0.0.0", () => this.logger.info({ port: this.cfg.port }, "Health API listening"));
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  snapshot(): Health | null {
    return this.latest;
  }

  async collect(): Promise<Health> {
    // The internet check runs first: the VPN check compares against the WAN IP it finds.
    const internet = await this.safe("internet", "Internet", "internet", null, () => this.checkInternet());
    const qbitState = await this.deps.qbit.getServerState().catch(() => null);
    const [chain, network] = await Promise.all([
      Promise.all(this.chainChecks(qbitState)),
      Promise.all(this.networkChecks(qbitState)),
    ]);
    const networkAll = [internet, ...network];
    const indexers = this.deps.doctor?.snapshot() ?? [];
    return {
      generatedAt: new Date().toISOString(),
      overall: worst([...chain, ...networkAll].map((c) => c.status)),
      chain,
      network: networkAll,
      indexers,
    };
  }

  private chainChecks(qs: Awaited<ReturnType<QBitClient["getServerState"]>> | null): Array<Promise<Check>> {
    const c = this.cfg;
    const checks: Array<Promise<Check>> = [];
    if (c.prowlarrUrl && this.deps.prowlarr) checks.push(this.safe("prowlarr", "Prowlarr", "indexers", c.prowlarrUrl, () => this.checkProwlarr()));
    if (c.jackettUrl) checks.push(this.safe("jackett", "Jackett", "indexers", c.jackettUrl, () => this.checkJackett()));
    if (c.flaresolverrUrl) checks.push(this.safe("flaresolverr", "FlareSolverr", "indexers", null, () => this.checkFlaresolverr()));
    for (const a of c.arrs) checks.push(this.safe(a.id, a.name, "arr", a.url, () => this.checkArr(a)));
    checks.push(this.safe("qbittorrent", "qBittorrent", "download", c.qbitUrl, () => this.checkQbit(qs)));
    if (c.drivepoolPath) checks.push(this.safe("drivepool", "DrivePool (J:)", "storage", null, () => this.checkDrivepool()));
    if (c.languarrgeUrl) checks.push(this.safe("languarrge", "languarrge", "processing", null, () => this.checkLanguarrge()));
    if (c.tdarrUrl) checks.push(this.safe("tdarr", "Tdarr", "processing", c.tdarrUrl, () => this.checkTdarr()));
    if (c.plexUrl) checks.push(this.safe("plex", "Plex", "playback", `${c.plexUrl}/web`, () => this.checkPlex()));
    checks.push(this.safe("arrshole", "arrshole", "maintenance", null, async () => this.checkSelf()));
    return checks;
  }

  private networkChecks(qs: Awaited<ReturnType<QBitClient["getServerState"]>> | null): Array<Promise<Check>> {
    const c = this.cfg;
    const checks: Array<Promise<Check>> = [
      this.safe("dns", "DNS", "internet", null, () => this.checkDns()),
      this.safe("vpn", "VPN (PIA)", "vpn", null, async () => {
        const v = vpnStatus(qs?.last_external_address_v4, this.wanIp);
        return { ...v, details: [], metrics: { torrentIp: qs?.last_external_address_v4 ?? null, wanIp: this.wanIp } };
      }),
      this.safe("torrent-connectivity", "Torrent connectivity", "vpn", null, () => this.checkTorrentConnectivity(qs)),
    ];
    if (c.tailscaleRouter) {
      const { host, port } = c.tailscaleRouter;
      checks.push(this.safe("tailscale-router", "Tailscale (via smidge-desktop)", "remote", null, async () => {
        try {
          const ms = await tcpPing(host, port);
          return { status: "ok", summary: `subnet router ${host} answering in ${ms} ms`, details: [], metrics: { latencyMs: ms } };
        } catch (err) {
          return { status: "warn", summary: `subnet router ${host} not answering — remote access is down`, details: [(err as Error).message], metrics: { latencyMs: null } };
        }
      }));
    }
    if (c.netshPath) checks.push(this.safe("wsl-portproxy", "WSL port forwards", "lan", null, () => this.checkPortproxy()));
    if (c.gateway) {
      const { host, port } = c.gateway;
      checks.push(this.safe("gateway", "LAN gateway", "lan", null, async () => {
        const ms = await tcpPing(host, port);
        return { status: "ok", summary: `${host} answering in ${ms} ms`, details: [], metrics: { latencyMs: ms } };
      }));
    }
    return checks;
  }

  /** Run one check; an exception becomes an error result rather than breaking the snapshot. */
  private async safe(
    id: string, name: string, stage: string, url: string | null,
    fn: () => Promise<Pick<Check, "status" | "summary" | "details" | "metrics">>,
  ): Promise<Check> {
    const checkedAt = new Date().toISOString();
    try {
      return { id, name, stage, url, checkedAt, ...(await fn()) };
    } catch (err) {
      return { id, name, stage, url, checkedAt, status: "error", summary: `unreachable: ${(err as Error).message}`, details: [], metrics: {} };
    }
  }

  private async checkInternet() {
    const started = performance.now();
    const { ip } = await getJson<{ ip: string }>("https://api.ipify.org?format=json");
    const ms = Math.round(performance.now() - started);
    this.wanIp = ip;
    return { status: (ms > 2000 ? "warn" : "ok") as Status, summary: `online · ${ms} ms`, details: [], metrics: { latencyMs: ms, wanIp: ip } };
  }

  private async checkDns() {
    const started = performance.now();
    await Promise.all([dns.resolve4("one.one.one.one"), dns.resolve4("github.com")]);
    const ms = Math.round(performance.now() - started);
    return { status: (ms > 1000 ? "warn" : "ok") as Status, summary: `resolving · ${ms} ms`, details: [], metrics: { resolveMs: ms } };
  }

  private async checkTorrentConnectivity(qs: Awaited<ReturnType<QBitClient["getServerState"]>> | null) {
    if (!qs) throw new Error("qBittorrent not answering");
    const listenPort = await this.deps.qbit.getListenPort().catch(() => null);
    const status: Status = qs.connection_status === "connected" ? "ok" : qs.connection_status === "firewalled" ? "warn" : "error";
    const summary = qs.connection_status === "connected"
      ? `connectable on port ${listenPort ?? "?"} · ${qs.dht_nodes} DHT nodes`
      : qs.connection_status === "firewalled"
        ? `firewalled: incoming peers can't reach port ${listenPort ?? "?"} (check PIA port forwarding)`
        : "disconnected";
    return { status, summary, details: [], metrics: { connection: qs.connection_status, listenPort, dhtNodes: qs.dht_nodes } };
  }

  private async checkPortproxy() {
    const out = await new Promise<string>((resolve, reject) =>
      execFile(this.cfg.netshPath!, ["interface", "portproxy", "show", "v4tov4"], { timeout: TIMEOUT }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
    ).catch((err: Error) => { throw new Error(`can't run netsh from WSL (${err.message})`); });
    const wslIp = networkInterfaces().eth0?.find((a) => a.family === "IPv4")?.address ?? null;
    const rules = parsePortproxy(out);
    const stale = rules.filter((r) => r.connectAddress !== wslIp);
    return {
      status: (stale.length ? "error" : "ok") as Status,
      summary: stale.length
        ? `${stale.length} forward(s) point at an old WSL IP: ports ${stale.map((r) => r.listenPort).join(", ")}`
        : `${rules.length} forwards point at ${wslIp}`,
      details: rules.map((r) => `${r.listenPort} → ${r.connectAddress}:${r.connectPort}`),
      metrics: { wslIp, stalePorts: stale.map((r) => r.listenPort).join(",") },
    };
  }

  private async checkProwlarr() {
    const client = this.deps.prowlarr!;
    const [{ version }, indexers, statuses] = await Promise.all([client.getVersion(), client.getIndexers(), client.getIndexerStatuses()]);
    this.deps.doctor?.refreshProwlarrStatus(indexers, statuses);
    const mine = (this.deps.doctor?.snapshot() ?? []).filter((c) => c.via === "prowlarr");
    const failing = mine.filter((c) => c.status !== "ok");
    const human = mine.filter((c) => c.needsHuman);
    const fixed = mine.filter((c) => c.autoFix);
    const enabled = indexers.filter((i) => i.enable).length;
    return {
      status: (human.length ? "warn" : failing.length > enabled / 2 ? "error" : failing.length ? "warn" : "ok") as Status,
      summary: `${enabled - failing.length}/${enabled} indexers working${human.length ? ` · ${human.length} need you` : ""}`,
      details: failing.map((c) => `${c.name}: ${c.lastError ?? "backing off"}`),
      metrics: { indexers: enabled, failing: failing.length, autoFixed: fixed.length, needsHuman: human.length, version },
    };
  }

  private async checkJackett() {
    const r = await fetch(`${this.cfg.jackettUrl}/UI/Login`, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT) });
    if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
    const mine = (this.deps.doctor?.snapshot() ?? []).filter((c) => c.via === "jackett");
    const failing = mine.filter((c) => c.status !== "ok");
    return {
      status: (failing.length ? "warn" : "ok") as Status,
      summary: mine.length ? `${mine.length - failing.length}/${mine.length} indexers working` : "up",
      details: failing.map((c) => `${c.name}: ${c.lastError ?? "failing"}`),
      metrics: { indexers: mine.length, failing: failing.length },
    };
  }

  private async checkFlaresolverr() {
    const { msg, version } = await getJson<{ msg: string; version: string }>(`${this.cfg.flaresolverrUrl}/`);
    const up = /ready/i.test(msg);
    return { status: (up ? "ok" : "error") as Status, summary: up ? `ready · v${version}` : msg, details: [], metrics: { up, version } };
  }

  private async checkArr(a: HealthConfig["arrs"][number]) {
    const h = { headers: { "X-Api-Key": a.apiKey } };
    const base = `${a.url}/api/${a.apiVersion}`;
    const [status, health, queue] = await Promise.all([
      getJson<{ version: string }>(`${base}/system/status`, h),
      getJson<Array<{ type: string; message: string }>>(`${base}/health`, h),
      getJson<{ totalCount: number }>(`${base}/queue/status`, h),
    ]);
    const { status: s, details } = arrHealthDetails(health);
    return {
      status: s,
      summary: `${queue.totalCount} in queue${details.length ? ` · ${details.length} warning${details.length > 1 ? "s" : ""}` : ""}`,
      details,
      metrics: { queue: queue.totalCount, healthWarnings: details.length, version: status.version },
    };
  }

  private async checkQbit(qs: Awaited<ReturnType<QBitClient["getServerState"]>> | null) {
    if (!qs) throw new Error("qBittorrent not answering");
    const torrents = await this.deps.qbit.getTorrents();
    const count = (states: string[]) => torrents.filter((t) => states.includes(t.state)).length;
    const downloading = count(["downloading", "forcedDL", "metaDL", "forcedMetaDL"]);
    const stalled = count(["stalledDL"]);
    const seeding = count(["uploading", "stalledUP", "forcedUP"]);
    const lowDisk = qs.free_space_on_disk < 50 * 1024 ** 3;
    return {
      status: (qs.connection_status === "disconnected" ? "error" : lowDisk || qs.connection_status === "firewalled" ? "warn" : "ok") as Status,
      summary: `${downloading} downloading · ${formatBytes(qs.dl_info_speed)}/s down · ${formatBytes(qs.up_info_speed)}/s up`,
      details: [
        ...(stalled ? [`${stalled} stalled`] : []),
        ...(lowDisk ? [`only ${formatBytes(qs.free_space_on_disk)} free on the torrent disk`] : []),
      ],
      metrics: {
        downloading, stalled, seeding,
        dlBytesPerSec: qs.dl_info_speed, upBytesPerSec: qs.up_info_speed,
        connection: qs.connection_status, torrentDiskFreeBytes: qs.free_space_on_disk,
      },
    };
  }

  private async checkDrivepool() {
    const s = await statfs(this.cfg.drivepoolPath!);
    const free = s.bavail * s.bsize;
    const total = s.blocks * s.bsize;
    const target = this.cfg.drivepoolTargetFreeBytes;
    return {
      status: drivepoolStatus(free, target),
      summary: `${formatBytes(free)} free of ${formatBytes(total)} (goal ${formatBytes(target)})`,
      details: [],
      metrics: { freeBytes: free, totalBytes: total, targetFreeBytes: target },
    };
  }

  private async checkLanguarrge() {
    const r = await fetch(`${this.cfg.languarrgeUrl}/healthz`, { signal: AbortSignal.timeout(TIMEOUT) });
    const receiverUp = r.ok;
    let queued: number | null = null;
    let failed: number | null = null;
    if (this.cfg.languarrgeDb) {
      const db = new DatabaseSync(this.cfg.languarrgeDb, { readOnly: true });
      try {
        queued = (db.prepare("SELECT count(*) AS n FROM jobs WHERE state IN ('pending','running')").get() as { n: number }).n;
        const dayAgo = Date.now() / 1000 - 86400;
        failed = (db.prepare("SELECT count(*) AS n FROM jobs WHERE state = 'failed' AND finished_at > ?").get(dayAgo) as { n: number }).n;
      } finally {
        db.close();
      }
    }
    return {
      status: (!receiverUp ? "error" : failed ? "warn" : "ok") as Status,
      summary: receiverUp ? `receiver up · ${queued ?? "?"} queued${failed ? ` · ${failed} failed today` : ""}` : `receiver down (HTTP ${r.status})`,
      details: [],
      metrics: { receiverUp, queued, failed },
    };
  }

  private async checkTdarr() {
    const url = this.cfg.tdarrUrl!;
    const statsRaw = await getJson<unknown>(`${url}/api/v2/cruddb`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { collection: "StatisticsJSONDB", mode: "getAll" } }),
    });
    const stats = (Array.isArray(statsRaw) ? statsRaw[0] : statsRaw) as Record<string, number>;
    const nodes = await getJson<Record<string, { nodeName: string; workers?: Record<string, unknown> }>>(`${url}/api/v2/get-nodes`);
    const names = Object.values(nodes).map((n) => n.nodeName);
    const workersActive = Object.values(nodes).reduce((n, node) => n + Object.keys(node.workers ?? {}).length, 0);
    const errors = stats.table3Count ?? 0;
    const healthErrors = stats.table6Count ?? 0;
    return {
      status: (names.length === 0 ? "error" : errors || healthErrors ? "warn" : "ok") as Status,
      summary: `${stats.table1Count ?? 0} queued · ${workersActive} working on ${names.length} node${names.length === 1 ? "" : "s"}`,
      details: [
        ...(errors ? [`${errors} transcode errors`] : []),
        ...(healthErrors ? [`${healthErrors} health-check errors`] : []),
      ],
      metrics: { queue: stats.table1Count ?? 0, transcodeErrors: errors, healthErrors, nodesOnline: names.length, nodes: names.join(","), workersActive },
    };
  }

  private async checkPlex() {
    const h = { headers: { Accept: "application/json" } };
    const id = await getJson<{ MediaContainer: { version: string } }>(`${this.cfg.plexUrl}/identity`, h);
    let sessions: number | null = null;
    if (this.cfg.plexToken) {
      const s = await getJson<{ MediaContainer: { size: number } }>(`${this.cfg.plexUrl}/status/sessions?X-Plex-Token=${encodeURIComponent(this.cfg.plexToken)}`, h);
      sessions = s.MediaContainer.size;
    }
    return {
      status: "ok" as Status,
      summary: `up · ${sessions ?? "?"} streaming`,
      details: [],
      metrics: { up: true, sessions, version: id.MediaContainer.version },
    };
  }

  private checkSelf() {
    const last = this.deps.lastCycleAt();
    let tasteLast: number | null = null;
    if (this.cfg.tasteStateFile) {
      try {
        tasteLast = (JSON.parse(readFileSync(this.cfg.tasteStateFile, "utf8")) as { lastSuccessAt?: number }).lastSuccessAt ?? null;
      } catch { /* not run yet */ }
    }
    const stale = last === null || Date.now() - last > 3 * this.cfg.pollIntervalMs + 60_000;
    return {
      status: (stale ? "warn" : "ok") as Status,
      summary: last ? `last cycle ${Math.round((Date.now() - last) / 1000)}s ago${this.cfg.dryRun ? " · DRY RUN" : ""}` : "no cycle completed yet",
      details: this.deps.doctor?.lastRunAt() ? [`indexer doctor last ran ${this.deps.doctor.lastRunAt()}`] : [],
      metrics: {
        lastCycleAt: last ? new Date(last).toISOString() : null,
        junkTaggerLastRunAt: tasteLast ? new Date(tasteLast).toISOString() : null,
        dryRun: this.cfg.dryRun,
      },
    };
  }
}
