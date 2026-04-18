---
title: ADR-002 — Token Storage
updated: 2026-04-17
status: accepted (see [addendum](ADR-002-addendum-safestorage-pivot.md) for W1 implementation pivot)
---
> ⚠️ **Implementation pivot:** During W1 implementation, `@napi-rs/keyring` was replaced with Electron `safeStorage` (OS keychain-backed, no native-binding bundling issues). See [ADR-002 addendum](ADR-002-addendum-safestorage-pivot.md) for rationale.
> The original decision below is preserved as historical record.

# ADR-002: Token Storage — @napi-rs/keyring + AES-256-GCM encrypted file

## Context

Musimy przechowywać OAuth tokens (access_token + refresh_token + metadata) lokalnie, w sposób który:
1. **Never leaves machine** — zgodnie z marketing narrative
2. **Survives vault sync** — user może syncować vault (git/iCloud/Obsidian Sync), tokeny nie mogą tym zostać skompromitowane
3. **Survives plugin update** — bez re-authorization przy każdym release
4. **Cross-platform** — macOS, Windows, Linux (desktop-only, mobile out-of-scope per `isDesktopOnly: true`)
5. **Handles key rotation & multi-account** (multi-account = W2+)

Konstrainty z Researcha:
- `node-keytar` archived 2026-03 → cannot use
- Obsidian native `SecretStorage` API introduced v1.11.4 ale miał plaintext bug, fix w 1.11.5+; nasz plugin ma `minAppVersion: "0.15.0"` — bump blokuje users
- Electron `safeStorage` — undocumented path via `require('electron')`
- `@napi-rs/keyring` — drop-in keytar replacement, OSS Microsoft-funded, prebuilt binaries per platform

## Decision

**Tiered fallback approach:**

```
Primary: @napi-rs/keyring (AES-256-GCM key in OS keychain)
  ↓ fallback if native binary fails
Tier 2: Obsidian SecretStorage API (if Obsidian >= 1.11.5 AND API detected)
  ↓ fallback if both unavailable
Tier 3: Passphrase-derived (PBKDF2-SHA256, 100k iter) — user prompt
```

**Storage layout:**
```
vault/.modular-context/
├── tokens.enc          # AES-256-GCM(tokens JSON)
├── tokens.meta.json    # { keyId, algorithm, storageMethod, encryptedAt }
└── .gitignore          # autogen: tokens.enc, tokens.meta.json
```

**Encryption detail:**
- Key: 32 bytes random (stored w keychain under service `modular-context-google-workspace`, account = vault UUID)
- Algorithm: AES-256-GCM (authenticated encryption, integrity + confidentiality)
- Format w pliku: hex(IV 12B) + hex(authTag 16B) + hex(ciphertext)

**For W1: implement only Tier 1 (@napi-rs/keyring).** Tier 2/3 to W2+ enhancements.

## Alternatives considered

| Option | Pros | Cons | Reason rejected |
|--------|------|------|-----------------|
| **A. @napi-rs/keyring only** | Proven, maintained, cross-platform prebuilts | Native binary — może fail na exotic arch (Alpine musl, FreeBSD) | Accepted w W1, expand fallbacks w W2 |
| **B. Obsidian SecretStorage API only** | Zero native deps, official path | v1.11.4 plaintext bug; minAppVersion bump | Wait for stability, add as Tier 2 |
| **C. Electron safeStorage directly** | Zero extra deps, ships w Electron | Undocumented w Obsidian — depends on internals | Risk: Obsidian może blokować require('electron') w przyszłości |
| **D. Plain Node crypto + passphrase** | Works everywhere, no deps | Passphrase prompt = friction — niska adoption | Accepted jako Tier 3 fallback |
| **E. Pure vault file (no encryption)** | Simplest | Narusza "tokens never leave machine" jeśli user syncuje | **REJECTED** — nie do negocjacji |
| **F. Plugin data (saveData)** | Built-in API | Obsidian plugin data jest w `.obsidian/plugins/{id}/data.json` — JSON plaintext, NOT secure | **REJECTED** — false sense of security |

## Consequences

### Positive
- **Narrative consistency** — master key nigdy nie opuszcza machine; encrypted blob na dysku jest bezużyteczny bez klucza
- **Survives vault sync** — `tokens.enc` + `tokens.meta.json` mogą być syncowane (`.gitignore` prevents git commit, ale iCloud/Dropbox OK) — restore on new device = reconnect (klucza brak → unencryptable)
- **Fallback ladder** gives UX graceful degradation: most users on Tier 1, power users z issues na Tier 3
- **Multi-account ready** — key per-account lub per-vault; tokens.enc jako map `{ email: StoredTokens }` w V2
- **Rotation possible** — `keyId` w meta pozwala na rotate flow bez data loss

### Negative
- **Native dependency** — `@napi-rs/keyring` wymaga prebuilt binary per platform. Instalacja via npm ciągnie `.node` file. Plugin bundle size grows ~2-5 MB (depending on platform).
- **Keychain permission prompt** — pierwsze zapisanie klucza triggera OS prompt (macOS: "modular-context-plugin wants to use your confidential information stored in..."). User może odrzucić → Tier 3 fallback needed
- **Linux fragmentation** — `@napi-rs/keyring` nie wymaga libsecret (dobre), ale na headless / WSL2 keyring daemon może nie działać. Testing: Ubuntu Desktop works, Ubuntu Server / Docker needs Tier 3
- **.obsidian folder access** — plugin pisze do `vault/.modular-context/` — user z read-only vault (niektórzy mount vaults from network shares) nie może zapisać → error handling needed

### Mitigations
- **Install-time detection:** w plugin init, detect czy keyring dostępny (`keyring.isSupported()` check). Fall through do Tier 2/3 automatically.
- **Clear error messages:** jeśli keychain prompt denied → Notice "Keychain access denied. Google Workspace won't work until you grant access in System Settings → Privacy & Security. Alternative: use passphrase mode (click here)."
- **Binary bundle optimization:** publish platform-specific plugin builds (darwin-arm64, darwin-x64, win32-x64, linux-x64). Obsidian już tego nie robi dla pluginów, ale możemy dostarczyć user "pick your platform" download link dla users z issues.
- **Docs:** Troubleshooting section: "keychain failures on Linux" → Tier 3 walkthrough.

## Implementation notes for W1

### Package installation
```bash
cd packages/plugin
npm install @napi-rs/keyring
# Creates platform-specific binaries download
```

**Dependency size check:** verify final plugin bundle <50MB (typical Obsidian ceiling). Jeśli >50MB — split package builds per-platform.

### API surface (packages/shared/src/google/tokens.ts)
```ts
export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  scope: string;
  expiresAt: number;  // unix ms
  tokenType: "Bearer";
  accountEmail: string;  // for UI display
}

export interface StorageMethod {
  readonly name: "keyring" | "obsidian-secret-storage" | "passphrase";
  saveTokens(tokens: StoredTokens): Promise<void>;
  loadTokens(): Promise<StoredTokens | null>;
  clearTokens(): Promise<void>;
  rotateKey(): Promise<void>;
}

// Factory — auto-picks Tier based on environment
export async function getStorageMethod(): Promise<StorageMethod>;
```

### Flow: saveTokens()
1. Serialize `StoredTokens` to JSON
2. Get master key from keyring (generate + store if absent)
3. Generate random 12-byte IV
4. `cipher = aes-256-gcm(key, iv)`; `ciphertext + authTag = cipher.update(json) + cipher.final()`
5. Write `vault/.modular-context/tokens.enc` (hex: iv || authTag || ciphertext)
6. Update `tokens.meta.json` with keyId, algorithm name, encryptedAt timestamp
7. Ensure `.gitignore` obecny (auto-create on first save)

### Flow: loadTokens()
1. Read `tokens.meta.json` → get keyId + algorithm (currently always aes-256-gcm)
2. Read `tokens.enc` → parse hex: iv, authTag, ciphertext
3. Get key from keyring by keyId
4. `decipher = aes-256-gcm(key, iv, authTag)`; plaintext = `decipher.update(ciphertext) + decipher.final()`
5. Parse JSON → return StoredTokens
6. Errors: `InvalidKey`, `TamperedData`, `TokenFileMissing` → all lead to "disconnected" state

### Flow: clearTokens()
1. Delete `tokens.enc`
2. Delete `tokens.meta.json`
3. Remove keyring entry for keyId

### Testing scenarios (W1 Iter 16)
- Fresh connect → tokens saved → restart Obsidian → loadTokens returns correct data
- Disconnect → all 3 artifacts gone (file, file, keyring)
- Keychain denied during setup → clear error, fallback prompt (Tier 3 in W2)
- Vault moved to new location → tokens.enc missing, graceful disconnected state
- Tampered tokens.enc (manual edit) → authTag fails → clear error, force reconnect

## References

- [[../research/02-token-storage]] — exhaustive options analysis
- [[../research/01-oauth-desktop-flow]] — token TTL, refresh logic
- [[ADR-001-oauth-strategy]] — oauth flow outputs feed this storage
- RFC 5116 — AEAD algorithms (AES-256-GCM)
- NIST SP 800-38D — GCM mode spec

## Open questions for user

- Vault root `.gitignore` — overwrite lub create jeśli istnieje? Propozycja: append section z header comment, idempotent
- Jeśli user ma 2 klinickie vaulty (ROS + Apolonia) i chce oddzielne konta → zaakceptowac że każdy vault = osobne tokens, czy dodać profile feature w onboardingu?
- Multi-account (W2): jedna tokens.enc map czy file per account?
