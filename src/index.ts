import "dotenv/config";
import { statSync } from "node:fs";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { QBitClient } from "./clients/qbittorrent.js";
import { ArrClient } from "./clients/arr-client.js";
import { Monitor } from "./monitor.js";
import { StateTracker } from "./state-tracker.js";

// Warn if .env is readable by group/others
try {
  const mode = statSync(".env").mode & 0o777;
  if (mode & 0o044) {
    console.warn(
      `WARNING: .env is readable by group/others (mode 0o${mode.toString(8)}). Run: chmod 600 .env`,
    );
  }
} catch {
  /* .env may not exist when using EnvironmentFile */
}

const config = loadConfig();
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
await qbit.login();
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

process.on("unhandledRejection", (err) => {
  logger.fatal({ err, uptimeSeconds: Math.round(process.uptime()) }, "Unhandled rejection — exiting");
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err, uptimeSeconds: Math.round(process.uptime()) }, "Uncaught exception — exiting");
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info({ signal, uptimeSeconds: Math.round(process.uptime()) }, "Shutting down");
    monitor.stop().then(() => process.exit(0), () => process.exit(1));
  });
}

monitor.start();
