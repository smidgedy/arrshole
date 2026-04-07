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
