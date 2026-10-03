import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyRelease, kindForApp } from "./release-inspector.js";

const MB = 1024 * 1024;

describe("classifyRelease", () => {
  it("passes a video release that has a real video file (extras don't matter here)", () => {
    assert.deepEqual(
      classifyRelease([
        { name: "Movie (2020)/Movie.2020.1080p.mkv", size: 4000 * MB },
        { name: "Movie (2020)/Movie.2020.1080p.nfo", size: 1024 },
        { name: "Movie (2020)/Codec.Installer.exe", size: 2 * MB },
      ], "video"),
      { bad: false },
    );
  });

  it("flags the padded-exe-in-iso fake: a disc image is not video", () => {
    const v = classifyRelease([{ name: "The Librarians (2025) 1080p.WEB.h264.iso", size: 1153 * MB }], "video");
    assert.equal(v.bad, true);
  });

  it("flags a release that is only an exe or archive", () => {
    assert.equal(classifyRelease([{ name: "Movie.2024.1080p.exe", size: 1200 * MB }], "video").bad, true);
    assert.equal(classifyRelease([{ name: "Movie.2024.part1.rar", size: 1000 * MB }, { name: "Movie.2024.part2.rar", size: 1000 * MB }], "video").bad, true);
  });

  it("does not count a lone sample clip as the release", () => {
    assert.equal(classifyRelease([{ name: "Movie/Sample/movie-sample.mkv", size: 40 * MB }, { name: "Movie/movie.exe", size: 900 * MB }], "video").bad, true);
  });

  it("uses audio types for Lidarr", () => {
    assert.equal(classifyRelease([{ name: "Album/01 - Track.flac", size: 30 * MB }, { name: "Album/cover.jpg", size: 1 * MB }], "audio").bad, false);
    assert.equal(classifyRelease([{ name: "Album/Album.mkv", size: 900 * MB }], "audio").bad, true);
  });

  it("does not judge a torrent whose file list isn't known yet", () => {
    assert.deepEqual(classifyRelease([], "video"), { bad: false });
  });

  it("is case-insensitive on extensions", () => {
    assert.equal(classifyRelease([{ name: "FILM.M4V", size: 900 * MB }], "video").bad, false);
  });
});

describe("kindForApp", () => {
  it("maps each *arr to the media it imports", () => {
    assert.equal(kindForApp("sonarr"), "video");
    assert.equal(kindForApp("radarr"), "video");
    assert.equal(kindForApp("lidarr"), "audio");
    assert.equal(kindForApp("readarr"), null);
  });
});
