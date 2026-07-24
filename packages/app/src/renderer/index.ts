/** Modular Context app renderer entry.
 *  Wires AppShell (3-panel layout) + FileTree + EditorPane + TerminalPane. */

export {};

import { sendWhenReady, buildOnboardingPrompt, type FileEntry, type VaultEvent, type OnboardingMission } from "@mc/shared";
import { createAppShell } from "./layout/AppShell";
import { FileTree } from "./layout/FileTree";
// CmEditor replaces the diagnostic <textarea> EditorPane — root cause of the old
// CM6 failure was duplicate @codemirror/state copies in the bundle, deduped via
// esbuild alias. EditorPane.ts stays on disk as an emergency fallback (CM6-DIAGNOSIS.md).
import { CmEditor } from "./layout/CmEditor";
import { TerminalManager } from "./layout/TerminalManager";
import { OnboardingWizard } from "./onboarding/OnboardingWizard";
import { createSignetMark } from "./layout/Loader";
import { buildLeftDock } from "./layout/AppModals";
import { HomeScreen } from "./layout/HomeScreen";
import { GraphView } from "./layout/GraphView";
import type { GraphData } from "../main/graph";

interface McVaultApi {
  listFiles(basePath: string): Promise<FileEntry[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  watchStart(basePath: string): Promise<void>;
  onVaultOpened(cb: (basePath: string) => void): void;
  onGoHome(cb: () => void): void;
  onFileEvent(cb: (event: VaultEvent) => void): void;
}

interface McEditorApi {
  onSaveRequest(cb: () => void): void;
}

const mcVault = (window as any).mcVault as McVaultApi;
const mcEditor = (window as any).mcEditor as McEditorApi;

const root = document.getElementById("app")!;

// Forward renderer-side crashes to the main log so they stop being invisible.
const mcLog = (window as any).mcLog as { error(scope: string, msg: string): void } | undefined;
window.addEventListener("error", (e) => {
  const detail = e.error?.stack ?? `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`;
  console.error("[renderer error]", detail);
  mcLog?.error("error", String(detail));
});
window.addEventListener("unhandledrejection", (e) => {
  const reason = (e as PromiseRejectionEvent).reason;
  const detail = reason?.stack ?? String(reason);
  console.error("[renderer unhandledrejection]", detail);
  mcLog?.error("unhandledrejection", String(detail));
});

let shell: ReturnType<typeof createAppShell> | null = null;
let fileTree: FileTree | null = null;
let editorPane: CmEditor | null = null;
let terminalManager: TerminalManager | null = null;
let currentVault: string | null = null;
let wizard: OnboardingWizard | null = null;
let home: HomeScreen | null = null;
let lastFiles: FileEntry[] = [];

// Editor tabs (multiple open files)
let editorTabsEl: HTMLElement | null = null;
let openTabs: string[] = [];
let activeTab: string | null = null;
let workspaceCreateTimer: number | null = null;

function tabName(path: string): string {
  const base = path.split("/").pop() || path;
  return base.replace(/\.md$/i, "");
}

/** Open a file in a tab (adds it if new) and focus it. */
function openInTab(path: string) {
  if (!editorPane) return;
  if (!openTabs.includes(path)) openTabs.push(path);
  activeTab = path;
  shell?.setReaderVisible(true); // reveal the reader now that a file is open
  editorPane.open(path);
  renderTabBar();
}

function closeTab(path: string) {
  const idx = openTabs.indexOf(path);
  if (idx < 0) return;
  openTabs.splice(idx, 1);
  if (activeTab === path) {
    const next = openTabs[idx] ?? openTabs[idx - 1] ?? null;
    activeTab = next;
    if (next) editorPane?.open(next);
    else editorPane?.clear();
  }
  if (openTabs.length === 0) shell?.setReaderVisible(false); // no files → hide reader, chat fills
  renderTabBar();
}

function renderTabBar() {
  if (!editorTabsEl) return;
  editorTabsEl.innerHTML = "";
  editorTabsEl.style.display = openTabs.length > 0 ? "flex" : "none";
  for (const path of openTabs) {
    const tab = document.createElement("div");
    tab.className = "mc-app-tab" + (path === activeTab ? " is-active" : "");
    tab.title = path;
    const label = document.createElement("span");
    label.className = "mc-app-tab-label";
    label.textContent = tabName(path);
    tab.appendChild(label);
    const close = document.createElement("button");
    close.className = "mc-app-tab-close";
    close.innerHTML = "&times;";
    close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(path); });
    tab.appendChild(close);
    tab.addEventListener("click", () => {
      if (path !== activeTab) { activeTab = path; editorPane?.open(path); renderTabBar(); }
    });
    editorTabsEl.appendChild(tab);
  }
  fileTree?.setActive(activeTab);
}

/** Mount the home dashboard (the landing screen before a vault is open). */
function showHome() {
  home?.destroy();
  home = null;
  root.innerHTML = "";

  // Title bar (drag region) present in every state
  const dragStrip = document.createElement("div");
  dragStrip.className = "mc-app-drag-strip";
  root.appendChild(dragStrip);

  home = new HomeScreen(root, {
    onOpenVault: (path) => {
      void (window as any).mcVault.rememberFolder(path);
      void loadVault(path).then(() => refreshSkills());
    },
    onCreateVault: () => openWizard(null),
    onPickFolder: () => (window as any).mcVault.pickFolder(),
    onSynthesise: (path) => void launchSynthesis(path),
    onAction: (path, archetype) => void launchAction(path, archetype),
    onPrompt: (path, text) => void launchPrompt(path, text),
    onLog: (path) => void launchLog(path),
  });
}

/** Enter the vault and run a free-typed prompt as a Simple-mode session. */
async function launchPrompt(path: string, text: string) {
  await (window as any).mcVault.rememberFolder(path);
  await loadVault(path);
  await refreshSkills();
  if (!terminalManager) return;
  // Typed directly by the operator → expert register, shown as their message.
  // launchPromptSession honors Pro mode (raw terminal vs Simple feed).
  await terminalManager.launchPromptSession("agent", text, { expert: true });
}

/** Each archetype grounds itself in the LIVE vault state at runtime (reads
 *  pipeline / latest session / quest-board) — so the launcher never goes stale. */
const ACTION_PROMPTS: Record<string, string> = {
  "comms-review": [
    "You're helping me triage and respond to my communications.",
    "First get current: run /comms-review if it's available; otherwise check what's waiting across my connected channels (email, Slack, ClickUp tasks/comments) and skim pipeline.md for who matters right now.",
    "Then surface only the comms that actually need me — sorted by urgency × importance — flag anything overdue, and draft replies in my voice where it saves time. Be decisive: tell me what to answer first and hand me the draft, not a list of everything.",
  ].join("\n"),
  strategize: [
    "You're my strategic sounding board — sharp, not flattering.",
    "First get current: read pipeline.md, the newest _claude/4-sessions/ log, and the latest quest-board — find the real state, the contradictions, and the bets in play.",
    "Then step back and name the 2-3 highest-leverage moves right now, leading each with its strongest counter-argument. Tell me what I'm probably getting wrong first. Pick one thread to go deep on with me. No generic advice — ground every point in what's actually in the vault.",
  ].join("\n"),
  copywrite: [
    "You're helping me write something in the house voice.",
    "First get current: skim pipeline.md and the latest session / quest-board so the copy reflects what's true now.",
    "Then ask who it's for and the outcome I want, and produce it — email, post, pitch, one-pager — in the house voice (\"system nerwowy kliniki\", \"ekspertyza z ludzką twarzą\", zero buzzwords, one CTA). Use /copy for short-form or /brief for a PDF/one-pager. Give me a tight first draft, not a menu of options.",
  ].join("\n"),
  research: [
    "You're helping me research a topic properly.",
    "First ask what I want to understand and why it matters now.",
    "Then dig: search the vault for what we already know (modules, transcripts, sessions) and the web for what we don't. Separate what's established from what's uncertain, cite your sources, and end with the 'so what' — what this means for my decisions. Be honest about confidence; an explicit 'unknown' beats a confident guess.",
  ].join("\n"),
};

/** Enter the vault and launch an action archetype as a Simple-mode session. */
async function launchAction(path: string, archetype: string) {
  const mc = (window as any).mcVault;
  await mc.ensureSynthesisSkills(path).catch(() => {}); // installs /decyzja, /synthesise, /process-files
  await mc.rememberFolder(path);
  await loadVault(path);
  await refreshSkills();
  if (!terminalManager) return;
  const prompt = ACTION_PROMPTS[archetype] ?? "";
  const ACTION_LABELS: Record<string, string> = {
    "comms-review": "Comms Review",
    strategize: "Strategize",
    copywrite: "Copywrite",
    research: "Research",
  };
  const label = ACTION_LABELS[archetype] ?? archetype;
  // launchPromptSession honors Pro mode (raw terminal) vs Simple feed.
  await terminalManager.launchPromptSession(label.toLowerCase(), prompt, {
    expert: true,
    displayLabel: label,
  });
}

/** Enter the vault and run /log to capture a worklog entry (sync-icon click). */
async function launchLog(path: string) {
  const mc = (window as any).mcVault;
  await mc.rememberFolder(path);
  await loadVault(path);
  await refreshSkills();
  if (!terminalManager) return;
  await terminalManager.launchSkill("log", "/log");
}

/** Enter the vault and start a synthesis run: process the backlog, fold in the
 *  per-file focus comments, handle non-transcript files too, and answer the
 *  comments once done. Always uses the Simple feed (curated, structured output)
 *  even in Pro mode, so the multi-line instruction lands as one message. */
async function launchSynthesis(path: string) {
  const mc = (window as any).mcVault;
  const [items, notes] = await Promise.all([
    mc.backlog(path).catch(() => [] as Array<{ name: string }>),
    mc.getFileNotes(path).catch(() => ({} as Record<string, string>)),
  ]);

  // Make sure the /synthesise + /process-files commands exist in this vault.
  await mc.ensureSynthesisSkills(path).catch(() => {});

  await mc.rememberFolder(path);
  await loadVault(path);
  await refreshSkills();
  if (!terminalManager) return;

  const commented = (items as Array<{ name: string }>)
    .filter((it) => notes[it.name]?.trim())
    .map((it) => `- ${it.name}: ${notes[it.name].trim()}`);

  // The /synthesise command orchestrates process-transcripts + process-files
  // over the whole backlog. Pass the per-file focus comments in the message.
  const lines = ["/synthesise"];
  if (commented.length > 0) {
    lines.push(
      "",
      "Focus comments the user left on specific files — weave each into how you analyse that file, and answer them in the final section:",
      ...commented,
    );
  }

  await terminalManager.createSimpleSession("synthesise", lines.join("\n"), {
    expert: true,
    displayLabel: "Synthesise backlog",
  });
}

/** Brand header at the top of the left sidebar — a lone signet monogram.
 *  Clicking it returns to the vault dashboard (home). Drag region for the
 *  window; the signet itself is no-drag so the click registers. */
function buildBrandHeader(container: HTMLElement) {
  const header = document.createElement("div");
  header.className = "mc-app-brand-header";
  const mark = createSignetMark(22);
  mark.classList.add("mc-app-brand-home");
  mark.title = "Back to your vaults";
  mark.addEventListener("click", () => void goHome());
  header.appendChild(mark);
  container.appendChild(header);
}

/** Tear down the open vault and return to the launcher dashboard. */
async function goHome() {
  if (terminalManager) { await terminalManager.destroy(); terminalManager = null; }
  if (editorPane) { editorPane.destroy(); editorPane = null; }
  closeGraph();
  currentVault = null;
  lastFiles = [];
  showHome();
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
  home?.destroy();
  home = null;

  // Destroy previous shell contents
  if (terminalManager) await terminalManager.destroy();
  if (editorPane) editorPane.destroy();

  shell = createAppShell(root);

  // Drag strip over the traffic-light row (the shell only pads it out)
  const dragStrip = document.createElement("div");
  dragStrip.className = "mc-app-drag-strip";
  root.appendChild(dragStrip);

  // Left sidebar: brand header (drag region) → file tree → settings dock
  shell.treeEl.innerHTML = "";
  buildBrandHeader(shell.treeEl);
  const treeScrollEl = document.createElement("div");
  treeScrollEl.className = "mc-app-tree-scroll";
  shell.treeEl.appendChild(treeScrollEl);
  buildLeftDock(shell.treeEl, {
    getVaultPath: () => currentVault,
    getTerminalManager: () => terminalManager,
    onSkillsChanged: () => void refreshSkills(),
    launchClaudeSession,
  });

  // Editor column = tab bar (top) + editor host (fills rest).
  openTabs = [];
  activeTab = null;
  shell.editorEl.innerHTML = "";
  editorTabsEl = document.createElement("div");
  editorTabsEl.className = "mc-app-tabs";
  editorTabsEl.style.display = "none";
  shell.editorEl.appendChild(editorTabsEl);
  const editorHostEl = document.createElement("div");
  editorHostEl.className = "mc-app-editor-hostwrap";
  shell.editorEl.appendChild(editorHostEl);

  // No file open yet → hide the reader so the file tree + chat fill the screen.
  // openInTab() reveals it again the moment a file (or workspace deliverable) opens.
  shell.setReaderVisible(false);

  editorPane = new CmEditor(editorHostEl, {
    // [[wiki-link]] → file path: exact relative match first, then basename
    resolveWiki: (target) => {
      const t = target.toLowerCase().replace(/\.md$/i, "");
      const md = lastFiles.filter((f) => !f.isDirectory && f.extension === "md");
      const byRel = md.find((f) => f.relativePath.toLowerCase().replace(/\.md$/i, "") === t);
      if (byRel) return byRel.path;
      const base = t.split("/").pop()!;
      const byName = md.find((f) => f.name.toLowerCase().replace(/\.md$/i, "") === base);
      return byName?.path ?? null;
    },
    onNavigate: (path) => openInTab(path),
  });
  terminalManager = new TerminalManager(shell.terminalEl, basePath);
  terminalManager.onFullscreenToggle = toggleTerminalFullscreen;
  // Create initial session
  terminalManager.create();
  fileTree = new FileTree(treeScrollEl, {
    onFileSelected: (path: string) => openInTab(path),
  });

  try {
    const files = await mcVault.listFiles(basePath);
    lastFiles = files;
    await mcVault.watchStart(basePath);
    fileTree.render(basePath, files);
    console.log(`[MC App] Loaded ${files.length} files from ${basePath}`);
  } catch (err) {
    console.error("[MC App] Vault load failed:", err);
    root.innerHTML = `<div class="mc-app-error">Failed to load vault: ${escape(String(err))}</div>`;
  }
}

// --- Graph view (⌘G) ---

let graphView: GraphView | null = null;
let graphEl: HTMLElement | null = null;

async function toggleGraph() {
  if (graphView) {
    closeGraph();
    return;
  }
  if (!currentVault || !shell) return;
  // Graph lives in the EDITOR column (overlay over the open file) — terminals
  // stay usable on the right, like a graph tab in Obsidian.
  shell.setReaderVisible(true); // the editor column must be visible to host the graph
  graphEl = document.createElement("div");
  shell.editorEl.appendChild(graphEl);
  graphView = new GraphView(graphEl, {
    onOpenFile: (absPath: string) => {
      closeGraph();
      openInTab(absPath);
    },
    onClose: closeGraph,
    onRefresh: async () => {
      const data = (await (window as any).mcVault.buildGraph(currentVault!)) as GraphData;
      graphView?.setData(data);
    },
  });
  const data = (await (window as any).mcVault.buildGraph(currentVault)) as GraphData;
  graphView.setData(data);
}

function closeGraph() {
  graphView?.destroy();
  graphView = null;
  graphEl?.remove();
  graphEl = null;
  if (openTabs.length === 0) shell?.setReaderVisible(false); // back to chat-fills
}

// --- Skills: vault .claude/ scan ∩ registry labels → panel buttons ---

async function refreshSkills() {
  if (!currentVault || !terminalManager) return;
  const mcSkills = (window as any).mcSkills;
  try {
    const [installed, registry] = await Promise.all([
      mcSkills.scanInstalled(currentVault),
      mcSkills.getRegistry(currentVault),
    ]);
    const regMap = new Map<string, any>((registry?.skills ?? []).map((s: any) => [s.id, s]));
    const skills = (installed as string[]).map((id) => ({
      id,
      label: (regMap.get(id)?.label as string | undefined) ?? id,
      slash: `/${id}`,
      primary: !!regMap.get(id)?.primary,
    }));
    terminalManager.setSkills(skills);
  } catch (err) {
    console.warn("[MC App] Skill refresh failed:", err);
  }
}

// --- Onboarding wizard + Start Here agent ---

/** Open a terminal session, launch Claude and paste a prompt once the TUI's
 *  ❯ shows up. Used by the Start Here agent and the connection wizards. */
function launchClaudeSession(name: string, prompt: string) {
  if (!terminalManager) return;
  // claude execs directly in the PTY — no shell prompt, no visible commands
  const session = terminalManager.create(name, terminalManager.buildAgentCmd());
  if (!session) return;
  void session.ready().then(() => {
    if (!terminalManager) return;
    terminalManager.agentTracker.track(session as any, name);
    sendWhenReady(session.process, prompt + "\r");
  });
}

function launchStartHereAgent(mission: OnboardingMission) {
  launchClaudeSession("onboard", buildOnboardingPrompt(mission));
}

function openWizard(existingVaultPath: string | null, recentFolders: string[] = []) {
  if (wizard) return;
  wizard = new OnboardingWizard(document.body, {
    existingVaultPath,
    recentFolders,
    // Always dismissable: re-run over an open vault → back to work;
    // launched from the home dashboard → back to the launcher.
    onDismiss: () => {
      wizard = null;
      if (existingVaultPath || currentVault) void refreshSkills();
      else showHome();
    },
    onFinished: async ({ vaultPath, mission, launchStartHere }) => {
      wizard = null;
      await (window as any).mcVault.rememberFolder(vaultPath);
      await loadVault(vaultPath);
      await refreshSkills();
      if (launchStartHere) launchStartHereAgent(mission);
    },
  });
}

window.addEventListener("mc:rerun-onboarding", () => {
  if (currentVault) openWizard(currentVault);
});

mcVault.onVaultOpened((basePath: string) => {
  // While the wizard is up, a folder pick belongs to its "open existing" flow
  if (wizard) {
    wizard.setExistingVault(basePath);
    return;
  }
  loadVault(basePath)
    .then(() => refreshSkills())
    .catch(console.error);
});

mcVault.onGoHome(() => void goHome());

mcVault.onFileEvent((event: VaultEvent) => {
  console.log("[MC App] File event:", event);
  // Quick refresh on create/delete
  if (event.type === "create" || event.type === "delete") {
    if (currentVault && fileTree) {
      mcVault.listFiles(currentVault).then((files) => {
        lastFiles = files;
        fileTree!.render(currentVault!, files);
        renderTabBar(); // keep active highlight in sync
      });
    }
  }

  // Auto-preview deliverables the agent just created under _workspace/.
  if (event.type === "create" && event.path.includes("/_workspace/")) {
    const previewable = /\.(md|markdown|txt|pdf|png|jpe?g|gif|webp|svg|html?|csv|json)$/i.test(event.path);
    const base = event.path.split("/").pop() || "";
    if (previewable && !base.startsWith(".")) {
      // Debounce a burst of creates → focus only the last one.
      if (workspaceCreateTimer) clearTimeout(workspaceCreateTimer);
      const p = event.path;
      workspaceCreateTimer = window.setTimeout(() => openInTab(p), 600);
    }
  }
  // External modify (usually an agent writing the open file) → editor conflict guard
  if (event.type === "modify") {
    editorPane?.handleExternalChange(event.path);
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
  // Cmd+G — toggle graph view
  if (e.metaKey && !e.shiftKey && (e.key === "g" || e.key === "G")) {
    e.preventDefault();
    void toggleGraph();
    return;
  }
  // Cmd+E — reading ↔ editing toggle (outside CM6; CM6 has its own keymap)
  if (e.metaKey && !e.shiftKey && (e.key === "e" || e.key === "E")) {
    e.preventDefault();
    void editorPane?.toggleMode();
    return;
  }
  // Escape — exit graph / fullscreen
  if (e.key === "Escape") {
    if (graphView) {
      e.preventDefault();
      closeGraph();
      return;
    }
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

// Boot: first run → wizard; otherwise land on the home dashboard. We do NOT
// auto-open the last vault — the launcher is the intended landing (it surfaces
// the last/pinned vaults, one click to enter).
async function boot() {
  showHome();
  try {
    const state = await (window as any).mcOnboarding.getState();
    if (!state.complete) {
      openWizard(null, state.recentFolders ?? []);
    }
  } catch (err) {
    console.error("[MC App] Onboarding state check failed:", err);
  }
}

void boot();

console.log("[MC App] Renderer ready");
