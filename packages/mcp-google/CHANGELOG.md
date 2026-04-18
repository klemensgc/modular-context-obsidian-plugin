# Changelog — @modular-context/mcp-google-workspace

## v1.3.0 — 2026-04-18 — Sheets + Slides (25 tools total)

Second expansion phase — adds Google Sheets (5 tools) and Google Slides (3 tools). Brings MCP surface to **25 tools** across 6 Google Workspace products.

### Added — Sheets tools (5)
- `sheets_list_sheets` — get spreadsheet metadata + list of sheet tabs (titles, IDs, grid dimensions)
- `sheets_read_range` — read values from A1 notation range, returns 2D string array. Supports `majorDimension` (ROWS/COLUMNS) + `valueRenderOption` (FORMATTED_VALUE / UNFORMATTED_VALUE / FORMULA)
- `sheets_write_range` — overwrite values at A1 range. Supports `valueInputOption` (RAW / USER_ENTERED) — USER_ENTERED parses formulas + dates
- `sheets_append_row` — append row(s) to end of data region using `values.append` API with `INSERT_ROWS`
- `sheets_create_spreadsheet` — new spreadsheet with title + optional initial sheet tab titles

### Added — Slides tools (3)
- `slides_read_presentation` — fetch metadata + plain-text summary per slide (walks textRun elements across shapes + tables)
- `slides_create_presentation` — new presentation with title, returns presentationId + webViewLink
- `slides_add_slide` — insert slide at `insertionIndex` (default: append). Supports 6 layouts: BLANK, TITLE, TITLE_AND_BODY, SECTION_HEADER, TITLE_AND_TWO_COLUMNS, CAPTION_ONLY

### Added — Infrastructure
- `createSheetsClient`, `createSlidesClient` factories in `google/client.ts`
- `MCGoogleError` enum extended: `SHEETS_API_ERROR`, `SHEETS_NOT_FOUND`, `SHEETS_INVALID_RANGE`, `SLIDES_API_ERROR`, `SLIDES_NOT_FOUND`
- New response types: `SheetTab`, `SheetsListResult`, `SheetsRangeData`, `SheetsWriteResult`, `SheetsCreateResult`, `SlideSummary`, `SlidesPresentation`, `SlidesCreateResult`, `SlidesAddSlideResult`

### Changed — OAuth scopes
- `GOOGLE_WORKSPACE_SCOPES` expanded from 8 → 10:
  - `https://www.googleapis.com/auth/spreadsheets` (full Sheets read/write)
  - `https://www.googleapis.com/auth/presentations` (full Slides read/write)
- **Migration required:** Existing users upgrading from v1.2.0 must re-authenticate via plugin Connect Google modal. Plugin auto-detects scope mismatch and surfaces "needs reconnect" via `computeMissingScopes`.

### Prerequisites
- User must enable Google Sheets API + Google Slides API in their Google Cloud project (same project as Gmail/Drive). Tool calls return `PERMISSION_DENIED` with direct `console.developers.google.com` link until APIs enabled.

---

## v1.2.0 — 2026-04-18 — Drive + Docs (17 tools total)

First expansion phase — adds Google Drive (4 tools) and Google Docs (3 tools) to the existing Gmail + Calendar set (10 tools).

### Added — Drive tools (4)
- `drive_list_files` — list files with optional Drive query syntax filter (e.g. `name contains 'report'`), pagination, ordering
- `drive_search` — full-text search across file content + names. Optional mimeType filter. Auto-excludes trashed files
- `drive_download_file` — fetch file content. Google-native formats (Docs/Sheets/Slides) auto-exported via `files.export` as plain text; binary files returned as base64
- `drive_upload_file` — create file with content + optional parent folder. Supports utf-8 + base64 input. Uses multipart `files.create` with `stream.Readable.from(buffer)`

### Added — Docs tools (3)
- `docs_read_doc` — fetch doc, return plain-text content walked from `body.content[]`. Tables rendered with tab separators per row
- `docs_create_doc` — new Google Doc with title + optional initial content (batchUpdate insertText at index 1)
- `docs_update_doc` — modify existing doc. `mode: "append"` inserts at document end index; `mode: "replace"` deletes body range + inserts new content

### Added — Infrastructure
- `createDriveClient`, `createDocsClient` factories
- New file `google/docs-helpers.ts` with `extractPlainText`, `getDocEndIndex`, `buildInsertTextRequests`, `buildReplaceAllRequests`
- `MCGoogleError` enum extended: `DRIVE_API_ERROR`, `DRIVE_FILE_NOT_FOUND`, `DRIVE_UPLOAD_FAILED`, `DOCS_API_ERROR`, `DOCS_NOT_FOUND`
- New response types: `DriveFile`, `DriveFileList`, `DriveFileContent`, `DriveUploadResult`, `DocDocument`, `DocCreateResult`, `DocUpdateResult`

### Changed — OAuth scopes
- `GOOGLE_WORKSPACE_SCOPES` expanded from 5 → 8:
  - `https://www.googleapis.com/auth/drive.file` (app-scoped Drive read/write)
  - `https://www.googleapis.com/auth/drive.metadata.readonly` (broader Drive list/search without content access)
  - `https://www.googleapis.com/auth/documents` (full Docs read/write)
- **Migration required:** Users on v1.1.0 see "needs reconnect (missing 3 scopes)" in `google-workspace-status`.

### Prerequisites
- Google Drive API + Google Docs API must be enabled in the OAuth project (Gmail/Calendar APIs were already enabled in v1.1.0).

---

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
