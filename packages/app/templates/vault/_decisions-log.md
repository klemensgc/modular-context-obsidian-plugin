---
title: Decisions Log
type: modul
status: stable
updated: 2026-06-12
---

# Decisions Log

Global cross-project decision log. Project-specific decisions live in the project's own modules; record here anything that spans projects or changes how the vault itself works.

This is the one hub whose whole job is dated entries, so they live in `## Log` below — the only section where dates are legal. Individual entries are append-only: a decision that gets reversed gets a new entry, it does not get edited away. Once a decision has consequences big enough to need their own record, promote it to an `event` file in `_events/YYYY/` and leave a one-line pointer here.

**Entry format** — entries are `###`, one level below `## Log`, so they nest inside it instead of ending it:

```markdown
### YYYY-MM-DD — [Decision title]

- **Decision:** [what was decided, one sentence]
- **Context:** [why — the situation that forced the decision]
- **Alternatives considered:** [what was rejected and why]
- **Owner:** [who made the call]
- **Source:** [[transcript-or-module]]
- **Revisit:** [date or "—"]
```

Newest entries at the top — a new entry goes directly under the `## Log` heading, above the previous `### YYYY-MM-DD` entry.

---

## Log

_(No decisions logged yet. Add the first one after your first transcript ingest.)_
