import "dotenv/config";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { QBitClient } from "./clients/qbittorrent.js";
import { SonarrClient } from "./clients/sonarr.js";
import { RadarrClient } from "./clients/radarr.js";
import { LidarrClient } from "./clients/lidarr.js";
import type { BaseArrClient } from "./clients/arr-client.js";
import { Monitor } from "./monitor.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);

logger.info(
  { dryRun: config.dryRun, pollIntervalMs: config.pollIntervalMs },
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

const arrClients = new Map<string, BaseArrClient>();
if (config.sonarr) {
  arrClients.set("sonarr", new SonarrClient(config.sonarr.url, config.sonarr.apiKey, logger));
}
if (config.radarr) {
  arrClients.set("radarr", new RadarrClient(config.radarr.url, config.radarr.apiKey, logger));
}
if (config.lidarr) {
  arrClients.set("lidarr", new LidarrClient(config.lidarr.url, config.lidarr.apiKey, logger));
}

logger.info({ apps: [...arrClients.keys()] }, "*arr clients configured");

const monitor = new Monitor(qbit, arrClients, config.categoryMap, config, logger);
monitor.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "Shutting down");
    monitor.stop();
    process.exit(0);
  });
}
