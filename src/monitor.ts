import type { Logger } from "./logger.js";
import type { Config } from "./config.js";
import type { ArrClient } from "./clients/arr-client.js";
import type { QBitClient } from "./clients/qbittorrent.js";
import { StateTracker } from "./state-tracker.js";
import { STUCK_ELIGIBLE_STATES, ACTIVE_DOWNLOAD_STATES, METADATA_STATES, type QBitTorrent } from "./types.js";
import { classifyReject, aggregateRejects } from "./reject-classifier.js";
import { classifyRelease, kindForApp } from "./release-inspector.js";
import { cleanImportFolder, translatePath } from "./library-cleaner.js";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * Core polling loop. Detects stuck torrents, notifies *arr apps to blocklist
 * and re-search, then deletes the torrent from qBittorrent.
 */
export class Monitor {
  private stateTracker: StateTracker;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private firstCycle = true;
  /** When the last poll cycle completed (ms since epoch); read by the health snapshot. */
  lastCycleAt: number | null = null;
  private pollPromise: Promise<void> | null = null;
  /** Torrents already judged clean by the bad-release reaper (file lists don't change). */
  private inspectedReleases = new Set<string>();
  /** Library cleanup position when no state file is configured (tests). */
  private memCleanupState: Record<string, number> = {};

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
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        this.pollPromise = this.poll();
        await this.pollPromise;
        this.lastCycleAt = Date.now();
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

    // Import-rejection reaper runs independently of stalled/metaDL detection —
    // it works off *arr queue status, not qBit torrent state, so it must run
    // even when nothing is stuck in qBittorrent.
    if (this.config.importRejectEnabled) {
      try {
        await this.scanImportRejects(this.config.maxActionsPerCycle);
      } catch (err) {
        this.logger.error({ err }, "Import-rejection scan failed");
      }
    }

    if (this.config.badReleaseEnabled) {
      try {
        await this.scanBadReleases(torrents, this.config.maxActionsPerCycle);
      } catch (err) {
        this.logger.error({ err }, "Bad-release scan failed");
      }
    }

    if (this.config.libraryCleanupEnabled) {
      try {
        await this.scanLibraryImports();
      } catch (err) {
        this.logger.error({ err }, "Library cleanup failed");
      }
    }

    if (stuckList.length === 0) {
      return;
    }

    // Step 3a: Outage guard. A client-wide qBittorrent outage makes every active
    // torrent stall at once — indistinguishable, per-torrent, from a batch of
    // genuinely dead releases. The tell is global transfer rate: if the whole
    // client is at ~0 B/s while many torrents are trying to download, assume an
    // outage and skip all actions this cycle. Resumes automatically once speed
    // recovers. Fail-safe: if we can't read the rate, skip rather than risk a
    // mass blocklist.
    if (this.config.outageGuardEnabled) {
      const activeDownloading = torrents.filter((t) =>
        ACTIVE_DOWNLOAD_STATES.has(t.state),
      ).length;

      if (activeDownloading >= this.config.outageMinActiveDownloading) {
        let dlSpeed: number;
        try {
          dlSpeed = (await this.qbit.getTransferInfo()).dl_info_speed;
        } catch (err) {
          this.logger.warn(
            { err, stuck: stuckList.length, activeDownloading },
            "Outage guard: could not read transfer info — skipping actions this cycle",
          );
          return;
        }

        if (dlSpeed <= this.config.outageSpeedFloorBytes) {
          this.logger.warn(
            {
              dlSpeedBytes: dlSpeed,
              floorBytes: this.config.outageSpeedFloorBytes,
              activeDownloading,
              stuck: stuckList.length,
            },
            "Outage guard tripped: qBittorrent download rate near zero while torrents are active — suspected client-wide outage, skipping all actions this cycle",
          );
          return;
        }
      }
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
        "[DRY RUN] Would delete from qBittorrent and notify *arr to blocklist + re-search",
      );
      this.stateTracker.remove(hash);
      return;
    }

    // Re-verify torrent is still stuck. If it recovered (or is in an ambiguous
    // state like pausedDL/checkingDL), skip this cycle and let it be re-detected.
    const current = await this.qbit.getTorrent(hash);
    if (!current) {
      this.logger.info({ torrent: name, hash }, "Torrent already gone from qBittorrent");
      this.stateTracker.remove(hash);
      return;
    }
    if (!STUCK_ELIGIBLE_STATES.has(current.state)) {
      this.logger.info(
        { torrent: name, hash, newState: current.state },
        "Torrent left stuck state — skipping",
      );
      this.stateTracker.remove(hash);
      return;
    }

    // Step 1: delete from qBit. This is the action that always needs to happen —
    // freeing the slot is the whole point. If it fails, queue for retry and bail.
    try {
      await this.qbit.deleteTorrent(hash, true);
      this.logger.warn(
        { action: "qbit_deleted", torrent: name, hash },
        "Deleted torrent and files from qBittorrent",
      );
    } catch (err) {
      this.logger.error(
        { torrent: name, hash, err },
        "qBit delete failed — will retry next cycle",
      );
      if (!this.stateTracker.addPendingDeletion(hash)) {
        this.logger.warn({ torrent: name, hash }, "Gave up retrying deletion after max retries");
      }
      return;
    }

    // Step 2: best-effort notify *arr to blocklist + re-search. Any failure here
    // is logged and swallowed — the torrent is already gone from qBit, so we
    // don't want to keep retrying. Worst case the *arr won't blocklist this
    // release and may re-grab it; the next stuck cycle will catch that too.
    try {
      const queueItems = await arrClient.getQueueItems();
      const match = queueItems.find((q) => q.downloadId === hash.toUpperCase());
      if (match) {
        await arrClient.removeAndSearch(match.id);
        this.logger.warn(
          { action: "arr_notified", app: arrClient.name, torrent: name, method: "queue_remove", queueId: match.id },
          `Notified ${arrClient.name} to blocklist and search for alternative`,
        );
      } else {
        await arrClient.markFailed(hash);
        this.logger.warn(
          { action: "arr_notified", app: arrClient.name, torrent: name, method: "history_fallback" },
          `Used history fallback to mark failed in ${arrClient.name}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        { torrent: name, hash, app: arrClient.name, err },
        "Best-effort *arr notification failed — torrent already deleted from qBit",
      );
    }

    this.stateTracker.remove(hash);
  }

  /**
   * Scan every configured *arr app's queue for releases that finished
   * downloading but were rejected at import, classify each, and clean them up.
   *
   * Unlike the stalled/metaDL path this is driven entirely by *arr queue status
   * (trackedDownloadState + statusMessages), not qBittorrent state — a rejected
   * release sits at stoppedUP/pausedUP in qBit, indistinguishable there from a
   * healthy torrent seeding after a good import. No qBit timer is needed: the
   * actionable states (importFailed/importBlocked) are terminal, and the one
   * transient state (importPending) is deliberately skipped by the classifier.
   *
   * The item is in the *arr queue, so removal goes through *arr with
   * removeFromClient=true — *arr deletes the torrent and its files from
   * qBittorrent, blocklists the release, and (for defective releases only)
   * searches for a replacement.
   *
   * @param limit  Max items to act on this pass (circuit breaker). Undefined = unlimited (one-shot).
   */
  async scanImportRejects(limit?: number): Promise<void> {
    let acted = 0;
    let skipped = 0;

    for (const [appName, arrClient] of this.arrClients) {
      let records;
      try {
        records = await arrClient.getRejectRecords();
      } catch (err) {
        this.logger.error({ app: arrClient.name, err }, "Failed to fetch queue for reject scan");
        continue;
      }

      // Collapse per-episode/track records to one entry per torrent before acting.
      const items = aggregateRejects(records);

      for (const item of items) {
        const verdict = classifyReject(item);

        if (verdict.kind === "skip") {
          skipped++;
          this.logger.debug(
            { app: arrClient.name, title: item.title, state: item.trackedDownloadState, reason: verdict.reason },
            "Reject scan: skipping",
          );
          continue;
        }

        if (limit !== undefined && acted >= limit) {
          this.logger.warn(
            { app: arrClient.name, limit },
            "Reject scan: circuit breaker reached — remaining items deferred to next cycle",
          );
          return;
        }

        const redownload = verdict.kind === "defective";

        if (this.config.dryRun) {
          this.logger.info(
            {
              app: arrClient.name,
              title: item.title,
              downloadId: item.downloadId,
              classification: verdict.kind,
              reason: verdict.reason,
              wouldReSearch: redownload,
            },
            "[DRY RUN] Would delete rejected download + files, blocklist" +
              (redownload ? " and re-search" : " (no re-search — redundant)"),
          );
          acted++;
          continue;
        }

        try {
          await arrClient.removeRejected(item.id, redownload);
          acted++;
          this.logger.warn(
            {
              action: "reject_reaped",
              app: arrClient.name,
              title: item.title,
              downloadId: item.downloadId,
              classification: verdict.kind,
              reason: verdict.reason,
              reSearched: redownload,
            },
            `Reaped rejected import from ${arrClient.name}: deleted download + files, blocklisted` +
              (redownload ? ", searching for replacement" : " (redundant — no re-search)"),
          );
        } catch (err) {
          this.logger.error(
            { app: arrClient.name, title: item.title, downloadId: item.downloadId, err },
            "Failed to reap rejected import — will retry next cycle",
          );
        }
      }
    }

    if (acted > 0 || skipped > 0) {
      this.logger.info(
        { acted, skipped, dryRun: this.config.dryRun },
        "Import-rejection scan complete",
      );
    }
  }

  /**
   * Bad-release reaper. Once qBittorrent knows a download's file list, check it contains at
   * least one file of the type its *arr imports (non-sample video for Sonarr/Radarr, audio for
   * Lidarr; disc images don't count) and isn't an upscale. If not, remove it through the *arr queue
   * (removeFromClient + blocklist + re-search) so that exact release is never grabbed again.
   * Downloads that aren't in an *arr queue are left alone.
   *
   * @param limit  Max removals this pass (circuit breaker). Undefined = unlimited.
   */
  async scanBadReleases(torrents: QBitTorrent[], limit?: number): Promise<void> {
    let acted = 0;
    const queues = new Map<string, Awaited<ReturnType<ArrClient["getQueueItems"]>>>();

    for (const t of torrents) {
      const app = this.categoryMap.get(t.category.toLowerCase());
      const kind = app ? kindForApp(app) : null;
      if (!app || !kind) continue;
      if (METADATA_STATES.has(t.state)) continue;
      if (this.inspectedReleases.has(t.hash)) continue;
      const arrClient = this.arrClients.get(app);
      if (!arrClient) continue;

      let files;
      try {
        files = await this.qbit.getTorrentFiles(t.hash);
      } catch (err) {
        this.logger.error({ hash: t.hash, name: t.name, err }, "Bad-release scan: failed to list torrent files");
        continue;
      }
      if (files.length === 0) continue; // metadata not ready yet

      const verdict = classifyRelease(files, kind, t.name);
      if (!verdict.bad) {
        this.inspectedReleases.add(t.hash);
        continue;
      }

      if (!queues.has(app)) {
        try {
          queues.set(app, await arrClient.getQueueItems());
        } catch (err) {
          this.logger.error({ app, err }, "Bad-release scan: failed to fetch queue — will retry next cycle");
          continue;
        }
      }
      const queueItem = queues.get(app)!.find((q) => q.downloadId?.toUpperCase() === t.hash.toUpperCase());
      if (!queueItem) {
        this.logger.debug({ app, name: t.name, reason: verdict.reason }, "Bad-release scan: not in an *arr queue — ignoring");
        this.inspectedReleases.add(t.hash);
        continue;
      }

      if (limit !== undefined && acted >= limit) {
        this.logger.warn({ limit }, "Bad-release scan: circuit breaker reached — remaining items deferred to next cycle");
        return;
      }

      if (this.config.dryRun) {
        this.logger.warn({ app, name: t.name, hash: t.hash, reason: verdict.reason },
          "[DRY RUN] Would remove bad release via *arr: delete download + files, blocklist, re-search");
        this.inspectedReleases.add(t.hash);
        acted++;
        continue;
      }

      try {
        await arrClient.removeRejected(queueItem.id, true);
        this.inspectedReleases.add(t.hash);
        acted++;
        this.logger.warn({ action: "bad_release_reaped", app, name: t.name, hash: t.hash, reason: verdict.reason },
          `Removed bad release via ${arrClient.name}: deleted, blocklisted, searching for replacement`);
      } catch (err) {
        this.logger.error({ app, name: t.name, hash: t.hash, err }, "Failed to remove bad release — will retry next cycle");
      }
    }

    if (acted > 0) {
      this.logger.info({ acted, dryRun: this.config.dryRun }, "Bad-release scan complete");
    }
  }

  /**
   * Post-import library cleanup. Reads each *arr's import history since the last pass, maps
   * each imported file's folder into this host's filesystem, and removes malware-carrying file
   * types and release cruft that landed next to it (see library-cleaner). On the very first
   * run it only records where history currently ends, so it never sweeps old imports.
   */
  async scanLibraryImports(): Promise<void> {
    const state = this.readCleanupState();
    let budget = this.config.libraryCleanupMaxFiles;
    let removed = 0;

    for (const [app, arrClient] of this.arrClients) {
      const kind = kindForApp(app);
      if (!kind) continue;
      const lastId = state[app];
      let result;
      try {
        result = await arrClient.getImportsSince(lastId ?? Number.MAX_SAFE_INTEGER);
      } catch (err) {
        this.logger.error({ app, err }, "Library cleanup: failed to read import history");
        continue;
      }
      if (lastId === undefined) {
        // First run: start from the newest history entry rather than sweeping the past.
        const peek = await arrClient.getImportsSince(0).catch(() => null);
        state[app] = peek?.maxId ?? 0;
        continue;
      }
      for (const imp of result.imports.sort((a, b) => a.id - b.id)) {
        if (budget <= 0) break;
        const local = translatePath(imp.importedPath, this.config.libraryPathMap);
        if (!local) {
          this.logger.warn({ app, path: imp.importedPath }, "Library cleanup: no LIBRARY_PATH_MAP rule for path — skipped");
          state[app] = imp.id;
          continue;
        }
        const n = cleanImportFolder(local, kind, { dryRun: this.config.dryRun, budget, logger: this.logger, app });
        removed += n;
        budget -= n;
        state[app] = imp.id;
      }
      if (budget > 0) state[app] = Math.max(state[app] ?? 0, result.maxId);
    }

    this.writeCleanupState(state);
    if (removed > 0) {
      this.logger.info({ removed, dryRun: this.config.dryRun }, "Library cleanup complete");
    }
  }

  private readCleanupState(): Record<string, number> {
    if (!this.config.libraryCleanupStateFile) return { ...this.memCleanupState };
    try {
      return JSON.parse(readFileSync(this.config.libraryCleanupStateFile, "utf8")) as Record<string, number>;
    } catch {
      return {};
    }
  }

  private writeCleanupState(state: Record<string, number>): void {
    this.memCleanupState = { ...state };
    if (!this.config.libraryCleanupStateFile) return;
    try {
      const tmp = `${this.config.libraryCleanupStateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(state) + "\n", { mode: 0o600 });
      renameSync(tmp, this.config.libraryCleanupStateFile);
    } catch (err) {
      this.logger.error({ err }, "Library cleanup: failed to persist state");
    }
  }
}
