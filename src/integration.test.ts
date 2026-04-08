import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { QBitClient } from "./clients/qbittorrent.js";
import { ArrClient } from "./clients/arr-client.js";
import { Monitor } from "./monitor.js";
import { StateTracker } from "./state-tracker.js";
import type { Config } from "./config.js";
import { makeSilentLogger } from "./test-helpers.js";

const TEN_MINUTES = 10 * 60 * 1000;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    qbit: { url: "http://localhost:18080", username: "admin", password: "pass" },
    sonarr: { url: "http://localhost:18989", apiKey: "test-key" },
    radarr: null,
    lidarr: null,
    categoryMap: new Map([["sonarr", "sonarr"]]),
    pollIntervalMs: 60000,
    metadataStuckMs: TEN_MINUTES,
    stalledThresholds: [{ maxProgress: 100, stuckMs: TWENTY_FOUR_HOURS }],
    maxActionsPerCycle: 5,
    dryRun: true,
    logLevel: "silent",
    stateFilePath: "",
    ...overrides,
  };
}

describe("Integration: startup → poll cycle", () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof mock.fn>;

  beforeEach(() => {
    mockFetch = mock.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("full lifecycle: login → poll → detect stuck → dry-run log", async () => {
    const logger = makeSilentLogger();
    const config = makeConfig();

    // Mock qBit login
    mockFetch.mock.mockImplementation((url: string, init?: RequestInit) => {
      const urlStr = String(url);

      // qBit login
      if (urlStr.includes("/api/v2/auth/login")) {
        return Promise.resolve(new Response("Ok.", {
          status: 200,
          headers: { "Set-Cookie": "SID=test-session-id; Path=/" },
        }));
      }

      // qBit getTorrents
      if (urlStr.includes("/api/v2/torrents/info") && !urlStr.includes("hashes=")) {
        return Promise.resolve(Response.json([
          {
            hash: "int-test-hash-1",
            name: "Integration.Test.S01E01",
            state: "metaDL",
            category: "sonarr",
            added_on: 1700000000,
            time_active: 15 * 60, // 15 min — above threshold
            last_activity: 1700000000,
            progress: 0,
            dlspeed: 0,
            size: 1000000000,
          },
          {
            hash: "int-test-hash-2",
            name: "Integration.Test.S01E02",
            state: "downloading",
            category: "sonarr",
            added_on: 1700000000,
            time_active: 300,
            last_activity: 1700000000,
            progress: 0.5,
            dlspeed: 1000000,
            size: 1000000000,
          },
        ]));
      }

      // Fallback
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });

    // Create real clients pointing at mock
    const qbit = new QBitClient(config.qbit.url, config.qbit.username, config.qbit.password, logger);
    await qbit.login();

    const arrClients = new Map<string, ArrClient>();
    arrClients.set("sonarr", new ArrClient("Sonarr", config.sonarr!.url, config.sonarr!.apiKey, "v3", logger));

    const stateTracker = new StateTracker(logger, undefined);
    const monitor = new Monitor(qbit, arrClients, config.categoryMap, config, logger, stateTracker);

    // Run a single poll
    await monitor.poll();

    // Verify: login happened (1 call), then getTorrents (1 call) = 2 fetch calls minimum
    assert.ok(mockFetch.mock.callCount() >= 2, `Expected at least 2 fetch calls, got ${mockFetch.mock.callCount()}`);

    // Verify: the metaDL torrent was detected (dry-run, so no arr/qbit mutations)
    // In dry-run mode with metaDL, processStuckTorrent logs but doesn't call arr or delete
    const calls = mockFetch.mock.calls.map((c: any) => String(c.arguments[0]));
    const loginCalls = calls.filter((u: string) => u.includes("/auth/login"));
    const torrentCalls = calls.filter((u: string) => u.includes("/torrents/info"));
    assert.equal(loginCalls.length, 1, "Should have 1 login call");
    assert.equal(torrentCalls.length, 1, "Should have 1 getTorrents call");

    // No arr or qbit delete calls (dry-run mode)
    const arrCalls = calls.filter((u: string) => u.includes(":18989"));
    const deleteCalls = calls.filter((u: string) => u.includes("/torrents/delete"));
    assert.equal(arrCalls.length, 0, "Dry-run should not call arr");
    assert.equal(deleteCalls.length, 0, "Dry-run should not delete");
  });

  it("full lifecycle: login → poll → detect stalled → live process", async () => {
    const logger = makeSilentLogger();
    const config = makeConfig({ dryRun: false });
    let now = 1000000;

    mockFetch.mock.mockImplementation((url: string) => {
      const urlStr = String(url);

      if (urlStr.includes("/api/v2/auth/login")) {
        return Promise.resolve(new Response("Ok.", {
          status: 200,
          headers: { "Set-Cookie": "SID=test-sid; Path=/" },
        }));
      }

      if (urlStr.includes("/api/v2/torrents/info") && !urlStr.includes("hashes=")) {
        return Promise.resolve(Response.json([{
          hash: "stalled-hash",
          name: "Stalled.Show.S01E01",
          state: "stalledDL",
          category: "sonarr",
          added_on: 1700000000,
          time_active: 300,
          last_activity: 1700000000,
          progress: 0,
          dlspeed: 0,
          size: 1000000000,
        }]));
      }

      // qBit getTorrent (re-verify)
      if (urlStr.includes("/api/v2/torrents/info") && urlStr.includes("hashes=")) {
        return Promise.resolve(Response.json([{
          hash: "stalled-hash",
          name: "Stalled.Show.S01E01",
          state: "stalledDL",
          category: "sonarr",
          added_on: 1700000000,
          time_active: 300,
          last_activity: 1700000000,
          progress: 0,
          dlspeed: 0,
          size: 1000000000,
        }]));
      }

      // Sonarr queue
      if (urlStr.includes(":18989") && urlStr.includes("/queue")) {
        return Promise.resolve(Response.json({
          page: 1, pageSize: 200, totalRecords: 1,
          records: [{ id: 999, downloadId: "STALLED-HASH", title: "Stalled Show" }],
        }));
      }

      // Sonarr queue delete
      if (urlStr.includes(":18989") && urlStr.includes("/queue/999")) {
        return Promise.resolve(new Response(null, { status: 200 }));
      }

      // qBit delete
      if (urlStr.includes("/api/v2/torrents/delete")) {
        return Promise.resolve(new Response("Ok.", { status: 200 }));
      }

      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });

    const qbit = new QBitClient(config.qbit.url, config.qbit.username, config.qbit.password, logger);
    await qbit.login();

    const arrClients = new Map<string, ArrClient>();
    arrClients.set("sonarr", new ArrClient("Sonarr", config.sonarr!.url, config.sonarr!.apiKey, "v3", logger));

    const stateTracker = new StateTracker(logger, undefined, () => now);
    const monitor = new Monitor(qbit, arrClients, config.categoryMap, config, logger, stateTracker);

    // First poll — stalledDL is tracked but not yet stuck (needs two polls)
    await monitor.poll();

    // Advance time past threshold
    now += TWENTY_FOUR_HOURS + 1;

    // Second poll — torrent exceeds threshold, gets processed
    await monitor.poll();

    const calls = mockFetch.mock.calls.map((c: any) => String(c.arguments[0]));

    // Verify arr was notified (queue fetch + queue delete)
    const queueCalls = calls.filter((u: string) => u.includes(":18989") && u.includes("/queue"));
    assert.ok(queueCalls.length >= 2, "Should fetch queue and delete from it");

    // Verify qBit delete was called
    const deleteCalls = calls.filter((u: string) => u.includes("/torrents/delete"));
    assert.equal(deleteCalls.length, 1, "Should delete torrent from qBit");
  });
});
