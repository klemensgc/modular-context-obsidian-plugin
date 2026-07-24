# Releasing the Modular Context desktop app (DMG)

> **Status: PREVIEW / EXPERIMENTAL.** macOS **arm64 (Apple Silicon) only**, adhoc-signed
> (`identity: null`), **not notarized**. Gatekeeper will block it on first open — by design.
> The mature install path is the Obsidian **plugin via BRAT**, not this app.

## What gets built

`electron-builder` (config: `electron-builder.yml`) produces, from `packages/app`:

```
dist-app/ModularContext-<version>-arm64.dmg
```

`artifactName: ModularContext-${version}-${arch}.dmg` keeps the file name space-free
while the in-app product name stays `Modular Context`. Version comes from
`packages/app/package.json` (kept in sync with the plugin `manifest.json` — currently **2.3.0**).

## Build locally

```bash
# from repo root
npm ci
cd packages/app
npm run dist            # = npm run build && electron-builder --mac --publish never
```

Output lands in `packages/app/dist-app/` (gitignored). `--publish never` means the
builder never uploads anything — publishing is a separate, manual step.

## Checksum

```bash
cd packages/app/dist-app
shasum -a 256 ModularContext-*-arm64.dmg
```

Put this SHA-256 on the download page so users can verify the artifact.

## Publish (manual, requires approval)

Publishing is **not automatic**. The CI workflow `.github/workflows/release-app.yml`
is `workflow_dispatch` only (never fires on push) and attaches the DMG to an
**existing** release tag (the one the plugin `release.yml` already created, e.g. `2.1.4`):

1. Ensure the plugin release for the tag exists (created by `release.yml`).
2. Manually run **Actions → Release desktop app (DMG · preview)**, input the tag.
3. The job builds on a `macos-14` (Apple Silicon) runner, renames the artifact to the
   stable name `ModularContext-arm64.dmg`, and uploads it + `.sha256` with `--clobber`.

Stable name → deterministic download URL:

```
https://github.com/klemensgc/modular-context-obsidian-plugin/releases/latest/download/ModularContext-arm64.dmg
```

Manual equivalent (if you'd rather not use the workflow):

```bash
cd packages/app/dist-app
cp ModularContext-*-arm64.dmg ModularContext-arm64.dmg
shasum -a 256 ModularContext-arm64.dmg > ModularContext-arm64.dmg.sha256
gh release upload <tag> ModularContext-arm64.dmg ModularContext-arm64.dmg.sha256 --clobber
```

## TODO — architectures

- **arm64**: built & shipped (preview).
- **x64 / universal**: NOT built, NOT tested. `electron-builder.yml` has no `arch:` override,
  so it builds host arch only. Adding `arch: [arm64, x64]` or `universal` requires an Intel
  test pass we don't have yet — do not advertise universal until it's actually built and tested.
