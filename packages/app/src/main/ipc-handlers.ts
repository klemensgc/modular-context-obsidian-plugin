import { ipcMain, BrowserWindow, shell } from "electron";
import { spawn } from "child_process";
import { createVaultAdapter } from "./vault-adapter-node";
import type { VaultAdapter } from "@mc/shared";
import { log } from "./logger";

/** Write to a child's stdin without ever throwing. A write to a dead/closing
 *  PTY emits an async EPIPE 'error' event on the stream — unhandled, that
 *  becomes an uncaught exception and crashes the app. */
function safeStdinWrite(proc: { stdin?: NodeJS.WritableStream | null }, data: string): void {
  const stdin = proc.stdin as (NodeJS.WritableStream & { destroyed?: boolean }) | null | undefined;
  if (!stdin || stdin.destroyed) return;
  try {
    stdin.write(data);
  } catch (err) {
    log("pty", "stdin write failed (sync)", err);
  }
}

let currentAdapter: VaultAdapter | null = null;
let currentUnwatch: (() => void) | null = null;

interface PtySession {
  id: string;
  process: ReturnType<typeof spawn>;
}

const ptySessions = new Map<string, PtySession>();
let nextPtyId = 1;

export function registerIpcHandlers(getHelperPath: () => string) {
  // --- Vault handlers ---

  ipcMain.handle("vault:list-files", async (_evt, basePath: string) => {
    if (!currentAdapter || currentAdapter.basePath !== basePath) {
      currentAdapter = createVaultAdapter(basePath);
    }
    return currentAdapter.getFiles();
  });

  ipcMain.handle("vault:read-file", async (_evt, path: string) => {
    if (!currentAdapter) throw new Error("No vault open");
    return currentAdapter.readFile(path);
  });

  ipcMain.handle("vault:write-file", async (_evt, path: string, content: string) => {
    if (!currentAdapter) throw new Error("No vault open");
    return currentAdapter.writeFile(path, content);
  });

  ipcMain.handle("vault:watch-start", async (_evt, basePath: string) => {
    if (currentUnwatch) currentUnwatch();
    if (!currentAdapter || currentAdapter.basePath !== basePath) {
      currentAdapter = createVaultAdapter(basePath);
    }
    currentUnwatch = currentAdapter.watch((vaultEvent) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("vault:file-event", vaultEvent);
      }
    });
  });

  // --- PTY handlers (for terminal pane) ---

  ipcMain.handle("pty:spawn", async (_evt, opts: { cwd: string; cols: number; rows: number; cmd?: string }) => {
    const helperPath = getHelperPath();
    const id = `pty-${nextPtyId++}`;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { CLAUDECODE, ...cleanEnv } = process.env;

    const proc = spawn("python3", [helperPath], {
      cwd: opts.cwd,
      env: {
        ...cleanEnv,
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        MC_TERM_COLS: String(opts.cols),
        MC_TERM_ROWS: String(opts.rows),
        // Direct command (e.g. "claude") — the helper execs it through a login
        // shell, so the user never sees a shell prompt or typed commands.
        ...(opts.cmd ? { MC_TERM_CMD: opts.cmd } : {}),
      },
    });

    ptySessions.set(id, { id, process: proc });

    // Error listeners are mandatory: without them an async stream/spawn error
    // (EPIPE, ENOENT for python3, etc.) is thrown as an uncaught exception.
    proc.on("error", (err) => {
      log("pty", `process error ${id}`, err);
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("pty:exit", id);
      }
      ptySessions.delete(id);
    });
    proc.stdin?.on("error", (err) => log("pty", `stdin error ${id}`, err));
    proc.stdout?.on("error", (err) => log("pty", `stdout error ${id}`, err));
    proc.stderr?.on("error", (err) => log("pty", `stderr error ${id}`, err));

    proc.stdout?.on("data", (data: Buffer) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("pty:data", id, data.toString("utf-8"));
      }
    });
    proc.stderr?.on("data", (data: Buffer) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("pty:data", id, data.toString("utf-8"));
      }
    });
    proc.on("exit", () => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("pty:exit", id);
      }
      ptySessions.delete(id);
    });

    return id;
  });

  ipcMain.handle("pty:write", async (_evt, id: string, data: string) => {
    const session = ptySessions.get(id);
    if (session) safeStdinWrite(session.process, data);
  });

  ipcMain.handle("pty:resize", async (_evt, id: string, cols: number, rows: number) => {
    const session = ptySessions.get(id);
    // Python helper parses \x1b]R;cols;rows\x07 from stdin
    if (session) safeStdinWrite(session.process, `\x1b]R;${cols};${rows}\x07`);
  });

  ipcMain.handle("pty:kill", async (_evt, id: string) => {
    const session = ptySessions.get(id);
    session?.process.kill("SIGTERM");
    ptySessions.delete(id);
  });

  // --- Shell handlers ---

  ipcMain.handle("shell:reveal", async (_evt, path: string) => {
    shell.showItemInFolder(path);
  });

  ipcMain.handle("shell:open-external", async (_evt, url: string) => {
    await shell.openExternal(url);
  });

  // Open a local file in its default app (e.g. PDF → Preview, which has the
  // full macOS Share sheet: AirDrop, Mail, Messages…).
  ipcMain.handle("shell:open-path", async (_evt, filePath: string) => {
    await shell.openPath(filePath);
  });

  // "Save a copy / Send to…" — native save dialog, then copy the file there.
  ipcMain.handle("shell:save-copy", async (_evt, filePath: string) => {
    const { dialog } = require("electron") as typeof import("electron");
    const { copyFile } = require("fs/promises") as typeof import("fs/promises");
    const base = filePath.split("/").pop() || "file";
    const res = await dialog.showSaveDialog({ title: "Send a copy to…", defaultPath: base });
    if (res.canceled || !res.filePath) return false;
    try {
      await copyFile(filePath, res.filePath);
      return true;
    } catch (err) {
      log("share", "save-copy failed", err);
      return false;
    }
  });
}
