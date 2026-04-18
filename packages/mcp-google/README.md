# @modular-context/mcp-google-workspace

MCP server exposing Gmail + Calendar tools to Claude Code. Designed to work with the [modular-context Obsidian plugin](https://github.com/klemensgc/modular-context-obsidian-plugin) — the plugin handles OAuth flow, token storage, and writes per-account credentials sidecars that this server reads on demand.

> **Status:** v1.1.0 stable — 10 tools, multi-account support. Part of Modular Context v2.0.

## Accounts

Multiple Google accounts can be connected simultaneously. Each tool accepts an optional `account` parameter (email, case-insensitive):

- Omit → primary account (first-connected or user-selected via plugin)
- Provide email → server resolves via `accounts-index.json`
- Unknown email → error `ACCOUNT_NOT_FOUND`

Plugin writes per-account credentials to `~/.modular-context/mcp-google/accounts/{filename}/credentials.json` with the index at `~/.modular-context/mcp-google/accounts-index.json`.

## Tools (10)

**Gmail (4):**
- `gmail_search` — query with Gmail syntax, optional body extraction
- `gmail_draft` — create draft (not sent)
- `gmail_send` — send immediately (skip draft)
- `gmail_modify_labels` — add/remove labels (system + custom). Archive = remove INBOX, mark-read = remove UNREAD, star = add STARRED.

**Calendar (6):**
- `calendar_list_calendars` — enumerate all calendars (primary + secondary + shared)
- `calendar_list_events` — events in date range
- `calendar_create_event` — create event, sendUpdates=none default
- `calendar_update_event` — patch existing event
- `calendar_delete_event` — delete event
- `calendar_freebusy` — query busy windows across calendars

Each tool definition:

### `gmail_search`

Search Gmail messages using Gmail's native query syntax.

**Input:**
```ts
{
  query: string;           // "is:unread from:x@y.com after:2026-04-01"
  maxResults?: number;     // default 20, max 100
  includeBody?: boolean;   // default false — lighter responses
}
```

**Returns:** Array of `{ id, threadId, subject, from, to, snippet, date, body? }`

### `gmail_draft`

Create a Gmail draft (user sends manually from Gmail UI).

**Input:**
```ts
{
  to: string[];
  cc?: string[];
  subject: string;
  body: string;               // plain text
  replyToThreadId?: string;   // for replies
}
```

**Returns:** `{ draftId, webUrl }` — open `webUrl` to review/send.

### `calendar_list_events`

List calendar events in a date range.

**Input:**
```ts
{
  calendarId?: string;   // default "primary"
  timeMin: string;       // ISO 8601
  timeMax: string;       // ISO 8601
  maxResults?: number;   // default 50
}
```

**Returns:** Array of `{ id, summary, description?, start, end, attendees[], location?, meetingLink?, htmlLink }`

### `calendar_create_event`

Create a calendar event. Does NOT send invites by default.

**Input:**
```ts
{
  calendarId?: string;       // default "primary"
  summary: string;
  description?: string;
  start: string;             // ISO 8601
  end: string;               // ISO 8601
  attendees?: string[];
  location?: string;
  sendUpdates?: "all" | "externalOnly" | "none";  // default "none"
}
```

**Returns:** Created event object.

## Install

**Automatic (recommended):** The modular-context plugin installs this server automatically on first Google Workspace Connect. Install location: `~/.modular-context/mcp-google/`.

**Manual:** Not currently supported standalone. A future v2 may ship as publishable npm package for bring-your-own-integration use.

## Configuration

The MCP server reads environment variables set by the plugin via `.mcp.json`:

| Variable | Purpose |
|----------|---------|
| `MC_CREDENTIALS_PATH` | Path to credentials sidecar (plaintext JSON, 0600) |
| `MC_LOG_PATH` | Path to server log file (appended, rotated at 10MB) |
| `MC_LOG_LEVEL` | `ERROR` / `WARN` / `INFO` / `DEBUG` (default `INFO`) |

## Security notes

The credentials sidecar (`~/.modular-context/mcp-google/credentials.json`) contains:
- OAuth refresh token (long-lived)
- OAuth client ID + secret (public for desktop apps per RFC 8252)
- Account email
- Current access token (short-lived)

Stored as plaintext JSON with `0600` file permissions (user-readable only), in a user-scoped folder. Comparable security profile to `~/.aws/credentials`, `~/.config/gcloud/application_default_credentials.json`, and `~/.ssh/` keys.

**Recommended:** exclude `~/.modular-context/` from Time Machine / cloud backups. On macOS enable FileVault for disk-level encryption.

See [ADR-003 addendum](https://github.com/klemensgc/modular-context-obsidian-plugin/blob/master/docs/ADR-003-addendum-shared-state.md) for the full security analysis.

## Troubleshooting

**`TOKEN_MISSING` error:** Credentials sidecar not found. Connect Google Workspace via plugin UI first.

**`TOKEN_EXPIRED` error:** Refresh token invalidated by Google (revoked, 6mo idle, password change). Disconnect + Reconnect via plugin.

**Tool returns no results:** Check that the relevant Gmail scope is granted in your OAuth consent. The plugin requests `gmail.readonly`, `gmail.send`, `calendar.events`, plus `openid email profile`.

**Server logs:** `~/.modular-context/mcp-google/logs/server.log`. Plugin command `google-workspace:show-logs` opens this file.

## Contributing

This server is part of the [modular-context monorepo](https://github.com/klemensgc/modular-context-obsidian-plugin/tree/master/packages/mcp-google). Issues and PRs welcome.

## License

MIT © modular-context
