import type { QBitTorrent, StuckTorrent, TrackedState } from "./types.js";

const STUCK_ELIGIBLE_STATES = new Set(["metaDL", "forcedMetaDL", "stalledDL"]);
const METADATA_STATES = new Set(["metaDL", "forcedMetaDL"]);

export class StateTracker {
  private tracked = new Map<string, TrackedState>();
  private pendingDeletions = new Set<string>();
  private retryCount = new Map<string, number>();
  private static readonly MAX_PENDING_RETRIES = 10;

  constructor(private getNow: () => number = Date.now) {}

  update(
    torrents: QBitTorrent[],
    metadataStuckMs: number,
    stalledStuckMs: number,
  ): StuckTorrent[] {
    const currentHashes = new Set(torrents.map((t) => t.hash));

    for (const hash of this.tracked.keys()) {
      if (!currentHashes.has(hash)) {
        this.tracked.delete(hash);
      }
    }

    const stuck: StuckTorrent[] = [];
    const now = this.getNow();

    for (const torrent of torrents) {
      if (STUCK_ELIGIBLE_STATES.has(torrent.state)) {
        const isMetadata = METADATA_STATES.has(torrent.state);

        if (isMetadata) {
          const activeMs = torrent.time_active * 1000;

          if (activeMs >= metadataStuckMs) {
            stuck.push({
              hash: torrent.hash,
              name: torrent.name,
              state: torrent.state,
              category: torrent.category,
              stuckDurationMs: activeMs,
            });
          }
          this.tracked.delete(torrent.hash);
        } else {
          const existing = this.tracked.get(torrent.hash);

          if (!existing) {
            this.tracked.set(torrent.hash, {
              hash: torrent.hash,
              name: torrent.name,
              state: torrent.state,
              category: torrent.category,
              firstSeenAt: now,
            });
          } else {
            const duration = now - existing.firstSeenAt;

            if (duration >= stalledStuckMs) {
              stuck.push({
                hash: torrent.hash,
                name: torrent.name,
                state: torrent.state,
                category: torrent.category,
                stuckDurationMs: duration,
              });
            }

            existing.state = torrent.state;
          }
        }
      } else {
        this.tracked.delete(torrent.hash);
      }
    }

    stuck.sort((a, b) => b.stuckDurationMs - a.stuckDurationMs);

    return stuck;
  }

  addPendingDeletion(hash: string): boolean {
    const current = this.retryCount.get(hash) ?? 0;
    const count = current + 1;
    if (count <= StateTracker.MAX_PENDING_RETRIES) {
      this.pendingDeletions.add(hash);
      this.retryCount.set(hash, count);
      return true;
    }
    this.retryCount.delete(hash);
    return false;
  }

  getPendingDeletions(): string[] {
    const hashes = [...this.pendingDeletions];
    this.pendingDeletions.clear();
    return hashes;
  }

  remove(hash: string): void {
    this.tracked.delete(hash);
    this.pendingDeletions.delete(hash);
    this.retryCount.delete(hash);
  }
}
