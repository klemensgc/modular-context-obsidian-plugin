// Installs mcp-google server dist/ to ~/.modular-context/mcp-google/dist/.
// Source: plugin assets bundled at build time OR mcp-google package in monorepo (dev mode).

import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DIST_DIR, SERVER_ENTRY, ensureSidecarDirs } from "./credentials-sidecar.js";

const REQUIRED_SERVER_VERSION = "1.3.0";
const VERSION_FILE = join(DIST_DIR, "VERSION");

/**
 * Ensure MCP server binary is installed at ~/.modular-context/mcp-google/dist/index.js.
 * Returns absolute path to the entry. Installs from source path if missing/outdated.
 *
 * @param sourceDistPath Path to packages/mcp-google/dist/index.js (plugin must know this
 *   at runtime — typically via bundled asset or derived from plugin's own install location).
 */
export function ensureServerInstalled(sourceDistPath: string): string {
  ensureSidecarDirs();

  if (isUpToDate()) {
    return SERVER_ENTRY;
  }

  if (!existsSync(sourceDistPath)) {
    throw new Error(
      `MCP server source binary not found at ${sourceDistPath}. ` +
        `Plugin build must include mcp-google dist/. Check esbuild.config.mjs postBuild step.`,
    );
  }

  copyFileSync(sourceDistPath, SERVER_ENTRY);
  chmodSync(SERVER_ENTRY, 0o755);
  writeFileSync(VERSION_FILE, REQUIRED_SERVER_VERSION, { encoding: "utf8" });

  return SERVER_ENTRY;
}

export function getInstalledVersion(): string | null {
  if (!existsSync(VERSION_FILE)) return null;
  try {
    return readFileSync(VERSION_FILE, "utf8").trim();
  } catch {
    return null;
  }
}

function isUpToDate(): boolean {
  if (!existsSync(SERVER_ENTRY)) return false;
  const installed = getInstalledVersion();
  return installed === REQUIRED_SERVER_VERSION;
}

// Unused import suppression — dirname kept for future path derivation logic
void dirname;
