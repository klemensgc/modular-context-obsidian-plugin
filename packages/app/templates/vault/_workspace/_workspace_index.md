---
title: Workspace Index
status: stable
updated: 2026-06-12
---

# Workspace Index

`_workspace/` holds ad-hoc deliverables — one-shot documents, drafts, exports, generated files. Things you produce FROM the wiki, not the wiki itself.

**Conventions:**

- Path: `_workspace/{YYYY-MM}/wN/name.md` — wN = week of the month (w1: days 1-7, w2: 8-14, w3: 15-21, w4: 22-31)
- A deliverable with more than 2 files → its own subfolder (`wN/deliverable-name/`)
- Versions: `name-v2.md`, `name-v3.md`
- "Deliverable" is not a type of its own. A file in a `wN/` folder is typed `log` by the cascade — write-once, and outside staleness anyway, because the whole `_workspace/` tree is excluded. Deliverables are outputs, not maintained knowledge
- This index is the exception in the folder: it is a folder map, not a deliverable and not an entity, so it carries no `type:` at all (see `_claude/1-standards/frontmatter.md`)
- If a deliverable produces durable knowledge → promote it to a wiki module (`type: modul`) and link it from the project index

**The test for where a new file belongs:** will anyone edit it after this task ends? No → `_workspace/`. Yes → it is an entity, give it a `type:` and its proper home.

---

## Active deliverables

_(Empty. List month folders and notable deliverables here as they appear.)_
