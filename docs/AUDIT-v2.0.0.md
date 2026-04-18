---
title: v2.0.0 Post-release audit
updated: 2026-04-18
status: active
scope: plugin repo (+ skills repo light check)
auditor: Ralph autonomous loop (ralph-plugin-repo-audit)
---
# v2.0.0 Audit

Post-release coherence + up-to-date sweep of `klemensgc/modular-context-obsidian-plugin` + `klemensgc/modular-context-skills` after v2.0.0 release on 2026-04-18.

## Executive summary

Repo is in **healthy state post-release**. Ralph audit found **7 yellow issues** (safe-fixable) and **3 red items** for user decision. All yellow fixes were applied in one commit. Reds are documented below — none block active usage but warrant decisions before v2.1.

---

## Green ✅ (verified correct)

| Area | Evidence |
|------|----------|
| Versions coherent | plugin 2.0.0 across manifest/package/versions.json/CHANGELOG/RELEASE; mcp-google 1.1.0 across package/CHANGELOG/index.ts |
| 10 MCP tools complete | Each of 10 tool source files has `reg()` registration in `packages/mcp-google/src/index.ts`; README table matches |
| 3 primary skills aligned | Plugin hardcoded SKILLS matches `modular-context-skills/registry.json`: process-transcripts, whatsapp-digest, gsuite-analysis |
| 6 plugin commands aligned | `google-workspace-{connect,add-account,disconnect,reconnect,status,show-logs}` registered and documented |
| CI workflows green | Latest Build Check + Release runs succeeded; workflows correctly point to `master` + per-workspace tsc |
| Release assets published | v2.0.0 GH release has main.js (2.85MB), manifest.json, mcp-server.js (105MB), styles.css |
| Security history clean | `main.js` + `mcp-server.js` removed from all git history (filter-repo); no secrets in committed source |
| .gitignore complete | main.js, packages/plugin/mcp-server.js, packages/mcp-google/dist/, .env.local, node_modules all covered |
| README top-level | Moved to repo root from packages/plugin/; renders as landing page; relative links to packages/*/CHANGELOG.md work |
| README banner | Moved to root, `![banner](banner.png)` reference valid |
| Zero open issues | `gh issue list` clean |

---

## Yellow ⚠️ (Ralph auto-fixed)

### 1. Stale `REQUIRED_SERVER_VERSION` in installer
- **File:** `packages/plugin/src/google/mcp-config/installer.ts:8`
- **Before:** `const REQUIRED_SERVER_VERSION = "1.0.0-beta.1";`
- **After:** `const REQUIRED_SERVER_VERSION = "1.1.0";`
- **Why:** mcp-google graduated to 1.1.0 stable; plugin's version check would otherwise always trigger reinstall (false-positive "outdated" detection)

### 2. CHANGELOG v2.0.0 "(unreleased)" marker
- **File:** `packages/plugin/CHANGELOG.md` heading
- **Before:** `## v2.0.0 (unreleased) — Modular Context | ...`
- **After:** `## v2.0.0 — 2026-04-18 — Modular Context | ...`
- **Why:** v2.0.0 IS released (tag exists, GH release published); "(unreleased)" misleading

### 3-5. ADR refs pointing at vault repo (invisible to public users)
- **Files:** `README.md:62`, `packages/plugin/RELEASE-v2.0.0.md:90`, `packages/plugin/CHANGELOG.md:212`
- **Before:** References `_workspace/2026-04/w3/google-workspace/adrs/` (paths in modular-context vault, NOT in plugin repo)
- **After:** References `docs/adrs/` (Ralph copied 6 ADRs to plugin repo) + converted text refs into clickable markdown links
- **Why:** Public users clone plugin repo → couldn't see ADRs; now ADRs ship with the code

### 6. `.env.example` documentation drift
- **File:** `packages/plugin/.env.example`
- **Before:** Listed OAuth scopes `gmail.readonly, gmail.send, calendar.events` (pre-v2 scopes); referenced `_workspace/...` paths
- **After:** Lists v2.0 scopes `gmail.modify, calendar, openid/email/profile`; links to `docs/adrs/ADR-001-oauth-strategy.md` + README walkthrough
- **Why:** v2.0 scope upgrade not reflected in the onboarding example file

### 7. `packages/plugin/src/google/README.md` stale references
- **File:** `packages/plugin/src/google/README.md`
- **Before:** Described subfolders as "W1 Iter 4" / "W2+ only, folder stub for now" (pre-release language); referenced vault Foundation pack paths
- **After:** Describes shipped v2.0.0 state; all ADR references use repo-local `../../../../docs/adrs/` relative paths
- **Why:** File was written mid-W1 development; didn't reflect shipped state

### 8. Missing `core/reweave/` in skills library (broken install path)
- **Found:** `registry.json` has entry for `reweave` but `core/reweave/` folder doesn't exist — plugin attempting to install reweave skill would 404 on GitHub fetch
- **Fix:** Copied `.claude/commands/reweave.md` from vault → `modular-context-skills/core/reweave/COMMAND.md`; updated registry entry `files: ["COMMAND.md"]` + added `"type": "command"` (matches process-transcripts pattern)
- **Why:** Reweave skill was planned/registered but its source file was never committed to skills repo; user clicking the skill would hit 404

---

## Red ⛔ (user decision needed)

### R1 — ADR-002 pivot not reflected in ADR body

**Observed:** `docs/adrs/ADR-002-token-storage.md` says "@napi-rs/keyring + AES-256-GCM" as the accepted approach. During W1 implementation the project pivoted to Electron `safeStorage` because `@napi-rs/keyring` native bindings can't be bundled by esbuild in Obsidian plugin context. `ADR-003-addendum-shared-state.md` documents this pivot in context of MCP-side consequences, but the ADR-002 body itself isn't updated.

**Impact:** New contributors reading ADR-002 in isolation will get wrong mental model.

**Options:**
- A. Add **"Superseded-by: W1 implementation pivot"** note at top + link to addendum
- B. Rewrite ADR-002 body to reflect `safeStorage` decision + preserve original as historical
- C. Write new `ADR-002-addendum-safestorage-pivot.md`

**Recommendation:** C — preserves ADR immutability convention while documenting the pivot clearly. One additional file, keeps original decision context.

### R2 — ADR-004 accepted but not shipped in v2.0 (deferred)

**Observed:** `docs/adrs/ADR-004-skill-registry-integration.md` frontmatter says `status: accepted`. It defines new `integration` skill type + `requires[]` + `postInstall` hooks. None of this shipped in v2.0 — the `gsuite-analysis` skill uses the existing registry format. Per internal notes, ADR-004 was "out of W2 scope" — effectively deferred.

**Impact:** Doc suggests the extensions exist; code doesn't implement them.

**Options:**
- A. Change ADR-004 status → `deferred` + add note "ship target: v2.1"
- B. Change to `rejected` if the extensions are no longer planned (cleanest if scope won't happen)
- C. Implement the extensions in v2.1 before shipping more integrations

**Recommendation:** A — most honest; preserves intent; revisit at v2.1 planning time. Audit `docs/adrs/README.md` already notes this under "Notes on specific ADRs" but ADR-004 itself isn't updated.

### R3 — v1.6.0-beta / v1.7.0-beta entries in CHANGELOG still say "(unreleased)"

**Observed:** CHANGELOG has headings `## v1.6.0-beta (unreleased)` and `## v1.7.0-beta (unreleased)` preserved from development. Technically correct (those betas never had their own git tags/releases — they graduated into v2.0.0) but visually ambiguous.

**Impact:** Reader of CHANGELOG may be confused whether those versions exist somewhere or not.

**Options:**
- A. Leave as-is (historically accurate — they genuinely were never released standalone)
- B. Add prefix: `## v1.6.0-beta (never released — graduated into v2.0.0)` for clarity
- C. Collapse all beta entries into a single "Development milestones (v1.5-1.7 beta, graduated into v2.0.0)" section

**Recommendation:** B — one-word addition, preserves audit trail, removes ambiguity.

---

## Metrics

- **Files audited:** ~30 (README, 2× CHANGELOG, RELEASE-v2.0.0, manifest, 2× package.json, versions.json, .env.example, 3× CI/workflow files, 3× gitignore, 22× skill registry entries + 6× ADRs + 10× mcp-google tools)
- **Relative links verified:** 5 in root README, all pass
- **ADRs copied:** 6 (ADR-001 through ADR-005 including addendum)
- **Version strings cross-compared:** 8 sources — coherent on 2.0.0 (plugin) + 1.1.0 (mcp-google)
- **Fixes applied:** 8 Yellow items (+ reweave skill file copied)
- **User action items:** 3 Red items (all optional — none block release)
- **Security:** Zero leaked secrets in tracked source; zero in git history

---

## User action items (priority-ordered)

1. **Review this audit report** (`docs/AUDIT-v2.0.0.md`) — verify Yellow fixes make sense, decide on Red items
2. **Review Ralph's commit** (`git log origin/master..HEAD` — single "Post-v2.0 audit fixes" commit)
3. **Decide R1 (ADR-002 pivot doc)** — recommended: create `ADR-002-addendum-safestorage-pivot.md`. Can be done in a later commit.
4. **Decide R2 (ADR-004 status)** — recommended: mark as `deferred` in frontmatter
5. **Decide R3 (CHANGELOG beta markers)** — recommended: add "(never released — graduated into v2.0.0)" suffix
6. **Push** — `git push origin master` if all OK. Ralph **did not push** — user-gated.
7. **Post-push:** verify GH Actions Build Check green on new commit
8. **(Optional)** — Skills repo has 1 new file + 1 modified file. Separate `git push` needed in `modular-context-skills/` submodule-like folder.
9. **(Optional)** — Rotate OAuth Client Secret in GCP Console (still recommended — secret was briefly in main.js via esbuild inject before filter-repo cleaned history; though per RFC 8252 desktop client secrets are "not truly secret")

---

## Audit trail — verified items (for posterity)

- [x] Version strings cross-checked (8 sources)
- [x] 10 MCP tools registered and have source files
- [x] 3 primary skills match between registry and plugin fallback
- [x] 6 plugin commands registered and documented in README
- [x] CI workflows point at `master` branch
- [x] CI workflows build per-workspace + tsc per-workspace
- [x] Release 2.0.0 has 4 required assets
- [x] Git history clean (main.js, mcp-server.js never re-committed after filter-repo)
- [x] .gitignore covers all build artifacts + secrets
- [x] No OAuth secrets in tracked source
- [x] README root-level + banner.png at root
- [x] 6 ADRs copied to `docs/adrs/` with index README.md
- [x] .env.example updated with v2.0 scopes
- [x] Plugin src/google/README.md rewritten for shipped state
- [x] Broken `reweave` skill install path fixed
- [x] CHANGELOG v2.0.0 heading updated from "(unreleased)" to release date

---

_Audit run by Ralph autonomous loop, 15-iteration sweep. Policy: safe fixes only, no push, no `gh` write operations. User decisions reserved for Red items. Report immutable — later audits should produce new dated files._
