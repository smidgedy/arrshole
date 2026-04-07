# arrshole

Monitors qBittorrent for stuck torrents and deals with them. When a torrent is stuck downloading metadata or stalled for too long, arrshole tells the relevant *arr app (Sonarr, Radarr, or Lidarr) to blocklist the release and search for an alternative, then deletes the torrent and its files from qBittorrent.

It was written to automatically resolve gridlock in the qBittorrent queue in a way that allows *arr to continue trying download candidates until they're exhausted.

## What it does

1. Polls qBittorrent every 60 seconds (configurable)
2. Detects torrents stuck in `metaDL` (metadata download) or `stalledDL` (stalled) beyond configurable thresholds
3. Notifies the owning *arr app to blocklist the release and search for a replacement
4. Deletes the torrent and files from qBittorrent (only after the *arr app has been notified)

Safety features: dry-run mode (on by default), circuit breaker to limit deletions per cycle, re-verification before delete, no deletion of torrents that can't be matched to an *arr app.

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
| `QBIT_URL` | Yes | `http://localhost:8080` | qBittorrent Web UI URL |
| `QBIT_USERNAME` | Yes | | qBittorrent username |
| `QBIT_PASSWORD` | Yes | | qBittorrent password |
| `SONARR_URL` | No* | | Sonarr URL |
| `SONARR_API_KEY` | No* | | Sonarr API key (Settings > General > Security) |
| `RADARR_URL` | No* | | Radarr URL |
| `RADARR_API_KEY` | No* | | Radarr API key |
| `LIDARR_URL` | No* | | Lidarr URL |
| `LIDARR_API_KEY` | No* | | Lidarr API key |
| `CATEGORY_MAP` | No | Auto-detected | Custom category mapping, e.g. `tv-sonarr:sonarr,movies:radarr` |
| `POLL_INTERVAL_SECONDS` | No | `60` | Poll interval (minimum 10) |
| `METADATA_STUCK_MINUTES` | No | `10` | Minutes in metaDL before acting |
| `STALLED_STUCK_HOURS` | No | `24` | Hours in stalledDL before acting |
| `MAX_ACTIONS_PER_CYCLE` | No | `5` | Max deletions per poll cycle (circuit breaker) |
| `DRY_RUN` | No | `true` | Set to `false` to enable destructive actions |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |

*At least one *arr app (URL + API key pair) must be configured.

If `CATEGORY_MAP` is not set, categories are matched by exact name: `sonarr`, `radarr`, `lidarr`.

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
# Check the node path in arrshole.service matches your system (default: /home/smidge/.nvm/versions/node/v25.5.0/bin/node)
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
