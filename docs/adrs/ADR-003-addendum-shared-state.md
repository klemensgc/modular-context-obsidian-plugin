---
title: ADR-003 Addendum — Shared-State Protocol (MCP Server ↔ Plugin)
updated: 2026-04-18
status: accepted
supersedes-section: ADR-003 section "Server reads tokens from disk"
---
# ADR-003 Addendum — Shared-State Protocol after W1 safeStorage pivot

## Context

ADR-003 (2026-04-17) zakładał:

> Server reads tokens.enc on every tool call, decrypts using keyring key (via env-provided service+account names)

To assumption miało sense przy oryginalnym ADR-002 który używał `@napi-rs/keyring` jako primary storage (shared native API accessible zarówno z Electron plugin jak i plain Node).

**W1 pivot (2026-04-17):** `@napi-rs/keyring` nie dał się zbundlować w esbuild (native binding per-platform requires). Przeszliśmy na Electron `safeStorage` API → `tokens.enc` jest teraz encrypted przez **Electron-only** API (`safeStorage.encryptString/decryptString`).

**Konsekwencja:** MCP server spawned przez Claude Code biegnie w **plain Node** (no Electron). Nie może wywołać `safeStorage.decryptString()`. Oryginalny plan "server reads tokens.enc" **nie działa**.

## Decision

**Option B — Plaintext credentials sidecar.** Plugin zapisuje osobny plik `~/.modular-context/mcp-google/credentials.json` z `0600` perms (user-readable-only). MCP server reads, refreshes access_token on demand via `google-auth-library`, używa w API calls.

### Sidecar format

```json
{
  "clientId": "...googleusercontent.com",
  "clientSecret": "GOCSPX-...",
  "refreshToken": "1//...",
  "accessToken": "ya29.a0...",
  "accessTokenExpiresAt": "2026-04-18T14:30:00.000Z",
  "accountEmail": "apollo@receptionos.com",
  "scope": "openid email profile https://...gmail.readonly ...",
  "writtenAt": "2026-04-18T13:40:00.000Z",
  "writtenBy": "plugin-v1.6.0-beta"
}
```

### Lifecycle

**Plugin-side:**
1. OAuth success → `saveTokens(tokens)` zapisuje `tokens.enc` (encrypted, vault) AND `syncCredentialsSidecar(tokens)` zapisuje `credentials.json` (plaintext, `~/.modular-context/mcp-google/`).
2. Refresh timer (50min) → po udanym refresh, rewrite both tokens.enc i credentials.json.
3. Disconnect → delete tokens.enc AND credentials.json (zero residual state).

**MCP server-side:**
1. On each tool call: `fs.readFileSync(process.env.MC_CREDENTIALS_PATH)` → JSON.parse → check expiry.
2. If `accessTokenExpiresAt` < `now + 5min`: refresh via `google-auth-library`'s `OAuth2Client.refreshAccessToken()` using `clientId + clientSecret + refreshToken`. Write back updated credentials to sidecar (with lockfile lub accept race with plugin — plugin's refreshTimer also updates; last-write-wins is benign bo oba używają tego samego refresh_token).
3. If `invalid_grant` error → return MCP error `TOKEN_EXPIRED` z message "Reconnect via plugin required".
4. Server NIGDY nie czyta tokens.enc z vault.

## Security analysis

### What's in the sidecar
- `refreshToken` — long-lived, Google-issued (valid aż do revoke lub 6mo idle)
- `clientSecret` — OAuth client secret (RFC 8252: not truly secret dla desktop apps; zembeddowany tak w plugin build)
- `accessToken` — short-lived (60min), refreshable
- Account metadata (email, scopes)

### Threat model
- **At-rest** (disk read): Protected by:
  - `0600` file perms (user-only read)
  - Folder location: `~/.modular-context/` (user's home, nie shared)
  - macOS FileVault (if enabled) encrypts wszystko on-disk
  - Linux: disk encryption per user setup
- **In-transit** (process → API): HTTPS to Google (googleapis library default)
- **Process-level** (other local procs reading): Blocked by 0600 + user-scope
- **Backup leakage**: folder `~/.modular-context/` SHOULD be excluded z user backups (Time Machine nie excluduje by default — dokumentować w README troubleshooting)

### Industry precedents (comparable plaintext credentials)
- `~/.aws/credentials` — AWS CLI, plaintext, 0600
- `~/.config/gcloud/application_default_credentials.json` — gcloud SDK, plaintext, 0600
- `~/.ssh/id_ed25519` — private SSH key, plaintext (chyba że passphrase-protected)
- `~/.netrc` — HTTP credentials, plaintext
- `.env` files — standardowa praktyka dla dev secrets

### Why not stronger?

**Evaluated Option A (keyring parallel):**
- Plugin spawnuje child process z `@napi-rs/keyring` binary matching current platform przy connect.
- Pros: refresh_token nigdy na dysku w plaintext.
- Cons: (a) plugin musi shipować platform-specific binaries, (b) child process error handling nontrivial, (c) marginal security gain over 0600 + FileVault + user-scope.
- **Rejected**: implementation cost > security benefit dla beta/fundraise.

**Evaluated Option C (HTTP bridge):**
- Plugin exposuje localhost:PORT/token endpoint z short-lived tokens.
- Pros: plugin single-source-of-truth.
- Cons: Plugin MUSI być running when Claude Code uses tools (breaks async workflow). DNS rebinding attack surface. Port allocation coordination.
- **Rejected**: UX breakage (plugin availability dependency).

## v2 hardening roadmap

Post-fundraise improvements (kiedy uzasadniają effort):

1. **Encrypted sidecar** — encrypt credentials.json via `@napi-rs/keyring`-derived key. Plugin and MCP server both bundle platform-specific keyring binaries. Requires solving original esbuild bundling challenge (potentially switch to `pkg` lub `caxa` dla MCP server binary distribution).
2. **Short-lived access tokens only** — sidecar ma TYLKO access_token + expires_at. MCP server nie może refreshować self. Plugin MUST be running i refreshować via timer. Returns do UX concern z Option C ale z file-based sync zamiast HTTP.
3. **Biometric unlock** — user auth required dla sidecar access (Touch ID on macOS via `@napi-rs/keyring`'s biometric feature).

## Updated `.mcp.json` schema

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "node",
      "args": [
        "/Users/{user}/.modular-context/mcp-google/dist/index.js"
      ],
      "env": {
        "MC_CREDENTIALS_PATH": "/Users/{user}/.modular-context/mcp-google/credentials.json",
        "MC_LOG_PATH": "/Users/{user}/.modular-context/mcp-google/logs/server.log",
        "MC_LOG_LEVEL": "INFO"
      }
    }
  }
}
```

**Removed:** `MC_TOKENS_PATH`, `MC_TOKENS_META_PATH`, `MC_KEYRING_SERVICE`, `MC_KEYRING_ACCOUNT` (keyring approach abandoned).

**Added:** `MC_CREDENTIALS_PATH` (sidecar), `MC_LOG_LEVEL`.

## Updated architecture diagram

```
┌──────────────────────────────────────────────────────────────┐
│ VAULT ROOT                                                   │
│ ~/Desktop/all-transcripts/modular-context/                   │
│                                                              │
│  ├─ .mcp.json ◀──── plugin writes on Connect                 │
│  │                                                           │
│  └─ .modular-context/                                        │
│      ├─ tokens.enc (Electron safeStorage, plugin-only)       │
│      ├─ tokens.meta.json                                     │
│      └─ .gitignore                                           │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│ USER HOME                                                    │
│ ~/.modular-context/mcp-google/                               │
│                                                              │
│  ├─ dist/index.js (MCP server binary, installed by plugin)   │
│  ├─ credentials.json (0600, plugin writes, server reads)     │
│  └─ logs/server.log (server writes)                          │
└──────────────────────────────────────────────────────────────┘

              ┌─────────────────────────┐
              │ Obsidian Plugin         │
              │ (safeStorage, Electron) │
              └──┬──────────────────────┘
                 │
                 │ 1. OAuth success/refresh
                 ├──▶ writes tokens.enc (vault)
                 └──▶ writes credentials.json (~/.modular-context/)

              ┌─────────────────────────────────┐
              │ Claude Code                     │
              │ (reads .mcp.json, spawns server)│
              └──┬──────────────────────────────┘
                 │
              ┌──▼──────────────────────┐
              │ MCP Server (plain Node) │
              │                         │
              │ Per tool call:          │
              │  • read credentials.json│
              │  • refresh if expired   │
              │  • call googleapis      │
              │  • return MCP response  │
              └─────────────────────────┘
```

## Consequences

### Positive
- Simple implementation (no native bindings, no bundling headaches)
- MCP server self-sufficient (no plugin-running dependency)
- Familiar pattern dla anyone używającego gcloud / AWS CLI
- Hot reload: plugin writes → server next call sees nowe credentials (zero coordination)

### Negative
- `refresh_token` w plaintext na disku — mitigated przez 0600 + user-scope + FileVault
- Sidecar + tokens.enc = 2 places gdzie tokens żyją (plugin-side, slight bloat)
- User musi być świadomy: nie pushuj `~/.modular-context/` do backups without excluding, nie shareuj home folder

### Mitigations
- README w `packages/mcp-google/` ma sekcję "Security notes" z list of what's plaintext + recommendation dla backup exclusion
- Plugin command `google-workspace:show-credentials-location` → reveals path w user's file manager dla audit
- `~/.modular-context/.gitignore` auto-generated dla case gdyby ktoś `git init`'ował tam
- v2 roadmap (above) pokazuje upgrade path gdy beta wymaga

## Implementation notes dla W2 Ralph

- **Plugin side** (nowy kod w packages/plugin/src/google/):
  - `mcp-config/credentials-sidecar.ts` — write/delete sidecar, permission handling
  - `mcp-config/generator.ts` — .mcp.json writer
  - `mcp-config/installer.ts` — server dist copy do ~/.modular-context/mcp-google/
  - Hooks w main.ts: Connect → write sidecar + install server + write mcp.json. Refresh timer callback → rewrite sidecar. Disconnect → delete sidecar + delete .mcp.json entry.

- **MCP server side** (packages/mcp-google/src/):
  - `auth/token-loader.ts` — readFileSync(MC_CREDENTIALS_PATH), JSON.parse, expiry check, refresh via `google-auth-library`, writeFileSync back. Atomic write (tmp + rename) żeby uniknąć partial state gdyby plugin też pisze jednocześnie.
  - Race handling: concurrent refreshes (plugin timer + server per-call) są OK bo oba używają tego samego refresh_token. Google Google może rotować refresh_token — last-write-wins jest benign (pierwsze rotate invalid-grant'uje drugie, ale drugie dostanie świeży refresh response).

- **Error mapping:**
  - `ENOENT` na credentials.json → `TOKEN_MISSING` (user musi connect via plugin)
  - JSON parse error → `TOKEN_INVALID` (corrupted, user disconnect+reconnect)
  - Refresh 400 `invalid_grant` → `TOKEN_EXPIRED` (reconnect required — Google rewiduje refresh)
  - Google API 401 post-refresh → `TOKEN_EXPIRED` (same path)
  - 429 → `RATE_LIMITED`
  - 5xx → `NETWORK_ERROR` (transient)

## References

- [[ADR-002-token-storage]] (superseded dla MCP server path by this addendum)
- [[ADR-003-mcp-server-lifecycle]] (base doc — tokens-on-disk section replaced)
- [OAuth 2.0 for Native Apps RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252) — desktop secret handling
- [google-auth-library OAuth2Client](https://github.com/googleapis/google-auth-library-nodejs) — refresh flow
