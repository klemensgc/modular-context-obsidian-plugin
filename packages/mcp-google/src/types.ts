// Shared types for MCP Google Workspace server.
// Per ADR-003 + ADR-003-addendum-shared-state.

export enum MCGoogleError {
  TOKEN_MISSING = "TOKEN_MISSING",
  TOKEN_EXPIRED = "TOKEN_EXPIRED",
  TOKEN_INVALID = "TOKEN_INVALID",
  ACCOUNT_NOT_FOUND = "ACCOUNT_NOT_FOUND",
  SCOPE_OUTDATED = "SCOPE_OUTDATED",
  PERMISSION_DENIED = "PERMISSION_DENIED",
  RATE_LIMITED = "RATE_LIMITED",
  QUOTA_EXCEEDED = "QUOTA_EXCEEDED",
  NETWORK_ERROR = "NETWORK_ERROR",
  UNKNOWN = "UNKNOWN",
}

/**
 * Plaintext credentials sidecar written by plugin, read by this server.
 * See ADR-003 addendum for security analysis.
 */
export interface SharedCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken: string;
  /** ISO 8601 string — compared against Date.now() */
  accessTokenExpiresAt: string;
  accountEmail: string;
  scope: string;
  writtenAt: string;
  writtenBy: string;
}

export class MCPToolError extends Error {
  constructor(
    public readonly code: MCGoogleError,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "MCPToolError";
  }
}

// Tool output types (what tools return)

export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  body?: string;
}

export interface GmailDraftResult {
  draftId: string;
  webUrl: string;
}

export interface CalendarEventAttendee {
  email: string;
  displayName?: string;
  responseStatus?: string;
  optional?: boolean;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  attendees: CalendarEventAttendee[];
  location?: string;
  meetingLink?: string;
  htmlLink: string;
}

// Environment contract — set by plugin via .mcp.json
// Multi-account aware (ADR-005): prefer accountsDir + accountsIndexPath; fall back to
// legacyCredentialsPath if only old env var set.
export interface ServerEnv {
  /** Multi-account sidecar root: ~/.modular-context/mcp-google/accounts */
  accountsDir?: string;
  /** Multi-account index: ~/.modular-context/mcp-google/accounts-index.json */
  accountsIndexPath?: string;
  /** Legacy W2 single-file sidecar — fallback only when multi-account absent */
  legacyCredentialsPath?: string;
  logPath?: string;
  logLevel: "ERROR" | "WARN" | "INFO" | "DEBUG";
}

export function parseEnv(env: NodeJS.ProcessEnv): ServerEnv {
  const accountsDir = env.MC_ACCOUNTS_DIR;
  const accountsIndexPath = env.MC_ACCOUNTS_INDEX;
  const legacyCredentialsPath = env.MC_CREDENTIALS_PATH;

  if (!accountsDir && !legacyCredentialsPath) {
    throw new MCPToolError(
      MCGoogleError.TOKEN_MISSING,
      "Neither MC_ACCOUNTS_DIR nor MC_CREDENTIALS_PATH set — plugin must write .mcp.json first",
    );
  }

  const logLevel = (env.MC_LOG_LEVEL ?? "INFO").toUpperCase() as ServerEnv["logLevel"];
  const validLevels: ServerEnv["logLevel"][] = ["ERROR", "WARN", "INFO", "DEBUG"];
  return {
    accountsDir,
    accountsIndexPath,
    legacyCredentialsPath,
    logPath: env.MC_LOG_PATH,
    logLevel: validLevels.includes(logLevel) ? logLevel : "INFO",
  };
}
