# Health API

Arrshole serves a read-only snapshot of the media chain and the network on
`HEALTH_PORT` (default `9798`, all interfaces). Windows forwards the port to
WSL with `netsh portproxy`. The home-dashboard Media and Network tabs render
this snapshot.

Checks run in the background every `HEALTH_INTERVAL_SECONDS` (default 60).
Requests return the latest snapshot and never trigger checks themselves.
Responses carry `Access-Control-Allow-Origin: *` and contain no secrets.

## `GET /api/health`

```ts
type Status = "ok" | "warn" | "error" | "unknown";

interface Health {
  generatedAt: string;          // ISO time the snapshot finished
  overall: Status;              // worst status across chain + network
  chain: Check[];               // ordered along the media pipeline
  network: Check[];
  indexers: IndexerCheck[];
}

interface Check {
  id: string;                   // stable, e.g. "qbittorrent"
  name: string;                 // display name, e.g. "qBittorrent"
  stage: Stage;
  status: Status;
  summary: string;              // one short line, e.g. "3 downloading · 12.4 MB/s"
  details: string[];            // extra lines: warnings, health messages, errors
  metrics: Record<string, number | string | boolean | null>;
  url: string | null;           // web UI link on the LAN, when there is one
  checkedAt: string;            // ISO
}

type Stage =
  // chain
  | "indexers" | "arr" | "download" | "storage" | "processing" | "playback" | "maintenance"
  // network
  | "internet" | "vpn" | "remote" | "lan";

interface IndexerCheck {
  name: string;
  via: "prowlarr" | "jackett";
  status: Status;               // ok | warn (backing off) | error (failing test)
  lastError: string | null;
  failingSince: string | null;  // ISO
  autoFix: { action: "flaresolverr-tag" | "base-url-switch"; detail: string; at: string } | null;
  needsHuman: boolean;          // true when code can't fix it (login, broken definition)
}
```

### Chain checks (`chain`, in this order)

| id | stage | metrics |
|---|---|---|
| `prowlarr` | indexers | `indexers`, `failing`, `autoFixed`, `needsHuman` |
| `jackett` | indexers | `indexers`, `failing` |
| `flaresolverr` | indexers | `up` |
| `sonarr` / `radarr` / `lidarr` | arr | `queue`, `healthWarnings`, `version` |
| `qbittorrent` | download | `downloading`, `stalled`, `seeding`, `dlBytesPerSec`, `upBytesPerSec`, `connection` (`connected`/`firewalled`/`disconnected`), `torrentDiskFreeBytes` |
| `drivepool` | storage | `freeBytes`, `totalBytes`, `targetFreeBytes` (1 TB) |
| `languarrge` | processing | `receiverUp`, `queued`, `failed` |
| `tdarr` | processing | `queue`, `transcodeErrors`, `healthErrors`, `nodesOnline`, `nodes` (comma list), `workersActive` |
| `plex` | playback | `up`, `sessions`, `version` |
| `arrshole` | maintenance | `lastCycleAt`, `junkTaggerLastRunAt`, `dryRun` |

### Network checks (`network`)

| id | stage | what it means |
|---|---|---|
| `internet` | internet | HTTPS reachability and latency to a public endpoint; metrics `latencyMs`, `wanIp` |
| `dns` | internet | public and LAN name resolution work; metrics `resolveMs` |
| `vpn` | vpn | qBittorrent's external IP differs from the home WAN IP. **error** = qBittorrent traffic is leaving outside PIA. Metrics `torrentIp`, `wanIp` |
| `torrent-connectivity` | vpn | qBittorrent connection status and listen port; metrics `connection`, `listenPort`, `dhtNodes` |
| `tailscale-router` | remote | smidge-desktop (192.168.86.37), the Tailscale subnet router for the LAN, is reachable; metrics `latencyMs` |
| `wsl-portproxy` | lan | Windows portproxy rules point at the current WSL IP; metrics `wslIp`, `stalePorts` |
| `gateway` | lan | the LAN gateway answers; metrics `latencyMs` |

The status of a check this host can't measure is `unknown`, with the reason
in `summary`.
