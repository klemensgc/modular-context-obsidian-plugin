/** Persistent logger + global crash safety net for the main process.
 *
 *  Until now the app logged nothing and any uncaught exception in the main
 *  process produced Electron's native "A JavaScript error occurred in the main
 *  process" dialog and could take the app down. This module:
 *   - writes a rolling log file under app.getPath("logs")
 *   - installs process-level uncaughtException / unhandledRejection handlers so
 *     a stray error (e.g. EPIPE writing to a dead child's stdin) is logged and
 *     swallowed instead of crashing the app
 *   - exposes log() for the rest of main + an IPC sink for renderer errors
 */

import { app, ipcMain } from "electron";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";

let logPath = "";

function ts(): string {
  // app runtime has Date; this is main process (not a Workflow sandbox)
  return new Date().toISOString();
}

export function log(scope: string, ...parts: unknown[]): void {
  const line = `[${ts()}] [${scope}] ${parts
    .map((p) => (typeof p === "string" ? p : safe(p)))
    .join(" ")}\n`;
  // Always echo to stderr (visible in `npm run dev`)
  process.stderr.write(line);
  if (!logPath) return;
  try {
    appendFileSync(logPath, line);
  } catch {
    /* logging must never throw */
  }
}

function safe(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}\n${v.stack ?? ""}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Call once early in app startup (before windows). */
export function initLogging(): void {
  try {
    const dir = app.getPath("logs"); // ~/Library/Logs/Modular Context
    mkdirSync(dir, { recursive: true });
    logPath = join(dir, "main.log");
  } catch (err) {
    process.stderr.write(`[logger] could not open log file: ${String(err)}\n`);
  }

  log("app", `--- start v${app.getVersion()} pid=${process.pid} ---`);
  log("app", `logs: ${logPath || "(stderr only)"}`);

  // The headline fix: never let a stray error kill the app.
  process.on("uncaughtException", (err, origin) => {
    log("uncaughtException", `(${origin})`, err);
  });
  process.on("unhandledRejection", (reason) => {
    log("unhandledRejection", reason as unknown);
  });
  process.on("warning", (w) => log("warning", w));

  // Renderer-side errors forwarded via preload (window.onerror etc.)
  ipcMain.on("app:log-error", (_evt, scope: string, message: string) => {
    log(`renderer:${scope}`, message);
  });
}

export function getLogPath(): string {
  return logPath;
}
