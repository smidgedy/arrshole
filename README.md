# arrshole

Monitors qBittorrent for stuck torrents and deals with them. When a torrent is stuck downloading metadata or stalled for too long, arrshole tells the relevant *arr app (Sonarr, Radarr, or Lidarr) to blocklist the release and search for an alternative, then deletes the torrent and its files from qBittorrent.

It was written to automatically resolve gridlock in the qBittorrent queue in a way that allows *arr to continue trying download candidates until they're exhausted. I think it's ultimately a feature that should exist in *arr natively.

## What it does

1. Polls qBittorrent every 60 seconds (configurable)
2. Detects torrents stuck in `metaDL` (metadata download) or `stalledDL` (stalled) beyond configurable thresholds
3. For stalled torrents, applies progress-based thresholds — torrents barely started can be cleared quickly, while nearly-complete ones get more time to recover
4. Notifies the owning *arr app to blocklist the release and search for a replacement
5. Deletes the torrent and files from qBittorrent (only after the *arr app has been notified)
6. Persists tracking state to disk so timers survive service restarts

Safety features: dry-run mode (on by default), circuit breaker to limit deletions per cycle, re-verification before delete, no deletion of torrents that can't be matched to an *arr app.

## Project status

Let's be blunt - this is "vibe coded" with claude code. It's not my first rodeo, and I'm working in Typescript mainly so that I can tell when the robot is going *off-piste*. It's tested and working in my environment, and that's really all it's built to do. I've tried to structure things in a way that it should work in other places, but you will be testing. This is not a "mature" product, and it is unlikely that it ever will be.

## Features, Issues, Requests

If you have any feedback or requests please feel free to raise an issue on this repo, but know that this is unlikely to be monitored closely. I think this problem is actually best solved by the *arr apps and you should ultimately beg their maintainers to implement.

## Prerequisites

- Node.js 18+
- qBittorrent with Web UI enabled
- At least one of: Sonarr, Radarr, Lidarr

## Build and run

```bash
git clone <repo-url>
cd arrshole
npm install
npm run build
cp .env.example .env
# Edit .env with your credentials and settings
```

Run in dev mode:
```bash
npm run dev
```

Run production build:
```bash
npm start
```

Run tests:
```bash
npm test
```

## Configuration

All configuration is via environment variables in `.env`.

| Variable | Required | Default | Description |
|---|---|---|---|
| `QBIT_URL` | Yes | | qBittorrent Web UI URL |
| `QBIT_USERNAME` | Yes | | qBittorrent username |
| `QBIT_PASSWORD` | Yes | | qBittorrent password |
| `SONARR_URL` | No* | | Sonarr URL |
| `SONARR_API_KEY` | No* | | Sonarr API key (Settings > General > Security) |
| `RADARR_URL` | No* | | Radarr URL |
| `RADARR_API_KEY` | No* | | Radarr API key |
| `LIDARR_URL` | No* | | Lidarr URL |
| `LIDARR_API_KEY` | No* | | Lidarr API key |
| `CATEGORY_MAP` | No | Matches exact names: `sonarr`, `radarr`, `lidarr` | Custom category mapping, e.g. `tv-sonarr:sonarr,movies:radarr` |
| `POLL_INTERVAL_SECONDS` | No | `60` | Poll interval (minimum 10) |
| `METADATA_STUCK_MINUTES` | No | `10` | Minutes in metaDL before acting |
| `STALLED_THRESHOLDS` | No | `100:24` | Progress-based stalled thresholds (see below) |
| `MAX_ACTIONS_PER_CYCLE` | No | `5` | Max deletions per poll cycle (circuit breaker) |
| `DRY_RUN` | No | `true` | Set to `false` to enable destructive actions |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error`, `fatal` |
| `STATE_FILE` | No | `./arrshole-state.json` | Path to persist tracking state across restarts |

*At least one *arr app (URL + API key pair) must be configured.

If `CATEGORY_MAP` is not set, categories are matched by exact name: `sonarr`, `radarr`, `lidarr`.

### Stalled thresholds

`STALLED_THRESHOLDS` lets you set different timeouts for stalled torrents based on how much they've downloaded. Format: `maxPercent:hours,maxPercent:hours,...` — the last entry must cover 100%.

Example: `10:1,90:12,100:24` means:
- Torrents at **10% or less** — clear after **1 hour** stalled (barely started, not worth waiting)
- Torrents at **11–90%** — clear after **12 hours** stalled
- Torrents at **91–100%** — clear after **24 hours** stalled (nearly done, give them time)

The default `100:24` applies a flat 24-hour threshold to all stalled torrents regardless of progress.

### State persistence

arrshole tracks when it first observes each torrent in a stalled state. This tracking is persisted to disk (at `STATE_FILE`, default `./arrshole-state.json`) so that stall timers survive service restarts. If a torrent resumes downloading, its timer is cleared. On startup, arrshole logs how many tracked entries were restored and how long ago the state was saved.

## One-shot mode

Use CLI switches to immediately prune matching torrents without waiting for threshold timers. This is useful for manually clearing out a backlog of stuck torrents.

```bash
# Prune all stalled and metaDL torrents immediately
node dist/index.js --now --stalled --metadl

# Prune stalled torrents that have barely started (<10% complete)
node dist/index.js --now --stalled --below 10

# Prune stalled torrents that are nearly done (>90% complete)
node dist/index.js --now --stalled --above 90

# Combine filters: stalled torrents between 10% and 50%
node dist/index.js --now --stalled --above 10 --below 50
```

| Flag | Description |
|---|---|
| `--now` | Run once and exit (required for one-shot mode) |
| `--stalled` | Include `stalledDL` torrents |
| `--metadl` | Include `metaDL`/`forcedMetaDL` torrents |
| `--below <pct>` | Only torrents below this completion % (exclusive) |
| `--above <pct>` | Only torrents above this completion % (exclusive) |
| `--help` | Show usage information |

One-shot mode bypasses the circuit breaker and threshold timers — every matching torrent is processed in a single pass. The `DRY_RUN` env var still applies, so you can preview what would happen with `DRY_RUN=true`.

## Dry run vs live

`DRY_RUN=true` is the default. In this mode arrshole detects stuck torrents and logs exactly what it would do, but makes no changes. Run it like this first and check the logs to make sure it's identifying the right torrents:

```bash
npm run dev
# or if running as a service:
journalctl -u arrshole -f
```

Look for `[DRY RUN] Would remove from *arr queue, blocklist, and delete from qBittorrent` lines. Once you're satisfied it's targeting the right things, set `DRY_RUN=false` in `.env` and restart:

```bash
sudo systemctl restart arrshole
```

Live mode logs every action at `warn` level — you'll see `arr_notified` and `qbit_deleted` entries for each torrent it processes.

## Installing as a service

### WSL2 (tested)

Requires systemd enabled in WSL2. Add to `/etc/wsl.conf`:

```ini
[boot]
systemd=true
```

Add to `%USERPROFILE%\.wslconfig` on the Windows side:

```ini
[wsl2]
vmIdleTimeout=-1
networkingMode=mirrored
```

`vmIdleTimeout=-1` prevents WSL from shutting down when idle. `networkingMode=mirrored` makes Windows-side services reachable at `localhost` from WSL. Restart WSL with `wsl --shutdown` from PowerShell after changing either file.

Install the service:

```bash
# Check that the Environment=PATH in arrshole.service includes your Node.js binary path (find it with: dirname $(which node))
# Also check WorkingDirectory and EnvironmentFile paths

sudo cp arrshole.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable arrshole
sudo systemctl start arrshole

# View logs
journalctl -u arrshole -f
```

### Ubuntu with systemd (untested)

Should work the same as WSL2 minus the `.wslconfig` setup. Adjust the service file paths:

```bash
# Edit arrshole.service:
#   - Set ExecStart to your node binary path (run `which node` to find it)
#   - Set WorkingDirectory to where you cloned the repo
#   - Set EnvironmentFile to the .env path
#   - Set User to the user that should run the service

sudo cp arrshole.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable arrshole
sudo systemctl start arrshole
```

### Windows (untested)

No systemd on Windows, so you have a few options:

**Option A: NSSM (Non-Sucking Service Manager)**

Download [NSSM](https://nssm.cc/) and install arrshole as a Windows service:

```powershell
nssm install arrshole "C:\Program Files\nodejs\node.exe" "C:\path\to\arrshole\dist\index.js"
nssm set arrshole AppDirectory "C:\path\to\arrshole"
nssm set arrshole AppEnvironmentExtra "QBIT_URL=http://localhost:8080" "QBIT_USERNAME=admin" ...
# Or point to a .env file and use dotenv — the app loads .env from the working directory
nssm start arrshole
```

**Option B: Task Scheduler**

Create a scheduled task that runs at logon:

1. Open Task Scheduler
2. Create Task (not Basic Task)
3. Trigger: At log on
4. Action: Start a program
   - Program: `node.exe`
   - Arguments: `dist\index.js`
   - Start in: `C:\path\to\arrshole`
5. Settings: uncheck "Stop the task if it runs longer than"
6. Settings: check "Run task as soon as possible after a scheduled start is missed"

**Option C: pm2**

```powershell
npm install -g pm2
cd C:\path\to\arrshole
pm2 start dist/index.js --name arrshole
pm2 save
pm2-startup install
```

## Credits

This project was written entirely by [Claude Code](https://claude.ai/code) (Anthropic's AI coding agent), including the plan, implementation, tests, and this README.

## Recovery

If a release is incorrectly blocklisted, remove it in the *arr app under Activity > Blocklist, then trigger a manual search for the affected episode/movie/album.

## License

There is no license. Do with it what you will, at your own risk.
