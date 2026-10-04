const REQUEST_TIMEOUT = 120_000;

export interface JackettIndexer {
  id: string;
  name: string;
}

/**
 * Minimal Jackett client using only the Torznab API (API key, no admin login):
 * list configured indexers and run a cheap per-indexer query to see if it works.
 */
export class JackettClient {
  constructor(
    private url: string,
    private apiKey: string,
  ) {}

  private torznab(indexer: string, params: Record<string, string>, timeout = REQUEST_TIMEOUT): Promise<Response> {
    const q = new URLSearchParams({ apikey: this.apiKey, ...params });
    return fetch(`${this.url}/api/v2.0/indexers/${encodeURIComponent(indexer)}/results/torznab/api?${q}`, {
      signal: AbortSignal.timeout(timeout),
    });
  }

  async getConfiguredIndexers(): Promise<JackettIndexer[]> {
    const response = await this.torznab("all", { t: "indexers", configured: "true" }, 30_000);
    if (!response.ok) throw new Error(`Jackett indexer list failed: HTTP ${response.status}`);
    return parseIndexerList(await response.text());
  }

  /** Query an indexer's latest releases. Returns null on success, otherwise the error. */
  async testIndexer(id: string): Promise<string | null> {
    try {
      const response = await this.torznab(id, { t: "search", q: "" });
      const text = await response.text();
      if (!response.ok) return torznabError(text) ?? `HTTP ${response.status}`;
      return torznabError(text);
    } catch (err) {
      return (err as Error).message;
    }
  }
}

/** Parse `<indexer id="..."><title>...</title>` entries from Jackett's t=indexers XML. */
export function parseIndexerList(xml: string): JackettIndexer[] {
  const out: JackettIndexer[] = [];
  for (const m of xml.matchAll(/<indexer\s+id="([^"]+)"[^>]*>[\s\S]*?<title>([^<]*)<\/title>/g)) {
    out.push({ id: m[1], name: decodeXml(m[2]) });
  }
  return out;
}

/** Torznab errors look like `<error code="900" description="..."/>`. */
export function torznabError(xml: string): string | null {
  const m = xml.match(/<error\s+code="(\d+)"\s+description="([^"]*)"/);
  return m ? decodeXml(m[2]) : null;
}

function decodeXml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
