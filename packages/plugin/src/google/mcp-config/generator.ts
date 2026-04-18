// .mcp.json writer — generates Claude Code MCP server entry for google-workspace.
// Per ADR-005 (multi-account env vars).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCOUNTS_DIR,
  ACCOUNTS_INDEX_PATH,
  LEGACY_CREDENTIALS_PATH,
  LOG_PATH,
  SERVER_ENTRY,
} from "./credentials-sidecar.js";

export const MCP_SERVER_KEY = "google-workspace";

interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

/**
 * Write or update .mcp.json in vault root. Merges with existing servers.
 * Uses multi-account env vars (MC_ACCOUNTS_DIR + MC_ACCOUNTS_INDEX).
 * MC_CREDENTIALS_PATH kept for legacy fallback — server uses it only if
 * multi-account vars absent/empty.
 */
export function writeMcpConfig(vaultRoot: string): void {
  const path = join(vaultRoot, ".mcp.json");
  const existing = readMcpConfig(path);

  const entry: McpServerEntry = {
    command: "node",
    args: [SERVER_ENTRY],
    env: {
      MC_ACCOUNTS_DIR: ACCOUNTS_DIR,
      MC_ACCOUNTS_INDEX: ACCOUNTS_INDEX_PATH,
      MC_CREDENTIALS_PATH: LEGACY_CREDENTIALS_PATH,
      MC_LOG_PATH: LOG_PATH,
      MC_LOG_LEVEL: "INFO",
    },
  };

  const merged: McpConfig = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers ?? {}),
      [MCP_SERVER_KEY]: entry,
    },
  };

  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", { encoding: "utf8" });
}

/**
 * Remove our entry from .mcp.json, preserving other servers. No-op if absent.
 */
export function removeMcpEntry(vaultRoot: string): void {
  const path = join(vaultRoot, ".mcp.json");
  if (!existsSync(path)) return;
  const existing = readMcpConfig(path);
  if (!existing.mcpServers || !(MCP_SERVER_KEY in existing.mcpServers)) return;

  const { [MCP_SERVER_KEY]: _removed, ...others } = existing.mcpServers;
  void _removed;
  const merged: McpConfig = { ...existing, mcpServers: others };

  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", { encoding: "utf8" });
}

function readMcpConfig(path: string): McpConfig {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as McpConfig;
    return parsed;
  } catch {
    return {};
  }
}
