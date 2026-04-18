# v2.1.0 — Library UX + Skill Ratings + Prereqs

Skills repo graduated from flat registry to **curated library**. Plugin parses library metadata, evaluates prereqs before install. Full sidebar UI polish (grouping, stars, badges) lands in v2.1.1 — this release sets the foundation.

---

## Highlights

📚 **5 skill categories** — Capture / Analyze / Create / Maintain / Automate. Skills now categorized semantically instead of flat registry.

⭐ **Star ratings** — every skill rated 1-5 on polish + utility. Honest rubric documented in CONTRIBUTING.md.

🎯 **Difficulty + scope** — Learner / Operator / Expert × Universal / Native-MC. Know what you're installing.

🔒 **Prereq awareness** — each skill declares `requires[]` (other skill IDs or setup flags like `vault-structure`, `gsuite-connected`). Plugin has helpers in place — UI gating ships v2.1.1.

📖 **New skill: `skills-audit`** — scans your installed skills, detects eligibility gaps, motivates contribution. 4-bucket report (Installed / Eligible / Prereq-blocked / Aspirational).

👑 **Admin skill: `skill-validator`** — lives in maintainer's vault (not community). 5-layer validation: frontmatter, sections, MC methodology, rating sanity, security. Pre-PR quality gate.

📝 **CONTRIBUTING.md** — explicit standards for skill contributors. Frontmatter schema, required sections, MC methodology compliance checklist (8 items).

🤖 **CI validation** — `.github/workflows/validate-skills.yml` in skills repo. Soft-gates PRs with registry schema check, category/scope/difficulty value validation, broken reference detection.

🎛️ **G-Suite extended** — mcp-google parallel release v1.3.0 ships **25 MCP tools** (up from 10 in v2.0): Gmail (4), Calendar (6), Drive (4), Docs (3), Sheets (5), Slides (3). `gsuite-analysis` skill renamed to "Gmail + G-Suite" to reflect expansion.

---

## Skills library (23 skills)

### 📥 Capture (3) — ingest external data
process-transcripts 🟡, whatsapp-digest 🟡, xdaily

### 🔍 Analyze (7) — understand vault + external
pulse, vault-audit, graph, weekly-learnings, playscript, gsuite-analysis 🟡, skills-audit *(new)*

### ✏️ Create (5) — produce content
brief, ideas, copy, learned, tasklist

### 🧹 Maintain (4) — vault housekeeping
log, reweave, graduate, sync

### 🤖 Automate (4) — meta-tools + automation
ralph-prompt, ralph-factory, overnight, skill-creator

🟡 = primary (pre-checked in plugin onboarding)

---

## Install / Upgrade

### New users
1. Install plugin (BRAT or manual from release assets)
2. Enable in Settings → Community plugins
3. Follow onboarding — 3 primary skills pre-checked
4. Run `skills-audit` for recommendations on the rest

### Upgrading from v2.0.0
1. Replace plugin files in `<vault>/.obsidian/plugins/modular-context/`
2. Reload plugin — skill registry auto-refreshes with new metadata
3. No data migration needed — SkillDef extensions are optional
4. **If you re-authenticated Google in the past for v2.0 scopes:** consider another reconnect after mcp-google v1.3 ships (adds Drive/Docs/Sheets/Slides scopes). `Google Workspace: Status` will show `needs reconnect` if scopes outdated.

---

## What's in the two repos

**Plugin repo** (`klemensgc/modular-context-obsidian-plugin`):
- SkillDef interface extensions
- Hardcoded SKILLS fallback enriched (13 entries — offline-ready)
- Prereq check helpers (ready to wire into UI)
- Plugin version 2.1.0

**Skills repo** (`klemensgc/modular-context-skills`):
- Registry v2.0.0 (23 skills)
- New `skills-audit` skill
- CONTRIBUTING.md
- README full rewrite
- GitHub Actions validator

**Both need push.** See post-release checklist below.

---

## Breaking changes

None at plugin level. SkillDef extensions are optional — registries without them still parse.

**Skills registry schema bumped to v2.** Old plugin installs (pre-v2.1) will still work (ignore unknown fields). New metadata surfaces only in v2.1+.

---

## Known limitations

- **UI integration incomplete in v2.1.0** — sidebar grouping, star icons, prereq gating UI land in v2.1.1 patch. Current release is data model + helpers only. 
- **Prereq gating** — helpers exist (`checkSkillPrereqs`) but not yet wired into install button. v2.1.1.
- **Onboarding modal** — still shows flat 3-primary view. 5-category preview is v2.1.1.

---

## What's next (v2.1.1 — coming soon)

- Sidebar group rendering — skills grouped by category with section headers
- Star/difficulty/scope icons inline
- Install-flow prereq gating (disabled button + tooltip)
- Onboarding modal shows 5-category preview + promotes `skills-audit`

---

## Full changelog

[CHANGELOG.md](CHANGELOG.md) — v2.1.0 section.

---

## Links

- Skills library: https://github.com/klemensgc/modular-context-skills
- Contributing: https://github.com/klemensgc/modular-context-skills/blob/main/CONTRIBUTING.md
- Skills audit: run `skills-audit` in any Claude Code session

---

**MIT** © klemensgc / receptionOS
