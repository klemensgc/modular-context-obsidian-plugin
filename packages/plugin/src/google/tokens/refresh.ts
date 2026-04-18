// Token refresh logic — background timer + valid access token getter.
// Per ADR-002 and research/01-oauth-desktop-flow.md.

import type { OAuthConfig, StoredTokens, TokenStorageMethod } from "@mc/shared";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // refresh if <5min to expiry
const REFRESH_TIMER_INTERVAL_MS = 50 * 60 * 1000; // 50min — access token lives 1h

export class RefreshTokenInvalidError extends Error {
  constructor() {
    super("Refresh token invalid (revoked or rotated) — reconnect required");
    this.name = "RefreshTokenInvalidError";
  }
}

interface RefreshResponse {
  access_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
  refresh_token?: string; // may be rotated
}

export interface RefreshOptions {
  storage: TokenStorageMethod;
  config: OAuthConfig;
}

/**
 * Get a valid access token. Refreshes in-place if expired or near-expiry.
 * Returns null if no tokens stored OR refresh token invalidated.
 */
export async function getValidAccessToken(opts: RefreshOptions): Promise<string | null> {
  const tokens = await opts.storage.loadTokens();
  if (!tokens) return null;

  const now = Date.now();
  if (tokens.expiresAt > now + REFRESH_THRESHOLD_MS) {
    // Still valid
    return tokens.accessToken;
  }

  // Need refresh
  if (!tokens.refreshToken) {
    return null; // no way to refresh — treat as disconnected
  }
  try {
    const refreshed = await refreshTokens(tokens.refreshToken, opts.config);
    const updated: StoredTokens = {
      ...tokens,
      accessToken: refreshed.access_token,
      expiresAt: Date.now() + refreshed.expires_in * 1000,
      scope: refreshed.scope,
      // Rotation: if Google returned new refresh_token, use it
      refreshToken: refreshed.refresh_token ?? tokens.refreshToken,
    };
    await opts.storage.saveTokens(updated);
    return updated.accessToken;
  } catch (err) {
    if (err instanceof RefreshTokenInvalidError) {
      return null; // caller should show "reconnect needed" UI
    }
    throw err;
  }
}

/**
 * Direct refresh API call. Throws RefreshTokenInvalidError on invalid_grant.
 */
export async function refreshTokens(
  refreshToken: string,
  config: OAuthConfig,
): Promise<RefreshResponse> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (response.status === 400 || response.status === 401) {
    const text = await response.text().catch(() => "");
    if (text.includes("invalid_grant")) {
      throw new RefreshTokenInvalidError();
    }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Refresh failed: HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  return (await response.json()) as RefreshResponse;
}

export interface RefreshTimerHandle {
  cancel(): void;
}

/**
 * Start background timer that proactively refreshes tokens before expiry.
 * Returns a handle for plugin lifecycle cleanup (call cancel() in onunload).
 */
export function startRefreshTimer(opts: RefreshOptions): RefreshTimerHandle {
  const handle = setInterval(() => {
    void getValidAccessToken(opts).catch(() => {
      // Silent — UI surfaces through other paths (status command, connect modal)
    });
  }, REFRESH_TIMER_INTERVAL_MS);

  return {
    cancel: () => clearInterval(handle),
  };
}
