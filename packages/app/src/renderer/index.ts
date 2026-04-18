/** Modular Context app renderer entry.
 *  Wires AppShell (3-panel layout) + FileTree + EditorPane + TerminalPane. */

export {};

import type { FileEntry, VaultEvent } from "@mc/shared";
import { createAppShell } from "./layout/AppShell";
import { FileTree } from "./layout/FileTree";
import { EditorPane } from "./layout/EditorPane";
import { TerminalManager } from "./layout/TerminalManager";
import { AgentCardsPanel } from "./layout/AgentCardsPanel";

interface McVaultApi {
  listFiles(basePath: string): Promise<FileEntry[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  watchStart(basePath: string): Promise<void>;
  onVaultOpened(cb: (basePath: string) => void): void;
  onFileEvent(cb: (event: VaultEvent) => void): void;
}

interface McEditorApi {
  onSaveRequest(cb: () => void): void;
}

const mcVault = (window as any).mcVault as McVaultApi;
const mcEditor = (window as any).mcEditor as McEditorApi;

const root = document.getElementById("app")!;

let shell: ReturnType<typeof createAppShell> | null = null;
let fileTree: FileTree | null = null;
let editorPane: EditorPane | null = null;
let terminalManager: TerminalManager | null = null;
let agentCardsPanel: AgentCardsPanel | null = null;
let currentVault: string | null = null;

function renderEmpty() {
  root.innerHTML = `
    <div class="mc-app-empty">
      <h2>Modular Context</h2>
      <p>Press <kbd>⌘O</kbd> to open a vault folder.</p>
    </div>
  `;
}

function toggleTerminalFullscreen() {
  const app = document.getElementById("app");
  if (!app) return;
  app.classList.toggle("is-terminal-fullscreen");
  // Re-fit terminals after layout change
  requestAnimationFrame(() => {
    window.dispatchEvent(new CustomEvent("mc:panes-resized"));
  });
}

async function loadVault(basePath: string) {
  currentVault = basePath;

  // Destroy previous shell contents
  if (terminalManager) await terminalManager.destroy();
  if (editorPane) editorPane.destroy();

  shell = createAppShell(root);

  // Split left sidebar: file tree on top, agent cards on bottom
  shell.treeEl.innerHTML = "";
  const treeScrollEl = document.createElement("div");
  treeScrollEl.className = "mc-app-tree-scroll";
  shell.treeEl.appendChild(treeScrollEl);

  const agentCardsEl = document.createElement("div");
  shell.treeEl.appendChild(agentCardsEl);

  editorPane = new EditorPane(shell.editorEl);
  terminalManager = new TerminalManager(shell.terminalEl, basePath);
  terminalManager.onFullscreenToggle = toggleTerminalFullscreen;
  agentCardsPanel = new AgentCardsPanel(agentCardsEl, terminalManager);
  // Create initial session
  terminalManager.create();
  fileTree = new FileTree(treeScrollEl, {
    onFileSelected: (path: string) => {
      editorPane?.open(path);
    },
  });

  try {
    const files = await mcVault.listFiles(basePath);
    await mcVault.watchStart(basePath);
    fileTree.render(basePath, files);
    console.log(`[MC App] Loaded ${files.length} files from ${basePath}`);
  } catch (err) {
    console.error("[MC App] Vault load failed:", err);
    root.innerHTML = `<div class="mc-app-error">Failed to load vault: ${escape(String(err))}</div>`;
  }
}

mcVault.onVaultOpened((basePath: string) => {
  loadVault(basePath).catch(console.error);
});

mcVault.onFileEvent((event: VaultEvent) => {
  // For MVP: just log events. Iter 15 could add live tree refresh.
  console.log("[MC App] File event:", event);
  // Quick refresh on create/delete
  if (event.type === "create" || event.type === "delete") {
    if (currentVault && fileTree) {
      mcVault.listFiles(currentVault).then((files) => fileTree!.render(currentVault!, files));
    }
  }
});

mcEditor.onSaveRequest(() => {
  editorPane?.save();
});

// --- Global keyboard shortcuts ---
document.addEventListener("keydown", (e) => {
  // Cmd+Shift+F — toggle terminal fullscreen
  if (e.metaKey && e.shiftKey && (e.key === "f" || e.key === "F")) {
    e.preventDefault();
    e.stopPropagation();
    toggleTerminalFullscreen();
    return;
  }
  // Escape — exit fullscreen if in fullscreen
  if (e.key === "Escape") {
    const app = document.getElementById("app");
    if (app?.classList.contains("is-terminal-fullscreen")) {
      e.preventDefault();
      toggleTerminalFullscreen();
    }
    return;
  }
  // Cmd+B — bookmark in active terminal
  if (e.metaKey && !e.shiftKey && (e.key === "b" || e.key === "B")) {
    const active = terminalManager?.getActive();
    if (active?.bookmarkManager) {
      e.preventDefault();
      active.bookmarkManager.addBookmark();
    }
    return;
  }
  // Cmd+] / Cmd+[ — jump next/prev bookmark
  if (e.metaKey && e.key === "]") {
    const active = terminalManager?.getActive();
    if (active?.bookmarkManager) {
      e.preventDefault();
      active.bookmarkManager.jumpNext();
    }
    return;
  }
  if (e.metaKey && e.key === "[") {
    const active = terminalManager?.getActive();
    if (active?.bookmarkManager) {
      e.preventDefault();
      active.bookmarkManager.jumpPrev();
    }
    return;
  }
});

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// Initial render: empty state
renderEmpty();

console.log("[MC App] Renderer ready");
