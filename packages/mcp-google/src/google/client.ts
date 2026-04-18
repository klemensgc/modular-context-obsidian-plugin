// googleapis wrappers + error mapping.

import {
  gmail_v1,
  google,
  calendar_v3,
  drive_v3,
  docs_v1,
  sheets_v4,
  slides_v1,
} from "googleapis";
import { MCGoogleError, MCPToolError } from "../types.js";

export function createGmailClient(accessToken: string): gmail_v1.Gmail {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.gmail({ version: "v1", auth });
}

export function createCalendarClient(accessToken: string): calendar_v3.Calendar {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.calendar({ version: "v3", auth });
}

export function createDriveClient(accessToken: string): drive_v3.Drive {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.drive({ version: "v3", auth });
}

export function createDocsClient(accessToken: string): docs_v1.Docs {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.docs({ version: "v1", auth });
}

export function createSheetsClient(accessToken: string): sheets_v4.Sheets {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.sheets({ version: "v4", auth });
}

export function createSlidesClient(accessToken: string): slides_v1.Slides {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.slides({ version: "v1", auth });
}

/**
 * Maps googleapis errors to MCPToolError with proper taxonomy.
 * Wrap every Google API call in this to get consistent errors up the stack.
 */
export async function callGoogleApi<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    throw mapGoogleError(label, err);
  }
}

function mapGoogleError(label: string, err: unknown): MCPToolError {
  const anyErr = err as { code?: number; status?: number; message?: string; errors?: unknown[] };
  const status = anyErr.code ?? anyErr.status;
  const message = anyErr.message ?? String(err);

  if (status === 401) {
    return new MCPToolError(
      MCGoogleError.TOKEN_EXPIRED,
      `${label}: HTTP 401 — access token rejected, likely expired or revoked`,
      err,
    );
  }
  if (status === 403) {
    if (message.toLowerCase().includes("insufficient")) {
      return new MCPToolError(
        MCGoogleError.PERMISSION_DENIED,
        `${label}: HTTP 403 — insufficient OAuth scope. Reconnect via plugin with fresh consent.`,
        err,
      );
    }
    return new MCPToolError(
      MCGoogleError.PERMISSION_DENIED,
      `${label}: HTTP 403 — ${message}`,
      err,
    );
  }
  if (status === 429) {
    return new MCPToolError(
      MCGoogleError.RATE_LIMITED,
      `${label}: HTTP 429 — Google API rate limit. Retry with backoff.`,
      err,
    );
  }
  if (typeof status === "number" && status >= 500) {
    return new MCPToolError(
      MCGoogleError.NETWORK_ERROR,
      `${label}: HTTP ${status} — Google server error (transient, retry may succeed)`,
      err,
    );
  }
  if (message.toLowerCase().includes("quota")) {
    return new MCPToolError(MCGoogleError.QUOTA_EXCEEDED, `${label}: ${message}`, err);
  }
  return new MCPToolError(
    MCGoogleError.UNKNOWN,
    `${label}: ${message}`,
    err,
  );
}
