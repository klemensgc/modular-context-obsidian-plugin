---
title: ADR-005 — Multi-Account Storage Model
updated: 2026-04-18
status: accepted
supersedes-section: ADR-003-addendum (single-account sidecar sections)
---
# ADR-005: Multi-Account Storage Model

## Context

Po W1/W2 plugin i MCP server obsługują pojedyncze konto (current: `apollo@receptionos.com`). User ma realistycznie 3+ konta Google Workspace (service account + personal + foundation) i chce móc wykonywać tool calls w kontekście wybranego konta — z defaultem na konto "primary" aby typowe zapytania działały bez explicit account.

ADR-003 addendum zdefiniował single-file sidecar `~/.modular-context/mcp-google/credentials.json`. Rozszerzenie na multi-account wymaga:

1. Filesystem layout — gdzie trzymać per-account credentials + index
2. Account identification — stable ID niezależny od email aliasów
3. Primary account resolution — który account jest defaultem dla tool calls bez `account` param
4. Tool API — jak plugin i MCP server komunikują wybór konta
5. Backwards compat — legacy single-account (apollo@) musi automigrować bez user friction
6. Scope coverage check — OAuth scope expansion wymaga reconnect dla istniejących accounts

## Decision

### Account identification

- **Canonical ID:** normalized email (`email.toLowerCase().trim()`)
- **Filesystem filename:** `emailToAccountFilename(email)` = replace `@` → `-at-`, `.` → `-`. E.g. `apollo@receptionos.com` → `apollo-at-receptionos-com`.
- **Why not SHA or UUID:** human-readable filenames easier to debug, account re-add doesn't change folder (same email → same filename). Collision risk negligible in practice (emails uniquely identify).
- **Collision strategy:** if filename exists with different email (edge case), append `-{6-char-hash}`. Document in README.

### Filesystem layout

**Plugin side** (encrypted, vault-local):
```
<vault>/.modular-context/
├── accounts/
│   ├── apollo-at-receptionos-com/
│   │   ├── tokens.enc            (Electron safeStorage)
│   │   └── meta.json             (email, connectedAt, scope, primary flag)
│   ├── k-at-receptionos-com/
│   │   └── ...
│   └── k-at-fundacjaedisona-pl/
│       └── ...
├── accounts-index.json           (AccountsIndex — single source of truth per vault)
└── .gitignore                    (blocks accounts/ + accounts-index.json)
```

**MCP side** (plaintext sidecar, user home):
```
~/.modular-context/mcp-google/
├── accounts/
│   ├── apollo-at-receptionos-com/
│   │   └── credentials.json      (plaintext SharedCredentials, 0600)
│   └── k-at-receptionos-com/
│       └── credentials.json
├── accounts-index.json           (mirror of plugin-side, MCP-readable format)
├── dist/index.js                 (server binary, installed by plugin)
├── logs/server.log
└── .gitignore                    (blocks accounts/ + accounts-index.json)
```

### AccountsIndex schema

```ts
interface AccountIndex {
  id: AccountId;              // email normalized
  email: string;              // display email (original case)
  filename: string;           // emailToAccountFilename(id) — for FS navigation
  scope: string;              // space-joined scopes the account was authorized with
  connectedAt: string;        // ISO 8601
  lastRefreshed?: string;     // ISO 8601 — updated on each successful refresh
  isPrimary: boolean;         // exactly one account has true (enforced by writer)
}

interface AccountsIndex {
  schemaVersion: 1;
  primaryAccount: AccountId | null;   // convenience — mirrors isPrimary across accounts[]
  accounts: AccountIndex[];
}
```

Writer invariant: exactly one account has `isPrimary: true` iff `accounts.length > 0`. `primaryAccount` field equals its `id` or `null`.

### Primary account selection

- First connected account → becomes primary
- User can explicitly re-assign via UI ("Set as primary" button in modal) or `google-workspace-set-primary` command
- If primary account disconnected + other accounts remain → first remaining becomes primary
- If all accounts disconnected → `primaryAccount: null`, index remains with empty `accounts: []`

### Tool API

Every MCP tool accepts optional `account: string` parameter (email, case-insensitive):
- If provided → server resolves to `AccountIndex.id` by lowercasing + exact match on `id`. Unknown email → error `ACCOUNT_NOT_FOUND`.
- If omitted → primary account. No primary + no `account` → error `TOKEN_MISSING` (analogous to "not connected").

Tools that span multiple accounts (e.g. hypothetical `email_search_all_accounts`) explicitly iterate — not part of W-full-control scope.

### .mcp.json env contract update

**Before (W2):**
```json
{
  "env": {
    "MC_CREDENTIALS_PATH": ".../credentials.json",
    "MC_LOG_PATH": "...",
    "MC_LOG_LEVEL": "INFO"
  }
}
```

**After (W-full-control):**
```json
{
  "env": {
    "MC_ACCOUNTS_DIR": "/Users/k/.modular-context/mcp-google/accounts",
    "MC_ACCOUNTS_INDEX": "/Users/k/.modular-context/mcp-google/accounts-index.json",
    "MC_LOG_PATH": "/Users/k/.modular-context/mcp-google/logs/server.log",
    "MC_LOG_LEVEL": "INFO"
  }
}
```

Server supports legacy fallback: if `MC_ACCOUNTS_DIR` + `MC_ACCOUNTS_INDEX` missing but `MC_CREDENTIALS_PATH` set → synthesize in-memory single-entry index from legacy sidecar. No write-back. Plugin's job to trigger migration flow.

### Backwards compat — legacy migration

**Trigger:** Plugin `onload` detects `vault/.modular-context/tokens.enc` (root-level, legacy) + no `accounts/` dir.

**Migration steps (plugin side):**
1. Load legacy tokens via existing `SafeStorageMethod` (plaintext JSON from safeStorage decrypt)
2. Derive `accountId` = tokens.accountEmail normalized
3. Create `accounts/{filename}/tokens.enc` by re-encrypting + writing (same schema), + `meta.json`
4. Write `accounts-index.json` with single account as primary
5. Delete legacy `tokens.enc` + `tokens.meta.json`
6. Also migrate MCP sidecar: move `~/.modular-context/mcp-google/credentials.json` → `accounts/{filename}/credentials.json`, write `accounts-index.json` on MCP side, update `.mcp.json`

**Failure handling:** any step fails → halt, leave legacy files intact, log warning. Migration re-attempts on next load. User can force reconnect as clean slate.

### Scope coverage enforcement

After multi-account is deployed, existing accounts may have OLD scopes (gmail.readonly + gmail.send + calendar.events). New default scope set includes `gmail.modify` + `calendar` instead. Plugin:

1. On plugin load + on each tool call via `getValidAccessToken`: compute `missingScopes = GOOGLE_WORKSPACE_SCOPES - tokens.scope.split(" ")`.
2. If missing scopes non-empty → return `null` from `getValidAccessToken` with error reason `SCOPE_OUTDATED`.
3. First time detected → show Notice: "OAuth scopes upgraded. Reconnect required for: {accountList}".
4. Reconnect button opens ConnectGoogleModal in "reauth" mode — banner explains new scopes, re-does OAuth flow with expanded set, overwrites account w index with updated scope string.

## Alternatives considered

| Option | Pros | Cons | Reason |
|--------|------|------|--------|
| **A. Single sidecar with accounts array** | Simpler FS layout (1 file) | Harder atomic writes, lock contention with MCP server, one write corrupts all accounts | Rejected — safer with per-account files |
| **B. Per-account sidecar + index (ACCEPTED)** | Atomic per-account writes, scale-friendly, clear FS layout | More files, slightly more complex readers | **ACCEPTED** |
| **C. SQLite DB for accounts** | Transactional, queryable | Native dep, esbuild bundling issues, overkill for <100 accounts | Rejected — files work |
| **D. Account ID = UUID** | Independent of email changes | Harder debugging, email is stable in practice | Rejected — readable filenames win |
| **E. All accounts in one encrypted blob** | Simpler to move | Race conditions with MCP server reads, one corruption = total loss | Rejected |

## Consequences

### Positive
- Clear growth path: add account → new folder, drop account → delete folder
- MCP server reads one account at a time — no partial state issues
- Each per-account write is atomic (file-level)
- Account emails visible in FS for debugging
- Scope tracking per-account (some accounts may grant narrower scopes if user chose)

### Negative
- More files per user (3 accounts = ~8 files total instead of 2)
- Migration code must handle legacy single-file layout (one-shot complexity)
- MCP server error taxonomy grows (`ACCOUNT_NOT_FOUND`, `SCOPE_OUTDATED`)
- Tool param `account` creates ambiguity if typo — error must be clear

### Mitigations
- Legacy migration is one-shot: after first successful migration, no further handling needed
- MCP server includes `accounts` list in init response so tool consumers can enumerate (future: TUI picker)
- README explains account param semantics with examples
- AskUserQuestion-style disambiguation on Disconnect command if multiple accounts

## References

- [ADR-002 token-storage] — safeStorage pattern, keeps encryption model
- [ADR-003 mcp-server-lifecycle] — stdio transport unchanged
- [ADR-003 addendum shared-state] — sidecar concept extended, not replaced
- [RFC 5321 SMTP §2.3.11](https://datatracker.ietf.org/doc/html/rfc5321#section-2.3.11) — email normalization rules for ID canonicalization
