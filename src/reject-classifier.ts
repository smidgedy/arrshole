import type { ArrRejectRecord, RejectAction } from "./types.js";

/**
 * Decides what to do with a *arr queue item whose download has finished but
 * which *arr will not import.
 *
 * Detection is driven entirely by the *arr side, never by qBittorrent state: a
 * completed torrent sitting at stoppedUP/pausedUP is indistinguishable, from
 * qBit's view, from a healthy torrent seeding after a successful import.
 *
 * The gate is **download completion + an import problem**, NOT the specific
 * trackedDownloadState. A finished download that *arr flags with warning/error
 * is dead no matter whether *arr files it under importFailed, importBlocked, or
 * (indefinitely) importPending — it will never import on its own. The only
 * items we must leave alone are those still downloading (sizeleft > 0) and those
 * *arr is importing normally (trackedDownloadStatus === "ok").
 *
 * Three outcomes:
 *   - defective  → the release itself is bad (incomplete, wrong match, nothing
 *                  importable). No acceptable file, so blocklist and re-search.
 *   - redundant  → the release is fine but not wanted (already have an equal or
 *                  better file — "not an upgrade"). Clean up the orphan and
 *                  blocklist to stop a re-grab loop, but do NOT re-search.
 *   - skip       → download still in progress, *arr importing normally, or a
 *                  reason we don't recognise. Left untouched and logged.
 */

/** trackedDownloadStatus values that indicate *arr has flagged an import problem. */
const PROBLEM_STATUSES = new Set(["warning", "error"]);

/**
 * Severity ranking for collapsing a multi-record download to one state.
 * A season-pack surfaces as one *arr queue record per episode, all sharing a
 * downloadId; if any episode hard-failed import we want the whole torrent
 * treated as importFailed.
 */
const STATE_SEVERITY: Record<string, number> = { importFailed: 3, importBlocked: 2, importPending: 1 };

/**
 * Reason fragments (lowercase, substring match) that mean the release is fine
 * but redundant — we already have an equal/better file. Delete + blocklist,
 * never re-search.
 */
const REDUNDANT_MARKERS = [
  "not an upgrade for existing",
  "not a custom format upgrade",
  "has fewer tracks than existing",
  "contains more episodes than this file contains",
];

/**
 * Reason fragments that mean the release is genuinely defective — incomplete,
 * the wrong content, unusable, or one *arr has declared it cannot auto-import.
 * Delete + blocklist + re-search for a replacement.
 */
const DEFECTIVE_MARKERS = [
  "not imported or missing",
  "were not imported",
  "not found in the grabbed release",
  "match is not close enough",
  "no files found are eligible for import",
  "unable to parse",
  "has missing tracks",
  "has unmatched tracks",
  "couldn't find similar album",
  "worst track match",
  "unable to determine if file is a sample",
  "multi-part file", // Radarr: "suspected multi-part file, Radarr doesn't support this"
  "matched to series by id", // "...automatic import is not possible"
  "matched to movie by id",
  "series title mismatch", // "...automatic import is not possible"
  "found executable file with extension", // release contains an .exe instead of media — fake/malicious
  "found potentially dangerous file with extension", // e.g. .zipx — same fake/junk-release pattern
];

/** Return the first marker in `markers` found anywhere in `text`, else null. */
function firstMatch(text: string, markers: string[]): string | null {
  for (const m of markers) {
    if (text.includes(m)) return m;
  }
  return null;
}

export function classifyReject(item: ArrRejectRecord): RejectAction {
  // Gate 1: never touch a download that hasn't finished.
  if (!item.downloadComplete) {
    return { kind: "skip", reason: "download still in progress" };
  }

  // Gate 2: only act when *arr has flagged an import problem. A completed
  // download that *arr is importing normally has trackedDownloadStatus "ok".
  if (!PROBLEM_STATUSES.has(item.trackedDownloadStatus)) {
    return { kind: "skip", reason: `trackedDownloadStatus=${item.trackedDownloadStatus || "(none)"} (no import problem flagged)` };
  }

  // Still actively importing right now — give it the cycle to finish.
  if (item.trackedDownloadState === "importing") {
    return { kind: "skip", reason: "state=importing (in progress)" };
  }

  const text = item.messages.join(" • ").toLowerCase();

  const redundant = firstMatch(text, REDUNDANT_MARKERS);
  if (redundant) {
    return { kind: "redundant", reason: redundant };
  }

  const defective = firstMatch(text, DEFECTIVE_MARKERS);
  if (defective) {
    return { kind: "defective", reason: defective };
  }

  // A hard import failure with no recognised reason: trust the state — the
  // import was attempted and failed, so the release is treated as defective.
  if (item.trackedDownloadState === "importFailed") {
    return { kind: "defective", reason: "importFailed (unrecognised reason)" };
  }

  // Completed download flagged with a problem we haven't classified. Don't
  // guess at the defective/redundant split — skip and surface it so a marker
  // can be added.
  return {
    kind: "skip",
    reason: `unrecognised reason (${item.trackedDownloadState}): ${item.messages.join("; ").slice(0, 200) || "(none)"}`,
  };
}

/**
 * Collapse queue records to one entry per download. *arr lists a season-pack as
 * many records (one per episode/track) that all point at the same torrent, so
 * acting per-record would fire N deletes at one torrent and waste N circuit-
 * breaker slots. Records with no downloadId are kept separate (keyed by id).
 * The merged entry takes the most severe state, the union of all messages, the
 * strongest problem status, and is complete only if every part is complete.
 */
export function aggregateRejects(records: ArrRejectRecord[]): ArrRejectRecord[] {
  const groups = new Map<string, ArrRejectRecord>();

  for (const r of records) {
    const key = r.downloadId ? r.downloadId.toUpperCase() : `__id_${r.id}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...r, messages: [...r.messages] });
      continue;
    }
    const seen = new Set(existing.messages);
    for (const m of r.messages) if (!seen.has(m)) existing.messages.push(m);
    if ((STATE_SEVERITY[r.trackedDownloadState] ?? 0) > (STATE_SEVERITY[existing.trackedDownloadState] ?? 0)) {
      existing.trackedDownloadState = r.trackedDownloadState;
    }
    // A torrent is only "complete" if every one of its records is complete.
    existing.downloadComplete = existing.downloadComplete && r.downloadComplete;
    // Escalate to the strongest problem status seen across the group.
    if (r.trackedDownloadStatus === "error" || existing.trackedDownloadStatus === "error") {
      existing.trackedDownloadStatus = "error";
    } else if (PROBLEM_STATUSES.has(r.trackedDownloadStatus) && !PROBLEM_STATUSES.has(existing.trackedDownloadStatus)) {
      existing.trackedDownloadStatus = r.trackedDownloadStatus;
    }
  }

  return [...groups.values()];
}
