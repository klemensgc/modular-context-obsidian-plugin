// Plaintext credentials sidecar for MCP server consumption.
// Multi-account layout per ADR-005:
//   ~/.modular-context/mcp-google/
//     ├── accounts/
//     │   └── {filename}/credentials.json (0600)
//     └── accounts-index.json

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  emailToAccountFilename,
  normalizeAccountId,
  type AccountId,
  type AccountIndex,
  type AccountsIndex,
  type StoredTokens,
} from "@mc/shared";

export const SIDECAR_DIR = join(homedir(), ".modular-context", "mcp-google");
export const ACCOUNTS_DIR = join(SIDECAR_DIR, "accounts");
export const ACCOUNTS_INDEX_PATH = join(SIDECAR_DIR, "accounts-index.json");
export const LOGS_DIR = join(SIDECAR_DIR, "logs");
export const LOG_PATH = join(LOGS_DIR, "server.log");
export const DIST_DIR = join(SIDECAR_DIR, "dist");
export const SERVER_ENTRY = join(DIST_DIR, "index.js");

// Legacy single-account path (W2 — pre-multi-account)
export const LEGACY_CREDENTIALS_PATH = join(SIDECAR_DIR, "credentials.json");

export interface SidecarCredentials {
  accountId: AccountId;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  accountEmail: string;
  scope: string;
  writtenAt: string;
  writtenBy: string;
}

export function ensureSidecarDirs(): void {
  if (!existsSync(SIDECAR_DIR)) mkdirSync(SIDECAR_DIR, { recursive: true, mode: 0o700 });
  if (!existsSync(ACCOUNTS_DIR)) mkdirSync(ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
  if (!existsSync(DIST_DIR)) mkdirSync(DIST_DIR, { recursive: true, mode: 0o755 });
}

function accountDir(accountId: AccountId): string {
  return join(ACCOUNTS_DIR, emailToAccountFilename(accountId));
}

function accountCredentialsPath(accountId: AccountId): string {
  return join(accountDir(accountId), "credentials.json");
}

export function writeAccountCredentials(
  accountId: AccountId,
  tokens: StoredTokens,
  opts: { clientId: string; clientSecret: string; pluginVersion: string },
): void {
  ensureSidecarDirs();
  const id = normalizeAccountId(accountId);
  const dir = accountDir(id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const creds: SidecarCredentials = {
    accountId: id,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    refreshToken: tokens.refreshToken ?? "",
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: new Date(tokens.expiresAt).toISOString(),
    accountEmail: tokens.accountEmail,
    scope: tokens.scope,
    writtenAt: new Date().toISOString(),
    writtenBy: `plugin-${opts.pluginVersion}`,
  };

  const finalPath = accountCredentialsPath(id);
  const tmp = `${finalPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(creds, null, 2), { encoding: "utf8", mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, finalPath);
  chmodSync(finalPath, 0o600);
}

export function deleteAccountCredentials(accountId: AccountId): void {
  const id = normalizeAccountId(accountId);
  const dir = accountDir(id);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

export function readAccountsIndex(): AccountsIndex {
  if (!existsSync(ACCOUNTS_INDEX_PATH)) {
    return { schemaVersion: 1, primaryAccount: null, accounts: [] };
  }
  try {
    return JSON.parse(readFileSync(ACCOUNTS_INDEX_PATH, "utf8")) as AccountsIndex;
  } catch {
    return { schemaVersion: 1, primaryAccount: null, accounts: [] };
  }
}

export function writeAccountsIndex(index: AccountsIndex): void {
  ensureSidecarDirs();
  // Normalize invariants (match plugin-side MultiAccountSafeStorage)
  if (index.accounts.length > 0) {
    const primaryCount = index.accounts.filter((a) => a.isPrimary).length;
    if (primaryCount === 0) {
      index.accounts[0].isPrimary = true;
      index.primaryAccount = index.accounts[0].id;
    } else if (primaryCount > 1) {
      let seen = false;
      for (const a of index.accounts) {
        if (a.isPrimary && seen) a.isPrimary = false;
        if (a.isPrimary) seen = true;
      }
    }
  } else {
    index.primaryAccount = null;
  }
  writeFileSync(ACCOUNTS_INDEX_PATH, JSON.stringify(index, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(ACCOUNTS_INDEX_PATH, 0o600);
}

/** Upsert an account entry into the sidecar index. */
export function upsertIndexEntry(entry: AccountIndex): void {
  const index = readAccountsIndex();
  const existing = index.accounts.find((a) => a.id === entry.id);
  if (existing) {
    existing.email = entry.email;
    existing.filename = entry.filename;
    existing.scope = entry.scope;
    existing.lastRefreshed = entry.lastRefreshed ?? new Date().toISOString();
    if (entry.isPrimary) {
      for (const a of index.accounts) a.isPrimary = a.id === entry.id;
      index.primaryAccount = entry.id;
    }
  } else {
    const becomesPrimary = entry.isPrimary || index.accounts.length === 0;
    if (becomesPrimary) {
      for (const a of index.accounts) a.isPrimary = false;
      entry.isPrimary = true;
      index.primaryAccount = entry.id;
    }
    index.accounts.push(entry);
  }
  writeAccountsIndex(index);
}

/** Remove an account entry and promote next primary if needed. */
export function removeIndexEntry(accountId: AccountId): void {
  const id = normalizeAccountId(accountId);
  const index = readAccountsIndex();
  const wasPrimary = index.primaryAccount === id;
  index.accounts = index.accounts.filter((a) => a.id !== id);
  if (wasPrimary) {
    if (index.accounts.length > 0) {
      index.accounts[0].isPrimary = true;
      index.primaryAccount = index.accounts[0].id;
      for (let i = 1; i < index.accounts.length; i++) index.accounts[i].isPrimary = false;
    } else {
      index.primaryAccount = null;
    }
  }
  writeAccountsIndex(index);
}

export function ensureSidecarGitignore(): void {
  const gitignorePath = join(SIDECAR_DIR, ".gitignore");
  const content = [
    "# mcp-google-workspace — never commit these",
    "accounts/",
    "accounts-index.json",
    "credentials.json",
    "logs/",
    "*.log",
    "",
  ].join("\n");
  // Always overwrite to ensure all current entries present (idempotent)
  writeFileSync(gitignorePath, content, { encoding: "utf8" });
}

/**
 * One-shot migration from W2 single-file sidecar to multi-account layout.
 * If legacy `credentials.json` exists at sidecar root, move it into accounts/{filename}/
 * and write an accounts-index.json. Preserves existing multi-account state if present.
 */
export function migrateLegacySidecarIfNeeded(): void {
  if (!existsSync(LEGACY_CREDENTIALS_PATH)) return;

  // If accounts dir has entries, legacy is stale → remove
  if (existsSync(ACCOUNTS_DIR)) {
    const entries = readdirSync(ACCOUNTS_DIR).filter((n) => !n.startsWith("."));
    if (entries.length > 0) {
      try {
        rmSync(LEGACY_CREDENTIALS_PATH, { force: true });
        console.log("[mc] Removed stale legacy credentials.json (accounts/ already populated)");
      } catch {
        /* ignore */
      }
      return;
    }
  }

  try {
    const raw = readFileSync(LEGACY_CREDENTIALS_PATH, "utf8");
    const creds = JSON.parse(raw) as Partial<SidecarCredentials> & { accountEmail?: string };
    const email = creds.accountEmail;
    if (!email) {
      console.warn("[mc] Legacy credentials.json missing accountEmail — leaving in place");
      return;
    }
    const id = normalizeAccountId(email);
    const filename = emailToAccountFilename(id);
    const dir = join(ACCOUNTS_DIR, filename);
    if (!existsSync(ACCOUNTS_DIR)) mkdirSync(ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

    // Annotate with accountId for new format
    const upgraded: SidecarCredentials = {
      accountId: id,
      clientId: creds.clientId ?? "",
      clientSecret: creds.clientSecret ?? "",
      refreshToken: creds.refreshToken ?? "",
      accessToken: creds.accessToken ?? "",
      accessTokenExpiresAt: creds.accessTokenExpiresAt ?? new Date(0).toISOString(),
      accountEmail: email,
      scope: creds.scope ?? "",
      writtenAt: creds.writtenAt ?? new Date().toISOString(),
      writtenBy: creds.writtenBy ?? "plugin-migrated",
    };
    const finalPath = join(dir, "credentials.json");
    writeFileSync(finalPath, JSON.stringify(upgraded, null, 2), { encoding: "utf8", mode: 0o600 });
    chmodSync(finalPath, 0o600);

    // Write fresh index with this as primary
    writeAccountsIndex({
      schemaVersion: 1,
      primaryAccount: id,
      accounts: [
        {
          id,
          email,
          filename,
          scope: upgraded.scope,
          connectedAt: new Date().toISOString(),
          lastRefreshed: new Date().toISOString(),
          isPrimary: true,
        },
      ],
    });

    rmSync(LEGACY_CREDENTIALS_PATH, { force: true });
    console.log(`[mc] Migrated legacy credentials.json → accounts/${filename}/`);
  } catch (err) {
    console.error("[mc] Legacy sidecar migration failed:", err);
  }
}
