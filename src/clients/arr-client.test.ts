import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ArrClient } from "./arr-client.js";
import { makeSilentLogger } from "../test-helpers.js";

function makeQueueResponse(records: any[], totalRecords?: number) {
  return {
    page: 1,
    pageSize: 200,
    totalRecords: totalRecords ?? records.length,
    records,
  };
}

describe("ArrClient", () => {
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

  describe("getQueueItems()", () => {
    it("returns mapped records from single page", async () => {
      mockFetch.mock.mockImplementation(async () => {
        return new Response(
          JSON.stringify(
            makeQueueResponse([
              { id: 1, downloadId: "ABC123", title: "Test.Show.S01E01" },
              { id: 2, downloadId: "DEF456", title: "Test.Show.S01E02" },
            ]),
          ),
          { status: 200 },
        );
      });

      const client = new ArrClient("Sonarr", "http://localhost:8989", "test-key", "v3", makeSilentLogger());
      const items = await client.getQueueItems();

      assert.equal(items.length, 2);
      assert.deepEqual(items[0], { id: 1, downloadId: "ABC123", title: "Test.Show.S01E01" });
    });

    it("paginates when totalRecords exceeds pageSize", async () => {
      let callCount = 0;
      mockFetch.mock.mockImplementation(async (url) => {
        callCount++;
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("page=1")) {
          const records = Array.from({ length: 200 }, (_, i) => ({
            id: i + 1,
            downloadId: `HASH_${i}`,
            title: `Item ${i}`,
          }));
          return new Response(
            JSON.stringify({ page: 1, pageSize: 200, totalRecords: 250, records }),
            { status: 200 },
          );
        }

        const records = Array.from({ length: 50 }, (_, i) => ({
          id: 200 + i + 1,
          downloadId: `HASH_${200 + i}`,
          title: `Item ${200 + i}`,
        }));
        return new Response(
          JSON.stringify({ page: 2, pageSize: 200, totalRecords: 250, records }),
          { status: 200 },
        );
      });

      const client = new ArrClient("Sonarr", "http://localhost:8989", "test-key", "v3", makeSilentLogger());
      const items = await client.getQueueItems();

      assert.equal(items.length, 250);
      assert.equal(callCount, 2);
    });

    it("sends X-Api-Key header", async () => {
      mockFetch.mock.mockImplementation(async () => {
        return new Response(JSON.stringify(makeQueueResponse([])), { status: 200 });
      });

      const client = new ArrClient("Sonarr", "http://localhost:8989", "my-secret-key", "v3", makeSilentLogger());
      await client.getQueueItems();

      assert.equal(mockFetch.mock.callCount(), 1);
      const headers = mockFetch.mock.calls[0].arguments[1]?.headers as Record<string, string>;
      assert.equal(headers["X-Api-Key"], "my-secret-key");
    });
  });

  describe("getQueueItems() error paths", () => {
    it("throws on non-OK response", async () => {
      mockFetch.mock.mockImplementation(async () => {
        return new Response("Internal Server Error", { status: 500 });
      });

      const client = new ArrClient("Sonarr", "http://localhost:8989", "test-key", "v3", makeSilentLogger());
      await assert.rejects(() => client.getQueueItems(), /getQueueItems failed.*500/);
    });

    it("throws on invalid JSON response", async () => {
      mockFetch.mock.mockImplementation(async () => {
        return new Response("not json at all", { status: 200 });
      });

      const client = new ArrClient("Sonarr", "http://localhost:8989", "test-key", "v3", makeSilentLogger());
      await assert.rejects(() => client.getQueueItems(), /getQueueItems returned invalid JSON/);
    });

    it("stops paginating and warns at MAX_PAGES limit", async () => {
      // Return totalRecords far exceeding what we'll fetch, forcing pagination to hit MAX_PAGES
      mockFetch.mock.mockImplementation(async () => {
        return Response.json({
          page: 1,
          pageSize: 200,
          totalRecords: 999999, // never satisfied — forces loop to MAX_PAGES
          records: [{ id: 1, downloadId: "HASH", title: "Test" }],
        });
      });

      const client = new ArrClient("Sonarr", "http://localhost:8989", "test-key", "v3", makeSilentLogger());
      const result = await client.getQueueItems();

      // Should have fetched exactly MAX_PAGES (50) pages
      assert.equal(mockFetch.mock.callCount(), 50);
      // Should have 50 records (1 per page)
      assert.equal(result.length, 50);
    });
  });

  describe("removeAndSearch()", () => {
    it("sends DELETE with correct query params", async () => {
      mockFetch.mock.mockImplementation(async () => {
        return new Response("{}", { status: 200 });
      });

      const client = new ArrClient("Sonarr", "http://localhost:8989", "test-key", "v3", makeSilentLogger());
      await client.removeAndSearch(42);

      assert.equal(mockFetch.mock.callCount(), 1);
      const [url, init] = mockFetch.mock.calls[0].arguments;
      const urlStr = typeof url === "string" ? url : url.toString();
      assert.ok(urlStr.includes("/api/v3/queue/42"));
      assert.ok(urlStr.includes("removeFromClient=false"));
      assert.ok(urlStr.includes("blocklist=true"));
      assert.ok(urlStr.includes("skipRedownload=false"));
      assert.equal(init?.method, "DELETE");
    });

    it("throws on non-OK response", async () => {
      mockFetch.mock.mockImplementation(async () => {
        return new Response("Internal Server Error", { status: 500 });
      });

      const client = new ArrClient("Sonarr", "http://localhost:8989", "test-key", "v3", makeSilentLogger());
      await assert.rejects(() => client.removeAndSearch(42), /removeAndSearch failed.*500/);
    });
  });

  describe("markFailed()", () => {
    it("fetches history by downloadId and posts to failed endpoint", async () => {
      const calls: string[] = [];
      mockFetch.mock.mockImplementation(async (url) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        calls.push(urlStr);

        if (urlStr.includes("/history?")) {
          return new Response(
            JSON.stringify({
              page: 1,
              pageSize: 10,
              totalRecords: 1,
              records: [{ id: 99 }],
            }),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 200 });
      });

      const client = new ArrClient("Sonarr", "http://localhost:8989", "test-key", "v3", makeSilentLogger());
      await client.markFailed("abc123");

      assert.equal(calls.length, 2);
      assert.ok(calls[0].includes("/history?downloadId=ABC123&eventType=1"));
      assert.ok(calls[1].includes("/history/failed/99"));
    });

    it("throws on non-OK history response", async () => {
      mockFetch.mock.mockImplementation(async () => {
        return new Response("Internal Server Error", { status: 500 });
      });

      const client = new ArrClient("Sonarr", "http://localhost:8989", "test-key", "v3", makeSilentLogger());
      await assert.rejects(() => client.markFailed("abc123"), /history lookup failed.*500/);
    });

    it("throws on non-OK failed POST response", async () => {
      mockFetch.mock.mockImplementation(async (url) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/history?")) {
          return new Response(
            JSON.stringify({
              page: 1,
              pageSize: 10,
              totalRecords: 1,
              records: [{ id: 99 }],
            }),
            { status: 200 },
          );
        }
        return new Response("Internal Server Error", { status: 500 });
      });

      const client = new ArrClient("Sonarr", "http://localhost:8989", "test-key", "v3", makeSilentLogger());
      await assert.rejects(() => client.markFailed("abc123"), /markFailed failed.*500/);
    });

    it("throws on invalid JSON from history endpoint", async () => {
      mockFetch.mock.mockImplementation(async () => {
        return new Response("not json at all", { status: 200 });
      });

      const client = new ArrClient("Sonarr", "http://localhost:8989", "test-key", "v3", makeSilentLogger());
      await assert.rejects(() => client.markFailed("abc123"), /history lookup returned invalid JSON/);
    });

    it("throws when no history record found", async () => {
      mockFetch.mock.mockImplementation(async () => {
        return new Response(
          JSON.stringify({ page: 1, pageSize: 10, totalRecords: 0, records: [] }),
          { status: 200 },
        );
      });

      const client = new ArrClient("Sonarr", "http://localhost:8989", "test-key", "v3", makeSilentLogger());
      await assert.rejects(() => client.markFailed("unknown"), /no history record/);
    });
  });

  describe("Lidarr uses v1 API version", () => {
    it("builds URLs with v1", async () => {
      mockFetch.mock.mockImplementation(async () => {
        return new Response(JSON.stringify(makeQueueResponse([])), { status: 200 });
      });

      const client = new ArrClient("Lidarr", "http://localhost:8686", "test-key", "v1", makeSilentLogger());
      await client.getQueueItems();

      const urlStr = mockFetch.mock.calls[0].arguments[0] as string;
      assert.ok(urlStr.includes("/api/v1/queue"));
    });
  });

  describe("tags", () => {
    it("getTags maps lower-cased labels to ids", async () => {
      mockFetch.mock.mockImplementation(async () =>
        new Response(JSON.stringify([{ id: 1, label: "keep" }, { id: 5, label: "Junk" }]), { status: 200 }));
      const client = new ArrClient("Radarr", "http://localhost:7878", "k", "v3", makeSilentLogger());
      const tags = await client.getTags();
      assert.equal(tags.get("junk"), 5);
      assert.equal(String(mockFetch.mock.calls[0].arguments[0]), "http://localhost:7878/api/v3/tag");
    });

    it("createTag POSTs the label and returns the new id", async () => {
      mockFetch.mock.mockImplementation(async () => new Response(JSON.stringify({ id: 9, label: "junk" }), { status: 201 }));
      const client = new ArrClient("Radarr", "http://localhost:7878", "k", "v3", makeSilentLogger());
      assert.equal(await client.createTag("junk"), 9);
      const init = mockFetch.mock.calls[0].arguments[1] as RequestInit;
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(init.body as string), { label: "junk" });
    });

    it("editTag uses the movie editor with movieIds for Radarr", async () => {
      mockFetch.mock.mockImplementation(async () => new Response("[]", { status: 202 }));
      const client = new ArrClient("Radarr", "http://localhost:7878", "k", "v3", makeSilentLogger());
      await client.editTag("movie", [1, 2], 9, "add");
      const [url, init] = mockFetch.mock.calls[0].arguments as [string, RequestInit];
      assert.equal(String(url), "http://localhost:7878/api/v3/movie/editor");
      assert.equal(init.method, "PUT");
      assert.deepEqual(JSON.parse(init.body as string), { movieIds: [1, 2], tags: [9], applyTags: "add" });
    });

    it("editTag uses the series editor with seriesIds for Sonarr", async () => {
      mockFetch.mock.mockImplementation(async () => new Response("[]", { status: 202 }));
      const client = new ArrClient("Sonarr", "http://localhost:8989", "k", "v3", makeSilentLogger());
      await client.editTag("series", [4], 9, "remove");
      const [url, init] = mockFetch.mock.calls[0].arguments as [string, RequestInit];
      assert.equal(String(url), "http://localhost:8989/api/v3/series/editor");
      assert.deepEqual(JSON.parse(init.body as string), { seriesIds: [4], tags: [9], applyTags: "remove" });
    });

    it("editTag with no ids makes no request", async () => {
      const client = new ArrClient("Sonarr", "http://localhost:8989", "k", "v3", makeSilentLogger());
      await client.editTag("series", [], 9, "add");
      assert.equal(mockFetch.mock.callCount(), 0);
    });

    it("editTag throws on HTTP error", async () => {
      mockFetch.mock.mockImplementation(async () => new Response("bad", { status: 400 }));
      const client = new ArrClient("Radarr", "http://localhost:7878", "k", "v3", makeSilentLogger());
      await assert.rejects(client.editTag("movie", [1], 9, "add"), /HTTP 400/);
    });
  });
});
