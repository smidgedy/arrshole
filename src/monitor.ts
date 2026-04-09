import type { Logger } from "./logger.js";
import type { Config } from "./config.js";
import type { ArrClient } from "./clients/arr-client.js";
import type { QBitClient } from "./clients/qbittorrent.js";
import { StateTracker } from "./state-tracker.js";
import { STUCK_ELIGIBLE_STATES } from "./types.js";

/**
 * Core polling loop. Detects stuck torrents, notifies *arr apps to blocklist
 * and re-search, then deletes the torrent from qBittorrent.
 */
export class Monitor {
  private stateTracker: StateTracker;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private firstCycle = true;
  private pollPromise: Promise<void> | null = null;

  constructor(
    private qbit: QBitClient,
    private arrClients: Map<string, ArrClient>,
    private categoryMap: Map<string, string>,
    private config: Config,
    private logger: Logger,
    stateTracker?: StateTracker,
  ) {
    this.stateTracker = stateTracker ?? new StateTracker(logger, config.stateFilePath);
  }

  /** Start the polling loop. Polls repeat on the configured interval until stop() is called. */
  start(): void {
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        this.pollPromise = this.poll();
        await this.pollPromise;
      } catch (err) {
        this.logger.error(err, "Poll cycle failed");
      } finally {
        this.pollPromise = null;
      }
      if (this.running) {
        this.timeoutId = setTimeout(loop, this.config.pollIntervalMs);
      }
    };
    loop();
  }

  /** Stop the polling loop. Waits for any in-flight poll to complete. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    if (this.pollPromise) {
      await this.pollPromise;
    }
  }

  /** Execute a single poll cycle: detect stuck torrents and process up to maxActionsPerCycle. */
  async poll(): Promise<void> {
    if (this.firstCycle) {
      this.logger.info(
        {
          categoryMap: Object.fromEntries(this.categoryMap),
          arrClients: [...this.arrClients.keys()],
          dryRun: this.config.dryRun,
        },
        "First poll cycle — resolved configuration",
      );
      this.firstCycle = false;
    }

    // Step 1: Retry pending qBit deletions (orphan recovery)
    const pendingHashes = this.stateTracker.getPendingDeletions();
    for (const hash of pendingHashes) {
      try {
        if (this.config.dryRun) {
          this.logger.info({ hash }, "[DRY RUN] Would retry orphan deletion");
        } else {
          await this.qbit.deleteTorrent(hash, true);
          this.logger.warn({ action: "orphan_deleted", hash }, "Retried orphan deletion");
        }
      } catch (err) {
        this.logger.error({ hash, err }, "Orphan deletion retry failed");
        if (!this.stateTracker.addPendingDeletion(hash)) {
          this.logger.warn({ hash }, "Gave up retrying orphan deletion after max retries");
        }
      }
    }

    // Step 2: Fetch all torrents
    const torrents = await this.qbit.getTorrents();

    // Step 3: Detect stuck torrents
    let stuckList = this.stateTracker.update(
      torrents,
      this.config.metadataStuckMs,
      this.config.stalledThresholds,
    );

    this.logger.info(
      { torrents: torrents.length, stuck: stuckList.length, uptimeSeconds: Math.round(process.uptime()) },
      "Poll complete",
    );

    if (stuckList.length === 0) {
      return;
    }

    // Step 3b: Filter out torrents with no mapped *arr app (don't waste circuit breaker slots)
    stuckList = stuckList.filter((t) => {
      const appName = this.categoryMap.get(t.category.toLowerCase());
      if (!appName || !this.arrClients.has(appName)) {
        this.logger.warn(
          { torrent: t.name, category: t.category },
          "No *arr app mapped for category — skipping",
        );
        return false;
      }
      return true;
    });

    if (stuckList.length === 0) {
      return;
    }

    // Step 4: Apply circuit breaker
    if (stuckList.length > this.config.maxActionsPerCycle) {
      this.logger.warn(
        {
          total: stuckList.length,
          processing: this.config.maxActionsPerCycle,
        },
        "Circuit breaker: more stuck torrents than max actions per cycle",
      );
      stuckList = stuckList.slice(0, this.config.maxActionsPerCycle);
    }

    this.logger.info({ count: stuckList.length }, "Processing stuck torrents");

    // Step 5: Process each stuck torrent
    for (const stuck of stuckList) {
      this.logger.info(
        {
          torrent: stuck.name,
          hash: stuck.hash,
          state: stuck.state,
          category: stuck.category,
          stuckHours: +(stuck.stuckDurationMs / 3600000).toFixed(2),
        },
        "Stuck torrent detected — processing",
      );
      try {
        await this.processStuckTorrent(stuck.hash, stuck.name, stuck.state, stuck.category);
      } catch (err) {
        this.logger.error(
          { torrent: stuck.name, hash: stuck.hash, err },
          "Failed to process stuck torrent — will retry next cycle",
        );
      }
    }
  }

  /**
   * One-shot mode: fetch all torrents, filter by the given states and progress
   * bounds, process every match (no circuit breaker), then return.
   */
  async runOnce(
    states: Set<string>,
    below?: number,
    above?: number,
  ): Promise<void> {
    const torrents = await this.qbit.getTorrents();

    const matches = torrents.filter((t) => {
      if (!states.has(t.state)) return false;
      const pct = t.progress * 100;
      if (below !== undefined && pct >= below) return false;
      if (above !== undefined && pct <= above) return false;
      return true;
    });

    this.logger.info(
      { torrents: torrents.length, matched: matches.length, states: [...states], below, above },
      "One-shot run",
    );

    if (matches.length === 0) return;

    for (const t of matches) {
      this.logger.info(
        {
          torrent: t.name,
          hash: t.hash,
          state: t.state,
          category: t.category,
          progress: +(t.progress * 100).toFixed(1) + "%",
        },
        "One-shot: processing torrent",
      );
      try {
        await this.processStuckTorrent(t.hash, t.name, t.state, t.category);
      } catch (err) {
        this.logger.error(
          { torrent: t.name, hash: t.hash, err },
          "Failed to process torrent in one-shot mode",
        );
      }
    }
  }

  private async processStuckTorrent(
    hash: string,
    name: string,
    state: string,
    category: string,
  ): Promise<void> {
    // Resolve *arr app from category
    const appName = this.categoryMap.get(category.toLowerCase());
    if (!appName) {
      this.logger.warn(
        { torrent: name, category },
        "No *arr app mapped for category — skipping",
      );
      return;
    }

    const arrClient = this.arrClients.get(appName);
    if (!arrClient) {
      this.logger.warn(
        { torrent: name, category, appName },
        "*arr client not configured — skipping",
      );
      return;
    }

    // DRY_RUN check
    if (this.config.dryRun) {
      this.logger.info(
        {
          torrent: name,
          hash,
          state,
          category,
          app: arrClient.name,
        },
        "[DRY RUN] Would remove from *arr queue, blocklist, and delete from qBittorrent",
      );
      this.stateTracker.remove(hash);
      return;
    }

    // Find in *arr queue
    const queueItems = await arrClient.getQueueItems();
    const match = queueItems.find((q) => q.downloadId === hash.toUpperCase());

    // Notify *arr
    if (match) {
      await arrClient.removeAndSearch(match.id);
      this.logger.warn(
        { action: "arr_notified", app: arrClient.name, torrent: name, method: "queue_remove", queueId: match.id },
        `Notified ${arrClient.name} to remove, blocklist, and search for alternative`,
      );
    } else {
      // markFailed auto-blocklists via DownloadFailedEvent → BlocklistService in the *arr
      await arrClient.markFailed(hash);
      this.logger.warn(
        { action: "arr_notified", app: arrClient.name, torrent: name, method: "history_fallback" },
        `Used history fallback to mark failed in ${arrClient.name}`,
      );
    }

    // Re-verify torrent state before deletion.
    // Conservative approach: only proceed with deletion if the torrent is still in a
    // known stuck state. If it transitioned to any other state (even ambiguous ones
    // like pausedDL/checkingDL), skip deletion. The *arr has already been notified,
    // and the torrent will be re-detected on the next cycle if it returns to stuck.
    const current = await this.qbit.getTorrent(hash);
    if (!current) {
      this.logger.info({ torrent: name, hash }, "Torrent already gone from qBittorrent");
      this.stateTracker.remove(hash);
      return;
    }
    if (!STUCK_ELIGIBLE_STATES.has(current.state)) {
      this.logger.info(
        { torrent: name, hash, newState: current.state },
        "Torrent left stuck state after *arr notification — skipping deletion",
      );
      this.stateTracker.remove(hash);
      return;
    }

    // Delete from qBit
    try {
      await this.qbit.deleteTorrent(hash, true);
      this.logger.warn(
        { action: "qbit_deleted", torrent: name, hash },
        "Deleted torrent and files from qBittorrent",
      );
      this.stateTracker.remove(hash);
    } catch (err) {
      this.logger.error(
        { torrent: name, hash, err },
        "qBit delete failed after *arr notification — will retry next cycle",
      );
      if (!this.stateTracker.addPendingDeletion(hash)) {
        this.logger.warn({ torrent: name, hash }, "Gave up retrying deletion after max retries");
      }
    }
  }
}
