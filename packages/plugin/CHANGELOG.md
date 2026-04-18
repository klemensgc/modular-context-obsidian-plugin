# Changelog

## v1.5.0-beta (unreleased) — Google Workspace W1 (OAuth + Storage + UI)

First release of Google Workspace integration foundation. OAuth flow + encrypted token storage + onboarding UI. MCP server (W2) and flagship skills (W3) coming next.

### Added
- **OAuth 2.0 desktop flow** (RFC 8252 + RFC 7636 PKCE S256)
  - Loopback HTTP server on ephemeral port for callback
  - PKCE challenge generation
  - State parameter CSRF protection
  - Dual-path: Quick Connect (shared client, Testing mode, <100 users) + Bring Your Own OAuth client (unlimited)
  - Opens browser via Electron `shell.openExternal`
  - 2-min timeout handling
  - Friendly error pages rendered to browser
- **Token storage** — encrypted at rest
  - Electron `safeStorage` (OS keychain backed: macOS Keychain, Windows DPAPI, Linux libsecret)
  - Files: `vault/.modular-context/tokens.enc` + `tokens.meta.json`
  - Auto-generated `.gitignore` prevents token commits
  - Schema versioning for future migrations
- **Token refresh** — proactive 50-min background timer
  - Auto-refreshes when <5min to expiry
  - Handles `invalid_grant` (revoked/rotated refresh token) gracefully
  - Startup check on plugin load
- **ConnectGoogleModal** — 4-state onboarding UI
  - States: disconnected / connecting / connected / error
  - Scope disclosure (expandable)
  - Quick Connect primary button
  - BYO advanced section with Client ID/Secret inputs
  - Trust messaging ("Your tokens never leave your machine")
- **4 Obsidian commands**
  - `Google Workspace: Connect`
  - `Google Workspace: Disconnect`
  - `Google Workspace: Reconnect`
  - `Google Workspace: Status`
- **OnboardingModal section** — "Connect accounts" added with Google Workspace entry + status pill

### Technical
- New package deps: `googleapis`, `google-auth-library`
- Build-time env inject via esbuild `define` (reads `packages/plugin/.env.local`)
- 6 new source files: `src/google/oauth/{pkce,loopback-server,flow}.ts`, `src/google/tokens/{storage,refresh}.ts`, `src/google/ui/connect-google-modal.ts`
- Shared types in `packages/shared/src/google/types.ts`
- CSS: ~270 lines of `mc-connect-google-*`, `mc-connection-state-*`, `mc-byo-section` classes

### Required post-release (user actions)
- Create Google Cloud OAuth client (type: Desktop app) — see Foundation pack `_workspace/2026-04/w3/google-workspace/adrs/ADR-001-oauth-strategy.md`
- Copy Client ID + Secret into `packages/plugin/.env.local` (gitignored)
- Rebuild: `cd packages/plugin && npm run build`
- Copy `main.js`, `manifest.json`, `styles.css` to `.obsidian/plugins/modular-context/`
- Reload plugin in Obsidian
- Integration test: Connect flow, token persistence, disconnect

### Known limitations
- MCP server not yet implemented (W2 scope)
- Flagship skills (daily-brief, inbox-triage, meeting-prep) not yet implemented (W3 scope)
- Linux without libsecret/keyring daemon: safeStorage may be unavailable
- BYO walkthrough reference (with screenshots) not yet published — see Foundation pack for now

### Breaking changes
None.

## v1.4.7 — Universal Drag-and-Drop + Auto-Mode UX
(Prior release. See GitHub releases for history.)
