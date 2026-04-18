// Token refresh logic — background timer + valid access token getter.
// Multi-account (ADR-005) + scope coverage enforcement.

import {
  computeMissingScopes,
  GOOGLE_WORKSPACE_SCOPES,
  type AccountId,
  type MultiTokenStorage,
  type OAuthConfig,
  type StoredTokens,
  type TokenStorageMethod,
} from "@mc/shared";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;
const REFRESH_TIMER_INTERVAL_MS = 50 * 60 * 1000;

export class RefreshTokenInvalidError extends Error {
  constructor() {
    super("Refresh token invalid (revoked or rotated) — reconnect required");
    this.name = "RefreshTokenInvalidError";
  }
}

export class ScopeOutdatedError extends Error {
  constructor(public readonly missing: string[]) {
    super(
      `Account scopes outdated. Missing: ${missing.join(", ")}. Reconnect required with expanded scope set.`,
    );
    this.name = "ScopeOutdatedError";
  }
}

interface RefreshResponse {
  access_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
  refresh_token?: string;
}

/**
 * Single-account refresh options (legacy W1 API — still used in startup checks).
 */
export interface RefreshOptions {
  storage: TokenStorageMethod;
  config: OAuthConfig;
  onTokensUpdated?: (tokens: StoredTokens) => void | Promise<void>;
}

/**
 * Multi-account refresh options — used by timer and tool calls.
 */
export interface MultiRefreshOptions {
  multiStorage: MultiTokenStorage;
  config: OAuthConfig;
  onTokensUpdated?: (accountId: AccountId, tokens: StoredTokens) => void | Promise<void>;
  /** If true, skip scope coverage check (used during migration or by recovery flows). */
  skipScopeCheck?: boolean;
}

/**
 * Legacy single-account getter — operates on primary account.
 */
export async function getValidAccessToken(opts: RefreshOptions): Promise<string | null> {
  const tokens = await opts.storage.loadTokens();
  if (!tokens) return null;

  const missing = computeMissingScopes(tokens.scope);
  if (missing.length > 0) {
    return null; // caller should prompt reconnect
  }

  const now = Date.now();
  if (tokens.expiresAt > now + REFRESH_THRESHOLD_MS) {
    return tokens.accessToken;
  }

  if (!tokens.refreshToken) return null;
  try {
    const refreshed = await refreshTokens(tokens.refreshToken, opts.config);
    const updated: StoredTokens = {
      ...tokens,
      accessToken: refreshed.access_token,
      expiresAt: Date.now() + refreshed.expires_in * 1000,
      scope: refreshed.scope,
      refreshToken: refreshed.refresh_token ?? tokens.refreshToken,
    };
    await opts.storage.saveTokens(updated);
    if (opts.onTokensUpdated) {
      try {
        await opts.onTokensUpdated(updated);
      } catch {
        /* swallow */
      }
    }
    return updated.accessToken;
  } catch (err) {
    if (err instanceof RefreshTokenInvalidError) return null;
    throw err;
  }
}

/**
 * Multi-account variant — refreshes a specific account's token.
 * Returns null on missing tokens, SCOPE_OUTDATED, or invalid refresh token.
 */
export async function getValidAccessTokenFor(
  accountId: AccountId,
  opts: MultiRefreshOptions,
): Promise<string | null> {
  const tokens = await opts.multiStorage.loadTokens(accountId);
  if (!tokens) return null;

  if (!opts.skipScopeCheck) {
    const missing = computeMissingScopes(tokens.scope);
    if (missing.length > 0) return null;
  }

  const now = Date.now();
  if (tokens.expiresAt > now + REFRESH_THRESHOLD_MS) {
    return tokens.accessToken;
  }

  if (!tokens.refreshToken) return null;
  try {
    const refreshed = await refreshTokens(tokens.refreshToken, opts.config);
    const updated: StoredTokens = {
      ...tokens,
      accessToken: refreshed.access_token,
      expiresAt: Date.now() + refreshed.expires_in * 1000,
      scope: refreshed.scope,
      refreshToken: refreshed.refresh_token ?? tokens.refreshToken,
    };
    await opts.multiStorage.saveTokens(accountId, updated);
    if (opts.onTokensUpdated) {
      try {
        await opts.onTokensUpdated(accountId, updated);
      } catch {
        /* swallow */
      }
    }
    return updated.accessToken;
  } catch (err) {
    if (err instanceof RefreshTokenInvalidError) return null;
    throw err;
  }
}

/**
 * Check scope coverage for a specific account. Returns which scopes are missing.
 */
export async function checkAccountScopeCoverage(
  accountId: AccountId,
  storage: MultiTokenStorage,
): Promise<{ ok: boolean; missing: string[] }> {
  const tokens = await storage.loadTokens(accountId);
  if (!tokens) return { ok: false, missing: [...GOOGLE_WORKSPACE_SCOPES] };
  const missing = computeMissingScopes(tokens.scope);
  return { ok: missing.length === 0, missing };
}

/**
 * Return list of accounts whose tokens are missing required scopes.
 */
export async function findAccountsNeedingReconnect(
  storage: MultiTokenStorage,
): Promise<Array<{ accountId: AccountId; email: string; missing: string[] }>> {
  const accounts = await storage.listAccounts();
  const results: Array<{ accountId: AccountId; email: string; missing: string[] }> = [];
  for (const a of accounts) {
    const check = await checkAccountScopeCoverage(a.id, storage);
    if (!check.ok) results.push({ accountId: a.id, email: a.email, missing: check.missing });
  }
  return results;
}

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
 * Start background timer that refreshes ALL connected accounts every 50min.
 * Per-account failures are logged but don't stop the timer.
 */
export function startMultiRefreshTimer(opts: MultiRefreshOptions): RefreshTimerHandle {
  const handle = setInterval(async () => {
    try {
      const accounts = await opts.multiStorage.listAccounts();
      for (const a of accounts) {
        try {
          await getValidAccessTokenFor(a.id, opts);
        } catch {
          // Silent per-account — UI surfaces via status command or tool call errors
        }
      }
    } catch {
      /* listAccounts failure — skip this tick */
    }
  }, REFRESH_TIMER_INTERVAL_MS);

  return {
    cancel: () => clearInterval(handle),
  };
}

/**
 * Legacy: single-account timer. Kept for backwards compat until main.ts migrates.
 */
export function startRefreshTimer(opts: RefreshOptions): RefreshTimerHandle {
  const handle = setInterval(() => {
    void getValidAccessToken(opts).catch(() => {
      /* silent */
    });
  }, REFRESH_TIMER_INTERVAL_MS);
  return { cancel: () => clearInterval(handle) };
}
