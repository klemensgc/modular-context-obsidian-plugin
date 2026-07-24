---
title: Template — Standard File
updated: 2026-06-12
status: stable
cadence: frozen
depends-on: "[[../1-standards/frontmatter]]"
---

# Template: Standard Wiki Module

Use this template whenever you create a new module in the wiki layer.

Frontmatter requirements → [[../1-standards/frontmatter]]

---

## Template

```markdown
---
title: [Title]
updated: [YYYY-MM-DD]
status: [stable|draft|needs-update|active|stub|archive]
cadence: [hot|tactical|iron-cold|frozen]
sources: "[[transcript-if-any]]"
depends-on: "[[related-file]]"
---

# [Title]

## TL;DR

- **[Key point 1]**
- **[Key point 2]**
- **[Key point 3]**

---

## [Section 1]

[Content]

---

## [Section 2]

[Content]

---

## Related Modules
[OPTIONAL]

- [[related-file-1]] — [relation]
- [[related-file-2]] — [relation]

---

## Change History
[OPTIONAL — for important files]

- [YYYY-MM-DD]: [Change description]
```

---

## Guidelines

1. **TL;DR** — always at the top, 3-5 bullet points
2. **Sections** — separated by `---` for readability
3. **Frontmatter** — minimum: title, updated, status, cadence
4. **Links** — use wiki-links `[[]]`; every entity with its own file gets a link
5. **After creating** — add the new file to the project's `{folder}_index.md`
