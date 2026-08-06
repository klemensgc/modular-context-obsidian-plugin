---
title: Template — Session Log
status: stable
updated: 2026-06-12
---

# Template: Session Log

A session log is the chronological record of what happened in a working session — the vault's "log file". It is `type: log`: **write-once**. You write it at the end of the session and never edit it afterwards; the next session gets its own file. Logs carry no staleness budget.

## Naming convention

`session-YYYY-MM-DD-HH-MM.md`

Example: `session-2026-06-12-14-30.md`

Save in: `_claude/4-sessions/YYYY-MM/`

---

## Template

```markdown
---
title: Session - [YYYY-MM-DD HH:MM]
type: log
status: stable
updated: [YYYY-MM-DD]
files-modified: [count]
---

# Session [YYYY-MM-DD HH:MM]

## Request
[REQUIRED: What the user asked for — exact task description]

---

## Actions Taken

### [Time] - [Action]
- [Details of what was done]
- Files: `path/file.md`

### [Time] - [Next action]
- [Details]

---

## Modified Files

| File | Action | Reason |
|------|--------|--------|
| `path/file.md` | created | [short] |
| `path/file2.md` | updated | [short] |
| `path/file3.md` | deleted | [short] |

---

## Commits

- `[hash]` - [message]
- `[hash]` - [message]

---

## Open Issues
[OPTIONAL: Things that need attention in the future]

- [ ] [Issue 1]
- [ ] [Issue 2]

---

## Notes
[OPTIONAL: Observations, learnings, things to remember]

- [Observation 1]
- [Observation 2]
```

---

## When to create

- After every session where >3 files were modified
- After completing a plan
- When the user asks for documentation
