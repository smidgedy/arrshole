import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import type { Logger } from "./logger.js";
import { STUCK_ELIGIBLE_STATES, METADATA_STATES } from "./types.js";
import type { QBitTorrent, StuckTorrent, TrackedState, PersistedState, StalledThreshold } from "./types.js";

/**
 * Tracks torrent stall durations across poll cycles. Persists state to disk
 * so timers survive restarts. Returns stuck torrents that have exceeded their
 * progress-based thresholds.
 */
export class StateTracker {
  private tracked = new Map<string, TrackedState>();
  private pendingDeletions = new Set<string>();
  private retryCount = new Map<string, number>();
  private static readonly MAX_PENDING_RETRIES = 10;

  constructor(
    private logger?: Logger,
    private stateFilePath?: string,
    private getNow: () => number = Date.now,
  ) {}

  /** Load persisted state from disk. Call once at startup. */
  loadFromDisk(): void {
    if (!this.stateFilePath) return;
    try {
      const raw = readFileSync(this.stateFilePath, "utf-8");
      const data: PersistedState = JSON.parse(raw);

      if (data.version !== 1) {
        this.logger?.warn({ version: data.version }, "Unknown state file version — starting fresh");
        return;
      }

      for (const entry of data.tracked) {
        this.tracked.set(entry.hash, entry);
      }
      for (const hash of data.pendingDeletions) {
        this.pendingDeletions.add(hash);
      }
      for (const [hash, count] of data.retryCounts) {
        this.retryCount.set(hash, count);
      }

      const ageMs = this.getNow() - data.savedAt;
      this.logger?.info(
        {
          trackedCount: this.tracked.size,
          pendingCount: this.pendingDeletions.size,
          savedAt: new Date(data.savedAt).toISOString(),
          ageSeconds: Math.round(ageMs / 1000),
        },
        "Loaded persisted state from disk",
      );
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        this.logger?.debug("No persisted state file found — starting fresh");
      } else {
        this.logger?.warn({ err }, "Failed to read state file — starting fresh");
      }
    }
  }

  /** Persist current state to disk. */
  private saveToDisk(): void {
    if (!this.stateFilePath) return;
    const data: PersistedState = {
      version: 1,
      savedAt: this.getNow(),
      tracked: [...this.tracked.values()],
      pendingDeletions: [...this.pendingDeletions],
      retryCounts: [...this.retryCount.entries()],
    };
    const tmpPath = this.stateFilePath + ".tmp";
    try {
      writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
      renameSync(tmpPath, this.stateFilePath);
    } catch (err) {
      this.logger?.error({ err }, "Failed to write state file");
      try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    }
  }

  /**
   * Select the appropriate stalled threshold based on torrent progress.
   * Thresholds must be sorted by maxProgress ascending.
   * Progress is 0–1 from qBittorrent, converted to 0–100 for comparison.
   */
  static selectThresholdMs(progress: number, thresholds: StalledThreshold[]): number {
    const pct = progress * 100;
    for (const t of thresholds) {
      if (pct <= t.maxProgress) return t.stuckMs;
    }
    return thresholds[thresholds.length - 1].stuckMs;
  }

  /**
   * Process a batch of torrents from qBittorrent. Tracks new stalled entries,
   * checks existing ones against progress-tiered thresholds, prunes entries
   * for torrents that have disappeared or recovered. Returns torrents that
   * have exceeded their threshold, sorted longest-stalled first.
   */
  update(
    torrents: QBitTorrent[],
    metadataStuckMs: number,
    stalledThresholds: StalledThreshold[],
  ): StuckTorrent[] {
    const currentHashes = new Set(torrents.map((t) => t.hash));

    for (const hash of this.tracked.keys()) {
      if (!currentHashes.has(hash)) {
        this.logger?.debug({ hash }, "Tracked torrent disappeared from qBittorrent — removing");
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
          // stalledDL — poll-based tracking with progress-tiered thresholds
          const existing = this.tracked.get(torrent.hash);

          if (!existing) {
            this.tracked.set(torrent.hash, {
              hash: torrent.hash,
              name: torrent.name,
              state: torrent.state,
              category: torrent.category,
              firstSeenAt: now,
            });
            this.logger?.debug(
              { torrent: torrent.name, hash: torrent.hash, progress: torrent.progress },
              "Started tracking stalled torrent",
            );
          } else {
            const duration = now - existing.firstSeenAt;
            const thresholdMs = StateTracker.selectThresholdMs(torrent.progress, stalledThresholds);

            if (duration >= thresholdMs) {
              this.logger?.debug(
                {
                  torrent: torrent.name,
                  hash: torrent.hash,
                  progress: torrent.progress,
                  durationHours: +(duration / 3600000).toFixed(2),
                  thresholdHours: +(thresholdMs / 3600000).toFixed(2),
                },
                "Stalled torrent exceeded threshold",
              );
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
        // Torrent is no longer in a stuck-eligible state
        const wasTracked = this.tracked.has(torrent.hash);
        if (wasTracked) {
          this.logger?.debug(
            { torrent: torrent.name, hash: torrent.hash, newState: torrent.state },
            "Torrent left stalled state — clearing from tracking",
          );
        }
        this.tracked.delete(torrent.hash);
      }
    }

    stuck.sort((a, b) => b.stuckDurationMs - a.stuckDurationMs);

    this.saveToDisk();
    return stuck;
  }

  /** Queue a hash for orphan deletion retry. Returns false if max retries exceeded. */
  addPendingDeletion(hash: string): boolean {
    const current = this.retryCount.get(hash) ?? 0;
    const count = current + 1;
    if (count <= StateTracker.MAX_PENDING_RETRIES) {
      this.pendingDeletions.add(hash);
      this.retryCount.set(hash, count);
      this.saveToDisk();
      return true;
    }
    this.retryCount.delete(hash);
    this.saveToDisk();
    return false;
  }

  /** Return and clear all pending deletion hashes for retry this cycle. */
  getPendingDeletions(): string[] {
    const hashes = [...this.pendingDeletions];
    this.pendingDeletions.clear();
    return hashes;
  }

  /** Remove a torrent from all tracking (tracked, pending, retry counts). */
  remove(hash: string): void {
    this.tracked.delete(hash);
    this.pendingDeletions.delete(hash);
    this.retryCount.delete(hash);
    this.saveToDisk();
  }
}
