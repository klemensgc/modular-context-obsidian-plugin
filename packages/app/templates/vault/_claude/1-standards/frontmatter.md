---
title: Frontmatter Standard
updated: 2026-06-12
status: stable
cadence: frozen
---

# Frontmatter Standard

Every `.md` file in the wiki layer MUST start with YAML frontmatter. Frontmatter is how the vault stays self-healing: tools and agents read it to detect staleness, dependencies, and completeness.

---

## Required fields

```yaml
---
title: File name                # human-readable title
updated: 2026-06-12             # YYYY-MM-DD — ALWAYS bump after editing
status: stable                  # see allowed values below
cadence: tactical               # see cadence tiers below
---
```

## Optional fields

```yaml
---
sources: "[[transcript-1]], [[transcript-2]]"   # raw sources this file was built from
depends-on: "[[file-1]], [[file-2]]"            # files this one depends on
---
```

---

## Allowed `status:` values

| Status | Meaning | When to use |
|--------|---------|-------------|
| `stable` | Verified, safe to rely on | Default for finished files |
| `draft` | Needs review/completion | New, incomplete files |
| `needs-update` | Known to be outdated | Flagged for an update |
| `active` | Actively used/evolving | Playbooks, plans, trackers |
| `stub` | Placeholder, minimal content | Created to hold a link target |
| `archive` | Historical, kept for reference | Closed projects, past events |

---

## Cadence tiers (expected update frequency)

`status` describes the file's STATE. `cadence` describes how often the file SHOULD change. They are orthogonal — a file can be `status: stable` + `cadence: hot` (complete but needs weekly refresh).

| Tier | Stale after | Critically stale after | Typical files |
|------|-------------|------------------------|---------------|
| `hot` | 7 days | 14 days | Live trackers, weekly priorities, decision logs |
| `tactical` | 30 days | 60 days | Playbooks, processes, team docs, implementations |
| `iron-cold` | 60 days | 120 days | Vision, architecture, brand, legal |
| `frozen` | never | never | Archives, templates, reference material |

**Staleness formula:**

```
staleness_ratio = days_since_update / cadence_days
```

| Ratio | State | Action |
|-------|-------|--------|
| < 0.5 | Fresh | None |
| 0.5 – 1.0 | Aging | Awareness |
| 1.0 – 2.0 | Stale | Update this or next session |
| > 2.0 | Critically stale | Immediate attention |

**Discipline:** `hot` is ONLY for living hubs updated weekly. One-shot deliverables, finished onboardings, and reference material do NOT get `hot` — otherwise the staleness signal drowns in noise.

Defaults: if a file has no `cadence:`, treat it as `tactical` (30d). Index files default to `iron-cold`. The tier is changed MANUALLY by the user — never automatically.

Exempt folders: `_claude/`, `.claude/`, `_transcripts/`, `_workspace/` are tooling/raw layers — cadence checking does not apply there.

---

## Field formats

`depends-on:` and `sources:` always use wiki-links:

```yaml
# Good
depends-on: "[[vision]], [[1_project/subfolder/features]]"

# Bad
depends-on: [vision, features]
```

---

## Validation checklist

- [ ] Frontmatter wrapped in `---`?
- [ ] Has `title:`?
- [ ] Has `updated:` with today's date after an edit?
- [ ] Has `status:` with an allowed value?
- [ ] Has `cadence:` with an allowed value?
- [ ] `depends-on:` / `sources:` use `[[wiki-links]]`?

---

## Related

- [[linking]] — wiki-link conventions
- [[../2-templates/file-standard]] — new file template
