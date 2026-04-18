# Google Workspace Integration — Plugin Side

Source for OAuth flow, token storage, onboarding UI, and MCP config generation.

Scaffolded 2026-04-17 by W1 Ralph (Foundation pack: `modular-context/_workspace/2026-04/w3/google-workspace/`).

## Subfolders

- `oauth/` — OAuth 2.0 desktop flow (PKCE, loopback server, orchestrator)
  - `flow.ts` — main entry `startOAuthFlow(config): Promise<StoredTokens>` (W1 Iter 4)
  - `loopback-server.ts` — tymczasowy HTTP server na callback (W1 Iter 3)
  - `pkce.ts` — S256 challenge generation (W1 Iter 3)

- `tokens/` — encrypted token storage
  - `storage.ts` — save/load/clear (W1 Iter 7)
  - `refresh.ts` — auto-refresh timer + access token getter (W1 Iter 8)

- `ui/` — UI components
  - `connect-google-modal.ts` — modal z 4 states (W1 Iter 10)

- `mcp-config/` — `.mcp.json` generation (W2+ only, folder stub for now)

## Architecture references

- [[adrs/ADR-001-oauth-strategy]] — Quick Connect + BYO
- [[adrs/ADR-002-token-storage]] — encryption mechanics
- [[adrs/ADR-003-mcp-server-lifecycle]] — MCP architecture (W2+)

Paths relative to: `modular-context/_workspace/2026-04/w3/google-workspace/`
