import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StateTracker } from "./state-tracker.js";
import type { QBitTorrent } from "./types.js";

const TEN_MINUTES = 10 * 60 * 1000;
const TEN_MINUTES_SECS = 10 * 60;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

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
      const tracker = new StateTracker(() => 1000000);

      const result = tracker.update(
        [makeTorrent({ state: "metaDL", time_active: 15 * 60 })], // 15 min active
        TEN_MINUTES,
        TWENTY_FOUR_HOURS,
      );

      assert.equal(result.length, 1);
      assert.equal(result[0].hash, "abc123");
      assert.ok(result[0].stuckDurationMs >= TEN_MINUTES);
    });

    it("does not flag metaDL if time_active is below threshold", () => {
      const tracker = new StateTracker(() => 1000000);

      const result = tracker.update(
        [makeTorrent({ state: "metaDL", time_active: 5 * 60 })], // 5 min active
        TEN_MINUTES,
        TWENTY_FOUR_HOURS,
      );

      assert.equal(result.length, 0);
    });

    it("detects metaDL immediately on service startup for long-running torrents", () => {
      const tracker = new StateTracker(() => 1000000);

      // Torrent has been active for 2 hours — detected on very first poll
      const result = tracker.update(
        [makeTorrent({ state: "metaDL", time_active: 2 * 60 * 60 })],
        TEN_MINUTES,
        TWENTY_FOUR_HOURS,
      );

      assert.equal(result.length, 1);
      assert.ok(result[0].stuckDurationMs >= 2 * 60 * 60 * 1000);
    });

    it("handles torrent that waited in queue — time_active is low despite old added_on", () => {
      const tracker = new StateTracker(() => 1000000);

      // added_on is 24 hours ago, but time_active is only 3 min (just left queue)
      const result = tracker.update(
        [makeTorrent({ state: "metaDL", added_on: 1700000000 - 86400, time_active: 3 * 60 })],
        TEN_MINUTES,
        TWENTY_FOUR_HOURS,
      );

      assert.equal(result.length, 0); // Not stuck — only 3 min of active time
    });

    it("does not flag metaDL that recovers to downloading", () => {
      const tracker = new StateTracker(() => 1000000);

      tracker.update(
        [makeTorrent({ state: "metaDL", time_active: 5 * 60 })],
        TEN_MINUTES,
        TWENTY_FOUR_HOURS,
      );

      // Transitions to downloading
      const result = tracker.update(
        [makeTorrent({ state: "downloading", time_active: 8 * 60 })],
        TEN_MINUTES,
        TWENTY_FOUR_HOURS,
      );

      assert.equal(result.length, 0);
    });
  });

  describe("stalledDL detection (uses poll-based tracking)", () => {
    it("does not return stalledDL as stuck on first poll", () => {
      let now = 1000000;
      const tracker = new StateTracker(() => now);

      const result = tracker.update(
        [makeTorrent({ state: "stalledDL" })],
        TEN_MINUTES,
        TWENTY_FOUR_HOURS,
      );

      assert.equal(result.length, 0);
    });

    it("uses 24hr threshold for stalledDL, not 10min", () => {
      let now = 1000000;
      const tracker = new StateTracker(() => now);

      tracker.update(
        [makeTorrent({ state: "stalledDL" })],
        TEN_MINUTES,
        TWENTY_FOUR_HOURS,
      );

      now += TEN_MINUTES + 1;
      const result = tracker.update(
        [makeTorrent({ state: "stalledDL" })],
        TEN_MINUTES,
        TWENTY_FOUR_HOURS,
      );
      assert.equal(result.length, 0);

      now += TWENTY_FOUR_HOURS;
      const result2 = tracker.update(
        [makeTorrent({ state: "stalledDL" })],
        TEN_MINUTES,
        TWENTY_FOUR_HOURS,
      );
      assert.equal(result2.length, 1);
    });

    it("removes stalledDL from tracking when state changes", () => {
      let now = 1000000;
      const tracker = new StateTracker(() => now);

      tracker.update(
        [makeTorrent({ state: "stalledDL" })],
        TEN_MINUTES,
        TWENTY_FOUR_HOURS,
      );

      now += TWENTY_FOUR_HOURS + 1;
      const result = tracker.update(
        [makeTorrent({ state: "downloading" })],
        TEN_MINUTES,
        TWENTY_FOUR_HOURS,
      );
      assert.equal(result.length, 0);

      // Re-enters stalledDL — timer restarts
      const result2 = tracker.update(
        [makeTorrent({ state: "stalledDL" })],
        TEN_MINUTES,
        TWENTY_FOUR_HOURS,
      );
      assert.equal(result2.length, 0);
    });
  });

  describe("general behavior", () => {
    it("prunes torrents that disappear from the list", () => {
      let now = 1000000;
      const tracker = new StateTracker(() => now);

      tracker.update([makeTorrent({ state: "stalledDL" })], TEN_MINUTES, TWENTY_FOUR_HOURS);

      now += TWENTY_FOUR_HOURS + 1;
      const result = tracker.update([], TEN_MINUTES, TWENTY_FOUR_HOURS);
      assert.equal(result.length, 0);

      const result2 = tracker.update(
        [makeTorrent({ state: "stalledDL" })],
        TEN_MINUTES,
        TWENTY_FOUR_HOURS,
      );
      assert.equal(result2.length, 0);
    });

    it("does not track non-eligible states", () => {
      let now = 1000000;
      const tracker = new StateTracker(() => now);

      tracker.update(
        [makeTorrent({ state: "uploading" })],
        TEN_MINUTES,
        TWENTY_FOUR_HOURS,
      );

      now += TWENTY_FOUR_HOURS * 2;
      const result = tracker.update(
        [makeTorrent({ state: "uploading" })],
        TEN_MINUTES,
        TWENTY_FOUR_HOURS,
      );

      assert.equal(result.length, 0);
    });

    it("sorts stuck torrents by duration descending (oldest first)", () => {
      let now = 1000000;
      const tracker = new StateTracker(() => now);

      tracker.update(
        [makeTorrent({ hash: "older", state: "stalledDL" })],
        TEN_MINUTES,
        TWENTY_FOUR_HOURS,
      );

      now += 6 * 60 * 60 * 1000;
      tracker.update(
        [
          makeTorrent({ hash: "older", state: "stalledDL" }),
          makeTorrent({ hash: "newer", state: "stalledDL" }),
        ],
        TEN_MINUTES,
        TWENTY_FOUR_HOURS,
      );

      now += 19 * 60 * 60 * 1000;
      const result = tracker.update(
        [
          makeTorrent({ hash: "older", state: "stalledDL" }),
          makeTorrent({ hash: "newer", state: "stalledDL" }),
        ],
        TEN_MINUTES,
        TWENTY_FOUR_HOURS,
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
        TWENTY_FOUR_HOURS,
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

      // Add 10 times (should all succeed)
      for (let i = 0; i < 10; i++) {
        tracker.addPendingDeletion("hash1");
        // Simulate the get-and-clear + re-add cycle
        tracker.getPendingDeletions();
      }

      // 11th attempt — should be silently dropped
      tracker.addPendingDeletion("hash1");
      const pending = tracker.getPendingDeletions();
      assert.equal(pending.length, 0);
    });
  });

  describe("remove()", () => {
    it("clears from both tracked and pending", () => {
      let now = 1000000;
      const tracker = new StateTracker(() => now);

      tracker.update([makeTorrent({ state: "stalledDL" })], TEN_MINUTES, TWENTY_FOUR_HOURS);
      tracker.addPendingDeletion("abc123");

      tracker.remove("abc123");

      const pending = tracker.getPendingDeletions();
      assert.equal(pending.length, 0);

      now += TWENTY_FOUR_HOURS + 1;
      const result = tracker.update(
        [makeTorrent({ state: "stalledDL" })],
        TEN_MINUTES,
        TWENTY_FOUR_HOURS,
      );
      assert.equal(result.length, 0);
    });
  });
});
