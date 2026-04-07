import type { Logger } from "../logger.js";
import type { QBitTorrent } from "../types.js";

const REQUEST_TIMEOUT = 15000;

export class QBitClient {
  private sid: string | null = null;

  constructor(
    private url: string,
    private username: string,
    private password: string,
    private logger: Logger,
  ) {}

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
      throw new Error(`qBittorrent login failed: HTTP ${response.status}`);
    }

    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      const match = setCookie.match(/SID=([^;]+)/);
      if (match) {
        this.sid = match[1];
        this.logger.debug("qBittorrent authenticated");
        return;
      }
    }

    const text = await response.text();
    if (text === "Ok.") {
      this.logger.warn("qBittorrent login returned Ok but no SID cookie — session may not persist");
    } else {
      throw new Error(`qBittorrent login failed: unexpected response "${text}"`);
    }
  }

  private get cookieHeader(): string {
    return this.sid ? `SID=${this.sid}` : "";
  }

  async getTorrents(): Promise<QBitTorrent[]> {
    const doFetch = async (): Promise<Response> => {
      return fetch(`${this.url}/api/v2/torrents/info`, {
        headers: { Cookie: this.cookieHeader },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });
    };

    let response = await doFetch();

    if (response.status === 403) {
      this.logger.debug("qBittorrent session expired, re-authenticating");
      await this.login();
      response = await doFetch();
      if (response.status === 403) {
        throw new Error("qBittorrent re-authentication failed");
      }
    }

    if (!response.ok) {
      throw new Error(`qBittorrent getTorrents failed: HTTP ${response.status}`);
    }

    return (await response.json()) as QBitTorrent[];
  }

  async getTorrent(hash: string): Promise<QBitTorrent | null> {
    const doFetch = async (): Promise<Response> => {
      return fetch(`${this.url}/api/v2/torrents/info?hashes=${hash}`, {
        headers: { Cookie: this.cookieHeader },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });
    };

    let response = await doFetch();

    if (response.status === 403) {
      await this.login();
      response = await doFetch();
      if (response.status === 403) {
        throw new Error("qBittorrent re-authentication failed");
      }
    }

    if (!response.ok) {
      throw new Error(`qBittorrent getTorrent failed: HTTP ${response.status}`);
    }

    const torrents = (await response.json()) as QBitTorrent[];
    return torrents.length > 0 ? torrents[0] : null;
  }

  async deleteTorrent(hash: string, deleteFiles: boolean): Promise<void> {
    const body = new URLSearchParams({
      hashes: hash,
      deleteFiles: String(deleteFiles),
    });

    const response = await fetch(`${this.url}/api/v2/torrents/delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: this.cookieHeader,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

    if (!response.ok) {
      throw new Error(`qBittorrent deleteTorrent failed: HTTP ${response.status}`);
    }
  }
}
