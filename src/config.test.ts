import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const VALID_ENV = {
  QBIT_URL: "http://localhost:8080",
  QBIT_USERNAME: "admin",
  QBIT_PASSWORD: "pass",
  SONARR_URL: "http://localhost:8989",
  SONARR_API_KEY: "abc123",
};

function setEnv(overrides: Record<string, string | undefined> = {}) {
  const env = { ...VALID_ENV, ...overrides };
  // Clear all relevant env vars first
  for (const key of Object.keys(VALID_ENV)) {
    delete process.env[key];
  }
  for (const key of [
    "RADARR_URL", "RADARR_API_KEY", "LIDARR_URL", "LIDARR_API_KEY",
    "POLL_INTERVAL_SECONDS", "METADATA_STUCK_MINUTES", "STALLED_THRESHOLDS",
    "MAX_ACTIONS_PER_CYCLE", "DRY_RUN", "LOG_LEVEL", "CATEGORY_MAP",
    "STATE_FILE",
  ]) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}

describe("loadConfig", () => {
  beforeEach(() => setEnv());

  it("loads valid config correctly", () => {
    const config = loadConfig();
    assert.equal(config.qbit.url, "http://localhost:8080");
    assert.equal(config.qbit.username, "admin");
    assert.ok(config.sonarr);
    assert.equal(config.sonarr.url, "http://localhost:8989");
    assert.equal(config.pollIntervalMs, 60000);
    assert.equal(config.metadataStuckMs, 10 * 60 * 1000);
    assert.equal(config.stalledThresholds.length, 1);
    assert.equal(config.stalledThresholds[0].maxProgress, 100);
    assert.equal(config.stalledThresholds[0].stuckMs, 24 * 60 * 60 * 1000);
    assert.equal(config.maxActionsPerCycle, 5);
    assert.equal(config.dryRun, true);
    assert.equal(config.stateFilePath, "./arrshole-state.json");
  });

  it("throws when QBIT_URL is missing", () => {
    delete process.env.QBIT_URL;
    assert.throws(() => loadConfig(), /QBIT_URL.*not set/);
  });

  it("throws when no *arr app is configured", () => {
    delete process.env.SONARR_URL;
    delete process.env.SONARR_API_KEY;
    assert.throws(() => loadConfig(), /At least one/);
  });

  it("throws when URL is set without API key", () => {
    process.env.RADARR_URL = "http://localhost:7878";
    assert.throws(() => loadConfig(), /RADARR_API_KEY.*missing/);
  });

  it("throws when API key is set without URL", () => {
    process.env.RADARR_API_KEY = "key123";
    assert.throws(() => loadConfig(), /RADARR_URL.*missing/);
  });

  it("throws on non-numeric POLL_INTERVAL_SECONDS", () => {
    process.env.POLL_INTERVAL_SECONDS = "abc";
    assert.throws(() => loadConfig(), /valid number/);
  });

  it("throws when POLL_INTERVAL_SECONDS is below 10", () => {
    process.env.POLL_INTERVAL_SECONDS = "5";
    assert.throws(() => loadConfig(), /at least 10/);
  });

  it("throws on invalid URL scheme", () => {
    process.env.QBIT_URL = "ftp://localhost:8080";
    assert.throws(() => loadConfig(), /http or https/);
  });

  it("throws on malformed URL", () => {
    process.env.QBIT_URL = "not-a-url";
    assert.throws(() => loadConfig(), /not a valid URL/);
  });

  it("parses CATEGORY_MAP correctly", () => {
    process.env.CATEGORY_MAP = "tv-sonarr:sonarr,movies:radarr";
    process.env.RADARR_URL = "http://localhost:7878";
    process.env.RADARR_API_KEY = "key";
    const config = loadConfig();
    assert.equal(config.categoryMap.get("tv-sonarr"), "sonarr");
    assert.equal(config.categoryMap.get("movies"), "radarr");
  });

  it("defaults DRY_RUN to true when unset", () => {
    const config = loadConfig();
    assert.equal(config.dryRun, true);
  });

  it("sets dryRun to false when DRY_RUN=false", () => {
    process.env.DRY_RUN = "false";
    const config = loadConfig();
    assert.equal(config.dryRun, false);
  });

  it("parses STALLED_THRESHOLDS correctly", () => {
    process.env.STALLED_THRESHOLDS = "10:1,90:12,100:24";
    const config = loadConfig();
    assert.equal(config.stalledThresholds.length, 3);
    assert.equal(config.stalledThresholds[0].maxProgress, 10);
    assert.equal(config.stalledThresholds[0].stuckMs, 1 * 60 * 60 * 1000);
    assert.equal(config.stalledThresholds[1].maxProgress, 90);
    assert.equal(config.stalledThresholds[1].stuckMs, 12 * 60 * 60 * 1000);
    assert.equal(config.stalledThresholds[2].maxProgress, 100);
    assert.equal(config.stalledThresholds[2].stuckMs, 24 * 60 * 60 * 1000);
  });

  it("throws on STALLED_THRESHOLDS without 100% coverage", () => {
    process.env.STALLED_THRESHOLDS = "50:12";
    assert.throws(() => loadConfig(), /covering 100%/);
  });

  it("throws on invalid STALLED_THRESHOLDS entry", () => {
    process.env.STALLED_THRESHOLDS = "bad";
    assert.throws(() => loadConfig(), /Expected format/);
  });

  it("uses STATE_FILE from env", () => {
    process.env.STATE_FILE = "/tmp/test-state.json";
    const config = loadConfig();
    assert.equal(config.stateFilePath, "/tmp/test-state.json");
  });

  it("builds default categoryMap from configured apps", () => {
    process.env.RADARR_URL = "http://localhost:7878";
    process.env.RADARR_API_KEY = "key";
    const config = loadConfig();
    assert.equal(config.categoryMap.get("sonarr"), "sonarr");
    assert.equal(config.categoryMap.get("radarr"), "radarr");
    assert.equal(config.categoryMap.has("lidarr"), false);
  });
});
