# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- One-shot CLI mode (`--now --stalled --metadl`) for immediate pruning without threshold timers
- `--below` and `--above` progress filters for one-shot mode
- `--help` flag with usage documentation
- Structured startup error handling (clean log messages instead of stack traces)
- `qbitUrl` logged at startup for easier debugging
- Heartbeat uptime in poll logs for detecting hung daemons
- JSDoc on all public methods
- CHANGELOG.md

### Changed
- `.env` permission check now exits fatally instead of warning
- State file written with mode 0o600 (owner-only)
- Pino log redaction expanded to cover `*.token`, `*.secret`, `*.key`
- `STUCK_ELIGIBLE_STATES` and `METADATA_STATES` exported from `types.ts` (deduplicated)
- Systemd service hardened with additional security directives
- `.env.example` updated with tiered threshold example and `STATE_FILE`
- README: fixed `CATEGORY_MAP` default description, added `fatal` to `LOG_LEVEL` options

### Fixed
- All service URLs pointed to `localhost` which is unreachable from WSL2

## [1.1.0] - 2026-04-08

### Added
- Progress-based stalled thresholds (`STALLED_THRESHOLDS` env var)
- Persistent state tracking across service restarts (`STATE_FILE`)
- `STATE_FILE` configuration option

## [1.0.0] - 2026-04-07

### Added
- Initial release
- Poll-based monitoring of qBittorrent for stuck torrents (`metaDL`, `stalledDL`)
- Automatic notification to Sonarr, Radarr, and Lidarr (blocklist + re-search)
- Dry-run mode (on by default)
- Circuit breaker (`MAX_ACTIONS_PER_CYCLE`)
- Re-verification before deletion
- Orphan deletion retry with max retries
- Category mapping (auto-detected or manual `CATEGORY_MAP`)
- Systemd service file for WSL2/Linux deployment
