import type { Logger } from "./logger.js";
import type { Config } from "./config.js";
import type { BaseArrClient } from "./clients/arr-client.js";
import type { QBitClient } from "./clients/qbittorrent.js";
import { StateTracker } from "./state-tracker.js";

const STUCK_STATES = new Set(["metaDL", "forcedMetaDL", "stalledDL"]);

export class Monitor {
  private stateTracker: StateTracker;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private firstCycle = true;
  private pollPromise: Promise<void> | null = null;

  constructor(
    private qbit: QBitClient,
    private arrClients: Map<string, BaseArrClient>,
    private categoryMap: Map<string, string>,
    private config: Config,
    private logger: Logger,
  ) {
    this.stateTracker = new StateTracker();
  }

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
      this.config.stalledStuckMs,
    );

    this.logger.info(
      { torrents: torrents.length, stuck: stuckList.length },
      "Poll complete",
    );

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
    if (!STUCK_STATES.has(current.state)) {
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
