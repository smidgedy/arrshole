import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyReject, aggregateRejects } from "./reject-classifier.js";
import type { ArrRejectRecord } from "./types.js";

function rec(overrides: Partial<ArrRejectRecord> = {}): ArrRejectRecord {
  return {
    id: 1,
    downloadId: "ABC",
    title: "Release",
    trackedDownloadState: "importFailed",
    trackedDownloadStatus: "warning",
    downloadComplete: true,
    messages: [],
    ...overrides,
  };
}

describe("classifyReject", () => {
  it("classifies Lidarr missing-tracks as defective (re-search)", () => {
    const v = classifyReject(rec({
      trackedDownloadState: "importFailed",
      messages: [
        "One or more tracks expected in this release were not imported or missing from the release",
        "Album.flac",
      ],
    }));
    assert.equal(v.kind, "defective");
  });

  it("classifies Sonarr missing-episodes as defective", () => {
    const v = classifyReject(rec({
      trackedDownloadState: "importBlocked",
      messages: ["One or more episodes expected in this release were not imported or missing from the release"],
    }));
    assert.equal(v.kind, "defective");
  });

  it("classifies wrong-match (album match not close enough) as defective", () => {
    const v = classifyReject(rec({
      trackedDownloadState: "importFailed",
      messages: ["Album match is not close enough: 68.1% vs 80%"],
    }));
    assert.equal(v.kind, "defective");
  });

  it("classifies 'not an upgrade' as redundant (no re-search)", () => {
    const v = classifyReject(rec({
      trackedDownloadState: "importBlocked",
      messages: ["Not an upgrade for existing episode file(s). Existing quality: WEBDL-1080p"],
    }));
    assert.equal(v.kind, "redundant");
  });

  it("redundant takes precedence when both markers present", () => {
    const v = classifyReject(rec({
      trackedDownloadState: "importBlocked",
      messages: [
        "Not an upgrade for existing episode file(s)",
        "One or more episodes were not imported or missing",
      ],
    }));
    assert.equal(v.kind, "redundant");
  });

  it("acts on a COMPLETED importPending with a terminal reason (not transient)", () => {
    // A finished download stuck pending import forever — the common real case.
    const v = classifyReject(rec({
      trackedDownloadState: "importPending",
      downloadComplete: true,
      messages: ["One or more episodes expected in this release were not imported or missing from the release"],
    }));
    assert.equal(v.kind, "defective");
  });

  it("classifies completed 'not a custom format upgrade' importPending as redundant", () => {
    const v = classifyReject(rec({
      trackedDownloadState: "importPending",
      downloadComplete: true,
      messages: ["Not a Custom Format upgrade for existing episode file(s). Existing: ..."],
    }));
    assert.equal(v.kind, "redundant");
  });

  it("classifies 'no files eligible for import' as defective", () => {
    const v = classifyReject(rec({
      trackedDownloadState: "importPending",
      downloadComplete: true,
      messages: ["No files found are eligible for import in I:\\Torrents\\Complete\\Foo"],
    }));
    assert.equal(v.kind, "defective");
  });

  it("skips a download still in progress even with a rejection-looking message", () => {
    const v = classifyReject(rec({
      trackedDownloadState: "importPending",
      downloadComplete: false,
      messages: ["One or more episodes were not imported or missing"],
    }));
    assert.equal(v.kind, "skip");
  });

  it("skips a completed download that *arr flags as ok (importing normally)", () => {
    const v = classifyReject(rec({
      trackedDownloadState: "importPending",
      trackedDownloadStatus: "ok",
      downloadComplete: true,
      messages: [],
    }));
    assert.equal(v.kind, "skip");
  });

  it("skips the active-import window (state=importing)", () => {
    const v = classifyReject(rec({
      trackedDownloadState: "importing",
      downloadComplete: true,
      messages: ["were not imported"],
    }));
    assert.equal(v.kind, "skip");
  });

  it("importFailed with unrecognised reason falls back to defective (trust the hard fail)", () => {
    const v = classifyReject(rec({
      trackedDownloadState: "importFailed",
      messages: ["Some brand new failure reason we've never seen"],
    }));
    assert.equal(v.kind, "defective");
  });

  it("treats 'matched to series by ID' (auto-import impossible) as defective", () => {
    const v = classifyReject(rec({
      trackedDownloadState: "importBlocked",
      messages: ["Found matching series via grab history, but release was matched to series by ID. Automatic import is not possible."],
    }));
    assert.equal(v.kind, "defective");
  });

  it("treats 'series title mismatch' (auto-import impossible) as defective", () => {
    const v = classifyReject(rec({
      trackedDownloadState: "importBlocked",
      messages: ["Series title mismatch; automatic import is not possible. Check the download troubleshooting entry on the wiki for common causes."],
    }));
    assert.equal(v.kind, "defective");
  });

  it("treats a release containing an executable file as defective (fake/malicious release)", () => {
    const v = classifyReject(rec({
      trackedDownloadState: "importPending",
      messages: ["Slow Horses S06E01 1080p ATVP WEB-DL DDP5 1 H 264-NTb", "Caution: Found executable file with extension: '.exe'"],
    }));
    assert.equal(v.kind, "defective");
  });

  it("treats a release containing a potentially dangerous file (e.g. .zipx) as defective", () => {
    const v = classifyReject(rec({
      trackedDownloadState: "importPending",
      messages: ["Caution: Found potentially dangerous file with extension: .zipx"],
    }));
    assert.equal(v.kind, "defective");
  });

  it("does NOT classify an archive needing extraction as defective — needs manual triage, not auto-prune", () => {
    const v = classifyReject(rec({
      trackedDownloadState: "importPending",
      messages: ["Found archive file, might need to be extracted"],
    }));
    assert.equal(v.kind, "skip");
  });

  it("does NOT classify an unconfirmed TheXEM mapping as defective — transient, not a bad release", () => {
    const v = classifyReject(rec({
      trackedDownloadState: "importPending",
      messages: ["This show has individual episode mappings on TheXEM but the mapping for this episode has not been confirmed yet by their administrators."],
    }));
    assert.equal(v.kind, "skip");
  });

  it("importBlocked, complete, with a genuinely unrecognised reason is skipped (don't guess)", () => {
    const v = classifyReject(rec({
      trackedDownloadState: "importBlocked",
      messages: ["Some totally novel blocking reason nobody has seen before"],
    }));
    assert.equal(v.kind, "skip");
  });

  it("is case-insensitive on reason text", () => {
    const v = classifyReject(rec({
      trackedDownloadState: "importBlocked",
      messages: ["NOT AN UPGRADE FOR EXISTING EPISODE FILE(S)"],
    }));
    assert.equal(v.kind, "redundant");
  });
});

describe("aggregateRejects", () => {
  it("collapses a season-pack (many records, one downloadId) to a single entry", () => {
    const records = Array.from({ length: 18 }, (_, i) =>
      rec({ id: 100 + i, downloadId: "SEASON5HASH", title: "Show S05", trackedDownloadState: "importBlocked",
        messages: [`Episode ${i} not an upgrade for existing episode file(s)`] }),
    );
    const out = aggregateRejects(records);
    assert.equal(out.length, 1);
    assert.equal(out[0].messages.length, 18); // union of all episode messages
  });

  it("promotes to the most severe state across the group", () => {
    const out = aggregateRejects([
      rec({ id: 1, downloadId: "H", trackedDownloadState: "importBlocked", messages: ["not an upgrade for existing"] }),
      rec({ id: 2, downloadId: "H", trackedDownloadState: "importFailed", messages: ["were not imported"] }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].trackedDownloadState, "importFailed");
  });

  it("is case-insensitive on downloadId and keeps distinct torrents separate", () => {
    const out = aggregateRejects([
      rec({ id: 1, downloadId: "abc" }),
      rec({ id: 2, downloadId: "ABC" }),
      rec({ id: 3, downloadId: "XYZ" }),
    ]);
    assert.equal(out.length, 2);
  });

  it("does not merge records that have no downloadId", () => {
    const out = aggregateRejects([
      rec({ id: 1, downloadId: "" }),
      rec({ id: 2, downloadId: "" }),
    ]);
    assert.equal(out.length, 2);
  });
});
