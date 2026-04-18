# Changelog

## v2.1.0 — 2026-04-18 — Library UX: categories + ratings + prereqs

Skills repo graduated from flat registry to curated library. Plugin now parses library metadata (stars, difficulty, scope, requires) and evaluates prereqs before skill install.

### Added
- **`SkillDef` interface extended** — optional fields: `stars`, `difficulty`, `value`, `scope`, `requires[]`, `category`. Backwards-compatible (old registries without these fields still work).
- **`evaluateSetupFlag(flag, app)`** — runtime check for setup prereqs: `vault-structure`, `gsuite-connected`, `whatsapp-macos`, `git-initialized`, `python3`.
- **`checkSkillPrereqs(skill, installed, app)`** — returns array of missing prereqs (skill IDs or setup flags).
- **`CATEGORY_META`** — 5 categories with icons: Capture 📥, Analyze 🔍, Create ✏️, Maintain 🧹, Automate 🤖.
- **Hardcoded SKILLS array enriched** — all 13 entries now have full library metadata (stars, difficulty, value, scope, requires, category). Fallback for offline / registry-unreachable scenarios.

### Skills repo changes (separate repo — `klemensgc/modular-context-skills`)
- Registry schema v2: 23 skills (added `skills-audit`), all with full metadata
- 5 categories replace old 6 — `analyze / capture / create / maintain / automate`
- Fixed `reweave` skill (missing folder caught by post-v2.0 audit)
- New `CONTRIBUTING.md` — standardisation checklist for contributors
- New `.github/workflows/validate-skills.yml` — CI validator (registry schema + folder presence + field validity)
- README full rewrite: bookshelf ASCII, legend, 5 category tables, Czarek onboarding, install/uninstall guide

### New skills
- **`skills-audit`** (community) — scan your installed skills, detect eligibility gaps, motivate contribution. 4-bucket report: Installed / Eligible / Prereq-blocked / Aspirational.
- **`skill-validator`** (admin-only, lives in maintainer's vault, NOT community) — quality gate for PR review + pre-publish check. 5-layer validation: frontmatter, sections, MC methodology, rating sanity, security anti-patterns.

### Coming in v2.1.1 (follow-up)
- Full sidebar UI integration — group rendering, star icons, difficulty badges, scope icons. Current v2.1.0 ships data model + helpers; UI polish is next patch.
- Install-flow prereq gating — button disabled + tooltip when requires[] unmet. Helpers in place; UI wiring pending.
- Onboarding modal 5-category preview + skills-audit promotion.

### Tied MCP server
- `mcp-google-workspace` parallel releases **v1.2.0** (Drive ×4 + Docs ×3) and **v1.3.0** (Sheets ×5 + Slides ×3). Total **25 tools** (up from 10 at v2.0.0) across Gmail, Calendar, Drive, Docs, Sheets, Slides.
- `GOOGLE_WORKSPACE_SCOPES` expanded 5 → 10 in `@mc/shared`: added `drive.file`, `drive.metadata.readonly`, `documents`, `spreadsheets`, `presentations`.
- `ConnectGoogleModal` scope disclosure copy updated to describe all 10 scopes (replaces stale v1.x copy referencing `gmail.readonly` / `calendar.events`).
- `installer.ts` `REQUIRED_SERVER_VERSION` bumped 1.1.0 → 1.3.0 — plugin auto-replaces `~/.modular-context/mcp-google/dist/index.js` on first load.
- gsuite-analysis skill label updated: "Gmail + Calendar" → "Gmail + G-Suite" (covers Docs/Drive/Sheets/Slides)

### Fixed
- **MCP sidecar desync (zombie account entries)** — plugin-side account index (`vault/.modular-context/accounts-index.json`) and server-side sidecar (`~/.modular-context/mcp-google/accounts-index.json`) could drift when accounts were added/removed outside normal modal flow. Resulted in `TOKEN_MISSING` errors for primary when actual credentials lived under a different account. Fix: new `reconcileMcpSidecar()` helper auto-runs after every `syncMcpOnConnect`, pruning orphans and aligning primary selection. Available as manual command `Google Workspace: Repair MCP sidecar (reconcile)` in command palette for existing broken states.
- **Primary account auto-fallback on disconnect** — verified and hardened. When primary is removed, next account in list is promoted (already in plugin-side `MultiAccountSafeStorage.removeAccount`, now mirrored to server-side via reconcile).

### Migration (for users upgrading from v2.0.0)
- **Re-authentication required to enable Drive/Docs/Sheets/Slides tools.** Run `Google Workspace: Status` after upgrade — accounts with old scopes show `needs reconnect (missing 5 scopes)`. Click Connect in modal; consent screen now requests all 10 scopes.
- **Enable Google Cloud APIs.** Users must enable Drive API, Docs API, Sheets API, and Slides API in their OAuth project (same project used for Gmail/Calendar v1.x). Tool calls return `PERMISSION_DENIED` with direct console links until enabled.
- **Existing sidecar desync self-heals on first Connect action post-upgrade** via `reconcileMcpSidecar`. If status command shows apollo@ / stale accounts, run `Google Workspace: Repair MCP sidecar` manually.

### Breaking changes
- **None** at plugin level. SkillDef extensions are optional.
- **Registry schema** is v2 (new version `2.0.0`). Old plugin versions will still parse it (they ignore unknown fields), but won't display new metadata.

---

## v2.0.0 — 2026-04-18 — Modular Context | Karpathy LLM Knowledge Base + Gmail & G-Cal

First stable release. Graduates v1.5 / v1.6 / v1.7 beta milestones into one production-ready bundle. New positioning: your Obsidian vault as LLM-native knowledge base + multi-account G-Suite MCP server for Claude Code.

### LLM Knowledge Base
- **3 primary skills post-onboarding** (was variable 2-4): `Synthesise Files`, `WhatsApp Digest`, `Gmail + Calendar`. Full-width in sidebar, pre-checked in onboarding modal. All others (Pulse, Brief, Log, Reweave, Graph, Graduate, Ideas, Vault-Audit) → secondary grid.
- **Skill rename**: "Ingest Data" → **"Synthesise Files"** (ID `process-transcripts` preserved for state-memory backwards compat). Description refreshed: "Synthesise raw files (transcripts, notes, backlog) into vault modules — categorizes, tags, updates, reweaves neighbors."
- **New skill `gsuite-analysis`** ("Gmail + Calendar") — dedicated SKILL.md orchestrating the 10 MCP tools with 4 playbook patterns: Morning Inbox Sweep, Stale Thread Follow-up, Calendar Gap Analysis, Meeting Prep. Multi-account aware. Writes insights to `_workspace/{YYYY-MM}/w{N}/` — never auto-sends.
- **Karpathy-aligned framing**: Sources → Wiki → Schema methodology made explicit in README architecture diagram. LLM-native knowledge base positioning.

### G-Suite MCP — 10 tools, multi-account, stable
- **4 Gmail tools**: `gmail_search`, `gmail_draft`, `gmail_send` (v2.0 new), `gmail_modify_labels` (v2.0 new — archive/star/mark-read + custom labels).
- **6 Calendar tools**: `calendar_list_events`, `calendar_create_event`, `calendar_list_calendars` (v2.0 new), `calendar_update_event` (v2.0 new), `calendar_delete_event` (v2.0 new), `calendar_freebusy` (v2.0 new).
- Every tool accepts optional `account` parameter (email). Omit → primary account.
- **Multi-account storage** — unlimited Google accounts in parallel. Per-account credentials sidecar at `~/.modular-context/mcp-google/accounts/{filename}/credentials.json`. Shared `accounts-index.json`.
- **OAuth**: hybrid Quick Connect (shared client, <100 users Testing mode) + BYO (user-provided client, unlimited). PKCE S256 desktop flow with ephemeral loopback redirect.
- **Token storage**: Electron `safeStorage` (macOS Keychain / Windows DPAPI / Linux libsecret). Auto-refresh timer every 50 min, 5-min expiry buffer.
- **Error taxonomy**: `TOKEN_MISSING`, `TOKEN_EXPIRED`, `TOKEN_INVALID`, `ACCOUNT_NOT_FOUND`, `SCOPE_OUTDATED`, `PERMISSION_DENIED`, `RATE_LIMITED`, `QUOTA_EXCEEDED`, `NETWORK_ERROR`, `UNKNOWN`.
- **`mcp-google-workspace`** package graduated **1.1.0-beta.1 → 1.1.0 stable**.

### Architecture
- **ADR-001** — Hybrid OAuth (Quick Connect + BYO) balancing beta quick-start with unlimited scaling post-CASA.
- **ADR-002** — Electron `safeStorage` over `@napi-rs/keyring` (esbuild bundling blockers).
- **ADR-003 + addendum** — MCP stdio transport + plaintext credentials sidecar (follows `~/.aws/`, `~/.config/gcloud/` industry pattern).
- **ADR-005** — Multi-account storage: per-account folder + canonical index + filename `emailToAccountFilename()`.

### Breaking changes (from v1.x)
- **OAuth scope upgrade** — `gmail.readonly` + `gmail.send` → `gmail.modify`. `calendar.events` → `calendar` (full). Plugin auto-detects scope mismatch on load, shows "Reconnect required" Notice. User runs `Google Workspace: Reconnect (upgrade scopes)`.
- **Primary skill re-selection** — if you already had an onboarded install, sidebar will show new primary set. Re-toggle any skill via sidebar context menu if you want the old layout.
- **Label rename "Ingest Data" → "Synthesise Files"** — UI-only, skill ID and behavior unchanged. State memory, stored workflow, and any references still work.

### Migration (automatic, no user action required)
- Legacy `vault/.modular-context/tokens.enc` (root-level) auto-migrates to `vault/.modular-context/accounts/{filename}/tokens.enc` on first v2.0 boot.
- Legacy `~/.modular-context/mcp-google/credentials.json` auto-migrates to `~/.modular-context/mcp-google/accounts/{filename}/credentials.json` + creates `accounts-index.json`.
- Migration logs to console; failures fail-soft (legacy files kept intact, retried next boot).

### Smart Session Restore Picker (v2.0 new)
- **Replaces silent auto-resume on plugin reopen.** Previously all saved sessions auto-restored and re-fired their skill command (risky: duplicate `/process-transcripts` runs, noisy re-spawns). Now a picker modal appears showing each prior session classified by:
  - **Needs attention** — agent was `working` / `to-review`, Claude TUI markers visible, or activity in last 30 min (pre-checked)
  - **Idle** — clean prompt (unchecked)
  - **Archive** — previously skipped (collapsed section)
- Each row shows glyph, skill name, reason badge, relative time, and last 4 buffer lines preview.
- `Skip all` → everything marked archived (preserved for future, not deleted). `Restore selected` → only checked items materialize.
- **Materialized sessions get a read-only preamble** with the previous buffer tail (`─── previous session tail ───`) — fresh PTY, user decides what to run. **No auto-replay of skill commands.**
- Snapshot capture: `onClose` + plugin `onunload` persist `{id, name, glyph, skillName, agentStatus, bufferTail[30], cwd, lastActivityAt, archived}` to plugin `saveData` (not workspace.json — keeps Obsidian layout file lean).

### Terminal & agents (stable from v1.x)
- Multi-terminal split layouts (1, 1×2, 2×1, 2×2, 2×3, 2×4) — up to 8 concurrent PTY sessions
- Claude Code + Codex provider toggle
- Session glyphs (12 geometric shapes) — skills inherit their icon
- Agent tracker — Working / To Review / Standby state machine
- Compact 48px sidebar mode + fullscreen overlay
- Wiki-link autocomplete in terminal (`[[`)
- Drag-and-drop files as shell-escaped paths
- Session persistence across restarts (now via smart restore picker — see above)

### Known limitations
- Bundled MCP server `mcp-server.js` is ~100MB (googleapis covers all APIs, not just Gmail/Calendar). Tree-shake candidate for v2.1.
- BRAT / Community Plugins auto-installer copies only `main.js` + `manifest.json` + `styles.css` — `mcp-server.js` must be copied manually once. v2.1 plan: embed as base64 + write-on-load (pty-helper pattern).
- No `gmail_reply` helper tool — reply workflow is 2 calls (search + draft with `replyToThreadId`). v2.1 candidate.
- No bulk operations (`gmail_archive_bulk`, `calendar_batch_*`). Iterate singles for now.
- CI workflow `branches: [main]` still references old branch name (history: renamed master on plugin repo). Build check doesn't fire on PR; fix pending.

### Required post-release (user, first v2.0 install)
1. Rebuild `packages/mcp-google` then `packages/plugin`
2. Copy `main.js` + `styles.css` + `manifest.json` + `mcp-server.js` to `<vault>/.obsidian/plugins/modular-context/`
3. Reload plugin — auto-migration runs
4. Notice appears: "Reconnect required for {email}" → run `Google Workspace: Reconnect (upgrade scopes)` → new OAuth consent screen shows expanded scope set
5. Add additional accounts via `Google Workspace: Add another account`
6. **Restart Claude Code session** — `.mcp.json` is read at session start
7. Test tool call from Claude Code prompt: "Search my emails in {account} for test"

---

## v1.7.0-beta (never released — graduated into v2.0.0) — Multi-account + full Gmail/Calendar control

Rozszerzenie MCP Google integracji o multiple accounts równolegle (do 100 na Testing mode) i 6 nowych tools dających pełną kontrolę nad skrzynką i kalendarzem.

### Added — MCP tools (6 nowych, total 10)
- **`gmail_send`** — wysyła maile (nie tylko draft). Uzupełnia `gmail_draft` dla workflow z review.
- **`gmail_modify_labels`** — archive/star/mark read/unread + custom labels (auto-resolved by name).
- **`calendar_list_calendars`** — enumerate wszystkich calendars z ich ID. Wymagane do operacji na non-primary.
- **`calendar_update_event`** — patch event (preserves unchanged fields).
- **`calendar_delete_event`** — usuwa event.
- **`calendar_freebusy`** — check availability windows (perfect do "find time to meet").

### Added — Multi-account
- Każde konto ma własny sidecar pod `~/.modular-context/mcp-google/accounts/{filename}/credentials.json`
- Każdy tool przyjmuje opcjonalny `account` parameter (email). Pominięcie → primary account.
- Plugin storage refactored na `MultiAccountSafeStorage` z per-account folderem + `accounts-index.json`
- New commands: `Add another account`, `Reconnect (upgrade scopes)`, enhanced `Status` pokazuje wszystkie konta + scope status

### Changed — OAuth scopes (BREAKING for existing accounts)
- `gmail.readonly` + `gmail.send` → **`gmail.modify`** (covers read + send + labels + archive + trash)
- `calendar.events` → **`calendar`** (full access, includes list-calendars + freebusy)
- OIDC (openid/email/profile) unchanged

### Migration
- Existing v1.6.0-beta install auto-migruje single-account layout na startup (`tokens.enc` root → `accounts/{filename}/tokens.enc`)
- Sidecar too: `~/.modular-context/mcp-google/credentials.json` → `accounts/{filename}/credentials.json` + new `accounts-index.json`
- **User action required:** Notice pokaże "Reconnect required" bo stary scope set nie obejmuje nowych tools. Command: `Google Workspace: Reconnect (upgrade scopes)`.

### Architecture (ADR-005)
- New doc: `docs/ADR-005-multi-account-storage.md` — full design rationale
- Alternatives considered (single blob / SQLite / UUID-based IDs) rejected

### Known limitations
- Bundled binary wciąż ~100MB (googleapis bloat) — treeshaking candidate for v1.8
- Concurrent refresh (plugin timer vs MCP server self-refresh per tool call) = last-write-wins, OK w praktyce
- No `gmail_archive_bulk` / `calendar_batch_*` tools — single operations only w tej wersji

### Required post-release (user)
1. Rebuild: `npm run build` w `packages/mcp-google`, potem `packages/plugin`
2. Copy artifacts: `cp packages/plugin/{main.js,styles.css,manifest.json,mcp-server.js} <vault>/.obsidian/plugins/modular-context/`
3. Reload plugin — auto-migration legacy sidecar
4. Notice pokaże "Reconnect required" → `Google Workspace: Reconnect (upgrade scopes)` → re-auth primary account z nowymi scopes
5. `Google Workspace: Add another account` → dodaj kolejne konta
6. **Restart Claude Code session** — picks up zaktualizowany `.mcp.json`
7. Test: `"Search emails in k@receptionos.com"`, `"List calendars I have access to"`, `"When am I free tomorrow?"`, `"Archive the latest newsletter"`, `"Delete the test event"`

---

## v1.6.0-beta (never released — graduated into v2.0.0) — Google Workspace W2 (MCP Server for Claude Code)

Ships standalone MCP server exposing Gmail + Calendar as native tools for Claude Code sessions. Plugin now writes `.mcp.json` automatically on Connect.

### Added
- **`@modular-context/mcp-google-workspace` package** (new `packages/mcp-google/`)
  - 4 tools: `gmail_search`, `gmail_draft`, `calendar_list_events`, `calendar_create_event`
  - MCP stdio transport (spawned by Claude Code via `.mcp.json`)
  - stderr + optional file logging with 10MB rotation, token-scrubbing redaction
  - Error taxonomy: TOKEN_MISSING / TOKEN_EXPIRED / RATE_LIMITED / PERMISSION_DENIED / NETWORK_ERROR / UNKNOWN
  - Single-file bundled binary with shebang, runs on plain Node 20+
- **Plugin MCP integration** (`packages/plugin/src/google/mcp-config/`)
  - Credentials sidecar: `~/.modular-context/mcp-google/credentials.json` (0600, user-scope)
  - Server install: copies bundled `mcp-server.js` to `~/.modular-context/mcp-google/dist/index.js` on Connect
  - `.mcp.json` generator: merges `google-workspace` entry, preserves other MCP servers
  - Refresh timer callback: re-syncs sidecar on token rotation
- **New command** `Google Workspace: Show MCP server logs` — opens `~/.modular-context/mcp-google/logs/server.log`

### Architecture change (ADR-003 addendum)
- Switched from "shared encrypted tokens.enc" model to plaintext credentials sidecar (industry-standard pattern like `~/.aws/credentials`, `~/.config/gcloud/`). Reason: W1 pivot to Electron `safeStorage` is Electron-only and MCP server runs in plain Node context. Full rationale + v2 hardening roadmap in `docs/ADR-003-addendum-shared-state.md`.

### Security
- Credentials sidecar contains `refresh_token` + `client_id/secret` (per RFC 8252 client_secret is not truly secret for desktop apps)
- Stored with `0600` permissions in user-scope folder, protected by FileVault if enabled
- MCP server never logs tokens, email bodies, or subject lines (scrubbing regex on all log lines)

### Breaking
- None at user level. Existing v1.5.0-beta installs: after upgrade, on next Connect the sidecar + `.mcp.json` will be written automatically.

### Known limitations
- MCP server binary is ~100MB (bundled googleapis). Disk cost one-time, runtime unaffected.
- Concurrent refresh between plugin timer and MCP server self-refresh is benign (same refresh token, last-write-wins on sidecar).
- No unit tests — runtime behavior validated via Claude Code integration flow.

### Required post-release (user)
1. Rebuild: `npm run build` in `packages/mcp-google`, then `packages/plugin`
2. Copy to vault: `cp packages/plugin/{main.js,styles.css,manifest.json,mcp-server.js} <vault>/.obsidian/plugins/modular-context/`
3. Reload plugin
4. Disconnect + Connect Google Workspace (to trigger MCP server install + `.mcp.json` write)
5. **Restart Claude Code session** so it picks up new `.mcp.json`
6. Test: "Search my email for X" in Claude Code prompt

---

## v1.5.0-beta (never released — graduated into v2.0.0) — Google Workspace W1 (OAuth + Storage + UI)

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
- Create Google Cloud OAuth client (type: Desktop app) — see [docs/adrs/ADR-001-oauth-strategy.md](../../docs/adrs/ADR-001-oauth-strategy.md)
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
