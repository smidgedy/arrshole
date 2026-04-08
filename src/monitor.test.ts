import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { Monitor } from "./monitor.js";
import { StateTracker } from "./state-tracker.js";
import type { Config } from "./config.js";
import type { QBitTorrent, ArrQueueRecord } from "./types.js";
import { makeSilentLogger } from "./test-helpers.js";

const TEN_MINUTES = 10 * 60 * 1000;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    qbit: { url: "http://localhost:8080", username: "admin", password: "pass" },
    sonarr: { url: "http://localhost:8989", apiKey: "key" },
    radarr: null,
    lidarr: null,
    categoryMap: new Map([["sonarr", "sonarr"]]),
    pollIntervalMs: 60000,
    metadataStuckMs: TEN_MINUTES,
    stalledThresholds: [{ maxProgress: 100, stuckMs: TWENTY_FOUR_HOURS }],
    maxActionsPerCycle: 5,
    dryRun: false,
    logLevel: "silent",
    stateFilePath: "",
    ...overrides,
  };
}

function makeTorrent(overrides: Partial<QBitTorrent> = {}): QBitTorrent {
  return {
    hash: "abc123",
    name: "Test.Torrent.S01E01",
    state: "metaDL",
    category: "sonarr",
    added_on: 1700000000,
    time_active: 0,
    last_activity: 1700000000,
    progress: 0,
    dlspeed: 0,
    size: 1000000000,
    ...overrides,
  };
}

// A metaDL torrent with time_active above the 10-minute threshold
function makeStuckMetaDL(overrides: Partial<QBitTorrent> = {}): QBitTorrent {
  return makeTorrent({ state: "metaDL", time_active: 15 * 60, ...overrides }); // 15 min
}

function makeQueueRecord(overrides: Partial<ArrQueueRecord> = {}): ArrQueueRecord {
  return {
    id: 42,
    downloadId: "ABC123",
    title: "Test.Torrent.S01E01",
    ...overrides,
  };
}

function createMockQbit() {
  return {
    getTorrents: mock.fn(async (): Promise<QBitTorrent[]> => []),
    getTorrent: mock.fn(async (): Promise<QBitTorrent | null> => null),
    deleteTorrent: mock.fn(async (): Promise<void> => {}),
    login: mock.fn(async (): Promise<void> => {}),
  };
}

function createMockArr(name = "Sonarr") {
  return {
    name,
    getQueueItems: mock.fn(async (): Promise<ArrQueueRecord[]> => []),
    removeAndSearch: mock.fn(async (): Promise<void> => {}),
    markFailed: mock.fn(async (): Promise<void> => {}),
  };
}

describe("Monitor", () => {
  it("does not act on metaDL torrent with low time_active", async () => {
    // time_active is 5 min — below 10 min threshold
    const torrent = makeTorrent({ state: "metaDL", time_active: 5 * 60 });
    const mockQbit = createMockQbit();
    const mockArr = createMockArr();

    mockQbit.getTorrents.mock.mockImplementation(async () => [torrent]);

    const config = makeConfig();
    const arrClients = new Map([["sonarr", mockArr as any]]);
    const monitor = new Monitor(mockQbit as any, arrClients, config.categoryMap, config, makeSilentLogger(), new StateTracker());

    await monitor.poll();
    assert.equal(mockArr.removeAndSearch.mock.callCount(), 0);
    assert.equal(mockQbit.deleteTorrent.mock.callCount(), 0);
  });

  it("processes stuck metaDL torrent through full lifecycle", async () => {
    const torrent = makeStuckMetaDL();
    const mockQbit = createMockQbit();
    const mockArr = createMockArr();

    mockQbit.getTorrents.mock.mockImplementation(async () => [torrent]);
    mockQbit.getTorrent.mock.mockImplementation(async () => torrent);
    mockArr.getQueueItems.mock.mockImplementation(async () => [makeQueueRecord()]);

    const config = makeConfig();
    const arrClients = new Map([["sonarr", mockArr as any]]);
    const monitor = new Monitor(mockQbit as any, arrClients, config.categoryMap, config, makeSilentLogger(), new StateTracker());

    // metaDL with time_active > threshold is detected on first poll
    await monitor.poll();
    assert.equal(mockArr.removeAndSearch.mock.callCount(), 1);
    assert.equal(mockArr.removeAndSearch.mock.calls[0].arguments[0], 42);
    assert.equal(mockQbit.getTorrent.mock.callCount(), 1); // re-verify
    assert.equal(mockQbit.deleteTorrent.mock.callCount(), 1);
    assert.equal(mockQbit.deleteTorrent.mock.calls[0].arguments[0], "abc123");
    assert.equal(mockQbit.deleteTorrent.mock.calls[0].arguments[1], true);
  });

  it("arr failure prevents qBit deletion", async () => {
    const torrent = makeStuckMetaDL();
    const mockQbit = createMockQbit();
    const mockArr = createMockArr();

    mockQbit.getTorrents.mock.mockImplementation(async () => [torrent]);
    mockArr.getQueueItems.mock.mockImplementation(async () => [makeQueueRecord()]);
    mockArr.removeAndSearch.mock.mockImplementation(async () => {
      throw new Error("Sonarr is down");
    });

    const config = makeConfig();
    const arrClients = new Map([["sonarr", mockArr as any]]);
    const monitor = new Monitor(mockQbit as any, arrClients, config.categoryMap, config, makeSilentLogger(), new StateTracker());

    await monitor.poll();

    assert.equal(mockArr.removeAndSearch.mock.callCount(), 1);
    assert.equal(mockQbit.deleteTorrent.mock.callCount(), 0); // NOT called
    assert.equal(mockQbit.getTorrent.mock.callCount(), 0); // NOT called
  });

  it("dry run mode: no mutations called", async () => {
    const torrent = makeStuckMetaDL();
    const mockQbit = createMockQbit();
    const mockArr = createMockArr();

    mockQbit.getTorrents.mock.mockImplementation(async () => [torrent]);

    const config = makeConfig({ dryRun: true });
    const arrClients = new Map([["sonarr", mockArr as any]]);
    const monitor = new Monitor(mockQbit as any, arrClients, config.categoryMap, config, makeSilentLogger(), new StateTracker());

    await monitor.poll();

    assert.equal(mockArr.removeAndSearch.mock.callCount(), 0);
    assert.equal(mockArr.markFailed.mock.callCount(), 0);
    assert.equal(mockQbit.deleteTorrent.mock.callCount(), 0);
  });

  it("unknown category: torrent skipped", async () => {
    const torrent = makeStuckMetaDL({ category: "unknown-app" });
    const mockQbit = createMockQbit();
    const mockArr = createMockArr();

    mockQbit.getTorrents.mock.mockImplementation(async () => [torrent]);

    const config = makeConfig();
    const arrClients = new Map([["sonarr", mockArr as any]]);
    const monitor = new Monitor(mockQbit as any, arrClients, config.categoryMap, config, makeSilentLogger(), new StateTracker());

    await monitor.poll();

    assert.equal(mockArr.getQueueItems.mock.callCount(), 0);
    assert.equal(mockQbit.deleteTorrent.mock.callCount(), 0);
  });

  it("queue miss triggers history fallback", async () => {
    const torrent = makeStuckMetaDL();
    const mockQbit = createMockQbit();
    const mockArr = createMockArr();

    mockQbit.getTorrents.mock.mockImplementation(async () => [torrent]);
    mockQbit.getTorrent.mock.mockImplementation(async () => torrent);
    mockArr.getQueueItems.mock.mockImplementation(async () => []); // empty queue

    const config = makeConfig();
    const arrClients = new Map([["sonarr", mockArr as any]]);
    const monitor = new Monitor(mockQbit as any, arrClients, config.categoryMap, config, makeSilentLogger(), new StateTracker());

    await monitor.poll();

    assert.equal(mockArr.removeAndSearch.mock.callCount(), 0);
    assert.equal(mockArr.markFailed.mock.callCount(), 1);
    assert.equal(mockArr.markFailed.mock.calls[0].arguments[0], "abc123");
    assert.equal(mockQbit.deleteTorrent.mock.callCount(), 1);
  });

  it("re-verify finds resumed torrent: deletion skipped", async () => {
    const torrent = makeStuckMetaDL();
    const mockQbit = createMockQbit();
    const mockArr = createMockArr();

    mockQbit.getTorrents.mock.mockImplementation(async () => [torrent]);
    mockQbit.getTorrent.mock.mockImplementation(async () => ({
      ...torrent,
      state: "downloading",
    }));
    mockArr.getQueueItems.mock.mockImplementation(async () => [makeQueueRecord()]);

    const config = makeConfig();
    const arrClients = new Map([["sonarr", mockArr as any]]);
    const monitor = new Monitor(mockQbit as any, arrClients, config.categoryMap, config, makeSilentLogger(), new StateTracker());

    await monitor.poll();

    assert.equal(mockArr.removeAndSearch.mock.callCount(), 1); // arr was notified
    assert.equal(mockQbit.deleteTorrent.mock.callCount(), 0); // but qBit delete skipped
  });

  it("circuit breaker limits processing", async () => {
    const torrents = Array.from({ length: 10 }, (_, i) =>
      makeStuckMetaDL({ hash: `hash_${i}`, name: `Torrent_${i}` }),
    );

    const mockQbit = createMockQbit();
    const mockArr = createMockArr();

    mockQbit.getTorrents.mock.mockImplementation(async () => torrents);
    mockQbit.getTorrent.mock.mockImplementation(async (hash: string) =>
      torrents.find((t) => t.hash === hash) ?? null,
    );
    mockArr.getQueueItems.mock.mockImplementation(async () =>
      torrents.map((t, i) => makeQueueRecord({ id: i, downloadId: t.hash.toUpperCase() })),
    );

    const config = makeConfig({ maxActionsPerCycle: 3 });
    const arrClients = new Map([["sonarr", mockArr as any]]);
    const monitor = new Monitor(mockQbit as any, arrClients, config.categoryMap, config, makeSilentLogger(), new StateTracker());

    await monitor.poll();

    assert.equal(mockArr.removeAndSearch.mock.callCount(), 3);
    assert.equal(mockQbit.deleteTorrent.mock.callCount(), 3);
  });

  it("qBit delete failure adds to pending deletions and retries next cycle", async () => {
    const torrent = makeStuckMetaDL();
    const mockQbit = createMockQbit();
    const mockArr = createMockArr();

    mockQbit.getTorrents.mock.mockImplementation(async () => [torrent]);
    mockQbit.getTorrent.mock.mockImplementation(async () => torrent);
    mockArr.getQueueItems.mock.mockImplementation(async () => [makeQueueRecord()]);
    mockQbit.deleteTorrent.mock.mockImplementation(async () => {
      throw new Error("qBit unreachable");
    });

    const config = makeConfig();
    const arrClients = new Map([["sonarr", mockArr as any]]);
    const monitor = new Monitor(mockQbit as any, arrClients, config.categoryMap, config, makeSilentLogger(), new StateTracker());

    await monitor.poll(); // process — arr succeeds, qBit fails

    assert.equal(mockArr.removeAndSearch.mock.callCount(), 1);
    assert.equal(mockQbit.deleteTorrent.mock.callCount(), 1); // attempted

    // Next poll: torrent gone from qBit, but pending deletion should retry
    mockQbit.getTorrents.mock.mockImplementation(async () => []);
    mockQbit.deleteTorrent.mock.mockImplementation(async () => {}); // fix qBit
    await monitor.poll();

    assert.equal(mockQbit.deleteTorrent.mock.callCount(), 2); // retry
  });

  it("orphan recovery retries pending deletions", async () => {
    const torrent = makeStuckMetaDL();
    const mockQbit = createMockQbit();
    const mockArr = createMockArr();

    mockQbit.getTorrents.mock.mockImplementation(async () => [torrent]);
    mockQbit.getTorrent.mock.mockImplementation(async () => torrent);
    mockArr.getQueueItems.mock.mockImplementation(async () => [makeQueueRecord()]);

    let deleteCallCount = 0;
    mockQbit.deleteTorrent.mock.mockImplementation(async () => {
      deleteCallCount++;
      if (deleteCallCount === 1) {
        throw new Error("qBit down");
      }
    });

    const config = makeConfig();
    const arrClients = new Map([["sonarr", mockArr as any]]);
    const monitor = new Monitor(mockQbit as any, arrClients, config.categoryMap, config, makeSilentLogger(), new StateTracker());

    await monitor.poll(); // process — delete fails, goes to pending

    // Torrent disappears from qBit
    mockQbit.getTorrents.mock.mockImplementation(async () => []);

    await monitor.poll(); // orphan recovery retries

    assert.equal(deleteCallCount, 2); // first attempt + retry
  });

  it("stalledDL requires poll-based tracking (two polls)", async () => {
    const torrent = makeTorrent({ state: "stalledDL" });
    const mockQbit = createMockQbit();
    const mockArr = createMockArr();

    mockQbit.getTorrents.mock.mockImplementation(async () => [torrent]);

    // Use a short threshold for testing
    const config = makeConfig({ stalledThresholds: [{ maxProgress: 100, stuckMs: 0 }] });
    const arrClients = new Map([["sonarr", mockArr as any]]);
    const monitor = new Monitor(mockQbit as any, arrClients, config.categoryMap, config, makeSilentLogger(), new StateTracker());

    // First poll — starts tracking, not stuck yet
    await monitor.poll();
    assert.equal(mockArr.removeAndSearch.mock.callCount(), 0);

    // Second poll — threshold exceeded
    mockQbit.getTorrent.mock.mockImplementation(async () => torrent);
    mockArr.getQueueItems.mock.mockImplementation(async () => [makeQueueRecord()]);
    await monitor.poll();
    assert.equal(mockArr.removeAndSearch.mock.callCount(), 1);
  });
});
