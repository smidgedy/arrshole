import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { QBitClient } from "./qbittorrent.js";
import type { QBitTorrent } from "../types.js";
import { makeSilentLogger } from "../test-helpers.js";

const SAMPLE_TORRENT: QBitTorrent = {
  hash: "abc123def456",
  name: "Test.Torrent.S01E01",
  state: "stalledDL",
  category: "sonarr",
  added_on: 1700000000,
  time_active: 3600,
  last_activity: 1700003600,
  progress: 0.5,
  dlspeed: 0,
  size: 1000000000,
};

describe("QBitClient", () => {
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: ReturnType<typeof mock.fn<typeof globalThis.fetch>>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockFetch = mock.fn<typeof globalThis.fetch>();
    globalThis.fetch = mockFetch as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("login()", () => {
    it("sends form-encoded body and parses SID from Set-Cookie", async () => {
      mockFetch.mock.mockImplementation(async () => {
        return new Response("Ok.", {
          status: 200,
          headers: { "Set-Cookie": "SID=test_session_id; path=/" },
        });
      });

      const client = new QBitClient("http://localhost:8080", "admin", "pass", makeSilentLogger());
      await client.login();

      assert.equal(mockFetch.mock.callCount(), 1);
      const [url, init] = mockFetch.mock.calls[0].arguments;
      assert.equal(url, "http://localhost:8080/api/v2/auth/login");
      assert.equal(init?.method, "POST");
      assert.equal(init?.headers?.["Content-Type" as keyof typeof init.headers], "application/x-www-form-urlencoded");
      const body = init?.body as string;
      assert.ok(body.includes("username=admin"));
      assert.ok(body.includes("password=pass"));
    });

    it("throws on non-200 response", async () => {
      mockFetch.mock.mockImplementation(async () => {
        return new Response("Forbidden", { status: 403 });
      });

      const client = new QBitClient("http://localhost:8080", "admin", "pass", makeSilentLogger());
      await assert.rejects(() => client.login(), /login failed.*403/);
    });

    it("throws when Ok response has no SID cookie", async () => {
      mockFetch.mock.mockImplementation(async () => {
        return new Response("Ok.", { status: 200 });
      });

      const client = new QBitClient("http://localhost:8080", "admin", "pass", makeSilentLogger());
      await assert.rejects(() => client.login(), /no SID cookie/);
    });
  });

  describe("getTorrents()", () => {
    it("sends SID cookie and returns parsed array", async () => {
      let callCount = 0;
      mockFetch.mock.mockImplementation(async (url) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/login")) {
          callCount++;
          return new Response("Ok.", {
            status: 200,
            headers: { "Set-Cookie": "SID=my_session; path=/" },
          });
        }
        return new Response(JSON.stringify([SAMPLE_TORRENT]), { status: 200 });
      });

      const client = new QBitClient("http://localhost:8080", "admin", "pass", makeSilentLogger());
      await client.login();
      const torrents = await client.getTorrents();

      assert.equal(torrents.length, 1);
      assert.equal(torrents[0].hash, "abc123def456");

      const infoCall = mockFetch.mock.calls.find(
        (c) => (c.arguments[0] as string).includes("/torrents/info"),
      );
      assert.ok(infoCall);
      const headers = infoCall.arguments[1]?.headers as Record<string, string>;
      assert.equal(headers.Cookie, "SID=my_session");
    });

    it("re-authenticates on 403 and retries", async () => {
      let loginCount = 0;
      let torrentCallCount = 0;

      mockFetch.mock.mockImplementation(async (url) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/login")) {
          loginCount++;
          return new Response("Ok.", {
            status: 200,
            headers: { "Set-Cookie": "SID=new_session; path=/" },
          });
        }
        torrentCallCount++;
        if (torrentCallCount === 1) {
          return new Response("Forbidden", { status: 403 });
        }
        return new Response(JSON.stringify([SAMPLE_TORRENT]), { status: 200 });
      });

      const client = new QBitClient("http://localhost:8080", "admin", "pass", makeSilentLogger());
      await client.login();
      const torrents = await client.getTorrents();

      assert.equal(torrents.length, 1);
      assert.equal(loginCount, 2);
      assert.equal(torrentCallCount, 2);
    });
  });

  describe("getTorrent()", () => {
    it("returns single torrent when found", async () => {
      mockFetch.mock.mockImplementation(async (url) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/login")) {
          return new Response("Ok.", {
            status: 200,
            headers: { "Set-Cookie": "SID=sess; path=/" },
          });
        }
        return new Response(JSON.stringify([SAMPLE_TORRENT]), { status: 200 });
      });

      const client = new QBitClient("http://localhost:8080", "admin", "pass", makeSilentLogger());
      await client.login();
      const torrent = await client.getTorrent("abc123def456");

      assert.ok(torrent);
      assert.equal(torrent.hash, "abc123def456");
    });

    it("returns null when not found", async () => {
      mockFetch.mock.mockImplementation(async (url) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/login")) {
          return new Response("Ok.", {
            status: 200,
            headers: { "Set-Cookie": "SID=sess; path=/" },
          });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      });

      const client = new QBitClient("http://localhost:8080", "admin", "pass", makeSilentLogger());
      await client.login();
      const torrent = await client.getTorrent("nonexistent");

      assert.equal(torrent, null);
    });
  });

  describe("deleteTorrent()", () => {
    it("sends form-encoded POST with hash and deleteFiles", async () => {
      mockFetch.mock.mockImplementation(async (url) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/login")) {
          return new Response("Ok.", {
            status: 200,
            headers: { "Set-Cookie": "SID=sess; path=/" },
          });
        }
        return new Response("", { status: 200 });
      });

      const client = new QBitClient("http://localhost:8080", "admin", "pass", makeSilentLogger());
      await client.login();
      await client.deleteTorrent("abc123def456", true);

      const deleteCall = mockFetch.mock.calls.find(
        (c) => (c.arguments[0] as string).includes("/torrents/delete"),
      );
      assert.ok(deleteCall);
      const [, init] = deleteCall.arguments;
      assert.equal(init?.method, "POST");
      const body = init?.body as string;
      assert.ok(body.includes("hashes=abc123def456"));
      assert.ok(body.includes("deleteFiles=true"));
    });

    it("re-authenticates on 403 and retries", async () => {
      let loginCount = 0;
      let deleteCallCount = 0;

      mockFetch.mock.mockImplementation(async (url) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/login")) {
          loginCount++;
          return new Response("Ok.", {
            status: 200,
            headers: { "Set-Cookie": "SID=new_session; path=/" },
          });
        }
        deleteCallCount++;
        if (deleteCallCount === 1) {
          return new Response("Forbidden", { status: 403 });
        }
        return new Response("", { status: 200 });
      });

      const client = new QBitClient("http://localhost:8080", "admin", "pass", makeSilentLogger());
      await client.login();
      await client.deleteTorrent("abc123def456", true);

      assert.equal(loginCount, 2);
      assert.equal(deleteCallCount, 2);
    });
  });
});
