import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexerDoctor, classifyFailure, redirectTarget, withBaseUrl, isBackingOff } from "./indexer-doctor.js";
import type { ProwlarrClient, ProwlarrIndexer, ProwlarrIndexerStatus } from "./clients/prowlarr.js";
import type { JackettClient } from "./clients/jackett.js";
import { makeSilentLogger } from "./test-helpers.js";

const NOW = Date.parse("2026-10-04T12:00:00Z");

describe("classifyFailure", () => {
  it("recognises the failure types Prowlarr reports", () => {
    assert.equal(classifyFailure("Unable to access eztvx.to, blocked by CloudFlare Protection."), "cloudflare");
    assert.equal(classifyFailure("Unable to connect to indexer. Redirected to https://bitsearch.eu/latest from indexer request"), "redirect");
    assert.equal(classifyFailure("HTTP request failed: [403:Forbidden] [POST] at [https://rutracker.org/forum/login.php]"), "auth");
    assert.equal(classifyFailure("Request timed out"), "other");
  });
});

describe("redirectTarget", () => {
  const urls = ["https://bitsearch.to/", "https://solidtorrents.eu/"];
  it("follows a redirect only to one of the definition's own URLs", () => {
    assert.equal(redirectTarget("Redirected to https://solidtorrents.eu/latest from indexer request", urls, "https://bitsearch.to/"), "https://solidtorrents.eu/");
    assert.equal(redirectTarget("Redirected to https://bitsearch.eu/latest from indexer request", urls, null), null);
  });
  it("ignores a redirect to the URL already in use", () => {
    assert.equal(redirectTarget("Redirected to https://bitsearch.to/x", urls, "https://bitsearch.to/"), null);
  });
});

describe("withBaseUrl / isBackingOff", () => {
  it("sets the baseUrl field, adding it when absent", () => {
    const ix: ProwlarrIndexer = { id: 1, name: "x", enable: true, tags: [], fields: [{ name: "other", value: 1 }] };
    assert.deepEqual(withBaseUrl(ix, "https://a/").fields.find((f) => f.name === "baseUrl")?.value, "https://a/");
  });
  it("treats disabled-now or failed-in-the-last-day as backing off", () => {
    assert.equal(isBackingOff({ indexerId: 1, disabledTill: "2026-10-04T13:00:00Z" }, NOW), true);
    assert.equal(isBackingOff({ indexerId: 1, mostRecentFailure: "2026-10-04T01:00:00Z", disabledTill: "2026-10-04T02:00:00Z" }, NOW), true);
    assert.equal(isBackingOff({ indexerId: 1, mostRecentFailure: "2026-10-01T01:00:00Z", disabledTill: "2026-10-01T02:00:00Z" }, NOW), false);
    assert.equal(isBackingOff(undefined, NOW), false);
  });
});

class FakeProwlarr {
  updated: ProwlarrIndexer[] = [];
  constructor(
    public indexers: ProwlarrIndexer[],
    public statuses: ProwlarrIndexerStatus[],
    /** name → error the test returns for a given candidate */
    public test: (ix: ProwlarrIndexer) => string | null,
  ) {}
  async getIndexers() { return this.indexers; }
  async getIndexerStatuses() { return this.statuses; }
  async getProxies() { return [{ id: 1, name: "FlareSolverr", implementation: "FlareSolverr", tags: [7] }]; }
  async testIndexer(ix: ProwlarrIndexer) { return this.test(ix); }
  async updateIndexer(ix: ProwlarrIndexer) { this.updated.push(ix); }
}

const ix = (id: number, name: string, extra: Partial<ProwlarrIndexer> = {}): ProwlarrIndexer =>
  ({ id, name, enable: true, tags: [], fields: [{ name: "baseUrl", value: null }], ...extra });
const failing = (id: number): ProwlarrIndexerStatus => ({ indexerId: id, disabledTill: "2026-10-04T18:00:00Z", mostRecentFailure: "2026-10-04T11:00:00Z" });

describe("IndexerDoctor", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "doctor-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const doctor = (p: FakeProwlarr | null, j: Partial<JackettClient> | null = null, dryRun = false, now = NOW) =>
    new IndexerDoctor(p as unknown as ProwlarrClient, j as JackettClient | null,
      { intervalMs: 1, dryRun, stateFilePath: join(dir, "doctor.json") }, makeSilentLogger(), () => now);

  it("only tests indexers Prowlarr is backing off", async () => {
    let tests = 0;
    const p = new FakeProwlarr([ix(1, "Good"), ix(2, "Bad")], [failing(2)], () => { tests++; return "Request timed out"; });
    const checks = await doctor(p).runOnce();
    assert.equal(tests, 1);
    assert.deepEqual(checks.map((c) => [c.name, c.status, c.needsHuman]), [["Good", "ok", false], ["Bad", "error", false]]);
  });

  it("adds the FlareSolverr tag to a Cloudflare-blocked indexer when that makes it work", async () => {
    const p = new FakeProwlarr([ix(3, "EZTV")], [failing(3)],
      (c) => (c.tags.includes(7) ? null : "Unable to access eztvx.to, blocked by CloudFlare Protection."));
    const [check] = await doctor(p).runOnce();
    assert.equal(check.status, "ok");
    assert.equal(check.autoFix?.action, "flaresolverr-tag");
    assert.deepEqual(p.updated.map((u) => u.tags), [[7]]);
  });

  it("leaves the indexer alone when the fix doesn't help, or in dry run", async () => {
    const cf = "blocked by CloudFlare Protection.";
    const p1 = new FakeProwlarr([ix(3, "EZTV")], [failing(3)], () => cf);
    assert.equal((await doctor(p1).runOnce())[0].status, "error");
    assert.equal(p1.updated.length, 0);
    const p2 = new FakeProwlarr([ix(3, "EZTV")], [failing(3)], (c) => (c.tags.includes(7) ? null : cf));
    assert.equal((await doctor(p2, null, true).runOnce())[0].status, "error");
    assert.equal(p2.updated.length, 0);
  });

  it("switches to another of the definition's URLs when the site moved there", async () => {
    const p = new FakeProwlarr([ix(4, "BitSearch", { indexerUrls: ["https://bitsearch.to/", "https://solidtorrents.eu/"] })], [failing(4)],
      (c) => (c.fields.find((f) => f.name === "baseUrl")?.value === "https://solidtorrents.eu/" ? null : "Redirected to https://solidtorrents.eu/latest from indexer request"));
    const [check] = await doctor(p).runOnce();
    assert.equal(check.autoFix?.action, "base-url-switch");
    assert.equal(p.updated[0].fields.find((f) => f.name === "baseUrl")?.value, "https://solidtorrents.eu/");
  });

  it("flags login failures for a human straight away, other failures after a day", async () => {
    const p = new FakeProwlarr([ix(5, "RuTracker"), ix(6, "Flaky")], [failing(5), failing(6)],
      (c) => (c.name === "RuTracker" ? "[403:Forbidden] [POST] at [https://rutracker.org/forum/login.php]" : "Request timed out"));
    const first = await doctor(p).runOnce();
    assert.deepEqual(first.map((c) => c.needsHuman), [true, false]);
    const later = await doctor(p, null, false, NOW + 25 * 3600_000).runOnce();
    assert.deepEqual(later.map((c) => c.needsHuman), [true, true]);
  });

  it("re-tests something it saw failing even after Prowlarr stops backing it off", async () => {
    let ok = false;
    const p = new FakeProwlarr([ix(6, "Flaky")], [failing(6)], () => (ok ? null : "Request timed out"));
    await doctor(p).runOnce();
    p.statuses = [];
    ok = true;
    const [check] = await doctor(p).runOnce();
    assert.equal(check.status, "ok");
    assert.equal(check.failingSince, null);
  });

  it("reports Jackett indexers without changing them", async () => {
    const j = {
      getConfiguredIndexers: async () => [{ id: "nyaasi", name: "Nyaa.si" }, { id: "therarbg", name: "TheRARBG" }],
      testIndexer: async (id: string) => (id === "therarbg" ? "Bad request" : null),
    };
    const checks = await doctor(null, j).runOnce();
    assert.deepEqual(checks.map((c) => [c.via, c.name, c.status]), [["jackett", "Nyaa.si", "ok"], ["jackett", "TheRARBG", "error"]]);
  });

  it("refreshes status cheaply between runs", async () => {
    const p = new FakeProwlarr([ix(6, "Flaky")], [failing(6)], () => "Request timed out");
    const d = doctor(p);
    await d.runOnce();
    d.refreshProwlarrStatus(p.indexers, []);
    assert.equal(d.snapshot()[0].status, "ok");
    d.refreshProwlarrStatus(p.indexers, [failing(6)]);
    assert.equal(d.snapshot()[0].status, "warn");
  });
});
