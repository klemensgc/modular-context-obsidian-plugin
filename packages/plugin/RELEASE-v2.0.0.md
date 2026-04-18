# v2.0 — Modular Context | Karpathy LLM Knowledge Base + Gmail & G-Cal

First stable release. Graduates v1.5 / v1.6 / v1.7 beta milestones into one production bundle.

**Two things in one plugin:**
1. **LLM Knowledge Base** — your Obsidian vault as LLM-native context (Sources → Wiki → Schema), multi-terminal Claude Code + Codex, skills sidebar.
2. **G-Suite MCP Server** — multi-account Gmail + Calendar as 10 native MCP tools for Claude Code. OAuth 2.0 desktop flow + PKCE, tokens encrypted via OS keychain, zero telemetry.

---

## Highlights

🧠 **LLM-native knowledge base** — Karpathy-aligned framing. Sources → Wiki → Schema wrapper for your vault.

📧 **10 MCP tools — Gmail + Calendar** — `gmail_search`, `gmail_send`, `gmail_draft`, `gmail_modify_labels`, `calendar_list_calendars`, `calendar_list_events`, `calendar_create_event`, `calendar_update_event`, `calendar_delete_event`, `calendar_freebusy`. Callable from any Claude Code session.

🔀 **Multi-account** — unlimited Google accounts in parallel. Each tool accepts optional `account` param; omit → primary.

🔐 **Local-first, encrypted** — tokens never leave your machine. `safeStorage` (OS keychain) for plugin storage; `0600` plaintext sidecar for MCP server (industry-standard pattern, matches `~/.aws/`, `~/.config/gcloud/`).

⚙️ **Zero telemetry** — no metrics, no crash reports, no external calls beyond OAuth + Google APIs.

🎯 **3 primary skills** post-onboarding: **Synthesise Files** (ingest raw files → vault), **WhatsApp Digest**, **Gmail + Calendar** (new playbook orchestrating 10 MCP tools).

🔁 **Smart Session Restore Picker** — no more silent auto-resume on plugin reopen. Modal classifies sessions (Needs attention / Idle / Archive), you choose what materializes. No accidental `/process-transcripts` re-runs, no hidden respawns.

📘 **5 ADRs** — architecture decisions documented (OAuth hybrid, token storage, MCP lifecycle + addendum, multi-account storage).

---

## Tools at a glance

| Gmail | Purpose |
|-------|---------|
| `gmail_search` | Query with native syntax (`is:unread`, `from:X`, `after:YYYY-MM-DD`). Optional body extraction. |
| `gmail_draft` | Create draft (not sent). User sends from Gmail UI. |
| `gmail_send` | Send immediately. |
| `gmail_modify_labels` | Archive/star/mark-read/unread + custom labels. |

| Calendar | Purpose |
|----------|---------|
| `calendar_list_calendars` | Enumerate all user calendars. |
| `calendar_list_events` | Events in time range. |
| `calendar_create_event` | Create (`sendUpdates: "none"` default). |
| `calendar_update_event` | Patch existing. |
| `calendar_delete_event` | Delete. |
| `calendar_freebusy` | Availability across calendars. |

---

## Install / Upgrade

### New users
1. Install plugin (BRAT or manual from release artifacts)
2. Enable in Obsidian Settings → Community plugins
3. Follow onboarding — 3 primary skills pre-checked
4. `Google Workspace: Connect` to attach your first account
5. Restart Claude Code session
6. Tool calls work from Claude Code prompts

### Upgrading from v1.x
1. Replace plugin files in `<vault>/.obsidian/plugins/modular-context/` (copy `main.js`, `styles.css`, `manifest.json`, `mcp-server.js`)
2. Reload plugin — **auto-migration runs** (legacy `tokens.enc` + `credentials.json` → multi-account layout, backwards-compatible)
3. Notice shows "Reconnect required for {email}" — run `Google Workspace: Reconnect (upgrade scopes)`
4. OAuth consent screen shows new scope set (`gmail.modify` + `calendar` full, replaces narrower pre-v2 scopes)
5. Restart Claude Code session

No data loss. Onboarding state persists; your primary skill list may look different — re-toggle via sidebar right-click if desired.

---

## Breaking changes (from v1.x)

1. **OAuth scopes expanded** — `gmail.readonly` + `gmail.send` → `gmail.modify`. `calendar.events` → `calendar` (full). Re-consent needed (plugin detects + prompts automatically).
2. **"Ingest Data" label renamed** to **"Synthesise Files"** (skill ID `process-transcripts` unchanged — state memory + references preserved).
3. **Primary skills reselected** — sidebar will show 3 new primary skills on first v2.0 load. User can customize via sidebar context menu.
4. **Plugin reopen no longer silent auto-resume** — previous versions restored ALL saved sessions automatically and re-fired their skill commands (risk: duplicate `/process-transcripts` runs). v2.0 shows a picker modal instead; unchecked sessions move to Archive bucket (preserved, not deleted).

See [CHANGELOG.md](CHANGELOG.md) for complete details.

---

## Architecture decisions

- **ADR-001** — OAuth Hybrid: Quick Connect (shared client, Testing mode <100 users) + BYO (user-provided unlimited). Avoids CASA cost for beta.
- **ADR-002** — Electron `safeStorage` over `@napi-rs/keyring` (esbuild can't bundle native bindings in plugin context).
- **ADR-003 + addendum** — MCP stdio transport + plaintext credentials sidecar (follows `gcloud`/`aws` CLI industry pattern).
- **ADR-005** — Multi-account storage: per-account folder + index, `emailToAccountFilename()` naming.

Full ADRs in repo under [`docs/adrs/`](../../docs/adrs/).

---

## What's next (v2.1 roadmap)

- **Tree-shake googleapis** — bundled binary 100MB → target <20MB
- **Embed mcp-server.js as base64** in main.js — BRAT auto-install no longer needs manual copy step
- **`gmail_reply` helper** — single-call reply (current workflow is search + draft-with-threadId)
- **`calendar_reschedule` helper** — shift single event or series
- **Skill registry web UI** — browse/install community skills without leaving Obsidian

---

## Known limitations

- Bundled MCP server ~100 MB (googleapis bloat — see v2.1 roadmap)
- BRAT auto-installer doesn't copy `mcp-server.js` — manual copy once (future: base64 embedding)
- CI `.github/workflows/build.yml` still references old branch name (`main`) — build check doesn't fire on PRs. Fix pending.
- Testing mode cap 100 users per OAuth client (Google's scope policy — unrelated to plugin)

---

## Full changelog

See [CHANGELOG.md](https://github.com/klemensgc/modular-context-obsidian-plugin/blob/master/packages/plugin/CHANGELOG.md).

## Links

- [README](https://github.com/klemensgc/modular-context-obsidian-plugin/blob/master/packages/plugin/README.md) — install + Connect Google walkthrough
- [Skills library](https://github.com/klemensgc/modular-context-skills) — separate repo, plugin auto-syncs
- [MCP spec](https://modelcontextprotocol.io/) — protocol Claude Code uses
- [Anthropic Claude Code docs](https://docs.anthropic.com/claude-code/)

---

**MIT** © klemensgc / receptionOS
