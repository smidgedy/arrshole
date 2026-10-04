import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { arrHealthDetails, diskStatus, formatBytes, HealthMonitor, parsePortproxy, vpnStatus, worst, type HealthConfig } from "./health.js";
import type { QBitClient } from "./clients/qbittorrent.js";
import { makeSilentLogger } from "./test-helpers.js";

describe("health helpers", () => {
  it("worst picks the most severe status", () => {
    assert.equal(worst(["ok", "unknown", "warn"]), "warn");
    assert.equal(worst(["ok", "error", "warn"]), "error");
    assert.equal(worst([]), "ok");
  });

  it("drops TheTVDB removal noise from *arr health", () => {
    const r = arrHealthDetails([
      { type: "warning", message: "Series Sneak Me in Your Closet My Prince (tvdbid 461182) was removed from TheTVDB" },
      { type: "error", message: "Indexers unavailable due to failures for more than 6 hours: BitSearch" },
    ]);
    assert.equal(r.status, "error");
    assert.deepEqual(r.details, ["Indexers unavailable due to failures for more than 6 hours: BitSearch"]);
    assert.equal(arrHealthDetails([{ type: "warning", message: "x was removed from TheTVDB" }]).status, "ok");
  });

  it("grades free disk space against its goal", () => {
    const tb = 1e12;
    assert.equal(diskStatus(1.2 * tb, tb), "ok");
    assert.equal(diskStatus(0.58 * tb, tb), "warn");
    assert.equal(diskStatus(0.2 * tb, tb), "error");
  });

  it("flags qBittorrent leaking outside the VPN", () => {
    assert.equal(vpnStatus("1.2.3.4", "1.2.3.4").status, "error");
    assert.equal(vpnStatus("220.158.199.251", "1.2.3.4").status, "ok");
    assert.equal(vpnStatus(undefined, "1.2.3.4").status, "unknown");
    assert.equal(vpnStatus("1.2.3.4", null).status, "unknown");
  });

  it("parses netsh portproxy output", () => {
    const out = `\r\nListen on ipv4:             Connect to ipv4:\r\n\r\nAddress         Port        Address         Port\r\n--------------- ----------  --------------- ----------\r\n0.0.0.0         3030        172.29.122.132  3030\r\n0.0.0.0         80          172.29.122.132  4600\r\n`;
    assert.deepEqual(parsePortproxy(out), [
      { listenPort: 3030, connectAddress: "172.29.122.132", connectPort: 3030 },
      { listenPort: 80, connectAddress: "172.29.122.132", connectPort: 4600 },
    ]);
  });

  it("formats bytes", () => {
    assert.equal(formatBytes(583 * 1024 ** 3), "583 GB");
    assert.equal(formatBytes(1.5 * 1024 ** 4), "1.5 TB");
  });
});

describe("HealthMonitor", () => {
  const cfg: HealthConfig = {
    port: 0, intervalMs: 60_000, arrs: [], prowlarrUrl: null, jackettUrl: null, flaresolverrUrl: null,
    tdarrUrl: null, plexUrl: null, plexToken: null, qbitUrl: "http://q", languarrgeUrl: null, languarrgeDb: null,
    drivepoolPath: null, drivepoolTargetFreeBytes: 1e12, torrentDiskPath: null, torrentDiskTargetFreeBytes: 1e11, tasteStateFile: null, pollIntervalMs: 60_000, dryRun: false,
    tailscaleRouter: null, gateway: null, netshPath: null,
  };

  it("turns a failing dependency into an error entry instead of failing the snapshot", async () => {
    const qbit = {
      getServerState: async () => { throw new Error("connection refused"); },
      getTorrents: async () => [],
      getListenPort: async () => 1,
    } as unknown as QBitClient;
    const m = new HealthMonitor(cfg, { qbit, prowlarr: null, doctor: null, lastCycleAt: () => Date.now() }, makeSilentLogger());
    const h = await m.collect();
    const q = h.chain.find((c) => c.id === "qbittorrent")!;
    assert.equal(q.status, "error");
    assert.match(q.summary, /unreachable/);
    assert.equal(h.chain.find((c) => c.id === "arrshole")!.status, "ok");
    assert.equal(h.overall, "error");
    assert.ok(h.network.some((c) => c.id === "vpn"));
  });
});
