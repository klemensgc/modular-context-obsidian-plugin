---
title: Category Routing — Transcripts → Modules
updated: 2026-06-12
status: stable
cadence: frozen
depends-on: "[[tagging-taxonomy]], [[transcript-standards]]"
---

# Category Routing

Mapping: transcript category → folder in `_transcripts/` → target modules in the wiki.

The vault starts with 7 generic categories. As your projects grow, refine this table: split categories, add project-specific ones, and point each at the concrete index files and modules of YOUR projects.

---

## Categories

| Category | Folder | When to use | Target modules |
|----------|--------|-------------|----------------|
| `meetings` | `_transcripts/meetings/` | Team syncs, 1:1s, standups, internal meetings | Team docs, process docs, decision log |
| `product` | `_transcripts/product/` | Features, sprints, architecture, roadmap | `*/product/*`, roadmap, features, architecture modules |
| `clients` | `_transcripts/clients/` | Client calls, demos, sales, deployments | Pipeline/status modules, client implementation pages |
| `research` | `_transcripts/research/` | User interviews, discovery, market research | Market/competition modules, positioning, research synthesis |
| `strategy` | `_transcripts/strategy/` | Strategic planning, cross-project decisions | Strategy modules, `_decisions-log.md`, priorities |
| `personal` | `_transcripts/personal/` | Personal notes, journaling, reflections | Personal modules (if any) |
| `other` | `_transcripts/other/` | Misc, uncategorizable, test recordings | Manual assessment |

> **Customize:** once project folders exist (e.g. `1_myproject/`), replace the generic "Target modules" column with concrete paths — e.g. `1_myproject/1-product/roadmap.md`. The more concrete this table, the better the agents route.

---

## Tie-breaking heuristics

When a transcript fits multiple categories:

1. **Client + product in one call** → `clients` (the client matters more)
2. **Strategy of a single project** → that project's category, not `strategy`
3. **Hiring conversation** → `meetings` (team domain), unless you add a dedicated category
4. **Empty transcripts** (0 min, no content) → do not categorize, flag as "empty"
5. **Test recordings** → `other`
6. If still unsure → propose 2 options with reasoning and let the user decide

---

## Navigation algorithm to a target module

1. Determine the transcript category
2. Open the matching project index file (`{folder}_index.md`)
3. Read the module map from the index
4. Identify the specific module matching the topic
5. Read the module — check `updated:`, `sources:`, `depends-on:`
6. Assess whether the new info is relevant (not a duplicate)
