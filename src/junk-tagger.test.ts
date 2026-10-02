import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JunkTagger, type TastePlan } from "./junk-tagger.js";
import type { TasteConfig } from "./config.js";
import { makeSilentLogger } from "./test-helpers.js";

class FakeArr {
  tags = new Map<string, number>();
  edits: Array<{ kind: string; ids: number[]; tagId: number; mode: string }> = [];
  created: string[] = [];
  constructor(readonly name: string) {}
  async getTags() {
    return new Map(this.tags);
  }
  async createTag(label: string) {
    this.created.push(label);
    const id = 90 + this.created.length;
    this.tags.set(label.toLowerCase(), id);
    return id;
  }
  async editTag(kind: "movie" | "series", ids: number[], tagId: number, mode: "add" | "remove") {
    this.edits.push({ kind, ids, tagId, mode });
  }
}

const change = (id: number) => ({ id, title: `t${id}`, score: 1, reason: "r" });

function plan(over: Partial<TastePlan["apps"]> = {}): TastePlan {
  return {
    runId: 1,
    apps: {
      radarr: { tagLabel: "junk", add: [change(1), change(2)], remove: [change(3)] },
      sonarr: { tagLabel: "junk", add: [change(10)], remove: [] },
      ...over,
    },
  };
}

describe("JunkTagger", () => {
  let dir: string;
  let cfg: TasteConfig;
  let radarr: FakeArr;
  let sonarr: FakeArr;
  let clients: Map<string, any>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "taste-"));
    cfg = {
      python: "python", cwd: ".", intervalMs: 24 * 3600_000, retryMs: 3600_000,
      timeoutMs: 1000, maxTagChanges: 40, stateFilePath: join(dir, "state.json"),
    };
    radarr = new FakeArr("Radarr");
    sonarr = new FakeArr("Sonarr");
    clients = new Map<string, any>([["radarr", radarr], ["sonarr", sonarr]]);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("applies removes then adds via the bulk editor, creating the tag if missing", async () => {
    radarr.tags.set("junk", 7);
    const t = new JunkTagger(cfg, clients, false, makeSilentLogger(), async () => plan());
    await t.runOnce();
    assert.deepEqual(radarr.edits, [
      { kind: "movie", ids: [3], tagId: 7, mode: "remove" },
      { kind: "movie", ids: [1, 2], tagId: 7, mode: "add" },
    ]);
    assert.deepEqual(sonarr.created, ["junk"]);
    assert.deepEqual(sonarr.edits, [{ kind: "series", ids: [10], tagId: 91, mode: "add" }]);
  });

  it("changes nothing in dry run", async () => {
    const t = new JunkTagger(cfg, clients, true, makeSilentLogger(), async () => plan());
    await t.runOnce();
    assert.equal(radarr.edits.length + sonarr.edits.length, 0);
    assert.equal(radarr.created.length + sonarr.created.length, 0);
  });

  it("never creates a tag just to remove it", async () => {
    const t = new JunkTagger(cfg, clients, false, makeSilentLogger(), async () =>
      plan({ radarr: { tagLabel: "junk", add: [], remove: [change(3)] }, sonarr: { tagLabel: "junk", add: [], remove: [] } }));
    await t.runOnce();
    assert.equal(radarr.created.length, 0);
    assert.equal(radarr.edits.length, 0);
  });

  it("caps total tag changes per run, spending the budget on removals first", async () => {
    radarr.tags.set("junk", 7);
    sonarr.tags.set("junk", 8);
    const t = new JunkTagger({ ...cfg, maxTagChanges: 2 }, clients, false, makeSilentLogger(), async () => plan());
    await t.runOnce();
    assert.deepEqual(radarr.edits, [
      { kind: "movie", ids: [3], tagId: 7, mode: "remove" },
      { kind: "movie", ids: [1], tagId: 7, mode: "add" },
    ]);
    assert.equal(sonarr.edits.length, 0);
  });

  it("skips apps it has no client for", async () => {
    clients.delete("sonarr");
    radarr.tags.set("junk", 7);
    const t = new JunkTagger(cfg, clients, false, makeSilentLogger(), async () => plan());
    await t.runOnce();
    assert.equal(radarr.edits.length, 2);
  });

  describe("scheduling", () => {
    it("is due with no state, not due right after success, due again after the interval", async () => {
      let now = 1_000_000_000;
      const t = new JunkTagger(cfg, clients, true, makeSilentLogger(), async () => plan(), () => now);
      assert.equal(t.isDue(), true);
      await t.runOnce();
      assert.equal(t.isDue(), false);
      now += cfg.intervalMs;
      assert.equal(t.isDue(), true);
    });

    it("backs off for retryMs after a failure instead of hammering", async () => {
      let now = 1_000_000_000;
      const t = new JunkTagger(cfg, clients, true, makeSilentLogger(), async () => {
        throw new Error("boom");
      }, () => now);
      await assert.rejects(t.runOnce());
      assert.equal(t.isDue(), false);
      now += cfg.retryMs;
      assert.equal(t.isDue(), true);
    });

    it("tolerates a corrupt state file", () => {
      writeFileSync(cfg.stateFilePath, "{not json");
      const t = new JunkTagger(cfg, clients, true, makeSilentLogger(), async () => plan());
      assert.equal(t.isDue(), true);
    });

    it("single-flights concurrent runs", async () => {
      let calls = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const t = new JunkTagger(cfg, clients, true, makeSilentLogger(), async () => {
        calls++;
        await gate;
        return plan();
      });
      const a = t.runOnce();
      const b = t.runOnce();
      release();
      await Promise.all([a, b]);
      assert.equal(calls, 1);
    });
  });
});
