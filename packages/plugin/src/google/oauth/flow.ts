// OAuth 2.0 desktop flow orchestrator.
// Implements RFC 8252 (OAuth for Native Apps) + RFC 7636 (PKCE S256).
// Per ADR-001 — supports both Quick Connect (shared client) and BYO (user-provided).

import { randomBytes } from "node:crypto";
import type { OAuthConfig, StoredTokens } from "@mc/shared";
import { GOOGLE_WORKSPACE_SCOPES } from "@mc/shared";
import { generateCodeVerifier, challengeFromVerifier } from "./pkce";
import { startLoopbackServer } from "./loopback-server";

// Re-export from loopback-server for consumers
export {
  OAuthDeniedError,
  OAuthTimeoutError,
  OAuthStateError,
} from "./loopback-server";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

export class TokenExchangeError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(`Token exchange failed: ${message}`);
    this.name = "TokenExchangeError";
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
  id_token?: string;
}

interface UserInfoResponse {
  email: string;
  id: string;
  verified_email?: boolean;
}

/**
 * Open URL in user's default browser.
 * Uses Electron's shell.openExternal when available (Obsidian runtime).
 */
async function openBrowser(url: string): Promise<void> {
  try {
    // Dynamic require — avoids bundling electron
    // Obsidian plugin runtime has access to electron module via node
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron");
    if (electron?.shell?.openExternal) {
      await electron.shell.openExternal(url);
      return;
    }
  } catch {
    // Fall through to fallback below
  }
  throw new Error(
    "Unable to open browser (electron.shell.openExternal unavailable). " +
      "This flow requires Obsidian desktop runtime.",
  );
}

/**
 * Execute full OAuth 2.0 desktop flow.
 * Returns StoredTokens on success, throws typed errors on failure.
 *
 * Flow:
 *   1. Generate PKCE pair (verifier + S256 challenge)
 *   2. Start loopback HTTP server on ephemeral port
 *   3. Build authorization URL + open user's browser
 *   4. Wait for callback with authorization code
 *   5. Exchange code for tokens (with code_verifier)
 *   6. Fetch user email for display
 *   7. Close loopback server
 */
export async function startOAuthFlow(config: OAuthConfig): Promise<StoredTokens> {
  if (!config.clientId) {
    throw new Error("OAuth config missing clientId");
  }
  if (!config.clientSecret) {
    throw new Error("OAuth config missing clientSecret");
  }

  const scopes = config.scopes.length > 0 ? config.scopes : [...GOOGLE_WORKSPACE_SCOPES];
  const verifier = generateCodeVerifier();
  const challenge = challengeFromVerifier(verifier);
  const state = randomBytes(16).toString("hex");

  const server = await startLoopbackServer(config.mode === "quick-connect");
  try {
    const redirectUri = `http://127.0.0.1:${server.port}/callback`;
    const authUrl = new URL(AUTH_URL);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", config.clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", scopes.join(" "));
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");

    await openBrowser(authUrl.toString());

    const code = await server.waitForCode(state);
    const tokens = await exchangeCodeForTokens(code, verifier, redirectUri, config);
    const accountEmail = await fetchUserEmail(tokens.access_token);

    const now = Date.now();
    const stored: StoredTokens = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? "",
      scope: tokens.scope,
      expiresAt: now + tokens.expires_in * 1000,
      tokenType: "Bearer",
      accountEmail,
    };

    if (!stored.refreshToken) {
      throw new TokenExchangeError(
        "Google did not return refresh_token. " +
          "This usually means the user has already authorized — force re-consent by revoking access at myaccount.google.com.",
      );
    }

    return stored;
  } finally {
    await server.close().catch(() => undefined);
  }
}

async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  config: OAuthConfig,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new TokenExchangeError(`HTTP ${response.status}: ${text.slice(0, 200)}`, {
      status: response.status,
    });
  }

  const data = (await response.json()) as TokenResponse;
  if (!data.access_token || typeof data.expires_in !== "number") {
    throw new TokenExchangeError("Response missing access_token or expires_in");
  }
  return data;
}

async function fetchUserEmail(accessToken: string): Promise<string> {
  const response = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new TokenExchangeError(
      `userinfo endpoint failed: HTTP ${response.status}: ${text.slice(0, 200)}`,
    );
  }
  const data = (await response.json()) as UserInfoResponse;
  if (!data.email) {
    throw new TokenExchangeError("userinfo response missing email");
  }
  return data.email;
}
