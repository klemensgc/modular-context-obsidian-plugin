// Loopback HTTP server for OAuth callback.
// Binds to 127.0.0.1 on ephemeral port, captures authorization code from /callback.
// Per ADR-001 and research/01-oauth-desktop-flow.md.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { QUICK_CONNECT_TEST_USER_ISSUE_URL } from "../constants";

const CALLBACK_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

export class OAuthStateError extends Error {
  constructor() {
    super("OAuth state parameter mismatch (possible CSRF attack or stale flow)");
    this.name = "OAuthStateError";
  }
}

export class OAuthDeniedError extends Error {
  public readonly googleError: string;
  constructor(googleError: string) {
    super(`User denied OAuth consent: ${googleError}`);
    this.name = "OAuthDeniedError";
    this.googleError = googleError;
  }
}

export class OAuthTimeoutError extends Error {
  constructor() {
    super(`OAuth callback not received within ${CALLBACK_TIMEOUT_MS / 1000}s`);
    this.name = "OAuthTimeoutError";
  }
}

export interface LoopbackServer {
  port: number;
  waitForCode(expectedState: string): Promise<string>;
  close(): Promise<void>;
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Connected</title>
<style>
body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 60px 24px; text-align: center; background: #f7f7f8; color: #222; }
.card { max-width: 420px; margin: 0 auto; background: white; border-radius: 12px; padding: 40px 32px; box-shadow: 0 4px 24px rgba(0,0,0,0.06); }
.check { color: #16a34a; font-size: 56px; margin-bottom: 16px; }
h1 { font-size: 22px; margin: 0 0 8px; }
p { color: #555; font-size: 14px; margin: 0; line-height: 1.5; }
</style>
</head>
<body>
<div class="card">
  <div class="check">✓</div>
  <h1>Connected</h1>
  <p>You can close this tab and return to Obsidian.</p>
</div>
</body>
</html>`;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const ERROR_HTML_TEMPLATE = (msg: string, extraHtml = ""): string => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Connection failed</title>
<style>
body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 60px 24px; text-align: center; background: #f7f7f8; color: #222; }
.card { max-width: 420px; margin: 0 auto; background: white; border-radius: 12px; padding: 40px 32px; box-shadow: 0 4px 24px rgba(0,0,0,0.06); }
.x { color: #dc2626; font-size: 56px; margin-bottom: 16px; }
h1 { font-size: 22px; margin: 0 0 8px; }
p { color: #555; font-size: 14px; margin: 0; line-height: 1.5; }
.hint { margin-top: 16px; font-size: 13px; color: #666; }
.hint a { color: #1976d2; text-decoration: none; }
.hint a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="card">
  <div class="x">✗</div>
  <h1>Connection failed</h1>
  <p>${escapeHtml(msg)}. You can close this tab and retry in Obsidian.</p>
  ${extraHtml}
</div>
</body>
</html>`;

const ACCESS_DENIED_QUICK_CONNECT_HTML = `<p class="hint">Quick Connect is in Google Testing mode. Comment your Google account email on <a href="${QUICK_CONNECT_TEST_USER_ISSUE_URL}" target="_blank" rel="noopener">issue #3</a> to be added as a test user.</p>`;

const ACCESS_DENIED_BYO_HTML = `<p class="hint">Add this Google account as a test user on your OAuth consent screen in Google Cloud Console, then try again.</p>`;

function oauthErrorPage(googleError: string, quickConnect: boolean): string {
  if (googleError === "access_denied") {
    return ERROR_HTML_TEMPLATE(
      quickConnect
        ? "OAuth denied (access_denied) — your account is not on the Quick Connect test-users list yet"
        : "OAuth denied (access_denied) — add this account as a test user in your GCP project",
      quickConnect ? ACCESS_DENIED_QUICK_CONNECT_HTML : ACCESS_DENIED_BYO_HTML,
    );
  }
  return ERROR_HTML_TEMPLATE(`OAuth denied (${googleError})`);
}

export async function startLoopbackServer(quickConnect = true): Promise<LoopbackServer> {
  let resolveCode: ((code: string) => void) | null = null;
  let rejectCode: ((err: Error) => void) | null = null;
  let expectedState: string | null = null;
  let timeoutHandle: NodeJS.Timeout | null = null;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    // Parse path + query
    const urlObj = new URL(url, `http://127.0.0.1`);
    if (urlObj.pathname !== "/callback") {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const params = urlObj.searchParams;
    const error = params.get("error");
    const code = params.get("code");
    const state = params.get("state");

    // Case 1: user denied or Google returned error
    if (error) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(oauthErrorPage(error, quickConnect));
      if (rejectCode) rejectCode(new OAuthDeniedError(error));
      return;
    }

    // Case 2: missing required params
    if (!code || !state) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(ERROR_HTML_TEMPLATE("Missing code or state parameter"));
      if (rejectCode) rejectCode(new Error("Missing code or state in callback"));
      return;
    }

    // Case 3: state mismatch (CSRF protection)
    if (expectedState === null || state !== expectedState) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(ERROR_HTML_TEMPLATE("State parameter mismatch"));
      if (rejectCode) rejectCode(new OAuthStateError());
      return;
    }

    // Case 4: success
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(SUCCESS_HTML);
    if (resolveCode) resolveCode(code);
  });

  // Bind to 127.0.0.1:0 — OS assigns ephemeral port
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const close = async (): Promise<void> => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Force-destroy any hanging connections
      server.closeAllConnections?.();
    });
  };

  const waitForCode = (state: string): Promise<string> => {
    expectedState = state;
    return new Promise<string>((resolve, reject) => {
      resolveCode = (code: string) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        resolve(code);
      };
      rejectCode = (err: Error) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        reject(err);
      };
      timeoutHandle = setTimeout(() => {
        rejectCode?.(new OAuthTimeoutError());
      }, CALLBACK_TIMEOUT_MS);
    });
  };

  return { port, waitForCode, close };
}
