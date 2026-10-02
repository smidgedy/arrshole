import "dotenv/config";
import { statSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig, type Config } from "./config.js";
import { createLogger } from "./logger.js";
import { QBitClient } from "./clients/qbittorrent.js";
import { ArrClient } from "./clients/arr-client.js";
import { Monitor } from "./monitor.js";
import { StateTracker } from "./state-tracker.js";
import { JunkTagger } from "./junk-tagger.js";

const { values: cli } = parseArgs({
  options: {
    now:     { type: "boolean", default: false },
    stalled: { type: "boolean", default: false },
    metadl:  { type: "boolean", default: false },
    rejects: { type: "boolean", default: false },
    taste:   { type: "boolean", default: false },
    below:   { type: "string" },
    above:   { type: "string" },
    help:    { type: "boolean", default: false },
  },
  strict: true,
});

if (cli.help) {
  console.log(`arrshole — stuck torrent monitor

Usage: node dist/index.js [options]

Daemon mode (default):
  Polls on an interval, applies configured thresholds.

One-shot mode:
  --now                Run once and exit (requires --stalled, --metadl, --rejects and/or --taste)
  --stalled            Include stalledDL torrents
  --metadl             Include metaDL/forcedMetaDL torrents
  --rejects            Reap *arr import-rejections (releases that downloaded then failed import)
  --taste              Run the taste model and apply its junk-tag plan (needs TASTE=true)
  --below <percent>    Only torrents below this completion % (exclusive)
  --above <percent>    Only torrents above this completion % (exclusive)

Examples:
  node dist/index.js --now --stalled --metadl
  node dist/index.js --now --rejects
  node dist/index.js --now --taste
  node dist/index.js --now --stalled --below 10
  node dist/index.js --now --stalled --above 90`);
  process.exit(0);
}

if (cli.now && !cli.stalled && !cli.metadl && !cli.rejects && !cli.taste) {
  console.error("--now requires at least one of --stalled, --metadl, --rejects, or --taste");
  process.exit(1);
}

if ((cli.stalled || cli.metadl || cli.rejects || cli.taste || cli.below || cli.above) && !cli.now) {
  console.error("--stalled, --metadl, --rejects, --taste, --below, and --above require --now");
  process.exit(1);
}

function parsePercent(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = parseFloat(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    console.error(`${name} must be a number between 0 and 100, got "${value}"`);
    process.exit(1);
  }
  return n;
}

const below = parsePercent(cli.below, "--below");
const above = parsePercent(cli.above, "--above");

// Warn if .env is readable by group/others
try {
  const mode = statSync(".env").mode & 0o777;
  if (mode & 0o044) {
    console.error(
      `FATAL: .env is readable by group/others (mode 0o${mode.toString(8)}). Run: chmod 600 .env`,
    );
    process.exit(1);
  }
} catch {
  /* .env may not exist when using EnvironmentFile */
}

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  console.error("Fatal: failed to load configuration:", (err as Error).message);
  process.exit(1);
}

const logger = createLogger(config.logLevel);

logger.info(
  {
    dryRun: config.dryRun,
    pollIntervalMs: config.pollIntervalMs,
    stalledThresholds: config.stalledThresholds.map((t) => ({
      maxProgress: t.maxProgress + "%",
      hours: t.stuckMs / 3600000,
    })),
    stateFilePath: config.stateFilePath,
    qbitUrl: config.qbit.url,
    nodeVersion: process.version,
    pid: process.pid,
  },
  "arrshole starting",
);

const qbit = new QBitClient(
  config.qbit.url,
  config.qbit.username,
  config.qbit.password,
  logger,
);

async function loginWithBackoff(): Promise<void> {
  const baseMs = 5_000;
  const maxMs = 300_000;
  let attempt = 0;
  for (;;) {
    try {
      await qbit.login();
      return;
    } catch (err) {
      attempt++;
      const delay = Math.min(baseMs * 2 ** Math.min(attempt - 1, 6), maxMs);
      logger.warn(
        { err, qbitUrl: config.qbit.url, attempt, retryInMs: delay },
        "qBittorrent unreachable at startup — retrying",
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

if (cli.now) {
  // One-shot: fail fast so scripts/cron don't hang on a sick qBit.
  try {
    await qbit.login();
  } catch (err) {
    logger.fatal(
      { err, qbitUrl: config.qbit.url },
      "Failed to connect to qBittorrent — is it running and reachable?",
    );
    process.exit(1);
  }
} else {
  // Daemon: retry forever. The poll loop already tolerates transient failures,
  // so we should never exit just because qBit is briefly down.
  await loginWithBackoff();
}
logger.info("qBittorrent authenticated");

const arrClients = new Map<string, ArrClient>();
if (config.sonarr) {
  arrClients.set("sonarr", new ArrClient("Sonarr", config.sonarr.url, config.sonarr.apiKey, "v3", logger));
}
if (config.radarr) {
  arrClients.set("radarr", new ArrClient("Radarr", config.radarr.url, config.radarr.apiKey, "v3", logger));
}
if (config.lidarr) {
  arrClients.set("lidarr", new ArrClient("Lidarr", config.lidarr.url, config.lidarr.apiKey, "v1", logger));
}

logger.info({ apps: [...arrClients.keys()] }, "*arr clients configured");

const stateTracker = new StateTracker(logger, config.stateFilePath);
stateTracker.loadFromDisk();

const monitor = new Monitor(qbit, arrClients, config.categoryMap, config, logger, stateTracker);

const junkTagger = config.taste
  ? new JunkTagger(config.taste, arrClients, config.dryRun, logger)
  : null;
if (cli.taste && !junkTagger) {
  console.error("--taste requires TASTE=true");
  process.exit(1);
}

process.on("unhandledRejection", (err) => {
  logger.fatal({ err, uptimeSeconds: Math.round(process.uptime()) }, "Unhandled rejection — exiting");
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err, uptimeSeconds: Math.round(process.uptime()) }, "Uncaught exception — exiting");
  process.exit(1);
});

if (cli.now) {
  const states = new Set<string>();
  if (cli.stalled) states.add("stalledDL");
  if (cli.metadl) { states.add("metaDL"); states.add("forcedMetaDL"); }

  try {
    if (states.size > 0) {
      await monitor.runOnce(states, below, above);
    }
    if (cli.rejects) {
      // One-shot reject reaping bypasses the env flag and the circuit breaker —
      // it's an explicit operator request to clear the current backlog.
      await monitor.scanImportRejects();
    }
    if (cli.taste && junkTagger) {
      await junkTagger.runOnce();
    }
  } catch (err) {
    logger.fatal({ err }, "One-shot run failed");
    process.exit(1);
  }
  process.exit(0);
} else {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      logger.info({ signal, uptimeSeconds: Math.round(process.uptime()) }, "Shutting down");
      Promise.all([monitor.stop(), junkTagger?.stop()]).then(() => process.exit(0), () => process.exit(1));
    });
  }

  monitor.start();
  junkTagger?.start();
}
