---
title: ADR-004 — Skill Registry Integration
updated: 2026-04-17
status: accepted
---
# ADR-004: Skill Registry Integration — New `integration` type + `requires` dependencies

## Context

Plugin `modular-context` ma już działający `SkillRegistry` (main.ts:3200) który:
- Fetchuje `registry.json` z `modular-context-skills` GitHub repo
- Cache'uje 1h, fallback do persisted cache offline
- Install skills do `.claude/skills/{id}/SKILL.md` lub `.claude/commands/{id}.md` (dla `type: "command"`)
- OnboardingModal exposes skill picker z checkbox per skill, grupowane by `category`

Google Workspace wymaga:
1. **Parent "integration" skill** — google-workspace — który nie uruchamia agenta jednorazowego, ale initializuje persistent state (OAuth + MCP config)
2. **3 flagship skills** (daily-brief, inbox-triage, meeting-prep) które WYMAGAJĄ google-workspace być skonnected pierwszy
3. **Postinstall hook** — po installacji google-workspace, automatycznie uruchomić onboarding flow (nie tylko wgrać SKILL.md, ale też otworzyć Connect Google modal)
4. **Uninstall cleanup** — po usunięciu skill, revoke tokens + delete .mcp.json entry

Obecny schema registry (z Iteration 1 findings):
```json
{
  "id", "label", "description", "version", "category",
  "tier", "files", "size", "primary", "type?"
}
```

Brakuje: `requires: []`, `postInstall`, nowy `type: "integration"`.

## Decision

**Rozszerzyć registry.json schema o 3 nowe pola + 1 nowy type value:**

```typescript
interface RegistrySkill {
  // existing
  id: string;
  label: string;
  description: string;
  version: string;
  category: "analysis" | "creation" | "workflow" | "ideation" | "mining" | "automation" | "integration"; // NEW VALUE
  tier: "core" | "community";
  files: string[];
  size: string;
  primary: boolean;
  type?: "command" | "integration"; // NEW VALUE: "integration"
  
  // NEW FIELDS
  requires?: string[];       // array of skill IDs that must be installed first
  postInstall?: {
    action: "openModal" | "runCommand";
    target: string;          // modal name or command id
  };
  provides?: {
    mcpServers?: string[];   // names of MCP servers this skill adds to .mcp.json
    commands?: string[];     // Obsidian command ids registered by this skill
  };
}
```

### New registry entries dla google-workspace suite

```json
{
  "id": "google-workspace",
  "label": "Google Workspace",
  "description": "Connect Gmail + Calendar as Claude Code MCP tools. Local-first: your tokens never leave your machine.",
  "version": "1.0.0",
  "category": "integration",
  "tier": "core",
  "type": "integration",
  "files": ["SKILL.md", "references/troubleshooting.md"],
  "size": "16KB",
  "primary": true,
  "postInstall": {
    "action": "openModal",
    "target": "ConnectGoogleModal"
  },
  "provides": {
    "mcpServers": ["google-workspace"],
    "commands": [
      "google-workspace:connect",
      "google-workspace:disconnect",
      "google-workspace:status",
      "google-workspace:reconnect"
    ]
  }
},
{
  "id": "daily-brief",
  "label": "Daily Brief",
  "description": "Morning briefing: today's calendar + unread email digest + vault priorities.",
  "version": "1.0.0",
  "category": "workflow",
  "tier": "core",
  "files": ["SKILL.md"],
  "size": "8KB",
  "primary": false,
  "requires": ["google-workspace"]
},
{
  "id": "inbox-triage",
  "label": "Inbox Triage",
  "description": "Categorize unread emails by project (ROS, Apolonia, FTE), draft replies for top 3.",
  "version": "1.0.0",
  "category": "workflow",
  "tier": "core",
  "files": ["SKILL.md"],
  "size": "8KB",
  "primary": false,
  "requires": ["google-workspace"]
},
{
  "id": "meeting-prep",
  "label": "Meeting Prep",
  "description": "Pre-meeting briefing: attendees, vault context, relevant decisions and prior commitments.",
  "version": "1.0.0",
  "category": "workflow",
  "tier": "core",
  "files": ["SKILL.md"],
  "size": "8KB",
  "primary": false,
  "requires": ["google-workspace"]
}
```

### New SkillRegistry behavior

1. **On install of skill with `requires`:** check all deps are installed. Jeśli nie → install them first (cascading). Show Notice: "Installing google-workspace (required by daily-brief)..."
2. **On install of skill with `type: "integration"`:** after downloading files, execute `postInstall.action`. For `openModal` — open the named modal (TypeScript: switch statement w SkillRegistry że knows supported modals)
3. **On uninstall of skill with `type: "integration"`:** check reverse deps. Jeśli daily-brief/inbox-triage installed → block uninstall, show "Uninstall dependent skills first: [list]"
4. **On uninstall of `google-workspace` (after deps cleared):** call cleanup hook — `clearTokens()`, remove `.mcp.json` entry
5. **UI indicator:** w OnboardingModal skill picker, skille z `requires` są wyszarzone dopóki dep niezinstalowany. Hover tooltip: "Requires google-workspace"

## Alternatives considered

| Option | Pros | Cons | Reason |
|--------|------|------|--------|
| **A. No schema changes, google-workspace as plain skill** | Zero registry code changes | No way to express deps, no postInstall trigger → onboarding manual | Rejected — poor UX |
| **B. Schema changes only (`requires`, `postInstall`), same type** | Minimal surface | Mixing "real agent skills" with "integrations" in same category | Rejected — UI grouping harder |
| **C. Separate "Integrations" registry (different file)** | Clean separation | Double fetch, double cache, schema drift risk | Rejected — premature abstraction |
| **D. Schema changes + new `integration` type + category** | Clean categorization, future-proof (Notion, Slack, etc.) | Registry consumers (plugins) must handle new type | **ACCEPTED** — one-time cost |
| **E. Each flagship skill has own OAuth flow** | Independent skills | 3× duplicate onboarding + token storage per skill | Rejected — engineering hell |

## Consequences

### Positive
- **Extensible pattern** — future integrations (Notion, Slack, Linear, HubSpot) follow same pattern: `type: "integration"` + `category: "integration"` + `postInstall.openModal: "Connect{Service}Modal"`
- **Dependency resolution** — auto-install `google-workspace` when user installs `daily-brief` = smooth UX
- **UI clarity** — skille w `category: "integration"` wyświetlają się jako osobna sekcja w OnboardingModal picker: "Connect your accounts"
- **Cleanup safety** — can't remove integration while skills depend on it = prevents broken state
- **Backward-compat** — existing skills bez `requires` i `type` działają bez zmian (fields optional)

### Negative
- **Registry schema version bump** — registry.json `"version": "1.0.0"` → `"1.1.0"`. Plugins z old version fetch code nie rozumieją nowych fields (graceful fallback: treat as `category: "unknown"` + render but can't install)
- **SkillRegistry code growth** — new flows (cascade install, postInstall hook, block-uninstall) add ~200 LoC do main.ts (already monolith)
- **Modal registration** — `postInstall.openModal` wymaga że plugin knows modal names. Maintained jako registry w plugin code. Dodanie nowej integration = plugin update (nie tylko registry update)

### Mitigations
- **Schema versioning:** add `"registryVersion": "1.1.0"` header to registry.json. Plugin check: jeśli registry version > maxSupportedVersion → Notice "Plugin update available — some new skills might not install correctly" + skip unsupported entries
- **Modal registry in plugin:** explicit map `{ "ConnectGoogleModal": () => new ConnectGoogleModal(app).open() }` w `SkillRegistry.executePostInstall()`. Unknown modal name → skip + warn in console (not crash)
- **Testing:** explicit test case: install `daily-brief` → auto-installs `google-workspace` → opens ConnectGoogleModal → user cancels → daily-brief stays installed but not functional until reconnect
- **Documentation:** skill-creator SKILL.md updated with "Integration skills" section

## Implementation notes — changes needed

### Registry schema (modular-context-skills repo)
- Bump `registry.json` version → 1.1.0
- Add 4 new skills (google-workspace + 3 flagship)
- Add `registryVersion` field

### Plugin changes (packages/plugin/main.ts)
- Extend `RegistrySkill` interface — add optional `requires`, `postInstall`, `provides`
- `SkillRegistry.installSkill()` — pre-install check deps, cascade install
- `SkillRegistry.uninstallSkill()` — pre-uninstall check reverse deps, block or cascade cleanup
- New method `SkillRegistry.executePostInstall(skill)` — switch on action type
- New modal: `ConnectGoogleModal` (packages/plugin/src/google/ui/connect-google-modal.ts) — per ADR-002/003
- OnboardingModal: render `integration` category skills in separate section "Connect accounts"
- Commands registration per `provides.commands`

### skill files (modular-context-skills/core/*)
- `google-workspace/SKILL.md` — purpose, connect flow walkthrough, troubleshooting reference
- `google-workspace/references/troubleshooting.md` — Keychain denial, token expired, multi-account, BYO client
- `daily-brief/SKILL.md` — morning agenda skill (per spec in Iter 11)
- `inbox-triage/SKILL.md` — triage + draft skill (per spec in Iter 11)
- `meeting-prep/SKILL.md` — pre-meeting briefing skill (per spec in Iter 11)

### Docs
- `_claude/7-skill-references/` — new doc `integration-skills-pattern.md` documenting new schema for future integrations
- CLAUDE.md — add section about `/google-workspace` skill suite

## References

- [[../research/03-mcp-server-patterns]] — MCP server lifecycle (postInstall wiring)
- [[ADR-001-oauth-strategy]] — OAuth flow triggered by postInstall modal
- [[ADR-002-token-storage]] — cleanup hook on uninstall
- [[ADR-003-mcp-server-lifecycle]] — provides.mcpServers tied to this skill
- [[../specs/google-workspace-skill-spec]] — SKILL.md content (Iter 10)
- packages/plugin/main.ts:3200-3820 — current SkillRegistry source

## Open questions for user

- Registry version bump strategy: all-at-once (1.1.0 with 4 new skills + schema changes) or staged (1.0.1 schema only, 1.1.0 new skills)?
- Integration uninstall UX — block w tooltip ("Uninstall daily-brief first") czy cascade confirm ("This will also remove daily-brief, inbox-triage, meeting-prep. Continue?")?
- Primary skills tier: google-workspace = `primary: true` (checked by default w onboarding)? Pro: visibility. Con: forces CASA path conversation early. Rekomendacja: primary=true during beta (funnel do connect), re-evaluate post-launch.
