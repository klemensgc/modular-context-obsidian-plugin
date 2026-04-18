import { ipcMain, BrowserWindow, shell } from "electron";
import { spawn } from "child_process";
import { createVaultAdapter } from "./vault-adapter-node";
import type { VaultAdapter } from "@mc/shared";

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

  ipcMain.handle("pty:spawn", async (_evt, opts: { cwd: string; cols: number; rows: number }) => {
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
      },
    });

    ptySessions.set(id, { id, process: proc });

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
    session?.process.stdin?.write(data);
  });

  ipcMain.handle("pty:resize", async (_evt, id: string, cols: number, rows: number) => {
    const session = ptySessions.get(id);
    // Python helper parses \x1b]R;cols;rows\x07 from stdin
    session?.process.stdin?.write(`\x1b]R;${cols};${rows}\x07`);
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
}
