import type { Logger } from "../logger.js";
import type { QBitTorrent } from "../types.js";
import { drain } from "../util.js";

const REQUEST_TIMEOUT = 15000;

/** Client for the qBittorrent Web API (v2). Handles authentication and session renewal. */
export class QBitClient {
  private sid: string | null = null;

  constructor(
    private url: string,
    private username: string,
    private password: string,
    private logger: Logger,
  ) {}

  /** Authenticate with qBittorrent and store the session cookie. */
  async login(): Promise<void> {
    const body = new URLSearchParams({
      username: this.username,
      password: this.password,
    });

    const response = await fetch(`${this.url}/api/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

    if (!response.ok) {
      await drain(response);
      throw new Error(`qBittorrent login failed: HTTP ${response.status}`);
    }

    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      const match = setCookie.match(/SID=([^;]+)/);
      if (match) {
        this.sid = match[1];
        await drain(response);
        this.logger.debug("qBittorrent authenticated");
        return;
      }
    }

    const text = await response.text();
    if (text === "Ok.") {
      throw new Error(
        "qBittorrent login returned Ok but no SID cookie — authentication will not persist",
      );
    } else {
      throw new Error(`qBittorrent login failed: unexpected response "${text}"`);
    }
  }

  private get cookieHeader(): string {
    return this.sid ? `SID=${this.sid}` : "";
  }

  private async fetchWithReauth(
    request: () => Promise<Response>,
  ): Promise<Response> {
    let response = await request();

    if (response.status === 403) {
      await drain(response);
      this.logger.debug("qBittorrent session expired, re-authenticating");
      await this.login();
      response = await request();
      if (response.status === 403) {
        await drain(response);
        throw new Error("qBittorrent re-authentication failed");
      }
    }

    return response;
  }

  /** Fetch all torrents. Re-authenticates automatically on 403. */
  async getTorrents(): Promise<QBitTorrent[]> {
    const response = await this.fetchWithReauth(() =>
      fetch(`${this.url}/api/v2/torrents/info`, {
        headers: { Cookie: this.cookieHeader },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      }),
    );

    if (!response.ok) {
      await drain(response);
      throw new Error(`qBittorrent getTorrents failed: HTTP ${response.status}`);
    }

    try {
      return (await response.json()) as QBitTorrent[];
    } catch {
      throw new Error("qBittorrent getTorrents returned invalid JSON");
    }
  }

  /** Fetch a single torrent by hash. Returns null if not found. */
  async getTorrent(hash: string): Promise<QBitTorrent | null> {
    const params = new URLSearchParams({ hashes: hash });
    const response = await this.fetchWithReauth(() =>
      fetch(`${this.url}/api/v2/torrents/info?${params}`, {
        headers: { Cookie: this.cookieHeader },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      }),
    );

    if (!response.ok) {
      await drain(response);
      throw new Error(`qBittorrent getTorrent failed: HTTP ${response.status}`);
    }

    let torrents: QBitTorrent[];
    try {
      torrents = (await response.json()) as QBitTorrent[];
    } catch {
      throw new Error("qBittorrent getTorrent returned invalid JSON");
    }
    return torrents.length > 0 ? torrents[0] : null;
  }

  /** Delete a torrent and optionally its downloaded files. */
  async deleteTorrent(hash: string, deleteFiles: boolean): Promise<void> {
    const body = new URLSearchParams({
      hashes: hash,
      deleteFiles: String(deleteFiles),
    });

    const response = await this.fetchWithReauth(() =>
      fetch(`${this.url}/api/v2/torrents/delete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: this.cookieHeader,
        },
        body: body.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      }),
    );

    if (!response.ok) {
      await drain(response);
      throw new Error(`qBittorrent deleteTorrent failed: HTTP ${response.status}`);
    }
    await drain(response);
  }
}
