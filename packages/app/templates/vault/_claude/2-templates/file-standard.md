---
title: Template — Standard File
status: stable
updated: 2026-06-12
---

# Template: Standard Wiki Module

Use this template whenever you create a new module in the wiki layer.

Frontmatter requirements → [[../1-standards/frontmatter]]

A module is **living-state**: `## Stan` describes the present and gets rewritten in place. Dated entries are legal only inside `## Log`.

---

## Template

```markdown
---
title: [Title]
type: modul
status: draft
updated: [YYYY-MM-DD]
# owner: "[[osoby/person-slug]]"   ← optional. Uncomment ONLY once that card exists.
---

# [Title]

## TL;DR

- **[Key point 1]**
- **[Key point 2]**
- **[Key point 3]**

---

## Stan

[The present state of this topic, written as fact. Rewrite this section in place
as reality changes — do not append updates to it. Numbers that live in another
system are pointers: `12 (as of YYYY-MM-DD, canon: <system of record>)`.]

---

## [Section]

[Content]

---

## Related Modules
[OPTIONAL]

- [[related-file-1]] — [relation]
- [[related-file-2]] — [relation]

---

## Log
[OPTIONAL — the only place dated entries are allowed]

- **YYYY-MM-DD** — [what changed and why it mattered]
```

---

## Guidelines

1. **TL;DR** — always at the top, 3-5 bullet points
2. **Stan** — the living core of the module; rewritten, never appended to
3. **Log** — the only section where dates may appear as headings or bullet prefixes
4. **Sections** — separated by `---` for readability
5. **Frontmatter** — required: `title`, `type`, `status`, `updated`. Never `cadence`, `depends-on`, `audience`, and never `sources` outside a transcript summary
6. **Links** — use wiki-links `[[]]`; every entity with its own file gets a link; person edges go in frontmatter and point at the people folder. `owner:` is commented out in the template on purpose: the scaffold ships no people folder, and an edge to a card that does not exist is a dangling link, which is worse than no edge at all. Write the card first, then uncomment
7. **After creating** — add the new file to the project's `{folder}_index.md`

## Other types

This template is for `type: modul`. For the write-once types the shape is different:

- `spotkanie` → the transcript + summary pair, see [[../7-skill-references/transcript-standards]]
- `log` → [[session-log]]
- `event` → a single file in `_events/YYYY/` named `YYYY-MM-DD-{kind}-{slug}.md`, describing one dated change to one entity (`dotyczy:`), written once and left alone

If a file has no durable owner — nobody will edit it after the task ends — it is not a module at all. It belongs in `_workspace/{YYYY-MM}/wN/`.
