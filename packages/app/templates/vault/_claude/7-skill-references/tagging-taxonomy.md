---
title: Tagging Taxonomy — Transcripts
status: stable
updated: 2026-06-12
---

# Transcript Tagging Taxonomy

## Format

All tags use the format `prefix:value` (lowercase, no spaces in value, always English regardless of the transcript language).

This file is the single source of truth for allowed tags. It GROWS with the vault: when a new person, client, or vendor appears, the agent proposes the new tag in its report and the user approves adding it here.

---

## Prefixes and allowed values

### action: (what is happening)

| Tag | When to use |
|-----|------------|
| `action:planning` | Planning sessions, roadmapping, prioritization |
| `action:development` | Building, coding, sprints, releases |
| `action:sales` | Sales calls, demos, pricing, offers |
| `action:marketing` | Campaigns, content, social media, branding |
| `action:hiring` | Recruitment, interviews, onboarding people |
| `action:research` | Discovery, user interviews, market analysis |
| `action:operations` | Day-to-day operations, processes, logistics |
| `action:finance` | Budgets, invoicing, fundraising, accounting |
| `action:legal` | Contracts, compliance, regulations |
| `action:review` | Retrospectives, feedback sessions, audits |

Add new `action:` values sparingly — prefer the closest existing one.

### person: (who is in the conversation)

| Tag | Person | Role |
|-----|--------|------|
| _(empty — fill in as people appear)_ | | |

Convention: `person:firstname` if unique, `person:firstname-lastname` when ambiguous. Every speaker in a transcript gets a `person:` tag. Keep a one-line role description in this table.

### product: (which product/offering)

| Tag | Product |
|-----|---------|
| _(empty — fill in as products appear)_ | |

### client: (which client)

| Tag | Client | Context |
|-----|--------|---------|
| _(empty — fill in as clients appear)_ | | |

### vendor: (which vendor/supplier)

| Tag | Vendor | What it is |
|-----|--------|-----------|
| _(empty — fill in as vendors appear)_ | | |

### team: (which team/external group)

| Tag | Team | Context |
|-----|------|---------|
| _(empty — fill in as teams appear)_ | | |

---

## Tagging rules

1. **Minimum 2 tags** per transcript
2. **person:** for EVERY person who speaks in the transcript
3. **action:** based on the main topic of the conversation (can be more than one)
4. **product/client/vendor/team:** only when EXPLICITLY mentioned
5. **Do not invent tags ad hoc** — if a new one is needed, flag it in the report and ask the user to approve adding it to this file
6. **Do not duplicate** — if a transcript already has tags, verify and complete them (do not recreate)

Tags describe the transcript. They are not entity edges: a person who has a card in the people folder is linked from the summary's `uczestnicy:`, and `person:` tags stay a search convenience on top of that.

---

## Related

- [[category-routing]] — which folder and which modules a transcript routes to
- [[transcript-standards]] — transcript and summary formats
