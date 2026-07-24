# CLAUDE.md

This file teaches Claude Code how to work with this repository.

Repo language: {{LANGUAGE}}. Respond in the repo language.

This is NOT a code repo. It is a personal knowledge base — an **LLM Wiki**. The human curates sources and asks questions; the LLM writes and maintains the wiki. The editor is the IDE, the LLM is the programmer, the wiki is the codebase.

---

## 1. How this vault works

**Three layers:**

1. **RAW SOURCES** — `_transcripts/` (categorized) + `_transcripts-backlog/` (inbox). Immutable. Read, never modify.
2. **THE WIKI** — numbered project folders (`1_project/`, `2_project/`, ...). Each has a `{folder}_index.md` as its navigation hub. Modules are interlinked markdown files.
3. **THE SCHEMA** — this file + `_claude/` (standards, templates, agent references).

**Three operations:**

- **INGEST** — drop a source in `_transcripts-backlog/`, process it: categorize, summarize, update modules across the wiki.
- **QUERY** — answer questions from wiki pages. Good answers get filed back as new or updated pages.
- **LINT** — health-check: contradictions, stale claims, orphan pages, missing cross-references.

**Key files:**

| File | Role |
|------|------|
| `{N}_{project}/{N}_{project}_index.md` | Entry point per project — map of all modules |
| `_decisions-log.md` | Cross-project decision log |
| `_transcripts/transcripts_index.md` | Source categories + counters |
| `_workspace/_workspace_index.md` | Ad-hoc deliverables workspace |

---

## 2. Hard rules

- **DO NOT** create files without asking
- **DO NOT** commit without explicit approval
- **DO NOT** edit a file you have not read in this session
- **DO NOT** guess when information is missing — ask
- **DO NOT** ignore frontmatter (`updated`, `depends-on`, `status`)
- **DO NOT** assume the repo is current — check `updated:` dates
- **DO NOT** pick a side when sources disagree — show both versions, ask the user

---

## 3. Navigation — how to find anything

1. Identify the project the question belongs to
2. Open `{folder}_index.md` — the map with links to all modules
3. Follow `depends-on:` in frontmatter → related files
4. Follow wiki-links `[[name]]` in content → dependent topics
5. If a module is stale or missing data → search `_transcripts/{category}/`

**Cadence tiers** (expected update frequency): hot = 7 days, tactical = 30 days, iron-cold = 60 days, frozen = never flag as stale. Staleness ratio = days_since_update / cadence_days; ratio > 1.0 means the file is overdue.

---

## 4. Workflows

### A. User asks about a topic
Navigate (section 3). Read index → modules → transcripts if needed.

### B. User drops a transcript
1. Categorize into a `_transcripts/` folder (see `_claude/7-skill-references/category-routing.md`)
2. Create `{name}-summary.md` next to the transcript
3. Propose module updates (which files, what changes, why)
4. **Wait for confirmation before editing**

### C. User asks to update a file
1. **Read the file BEFORE editing**
2. Check `depends-on:` — do related files need changes too?
3. Propose the change, then after approval: edit + update `updated:` in frontmatter

### D. Processing the transcript backlog
1. Check `_transcripts-backlog/` for waiting files
2. Categorize each into `_transcripts/{category}/`
3. **Safety check:** compare `updated:` and `sources:` in target modules — never overwrite fresher data
4. Mine new information only — do not duplicate what modules already say
5. Move processed files backlog → `_transcripts/{category}/`
6. Update `_transcripts/transcripts_index.md` counters

### E. Ending a session
1. If >3 files modified → create a session log (`_claude/4-sessions/YYYY-MM/`, template: `_claude/2-templates/session-log.md`)
2. Verify `updated:` in all modified files
3. Propose a commit (never commit without approval)

---

## 5. Inconsistency protocol

While reading files, actively look for:

- Contradictions between files
- `updated:` dates past their cadence window (staleness ratio > 1.0)
- `status: needs-update` or `status: stub`
- Topics mentioned without a `[[wiki-link]]`
- Language that sounds outdated ("we plan to..." about something likely done)

**When you find an inconsistency → STOP:**
1. Show the user both versions: "File A says X, file B says Y"
2. Ask which is current
3. Fix the source file **first**, then continue the task

---

## 6. Formatting standards

### Frontmatter (every .md file)

```yaml
---
title: File name                # required
updated: 2026-06-12             # required, YYYY-MM-DD, ALWAYS bump after editing
status: stable                  # required: stable | draft | needs-update | active | stub | archive
cadence: tactical               # required: hot | tactical | iron-cold | frozen
sources: "[[transcript-name]]"  # optional, wiki-links to raw sources
depends-on: "[[related-file]]"  # optional, wiki-links
---
```

### Wiki-links

```markdown
[[file-name]]            # basic link
[[file-name|alias]]      # with alias
[[folder/file]]          # full path — ALWAYS for cross-project links and in index files
```

### Naming

- **Files:** `kebab-case.md`
- **Indexes:** `{folder}_index.md`
- **Transcripts:** `{title}.md` + `{title}-summary.md` (always a pair)
- **Workspace:** `_workspace/{YYYY-MM}/wN/name.md` (wN = week of month)

### Commits

Types: `Add:` (new file), `Update:` (content change), `Fix:` (correction), `Refactor:` (reorganization), `Remove:` (deletion). Never use `--force`, `--hard`, `--no-verify`, or `--amend` without explicit approval.

---

## 7. Tools in `_claude/` and `.claude/`

**`.claude/`** = Claude Code runtime config (agents, skills). **`_claude/`** = vault methodology.

| You need | Read |
|----------|------|
| Frontmatter and linking rules | `_claude/1-standards/` |
| New file template | `_claude/2-templates/file-standard.md` |
| Session log template | `_claude/2-templates/session-log.md` |
| Transcript tagging taxonomy | `_claude/7-skill-references/tagging-taxonomy.md` |
| Category → module routing | `_claude/7-skill-references/category-routing.md` |
| Transcript formats | `_claude/7-skill-references/transcript-standards.md` |
| Agents | `.claude/agents/` (transcript-analyzer, module-scanner, consistency-checker, reweave-scanner, knowledge-weaver, ceo-advisor) |
