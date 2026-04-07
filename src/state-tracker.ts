import type { QBitTorrent, StuckTorrent, TrackedState } from "./types.js";

const STUCK_ELIGIBLE_STATES = new Set(["metaDL", "forcedMetaDL", "stalledDL"]);
const METADATA_STATES = new Set(["metaDL", "forcedMetaDL"]);

export class StateTracker {
  private tracked = new Map<string, TrackedState>();
  private pendingDeletions = new Set<string>();

  constructor(private getNow: () => number = Date.now) {}

  update(
    torrents: QBitTorrent[],
    metadataStuckMs: number,
    stalledStuckMs: number,
  ): StuckTorrent[] {
    const currentHashes = new Set(torrents.map((t) => t.hash));

    // Prune entries for torrents no longer in qBittorrent
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
          // metaDL is the initial state for magnet links. We use time_active (seconds
          // the torrent has been running, excluding time spent queued) for immediate
          // detection — even on the first poll after a service restart. This is safe
          // even if the torrent waited in queuedDL for hours before entering metaDL,
          // because time_active only counts active time.
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
          // Clean up any stale stalledDL tracking entry if state changed to metaDL
          this.tracked.delete(torrent.hash);
        } else {
          // stalledDL can happen at any point — must poll-track with firstSeenAt
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
        // Torrent is in a non-stuck state — remove from tracking if present
        this.tracked.delete(torrent.hash);
      }
    }

    // Sort by duration descending (oldest first) for circuit breaker
    stuck.sort((a, b) => b.stuckDurationMs - a.stuckDurationMs);

    return stuck;
  }

  addPendingDeletion(hash: string): void {
    this.pendingDeletions.add(hash);
  }

  getPendingDeletions(): string[] {
    const hashes = [...this.pendingDeletions];
    this.pendingDeletions.clear();
    return hashes;
  }

  remove(hash: string): void {
    this.tracked.delete(hash);
    this.pendingDeletions.delete(hash);
  }
}
