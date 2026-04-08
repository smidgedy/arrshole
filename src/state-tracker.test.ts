import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { StateTracker } from "./state-tracker.js";
import type { QBitTorrent, StalledThreshold, PersistedState } from "./types.js";

const TEN_MINUTES = 10 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const TWELVE_HOURS = 12 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

/** Single flat threshold matching old behavior. */
const FLAT_THRESHOLDS: StalledThreshold[] = [{ maxProgress: 100, stuckMs: TWENTY_FOUR_HOURS }];

/** Tiered thresholds: ≤10% → 1h, ≤90% → 12h, ≤100% → 24h. */
const TIERED_THRESHOLDS: StalledThreshold[] = [
  { maxProgress: 10, stuckMs: ONE_HOUR },
  { maxProgress: 90, stuckMs: TWELVE_HOURS },
  { maxProgress: 100, stuckMs: TWENTY_FOUR_HOURS },
];

function makeTorrent(overrides: Partial<QBitTorrent> = {}): QBitTorrent {
  return {
    hash: "abc123",
    name: "Test.Torrent",
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

describe("StateTracker", () => {
  describe("metaDL detection (uses time_active)", () => {
    it("detects stuck metaDL on first poll if time_active exceeds threshold", () => {
      const tracker = new StateTracker(undefined, undefined, () => 1000000);

      const result = tracker.update(
        [makeTorrent({ state: "metaDL", time_active: 15 * 60 })],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );

      assert.equal(result.length, 1);
      assert.equal(result[0].hash, "abc123");
      assert.ok(result[0].stuckDurationMs >= TEN_MINUTES);
    });

    it("does not flag metaDL if time_active is below threshold", () => {
      const tracker = new StateTracker(undefined, undefined, () => 1000000);

      const result = tracker.update(
        [makeTorrent({ state: "metaDL", time_active: 5 * 60 })],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );

      assert.equal(result.length, 0);
    });

    it("detects metaDL immediately on service startup for long-running torrents", () => {
      const tracker = new StateTracker(undefined, undefined, () => 1000000);

      const result = tracker.update(
        [makeTorrent({ state: "metaDL", time_active: 2 * 60 * 60 })],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );

      assert.equal(result.length, 1);
      assert.ok(result[0].stuckDurationMs >= 2 * 60 * 60 * 1000);
    });

    it("handles torrent that waited in queue — time_active is low despite old added_on", () => {
      const tracker = new StateTracker(undefined, undefined, () => 1000000);

      const result = tracker.update(
        [makeTorrent({ state: "metaDL", added_on: 1700000000 - 86400, time_active: 3 * 60 })],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );

      assert.equal(result.length, 0);
    });

    it("handles forcedMetaDL identically to metaDL", () => {
      const tracker = new StateTracker(undefined, undefined, () => 1000000);

      const result = tracker.update(
        [makeTorrent({ state: "forcedMetaDL", time_active: 15 * 60 })],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );

      assert.equal(result.length, 1);
      assert.equal(result[0].state, "forcedMetaDL");
      assert.ok(result[0].stuckDurationMs >= TEN_MINUTES);
    });

    it("does not flag metaDL that recovers to downloading", () => {
      const tracker = new StateTracker(undefined, undefined, () => 1000000);

      tracker.update(
        [makeTorrent({ state: "metaDL", time_active: 5 * 60 })],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );

      const result = tracker.update(
        [makeTorrent({ state: "downloading", time_active: 8 * 60 })],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );

      assert.equal(result.length, 0);
    });
  });

  describe("stalledDL detection (uses poll-based tracking)", () => {
    it("does not return stalledDL as stuck on first poll", () => {
      let now = 1000000;
      const tracker = new StateTracker(undefined, undefined, () => now);

      const result = tracker.update(
        [makeTorrent({ state: "stalledDL" })],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );

      assert.equal(result.length, 0);
    });

    it("uses 24hr threshold for stalledDL with flat thresholds", () => {
      let now = 1000000;
      const tracker = new StateTracker(undefined, undefined, () => now);

      tracker.update(
        [makeTorrent({ state: "stalledDL" })],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );

      now += TEN_MINUTES + 1;
      const result = tracker.update(
        [makeTorrent({ state: "stalledDL" })],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );
      assert.equal(result.length, 0);

      now += TWENTY_FOUR_HOURS;
      const result2 = tracker.update(
        [makeTorrent({ state: "stalledDL" })],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );
      assert.equal(result2.length, 1);
    });

    it("removes stalledDL from tracking when state changes", () => {
      let now = 1000000;
      const tracker = new StateTracker(undefined, undefined, () => now);

      tracker.update(
        [makeTorrent({ state: "stalledDL" })],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );

      now += TWENTY_FOUR_HOURS + 1;
      const result = tracker.update(
        [makeTorrent({ state: "downloading" })],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );
      assert.equal(result.length, 0);

      // Re-enters stalledDL — timer restarts
      const result2 = tracker.update(
        [makeTorrent({ state: "stalledDL" })],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );
      assert.equal(result2.length, 0);
    });
  });

  describe("tiered stalled thresholds", () => {
    it("uses 1h threshold for low-progress torrent (≤10%)", () => {
      let now = 1000000;
      const tracker = new StateTracker(undefined, undefined, () => now);

      tracker.update(
        [makeTorrent({ state: "stalledDL", progress: 0.05 })],
        TEN_MINUTES,
        TIERED_THRESHOLDS,
      );

      // After 1 hour + 1ms — should be stuck
      now += ONE_HOUR + 1;
      const result = tracker.update(
        [makeTorrent({ state: "stalledDL", progress: 0.05 })],
        TEN_MINUTES,
        TIERED_THRESHOLDS,
      );
      assert.equal(result.length, 1);
    });

    it("uses 12h threshold for mid-progress torrent (11–90%)", () => {
      let now = 1000000;
      const tracker = new StateTracker(undefined, undefined, () => now);

      tracker.update(
        [makeTorrent({ state: "stalledDL", progress: 0.50 })],
        TEN_MINUTES,
        TIERED_THRESHOLDS,
      );

      // After 1 hour — NOT stuck (needs 12h)
      now += ONE_HOUR + 1;
      const result = tracker.update(
        [makeTorrent({ state: "stalledDL", progress: 0.50 })],
        TEN_MINUTES,
        TIERED_THRESHOLDS,
      );
      assert.equal(result.length, 0);

      // After 12 hours total — stuck
      now += TWELVE_HOURS - ONE_HOUR;
      const result2 = tracker.update(
        [makeTorrent({ state: "stalledDL", progress: 0.50 })],
        TEN_MINUTES,
        TIERED_THRESHOLDS,
      );
      assert.equal(result2.length, 1);
    });

    it("uses 24h threshold for high-progress torrent (>90%)", () => {
      let now = 1000000;
      const tracker = new StateTracker(undefined, undefined, () => now);

      tracker.update(
        [makeTorrent({ state: "stalledDL", progress: 0.95 })],
        TEN_MINUTES,
        TIERED_THRESHOLDS,
      );

      // After 12 hours — NOT stuck (needs 24h)
      now += TWELVE_HOURS + 1;
      const result = tracker.update(
        [makeTorrent({ state: "stalledDL", progress: 0.95 })],
        TEN_MINUTES,
        TIERED_THRESHOLDS,
      );
      assert.equal(result.length, 0);

      // After 24 hours total — stuck
      now += TWELVE_HOURS;
      const result2 = tracker.update(
        [makeTorrent({ state: "stalledDL", progress: 0.95 })],
        TEN_MINUTES,
        TIERED_THRESHOLDS,
      );
      assert.equal(result2.length, 1);
    });

    it("boundary: exactly 10% uses the ≤10% threshold", () => {
      let now = 1000000;
      const tracker = new StateTracker(undefined, undefined, () => now);

      tracker.update(
        [makeTorrent({ state: "stalledDL", progress: 0.10 })],
        TEN_MINUTES,
        TIERED_THRESHOLDS,
      );

      now += ONE_HOUR + 1;
      const result = tracker.update(
        [makeTorrent({ state: "stalledDL", progress: 0.10 })],
        TEN_MINUTES,
        TIERED_THRESHOLDS,
      );
      assert.equal(result.length, 1);
    });

    it("boundary: exactly 90% uses the ≤90% threshold", () => {
      let now = 1000000;
      const tracker = new StateTracker(undefined, undefined, () => now);

      tracker.update(
        [makeTorrent({ state: "stalledDL", progress: 0.90 })],
        TEN_MINUTES,
        TIERED_THRESHOLDS,
      );

      now += TWELVE_HOURS + 1;
      const result = tracker.update(
        [makeTorrent({ state: "stalledDL", progress: 0.90 })],
        TEN_MINUTES,
        TIERED_THRESHOLDS,
      );
      assert.equal(result.length, 1);
    });
  });

  describe("selectThresholdMs", () => {
    it("selects correct tier for various progress values", () => {
      assert.equal(StateTracker.selectThresholdMs(0, TIERED_THRESHOLDS), ONE_HOUR);
      assert.equal(StateTracker.selectThresholdMs(0.05, TIERED_THRESHOLDS), ONE_HOUR);
      assert.equal(StateTracker.selectThresholdMs(0.10, TIERED_THRESHOLDS), ONE_HOUR);
      assert.equal(StateTracker.selectThresholdMs(0.11, TIERED_THRESHOLDS), TWELVE_HOURS);
      assert.equal(StateTracker.selectThresholdMs(0.50, TIERED_THRESHOLDS), TWELVE_HOURS);
      assert.equal(StateTracker.selectThresholdMs(0.90, TIERED_THRESHOLDS), TWELVE_HOURS);
      assert.equal(StateTracker.selectThresholdMs(0.91, TIERED_THRESHOLDS), TWENTY_FOUR_HOURS);
      assert.equal(StateTracker.selectThresholdMs(1.0, TIERED_THRESHOLDS), TWENTY_FOUR_HOURS);
    });
  });

  describe("general behavior", () => {
    it("prunes torrents that disappear from the list", () => {
      let now = 1000000;
      const tracker = new StateTracker(undefined, undefined, () => now);

      tracker.update([makeTorrent({ state: "stalledDL" })], TEN_MINUTES, FLAT_THRESHOLDS);

      now += TWENTY_FOUR_HOURS + 1;
      const result = tracker.update([], TEN_MINUTES, FLAT_THRESHOLDS);
      assert.equal(result.length, 0);

      const result2 = tracker.update(
        [makeTorrent({ state: "stalledDL" })],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );
      assert.equal(result2.length, 0);
    });

    it("does not track non-eligible states", () => {
      let now = 1000000;
      const tracker = new StateTracker(undefined, undefined, () => now);

      tracker.update(
        [makeTorrent({ state: "uploading" })],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );

      now += TWENTY_FOUR_HOURS * 2;
      const result = tracker.update(
        [makeTorrent({ state: "uploading" })],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );

      assert.equal(result.length, 0);
    });

    it("sorts stuck torrents by duration descending (oldest first)", () => {
      let now = 1000000;
      const tracker = new StateTracker(undefined, undefined, () => now);

      tracker.update(
        [makeTorrent({ hash: "older", state: "stalledDL" })],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );

      now += 6 * 60 * 60 * 1000;
      tracker.update(
        [
          makeTorrent({ hash: "older", state: "stalledDL" }),
          makeTorrent({ hash: "newer", state: "stalledDL" }),
        ],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );

      now += 19 * 60 * 60 * 1000;
      const result = tracker.update(
        [
          makeTorrent({ hash: "older", state: "stalledDL" }),
          makeTorrent({ hash: "newer", state: "stalledDL" }),
        ],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );

      assert.equal(result.length, 1);
      assert.equal(result[0].hash, "older");

      now += 6 * 60 * 60 * 1000;
      const result2 = tracker.update(
        [
          makeTorrent({ hash: "older", state: "stalledDL" }),
          makeTorrent({ hash: "newer", state: "stalledDL" }),
        ],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );

      assert.equal(result2.length, 2);
      assert.equal(result2[0].hash, "older");
      assert.equal(result2[1].hash, "newer");
    });
  });

  describe("pendingDeletions", () => {
    it("addPendingDeletion and getPendingDeletions returns and clears", () => {
      const tracker = new StateTracker();

      tracker.addPendingDeletion("hash1");
      tracker.addPendingDeletion("hash2");

      const pending = tracker.getPendingDeletions();
      assert.equal(pending.length, 2);
      assert.ok(pending.includes("hash1"));
      assert.ok(pending.includes("hash2"));

      const pending2 = tracker.getPendingDeletions();
      assert.equal(pending2.length, 0);
    });

    it("drops pending deletions after max retries (10)", () => {
      const tracker = new StateTracker();

      for (let i = 0; i < 10; i++) {
        tracker.addPendingDeletion("hash1");
        tracker.getPendingDeletions();
      }

      tracker.addPendingDeletion("hash1");
      const pending = tracker.getPendingDeletions();
      assert.equal(pending.length, 0);
    });
  });

  describe("remove()", () => {
    it("clears from both tracked and pending", () => {
      let now = 1000000;
      const tracker = new StateTracker(undefined, undefined, () => now);

      tracker.update([makeTorrent({ state: "stalledDL" })], TEN_MINUTES, FLAT_THRESHOLDS);
      tracker.addPendingDeletion("abc123");

      tracker.remove("abc123");

      const pending = tracker.getPendingDeletions();
      assert.equal(pending.length, 0);

      now += TWENTY_FOUR_HOURS + 1;
      const result = tracker.update(
        [makeTorrent({ state: "stalledDL" })],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );
      assert.equal(result.length, 0);
    });
  });

  describe("disk persistence", () => {
    const testFile = "/tmp/arrshole-test-state.json";

    function cleanup() {
      try { unlinkSync(testFile); } catch {}
    }

    it("saves and restores state across instances", () => {
      cleanup();
      let now = 1000000;

      // First instance: start tracking
      const tracker1 = new StateTracker(undefined, testFile, () => now);
      tracker1.update(
        [makeTorrent({ state: "stalledDL" })],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );

      // New instance: load from disk
      now += TWENTY_FOUR_HOURS + 1;
      const tracker2 = new StateTracker(undefined, testFile, () => now);
      tracker2.loadFromDisk();

      const result = tracker2.update(
        [makeTorrent({ state: "stalledDL" })],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );

      // Should be stuck because firstSeenAt was persisted
      assert.equal(result.length, 1);
      assert.equal(result[0].hash, "abc123");
      cleanup();
    });

    it("handles missing state file gracefully", () => {
      cleanup();
      const tracker = new StateTracker(undefined, testFile, () => 1000000);
      tracker.loadFromDisk(); // should not throw

      const result = tracker.update(
        [makeTorrent({ state: "stalledDL" })],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );
      assert.equal(result.length, 0);
    });

    it("handles corrupt state file gracefully", () => {
      writeFileSync(testFile, "not json {{{");
      const tracker = new StateTracker(undefined, testFile, () => 1000000);
      tracker.loadFromDisk(); // should not throw

      const result = tracker.update(
        [makeTorrent({ state: "stalledDL" })],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );
      assert.equal(result.length, 0);
      cleanup();
    });

    it("persists pending deletions and retry counts", () => {
      cleanup();

      const tracker1 = new StateTracker(undefined, testFile, () => 1000000);
      tracker1.addPendingDeletion("hash1");
      tracker1.addPendingDeletion("hash1");

      const tracker2 = new StateTracker(undefined, testFile, () => 1000000);
      tracker2.loadFromDisk();

      const pending = tracker2.getPendingDeletions();
      assert.equal(pending.length, 1);
      assert.ok(pending.includes("hash1"));
      cleanup();
    });

    it("clears persisted state when torrent resumes downloading", () => {
      cleanup();
      let now = 1000000;

      const tracker1 = new StateTracker(undefined, testFile, () => now);
      tracker1.update(
        [makeTorrent({ state: "stalledDL" })],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );

      // Torrent resumes
      now += ONE_HOUR;
      tracker1.update(
        [makeTorrent({ state: "downloading" })],
        TEN_MINUTES,
        FLAT_THRESHOLDS,
      );

      // Read what was saved
      const raw = JSON.parse(readFileSync(testFile, "utf-8")) as PersistedState;
      assert.equal(raw.tracked.length, 0);
      cleanup();
    });
  });
});
