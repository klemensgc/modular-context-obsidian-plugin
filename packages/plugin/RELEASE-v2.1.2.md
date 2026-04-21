## Fix: Quick Connect button missing in downloaded releases

v2.1.0–v2.1.1 shipped GitHub releases with empty OAuth credentials baked into `main.js`, so `ConnectGoogleModal` rendered the *"Quick Connect unavailable in this build"* fallback for anyone installing from the GitHub release assets. Local builds with `.env.local` worked fine, which hid the issue.

Root cause: `esbuild.config.mjs` reads `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` from `packages/plugin/.env.local` at build time and substitutes them via `define:`. The release workflow did not create that file, so CI always built with empty strings.

Fix: `.github/workflows/release.yml` now writes `.env.local` from repo-level GitHub Secrets before `npm run build`. Credentials are the same shared public client from ADR-001 (Testing mode, <100 users) — identical to what a local dev build produced.

No source changes. If your locally installed plugin already had Quick Connect working (e.g., you were on v2.1.1 via `cp main.js styles.css manifest.json ...` from a local build), this release is a no-op for you.

If you were stuck on the "Quick Connect unavailable" fallback: update to v2.1.2 and the button returns.
