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
| `OUTAGE_GUARD` | No | `true` | Skip all actions during a suspected client-wide outage (see below). `false` to disable |
| `OUTAGE_SPEED_FLOOR_BYTES` | No | `1024` | Global DL rate (B/s) at or below which the client counts as "not downloading" |
| `OUTAGE_MIN_ACTIVE` | No | `3` | Minimum torrents in a downloading state before the outage guard can engage |
| `IMPORT_REJECT` | No | `false` | Set to `true` to reap *arr import-rejections (see below) |
| `BAD_RELEASE` | No | `false` | Set to `true` to remove + blocklist fake/malicious downloads (see below) |
| `TASTE` | No | `false` | Set to `true` to enable the junk tagger (see below) |
| `TASTE_INTERVAL_HOURS` | No | `24` | How often the taste model runs |
| `TASTE_TIMEOUT_MINUTES` | No | `30` | Kill the model run if it takes longer |
| `TASTE_MAX_TAG_CHANGES` | No | `250` | Max tag adds + removes per run (circuit breaker) |
| `TASTE_DIR` / `TASTE_PYTHON` | No | `./taste` / `.venv/bin/python` | Where the model package and its interpreter live |
| `TASTE_STATE_FILE` | No | `./taste-data/arrshole-taste.json` | Last-run bookkeeping |
| `PLEX_TOKEN` | No | — | Lets the model read your plex.tv watch history |
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

### Outage guard

A client-wide qBittorrent outage (lost connectivity, VPN drop, the daemon wedging) makes *every* active torrent stall at the same time. Looked at one torrent at a time, that's indistinguishable from a batch of genuinely dead releases — so without a guard, arrshole would blocklist and delete everything that crossed its stall thresholds during the outage, potentially thousands of releases.

The tell that separates an outage from real dead torrents is the **global transfer rate**: during an outage the whole client sits at ~0 B/s. Each cycle, before taking any action, arrshole checks `qBittorrent`'s global download rate (`/api/v2/transfer/info`). If the rate is at or below `OUTAGE_SPEED_FLOOR_BYTES` **and** at least `OUTAGE_MIN_ACTIVE` torrents are in a downloading state, it treats the situation as a client-wide outage and skips all actions for that cycle. It resumes automatically on the next cycle once the rate recovers — no manual intervention.

The `OUTAGE_MIN_ACTIVE` floor stops a quiet, legitimately-idle client (nothing downloading, so 0 B/s is normal) from being mistaken for an outage. The guard is **fail-safe**: if the transfer rate can't be read at all, the cycle is skipped rather than risk acting blind. Set `OUTAGE_GUARD=false` to disable it entirely.

### Import-rejection reaper

Separate from stalled/metaDL detection, this handles a different failure mode: a
release that **finishes downloading** and is then **rejected at import** by the
*arr app — e.g. Lidarr rejecting an album because a track is missing, or Sonarr
rejecting a release that turned out not to be an upgrade. The download sits
completed-but-stopped in qBittorrent forever, orphaned.

This can't be detected from qBittorrent state: a completed torrent sitting at
`stoppedUP`/`pausedUP` is indistinguishable there from a healthy torrent seeding
after a *successful* import. The authoritative signal lives in the *arr app — the
queue item's `trackedDownloadState` (`importFailed`/`importBlocked`) plus the
`statusMessages` explaining why. So the reaper is driven entirely by the *arr
queue, and correlates back to the download by ID.

Each rejected item is classified by its reason:

- **Defective** (incomplete release, missing tracks/episodes, wrong match) — the
  item has no acceptable file, so arrshole tells *arr to delete the download and
  its files, blocklist the release, and **search for a replacement**.
- **Redundant** ("not an upgrade for existing file" — you already have an equal or
  better copy) — the item isn't deficient, so arrshole deletes the orphan and
  blocklists it to stop a re-grab loop, but does **not** re-search (that would
  churn and risk blocklisting the whole release pool for something you have).
- **Skip** — transient states (`importPending`, still importing) and any reason
  the classifier doesn't recognise are left untouched and logged, so nothing is
  acted on speculatively.

Removal goes through the *arr queue with `removeFromClient=true`, so *arr deletes
the torrent and files from qBittorrent and applies the blocklist atomically.
Because a season-pack surfaces as one queue record per episode (all sharing a
download ID), records are collapsed to one action per torrent before the circuit
breaker (`MAX_ACTIONS_PER_CYCLE`) is applied.

Disabled by default — it acts on completed torrents, a wider blast radius than
stalled/metaDL detection, so it's opt-in via `IMPORT_REJECT=true`. `DRY_RUN` still
applies. To clear the current backlog immediately without waiting for poll cycles:

```bash
node dist/index.js --now --rejects        # DRY_RUN=true previews; false acts
```

### Bad-release reaper

Opt-in (`BAD_RELEASE=true`). Fake releases are common: a "movie" that is really a disc image wrapping a padded `.exe`, or a show that arrives with an installer next to the video. Each poll, arrshole looks at the file list of every Sonarr/Radarr download once qBittorrent has its metadata, and treats it as bad if it contains any executable, script or shortcut (`.exe`, `.scr`, `.lnk`, `.bat`, `.msi`, `.ps1`, ...), if its main file is a disc image (`.iso`, `.img`, `.dmg`, ...), or if it has no video at all. The tiny `RARBG_DO_NOT_MIRROR.exe` decoy that genuine old RARBG releases carry is allowed.

A bad release is removed through the *arr queue (`removeFromClient=true`, `blocklist=true`), so the download and its files are deleted, **that specific release is blocklisted**, and the app searches for another. If the download isn't in an *arr queue, the torrent and its files are deleted from qBittorrent directly (there's nothing to blocklist against). Clean releases are inspected once. `DRY_RUN` and `MAX_ACTIONS_PER_CYCLE` apply.

### Junk tagger

Opt-in (`TASTE=true`). Once a day arrshole runs a taste model (`taste/`, Python) that learns what you keep versus delete in Radarr/Sonarr, then puts a `junk` tag on the strongest deletion candidates: a poor taste fit *and* a lot of disk space. Filter on `junk` in the Radarr/Sonarr UI, then for each item:

- **delete it**: recorded as a confirmed deletion
- **add `keep`**: arrshole removes `junk`, and the model counts it as a keep
- **just remove `junk`**: counted as a soft keep

Nothing is ever deleted by arrshole; it only adds and removes the `junk` tag. `DRY_RUN` applies (dry run logs the planned tag changes), and `TASTE_MAX_TAG_CHANGES` caps changes per run.

**What it learns from:** items removed from the library, import-list exclusions (older deletions), your `keep` tags, your UI custom filters (a filter match without `keep` counts as "maybe not processed yet", at low weight), and your verdicts on `junk` items. Plex watch history (every account, from Plex's nightly DB backups, plus your plex.tv history if `PLEX_TOKEN` is set) protects anything watched in the last 12 months. It is not a taste signal, because deleted items have no history.

**Not overreacting:** a verdict counts as one labelled item at about 3× normal weight; total verdict weight is capped at 15% of the training weight; and a pattern needs 20+ items behind it before the model acts on it. One odd keep (a single Estonian horse drama) doesn't rescue everything similar, but a consistent run of keeps does (see `taste/tests`). Each run logs score drift against the previous run.

**Tuning:** `taste/taste.toml` (weights, features, how many items carry `junk` at once, size vs taste balance). Per-run reports (ranked candidates, the plan, metrics) are written to `taste-data/runs/<id>/`.

Setup (once):

```bash
python3 -m venv taste/.venv
taste/.venv/bin/pip install -e taste
# optional: import historic deletions/verdicts gathered elsewhere
(cd taste && .venv/bin/python -m arr_taste seed /path/to/seed.jsonl)
```

Run the model alone (read-only, prints the plan JSON): `cd taste && RADARR_URL=... RADARR_API_KEY=... .venv/bin/python -m arr_taste plan`. Tests: `cd taste && .venv/bin/pip install -e '.[dev]' && .venv/bin/python -m pytest`.

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
| `--rejects` | Reap *arr import-rejections (see "Import-rejection reaper") |
| `--taste` | Run the taste model now and apply its junk-tag plan (needs `TASTE=true`) |
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

## Known limitations and design choices

The following are deliberate trade-offs, not bugs. They've been reviewed and accepted as appropriate for this project's scope and deployment context.

**HTTP is supported (not just HTTPS).** qBittorrent, Sonarr, Radarr, and Lidarr are typically deployed on a home LAN and accessed via HTTP. Requiring HTTPS would force users to set up TLS certificates for local services that don't ship with them. If you're exposing these services over the internet, you should be using a reverse proxy with TLS anyway — that's outside the scope of this tool.

**API responses are not validated at runtime.** JSON responses from qBittorrent and *arr APIs are cast to TypeScript interfaces without runtime schema validation (e.g., zod). These are trusted internal services with stable, documented APIs — not user input. Adding runtime validation would increase complexity and dependencies for no practical benefit in this context.

**`parseInt` accepts trailing non-numeric characters.** `parseInt("10abc", 10)` returns `10` in JavaScript. The `parseIntStrict` helper validates the result is finite and above a minimum, but doesn't reject trailing garbage. Since all numeric config comes from `.env` files written by the operator (not user input), this is a non-issue in practice.

**`drain()` cancels the stream rather than consuming it.** The `drain()` utility calls `response.body?.cancel()` to release resources on error paths. Strictly, "drain" implies reading to completion, but cancelling is more efficient and achieves the same goal (freeing the connection). The function works correctly for all call sites.

**`DRY_RUN` only disables on the exact string `"false"`.** Any other value — including `"0"`, `"no"`, `"off"`, or unset — enables dry-run mode. This is intentional: for a daemon that deletes torrents and modifies *arr queues, the safe default is to do nothing. You have to explicitly opt in to destructive behaviour.

**Test mocks use `as any` casts.** Test files contain ~30 `as any` assertions to create partial mock objects. This is a pragmatic choice — fully typing mock objects that only need 2-3 methods would add significant boilerplate for no test quality benefit. Production code has zero `any` usage.

## Credits

This project was written entirely by [Claude Code](https://claude.ai/code) (Anthropic's AI coding agent), including the plan, implementation, tests, and this README.

## Recovery

If a release is incorrectly blocklisted, remove it in the *arr app under Activity > Blocklist, then trigger a manual search for the affected episode/movie/album.

## License

There is no license. Do with it what you will, at your own risk.
