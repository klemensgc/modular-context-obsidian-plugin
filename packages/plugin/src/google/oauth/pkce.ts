// PKCE (Proof Key for Code Exchange) — RFC 7636 S256 method.
// Used by OAuth 2.0 desktop flow to protect authorization code exchange.
// Per ADR-001 and research/01-oauth-desktop-flow.md.

import { createHash, randomBytes } from "node:crypto";

const VERIFIER_MIN = 43;
const VERIFIER_MAX = 128;
// RFC 7636 §4.1 — unreserved chars
const VERIFIER_CHARSET = /^[A-Za-z0-9\-._~]+$/;

export class InvalidCodeVerifierError extends Error {
  constructor(message: string) {
    super(`Invalid PKCE code verifier: ${message}`);
    this.name = "InvalidCodeVerifierError";
  }
}

/**
 * Generate cryptographically random code verifier per RFC 7636 §4.1.
 * Returns 43-128 chars from unreserved set (A-Z a-z 0-9 - . _ ~).
 */
export function generateCodeVerifier(): string {
  // 64 bytes → ~86 base64url chars, fits 43-128 range
  const bytes = randomBytes(64);
  return bytes.toString("base64url");
}

/**
 * Compute S256 code challenge from verifier per RFC 7636 §4.2.
 * Returns base64url(SHA-256(verifier)).
 * Throws InvalidCodeVerifierError if verifier fails length or charset validation.
 */
export function challengeFromVerifier(verifier: string): string {
  if (verifier.length < VERIFIER_MIN || verifier.length > VERIFIER_MAX) {
    throw new InvalidCodeVerifierError(
      `length must be ${VERIFIER_MIN}-${VERIFIER_MAX}, got ${verifier.length}`,
    );
  }
  if (!VERIFIER_CHARSET.test(verifier)) {
    throw new InvalidCodeVerifierError("contains characters outside [A-Za-z0-9-._~]");
  }
  return createHash("sha256").update(verifier).digest("base64url");
}
