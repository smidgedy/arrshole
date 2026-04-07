export interface ArrConfig {
  url: string;
  apiKey: string;
}

export interface Config {
  qbit: { url: string; username: string; password: string };
  sonarr: ArrConfig | null;
  radarr: ArrConfig | null;
  lidarr: ArrConfig | null;
  categoryMap: Map<string, string>;
  pollIntervalMs: number;
  metadataStuckMs: number;
  stalledStuckMs: number;
  maxActionsPerCycle: number;
  dryRun: boolean;
  logLevel: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

function loadArrConfig(urlKey: string, apiKeyKey: string): ArrConfig | null {
  const url = process.env[urlKey];
  const apiKey = process.env[apiKeyKey];

  if (url && apiKey) {
    return { url: url.replace(/\/+$/, ""), apiKey };
  }
  if (url && !apiKey) {
    throw new Error(`${urlKey} is set but ${apiKeyKey} is missing`);
  }
  if (!url && apiKey) {
    throw new Error(`${apiKeyKey} is set but ${urlKey} is missing`);
  }
  return null;
}

function buildCategoryMap(
  sonarr: ArrConfig | null,
  radarr: ArrConfig | null,
  lidarr: ArrConfig | null,
): Map<string, string> {
  const map = new Map<string, string>();

  const envMap = process.env.CATEGORY_MAP;
  if (envMap) {
    for (const pair of envMap.split(",")) {
      const [category, app] = pair.split(":").map((s) => s.trim().toLowerCase());
      if (!category || !app) {
        throw new Error(`Invalid CATEGORY_MAP entry: "${pair}". Expected format: category:app`);
      }
      if (!["sonarr", "radarr", "lidarr"].includes(app)) {
        throw new Error(`Invalid app "${app}" in CATEGORY_MAP. Must be sonarr, radarr, or lidarr`);
      }
      map.set(category, app);
    }
  } else {
    if (sonarr) map.set("sonarr", "sonarr");
    if (radarr) map.set("radarr", "radarr");
    if (lidarr) map.set("lidarr", "lidarr");
  }

  return map;
}

export function loadConfig(): Config {
  const qbitUrl = requireEnv("QBIT_URL").replace(/\/+$/, "");
  const qbitUsername = requireEnv("QBIT_USERNAME");
  const qbitPassword = requireEnv("QBIT_PASSWORD");

  const sonarr = loadArrConfig("SONARR_URL", "SONARR_API_KEY");
  const radarr = loadArrConfig("RADARR_URL", "RADARR_API_KEY");
  const lidarr = loadArrConfig("LIDARR_URL", "LIDARR_API_KEY");

  if (!sonarr && !radarr && !lidarr) {
    throw new Error("At least one *arr app must be configured (SONARR, RADARR, or LIDARR)");
  }

  const pollIntervalSeconds = parseInt(process.env.POLL_INTERVAL_SECONDS || "60", 10);
  if (pollIntervalSeconds < 10) {
    throw new Error("POLL_INTERVAL_SECONDS must be at least 10");
  }

  const metadataStuckMinutes = parseInt(process.env.METADATA_STUCK_MINUTES || "10", 10);
  const stalledStuckHours = parseInt(process.env.STALLED_STUCK_HOURS || "24", 10);
  const maxActionsPerCycle = parseInt(process.env.MAX_ACTIONS_PER_CYCLE || "5", 10);

  const dryRunEnv = process.env.DRY_RUN;
  const dryRun = dryRunEnv !== "false";

  return {
    qbit: { url: qbitUrl, username: qbitUsername, password: qbitPassword },
    sonarr,
    radarr,
    lidarr,
    categoryMap: buildCategoryMap(sonarr, radarr, lidarr),
    pollIntervalMs: pollIntervalSeconds * 1000,
    metadataStuckMs: metadataStuckMinutes * 60 * 1000,
    stalledStuckMs: stalledStuckHours * 60 * 60 * 1000,
    maxActionsPerCycle,
    dryRun,
    logLevel: process.env.LOG_LEVEL || "info",
  };
}
