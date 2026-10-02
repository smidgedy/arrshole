/** qBittorrent states considered eligible for stuck detection. */
export const STUCK_ELIGIBLE_STATES = new Set(["metaDL", "forcedMetaDL", "stalledDL"]);

/** Subset of stuck-eligible states that represent metadata fetch. */
export const METADATA_STATES = new Set(["metaDL", "forcedMetaDL"]);

/**
 * States representing torrents that should be actively transferring data.
 * Used by the outage guard to gauge how much of the client is "trying to
 * download" when global transfer speed is near zero.
 */
export const ACTIVE_DOWNLOAD_STATES = new Set([
  "downloading",
  "forcedDL",
  "metaDL",
  "forcedMetaDL",
  "stalledDL",
]);

export interface QBitTorrent {
  hash: string;
  name: string;
  state: string;
  category: string;
  added_on: number;
  time_active: number;
  last_activity: number;
  progress: number;
  dlspeed: number;
  size: number;
}

/** Global transfer stats from qBittorrent's /transfer/info endpoint. */
export interface QBitTransferInfo {
  dl_info_speed: number; // global download rate, bytes/s
  up_info_speed: number; // global upload rate, bytes/s
}

export interface ArrQueueRecord {
  id: number;
  downloadId: string;
  title: string;
}

/**
 * A *arr queue item carrying the tracked-download status fields used to detect
 * releases that finished downloading but were rejected at import time.
 */
export interface ArrRejectRecord {
  id: number;
  downloadId: string;
  title: string;
  /** e.g. "importFailed", "importBlocked", "importPending", "downloading". */
  trackedDownloadState: string;
  /** e.g. "ok", "warning", "error". */
  trackedDownloadStatus: string;
  /** True once the download has finished (sizeleft === 0) — the safe-to-act gate. */
  downloadComplete: boolean;
  /** Human-readable reasons the import was rejected/blocked. */
  messages: string[];
}

/** What arrshole should do with a rejected import (see reject-classifier). */
export type RejectAction =
  /** Delete download + files, blocklist the release, search for a replacement. */
  | { kind: "defective"; reason: string }
  /** Delete download + files, blocklist to stop a re-grab loop, but do NOT re-search. */
  | { kind: "redundant"; reason: string }
  /** Leave it alone (transient state, or a reason we don't recognise). */
  | { kind: "skip"; reason: string };

export interface StuckTorrent {
  hash: string;
  name: string;
  state: string;
  category: string;
  stuckDurationMs: number;
}

export interface TrackedState {
  hash: string;
  name: string;
  state: string;
  category: string;
  firstSeenAt: number;
}

/** Progress-based stalled threshold: torrents at or below maxProgress% use this stuckMs. */
export interface StalledThreshold {
  maxProgress: number; // 0–100 percentage
  stuckMs: number;
}

/** Shape of the persisted state file on disk. */
export interface PersistedState {
  version: 1;
  savedAt: number;
  tracked: TrackedState[];
  pendingDeletions: string[];
  retryCounts: [string, number][];
}
