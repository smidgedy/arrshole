import type { Logger } from "../logger.js";
import { drain } from "../util.js";

const REQUEST_TIMEOUT = 30_000;
/** Indexer tests hit the remote site (sometimes through FlareSolverr), so allow longer. */
const TEST_TIMEOUT = 180_000;

export interface ProwlarrField {
  name: string;
  value?: unknown;
  [key: string]: unknown;
}

export interface ProwlarrIndexer {
  id: number;
  name: string;
  enable: boolean;
  tags: number[];
  indexerUrls?: string[];
  fields: ProwlarrField[];
  [key: string]: unknown;
}

export interface ProwlarrIndexerStatus {
  indexerId: number;
  disabledTill?: string;
  mostRecentFailure?: string;
  initialFailure?: string;
}

export interface ProwlarrProxy {
  id: number;
  name: string;
  implementation: string;
  tags: number[];
}

/** Minimal client for Prowlarr's v1 API: indexers, their status, tests and the FlareSolverr proxy. */
export class ProwlarrClient {
  constructor(
    private url: string,
    private apiKey: string,
    private logger: Logger,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}, timeout = REQUEST_TIMEOUT): Promise<T> {
    const response = await fetch(`${this.url}/api/v1/${path}`, {
      ...init,
      headers: { "X-Api-Key": this.apiKey, "Content-Type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ProwlarrError(`Prowlarr ${init.method ?? "GET"} ${path} failed: HTTP ${response.status}`, response.status, body);
    }
    if (response.status === 204) {
      await drain(response);
      return undefined as T;
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  getVersion(): Promise<{ version: string }> {
    return this.request("system/status");
  }

  getIndexers(): Promise<ProwlarrIndexer[]> {
    return this.request("indexer");
  }

  getIndexerStatuses(): Promise<ProwlarrIndexerStatus[]> {
    return this.request("indexerstatus");
  }

  getProxies(): Promise<ProwlarrProxy[]> {
    return this.request("indexerProxy");
  }

  /**
   * Run Prowlarr's connection test for an indexer definition (saved or not).
   * Returns null on success, otherwise Prowlarr's error message.
   */
  async testIndexer(indexer: ProwlarrIndexer): Promise<string | null> {
    try {
      await this.request("indexer/test", { method: "POST", body: JSON.stringify(indexer) }, TEST_TIMEOUT);
      return null;
    } catch (err) {
      if (err instanceof ProwlarrError && err.status === 400) return validationMessage(err.body) ?? err.message;
      return (err as Error).message;
    }
  }

  async updateIndexer(indexer: ProwlarrIndexer): Promise<void> {
    await this.request(`indexer/${indexer.id}`, { method: "PUT", body: JSON.stringify(indexer) }, TEST_TIMEOUT);
    this.logger.debug({ indexer: indexer.name }, "Prowlarr indexer updated");
  }
}

export class ProwlarrError extends Error {
  constructor(message: string, public status: number, public body: string) {
    super(message);
  }
}

/** Prowlarr returns test failures as a list of validation failures; join their messages. */
export function validationMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Array<{ errorMessage?: string }> | { message?: string };
    if (Array.isArray(parsed)) {
      const msgs = parsed.map((f) => f.errorMessage).filter(Boolean);
      return msgs.length ? msgs.join(" / ") : null;
    }
    return parsed.message ?? null;
  } catch {
    return null;
  }
}
