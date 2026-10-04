import type { TorrentFile } from "../release-inspector.js";
import type { Logger } from "../logger.js";
import type { QBitServerState, QBitTorrent, QBitTransferInfo } from "../types.js";
import { drain } from "../util.js";

const REQUEST_TIMEOUT = 15000;

// qBittorrent's session cookie. Older builds use `SID=...`; newer builds (≥4.6)
// use `QBT_SID_<port>=...`. Match either to stay compatible.
const SID_COOKIE_RE = /(?:^|;\s*)((?:QBT_)?SID(?:_\d+)?)=([^;]+)/;

/** Client for the qBittorrent Web API (v2). Handles authentication and session renewal. */
export class QBitClient {
  private sidCookie: string | null = null;

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
      const match = setCookie.match(SID_COOKIE_RE);
      if (match) {
        this.sidCookie = `${match[1]}=${match[2]}`;
        await drain(response);
        this.logger.debug({ cookieName: match[1] }, "qBittorrent authenticated");
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
    return this.sidCookie ?? "";
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

  /** Files inside a torrent (name relative to the torrent root, size in bytes). Empty until metadata is known. */
  async getTorrentFiles(hash: string): Promise<TorrentFile[]> {
    const params = new URLSearchParams({ hash });
    const response = await this.fetchWithReauth(() =>
      fetch(`${this.url}/api/v2/torrents/files?${params}`, {
        headers: { Cookie: this.cookieHeader },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      }),
    );

    if (!response.ok) {
      await drain(response);
      throw new Error(`qBittorrent getTorrentFiles failed: HTTP ${response.status}`);
    }

    let files: Array<{ name: string; size: number }>;
    try {
      files = (await response.json()) as Array<{ name: string; size: number }>;
    } catch {
      throw new Error("qBittorrent getTorrentFiles returned invalid JSON");
    }
    return files.map((f) => ({ name: f.name, size: f.size }));
  }

  /** Fetch global transfer stats (download/upload rates). Re-authenticates on 403. */
  async getTransferInfo(): Promise<QBitTransferInfo> {
    const response = await this.fetchWithReauth(() =>
      fetch(`${this.url}/api/v2/transfer/info`, {
        headers: { Cookie: this.cookieHeader },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      }),
    );

    if (!response.ok) {
      await drain(response);
      throw new Error(`qBittorrent getTransferInfo failed: HTTP ${response.status}`);
    }

    try {
      return (await response.json()) as QBitTransferInfo;
    } catch {
      throw new Error("qBittorrent getTransferInfo returned invalid JSON");
    }
  }

  /** Session-wide state: connection status, external IP, free space. Re-authenticates on 403. */
  async getServerState(): Promise<QBitServerState> {
    const response = await this.fetchWithReauth(() =>
      fetch(`${this.url}/api/v2/sync/maindata?rid=0`, {
        headers: { Cookie: this.cookieHeader },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      }),
    );
    if (!response.ok) {
      await drain(response);
      throw new Error(`qBittorrent getServerState failed: HTTP ${response.status}`);
    }
    try {
      return ((await response.json()) as { server_state: QBitServerState }).server_state;
    } catch {
      throw new Error("qBittorrent getServerState returned invalid JSON");
    }
  }

  /** The torrent listen port from qBittorrent's preferences. */
  async getListenPort(): Promise<number> {
    const response = await this.fetchWithReauth(() =>
      fetch(`${this.url}/api/v2/app/preferences`, {
        headers: { Cookie: this.cookieHeader },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      }),
    );
    if (!response.ok) {
      await drain(response);
      throw new Error(`qBittorrent getPreferences failed: HTTP ${response.status}`);
    }
    return ((await response.json()) as { listen_port: number }).listen_port;
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
