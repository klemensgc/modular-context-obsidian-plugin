---
title: Transcript Standards — Formats and Conventions
updated: 2026-06-12
status: stable
cadence: frozen
depends-on: "[[tagging-taxonomy]], [[category-routing]]"
---

# Transcript Standards

Transcripts are the RAW SOURCES layer: immutable input. The LLM reads them, never modifies their content. Only frontmatter/tags may be added during processing.

## Two coexisting formats

### Format A: With YAML frontmatter + tags

```yaml
---
title: "Conversation title"
category: meetings
date: 2026-06-10
type: transcript
tags:
  - action:planning
  - person:alex
---

**Alex Doe** (0:00): Spoken content.
**Sam Roe** (0:15): Next utterance.
```

Features: YAML frontmatter, `(m:ss)` timestamps, speaker in bold.
During processing: VERIFY existing tags, COMPLETE missing ones (never delete).

### Format B: Export without frontmatter (e.g. meeting-recorder exports)

**Transcript:**
```markdown
# Conversation title

**Date:** 2026-06-10T10:25:30.000Z
**Duration:** 45 minutes
**Attendees:** Full Name (email@example.com)

---

**Full Name** (0:00): Spoken content.
**null** (0:15): Content (speaker not recognized).
```

**Summary:**
```markdown
# Conversation title - Summary

**Date:** 2026-06-10
**Duration:** ~45 min

---

## Overview
[Conversation context]

## Key takeaways
- point 1
- point 2

## Action Items
- [ ] task — owner: person

## Tags
tag1, tag2, tag3
```

Features: no YAML, `(m:ss)` timestamps, loose "Tags" section in the summary.
During processing: REQUIRES full `prefix:value` tagging. The "Tags" section is only a hint.

---

## Naming conventions

- `{title}.md` — the full transcript
- `{title}-summary.md` — the summary (always create one if missing)
- After moving into a category folder → do NOT rename (keep the original name)

---

## Reading order

When analyzing, ALWAYS:
1. **Summary FIRST** — a 30-second overview
2. **Full transcript SECOND** — verification, details, quotes

---

## Validation

Before categorizing, check:
1. Is the file non-empty? (Duration 0, no content → flag as "empty")
2. Is it a pair? (look for the `-summary.md` file)
3. Is it a duplicate? (check `_transcripts/`)
4. Which format? (A with YAML or B without)
