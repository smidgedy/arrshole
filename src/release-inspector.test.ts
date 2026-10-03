import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyRelease } from "./release-inspector.js";

const MB = 1024 * 1024;

describe("classifyRelease", () => {
  it("passes a normal video release with extras", () => {
    assert.deepEqual(
      classifyRelease([
        { name: "Movie (2020)/Movie.2020.1080p.mkv", size: 4000 * MB },
        { name: "Movie (2020)/Movie.2020.1080p.nfo", size: 1024 },
        { name: "Movie (2020)/Subs/English.srt", size: 50_000 },
        { name: "Movie (2020)/Sample/sample.mkv", size: 20 * MB },
      ]),
      { bad: false },
    );
  });

  it("flags the padded-exe-in-iso fake (The Librarians case)", () => {
    const v = classifyRelease([{ name: "The Librarians (2025) 1080p.WEB.h264.iso", size: 1153 * MB }]);
    assert.equal(v.bad, true);
    assert.match((v as { reason: string }).reason, /disc image/);
  });

  it("flags a release carrying an executable alongside video", () => {
    const v = classifyRelease([
      { name: "Show.S01E01.mkv", size: 800 * MB },
      { name: "Show.S01E01.Codec.Installer.exe", size: 3 * MB },
    ]);
    assert.equal(v.bad, true);
    assert.match((v as { reason: string }).reason, /executable/);
  });

  it("flags shortcuts and scripts too", () => {
    for (const bad of ["Play Movie.lnk", "watch.bat", "setup.msi", "readme.js", "x.scr", "y.ps1"]) {
      assert.equal(classifyRelease([{ name: "m.mkv", size: 900 * MB }, { name: bad, size: 2000 }]).bad, true, bad);
    }
  });

  it("allows the tiny genuine RARBG decoy but not a large one with the same name", () => {
    const video = { name: "Film.1080p.mkv", size: 2000 * MB };
    assert.equal(classifyRelease([video, { name: "RARBG_DO_NOT_MIRROR.exe", size: 99_000 }]).bad, false);
    assert.equal(classifyRelease([video, { name: "RARBG_DO_NOT_MIRROR.exe", size: 900 * MB }]).bad, true);
  });

  it("flags releases with no video at all", () => {
    const v = classifyRelease([
      { name: "Movie.2024.part1.rar", size: 1000 * MB },
      { name: "Movie.2024.part2.rar", size: 1000 * MB },
      { name: "password.txt", size: 100 },
    ]);
    assert.equal(v.bad, true);
    assert.match((v as { reason: string }).reason, /no video/);
  });

  it("does not judge a torrent whose file list isn't known yet", () => {
    assert.deepEqual(classifyRelease([]), { bad: false });
  });

  it("is case-insensitive on extensions", () => {
    assert.equal(classifyRelease([{ name: "MOVIE.MKV", size: 900 * MB }, { name: "RUN.EXE", size: 5 * MB }]).bad, true);
    assert.equal(classifyRelease([{ name: "FILM.M4V", size: 900 * MB }]).bad, false);
  });
});
