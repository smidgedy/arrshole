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
    dryRun: true,
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

    const config = makeConfig({ dryRun: false });
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

  it("arr failure does not prevent qBit deletion (best-effort notify)", async () => {
    const torrent = makeStuckMetaDL();
    const mockQbit = createMockQbit();
    const mockArr = createMockArr();

    mockQbit.getTorrents.mock.mockImplementation(async () => [torrent]);
    mockQbit.getTorrent.mock.mockImplementation(async () => torrent);
    mockArr.getQueueItems.mock.mockImplementation(async () => [makeQueueRecord()]);
    mockArr.removeAndSearch.mock.mockImplementation(async () => {
      throw new Error("Sonarr is down");
    });

    const config = makeConfig({ dryRun: false });
    const arrClients = new Map([["sonarr", mockArr as any]]);
    const monitor = new Monitor(mockQbit as any, arrClients, config.categoryMap, config, makeSilentLogger(), new StateTracker());

    await monitor.poll();

    assert.equal(mockQbit.deleteTorrent.mock.callCount(), 1); // qBit delete still happens
    assert.equal(mockArr.removeAndSearch.mock.callCount(), 1); // arr notify attempted
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

    const config = makeConfig({ dryRun: false });
    const arrClients = new Map([["sonarr", mockArr as any]]);
    const monitor = new Monitor(mockQbit as any, arrClients, config.categoryMap, config, makeSilentLogger(), new StateTracker());

    await monitor.poll();

    assert.equal(mockArr.removeAndSearch.mock.callCount(), 0);
    assert.equal(mockArr.markFailed.mock.callCount(), 1);
    assert.equal(mockArr.markFailed.mock.calls[0].arguments[0], "abc123");
    assert.equal(mockQbit.deleteTorrent.mock.callCount(), 1);
  });

  it("re-verify finds resumed torrent: skips qBit delete and arr notify", async () => {
    const torrent = makeStuckMetaDL();
    const mockQbit = createMockQbit();
    const mockArr = createMockArr();

    mockQbit.getTorrents.mock.mockImplementation(async () => [torrent]);
    mockQbit.getTorrent.mock.mockImplementation(async () => ({
      ...torrent,
      state: "downloading",
    }));
    mockArr.getQueueItems.mock.mockImplementation(async () => [makeQueueRecord()]);

    const config = makeConfig({ dryRun: false });
    const arrClients = new Map([["sonarr", mockArr as any]]);
    const monitor = new Monitor(mockQbit as any, arrClients, config.categoryMap, config, makeSilentLogger(), new StateTracker());

    await monitor.poll();

    assert.equal(mockQbit.deleteTorrent.mock.callCount(), 0);
    assert.equal(mockArr.removeAndSearch.mock.callCount(), 0);
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

    const config = makeConfig({ maxActionsPerCycle: 3, dryRun: false });
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

    const config = makeConfig({ dryRun: false });
    const arrClients = new Map([["sonarr", mockArr as any]]);
    const monitor = new Monitor(mockQbit as any, arrClients, config.categoryMap, config, makeSilentLogger(), new StateTracker());

    await monitor.poll(); // process — qBit delete fails, arr notify never attempted

    assert.equal(mockQbit.deleteTorrent.mock.callCount(), 1); // attempted
    assert.equal(mockArr.removeAndSearch.mock.callCount(), 0); // bailed before notify

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

    const config = makeConfig({ dryRun: false });
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
    const config = makeConfig({ stalledThresholds: [{ maxProgress: 100, stuckMs: 0 }], dryRun: false });
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

describe("Monitor.runOnce", () => {
  it("filters by stalledDL state only", async () => {
    const stalled = makeTorrent({ hash: "s1", state: "stalledDL", progress: 0.5 });
    const meta = makeTorrent({ hash: "m1", state: "metaDL", progress: 0 });
    const downloading = makeTorrent({ hash: "d1", state: "downloading", progress: 0.3 });

    const mockQbit = createMockQbit();
    const mockArr = createMockArr();
    mockQbit.getTorrents.mock.mockImplementation(async () => [stalled, meta, downloading]);

    const config = makeConfig();
    const arrClients = new Map([["sonarr", mockArr as any]]);
    const monitor = new Monitor(mockQbit as any, arrClients, config.categoryMap, config, makeSilentLogger(), new StateTracker());

    await monitor.runOnce(new Set(["stalledDL"]));

    // Only stalled torrent processed (dry run logs but calls processStuckTorrent)
    // In dry run, processStuckTorrent returns early after logging — no arr calls
    assert.equal(mockArr.getQueueItems.mock.callCount(), 0); // dry run skips
    assert.equal(mockQbit.getTorrents.mock.callCount(), 1);
  });

  it("filters by metaDL state only", async () => {
    const stalled = makeTorrent({ hash: "s1", state: "stalledDL", progress: 0.5 });
    const meta = makeTorrent({ hash: "m1", state: "metaDL", progress: 0, category: "sonarr" });

    const mockQbit = createMockQbit();
    const mockArr = createMockArr();
    mockQbit.getTorrents.mock.mockImplementation(async () => [stalled, meta]);

    const config = makeConfig();
    const arrClients = new Map([["sonarr", mockArr as any]]);
    const monitor = new Monitor(mockQbit as any, arrClients, config.categoryMap, config, makeSilentLogger(), new StateTracker());

    await monitor.runOnce(new Set(["metaDL"]));

    // dry run: processStuckTorrent called for meta only, no mutations
    assert.equal(mockArr.getQueueItems.mock.callCount(), 0);
  });

  it("filters by multiple states (stalledDL + metaDL)", async () => {
    const stalled = makeTorrent({ hash: "s1", state: "stalledDL", progress: 0.5 });
    const meta = makeTorrent({ hash: "m1", state: "metaDL", progress: 0 });
    const downloading = makeTorrent({ hash: "d1", state: "downloading", progress: 0.3 });

    const mockQbit = createMockQbit();
    const mockArr = createMockArr();
    mockQbit.getTorrents.mock.mockImplementation(async () => [stalled, meta, downloading]);

    // Use dryRun: false with full mocks to verify both get processed
    const config = makeConfig({ dryRun: false });
    const arrClients = new Map([["sonarr", mockArr as any]]);

    mockQbit.getTorrent.mock.mockImplementation(async (hash: string) =>
      [stalled, meta].find((t) => t.hash === hash) ?? null,
    );
    mockArr.getQueueItems.mock.mockImplementation(async () => [
      makeQueueRecord({ id: 1, downloadId: "S1" }),
      makeQueueRecord({ id: 2, downloadId: "M1" }),
    ]);

    const monitor = new Monitor(mockQbit as any, arrClients, config.categoryMap, config, makeSilentLogger(), new StateTracker());

    await monitor.runOnce(new Set(["stalledDL", "metaDL"]));

    // Both stalled and meta torrents processed
    assert.equal(mockArr.removeAndSearch.mock.callCount(), 2);
    assert.equal(mockQbit.deleteTorrent.mock.callCount(), 2);
  });

  it("filters by below threshold (exclusive: pct >= below excluded)", async () => {
    const t10 = makeTorrent({ hash: "t10", state: "stalledDL", progress: 0.10 }); // 10%
    const t50 = makeTorrent({ hash: "t50", state: "stalledDL", progress: 0.50 }); // 50%
    const t80 = makeTorrent({ hash: "t80", state: "stalledDL", progress: 0.80 }); // 80%

    const mockQbit = createMockQbit();
    const mockArr = createMockArr();
    mockQbit.getTorrents.mock.mockImplementation(async () => [t10, t50, t80]);

    // dryRun: false to count processStuckTorrent calls via arr mock
    const config = makeConfig({ dryRun: false });
    const arrClients = new Map([["sonarr", mockArr as any]]);
    mockQbit.getTorrent.mock.mockImplementation(async (hash: string) =>
      [t10, t50, t80].find((t) => t.hash === hash) ?? null,
    );
    mockArr.getQueueItems.mock.mockImplementation(async () => [
      makeQueueRecord({ id: 1, downloadId: "T10" }),
    ]);

    const monitor = new Monitor(mockQbit as any, arrClients, config.categoryMap, config, makeSilentLogger(), new StateTracker());

    // below=50 means pct < 50 passes, pct >= 50 excluded
    await monitor.runOnce(new Set(["stalledDL"]), 50);

    // Only t10 (10%) should match; t50 (50%) and t80 (80%) excluded
    assert.equal(mockArr.removeAndSearch.mock.callCount(), 1);
    assert.equal(mockQbit.deleteTorrent.mock.callCount(), 1);
  });

  it("filters by above threshold (exclusive: pct <= above excluded)", async () => {
    const t10 = makeTorrent({ hash: "t10", state: "stalledDL", progress: 0.10 }); // 10%
    const t50 = makeTorrent({ hash: "t50", state: "stalledDL", progress: 0.50 }); // 50%
    const t80 = makeTorrent({ hash: "t80", state: "stalledDL", progress: 0.80 }); // 80%

    const mockQbit = createMockQbit();
    const mockArr = createMockArr();
    mockQbit.getTorrents.mock.mockImplementation(async () => [t10, t50, t80]);

    const config = makeConfig({ dryRun: false });
    const arrClients = new Map([["sonarr", mockArr as any]]);
    mockQbit.getTorrent.mock.mockImplementation(async (hash: string) =>
      [t10, t50, t80].find((t) => t.hash === hash) ?? null,
    );
    mockArr.getQueueItems.mock.mockImplementation(async () => [
      makeQueueRecord({ id: 1, downloadId: "T80" }),
    ]);

    const monitor = new Monitor(mockQbit as any, arrClients, config.categoryMap, config, makeSilentLogger(), new StateTracker());

    // above=50 means pct > 50 passes, pct <= 50 excluded
    await monitor.runOnce(new Set(["stalledDL"]), undefined, 50);

    // Only t80 (80%) should match; t10 (10%) and t50 (50%) excluded
    assert.equal(mockArr.removeAndSearch.mock.callCount(), 1);
    assert.equal(mockQbit.deleteTorrent.mock.callCount(), 1);
  });

  it("combined state + below + above filters", async () => {
    const stalled10 = makeTorrent({ hash: "s10", state: "stalledDL", progress: 0.10 });
    const stalled50 = makeTorrent({ hash: "s50", state: "stalledDL", progress: 0.50 });
    const stalled80 = makeTorrent({ hash: "s80", state: "stalledDL", progress: 0.80 });
    const meta30 = makeTorrent({ hash: "m30", state: "metaDL", progress: 0.30 });
    const dl50 = makeTorrent({ hash: "d50", state: "downloading", progress: 0.50 });

    const mockQbit = createMockQbit();
    const mockArr = createMockArr();
    mockQbit.getTorrents.mock.mockImplementation(async () => [stalled10, stalled50, stalled80, meta30, dl50]);

    const config = makeConfig({ dryRun: false });
    const arrClients = new Map([["sonarr", mockArr as any]]);
    mockQbit.getTorrent.mock.mockImplementation(async (hash: string) =>
      [stalled10, stalled50, stalled80, meta30, dl50].find((t) => t.hash === hash) ?? null,
    );
    mockArr.getQueueItems.mock.mockImplementation(async () => [
      makeQueueRecord({ id: 1, downloadId: "S50" }),
    ]);

    const monitor = new Monitor(mockQbit as any, arrClients, config.categoryMap, config, makeSilentLogger(), new StateTracker());

    // stalledDL only, above=20, below=80 => pct > 20 AND pct < 80
    // stalled10 (10%): pct <= 20 => excluded
    // stalled50 (50%): pct > 20, pct < 80 => included
    // stalled80 (80%): pct >= 80 => excluded
    // meta30: wrong state => excluded
    // dl50: wrong state => excluded
    await monitor.runOnce(new Set(["stalledDL"]), 80, 20);

    assert.equal(mockArr.removeAndSearch.mock.callCount(), 1);
    assert.equal(mockQbit.deleteTorrent.mock.callCount(), 1);
  });

  it("processes all matches without circuit breaker", async () => {
    const torrents = Array.from({ length: 10 }, (_, i) =>
      makeTorrent({ hash: `hash_${i}`, name: `Torrent_${i}`, state: "stalledDL", progress: 0 }),
    );

    const mockQbit = createMockQbit();
    const mockArr = createMockArr();
    mockQbit.getTorrents.mock.mockImplementation(async () => torrents);

    // maxActionsPerCycle=3 should NOT limit runOnce
    const config = makeConfig({ maxActionsPerCycle: 3, dryRun: false });
    const arrClients = new Map([["sonarr", mockArr as any]]);
    mockQbit.getTorrent.mock.mockImplementation(async (hash: string) =>
      torrents.find((t) => t.hash === hash) ?? null,
    );
    mockArr.getQueueItems.mock.mockImplementation(async () =>
      torrents.map((t, i) => makeQueueRecord({ id: i, downloadId: t.hash.toUpperCase() })),
    );

    const monitor = new Monitor(mockQbit as any, arrClients, config.categoryMap, config, makeSilentLogger(), new StateTracker());

    await monitor.runOnce(new Set(["stalledDL"]));

    // All 10 processed despite maxActionsPerCycle=3
    assert.equal(mockArr.removeAndSearch.mock.callCount(), 10);
    assert.equal(mockQbit.deleteTorrent.mock.callCount(), 10);
  });

  it("continues processing after individual torrent failure", async () => {
    const t1 = makeTorrent({ hash: "t1", state: "stalledDL", progress: 0 });
    const t2 = makeTorrent({ hash: "t2", state: "stalledDL", progress: 0 });
    const t3 = makeTorrent({ hash: "t3", state: "stalledDL", progress: 0 });

    const mockQbit = createMockQbit();
    const mockArr = createMockArr();
    mockQbit.getTorrents.mock.mockImplementation(async () => [t1, t2, t3]);

    const config = makeConfig({ dryRun: false });
    const arrClients = new Map([["sonarr", mockArr as any]]);

    // t2 will fail during getQueueItems (simulating arr failure)
    let callNum = 0;
    mockArr.getQueueItems.mock.mockImplementation(async () => {
      callNum++;
      if (callNum === 2) throw new Error("Transient failure");
      return []; // empty queue triggers markFailed fallback
    });
    mockQbit.getTorrent.mock.mockImplementation(async (hash: string) =>
      [t1, t2, t3].find((t) => t.hash === hash) ?? null,
    );

    const monitor = new Monitor(mockQbit as any, arrClients, config.categoryMap, config, makeSilentLogger(), new StateTracker());

    await monitor.runOnce(new Set(["stalledDL"]));

    // t1 and t3 should still be processed; t2 failed
    assert.equal(mockArr.getQueueItems.mock.callCount(), 3); // all 3 attempted
    assert.equal(mockArr.markFailed.mock.callCount(), 2); // t1 and t3 via fallback
  });

  it("returns without processing when no matches", async () => {
    const downloading = makeTorrent({ hash: "d1", state: "downloading", progress: 0.5 });

    const mockQbit = createMockQbit();
    const mockArr = createMockArr();
    mockQbit.getTorrents.mock.mockImplementation(async () => [downloading]);

    const config = makeConfig();
    const arrClients = new Map([["sonarr", mockArr as any]]);
    const monitor = new Monitor(mockQbit as any, arrClients, config.categoryMap, config, makeSilentLogger(), new StateTracker());

    await monitor.runOnce(new Set(["stalledDL"]));

    assert.equal(mockArr.getQueueItems.mock.callCount(), 0);
    assert.equal(mockArr.removeAndSearch.mock.callCount(), 0);
    assert.equal(mockQbit.deleteTorrent.mock.callCount(), 0);
  });

  it("DRY_RUN mode prevents mutations in processStuckTorrent", async () => {
    const torrent = makeTorrent({ hash: "abc123", state: "stalledDL", progress: 0.1 });

    const mockQbit = createMockQbit();
    const mockArr = createMockArr();
    mockQbit.getTorrents.mock.mockImplementation(async () => [torrent]);

    const config = makeConfig(); // dryRun: true by default
    const arrClients = new Map([["sonarr", mockArr as any]]);
    const monitor = new Monitor(mockQbit as any, arrClients, config.categoryMap, config, makeSilentLogger(), new StateTracker());

    await monitor.runOnce(new Set(["stalledDL"]));

    // processStuckTorrent should have been called but dry run prevents all mutations
    assert.equal(mockArr.getQueueItems.mock.callCount(), 0);
    assert.equal(mockArr.removeAndSearch.mock.callCount(), 0);
    assert.equal(mockArr.markFailed.mock.callCount(), 0);
    assert.equal(mockQbit.deleteTorrent.mock.callCount(), 0);
    assert.equal(mockQbit.getTorrent.mock.callCount(), 0);
  });
});
