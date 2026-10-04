import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AnimeClassifier, isAnime } from "./anime-classifier.js";
import type { ArrClient, SeriesSummary } from "./clients/arr-client.js";
import { makeSilentLogger } from "./test-helpers.js";

const ja = { id: 8, name: "Japanese" };
const en = { id: 1, name: "English" };
const series = (id: number, title: string, genres: string[], lang = ja, extra: Partial<SeriesSummary> = {}): SeriesSummary =>
  ({ id, title, seriesType: "standard", qualityProfileId: 7, genres, originalLanguage: lang, tags: [], ...extra });

describe("isAnime", () => {
  it("needs Japanese origin plus the Anime or Animation genre", () => {
    assert.equal(isAnime(series(1, "Frieren", ["Anime", "Fantasy"])), true);
    assert.equal(isAnime(series(2, "Naruto Spin-Off", ["Animation", "Comedy"])), true);
    assert.equal(isAnime(series(3, "Scott Pilgrim Takes Off", ["Anime", "Comedy"], en)), false);
    assert.equal(isAnime(series(4, "Kamen Rider Black Sun", ["Action"])), false);
    assert.equal(isAnime({ genres: undefined, originalLanguage: undefined }), false);
  });
});

class FakeSonarr {
  edits: Array<{ ids: number[]; changes: unknown }> = [];
  constructor(public list: SeriesSummary[], public profiles = new Map([["WEB-1080p", 7], ["Anime", 8]]), public tags = new Map<string, number>()) {}
  async getSeries() { return this.list; }
  async getQualityProfiles() { return this.profiles; }
  async getTags() { return this.tags; }
  async editSeries(ids: number[], changes: unknown) { this.edits.push({ ids, changes }); }
}

const run = (fake: FakeSonarr, dryRun = false, max = 100) =>
  new AnimeClassifier(fake as unknown as ArrClient, { intervalMs: 1, profileName: "Anime", optOutTag: "not-anime", maxChangesPerRun: max }, dryRun, makeSilentLogger()).runOnce();

describe("AnimeClassifier", () => {
  it("switches anime to the anime type and profile in one bulk edit", async () => {
    const fake = new FakeSonarr([
      series(1, "Frieren", ["Anime"]),
      series(2, "Death Note", ["Anime"], ja, { seriesType: "anime" }),
      series(3, "Already done", ["Anime"], ja, { seriesType: "anime", qualityProfileId: 8 }),
      series(4, "Slow Horses", ["Drama"], en),
    ]);
    assert.deepEqual(await run(fake), ["Frieren", "Death Note"]);
    assert.deepEqual(fake.edits, [{ ids: [1, 2], changes: { seriesType: "anime", qualityProfileId: 8 } }]);
  });

  it("respects the not-anime tag, dry run and the per-run cap", async () => {
    const fake = new FakeSonarr([series(1, "A", ["Anime"], ja, { tags: [5] }), series(2, "B", ["Anime"]), series(3, "C", ["Anime"])], undefined, new Map([["not-anime", 5]]));
    assert.deepEqual(await run(fake, true), ["B", "C"]);
    assert.equal(fake.edits.length, 0);
    assert.deepEqual(await run(fake, false, 1), ["B"]);
  });

  it("still sets the type when the anime profile doesn't exist", async () => {
    const fake = new FakeSonarr([series(1, "Frieren", ["Anime"])], new Map([["WEB-1080p", 7]]));
    await run(fake);
    assert.deepEqual(fake.edits, [{ ids: [1], changes: { seriesType: "anime" } }]);
  });
});
