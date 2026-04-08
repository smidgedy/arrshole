export interface ArrConfig {
  url: string;
  apiKey: string;
}

export interface StalledThresholdConfig {
  maxProgress: number; // 0–100
  stuckMs: number;
}

export interface Config {
  qbit: { url: string; username: string; password: string };
  sonarr: ArrConfig | null;
  radarr: ArrConfig | null;
  lidarr: ArrConfig | null;
  categoryMap: Map<string, string>;
  pollIntervalMs: number;
  metadataStuckMs: number;
  stalledThresholds: StalledThresholdConfig[];
  maxActionsPerCycle: number;
  dryRun: boolean;
  logLevel: string;
  stateFilePath: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

function parseIntStrict(value: string, name: string, min: number): number {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a valid number, got "${value}"`);
  }
  if (parsed < min) {
    throw new Error(`${name} must be at least ${min}`);
  }
  return parsed;
}

function validateUrl(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL: "${value}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use http or https, got "${parsed.protocol}"`);
  }
  return parsed.origin;
}

function loadArrConfig(urlKey: string, apiKeyKey: string): ArrConfig | null {
  const url = process.env[urlKey];
  const apiKey = process.env[apiKeyKey];

  if (url && apiKey) {
    return { url: validateUrl(url, urlKey), apiKey };
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

/**
 * Parse STALLED_THRESHOLDS env var.
 * Format: "maxPercent:hours,maxPercent:hours,..." sorted by maxPercent ascending.
 * Example: "10:1,90:12,100:24" means ≤10% → 1h, ≤90% → 12h, ≤100% → 24h.
 * The last entry must cover 100%.
 */
function parseStalledThresholds(raw: string): StalledThresholdConfig[] {
  const thresholds: StalledThresholdConfig[] = [];

  for (const entry of raw.split(",")) {
    const [percentStr, hoursStr] = entry.split(":").map((s) => s.trim());
    if (!percentStr || !hoursStr) {
      throw new Error(
        `Invalid STALLED_THRESHOLDS entry: "${entry}". Expected format: maxPercent:hours`,
      );
    }
    const maxProgress = parseFloat(percentStr);
    const hours = parseFloat(hoursStr);
    if (!Number.isFinite(maxProgress) || maxProgress < 0 || maxProgress > 100) {
      throw new Error(
        `Invalid progress percentage "${percentStr}" in STALLED_THRESHOLDS. Must be 0–100`,
      );
    }
    if (!Number.isFinite(hours) || hours <= 0) {
      throw new Error(
        `Invalid hours "${hoursStr}" in STALLED_THRESHOLDS. Must be a positive number`,
      );
    }
    thresholds.push({ maxProgress, stuckMs: hours * 60 * 60 * 1000 });
  }

  thresholds.sort((a, b) => a.maxProgress - b.maxProgress);

  if (thresholds.length === 0) {
    throw new Error("STALLED_THRESHOLDS must contain at least one entry");
  }
  if (thresholds[thresholds.length - 1].maxProgress < 100) {
    throw new Error(
      "STALLED_THRESHOLDS must include a final entry covering 100% (e.g. 100:24)",
    );
  }
  return thresholds;
}

export function loadConfig(): Config {
  const qbitUrl = validateUrl(requireEnv("QBIT_URL"), "QBIT_URL");
  const qbitUsername = requireEnv("QBIT_USERNAME");
  const qbitPassword = requireEnv("QBIT_PASSWORD");

  const sonarr = loadArrConfig("SONARR_URL", "SONARR_API_KEY");
  const radarr = loadArrConfig("RADARR_URL", "RADARR_API_KEY");
  const lidarr = loadArrConfig("LIDARR_URL", "LIDARR_API_KEY");

  if (!sonarr && !radarr && !lidarr) {
    throw new Error("At least one *arr app must be configured (SONARR, RADARR, or LIDARR)");
  }

  const pollIntervalSeconds = parseIntStrict(
    process.env.POLL_INTERVAL_SECONDS || "60", "POLL_INTERVAL_SECONDS", 10,
  );
  const metadataStuckMinutes = parseIntStrict(
    process.env.METADATA_STUCK_MINUTES || "10", "METADATA_STUCK_MINUTES", 1,
  );
  const maxActionsPerCycle = parseIntStrict(
    process.env.MAX_ACTIONS_PER_CYCLE || "5", "MAX_ACTIONS_PER_CYCLE", 1,
  );

  const stalledThresholds = parseStalledThresholds(
    process.env.STALLED_THRESHOLDS || "100:24",
  );

  const dryRunEnv = process.env.DRY_RUN;
  const dryRun = dryRunEnv?.toLowerCase() !== "false";

  return {
    qbit: { url: qbitUrl, username: qbitUsername, password: qbitPassword },
    sonarr,
    radarr,
    lidarr,
    categoryMap: buildCategoryMap(sonarr, radarr, lidarr),
    pollIntervalMs: pollIntervalSeconds * 1000,
    metadataStuckMs: metadataStuckMinutes * 60 * 1000,
    stalledThresholds,
    maxActionsPerCycle,
    dryRun,
    logLevel: process.env.LOG_LEVEL || "info",
    stateFilePath: process.env.STATE_FILE || "./arrshole-state.json",
  };
}
