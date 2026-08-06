---
title: Transcripts Index
status: stable
updated: 2026-06-12
---

# Transcripts Index

Raw sources layer. Transcripts are immutable — the LLM reads them, never modifies their content.

**Flow:** new files land in `_transcripts-backlog/` (the inbox) → processing categorizes them into a folder below → counters here get updated.

Every transcript lives as a **pair**: `{title}.md` (full transcript) + `{title}-summary.md` (summary). If the summary is missing, processing creates it.

---

## Categories

| Folder | Contents | Files |
|--------|----------|-------|
| `meetings/` | Team syncs, 1:1s, standups, internal meetings | 0 |
| `product/` | Features, sprints, architecture, roadmap discussions | 0 |
| `clients/` | Client calls, demos, sales conversations, deployments | 0 |
| `research/` | User interviews, discovery, market research | 0 |
| `strategy/` | Strategic planning, cross-project decisions | 0 |
| `personal/` | Personal notes, journaling, reflections | 0 |
| `other/` | Misc, uncategorizable, test recordings | 0 |

**Total: 0 transcripts** (update counters after every backlog processing run)

---

## References

- Routing rules: [[../_claude/7-skill-references/category-routing]]
- Formats and validation: [[../_claude/7-skill-references/transcript-standards]]
- Tagging: [[../_claude/7-skill-references/tagging-taxonomy]]
