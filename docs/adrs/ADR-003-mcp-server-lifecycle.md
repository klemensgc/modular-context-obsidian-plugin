---
title: ADR-003 — MCP Server Lifecycle
updated: 2026-04-17
status: accepted
---
# ADR-003: MCP Server Lifecycle — Own server, standalone package, spawned by Claude Code

## Context

Integracja Google Workspace do Claude Code wymaga MCP (Model Context Protocol) servera który expose Gmail + Calendar jako tools. Decyzje do podjęcia:

1. **Build vs buy** — czy fork `j3k0/mcp-google-workspace`, użyć npm dependency, czy napisać własny
2. **Package location** — standalone package w monorepo, embedded w plugin, czy osobne repo
3. **Spawn model** — kto startuje server (plugin process vs Claude Code via `.mcp.json`)
4. **Token refresh coordination** — plugin refreshuje tokeny → jak server widzi updated tokens
5. **Error handling** — `invalid_grant`, network failures, quota errors

Konstrainty z [[../research/03-mcp-server-patterns]]:
- stdio transport preferred (simple subprocess model)
- `.mcp.json` w project root dla project-level config, version-controlled
- Istniejące servery są close-but-not-quite (OAuth external, nasz flow inside)

## Decision

**Build own MCP server w `packages/mcp-google/` jako standalone package:**

1. **Package location:** `packages/mcp-google/` — standalone, publishable jako `@modular-context/mcp-google-workspace` na npm
2. **Spawn model:** Claude Code spawnuje via `.mcp.json` (stdio transport, plugin nie uruchamia servera explicitly)
3. **Server reads tokens from disk** — plugin write encrypted tokens (per ADR-002), server decrypts on-demand using keyring key (via env-provided service+account names)
4. **Token refresh:** plugin ma timer (Obsidian `setInterval` in plugin lifecycle) który co 50 min czyta + refreshuje jeśli <10min do expiry → re-encrypt. Server re-reads tokens.enc on each tool call (no cache — simple, safe).
5. **`.mcp.json` auto-generation:** plugin generuje/updateuje `.mcp.json` w vault root on connect/disconnect
6. **Tools v1 (minimum):** 4 tools — `gmail.search`, `gmail.send` (draft mode only), `calendar.listEvents`, `calendar.createEvent`

## Architecture diagram

```
┌────────────────────────────────────────────────────────────┐
│  VAULT ROOT                                                │
│  /Users/kubagasienica/Desktop/all-transcripts/modular-context/│
│                                                            │
│  ├─ .mcp.json ◀──── plugin generuje/updateuje ◀─┐           │
│  │                                              │           │
│  ├─ .modular-context/                           │           │
│  │   ├─ tokens.enc ◀── plugin pisze ◀──┐        │           │
│  │   ├─ tokens.meta.json                │        │           │
│  │   └─ .gitignore                       │        │           │
│  │                                       │        │           │
│  └─ .obsidian/plugins/modular-context/   │        │           │
│                                          │        │           │
└──────────────────────────────────────────┼────────┼──────────┘
                                           │        │
         ┌─────────────────────────────────┴────────┴─────┐
         │  Obsidian Plugin (packages/plugin)             │
         │                                                │
         │  • OAuth flow (per ADR-001)                    │
         │  • Encrypts + writes tokens.enc (per ADR-002)  │
         │  • Timer refresh (every 50min, Obsidian Timer) │
         │  • Writes .mcp.json on connect                 │
         └────────────────────────────────────────────────┘
                              │ (OAuth happens here)
                              ▼
                     [User Browser → Google OAuth]


         ┌─────────────────────────────────────────────┐
         │  Claude Code (user invokes /skill)          │
         │                                             │
         │  1. Reads .mcp.json                         │
         │  2. Spawns node mcp-google-workspace.js     │
         │     with env: MC_TOKENS_PATH,               │
         │              MC_KEYRING_SERVICE,            │
         │              MC_KEYRING_ACCOUNT             │
         │  3. Protocol handshake (initialize)         │
         │  4. Calls tools (gmail.search, etc.)        │
         │  5. On session end: closes stdin, server    │
         │     shuts down                              │
         └─────────────────────────────────────────────┘
                              │
                              ▼
         ┌─────────────────────────────────────────────┐
         │  MCP Server (packages/mcp-google)           │
         │                                             │
         │  On init:                                   │
         │    • read env MC_KEYRING_SERVICE/ACCOUNT    │
         │    • load master key from keychain          │
         │                                             │
         │  On tool call:                              │
         │    • read tokens.enc (per call, no cache)   │
         │    • decrypt with master key                │
         │    • if expired → error "TOKEN_EXPIRED"     │
         │      (plugin refreshes, client retries)     │
         │    • googleapis API call with access_token  │
         │    • return MCP response                    │
         └─────────────────────────────────────────────┘
                              │
                              ▼
                        [Google APIs]
```

## `.mcp.json` schema (generated by plugin)

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "node",
      "args": [
        "/Users/kubagasienica/.modular-context/mcp-google/dist/index.js"
      ],
      "env": {
        "MC_TOKENS_PATH": "${VAULT_PATH}/.modular-context/tokens.enc",
        "MC_TOKENS_META_PATH": "${VAULT_PATH}/.modular-context/tokens.meta.json",
        "MC_KEYRING_SERVICE": "modular-context-google-workspace",
        "MC_KEYRING_ACCOUNT": "vault-${VAULT_UUID}",
        "MC_LOG_PATH": "${VAULT_PATH}/.modular-context/logs/mcp-google.log"
      }
    }
  }
}
```

**Server install location:** `~/.modular-context/mcp-google/` — installed on first Connect. Plugin downloads/copies from bundle or npm. Keeps server updates decoupled from plugin updates.

**Idempotency:** plugin merges with existing `.mcp.json` (other servers user may have). Never overwrites keys outside `google-workspace`.

## Tool API v1 (4 tools minimum)

```typescript
// gmail.search
{
  name: "gmail_search",
  description: "Search Gmail messages using Gmail search syntax",
  inputSchema: {
    query: string;         // e.g. "is:unread from:partner@example.com"
    maxResults?: number;   // default 20
    includeBody?: boolean; // default false (lighter responses)
  },
  returns: GmailMessage[]  // id, subject, from, snippet, date, body?
}

// gmail.send (draft mode in W1)
{
  name: "gmail_draft",
  description: "Create a Gmail draft (not sent automatically)",
  inputSchema: {
    to: string[];
    cc?: string[];
    subject: string;
    body: string;          // plain text
    replyToThreadId?: string;
  },
  returns: { draftId: string; webUrl: string; }  // user opens in Gmail to send
}

// calendar.listEvents
{
  name: "calendar_list_events",
  description: "List calendar events in a date range",
  inputSchema: {
    calendarId?: string;   // default "primary"
    timeMin: string;       // ISO 8601
    timeMax: string;       // ISO 8601
    maxResults?: number;   // default 50
  },
  returns: CalendarEvent[] // id, summary, start, end, attendees, location
}

// calendar.createEvent
{
  name: "calendar_create_event",
  description: "Create a calendar event",
  inputSchema: {
    calendarId?: string;   // default "primary"
    summary: string;
    description?: string;
    start: string;         // ISO 8601
    end: string;           // ISO 8601
    attendees?: string[];  // emails
    location?: string;
    sendUpdates?: "all" | "externalOnly" | "none"; // default "none"
  },
  returns: CalendarEvent
}
```

V2 expansion (post W1): `gmail_send` (actually sends, not just draft), `gmail_archive`, `gmail_label`, `calendar_delete`, `calendar_update`, `calendar_freeBusy`, `gmail_bulk_*`.

## Alternatives considered

| Option | Pros | Cons | Reason |
|--------|------|------|--------|
| **A. Use j3k0/mcp-google-workspace as npm dep** | Zero own code, maintained elsewhere | External OAuth model (`.gauth.json` manual flow) — sprzeczne z onboarding | Rejected — UX incompatible |
| **B. Fork j3k0 + modify token loading** | Faster start vs from-scratch | Continuous merge maintenance, ~50% modifications | Rejected — "build own" not much slower, full control |
| **C. Build own, embedded w plugin** | Simpler install (plugin = server) | Can't publish as npm asset, harder reuse | Rejected — marketing loss |
| **D. Build own, standalone package** | Publishable marketing asset, reusable, clean separation | Slightly more setup complexity | **ACCEPTED** |
| **E. Build own, separate repo** | Fully independent project | Fragmentation, less discovery | Rejected — keep w monorepo (shared types, shared CI) |
| **F. Server as HTTP (not stdio)** | Could serve multiple Claude Code instances | Security warnings (DNS rebinding), more complex | Rejected — stdio is standard, simple, secure |
| **G. Plugin spawns server explicitly** | Plugin controls lifecycle directly | Duplicate work (Claude Code already does this via .mcp.json), coordination issues | Rejected — let Claude Code own spawning |

## Consequences

### Positive
- **Full control** over tool API, error messages, user experience
- **Brand asset** — `@modular-context/mcp-google-workspace` publishable to npm, visible in MCP server directories
- **Tight integration** with our token storage (no mismatched flows)
- **Narrative** — shipping our own MCP server reinforces "we own the stack" positioning
- **Reusable** — third parties can use it standalone (bring your own plugin integration)
- **Simple mental model** — "Claude Code spawns, talks stdio, exits" — no hidden lifecycle

### Negative
- **More code to maintain** — ~1000-1500 LoC TypeScript (compared to `npx j3k0-package`)
- **Version coordination** — plugin and server must agree on token format, keyring service/account names. Breaking changes in one require other to update
- **Install complexity** — server isn't part of plugin bundle, must be installed separately (`~/.modular-context/mcp-google/`). First-run flow: plugin checks for installation, downloads if missing
- **Google API coverage gap** — we start with 4 tools, users may request more. Need expansion backlog
- **Testing burden** — must test against real Gmail + Calendar APIs (can't mock everything — real OAuth responses vary)

### Mitigations
- **Install automation:** plugin installs server on first Connect via `npm i -g @modular-context/mcp-google-workspace` OR download prebuilt bundle OR copy from plugin assets (decide during W1 Iter 4 based on ease of use)
- **Version pinning:** plugin manifest declares `mcpGoogleServerVersion: "1.0.0"` — plugin checks + updates server if mismatch
- **Error taxonomy:** clear error codes server returns (TOKEN_EXPIRED, TOKEN_INVALID, QUOTA_EXCEEDED, NETWORK_ERROR) → plugin can display user-friendly messages + recovery actions
- **Testing:** integration tests w `packages/mcp-google/tests/` using real test Gmail account (separate from klemens@receptionos.com, dedicated QA account)
- **Hot reload:** server re-reads `tokens.enc` on each tool call → zero-downtime refresh (plugin updates file, next tool call sees new tokens)

## Implementation notes for W2

W1 NIE implementuje MCP server — tylko OAuth + storage. W2 scope:

### Package scaffold
```
packages/mcp-google/
├── src/
│   ├── index.ts              # entry point, protocol handshake
│   ├── tools/
│   │   ├── gmail-search.ts
│   │   ├── gmail-draft.ts
│   │   ├── calendar-list-events.ts
│   │   └── calendar-create-event.ts
│   ├── auth/
│   │   └── token-loader.ts   # reads tokens.enc, decrypts via keyring
│   ├── google/
│   │   └── client.ts         # googleapis wrapper
│   └── types.ts
├── tests/
├── package.json              # "bin": { "mcp-google-workspace": "./dist/index.js" }
├── tsconfig.json
├── README.md
└── LICENSE (MIT)
```

### Dependencies
```json
{
  "@modelcontextprotocol/sdk": "^1.x",  // official TS SDK
  "googleapis": "^144.x",
  "google-auth-library": "^9.x",
  "@napi-rs/keyring": "^1.x"
}
```

### Build output
- `dist/index.js` — bundled ESM/CJS single-file entry point (esbuild)
- Shebang: `#!/usr/bin/env node` — executable
- Target: Node 20+ (same as plugin)

### Log strategy
- stderr → `MC_LOG_PATH` (if set, append mode, rotate after 10MB)
- Log levels: ERROR, WARN, INFO, DEBUG (controlled via `MC_LOG_LEVEL`)
- Never log tokens, subject lines, or email bodies (privacy)

### Error taxonomy
```ts
export enum MCGoogleError {
  TOKEN_MISSING = "TOKEN_MISSING",        // no tokens.enc file
  TOKEN_EXPIRED = "TOKEN_EXPIRED",        // plugin should refresh
  TOKEN_INVALID = "TOKEN_INVALID",        // decryption failed, tampered
  QUOTA_EXCEEDED = "QUOTA_EXCEEDED",      // Google API limits
  NETWORK_ERROR = "NETWORK_ERROR",        // transport failure
  PERMISSION_DENIED = "PERMISSION_DENIED", // scope insufficient
  RATE_LIMITED = "RATE_LIMITED",          // Google 429
  UNKNOWN = "UNKNOWN",
}
```

## References

- [[../research/03-mcp-server-patterns]] — transport, lifecycle, existing implementations
- [[../research/01-oauth-desktop-flow]] — token format
- [[ADR-002-token-storage]] — tokens.enc contract, keyring key lookup
- [[ADR-004-skill-registry-integration]] — how server gets installed via skill flow
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [googleapis npm](https://www.npmjs.com/package/googleapis)

## Open questions for user

- Instalacja servera: `npm install -g` vs bundle-in-plugin vs download-on-first-use — preferencja UX?
- v1 tool coverage (4 tools) — czy wystarczy dla fundraise demo, czy należy rozszerzyć do 8 (dodać `gmail_archive`, `gmail_label`, `calendar_delete`, `calendar_update`)?
- Naming: `@modular-context/mcp-google-workspace` on npm — accept, or shorter `@modular-context/mcp-google`?
