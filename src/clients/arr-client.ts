import type { Logger } from "../logger.js";
import type { ArrQueueRecord } from "../types.js";

const REQUEST_TIMEOUT = 15000;
const PAGE_SIZE = 200;
const MAX_PAGES = 50;

interface QueueResponse {
  page: number;
  pageSize: number;
  totalRecords: number;
  records: Array<{
    id: number;
    downloadId: string;
    title: string;
    [key: string]: unknown;
  }>;
}

interface HistoryResponse {
  page: number;
  pageSize: number;
  totalRecords: number;
  records: Array<{
    id: number;
    [key: string]: unknown;
  }>;
}

async function drain(response: Response): Promise<void> {
  await response.body?.cancel();
}

export abstract class BaseArrClient {
  constructor(
    readonly name: string,
    protected baseUrl: string,
    protected apiKey: string,
    protected apiVersion: string,
    protected logger: Logger,
  ) {}

  private get headers(): Record<string, string> {
    return { "X-Api-Key": this.apiKey };
  }

  private apiUrl(path: string): string {
    return `${this.baseUrl}/api/${this.apiVersion}${path}`;
  }

  async getQueueItems(): Promise<ArrQueueRecord[]> {
    const allRecords: ArrQueueRecord[] = [];
    let page = 1;

    while (page <= MAX_PAGES) {
      const url = this.apiUrl(`/queue?page=${page}&pageSize=${PAGE_SIZE}`);
      this.logger.debug({ url, app: this.name }, "Fetching queue page");

      const response = await fetch(url, {
        headers: this.headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });

      if (!response.ok) {
        await drain(response);
        throw new Error(`${this.name} getQueueItems failed: HTTP ${response.status}`);
      }

      const data = (await response.json()) as QueueResponse;

      for (const record of data.records) {
        allRecords.push({
          id: record.id,
          downloadId: record.downloadId,
          title: record.title,
        });
      }

      if (allRecords.length >= data.totalRecords) {
        break;
      }
      page++;
    }

    if (page > MAX_PAGES) {
      this.logger.warn(
        { app: this.name, pages: MAX_PAGES, fetched: allRecords.length },
        "Pagination limit reached — queue may be incomplete",
      );
    }

    return allRecords;
  }

  async removeAndSearch(queueId: number): Promise<void> {
    const url = this.apiUrl(
      `/queue/${queueId}?removeFromClient=false&blocklist=true&skipRedownload=false`,
    );
    this.logger.debug({ url, queueId, app: this.name }, "Removing from queue with blocklist");

    const response = await fetch(url, {
      method: "DELETE",
      headers: this.headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

    if (!response.ok) {
      await drain(response);
      throw new Error(`${this.name} removeAndSearch failed: HTTP ${response.status}`);
    }
    await drain(response);
  }

  // markFailed uses POST /history/failed/{id} which unconditionally blocklists
  // the release via DownloadFailedEvent → BlocklistService.Handle in the *arr
  // source code, and triggers a re-search if AutoRedownloadFailed is enabled.
  async markFailed(downloadHash: string): Promise<void> {
    const upperHash = downloadHash.toUpperCase();
    const historyUrl = this.apiUrl(
      `/history?downloadId=${upperHash}&eventType=1&pageSize=10`,
    );
    this.logger.debug({ historyUrl, app: this.name }, "Looking up history for failed download");

    const historyResponse = await fetch(historyUrl, {
      headers: this.headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

    if (!historyResponse.ok) {
      await drain(historyResponse);
      throw new Error(`${this.name} history lookup failed: HTTP ${historyResponse.status}`);
    }

    const historyData = (await historyResponse.json()) as HistoryResponse;

    if (historyData.records.length === 0) {
      throw new Error(
        `${this.name} has no history record for download ${upperHash}`,
      );
    }

    const historyId = historyData.records[0].id;
    const failedUrl = this.apiUrl(`/history/failed/${historyId}`);
    this.logger.debug({ failedUrl, historyId, app: this.name }, "Marking history record as failed");

    const failedResponse = await fetch(failedUrl, {
      method: "POST",
      headers: this.headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

    if (!failedResponse.ok) {
      await drain(failedResponse);
      throw new Error(`${this.name} markFailed failed: HTTP ${failedResponse.status}`);
    }
    await drain(failedResponse);
  }
}
