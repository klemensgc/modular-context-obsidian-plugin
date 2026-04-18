// Multi-account token loader (ADR-005).
// Reads sidecar credentials for a specific account, refreshes access token if near-expiry.
// Falls back to legacy single-file sidecar if multi-account env vars absent.

import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { OAuth2Client } from "google-auth-library";
import { MCGoogleError, MCPToolError, type SharedCredentials, type ServerEnv } from "../types.js";
import type { Logger } from "../logger.js";

const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

interface AccountIndexEntry {
  id: string;
  email: string;
  filename: string;
  scope: string;
  connectedAt: string;
  lastRefreshed?: string;
  isPrimary: boolean;
}

interface AccountsIndexJson {
  schemaVersion: number;
  primaryAccount: string | null;
  accounts: AccountIndexEntry[];
}

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

function emailToFilename(email: string): string {
  return normalizeEmail(email).replace(/@/g, "-at-").replace(/\./g, "-");
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Resolve accountId (optional email) → absolute path to that account's credentials.json.
 * Returns null if env doesn't support multi-account (legacy fallback path used elsewhere).
 */
function resolveAccountCredentialsPath(env: ServerEnv, accountId?: string): string | null {
  if (!env.accountsDir) return null;
  const index = env.accountsIndexPath ? readJsonFile<AccountsIndexJson>(env.accountsIndexPath) : null;

  let resolvedId: string | null = null;
  if (accountId) {
    const normalized = normalizeEmail(accountId);
    if (index) {
      const match = index.accounts.find((a) => a.id === normalized);
      if (!match) {
        throw new MCPToolError(
          MCGoogleError.ACCOUNT_NOT_FOUND,
          `No account "${accountId}" in index. Connect via plugin first.`,
        );
      }
      resolvedId = match.id;
    } else {
      // No index, but accountId given — compute filename and try it
      resolvedId = normalized;
    }
  } else if (index && index.primaryAccount) {
    resolvedId = index.primaryAccount;
  } else {
    // No index and no accountId — fall back to legacy
    return null;
  }

  return join(env.accountsDir, emailToFilename(resolvedId), "credentials.json");
}

function loadCredentialsFromPath(path: string): SharedCredentials {
  if (!existsSync(path)) {
    throw new MCPToolError(
      MCGoogleError.TOKEN_MISSING,
      `Credentials not found at ${path}. Connect Google Workspace via the plugin first.`,
    );
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new MCPToolError(
      MCGoogleError.TOKEN_INVALID,
      `Cannot read credentials sidecar at ${path}`,
      err,
    );
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SharedCredentials>;
    validateCredentials(parsed);
    return parsed;
  } catch (err) {
    if (err instanceof MCPToolError) throw err;
    throw new MCPToolError(MCGoogleError.TOKEN_INVALID, "Credentials sidecar malformed JSON", err);
  }
}

function validateCredentials(c: Partial<SharedCredentials>): asserts c is SharedCredentials {
  const required: Array<keyof SharedCredentials> = [
    "clientId",
    "clientSecret",
    "refreshToken",
    "accountEmail",
  ];
  for (const field of required) {
    if (!c[field] || typeof c[field] !== "string") {
      throw new MCPToolError(
        MCGoogleError.TOKEN_INVALID,
        `Credentials sidecar missing required field: ${field}`,
      );
    }
  }
}

function writeCredentialsAtomic(path: string, creds: SharedCredentials): void {
  const tmp = `${path}.tmp`;
  const json = JSON.stringify(creds, null, 2);
  writeFileSync(tmp, json, { encoding: "utf8", mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/**
 * Get a valid access token for the requested account (or primary if accountId undefined).
 * Refreshes via google-auth-library if within REFRESH_THRESHOLD_MS of expiry.
 * Writes updated credentials back to the same sidecar path on success.
 */
export async function getValidAccessToken(
  env: ServerEnv,
  accountId: string | undefined,
  logger: Logger,
): Promise<{ accessToken: string; accountEmail: string }> {
  // Prefer multi-account; fall back to legacy single-file path
  let credsPath: string | null = resolveAccountCredentialsPath(env, accountId);
  if (!credsPath) {
    if (accountId) {
      throw new MCPToolError(
        MCGoogleError.ACCOUNT_NOT_FOUND,
        `account "${accountId}" requested but no accounts index configured (MC_ACCOUNTS_INDEX unset)`,
      );
    }
    if (!env.legacyCredentialsPath) {
      throw new MCPToolError(
        MCGoogleError.TOKEN_MISSING,
        "Neither MC_ACCOUNTS_DIR nor MC_CREDENTIALS_PATH set — plugin must write .mcp.json",
      );
    }
    credsPath = env.legacyCredentialsPath;
  }

  const creds = loadCredentialsFromPath(credsPath);
  const expiresAt = Date.parse(creds.accessTokenExpiresAt);
  const now = Date.now();

  if (creds.accessToken && Number.isFinite(expiresAt) && expiresAt > now + REFRESH_THRESHOLD_MS) {
    logger.debug("Access token still valid", { accountEmail: creds.accountEmail });
    return { accessToken: creds.accessToken, accountEmail: creds.accountEmail };
  }

  logger.info("Refreshing access token", { accountEmail: creds.accountEmail });
  const client = new OAuth2Client({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
  });
  client.setCredentials({ refresh_token: creds.refreshToken });

  let refreshed;
  try {
    refreshed = await client.refreshAccessToken();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("invalid_grant")) {
      throw new MCPToolError(
        MCGoogleError.TOKEN_EXPIRED,
        "Refresh token invalidated by Google. Reconnect via plugin required.",
        err,
      );
    }
    throw new MCPToolError(MCGoogleError.NETWORK_ERROR, `Token refresh failed: ${message}`, err);
  }

  const tokens = refreshed.credentials;
  if (!tokens.access_token) {
    throw new MCPToolError(MCGoogleError.UNKNOWN, "Refresh response missing access_token");
  }

  const updated: SharedCredentials = {
    ...creds,
    accessToken: tokens.access_token,
    accessTokenExpiresAt: new Date(
      tokens.expiry_date ?? Date.now() + 55 * 60 * 1000,
    ).toISOString(),
    refreshToken: tokens.refresh_token ?? creds.refreshToken,
    writtenAt: new Date().toISOString(),
    writtenBy: "mcp-google-workspace-server",
  };

  try {
    writeCredentialsAtomic(credsPath, updated);
    logger.debug("Credentials sidecar rewritten post-refresh");
  } catch (err) {
    logger.warn("Failed to write refreshed credentials back to sidecar", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { accessToken: updated.accessToken, accountEmail: updated.accountEmail };
}

/** Enumerate accounts from index (if present). Used by future debug/status tools. */
export function listAccounts(env: ServerEnv): AccountIndexEntry[] {
  if (!env.accountsIndexPath) return [];
  const index = readJsonFile<AccountsIndexJson>(env.accountsIndexPath);
  return index?.accounts ?? [];
}
