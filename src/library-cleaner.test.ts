import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyLibraryFile, cleanImportFolder, translatePath } from "./library-cleaner.js";
import { makeSilentLogger } from "./test-helpers.js";

const MB = 1024 * 1024;

describe("classifyLibraryFile", () => {
  const imported = "Movie (2020) {tmdb-1} - [WEBDL-1080p].mkv";
  it("keeps the imported file, other videos and subtitles", () => {
    assert.equal(classifyLibraryFile(imported, 4000 * MB, "video", imported).remove, false);
    assert.equal(classifyLibraryFile("Show - S01E02.mkv", 900 * MB, "video", imported).remove, false);
    for (const sub of ["a.srt", "a.en.ass", "a.sup", "a.idx", "a.sub", "a.vtt"]) {
      assert.equal(classifyLibraryFile(sub, 50_000, "video", imported).remove, false, sub);
    }
  });
  it("removes malware-carrying types", () => {
    for (const f of ["setup.exe", "x.com", "run.bat", "run.cmd", "s.scr", "Play.lnk", "a.msi", "a.ps1", "a.vbs", "a.js", "Visit.url"]) {
      assert.equal(classifyLibraryFile(f, 1000, "video", imported).remove, true, f);
    }
  });
  it("removes release cruft and sample clips in video libraries", () => {
    for (const f of ["RARBG.txt", "movie.nfo", "poster.jpg", "screen.png", "movie.iso", "movie.sfv"]) {
      assert.equal(classifyLibraryFile(f, 1000, "video", imported).remove, true, f);
    }
    assert.equal(classifyLibraryFile("movie-sample.mkv", 40 * MB, "video", imported).remove, true);
    assert.equal(classifyLibraryFile("Sample Size Matters (2020).mkv", 4000 * MB, "video", imported).remove, false);
  });
  it("keeps unknown types (when in doubt, leave it)", () => {
    assert.equal(classifyLibraryFile("chapters.xml", 1000, "video", imported).remove, false);
  });
  it("only removes malware types in audio libraries", () => {
    for (const keep of ["cover.jpg", "album.cue", "rip.log", "info.txt", "01.flac"]) {
      assert.equal(classifyLibraryFile(keep, 1000, "audio", "01.flac").remove, false, keep);
    }
    assert.equal(classifyLibraryFile("player.exe", 1000, "audio", "01.flac").remove, true);
  });
});

describe("translatePath", () => {
  const maps: Array<[string, string]> = [["J:\\", "/mnt/j/"]];
  it("maps Windows *arr paths to the local mount", () => {
    assert.equal(translatePath("J:\\Movies\\Film (2020)\\Film.mkv", maps), "/mnt/j/Movies/Film (2020)/Film.mkv");
    assert.equal(translatePath("j:\\Television\\Show\\Season 1\\e.mkv", maps), "/mnt/j/Television/Show/Season 1/e.mkv");
  });
  it("returns null when no rule matches", () => {
    assert.equal(translatePath("D:\\Other\\x.mkv", maps), null);
  });
});

describe("cleanImportFolder", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lib-"));
    for (const [f, size] of [
      ["Film (2020) - [WEBDL-1080p].mkv", 2000], ["Film.en.srt", 10], ["RARBG.txt", 10], ["Film.nfo", 10],
      ["Codec.Pack.exe", 10], ["poster.jpg", 10], ["chapters.xml", 10],
    ] as const) writeFileSync(join(dir, f), Buffer.alloc(size));
    mkdirSync(join(dir, "Subs"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (dryRun: boolean, budget = 50) => cleanImportFolder(join(dir, "Film (2020) - [WEBDL-1080p].mkv"), "video",
    { dryRun, budget, logger: makeSilentLogger(), app: "radarr" });

  it("removes cruft next to the imported file and keeps the media", () => {
    assert.equal(run(false), 4);
    assert.deepEqual(readdirSync(dir).sort(), ["Film (2020) - [WEBDL-1080p].mkv", "Film.en.srt", "Subs", "chapters.xml"]);
  });
  it("removes nothing in dry run", () => {
    assert.equal(run(true), 4);
    assert.equal(readdirSync(dir).length, 8);
  });
  it("stops at the budget", () => {
    assert.equal(run(false, 2), 2);
    assert.equal(readdirSync(dir).length, 6);
  });
  it("copes with a folder that no longer exists", () => {
    rmSync(dir, { recursive: true, force: true });
    assert.equal(run(false), 0);
  });
});
