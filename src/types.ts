/** qBittorrent states considered eligible for stuck detection. */
export const STUCK_ELIGIBLE_STATES = new Set(["metaDL", "forcedMetaDL", "stalledDL"]);

/** Subset of stuck-eligible states that represent metadata fetch. */
export const METADATA_STATES = new Set(["metaDL", "forcedMetaDL"]);

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

export interface ArrQueueRecord {
  id: number;
  downloadId: string;
  title: string;
}

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
