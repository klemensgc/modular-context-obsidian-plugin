---
title: ADR-002 Addendum — safeStorage Pivot
updated: 2026-04-17
status: accepted
supersedes-section: ADR-002 primary storage method (@napi-rs/keyring)
---
# ADR-002 Addendum — Electron safeStorage replaces `@napi-rs/keyring`

## Context

ADR-002 (2026-04-17) accepted `@napi-rs/keyring` as primary token storage mechanism — backed by OS keychain (macOS Keychain / Windows DPAPI / Linux libsecret), bundleable via esbuild. During W1 implementation, **this assumption failed**.

## Problem discovered during W1

`@napi-rs/keyring` depends on **platform-specific native bindings** (`.node` files, one per platform: darwin-arm64, darwin-x64, win32-x64, linux-x64). When bundled by esbuild in an Obsidian plugin context, the native require path resolves at build-time to a specific platform's binding, not dynamically at runtime. This means:

- Binary built on macOS arm64 crashes on Linux or Windows
- Binary built on CI (typically Linux) crashes on end-user macOS
- Shipping multi-platform binaries would require platform-specific build pipelines AND a dynamic loader written manually
- The esbuild bundling model (single file `main.js`) directly conflicts with native binding resolution

This was hit on first build attempt with `tsc --noEmit` passing but runtime import failing on `require('@napi-rs/keyring')`.

## Decision

**Pivot to Electron `safeStorage` API** for token encryption:

```ts
// Available in Obsidian (Electron renderer process) — zero native deps
const encrypted = electron.safeStorage.encryptString(plaintext);
const plaintext = electron.safeStorage.decryptString(encrypted);
```

Internally, `safeStorage`:
- **macOS**: Uses Keychain via Apple's Keychain Services API (same as `@napi-rs/keyring` under the hood)
- **Windows**: Uses DPAPI
- **Linux**: Uses libsecret via Secret Service API

Same **security model** as the original ADR-002 intent. Different API surface, zero native bundling friction.

## Consequences

### Positive
- ✅ **Zero native deps** — pure Electron IPC call
- ✅ **Works with esbuild out of the box** — just `external: ["electron"]` in build config
- ✅ **Same OS-keychain security** — uses identical OS primitives
- ✅ **Shipped v1.5.0-beta works on macOS + Windows + Linux** without platform-specific builds

### Negative
- ❌ **Electron-only** — MCP server (plain Node subprocess spawned by Claude Code) **cannot read tokens.enc** — it has no access to `safeStorage`. This is the problem resolved by [ADR-003 addendum (shared-state protocol)](ADR-003-addendum-shared-state.md) — plugin writes a separate plaintext sidecar for MCP server consumption.
- ⚠️ **Fallback story weaker** — if `safeStorage.isEncryptionAvailable()` returns false (e.g. missing libsecret on Linux), plugin errors out. Original ADR-002 had a passphrase-derived fallback; current implementation just errors. Future v2.1+ could add passphrase fallback.

### Code paths affected
- `packages/plugin/src/google/tokens/storage.ts` — `MultiAccountSafeStorage` class uses `electron.safeStorage`
- `packages/plugin/src/google/tokens/refresh.ts` — unchanged (operates on decrypted tokens)
- ADR-003 addendum + ADR-005 — consequence chain: plaintext sidecar for MCP, per-account layout

## References

- [ADR-002 (original decision — preserved as historical)](ADR-002-token-storage.md)
- [ADR-003 addendum — Shared-state protocol (MCP can't read safeStorage)](ADR-003-addendum-shared-state.md)
- [Electron safeStorage docs](https://www.electronjs.org/docs/latest/api/safe-storage)
- [@napi-rs/keyring](https://napi.rs/docs/interface) — rejected dependency
