# Architecture Decision Records (ADRs)

Record of architectural decisions made during v1.5 → v2.0 development of the Google Workspace integration.

Each ADR is an immutable record at acceptance time. Later decisions override via addendums (e.g. ADR-003 has an addendum; ADR-005 supersedes parts of that addendum).

## Index

| ADR | Title | Status | Accepted |
|-----|-------|--------|----------|
| [001](ADR-001-oauth-strategy.md) | OAuth Strategy — Hybrid Quick Connect + BYO | accepted | 2026-04-17 |
| [002](ADR-002-token-storage.md) | Token Storage — encrypted file + OS keychain | accepted | 2026-04-17 |
| [003](ADR-003-mcp-server-lifecycle.md) | MCP Server Lifecycle — standalone package, stdio spawned | accepted | 2026-04-17 |
| [003-addendum](ADR-003-addendum-shared-state.md) | Shared-State Protocol (MCP ↔ Plugin) — plaintext credentials sidecar | accepted | 2026-04-18 |
| [004](ADR-004-skill-registry-integration.md) | Skill Registry Integration — integration type + requires | accepted | 2026-04-17 |
| [005](ADR-005-multi-account-storage.md) | Multi-Account Storage Model — per-account folder + canonical index | accepted | 2026-04-18 |

## Status legend

- **accepted** — decision made, implemented (or actively being implemented)
- **deferred** — decision accepted in principle, implementation delayed
- **superseded** — replaced by a newer ADR (cross-referenced in frontmatter)

## Notes on specific ADRs

- **ADR-002 pivot:** Original text specifies `@napi-rs/keyring` as token storage primary. During W1 implementation we pivoted to Electron `safeStorage` because `@napi-rs/keyring` native bindings couldn't be bundled by esbuild in Obsidian plugin context. Shipped v2.0 uses safeStorage (OS keychain-backed). See ADR-003 addendum for downstream MCP-side consequences of this pivot.
- **ADR-004 status:** Skill registry extensions (new `integration` type, `requires[]`, `postInstall` hooks) were accepted but **deferred** from v2.0 scope — not implemented. The gsuite-analysis skill in v2.0 uses the existing registry format without these extensions. Revisit for v2.1+.
- **ADR-003 addendum supersession:** Multi-account (ADR-005) changes the "single credentials.json sidecar" model. Server now reads per-account sidecars + index. See ADR-005 for current shape.
