import { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme } from "electron";
import { join } from "path";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import Store from "electron-store";
import { PTY_HELPER_SOURCE } from "@mc/shared";
import { registerIpcHandlers } from "./ipc-handlers";

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
  windowState: WindowState;
  autoMode: boolean;
}

const store = new Store<StoreSchema>({
  defaults: {
    lastFolder: null,
    recentFolders: [],
    windowState: { width: 1400, height: 900 },
    autoMode: true,
  },
});

const MAX_RECENT = 10;

function rememberFolder(folderPath: string) {
  store.set("lastFolder", folderPath);
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

app.whenReady().then(() => {
  ensurePtyHelper();
  registerIpcHandlers(() => ptyHelperPath);

  // Restore last folder if still exists
  const last = store.get("lastFolder");
  if (last && existsSync(last)) {
    pendingVaultToOpen = last;
  }

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

// --- IPC: settings ---

ipcMain.handle("settings:get-auto-mode", () => {
  return store.get("autoMode", true);
});

ipcMain.handle("settings:set-auto-mode", (_evt, value: boolean) => {
  store.set("autoMode", value);
});
