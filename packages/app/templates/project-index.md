---
title: {{PROJECT_NAME}} — Index
type: modul
status: draft
updated: 2026-06-12
---

# {{PROJECT_NAME}}

Entry point for the **{{PROJECT_NAME}}** project. This index is the navigation hub: every module in `{{N}}_{{PROJECT_SLUG}}/` must be linked from here with a one-line description.

## Stan

_(One paragraph: what {{PROJECT_NAME}} is, what stage it is at, why it exists. Replace this placeholder during your first working session.)_

_This is the living-state section — rewrite it in place as reality changes. Dated entries belong in a `## Log` section, never here. Operational numbers are pointers: `12 (as of YYYY-MM-DD, canon: <system of record>)`._

---

## Module map

_(Empty — modules appear here as the wiki grows. Suggested starter structure:)_

### 1-overview
- _(e.g. `1-overview/vision.md` — where this project is going)_

### 2-operations
- _(e.g. `2-operations/processes.md` — how things get done)_

### 3-people
- _(e.g. `3-people/team.md` — who is involved)_

---

## Conventions

- Subfolders are numbered: `1-overview/`, `2-operations/`, ...
- Every new module: kebab-case filename, frontmatter with a mandatory `type:` and a `status:` from `stable | draft | needs-update | archive` ([[_claude/2-templates/file-standard|template]]), linked from this index
- This index is a hub: it holds the map and a short current state, not the content. When it outgrows that, the content moves into child modules
- Links inside this index use paths relative to `{{N}}_{{PROJECT_SLUG}}/`

## Related

- Raw sources: [[_transcripts/transcripts_index]]
- Cross-project decisions: [[_decisions-log]]
