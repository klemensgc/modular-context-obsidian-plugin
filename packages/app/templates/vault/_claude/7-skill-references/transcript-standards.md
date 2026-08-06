---
title: Transcript Standards — Formats and Conventions
status: stable
updated: 2026-06-12
---

# Transcript Standards

Transcripts are the RAW SOURCES layer: immutable input. The LLM reads them, never modifies their content. Only frontmatter/tags may be added during processing.

A transcript and its summary are `type: spotkanie` — **write-once**. You do not revise them later; corrections happen in the modules the transcript fed, not in the record of what was said. `sources:` lives here and only here: in the `-summary.md` file.

**Participants:** `uczestnicy:` is a typed edge — every value must be a wiki-link resolving to a card in the people folder. A speaker who has no card yet goes into `uczestnicy-nierozpoznani:` as plain text, and moves to `uczestnicy:` the day their card is created. Never point `uczestnicy:` at a name that has no file.

In a freshly scaffolded vault there is no people folder, so **every** speaker lands in `uczestnicy-nierozpoznani:` — that is what the sample transcript in `_transcripts-backlog/` shows, and it is the correct starting state, not a bug. The typed graph starts working the moment you create the first card. Practical rule: after an ingest, whoever appears in a third transcript gets a card, and their name moves from the unresolved field to `uczestnicy:` in every summary that mentions them. The transcript itself is write-once — resolve names in the `-summary.md`, never by rewriting the record.

## Two coexisting formats

### Format A: With YAML frontmatter + tags

```yaml
---
title: "Conversation title"
type: spotkanie
status: stable
category: meetings
date: 2026-06-10
uczestnicy: "[[osoby/alex-doe]], [[osoby/sam-roe]]"
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

**Summary:** the summary always gets frontmatter, even when the transcript has none —

```markdown
---
title: "Conversation title — Summary"
type: spotkanie
status: stable
updated: 2026-06-10
sources: "[[_transcripts/meetings/conversation-title]]"
uczestnicy: "[[osoby/alex-doe]], [[osoby/sam-roe]]"
---

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

---

## Related

- [[category-routing]] — which folder and which modules a transcript routes to
- [[tagging-taxonomy]] — allowed tags
