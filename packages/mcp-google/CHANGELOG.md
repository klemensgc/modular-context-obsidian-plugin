# Changelog — @modular-context/mcp-google-workspace

## v1.1.0 — 2026-04-18 — Graduated stable

Graduated from beta alongside Modular Context plugin v2.0.0. No API changes since 1.1.0-beta.1 — this release is the production-stable marker.

**Recommended for production** Claude Code use with the Modular Context plugin (v2.0.0+).

### Verified stable
- 10 tools (Gmail ×4 + Calendar ×6) tested end-to-end
- Multi-account support (per-account credentials sidecar + index)
- OAuth refresh + atomic sidecar write-back
- Error taxonomy complete (9 codes)
- Logging with PII scrubbing + 10MB rotation

### No breaking changes from 1.1.0-beta.1
If you're on 1.1.0-beta.1 the only upgrade step is bumping the plugin to v2.0.0, which will pick up the stable version automatically via bundled build.

---

## v1.1.0-beta.1 (unreleased)

Multi-account support + 6 new tools (total: 10).

### Added — Tools
- `gmail_send` — real send (not just draft)
- `gmail_modify_labels` — archive/star/read/unread + custom labels
- `calendar_list_calendars` — enumerate all user calendars
- `calendar_update_event` — events.patch semantics
- `calendar_delete_event`
- `calendar_freebusy` — availability query across calendars

### Added — Multi-account
- Per-account sidecar: `~/.modular-context/mcp-google/accounts/{filename}/credentials.json`
- `accounts-index.json` tracks connected accounts + primary selection
- All tools accept optional `account` param (email, case-insensitive). Omit → primary.
- New error codes: `ACCOUNT_NOT_FOUND`, `SCOPE_OUTDATED`

### Changed — Env vars
- New: `MC_ACCOUNTS_DIR`, `MC_ACCOUNTS_INDEX` (multi-account primary path)
- Legacy: `MC_CREDENTIALS_PATH` (fallback only, synthesizes in-memory single-entry index)

### Internals
- Token refresh writes back to per-account sidecar (atomic rename)
- OAuth scopes for account validation — if missing expected scopes, server can detect and return typed error

---

## v1.0.0-beta.1 (unreleased)

Initial release. MCP server exposing Gmail + Calendar tools to Claude Code.

### Tools
- `gmail_search` — query Gmail with native search syntax, optional body extraction
- `gmail_draft` — create Gmail draft (user opens in web UI to send)
- `calendar_list_events` — list events in a date range
- `calendar_create_event` — create calendar event, `sendUpdates=none` default

### Architecture
- MCP stdio transport via `@modelcontextprotocol/sdk`
- Reads plaintext credentials sidecar (written by plugin) at `$MC_CREDENTIALS_PATH`
- Refreshes access tokens on demand via `google-auth-library` when near expiry
- Writes refreshed credentials atomically back to sidecar
- Error mapping: Google API 401/403/429/5xx → typed MCP errors with retry hints

### Logging
- stderr primary, optional file sink at `$MC_LOG_PATH`
- 10MB rotation, keep last 3 logs
- Redacts tokens, refresh tokens, Authorization headers
- Levels via `$MC_LOG_LEVEL` (ERROR / WARN / INFO / DEBUG)

### Known limitations
- Bundled binary is ~100MB (googleapis covers all APIs, not just Gmail/Calendar)
- No standalone npm install path yet — designed for plugin-managed install
