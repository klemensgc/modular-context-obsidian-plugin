// Shared Google Workspace types — per ADR-002 (token storage), ADR-003 (MCP contract),
// ADR-003-addendum (sidecar), ADR-005 (multi-account).
// Used by both plugin (packages/plugin) and MCP server (packages/mcp-google).

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  scope: string;
  expiresAt: number; // unix ms
  tokenType: "Bearer";
  accountEmail: string;
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  scopes: string[];
  // "quick-connect" uses shared/embedded client; "byo" uses user-provided
  mode: "quick-connect" | "byo";
}

// Multi-account storage contract (ADR-005).
export type AccountId = string; // normalized email (lowercase, trimmed)

export interface AccountIndex {
  id: AccountId;
  email: string;                 // display email (original case)
  filename: string;              // emailToAccountFilename(id)
  scope: string;                 // space-joined scopes granted to this account
  connectedAt: string;           // ISO 8601
  lastRefreshed?: string;        // ISO 8601 — updated on each successful refresh
  isPrimary: boolean;            // exactly one account has true iff accounts.length > 0
}

export interface AccountsIndex {
  schemaVersion: 1;
  primaryAccount: AccountId | null;
  accounts: AccountIndex[];
}

/**
 * Multi-account storage interface (ADR-005). All methods take accountId.
 * Legacy single-account API preserved via adapter (TokenStorageMethod).
 */
export interface MultiTokenStorage {
  readonly name: "safestorage-multi";
  saveTokens(accountId: AccountId, tokens: StoredTokens): Promise<void>;
  loadTokens(accountId: AccountId): Promise<StoredTokens | null>;
  removeAccount(accountId: AccountId): Promise<void>;
  listAccounts(): Promise<AccountIndex[]>;
  getPrimaryAccountId(): Promise<AccountId | null>;
  setPrimary(accountId: AccountId): Promise<void>;
  readIndex(): Promise<AccountsIndex>;
}

/**
 * Legacy single-account storage (W1). Keep for backwards compat and migration.
 * New code should use MultiTokenStorage.
 */
export interface TokenStorageMethod {
  readonly name: "keyring" | "obsidian-secret-storage" | "passphrase";
  saveTokens(tokens: StoredTokens): Promise<void>;
  loadTokens(): Promise<StoredTokens | null>;
  clearTokens(): Promise<void>;
}

// Encryption metadata saved next to tokens.enc (per ADR-002)
export interface TokensMeta {
  keyId: string;
  algorithm: "aes-256-gcm";
  storageMethod: TokenStorageMethod["name"];
  encryptedAt: string; // ISO 8601
  schemaVersion: 1;
}

// Errors surfaced by MCP server to client (Claude Code)
export enum MCGoogleError {
  TOKEN_MISSING = "TOKEN_MISSING",
  TOKEN_EXPIRED = "TOKEN_EXPIRED",
  TOKEN_INVALID = "TOKEN_INVALID",
  ACCOUNT_NOT_FOUND = "ACCOUNT_NOT_FOUND",
  SCOPE_OUTDATED = "SCOPE_OUTDATED",
  QUOTA_EXCEEDED = "QUOTA_EXCEEDED",
  NETWORK_ERROR = "NETWORK_ERROR",
  PERMISSION_DENIED = "PERMISSION_DENIED",
  RATE_LIMITED = "RATE_LIMITED",
  DRIVE_API_ERROR = "DRIVE_API_ERROR",
  DRIVE_FILE_NOT_FOUND = "DRIVE_FILE_NOT_FOUND",
  DRIVE_UPLOAD_FAILED = "DRIVE_UPLOAD_FAILED",
  DOCS_API_ERROR = "DOCS_API_ERROR",
  DOCS_NOT_FOUND = "DOCS_NOT_FOUND",
  SHEETS_API_ERROR = "SHEETS_API_ERROR",
  SHEETS_NOT_FOUND = "SHEETS_NOT_FOUND",
  SHEETS_INVALID_RANGE = "SHEETS_INVALID_RANGE",
  SLIDES_API_ERROR = "SLIDES_API_ERROR",
  SLIDES_NOT_FOUND = "SLIDES_NOT_FOUND",
  UNKNOWN = "UNKNOWN",
}

/**
 * Updated scope set (v1.2 expansion — Docs + Drive):
 * - `gmail.modify` covers read + send + labels + archive + trash
 * - `calendar` (full) covers list-calendars + CRUD + freebusy
 * - `drive.file` covers read/write files created/opened by the app
 * - `drive.metadata.readonly` covers listing/searching files beyond app scope
 * - `documents` covers full Docs read/write
 * - OIDC: openid + email + profile (required for userinfo endpoint)
 *
 * Restricted scopes (gmail.modify, calendar, drive.file) require CASA for production,
 * but Testing mode (<100 users) exempts them. See ADR-001 for rationale.
 *
 * Existing users upgrading from v1.1 must re-authenticate (SCOPE_OUTDATED surfaced
 * via computeMissingScopes helper below).
 */
export const GOOGLE_WORKSPACE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/presentations",
] as const;

export type GoogleWorkspaceScope = (typeof GOOGLE_WORKSPACE_SCOPES)[number];

/**
 * Normalize email → FS-safe filename for per-account directories.
 * E.g. "Apollo@receptionos.com" → "apollo-at-receptionos-com"
 */
export function emailToAccountFilename(email: string): string {
  return email
    .toLowerCase()
    .trim()
    .replace(/@/g, "-at-")
    .replace(/\./g, "-");
}

/**
 * Canonical account ID from an email (for use as AccountId).
 */
export function normalizeAccountId(email: string): AccountId {
  return email.toLowerCase().trim();
}

/**
 * Check whether the scope string from a stored token covers all required scopes.
 * Returns list of missing scopes (empty array means fully covered).
 */
export function computeMissingScopes(
  grantedScopeString: string,
  required: readonly string[] = GOOGLE_WORKSPACE_SCOPES,
): string[] {
  const granted = new Set(grantedScopeString.split(/\s+/).filter(Boolean));
  return required.filter((s) => !granted.has(s));
}
