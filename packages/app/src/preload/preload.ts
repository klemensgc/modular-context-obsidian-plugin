import { contextBridge, ipcRenderer } from "electron";
import type { FileEntry, VaultEvent } from "@mc/shared";

// Vault API
contextBridge.exposeInMainWorld("mcVault", {
  listFiles: (basePath: string): Promise<FileEntry[]> =>
    ipcRenderer.invoke("vault:list-files", basePath),
  readFile: (path: string): Promise<string> =>
    ipcRenderer.invoke("vault:read-file", path),
  writeFile: (path: string, content: string): Promise<void> =>
    ipcRenderer.invoke("vault:write-file", path, content),
  watchStart: (basePath: string): Promise<void> =>
    ipcRenderer.invoke("vault:watch-start", basePath),

  // Folder memory
  rememberFolder: (path: string): Promise<void> =>
    ipcRenderer.invoke("vault:remember-folder", path),
  getRecent: (): Promise<string[]> =>
    ipcRenderer.invoke("vault:get-recent"),
  pickFolder: (): Promise<void> =>
    ipcRenderer.invoke("vault:pick-folder"),

  onVaultOpened: (cb: (basePath: string) => void) => {
    ipcRenderer.on("vault:opened", (_, path: string) => cb(path));
  },
  onFileEvent: (cb: (event: VaultEvent) => void) => {
    ipcRenderer.on("vault:file-event", (_, event: VaultEvent) => cb(event));
  },
});

// PTY API
contextBridge.exposeInMainWorld("mcPty", {
  spawn: (opts: { cwd: string; cols: number; rows: number }): Promise<string> =>
    ipcRenderer.invoke("pty:spawn", opts),
  write: (id: string, data: string): Promise<void> =>
    ipcRenderer.invoke("pty:write", id, data),
  resize: (id: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke("pty:resize", id, cols, rows),
  kill: (id: string): Promise<void> =>
    ipcRenderer.invoke("pty:kill", id),
  onData: (cb: (id: string, data: string) => void) => {
    ipcRenderer.on("pty:data", (_, id: string, data: string) => cb(id, data));
  },
  onExit: (cb: (id: string) => void) => {
    ipcRenderer.on("pty:exit", (_, id: string) => cb(id));
  },
});

// Editor save signal (from menu File > Save)
contextBridge.exposeInMainWorld("mcEditor", {
  onSaveRequest: (cb: () => void) => {
    ipcRenderer.on("editor:save-request", () => cb());
  },
});

// Theme
contextBridge.exposeInMainWorld("mcTheme", {
  onChange: (cb: (theme: { isDark: boolean }) => void) => {
    ipcRenderer.on("theme:changed", (_, theme) => cb(theme));
  },
});

// Shell helpers
contextBridge.exposeInMainWorld("mcShell", {
  showItemInFolder: (path: string): Promise<void> => ipcRenderer.invoke("shell:reveal", path),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("shell:open-external", url),
});

// Settings
contextBridge.exposeInMainWorld("mcSettings", {
  getAutoMode: (): Promise<boolean> => ipcRenderer.invoke("settings:get-auto-mode"),
  setAutoMode: (value: boolean): Promise<void> => ipcRenderer.invoke("settings:set-auto-mode", value),
});
