# Google Workspace Integration — Plugin Side

Source for OAuth flow, multi-account token storage, onboarding UI, and MCP config generation.

Shipped in v2.0.0 (2026-04-18). See repo-level [docs/adrs/](../../../../docs/adrs/) for architecture decisions.

## Subfolders

- `oauth/` — OAuth 2.0 desktop flow (PKCE S256, ephemeral loopback server)
  - `flow.ts` — main entry `startOAuthFlow(config): Promise<StoredTokens>`
  - `loopback-server.ts` — temporary HTTP server for callback
  - `pkce.ts` — S256 challenge + verifier generation (RFC 7636)

- `tokens/` — multi-account encrypted token storage
  - `storage.ts` — `MultiAccountSafeStorage` (per-account encrypted files via Electron `safeStorage`)
  - `refresh.ts` — auto-refresh timer per account + `checkScopeCoverage` helper

- `ui/` — UI components
  - `connect-google-modal.ts` — modal with 4 states (disconnected/connecting/connected/error) + BYO path

- `mcp-config/` — MCP server integration
  - `credentials-sidecar.ts` — plaintext sidecar at `~/.modular-context/mcp-google/accounts/{id}/credentials.json`
  - `generator.ts` — writes `.mcp.json` in vault root
  - `installer.ts` — copies mcp-google `dist/index.js` to `~/.modular-context/mcp-google/dist/`
  - `mcp-sync.ts` — orchestrator (syncOnConnect/Refresh/Disconnect)

## Architecture references (repo-local)

- [ADR-001 — OAuth Strategy](../../../../docs/adrs/ADR-001-oauth-strategy.md) — Quick Connect + BYO hybrid
- [ADR-002 — Token Storage](../../../../docs/adrs/ADR-002-token-storage.md) — encryption mechanics (note: W1 pivoted to `safeStorage`)
- [ADR-003 — MCP Server Lifecycle](../../../../docs/adrs/ADR-003-mcp-server-lifecycle.md) — standalone package, stdio
- [ADR-003 addendum — Shared-State](../../../../docs/adrs/ADR-003-addendum-shared-state.md) — plaintext sidecar protocol
- [ADR-005 — Multi-Account Storage](../../../../docs/adrs/ADR-005-multi-account-storage.md) — per-account folder + index
