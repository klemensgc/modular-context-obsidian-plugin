// Encrypted multi-account token storage — Electron safeStorage (OS keychain-backed).
// Per ADR-002 + ADR-005 (multi-account).
//
// Each account lives in its own folder with its own tokens.enc + meta.json.
// Root index file (accounts-index.json) tracks all accounts + primary selection.
//
// Legacy single-account layout (W1) auto-migrates on first access — see migrateLegacy().

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  emailToAccountFilename,
  normalizeAccountId,
  type AccountId,
  type AccountIndex,
  type AccountsIndex,
  type MultiTokenStorage,
  type StoredTokens,
  type TokenStorageMethod,
  type TokensMeta,
} from "@mc/shared";

const DATA_DIR = ".modular-context";
const ACCOUNTS_SUBDIR = "accounts";
const INDEX_FILENAME = "accounts-index.json";
const TOKENS_FILENAME = "tokens.enc";
const META_FILENAME = "tokens.meta.json";
const GITIGNORE_FILENAME = ".gitignore";

// Legacy single-account paths (W1)
const LEGACY_TOKENS = "tokens.enc";
const LEGACY_META = "tokens.meta.json";

export class EncryptionUnavailableError extends Error {
  constructor() {
    super(
      "OS-level encryption unavailable. On Linux, install libsecret and ensure a keyring daemon is running.",
    );
    this.name = "EncryptionUnavailableError";
  }
}

export class TamperedDataError extends Error {
  constructor() {
    super("Token file integrity check failed (decrypt returned empty or invalid)");
    this.name = "TamperedDataError";
  }
}

export class AccountNotFoundError extends Error {
  constructor(accountId: string) {
    super(`No account with id "${accountId}" in plugin storage`);
    this.name = "AccountNotFoundError";
  }
}

interface ElectronSafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

function getSafeStorage(): ElectronSafeStorage {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require("electron");
  const store = (electron.safeStorage ?? electron.remote?.safeStorage) as
    | ElectronSafeStorage
    | undefined;
  if (!store) {
    throw new EncryptionUnavailableError();
  }
  return store;
}

export interface StorageOptions {
  /** Absolute path to the vault root (plugin passes from app.vault.adapter) */
  vaultRoot: string;
  /** Unique identifier per vault — used in meta.keyId for audit trail */
  vaultId: string;
}

export class MultiAccountSafeStorage implements MultiTokenStorage {
  public readonly name = "safestorage-multi" as const;
  private readonly dataDir: string;
  private readonly accountsDir: string;
  private readonly indexPath: string;
  private readonly gitignorePath: string;
  private readonly vaultId: string;
  private migrationAttempted = false;

  constructor(opts: StorageOptions) {
    this.dataDir = join(opts.vaultRoot, DATA_DIR);
    this.accountsDir = join(this.dataDir, ACCOUNTS_SUBDIR);
    this.indexPath = join(this.dataDir, INDEX_FILENAME);
    this.gitignorePath = join(this.dataDir, GITIGNORE_FILENAME);
    this.vaultId = opts.vaultId;
  }

  async saveTokens(accountId: AccountId, tokens: StoredTokens): Promise<void> {
    this.ensureDataDir();
    this.ensureGitignore();
    await this.ensureMigrated();

    const storage = getSafeStorage();
    if (!storage.isEncryptionAvailable()) {
      throw new EncryptionUnavailableError();
    }

    const id = normalizeAccountId(accountId);
    const filename = emailToAccountFilename(id);
    const accountDir = join(this.accountsDir, filename);
    if (!existsSync(accountDir)) mkdirSync(accountDir, { recursive: true, mode: 0o700 });

    const tokensPath = join(accountDir, TOKENS_FILENAME);
    const metaPath = join(accountDir, META_FILENAME);

    const plaintext = JSON.stringify(tokens);
    const encrypted = storage.encryptString(plaintext);
    writeFileSync(tokensPath, encrypted, { mode: 0o600 });

    const meta: TokensMeta = {
      keyId: this.vaultId,
      algorithm: "aes-256-gcm",
      storageMethod: "keyring",
      encryptedAt: new Date().toISOString(),
      schemaVersion: 1,
    };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });

    // Update index — upsert account entry
    const index = this.readIndexSync();
    const existing = index.accounts.find((a) => a.id === id);
    if (existing) {
      existing.scope = tokens.scope;
      existing.email = tokens.accountEmail;
      existing.lastRefreshed = new Date().toISOString();
    } else {
      const entry: AccountIndex = {
        id,
        email: tokens.accountEmail,
        filename,
        scope: tokens.scope,
        connectedAt: new Date().toISOString(),
        lastRefreshed: new Date().toISOString(),
        isPrimary: index.accounts.length === 0, // first one is primary
      };
      index.accounts.push(entry);
      if (entry.isPrimary) index.primaryAccount = entry.id;
    }
    this.writeIndex(index);
  }

  async loadTokens(accountId: AccountId): Promise<StoredTokens | null> {
    await this.ensureMigrated();
    const id = normalizeAccountId(accountId);
    const filename = emailToAccountFilename(id);
    const tokensPath = join(this.accountsDir, filename, TOKENS_FILENAME);
    const metaPath = join(this.accountsDir, filename, META_FILENAME);

    if (!existsSync(tokensPath) || !existsSync(metaPath)) return null;

    const storage = getSafeStorage();
    if (!storage.isEncryptionAvailable()) {
      throw new EncryptionUnavailableError();
    }

    const encrypted = readFileSync(tokensPath);
    let plaintext: string;
    try {
      plaintext = storage.decryptString(encrypted);
    } catch {
      throw new TamperedDataError();
    }
    if (!plaintext) throw new TamperedDataError();
    return JSON.parse(plaintext) as StoredTokens;
  }

  async removeAccount(accountId: AccountId): Promise<void> {
    await this.ensureMigrated();
    const id = normalizeAccountId(accountId);
    const filename = emailToAccountFilename(id);
    const accountDir = join(this.accountsDir, filename);
    if (existsSync(accountDir)) rmSync(accountDir, { recursive: true, force: true });

    const index = this.readIndexSync();
    const wasPrimary = index.primaryAccount === id;
    index.accounts = index.accounts.filter((a) => a.id !== id);
    if (wasPrimary) {
      // Promote first remaining or clear
      if (index.accounts.length > 0) {
        index.accounts[0].isPrimary = true;
        index.primaryAccount = index.accounts[0].id;
        for (let i = 1; i < index.accounts.length; i++) index.accounts[i].isPrimary = false;
      } else {
        index.primaryAccount = null;
      }
    }
    this.writeIndex(index);
  }

  async listAccounts(): Promise<AccountIndex[]> {
    await this.ensureMigrated();
    return this.readIndexSync().accounts;
  }

  async getPrimaryAccountId(): Promise<AccountId | null> {
    await this.ensureMigrated();
    return this.readIndexSync().primaryAccount;
  }

  async setPrimary(accountId: AccountId): Promise<void> {
    await this.ensureMigrated();
    const id = normalizeAccountId(accountId);
    const index = this.readIndexSync();
    const target = index.accounts.find((a) => a.id === id);
    if (!target) throw new AccountNotFoundError(id);
    for (const a of index.accounts) a.isPrimary = a.id === id;
    index.primaryAccount = id;
    this.writeIndex(index);
  }

  async readIndex(): Promise<AccountsIndex> {
    await this.ensureMigrated();
    return this.readIndexSync();
  }

  // --- internals ---

  private readIndexSync(): AccountsIndex {
    if (!existsSync(this.indexPath)) {
      return { schemaVersion: 1, primaryAccount: null, accounts: [] };
    }
    try {
      return JSON.parse(readFileSync(this.indexPath, "utf8")) as AccountsIndex;
    } catch {
      return { schemaVersion: 1, primaryAccount: null, accounts: [] };
    }
  }

  private writeIndex(index: AccountsIndex): void {
    // Enforce invariant: exactly one primary iff accounts non-empty
    if (index.accounts.length > 0) {
      const primaryCount = index.accounts.filter((a) => a.isPrimary).length;
      if (primaryCount === 0) {
        index.accounts[0].isPrimary = true;
        index.primaryAccount = index.accounts[0].id;
      } else if (primaryCount > 1) {
        let first = true;
        for (const a of index.accounts) {
          if (a.isPrimary && !first) a.isPrimary = false;
          if (a.isPrimary) first = false;
        }
      }
    } else {
      index.primaryAccount = null;
    }
    writeFileSync(this.indexPath, JSON.stringify(index, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  private ensureDataDir(): void {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    }
    if (!existsSync(this.accountsDir)) {
      mkdirSync(this.accountsDir, { recursive: true, mode: 0o700 });
    }
  }

  private ensureGitignore(): void {
    if (existsSync(this.gitignorePath)) return;
    const content = [
      "# Auto-generated by modular-context — Google Workspace tokens",
      "# NEVER commit these files — they contain encrypted OAuth tokens",
      "accounts/",
      INDEX_FILENAME,
      TOKENS_FILENAME,
      META_FILENAME,
      "",
    ].join("\n");
    writeFileSync(this.gitignorePath, content, { encoding: "utf8" });
  }

  /**
   * One-shot migration from W1 single-account layout to multi-account.
   * Safe to call repeatedly — no-op if legacy files absent.
   */
  private async ensureMigrated(): Promise<void> {
    if (this.migrationAttempted) return;
    this.migrationAttempted = true;

    const legacyTokens = join(this.dataDir, LEGACY_TOKENS);
    const legacyMeta = join(this.dataDir, LEGACY_META);
    if (!existsSync(legacyTokens) || !existsSync(legacyMeta)) return;

    // If accounts/ exists with any entries, legacy state is stale — remove legacy files
    if (existsSync(this.accountsDir)) {
      const entries = readdirSync(this.accountsDir).filter((n) => !n.startsWith("."));
      if (entries.length > 0) {
        console.warn("[mc] Legacy tokens.enc present alongside multi-account layout; removing legacy");
        rmSync(legacyTokens, { force: true });
        rmSync(legacyMeta, { force: true });
        return;
      }
    }

    try {
      // Decrypt legacy file to derive email
      const storage = getSafeStorage();
      if (!storage.isEncryptionAvailable()) {
        console.warn("[mc] safeStorage unavailable during migration — will retry next boot");
        this.migrationAttempted = false;
        return;
      }
      const encrypted = readFileSync(legacyTokens);
      const plaintext = storage.decryptString(encrypted);
      if (!plaintext) {
        console.warn("[mc] Legacy tokens decrypt returned empty — leaving in place");
        return;
      }
      const tokens = JSON.parse(plaintext) as StoredTokens;
      const accountEmail = tokens.accountEmail;
      if (!accountEmail) {
        console.warn("[mc] Legacy tokens missing accountEmail — leaving in place");
        return;
      }
      const id = normalizeAccountId(accountEmail);
      const filename = emailToAccountFilename(id);
      const accountDir = join(this.accountsDir, filename);
      if (!existsSync(this.accountsDir)) mkdirSync(this.accountsDir, { recursive: true, mode: 0o700 });
      if (!existsSync(accountDir)) mkdirSync(accountDir, { recursive: true, mode: 0o700 });

      // Move legacy files into account dir
      renameSync(legacyTokens, join(accountDir, TOKENS_FILENAME));
      renameSync(legacyMeta, join(accountDir, META_FILENAME));

      // Write index
      const index: AccountsIndex = {
        schemaVersion: 1,
        primaryAccount: id,
        accounts: [
          {
            id,
            email: accountEmail,
            filename,
            scope: tokens.scope,
            connectedAt: new Date().toISOString(),
            isPrimary: true,
          },
        ],
      };
      this.writeIndex(index);

      console.log(`[mc] Migrated legacy single-account tokens → accounts/${filename}/`);
    } catch (err) {
      console.error("[mc] Legacy migration failed — leaving files intact:", err);
      // Reset flag so we retry on next boot
      this.migrationAttempted = false;
    }
  }
}

/**
 * Legacy single-account adapter over MultiAccountSafeStorage.
 * Operates on the primary account. Preserved for call sites that haven't been
 * updated to multi-account API yet.
 */
export class SafeStorageMethod implements TokenStorageMethod {
  public readonly name = "keyring" as const;
  private readonly multi: MultiAccountSafeStorage;

  constructor(opts: StorageOptions) {
    this.multi = new MultiAccountSafeStorage(opts);
  }

  async saveTokens(tokens: StoredTokens): Promise<void> {
    const id = normalizeAccountId(tokens.accountEmail);
    await this.multi.saveTokens(id, tokens);
    // Ensure this account is primary (adapter semantics)
    const primary = await this.multi.getPrimaryAccountId();
    if (primary !== id) await this.multi.setPrimary(id);
  }

  async loadTokens(): Promise<StoredTokens | null> {
    const primary = await this.multi.getPrimaryAccountId();
    if (!primary) return null;
    return this.multi.loadTokens(primary);
  }

  async clearTokens(): Promise<void> {
    const primary = await this.multi.getPrimaryAccountId();
    if (!primary) return;
    await this.multi.removeAccount(primary);
  }

  /** Escape hatch for callers that want the underlying multi-account API. */
  getMulti(): MultiAccountSafeStorage {
    return this.multi;
  }
}

export function createStorageMethod(opts: StorageOptions): TokenStorageMethod {
  return new SafeStorageMethod(opts);
}

export function createMultiAccountStorage(opts: StorageOptions): MultiAccountSafeStorage {
  return new MultiAccountSafeStorage(opts);
}
