---
title: Frontmatter Standard
status: stable
updated: 2026-06-12
---

# Frontmatter Standard

Every `.md` file in the wiki layer MUST start with YAML frontmatter. Frontmatter is how the vault stays machine-readable: it declares what a file **is**, so tools and agents know which edit contract applies and which staleness budget to measure it against.

---

## Required fields

```yaml
---
title: File name       # human-readable title
type: modul            # modul | osoba | spotkanie | event | deal | log
status: stable         # stable | draft | needs-update | archive
updated: 2026-06-12    # YYYY-MM-DD — a stamp, not a freshness signal (see below)
---
```

`type:` is mandatory **in the wiki layer**. A new wiki file whose type cannot be decided is a broken file — decide the type or put the file in `_workspace/` instead.

**Files that are not entities carry no `type:` at all** — this document is one of them. A declared type is what hands a file a staleness budget, so typing the vault's own standards as `modul` would put the schema layer on a 60-day clock and report the rulebook as stale knowledge. Three groups qualify:

- the standards, templates and references in `_claude/`
- the runtime config in `.claude/` (agents, commands)
- the two folder-map indexes: `_transcripts/transcripts_index.md` and `_workspace/_workspace_index.md`

Everything else that lives in those trees and *is* an entity keeps its type. A transcript and its summary are `type: spotkanie` — write-once, so they carry no budget either way; that is why the sample transcript in `_transcripts-backlog/` ships fully typed while this file does not.

## Optional fields — entity edges

```yaml
---
owner: "[[osoby/alex-doe]]"        # who owns this
osoby: "[[osoby/sam-roe]]"         # people this file is about
uczestnicy: "[[osoby/alex-doe]]"   # participants of a meeting or event
dotyczy: "[[1_project/roadmap]]"   # what an event or deal concerns
uczestnicy-nierozpoznani: Dana Ruiz (dana@atlas.example)   # plain text, NOT an edge
---
```

The first four plus `[[wiki-links]]` in the body are the entire graph. Person edges always point at the people folder — never at a project module that happens to mention someone, and never at a name with no file behind it.

`uczestnicy-nierozpoznani:` is the escape hatch and is deliberately untyped: a speaker or attendee with no card is parked there as plain text and moves to `uczestnicy:` the day a card exists. A fresh vault has no people folder at all, so every attendee starts in that field — that is expected, not a defect. Creating the first person card is the move that converts those names into edges, and it is worth doing early for anyone who recurs.

## Fields that do not exist

`cadence:`, `depends-on:`, `audience:`. If you find them in a file, they are leftovers from an older contract — remove them.

`sources:` exists in exactly one place: `_transcripts/**-summary.md`. A module does not carry a `sources:` list; the link from summary to module is enough.

---

## The type cascade (first match wins)

`log? → spotkanie? → event? → osoba? → deal? → modul`

| Type | What it is | Edit contract |
|------|-----------|---------------|
| `modul` | A topic in the wiki — the default | **living-state** |
| `osoba` | A person's card | **living-state** |
| `deal` | An opportunity in the pipeline | living-state while open, write-once after won/lost |
| `event` | Something that happened on a date and changed an entity | **write-once** |
| `spotkanie` | A transcript + its summary | **write-once** |
| `log` | A session log, a workspace deliverable | **write-once** |

**Living-state** means the file describes the present. Current truth lives in `## Stan`; you rewrite it in place as reality changes. Dated entries are legal only inside a `## Log` section. No `## Change History`, no `(2026-06-12: ...)` notes bolted onto a paragraph.

**Write-once** means the file is a record of a moment. You do not rewrite it later — if it was wrong, write a new record.

---

## Allowed `status:` values

| Status | Meaning | When to use |
|--------|---------|-------------|
| `stable` | Verified, safe to rely on | Default for finished files |
| `draft` | Incomplete, not yet trustworthy | New files, placeholders, stubs |
| `needs-update` | Known to be outdated | Flagged for an update |
| `archive` | Historical, kept for reference | Closed projects, past initiatives |

Four values, nothing else. `active` and `stub` belonged to the older contract — a placeholder is `draft`, and a file being actively worked on is still just `stable` or `draft`.

`status: archive` puts a file outside staleness entirely.

---

## Freshness — read it from git, not from `updated:`

A file's last real change is **the last commit touching it, skipping commits that carry the `Meta: true` trailer**. Mechanical batches — sweeps, renames, lint fixes — do not refresh knowledge, and a batch committed without that trailer silently marks the whole vault as fresh.

`updated:` is meant to be stamped by a pre-commit hook so it can never disagree with git. **The vault scaffold ships no hooks**, so until you install one, keep the field current by hand and still compute freshness from git.

### Budgets per type

| Scope | Budget |
|-------|--------|
| Hub — `_decisions-log.md` and every project index `{N}_{project}/{N}_{project}_index.md` | 7 days |
| `modul` | 60 days |
| `osoba` | 180 days |
| `deal` in the active-pipeline folder | 30 days |

The hub budget beats the type budget. `deal` files outside the active folder carry no budget.

Hubs are an explicit list you maintain, not a glob over index files — `_transcripts/transcripts_index.md` and `_workspace/_workspace_index.md` are index files but not hubs, because their trees are excluded from staleness before any budget is looked up.

```
staleness_ratio = days_since_last_non-Meta_commit / budget_days
```

| Ratio | State | Action |
|-------|-------|--------|
| < 0.5 | Fresh | None |
| 0.5 – 1.0 | Aging | Awareness |
| 1.0 – 2.0 | Stale | Update this or next session |
| > 2.0 | Critically stale | Immediate attention |

### Out of scope

`spotkanie`, `event` and `log` are records of moments — they cannot go stale. Neither can anything with `status: archive`, nor the trees `_claude/`, `.claude/`, `_transcripts/`, `_transcripts-backlog/`, `_workspace/` — which is exactly why files in those trees carry no `type:` (see the top of this document).

---

## Operational numbers are pointers

A number that lives in another system (a CRM, a billing dashboard, a spreadsheet) is not a fact this vault owns. Never write "12 customers live". Write:

```
12 (as of 2026-06-12, canon: <name of the system of record>)
```

The vault stores the interpretation; the other system stores the number.

---

## Validation checklist

- [ ] Frontmatter wrapped in `---`?
- [ ] Has `title:`?
- [ ] Wiki-layer file: has `type:` from the allowed set? Outside the wiki layer: no `type:` at all?
- [ ] Has `status:` from the four-value enum?
- [ ] Has `updated:` as `YYYY-MM-DD`, and — with no hook installed — is it actually today's date on a file you just edited?
- [ ] No `cadence:` / `depends-on:` / `audience:`?
- [ ] No `sources:` outside `_transcripts/**-summary.md`?
- [ ] Dated entries confined to `## Log` (living-state files)?
- [ ] Entity edges use `[[wiki-links]]` into the people folder?

---

## Related

- [[linking]] — wiki-link conventions
- [[../2-templates/file-standard]] — new file template
