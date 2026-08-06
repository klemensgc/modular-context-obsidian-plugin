# Templates Manifest

Deterministic vault template bundled with the Modular Context standalone app (Electron). Used by the "Create new vault" onboarding flow.

## What the scaffold does

1. **Copies `vault/` verbatim** into the user's chosen vault directory (including `.claude/` and dotfiles like `.gitkeep`).
2. **Substitutes placeholders** in the copied files (currently only `{{LANGUAGE}}` in `vault/CLAUDE.md`).
3. **Generates project folders** from `project-index.md`: for each project the user names during onboarding, create `{{N}}_{{PROJECT_SLUG}}/{{N}}_{{PROJECT_SLUG}}_index.md` from the template, substituting all placeholders.
4. **Runs `git init`** in the vault root and creates the initial commit (subject suggestion: `Add: vault scaffold from Modular Context template`).

## Placeholders

| Placeholder | Where | Substituted with |
|-------------|-------|------------------|
| `{{LANGUAGE}}` | `vault/CLAUDE.md` | The user's chosen vault language (e.g. `English`, `Polish`). Default: `English`. |
| `{{PROJECT_NAME}}` | `project-index.md` | Human-readable project name, e.g. `Acme SaaS` |
| `{{PROJECT_SLUG}}` | `project-index.md` | kebab-case slug, e.g. `acme-saas` |
| `{{N}}` | `project-index.md` | Project number starting at 1 (`1_acme-saas/`, `2_side-hustle/`, ...) |

`project-index.md` is a generator template — it is NOT copied into the vault as-is.

## File tree

```
templates/
├── MANIFEST.md                     ← this file (not copied into vaults)
├── project-index.md                ← per-project index generator template
└── vault/                          ← copied verbatim on "Create new vault"
    ├── CLAUDE.md                   ← schema root ({{LANGUAGE}} placeholder)
    ├── .claude/
    │   ├── agents/                 ← 6 agents used by /process-transcripts
    │   │   ├── transcript-analyzer.md
    │   │   ├── module-scanner.md
    │   │   ├── consistency-checker.md
    │   │   ├── reweave-scanner.md
    │   │   ├── knowledge-weaver.md
    │   │   └── ceo-advisor.md      ← vault-owner advisor (filename kept: skills call it by name)
    │   └── commands/               ← 3 slash commands shipped with the scaffold
    │       ├── process-files.md    ← ingest for non-transcript files
    │       ├── synthesise.md       ← combined transcript + file backlog run
    │       └── decyzja.md          ← "Make the Call" → entry in _decisions-log.md
    ├── _claude/                    ← vault methodology (schema layer)
    │   ├── 1-standards/
    │   │   ├── frontmatter.md      ← type cascade, edit contracts, status enum, git-based staleness
    │   │   └── linking.md          ← wiki-link conventions
    │   ├── 2-templates/
    │   │   ├── file-standard.md    ← new wiki module template
    │   │   └── session-log.md      ← session log template (_claude/4-sessions/)
    │   └── 7-skill-references/
    │       ├── tagging-taxonomy.md ← prefix:value tags (grows with the vault)
    │       ├── category-routing.md ← 7 generic transcript categories → modules
    │       └── transcript-standards.md ← transcript formats A/B, pair convention
    ├── _transcripts/               ← raw sources layer (immutable)
    │   ├── transcripts_index.md    ← category map + counters
    │   ├── meetings/.gitkeep
    │   ├── product/.gitkeep
    │   ├── clients/.gitkeep
    │   ├── research/.gitkeep
    │   ├── strategy/.gitkeep
    │   ├── personal/.gitkeep
    │   └── other/.gitkeep
    ├── _transcripts-backlog/       ← ingest inbox
    │   └── sample-meeting.md       ← fictional weekly product sync (Brightbill) for the first ingest
    ├── _decisions-log.md           ← cross-project decision log (stub)
    └── _workspace/
        └── _workspace_index.md     ← ad-hoc deliverables conventions (stub)
```

## Design notes

- **Language:** all template content is English (EN-first product decision). `CLAUDE.md` carries `Repo language: {{LANGUAGE}}.` so agents respond in the user's language; tags stay English regardless.
- **Methodology canon (2.0):** the template matches the onboarding prompt in `packages/shared/src/skills/onboarding-prompt.ts`. 3 layers (RAW SOURCES → WIKI → SCHEMA) and 3 operations (INGEST / QUERY / LINT) are unchanged. What 2.0 replaced: the `cadence:` tiers are gone, and with them `depends-on:` and `audience:`. Frontmatter is `title/type/status/updated`; `type:` is mandatory in the wiki layer and drawn from a MECE cascade (`log → spotkanie → event → osoba → deal → modul`); staleness is computed from git history per type (hub 7d / `modul` 60 / `osoba` 180 / active `deal` 30), skipping commits with a `Meta: true` trailer.
- **`type:` is deliberately absent on non-entities.** The `_claude/` standards, the `.claude/` runtime config and the two folder maps (`_transcripts/transcripts_index.md`, `_workspace/_workspace_index.md`) ship with `title/status/updated` only. A declared type hands a file a staleness budget, which would put the vault's own rulebook on a 60-day clock. Do not "fix" this by adding types. `_transcripts-backlog/sample-meeting.md` is the counter-example that proves the rule: it *is* an entity, so it ships `type: spotkanie`.
- **Hubs are an explicit list, not a glob.** In this scaffold: `_decisions-log.md` plus every generated project index. The two index files in excluded trees (`_transcripts/`, `_workspace/`) are not hubs.
- **Agents are self-contained:** reweave-scanner and knowledge-weaver carry their trigger/scoring/relation-type definitions inline (the private vault's `reweave-standards.md` is not part of the minimal template).
- **Transcript categories:** 7 generic ones (`meetings/product/clients/research/strategy/personal/other`); `category-routing.md` instructs users to specialize the table as their projects grow.
- **Frontmatter date:** every vault `.md` (except `CLAUDE.md` and `.claude/`) ships with `updated: 2026-06-12`. Scaffold MAY rewrite this to the creation date — optional, not required for correctness.
- **No skills bundled here:** skills are distributed via the skills registry (`modular-context-skills` repo); the template only provides agents + schema the skills depend on.
