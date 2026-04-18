// Shared Google Workspace types — per ADR-002 (token storage) and ADR-003 (MCP contract).
// Used by both plugin (packages/plugin) and MCP server (packages/mcp-google — W2+).

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
  // Schema version — increment on breaking format changes
  schemaVersion: 1;
}

// Errors surfaced by MCP server to client (Claude Code)
export enum MCGoogleError {
  TOKEN_MISSING = "TOKEN_MISSING",
  TOKEN_EXPIRED = "TOKEN_EXPIRED",
  TOKEN_INVALID = "TOKEN_INVALID",
  QUOTA_EXCEEDED = "QUOTA_EXCEEDED",
  NETWORK_ERROR = "NETWORK_ERROR",
  PERMISSION_DENIED = "PERMISSION_DENIED",
  RATE_LIMITED = "RATE_LIMITED",
  UNKNOWN = "UNKNOWN",
}

// Restricted scopes per Google (all 3 we request are restricted — see research/01-oauth-desktop-flow)
export const GOOGLE_WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
] as const;

export type GoogleWorkspaceScope = (typeof GOOGLE_WORKSPACE_SCOPES)[number];
