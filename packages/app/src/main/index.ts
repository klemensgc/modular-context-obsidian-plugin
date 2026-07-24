import { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, nativeImage, shell } from "electron";
import { join } from "path";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import Store from "electron-store";
import { PTY_HELPER_SOURCE, evaluateSetupFlag } from "@mc/shared";
import { registerIpcHandlers } from "./ipc-handlers";
import { runDoctor, createVaultFromTemplate, defaultVaultParentDir, getTemplatesDir, type CreateVaultOptions } from "./onboarding";
import { fetchRegistryData, installSkills, scanInstalledSkills } from "./skills";
import { buildLinkGraph } from "./graph";
import { getVaultStats } from "./vault-stats";
import { basename } from "path";
import { registerSimpleIpc } from "./simple-runner";
import { initLogging, log, getLogPath } from "./logger";

// --- Persistent store ---

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

interface StoreSchema {
  lastFolder: string | null;
  recentFolders: string[];
  pinnedFolders: string[];
  vaultLastOpened: Record<string, number>;
  windowState: WindowState;
  autoMode: boolean;
  onboardingComplete: boolean;
}

const store = new Store<StoreSchema>({
  defaults: {
    lastFolder: null,
    recentFolders: [],
    pinnedFolders: [],
    vaultLastOpened: {},
    windowState: { width: 1400, height: 900 },
    // Auto-mode launches Claude with --dangerously-skip-permissions.
    // Must be an explicit opt-in, never the out-of-the-box default.
    autoMode: false,
    onboardingComplete: false,
  },
});

// Loosely-typed view for modules that store dynamic keys (skills cache/tracking)
const anyStore = store as unknown as Store<any>;

const MAX_RECENT = 10;

function rememberFolder(folderPath: string) {
  store.set("lastFolder", folderPath);
  const lastOpened = store.get("vaultLastOpened", {});
  lastOpened[folderPath] = Date.now();
  store.set("vaultLastOpened", lastOpened);
  const current = store.get("recentFolders", []);
  const next = [folderPath, ...current.filter((p) => p !== folderPath)].slice(0, MAX_RECENT);
  store.set("recentFolders", next);
  buildMenu(); // rebuild Open Recent submenu
}

function forgetMissingFolders(): string[] {
  const current = store.get("recentFolders", []);
  const existing = current.filter((p) => existsSync(p));
  if (existing.length !== current.length) {
    store.set("recentFolders", existing);
  }
  return existing;
}

// --- State ---

let mainWindow: BrowserWindow | null = null;
let ptyHelperPath = "";
let pendingVaultToOpen: string | null = null;

function ensurePtyHelper() {
  const dir = join(app.getPath("userData"), "bin");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  ptyHelperPath = join(dir, "pty-helper.py");
  writeFileSync(ptyHelperPath, PTY_HELPER_SOURCE, { mode: 0o755 });
  return ptyHelperPath;
}

async function createWindow() {
  const savedState = store.get("windowState", { width: 1400, height: 900 });

  mainWindow = new BrowserWindow({
    x: savedState.x,
    y: savedState.y,
    width: savedState.width,
    height: savedState.height,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    vibrancy: "under-window",
    backgroundColor: "#0d0d0d",
    icon: join(__dirname, "../../assets/icon.icns"),
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (savedState.isMaximized) {
    mainWindow.maximize();
  }

  // Persist bounds on close (before destroy)
  const persistBounds = () => {
    if (!mainWindow) return;
    const isMax = mainWindow.isMaximized();
    if (isMax) {
      // Keep previous x/y/size; only flip isMaximized
      store.set("windowState", {
        x: savedState.x,
        y: savedState.y,
        width: savedState.width,
        height: savedState.height,
        isMaximized: true,
      });
    } else {
      const bounds = mainWindow.getBounds();
      store.set("windowState", {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        isMaximized: false,
      });
    }
  };
  mainWindow.on("close", persistBounds);
  mainWindow.on("resize", persistBounds);
  mainWindow.on("move", persistBounds);

  // Load the renderer
  await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));

  // After renderer is ready, emit any pending vault open
  if (pendingVaultToOpen) {
    const path = pendingVaultToOpen;
    pendingVaultToOpen = null;
    // Small delay to ensure renderer listeners are registered
    setTimeout(() => {
      mainWindow?.webContents.send("vault:opened", path);
    }, 100);
  }

  if (process.env.MC_APP_DEV === "1") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

async function pickFolder() {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    title: "Open Vault Folder",
  });
  if (!result.canceled && result.filePaths[0]) {
    openFolderInWindow(result.filePaths[0]);
  }
}

function openFolderInWindow(folderPath: string) {
  if (!existsSync(folderPath)) {
    dialog.showErrorBox("Folder not found", `The folder no longer exists:\n${folderPath}`);
    return;
  }
  rememberFolder(folderPath);
  mainWindow?.webContents.send("vault:opened", folderPath);
}

function buildMenu() {
  const recentFolders = forgetMissingFolders();

  const recentSubmenu: Electron.MenuItemConstructorOptions[] = recentFolders.length > 0
    ? [
        ...recentFolders.map((folder): Electron.MenuItemConstructorOptions => ({
          label: compactPath(folder),
          click: () => openFolderInWindow(folder),
        })),
        { type: "separator" },
        {
          label: "Clear Recent",
          click: () => {
            store.set("recentFolders", []);
            store.set("lastFolder", null);
            buildMenu();
          },
        },
      ]
    : [{ label: "No Recent Folders", enabled: false }];

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Modular Context",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "Open Folder…",
          accelerator: "CmdOrCtrl+O",
          click: pickFolder,
        },
        {
          label: "Open Recent",
          submenu: recentSubmenu,
        },
        {
          label: "Vault Home",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => mainWindow?.webContents.send("vault:go-home"),
        },
        { type: "separator" },
        {
          label: "Save",
          accelerator: "CmdOrCtrl+S",
          click: () => mainWindow?.webContents.send("editor:save-request"),
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function compactPath(full: string): string {
  const home = app.getPath("home");
  return full.startsWith(home) ? full.replace(home, "~") : full;
}

// --- Lifecycle ---

// Packaged builds get name+icon from electron-builder (productName / icon.icns);
// dev runs would otherwise show "Electron" with the atom icon in the Dock.
app.setName("Modular Context");

// Persistent logging + crash safety net before anything else can throw.
initLogging();

app.whenReady().then(() => {
  if (!app.isPackaged && process.platform === "darwin") {
    const devIcon = nativeImage.createFromPath(join(__dirname, "../../assets/icon_1024.png"));
    if (!devIcon.isEmpty()) app.dock.setIcon(devIcon);
  }
  ensurePtyHelper();
  registerIpcHandlers(() => ptyHelperPath);
  registerSimpleIpc();

  // We intentionally do NOT auto-open the last vault. The renderer lands on the
  // home dashboard (launcher), which surfaces the last/pinned vaults for a
  // one-click entry — the launcher is the intended landing experience.

  createWindow();
  buildMenu();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

nativeTheme.on("updated", () => {
  mainWindow?.webContents.send("theme:changed", {
    isDark: nativeTheme.shouldUseDarkColors,
  });
});

// --- IPC: folder memory ---

ipcMain.handle("vault:remember-folder", (_evt, folderPath: string) => {
  rememberFolder(folderPath);
});

ipcMain.handle("vault:get-recent", () => {
  return forgetMissingFolders();
});

ipcMain.handle("vault:pick-folder", pickFolder);

// --- IPC: vault dashboard (home screen) ---

ipcMain.handle("vault:get-managed", () => {
  const existing = forgetMissingFolders(); // prunes vanished folders
  const pinned = (store.get("pinnedFolders", []) as string[]).filter((p) => existsSync(p));
  const lastOpened = store.get("vaultLastOpened", {}) as Record<string, number>;
  const pinnedSet = new Set(pinned);
  const list = existing.map((path) => ({
    path,
    name: basename(path),
    pinned: pinnedSet.has(path),
    lastOpened: lastOpened[path] ?? 0,
  }));
  // Pinned first, then by most-recently-opened.
  list.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.lastOpened - a.lastOpened;
  });
  return list;
});

ipcMain.handle("vault:stats", (_evt, path: string) => getVaultStats(path));

ipcMain.handle("vault:forget", (_evt, path: string) => {
  store.set("recentFolders", (store.get("recentFolders", []) as string[]).filter((p) => p !== path));
  store.set("pinnedFolders", (store.get("pinnedFolders", []) as string[]).filter((p) => p !== path));
  const lastOpened = store.get("vaultLastOpened", {}) as Record<string, number>;
  delete lastOpened[path];
  store.set("vaultLastOpened", lastOpened);
});

ipcMain.handle("vault:set-pinned", (_evt, path: string, pinned: boolean) => {
  const set = new Set(store.get("pinnedFolders", []) as string[]);
  if (pinned) set.add(path);
  else set.delete(path);
  store.set("pinnedFolders", [...set]);
});

// --- IPC: transcript backlog (the ingest inbox shown on the home screen) ---

ipcMain.handle("vault:backlog", async (_evt, vaultPath: string) => {
  const dir = join(vaultPath, "_transcripts-backlog");
  if (!existsSync(dir)) return [];
  const { readdir, stat } = require("fs/promises") as typeof import("fs/promises");
  let items: import("fs").Dirent[];
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ name: string; mtime: number; sizeKB: number }> = [];
  for (const item of items) {
    if (!item.isFile()) continue;
    if (item.name.startsWith(".") || item.name.startsWith("_")) continue; // skip _index, dotfiles
    // Any file type is fair game — transcripts, PDFs, notes, articles, data.
    try {
      const st = await stat(join(dir, item.name));
      out.push({ name: item.name, mtime: st.mtimeMs, sizeKB: Math.max(1, Math.round(st.size / 1024)) });
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
});

// Per-file focus comments: { vaultPath: { filename: comment } }. These are
// woven into the synthesis run and answered afterwards.
ipcMain.handle("vault:get-file-notes", (_evt, vaultPath: string) => {
  const all = (store as any).get("backlogFileNotes", {}) as Record<string, Record<string, string>>;
  return all[vaultPath] ?? {};
});

ipcMain.handle("vault:set-file-note", (_evt, vaultPath: string, filename: string, text: string) => {
  const all = (store as any).get("backlogFileNotes", {}) as Record<string, Record<string, string>>;
  const forVault = all[vaultPath] ?? {};
  if (text.trim()) forVault[filename] = text;
  else delete forVault[filename];
  all[vaultPath] = forVault;
  (store as any).set("backlogFileNotes", all);
});

// Ensure the synthesis commands exist in the vault (self-healing install from
// the bundled template) so the /synthesise button works in any vault.
ipcMain.handle("vault:ensure-synthesis-skills", async (_evt, vaultPath: string) => {
  const { mkdir, copyFile } = require("fs/promises") as typeof import("fs/promises");
  const destDir = join(vaultPath, ".claude", "commands");
  await mkdir(destDir, { recursive: true });
  const srcDir = join(getTemplatesDir(), "vault", ".claude", "commands");
  for (const file of ["process-files.md", "synthesise.md", "decyzja.md"]) {
    const dest = join(destDir, file);
    if (existsSync(dest)) continue; // never clobber the user's copy
    const src = join(srcDir, file);
    if (existsSync(src)) {
      try { await copyFile(src, dest); } catch (err) { log("synth", "install command failed", err); }
    }
  }
});

// Remove a queued file from the backlog — to Trash (recoverable), not nuked.
ipcMain.handle("vault:remove-from-backlog", async (_evt, vaultPath: string, filename: string) => {
  if (filename.includes("/") || filename.includes("..")) return; // path-safety
  const target = join(vaultPath, "_transcripts-backlog", filename);
  if (!existsSync(target)) return;
  try {
    await shell.trashItem(target);
  } catch (err) {
    log("backlog", "trash failed", err);
  }
});

// Drag-and-drop: copy arbitrary files into the vault's _transcripts-backlog/.
ipcMain.handle("vault:add-to-backlog", async (_evt, vaultPath: string, filePaths: string[]) => {
  const { mkdir, copyFile, access } = require("fs/promises") as typeof import("fs/promises");
  const dir = join(vaultPath, "_transcripts-backlog");
  await mkdir(dir, { recursive: true });
  for (const src of filePaths) {
    if (!src) continue;
    const base = basename(src);
    if (base.startsWith(".")) continue;
    let dest = join(dir, base);
    // Collision-safe: name.ext → name (2).ext
    let n = 2;
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try { await access(dest); dest = join(dir, `${stem} (${n++})${ext}`); }
      catch { break; }
    }
    try { await copyFile(src, dest); } catch (err) { log("backlog", "copy failed", err); }
  }
});

// --- IPC: settings ---

ipcMain.handle("settings:get-auto-mode", () => {
  return store.get("autoMode", false);
});

ipcMain.handle("settings:set-auto-mode", (_evt, value: boolean) => {
  store.set("autoMode", value);
});

ipcMain.handle("settings:get-max-sessions", () => {
  return (store as any).get("maxSessions", 12);
});

ipcMain.handle("settings:set-max-sessions", (_evt, value: number) => {
  if (Number.isFinite(value) && value >= 1 && value <= 20) {
    (store as any).set("maxSessions", value);
  }
});

// Beginner mode: plain-language agent + extra hand-holding. Default ON —
// the app's whole thrust is non-technical users.
ipcMain.handle("settings:get-beginner-mode", () => {
  return (store as any).get("beginnerMode", true);
});

ipcMain.handle("settings:set-beginner-mode", (_evt, value: boolean) => {
  (store as any).set("beginnerMode", value);
});

// Pro mode: new agent sessions open as the raw Claude Code terminal (TUI)
// instead of the friendly Simple chat feed. Default OFF.
ipcMain.handle("settings:get-pro-mode", () => {
  return (store as any).get("proMode", false);
});

ipcMain.handle("settings:set-pro-mode", (_evt, value: boolean) => {
  (store as any).set("proMode", value);
});

// --- IPC: link graph (Cmd+G graph view) ---

ipcMain.handle("vault:build-graph", (_evt, basePath: string) => buildLinkGraph(basePath));

// --- IPC: git info + native git actions (Connections panel) ---

function gitRun(vaultPath: string, args: string[], timeout = 8000): Promise<{ ok: boolean; out: string }> {
  const { execFile } = require("child_process") as typeof import("child_process");
  return new Promise((resolve) => {
    execFile("git", args, { cwd: vaultPath, timeout }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: (err ? String(stderr || err.message) : String(stdout)).trim() }),
    );
  });
}

async function getGitInfo(vaultPath: string) {
  const inside = await gitRun(vaultPath, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.out !== "true") return { isRepo: false as const };
  const [branch, remoteUrl, lastCommit, upstream] = await Promise.all([
    gitRun(vaultPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitRun(vaultPath, ["remote", "get-url", "origin"]),
    gitRun(vaultPath, ["log", "-1", "--format=%h · %s · %cr"]),
    gitRun(vaultPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
  ]);

  // Sync state vs the remote-tracking branch (what we last knew was on GitHub).
  let hasUpstream = false;
  let ahead = 0;
  let behind = 0;
  let syncedRel: string | null = null;
  if (upstream.ok && upstream.out) {
    hasUpstream = true;
    const [ab, rel] = await Promise.all([
      gitRun(vaultPath, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
      gitRun(vaultPath, ["log", "-1", "--format=%cr", "@{upstream}"]),
    ]);
    if (ab.ok) {
      const parts = ab.out.split(/\s+/).map((n) => parseInt(n, 10));
      behind = Number.isFinite(parts[0]) ? parts[0] : 0;
      ahead = Number.isFinite(parts[1]) ? parts[1] : 0;
    }
    if (rel.ok) syncedRel = rel.out;
  }

  return {
    isRepo: true as const,
    branch: branch.ok ? branch.out : null,
    remoteUrl: remoteUrl.ok ? remoteUrl.out : null,
    lastCommit: lastCommit.ok ? lastCommit.out : null,
    hasUpstream,
    ahead,
    behind,
    syncedRel,
  };
}

ipcMain.handle("vault:git-info", (_evt, vaultPath: string) => getGitInfo(vaultPath));

ipcMain.handle("git:init", async (_evt, vaultPath: string) => {
  const init = await gitRun(vaultPath, ["init"]);
  if (!init.ok) return { ok: false, out: init.out };
  await gitRun(vaultPath, ["add", "-A"]);
  const commit = await gitRun(vaultPath, ["commit", "-m", "Add: initial vault commit"]);
  return { ok: commit.ok, out: commit.out };
});

ipcMain.handle("git:add-remote", async (_evt, vaultPath: string, url: string) => {
  if (!/^(https:\/\/|git@)[\w.@:\/~-]+$/.test(url.trim())) {
    return { ok: false, out: "That does not look like a git URL." };
  }
  const existing = await gitRun(vaultPath, ["remote", "get-url", "origin"]);
  const addOrSet = existing.ok ? ["remote", "set-url", "origin", url.trim()] : ["remote", "add", "origin", url.trim()];
  const add = await gitRun(vaultPath, addOrSet);
  if (!add.ok) return { ok: false, out: add.out };
  const branch = await gitRun(vaultPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  // Push may need auth — give it more time, report whatever git says.
  const push = await gitRun(vaultPath, ["push", "-u", "origin", branch.ok ? branch.out : "master"], 60000);
  return { ok: push.ok, out: push.ok ? "Remote added and pushed." : push.out };
});

// --- IPC: connection statuses (setup flags driving skill prereqs) ---

ipcMain.handle("connections:status", async (_evt, vaultPath: string) => {
  const git = await getGitInfo(vaultPath);
  return {
    git,
    flags: {
      "git-initialized": git.isRepo,
      "github-remote": git.isRepo && !!git.remoteUrl,
      "gsuite-connected": evaluateSetupFlag("gsuite-connected", vaultPath),
      "whatsapp-macos": evaluateSetupFlag("whatsapp-macos", vaultPath),
      "clickup-connected": evaluateSetupFlag("clickup-connected", vaultPath),
      "python3": evaluateSetupFlag("python3", vaultPath),
    },
  };
});

// --- IPC: onboarding ---

ipcMain.handle("onboarding:get-state", () => {
  return {
    complete: store.get("onboardingComplete", false),
    recentFolders: forgetMissingFolders(),
  };
});

ipcMain.handle("onboarding:complete", () => {
  store.set("onboardingComplete", true);
});

ipcMain.handle("doctor:run", () => runDoctor());

ipcMain.handle("vault:pick-parent-dir", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    title: "Choose where to create the vault",
    defaultPath: defaultVaultParentDir(),
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle("vault:create-from-template", async (_evt, opts: CreateVaultOptions) => {
  const result = await createVaultFromTemplate(opts);
  // Remember it (recent list), but DON'T emit vault:opened — the wizard decides
  // when the vault actually loads (after the skills step).
  rememberFolder(result.vaultPath);
  return result;
});

ipcMain.handle("vault:open-path", (_evt, folderPath: string) => {
  openFolderInWindow(folderPath);
});

// --- IPC: skills ---

ipcMain.handle("skills:get-registry", (_evt, vaultPath: string) => {
  return fetchRegistryData(vaultPath, anyStore);
});

ipcMain.handle("skills:install", (_evt, vaultPath: string, ids: string[]) => {
  return installSkills(vaultPath, anyStore, ids);
});

ipcMain.handle("skills:scan-installed", (_evt, vaultPath: string) => {
  return scanInstalledSkills(vaultPath);
});
