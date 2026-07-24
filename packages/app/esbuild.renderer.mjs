/** Renderer bundle config.
 *
 *  Exists (instead of CLI flags) for one critical reason: the `alias` entries
 *  below force every import of @codemirror/state and @codemirror/view to the
 *  single copy this package resolves — regardless of how npm hoists nested
 *  duplicates across the monorepo. Duplicate copies were the root cause of
 *  the "CM6 renders but ignores input/scroll" failure (see CM6-DIAGNOSIS.md):
 *  extensions created by one copy are not recognized by an EditorView from
 *  another. npm `overrides` do not reliably apply inside workspaces, so the
 *  dedupe happens here, at bundle time, deterministically.
 */

import esbuild from "esbuild";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// Resolve to the ENTRY FILE of the copy this package sees — these packages are
// only ever imported bare (no subpaths), so a file alias is sufficient and the
// exports map blocks resolving package.json/roots.
const cmStateEntry = require.resolve("@codemirror/state");
const cmViewEntry = require.resolve("@codemirror/view");

await esbuild.build({
  entryPoints: ["src/renderer/index.ts"],
  bundle: true,
  platform: "browser",
  target: "es2020",
  format: "iife",
  loader: { ".css": "text", ".py": "text" },
  external: ["child_process", "fs", "path", "os"],
  alias: {
    "@codemirror/state": cmStateEntry,
    "@codemirror/view": cmViewEntry,
  },
  outfile: "dist/renderer/index.js",
  logLevel: "info",
});
