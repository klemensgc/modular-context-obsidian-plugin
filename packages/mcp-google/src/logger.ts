// stderr + optional file logger z rotation.
// NEVER log tokens, email bodies, subject lines (privacy — per ADR-003 addendum).

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { ServerEnv } from "./types.js";

const ROTATION_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const ROTATION_KEEP = 3;

const LEVEL_ORDER = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 } as const;

const REDACT_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [REDACTED]"],
  [/ya29\.[A-Za-z0-9._-]+/g, "ya29.[REDACTED]"],
  [/1\/\/[A-Za-z0-9._-]+/g, "1//[REDACTED]"],
  [/GOCSPX-[A-Za-z0-9_-]+/g, "GOCSPX-[REDACTED]"],
  [/"(access_token|refresh_token|accessToken|refreshToken)"\s*:\s*"[^"]*"/g, '"$1":"[REDACTED]"'],
];

function scrub(msg: string): string {
  let result = msg;
  for (const [pattern, replacement] of REDACT_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function maybeRotate(path: string): void {
  if (!existsSync(path)) return;
  try {
    const size = statSync(path).size;
    if (size < ROTATION_SIZE_BYTES) return;
    // Rotate: .log.{N-1} → .log.N, drop oldest
    for (let i = ROTATION_KEEP - 1; i >= 1; i--) {
      const from = `${path}.${i}`;
      const to = `${path}.${i + 1}`;
      if (existsSync(from)) {
        if (i === ROTATION_KEEP - 1 && existsSync(to)) unlinkSync(to);
        renameSync(from, to);
      }
    }
    renameSync(path, `${path}.1`);
  } catch {
    // best-effort — if rotate fails, continue appending to existing
  }
}

export class Logger {
  constructor(private readonly env: ServerEnv) {
    if (env.logPath) ensureDir(env.logPath);
  }

  private shouldLog(level: keyof typeof LEVEL_ORDER): boolean {
    return LEVEL_ORDER[level] <= LEVEL_ORDER[this.env.logLevel];
  }

  private write(level: keyof typeof LEVEL_ORDER, msg: string, context?: unknown): void {
    if (!this.shouldLog(level)) return;
    const ts = new Date().toISOString();
    const ctxStr = context !== undefined ? " " + scrub(JSON.stringify(context)) : "";
    const line = `[${ts}] ${level} ${scrub(msg)}${ctxStr}\n`;
    process.stderr.write(line);
    if (this.env.logPath) {
      try {
        maybeRotate(this.env.logPath);
        appendFileSync(this.env.logPath, line);
      } catch {
        // swallow — file logging is best-effort, stderr is primary
      }
    }
  }

  error(msg: string, context?: unknown): void {
    this.write("ERROR", msg, context);
  }

  warn(msg: string, context?: unknown): void {
    this.write("WARN", msg, context);
  }

  info(msg: string, context?: unknown): void {
    this.write("INFO", msg, context);
  }

  debug(msg: string, context?: unknown): void {
    this.write("DEBUG", msg, context);
  }
}
