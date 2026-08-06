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

**Key files** (a navigation map — not the hub list, which section 3 defines separately):

| File | Role | Layer |
|------|------|-------|
| `{N}_{project}/{N}_{project}_index.md` | Entry point per project — map of all modules | wiki |
| `_decisions-log.md` | Cross-project decision log | wiki |
| `_transcripts/transcripts_index.md` | Source categories + counters | sources |
| `_workspace/_workspace_index.md` | Ad-hoc deliverables workspace | neither |

---

## 2. Hard rules

- **DO NOT** create files without asking
- **DO NOT** commit without explicit approval
- **DO NOT** edit a file you have not read in this session
- **DO NOT** guess when information is missing — ask
- **DO NOT** create a file in the wiki layer without a `type:` — it is mandatory (section 6)
- **DO NOT** compute freshness from `updated:` — freshness comes from git (section 3)
- **DO NOT** date-stamp content outside a `## Log` section — no `(2026-06-12: ...)` inline notes, no `## Change History`
- **DO NOT** write operational numbers as bare facts — they are pointers (section 6)
- **DO NOT** pick a side when sources disagree — show both versions, ask the user

---

## 3. Navigation — how to find anything

1. Identify the project the question belongs to
2. Open `{folder}_index.md` — the map with links to all modules
3. Follow the entity edges in frontmatter (`owner:`, `osoby:`, `uczestnicy:`, `dotyczy:`) → the people and entities involved
4. Follow wiki-links `[[name]]` in content → dependent topics
5. If a module is stale or missing data → search `_transcripts/{category}/`

**Freshness comes from git, never from frontmatter.** A file's last real change is the last commit touching it, **skipping commits that carry the `Meta: true` trailer** — mechanical batches (sweeps, renames, lint fixes) do not refresh knowledge. `updated:` is a stamped field, not a signal you compute with.

Staleness budgets: **hub 7 days**, `modul` 60 days, `osoba` 180 days, `deal` 30 days (only inside `_sales/pipeline/active/`; deals outside it carry no budget). The hub budget beats the type budget. `staleness_ratio = days_since_last_non-Meta_commit / budget_days`; ratio > 1.0 means overdue.

**Hubs** are an explicit list, not a glob. This vault ships two kinds: `_decisions-log.md` and every project index `{N}_{project}/{N}_{project}_index.md`. Extend the list by hand as the vault grows — a file is a hub because its staleness is worth a daily alarm, not because of where it sits.

Outside staleness entirely: `spotkanie`, `event`, `log`, anything with `status: archive`, and the trees `_claude/`, `.claude/`, `_transcripts/`, `_transcripts-backlog/`, `_workspace/`. Those trees hold either write-once entities (transcripts) or files that are not entities at all and therefore carry no `type:` (section 6) — neither gets a budget. That is also why `_transcripts/transcripts_index.md` and `_workspace/_workspace_index.md` are not hubs despite being index files: they are folder maps, not wiki entry points.

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
2. Check the neighbors — wiki-links out, backlinks in, entity edges — do they need changes too?
3. Propose the change, then after approval: edit
4. Respect the file's edit contract: **living-state** (`modul`, `osoba`) — weave the new fact into `## Stan`, put dated entries only in `## Log`. **Write-once** (`spotkanie`, `event`, `log`) — do not rewrite; if the record was wrong, write a new one.

### D. Processing the transcript backlog
1. Check `_transcripts-backlog/` for waiting files
2. Categorize each into `_transcripts/{category}/`
3. **Safety check:** compare the transcript's date with the target module's last real change (git) — never overwrite fresher data
4. Mine new information only — do not duplicate what modules already say
5. Move processed files backlog → `_transcripts/{category}/`
6. Update `_transcripts/transcripts_index.md` counters

### E. Ending a session
1. If >3 files modified → create a session log (`_claude/4-sessions/YYYY-MM/`, template: `_claude/2-templates/session-log.md`)
2. Verify every modified file still satisfies its edit contract (dated entries only in `## Log`, write-once entities untouched)
3. Propose a commit (never commit without approval). A purely mechanical batch — sweep, rename, lint fix — gets the `Meta: true` trailer in the commit body so it does not fake freshness

---

## 5. Inconsistency protocol

While reading files, actively look for:

- Contradictions between files
- Files past their staleness budget (ratio > 1.0, computed from git — section 3)
- `status: needs-update` that nobody addressed, or `status: draft` left standing for months
- Dated entries that leaked outside a `## Log` section
- Bare operational numbers where a pointer is required
- Topics mentioned without a `[[wiki-link]]`
- Language that sounds outdated ("we plan to..." about something likely done)

**When you find an inconsistency → STOP:**
1. Show the user both versions: "File A says X, file B says Y"
2. Ask which is current
3. Fix the source file **first**, then continue the task

---

## 6. Formatting standards

### Types — a MECE cascade (first match wins)

`log? → spotkanie? → event? → osoba? → deal? → modul`

| Type | Home | Edit contract |
|------|------|---------------|
| `modul` (default) | numbered project folders | living-state: `## Stan` holds the current truth, dated entries go only in `## Log` |
| `osoba` | one people folder, e.g. `osoby/` — the only legal target of `owner:` / `osoby:` / `uczestnicy:` edges | living-state |
| `deal` | `_sales/pipeline/active/` while open — the path the 30-day budget is keyed to | living-state while open, write-once after won/lost |
| `event` | `_events/YYYY/`, filename `YYYY-MM-DD-{kind}-{slug}.md` | write-once |
| `spotkanie` | `_transcripts/` — the pair `{title}.md` + `{title}-summary.md` | write-once |
| `log` | `_workspace/{YYYY-MM}/wN/`, `_claude/4-sessions/` | write-once |

**Deliverable** is not a type — it is what you produce, and it lands in `_workspace/{YYYY-MM}/wN/`, where the cascade types it `log`. A **view** is generated, not written by hand.

### Frontmatter (every .md file in the wiki layer)

```yaml
---
title: File name                 # required
type: modul                      # required: modul | osoba | spotkanie | event | deal | log
status: stable                   # required: stable | draft | needs-update | archive
updated: 2026-06-12              # stamped — see below, not a signal you compute with
owner: "[[osoby/alex-doe]]"      # optional entity edge — points into the people folder
osoby: "[[osoby/sam-roe]]"       # optional entity edge
uczestnicy: "[[osoby/sam-roe]]"  # optional entity edge — attendees of a meeting or event
dotyczy: "[[1_project/roadmap]]" # optional — what an event or deal is about
uczestnicy-nierozpoznani: Dana Ruiz (dana@atlas.example)   # plain text, NOT an edge
---
```

Those four edges (`owner:`, `osoby:`, `uczestnicy:`, `dotyczy:`) plus `[[wiki-links]]` in the body are the whole graph. Nothing else creates a relation — including `uczestnicy-nierozpoznani:`, which is deliberately untyped: it parks a speaker who has no card yet, as plain text, until one exists. A fresh vault has no people folder, so every attendee starts there; the first card you write is what turns those names into edges.

The people, pipeline and `_events/` folders do not ship with the scaffold — create one the first time you need it, and keep it as the single home for that type.

Fields that **do not exist** in this contract: `cadence:`, `depends-on:`, `audience:`. `sources:` exists in exactly one place — `_transcripts/**-summary.md`. A raw transcript is write-once: whatever frontmatter its exporter wrote stays as it is.

**A file that is not an entity carries no `type:` at all.** That absence is load-bearing — a declared type is what hands a file a staleness budget (section 3). It applies to the standards in `_claude/`, the runtime config in `.claude/`, and the two folder-map indexes `_transcripts/transcripts_index.md` and `_workspace/_workspace_index.md`. Entities inside those trees keep their type: a transcript and its summary are `type: spotkanie`, write-once, so no budget either way.

`updated:` is a stamp, not an argument. The intended setup is a pre-commit hook that writes it, so the field never lies; **the scaffold ships no hooks**, so until you install one, keep it current by hand and still read freshness from git (section 3).

### Writing facts

- A fact from a transcript is **woven into `## Stan`** of the module. No `(2026-06-12: ...)` inline notes, no `## Change History`, no `# 2026 update` blocks.
- A dated event that genuinely changes an entity → its own `event` file. If it changes nothing, the fact stays in the meeting summary.
- **Operational numbers are pointers, not facts.** Never "12 customers live". Write `12 (as of 2026-06-12, canon: <your CRM>)` — the vault points at the system of record instead of racing it.

### Enforcement

The contract is meant to be machine-checked in three lines — an editor hook while writing, a pre-commit hook before the commit lands, CI on push — where a FAIL blocks. **None of that is installed by the scaffold.** Until you wire it up, the contract is agent discipline: check it yourself before you claim a file is compliant.

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

A commit that changed no knowledge — a mass rename, a lint sweep, a formatting pass — carries the trailer `Meta: true` in its body. Freshness ignores those commits; without the trailer a sweep silently marks the whole vault as fresh.

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
