// High-level orchestrator: keeps MCP server state synced with plugin Google state.
// Multi-account aware (ADR-005).

import { existsSync, rmSync } from "node:fs";
import type { AccountId, AccountIndex, StoredTokens } from "@mc/shared";
import { emailToAccountFilename, normalizeAccountId } from "@mc/shared";
import {
  ACCOUNTS_DIR,
  deleteAccountCredentials,
  ensureSidecarDirs,
  ensureSidecarGitignore,
  migrateLegacySidecarIfNeeded,
  readAccountsIndex,
  removeIndexEntry,
  upsertIndexEntry,
  writeAccountCredentials,
  writeAccountsIndex,
} from "./credentials-sidecar.js";
import { removeMcpEntry, writeMcpConfig } from "./generator.js";
import { ensureServerInstalled } from "./installer.js";

export interface McpSyncOptions {
  /** Absolute path to Obsidian vault root — where .mcp.json lives */
  vaultRoot: string;
  /** Absolute path to the bundled mcp-server.js in plugin install dir */
  sourceServerPath: string;
  /** OAuth credentials — needed in sidecar for MCP server refresh */
  clientId: string;
  clientSecret: string;
  /** Plugin version string for audit trail */
  pluginVersion: string;
}

export interface McpSyncResult {
  ok: boolean;
  message?: string;
  error?: unknown;
}

/**
 * Called after successful Connect (or Add Account) — writes account sidecar,
 * updates accounts-index, installs server (if first account), writes .mcp.json.
 *
 * accountId is derived from tokens.accountEmail.
 */
export function syncOnConnect(tokens: StoredTokens, opts: McpSyncOptions): McpSyncResult {
  try {
    migrateLegacySidecarIfNeeded();
    ensureSidecarDirs();
    ensureSidecarGitignore();

    const id = normalizeAccountId(tokens.accountEmail);
    const filename = emailToAccountFilename(id);

    writeAccountCredentials(id, tokens, {
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      pluginVersion: opts.pluginVersion,
    });

    // Upsert index entry — first account becomes primary
    const existingIndex = readAccountsIndex();
    const isFirstAccount = existingIndex.accounts.length === 0;
    upsertIndexEntry({
      id,
      email: tokens.accountEmail,
      filename,
      scope: tokens.scope,
      connectedAt: new Date().toISOString(),
      lastRefreshed: new Date().toISOString(),
      isPrimary: isFirstAccount || existingIndex.primaryAccount === id,
    });

    ensureServerInstalled(opts.sourceServerPath);
    writeMcpConfig(opts.vaultRoot);

    return {
      ok: true,
      message: isFirstAccount
        ? "MCP server installed. Restart Claude Code session to load Gmail + Calendar tools."
        : `Account ${tokens.accountEmail} added. Restart Claude Code session to pick up.`,
    };
  } catch (err) {
    return {
      ok: false,
      message:
        err instanceof Error
          ? `MCP setup failed: ${err.message}`
          : "MCP setup failed (unknown error)",
      error: err,
    };
  }
}

/**
 * Called after token refresh — rewrite sidecar for the account with fresh access_token.
 */
export function syncOnRefresh(
  accountId: AccountId,
  tokens: StoredTokens,
  opts: McpSyncOptions,
): McpSyncResult {
  try {
    const id = normalizeAccountId(accountId);
    writeAccountCredentials(id, tokens, {
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      pluginVersion: opts.pluginVersion,
    });
    // Update lastRefreshed in index
    upsertIndexEntry({
      id,
      email: tokens.accountEmail,
      filename: emailToAccountFilename(id),
      scope: tokens.scope,
      connectedAt: readAccountsIndex().accounts.find((a) => a.id === id)?.connectedAt ?? new Date().toISOString(),
      lastRefreshed: new Date().toISOString(),
      isPrimary: readAccountsIndex().primaryAccount === id,
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "refresh sidecar write failed",
      error: err,
    };
  }
}

/**
 * Called after Disconnect of a specific account — remove its sidecar + index entry.
 * If no accounts remain, also remove .mcp.json entry.
 */
export function syncOnDisconnect(
  accountId: AccountId,
  opts: Pick<McpSyncOptions, "vaultRoot">,
): McpSyncResult {
  try {
    const id = normalizeAccountId(accountId);
    deleteAccountCredentials(id);
    removeIndexEntry(id);

    const remaining = readAccountsIndex().accounts.length;
    if (remaining === 0) {
      removeMcpEntry(opts.vaultRoot);
      return {
        ok: true,
        message: "Last account disconnected. MCP config removed. Restart Claude Code.",
      };
    }
    return {
      ok: true,
      message: `Account disconnected (${remaining} remaining). Restart Claude Code to refresh.`,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "disconnect cleanup failed",
      error: err,
    };
  }
}

/**
 * Reconcile server-side sidecar with plugin-side authoritative account list.
 *
 * Plugin-side (vault `.modular-context/accounts-index.json` via safeStorage) is the
 * source of truth. Server-side (`~/.modular-context/mcp-google/accounts-index.json`)
 * must match it exactly — otherwise MCP server picks wrong primary, points at
 * deleted folders (TOKEN_MISSING), or exposes removed accounts.
 *
 * Desync can happen when:
 *  - Plugin is reloaded after manual sidecar deletion
 *  - Account was added/removed while plugin was closed
 *  - Migration between versions left stale entries
 *
 * This helper prunes sidecar entries not in pluginAccounts, updates scopes/timestamps
 * for matched ones, and promotes the correct primary.
 *
 * Note: this does NOT re-create missing sidecar credentials. If plugin has an account
 * but server-side credentials.json is missing, server will return TOKEN_MISSING until
 * user reconnects that account. Reconciliation only aligns the index, not tokens.
 */
export function reconcileMcpSidecar(
  pluginAccounts: AccountIndex[],
  pluginPrimary: AccountId | null,
): McpSyncResult {
  try {
    ensureSidecarDirs();
    const pluginIds = new Set(pluginAccounts.map((a) => a.id));
    const serverIndex = readAccountsIndex();

    // Start from plugin list (source of truth), preserving server timestamps where available
    const reconciled: AccountIndex[] = pluginAccounts.map((pa) => {
      const existing = serverIndex.accounts.find((sa) => sa.id === pa.id);
      return {
        ...pa,
        // Keep whichever connectedAt is older (first connection)
        connectedAt: existing?.connectedAt ?? pa.connectedAt,
        // Keep whichever lastRefreshed is newer
        lastRefreshed: pickLatestIso(existing?.lastRefreshed, pa.lastRefreshed),
        // Primary is decided by pluginPrimary; isPrimary set in writeAccountsIndex invariant fixup
        isPrimary: pa.id === pluginPrimary,
      };
    });

    // Delete orphaned sidecars (accounts in server but not in plugin)
    for (const sa of serverIndex.accounts) {
      if (!pluginIds.has(sa.id)) {
        deleteAccountCredentials(sa.id);
      }
    }

    writeAccountsIndex({
      schemaVersion: 1,
      primaryAccount: reconciled.length > 0 ? pluginPrimary : null,
      accounts: reconciled,
    });

    return {
      ok: true,
      message: `MCP sidecar reconciled: ${reconciled.length} account(s)`,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "sidecar reconciliation failed",
      error: err,
    };
  }
}

function pickLatestIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) > Date.parse(b) ? a : b;
}

/**
 * Nuke ALL account sidecars + index + .mcp.json entry.
 * Used by a full "disconnect all" command.
 */
export function syncDisconnectAll(opts: Pick<McpSyncOptions, "vaultRoot">): McpSyncResult {
  try {
    const index = readAccountsIndex();
    for (const a of index.accounts) deleteAccountCredentials(a.id);
    // Clear index file
    if (existsSync(ACCOUNTS_DIR)) {
      rmSync(ACCOUNTS_DIR, { recursive: true, force: true });
    }
    removeMcpEntry(opts.vaultRoot);
    return { ok: true, message: "All accounts disconnected. Restart Claude Code." };
  } catch (err) {
    return { ok: false, error: err };
  }
}
