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
  buildGraph: (basePath: string): Promise<unknown> =>
    ipcRenderer.invoke("vault:build-graph", basePath),

  // Folder memory
  rememberFolder: (path: string): Promise<void> =>
    ipcRenderer.invoke("vault:remember-folder", path),
  getRecent: (): Promise<string[]> =>
    ipcRenderer.invoke("vault:get-recent"),
  pickFolder: (): Promise<void> =>
    ipcRenderer.invoke("vault:pick-folder"),

  // Home dashboard
  getManaged: (): Promise<Array<{ path: string; name: string; pinned: boolean; lastOpened: number }>> =>
    ipcRenderer.invoke("vault:get-managed"),
  stats: (path: string): Promise<{ noteCount: number; lastActivityMs: number }> =>
    ipcRenderer.invoke("vault:stats", path),
  forget: (path: string): Promise<void> => ipcRenderer.invoke("vault:forget", path),
  setPinned: (path: string, pinned: boolean): Promise<void> =>
    ipcRenderer.invoke("vault:set-pinned", path, pinned),
  openPath: (path: string): Promise<void> => ipcRenderer.invoke("vault:open-path", path),

  // Transcript backlog (ingest inbox) + per-file focus comments + drop-in
  backlog: (path: string): Promise<Array<{ name: string; mtime: number; sizeKB: number }>> =>
    ipcRenderer.invoke("vault:backlog", path),
  getFileNotes: (path: string): Promise<Record<string, string>> =>
    ipcRenderer.invoke("vault:get-file-notes", path),
  setFileNote: (path: string, filename: string, text: string): Promise<void> =>
    ipcRenderer.invoke("vault:set-file-note", path, filename, text),
  addToBacklog: (path: string, filePaths: string[]): Promise<void> =>
    ipcRenderer.invoke("vault:add-to-backlog", path, filePaths),
  removeFromBacklog: (path: string, filename: string): Promise<void> =>
    ipcRenderer.invoke("vault:remove-from-backlog", path, filename),
  ensureSynthesisSkills: (path: string): Promise<void> =>
    ipcRenderer.invoke("vault:ensure-synthesis-skills", path),

  onVaultOpened: (cb: (basePath: string) => void) => {
    ipcRenderer.on("vault:opened", (_, path: string) => cb(path));
  },
  onGoHome: (cb: () => void) => {
    ipcRenderer.on("vault:go-home", () => cb());
  },
  onFileEvent: (cb: (event: VaultEvent) => void) => {
    ipcRenderer.on("vault:file-event", (_, event: VaultEvent) => cb(event));
  },
});

// PTY API
contextBridge.exposeInMainWorld("mcPty", {
  spawn: (opts: { cwd: string; cols: number; rows: number; cmd?: string }): Promise<string> =>
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
  openPath: (path: string): Promise<void> => ipcRenderer.invoke("shell:open-path", path),
  saveCopy: (path: string): Promise<boolean> => ipcRenderer.invoke("shell:save-copy", path),
});

// Settings
contextBridge.exposeInMainWorld("mcSettings", {
  getAutoMode: (): Promise<boolean> => ipcRenderer.invoke("settings:get-auto-mode"),
  setAutoMode: (value: boolean): Promise<void> => ipcRenderer.invoke("settings:set-auto-mode", value),
  getMaxSessions: (): Promise<number> => ipcRenderer.invoke("settings:get-max-sessions"),
  setMaxSessions: (value: number): Promise<void> => ipcRenderer.invoke("settings:set-max-sessions", value),
  getBeginnerMode: (): Promise<boolean> => ipcRenderer.invoke("settings:get-beginner-mode"),
  setBeginnerMode: (value: boolean): Promise<void> => ipcRenderer.invoke("settings:set-beginner-mode", value),
  getProMode: (): Promise<boolean> => ipcRenderer.invoke("settings:get-pro-mode"),
  setProMode: (value: boolean): Promise<void> => ipcRenderer.invoke("settings:set-pro-mode", value),
});

// Git + connections (Connections panel)
contextBridge.exposeInMainWorld("mcGit", {
  info: (vaultPath: string): Promise<unknown> => ipcRenderer.invoke("vault:git-info", vaultPath),
  init: (vaultPath: string): Promise<unknown> => ipcRenderer.invoke("git:init", vaultPath),
  addRemote: (vaultPath: string, url: string): Promise<unknown> =>
    ipcRenderer.invoke("git:add-remote", vaultPath, url),
});

contextBridge.exposeInMainWorld("mcConnections", {
  status: (vaultPath: string): Promise<unknown> => ipcRenderer.invoke("connections:status", vaultPath),
});

// Onboarding (first-run wizard: doctor, vault scaffold, completion flag)
contextBridge.exposeInMainWorld("mcOnboarding", {
  getState: (): Promise<{ complete: boolean; recentFolders: string[] }> =>
    ipcRenderer.invoke("onboarding:get-state"),
  complete: (): Promise<void> => ipcRenderer.invoke("onboarding:complete"),
  runDoctor: (): Promise<unknown[]> => ipcRenderer.invoke("doctor:run"),
  pickParentDir: (): Promise<string | null> => ipcRenderer.invoke("vault:pick-parent-dir"),
  createVault: (opts: unknown): Promise<{ vaultPath: string; gitInitialized: boolean }> =>
    ipcRenderer.invoke("vault:create-from-template", opts),
  openVaultPath: (path: string): Promise<void> => ipcRenderer.invoke("vault:open-path", path),
});

// Skill library (registry fetch + install into the vault's .claude/)
contextBridge.exposeInMainWorld("mcSkills", {
  getRegistry: (vaultPath: string): Promise<unknown> =>
    ipcRenderer.invoke("skills:get-registry", vaultPath),
  install: (vaultPath: string, ids: string[]): Promise<number> =>
    ipcRenderer.invoke("skills:install", vaultPath, ids),
  scanInstalled: (vaultPath: string): Promise<string[]> =>
    ipcRenderer.invoke("skills:scan-installed", vaultPath),
  onInstallProgress: (cb: (done: number, total: number) => void) => {
    ipcRenderer.on("skills:install-progress", (_, done: number, total: number) => cb(done, total));
  },
});

// Simple mode — headless Claude (stream-json) rendered as a native chat feed
contextBridge.exposeInMainWorld("mcSimple", {
  spawn: (opts: { cwd: string; prompt: string; permissionMode: "acceptEdits" | "bypassPermissions"; beginner?: boolean; expert?: boolean }): Promise<string> =>
    ipcRenderer.invoke("simple:spawn", opts),
  send: (id: string, text: string): Promise<void> => ipcRenderer.invoke("simple:send", id, text),
  respond: (id: string, requestId: string, allow: boolean, input: unknown): Promise<void> =>
    ipcRenderer.invoke("simple:respond", id, requestId, allow, input),
  answer: (id: string, toolUseId: string, content: string): Promise<void> =>
    ipcRenderer.invoke("simple:answer", id, toolUseId, content),
  interrupt: (id: string): Promise<void> => ipcRenderer.invoke("simple:interrupt", id),
  kill: (id: string): Promise<void> => ipcRenderer.invoke("simple:kill", id),
  onEvent: (cb: (id: string, evt: unknown) => void) => {
    ipcRenderer.on("simple:event", (_e, id: string, evt: unknown) => cb(id, evt));
  },
});

// Renderer → main error logging (window.onerror / unhandledrejection)
contextBridge.exposeInMainWorld("mcLog", {
  error: (scope: string, message: string) => ipcRenderer.send("app:log-error", scope, message),
});

// App-level notifications from main (skill install errors etc.)
contextBridge.exposeInMainWorld("mcNotify", {
  onNotify: (cb: (message: string) => void) => {
    ipcRenderer.on("app:notify", (_, message: string) => cb(message));
  },
});
