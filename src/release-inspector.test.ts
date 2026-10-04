import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyRelease, isUpscale, kindForApp } from "./release-inspector.js";

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

describe("upscales", () => {
  it("flags upscaled releases by name, even before file metadata arrives", () => {
    const name = "300 2006  2160p Open Matte AI Upscaled BluRay 60FPS.H265.SDR.DTS-HD MA TrueHD 7.1.MultiSubs Marjenbo";
    assert.deepEqual(classifyRelease([], "video", name), { bad: true, reason: "upscaled release" });
    assert.equal(classifyRelease([{ name: "300.mkv", size: 30000 * MB }], "video", name).bad, true);
  });
  it("flags an upscale named only in the video file", () => {
    assert.equal(classifyRelease([{ name: "Film/Film.2160p.UPSCALED.mkv", size: 9000 * MB }], "video", "Film 2160p").bad, true);
  });
  it("recognises common upscale markers", () => {
    for (const n of ["Film.2160p.Upscale.x265", "Film 4K AI-Upscaled", "Film.UpsUHD.2160p", "Film.Upconverted.1080p", "Film.AI.Enhanced.2160p", "Film_upscaled_HDR"]) {
      assert.equal(isUpscale(n), true, n);
    }
  });
  it("leaves normal releases and look-alike words alone", () => {
    for (const n of ["Film.2160p.UHD.BluRay.x265", "Upstream.Color.2013.1080p", "The.Upside.2017.1080p", "Film.Remastered.1080p", "Scaled.Down.2020"]) {
      assert.equal(isUpscale(n), false, n);
    }
  });
  it("doesn't apply to Lidarr", () => {
    assert.equal(classifyRelease([{ name: "01.flac", size: 30 * MB }], "audio", "Album (Upscaled Remaster)").bad, false);
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
