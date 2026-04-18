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

// Drive tool outputs
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
}

export interface DriveFileList {
  files: DriveFile[];
  nextPageToken: string | null;
}

export interface DriveFileContent {
  id: string;
  name: string;
  mimeType: string;
  /** utf-8 text OR base64-encoded binary */
  content: string;
  encoding: "utf-8" | "base64";
}

export interface DriveUploadResult {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
}

// Docs tool outputs
export interface DocDocument {
  documentId: string;
  title: string;
  content: string;
  revisionId?: string;
  format: "plain";
}

export interface DocCreateResult {
  documentId: string;
  title: string;
  webViewLink: string;
}

export interface DocUpdateResult {
  documentId: string;
  revisionId?: string;
  mode: "append" | "replace";
}

// Sheets tool outputs
export interface SheetTab {
  sheetId: number;
  title: string;
  index?: number;
  rowCount?: number;
  columnCount?: number;
}

export interface SheetsListResult {
  spreadsheetId: string;
  title: string;
  sheets: SheetTab[];
  webViewLink?: string;
}

export interface SheetsRangeData {
  spreadsheetId: string;
  range: string;
  majorDimension: "ROWS" | "COLUMNS";
  values: string[][];
}

export interface SheetsWriteResult {
  spreadsheetId: string;
  updatedRange?: string;
  updatedRows?: number;
  updatedColumns?: number;
  updatedCells?: number;
}

export interface SheetsCreateResult {
  spreadsheetId: string;
  title: string;
  webViewLink: string;
}

// Slides tool outputs
export interface SlideSummary {
  objectId: string;
  /** Plain text concatenated from all text elements on the slide */
  text: string;
}

export interface SlidesPresentation {
  presentationId: string;
  title: string;
  slideCount: number;
  slides: SlideSummary[];
  revisionId?: string;
}

export interface SlidesCreateResult {
  presentationId: string;
  title: string;
  webViewLink: string;
}

export interface SlidesAddSlideResult {
  presentationId: string;
  slideObjectId: string;
  index: number;
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
