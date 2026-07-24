/** Unified settings panel — one sleek modal with a left tab rail:
 *  Skills (library) · Connections (interactive setup-flag driven) · General · Shortcuts.
 *
 *  Connections is the methodology's nervous system: each row mirrors a setup
 *  flag from the skills registry (gsuite-connected, whatsapp-macos, …). Simple
 *  things are fixed natively (git init / remote add+push); anything gnarlier
 *  launches a Claude Code session with a connection-wizard prompt
 *  (@mc/shared buildConnectionPrompt) that walks the user through it.
 */

import type { RegistryData, RegistrySkill, ConnectionKind } from "@mc/shared";
import { CATEGORY_META, buildConnectionPrompt } from "@mc/shared";

export interface DockDeps {
  getVaultPath(): string | null;
  getTerminalManager(): { autoMode: boolean; setAutoMode(v: boolean): void; setProMode?(v: boolean): void } | null;
  onSkillsChanged(): void;
  /** Open a terminal session running Claude with an injected wizard prompt. */
  launchClaudeSession(name: string, prompt: string): void;
}

type PanelTab = "skills" | "connections" | "general" | "shortcuts";

const TAB_META: Array<{ id: PanelTab; label: string; icon: string }> = [
  { id: "skills", label: "Skills", icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.4 5.6.1-4.5 3.4 1.6 5.4-4.6-3.3-4.6 3.3 1.6-5.4L4.5 8.5l5.6-.1z"/></svg>' },
  { id: "connections", label: "Connections", icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12a4.5 4.5 0 0 1 0-6.4l2.3-2.3a4.5 4.5 0 0 1 6.4 6.4l-1.5 1.5M15 12a4.5 4.5 0 0 1 0 6.4l-2.3 2.3a4.5 4.5 0 0 1-6.4-6.4l1.5-1.5"/></svg>' },
  { id: "general", label: "General", icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>' },
  { id: "shortcuts", label: "Shortcuts", icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h0M10.5 10h0M14.5 10h0M17.5 10h0M7 14h10"/></svg>' },
];

// Module-level deps so showShortcutsModal() (called from TerminalManager's
// info button) can open the panel without threading deps through.
let panelDeps: DockDeps | null = null;

export function showShortcutsModal() {
  if (panelDeps) showSettingsPanel(panelDeps, "shortcuts");
}

// ─────────────────────────── panel skeleton ───────────────────────────

export function showSettingsPanel(deps: DockDeps, initialTab: PanelTab = "skills") {
  document.querySelectorAll(".mc-app-modal-backdrop").forEach((el) => el.remove());

  const backdrop = document.createElement("div");
  backdrop.className = "mc-app-modal-backdrop";

  const panel = document.createElement("div");
  panel.className = "mc-app-modal is-settings-panel";
  backdrop.appendChild(panel);

  // Left tab rail
  const rail = document.createElement("div");
  rail.className = "mc-app-panel-rail";
  panel.appendChild(rail);

  const content = document.createElement("div");
  content.className = "mc-app-panel-content";
  panel.appendChild(content);

  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener("keydown", onKey);

  const tabButtons = new Map<PanelTab, HTMLElement>();
  let activeTab: PanelTab = initialTab;

  const renderTab = (tab: PanelTab) => {
    activeTab = tab;
    for (const [id, btn] of tabButtons) btn.classList.toggle("is-active", id === tab);
    content.innerHTML = "";
    switch (tab) {
      case "skills": void renderSkillsTab(content, deps); break;
      case "connections": void renderConnectionsTab(content, deps, close); break;
      case "general": void renderGeneralTab(content, deps, close); break;
      case "shortcuts": renderShortcutsTab(content); break;
    }
  };

  for (const tab of TAB_META) {
    const btn = document.createElement("button");
    btn.className = "mc-app-panel-tab";
    btn.innerHTML = `${tab.icon}<span>${tab.label}</span>`;
    btn.addEventListener("click", () => renderTab(tab.id));
    rail.appendChild(btn);
    tabButtons.set(tab.id, btn);
  }

  const railSpacer = document.createElement("div");
  railSpacer.className = "mc-app-panel-rail-spacer";
  rail.appendChild(railSpacer);

  const closeBtn = document.createElement("button");
  closeBtn.className = "mc-app-panel-tab is-close";
  closeBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg><span>Close</span>`;
  closeBtn.addEventListener("click", close);
  rail.appendChild(closeBtn);

  document.body.appendChild(backdrop);
  renderTab(activeTab);
}

function sectionLabel(container: HTMLElement, text: string) {
  const el = document.createElement("div");
  el.className = "mc-app-modal-section";
  el.textContent = text;
  container.appendChild(el);
  return el;
}

function hint(container: HTMLElement, text: string) {
  const el = document.createElement("div");
  el.className = "mc-app-modal-hint";
  el.textContent = text;
  container.appendChild(el);
  return el;
}

// ─────────────────────────── Skills tab ───────────────────────────

async function renderSkillsTab(body: HTMLElement, deps: DockDeps) {
  const vaultPath = deps.getVaultPath();
  if (!vaultPath) {
    hint(body, "Open a vault first.");
    return;
  }

  const loading = hint(body, "Loading library…");
  const mcSkills = (window as any).mcSkills;
  const [registry, installed] = await Promise.all([
    mcSkills.getRegistry(vaultPath) as Promise<RegistryData | null>,
    mcSkills.scanInstalled(vaultPath) as Promise<string[]>,
  ]);
  loading.remove();

  if (!registry) {
    hint(body, "Could not load the skill library — check your internet connection.");
    return;
  }

  const installedSet = new Set(installed);
  const byCategory = new Map<string, RegistrySkill[]>();
  for (const skill of registry.skills) {
    const cat = skill.category && CATEGORY_META[skill.category] ? skill.category : "other";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(skill);
  }

  for (const [cat, skills] of byCategory) {
    const meta = CATEGORY_META[cat] ?? CATEGORY_META.other;
    sectionLabel(body, `${meta.icon} ${meta.label.toUpperCase()}`);

    for (const skill of skills) {
      const row = document.createElement("div");
      row.className = "mc-app-skill-lib-row";

      const text = document.createElement("div");
      text.className = "mc-app-skill-lib-text";
      const name = document.createElement("strong");
      name.textContent = skill.label;
      text.appendChild(name);
      const desc = document.createElement("span");
      desc.textContent = skill.description.split(".")[0];
      text.appendChild(desc);
      row.appendChild(text);

      const action = document.createElement("div");
      action.className = "mc-app-skill-lib-action";
      if (installedSet.has(skill.id)) {
        action.innerHTML = `<span class="mc-app-skill-lib-installed">Installed ✓</span>`;
      } else {
        const btn = document.createElement("button");
        btn.className = "mc-app-modal-btn";
        btn.textContent = "Install";
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          btn.textContent = "…";
          const count = (await mcSkills.install(vaultPath, [skill.id])) as number;
          if (count > 0) {
            action.innerHTML = `<span class="mc-app-skill-lib-installed">Installed ✓</span>`;
            deps.onSkillsChanged();
          } else {
            btn.disabled = false;
            btn.textContent = "Install";
          }
        });
        action.appendChild(btn);
      }
      row.appendChild(action);
      body.appendChild(row);
    }
  }
}

// ─────────────────────────── Connections tab ───────────────────────────

interface ConnectionsStatus {
  git: { isRepo: boolean; branch?: string | null; remoteUrl?: string | null; lastCommit?: string | null };
  flags: Record<string, boolean>;
}

async function renderConnectionsTab(body: HTMLElement, deps: DockDeps, closePanel: () => void) {
  const vaultPath = deps.getVaultPath();
  if (!vaultPath) {
    hint(body, "Open a vault first.");
    return;
  }

  const intro = document.createElement("p");
  intro.className = "mc-app-panel-intro";
  intro.textContent =
    "Each connection unlocks skills in the registry. Green = the skills that need it will work. Complex setups launch a Claude session that walks you through.";
  body.appendChild(intro);

  const loading = hint(body, "Checking connections…");
  const status = (await (window as any).mcConnections.status(vaultPath)) as ConnectionsStatus;
  loading.remove();

  const launchWizard = (kind: ConnectionKind, label: string) => {
    closePanel();
    deps.launchClaudeSession(`connect ${label}`, buildConnectionPrompt(kind));
  };

  const refresh = () => {
    body.innerHTML = "";
    void renderConnectionsTab(body, deps, closePanel);
  };

  // --- Git / GitHub ---
  const git = status.git;
  const gitRow = connectionRow(body, {
    ok: !!(git.isRepo && git.remoteUrl),
    warn: git.isRepo && !git.remoteUrl,
    title: !git.isRepo ? "Git — not initialized" : git.remoteUrl ? `GitHub · ${git.branch ?? ""}` : `Git · ${git.branch ?? ""} (local only)`,
    detail: !git.isRepo
      ? "Versioning is the wiki's changelog — initialize git to get rollback and history for free."
      : git.remoteUrl
        ? `${git.remoteUrl}\n${git.lastCommit ?? ""}`
        : "No remote — add a GitHub repository to sync the vault across machines.",
    unlocks: "log, reweave, every commit-based workflow",
  });
  if (!git.isRepo) {
    const btn = actionBtn(gitRow, "Initialize git");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "…";
      await (window as any).mcGit.init(vaultPath);
      refresh();
    });
  } else if (!git.remoteUrl) {
    const input = document.createElement("input");
    input.className = "mc-app-conn-input";
    input.placeholder = "git@github.com:you/vault.git";
    gitRow.actions.appendChild(input);
    const btn = actionBtn(gitRow, "Add & push");
    btn.addEventListener("click", async () => {
      if (!input.value.trim()) return;
      btn.disabled = true;
      btn.textContent = "Pushing…";
      const res = (await (window as any).mcGit.addRemote(vaultPath, input.value)) as { ok: boolean; out: string };
      if (res.ok) refresh();
      else {
        btn.disabled = false;
        btn.textContent = "Add & push";
        errorNote(gitRow.actions, `${res.out} — the wizard can sort out auth.`);
      }
    });
    wizardBtn(gitRow, () => launchWizard("github", "GitHub"));
  }

  // --- Google Workspace ---
  const gRow = connectionRow(body, {
    ok: status.flags["gsuite-connected"],
    title: "Google Workspace",
    detail: status.flags["gsuite-connected"]
      ? "Connected — Gmail + Calendar available as tools for Claude."
      : "Gmail + Calendar as tools for Claude — the comms layer of the AI Company Stack.",
    unlocks: "gsuite-analysis, comms-review",
  });
  if (!status.flags["gsuite-connected"]) {
    wizardBtn(gRow, () => launchWizard("google", "Google"));
  }

  // --- WhatsApp ---
  const wRow = connectionRow(body, {
    ok: status.flags["whatsapp-macos"],
    title: "WhatsApp (macOS)",
    detail: status.flags["whatsapp-macos"]
      ? "WhatsApp Desktop detected — digest skills can read local chats (after Full Disk Access)."
      : "WhatsApp Desktop not found — needed for group-chat digests.",
    unlocks: "whatsapp-digest, comms-review",
  });
  wizardBtn(wRow, () => launchWizard("whatsapp", "WhatsApp"));

  // --- ClickUp ---
  const cRow = connectionRow(body, {
    ok: status.flags["clickup-connected"],
    title: "ClickUp",
    detail: status.flags["clickup-connected"]
      ? "API token stored — review skills can read your task/CRM state."
      : "Connect an API token to let review skills read tasks and pipelines.",
    unlocks: "clickup-review, comms-review",
  });
  if (!status.flags["clickup-connected"]) {
    wizardBtn(cRow, () => launchWizard("clickup", "ClickUp"));
  }

  // --- Python ---
  const pRow = connectionRow(body, {
    ok: status.flags["python3"],
    title: "Python 3",
    detail: status.flags["python3"]
      ? "python3 available — terminals, graph scripts and PDF rendering all work."
      : "python3 missing — terminals cannot start without it.",
    unlocks: "brief (PDF), graph, the terminal itself",
  });
  if (!status.flags["python3"]) {
    wizardBtn(pRow, () => launchWizard("python", "Python"));
  }
}

function connectionRow(
  body: HTMLElement,
  opts: { ok: boolean; warn?: boolean; title: string; detail: string; unlocks: string },
): { row: HTMLElement; actions: HTMLElement } {
  const row = document.createElement("div");
  row.className = "mc-app-conn-row";

  const dot = document.createElement("span");
  dot.className = `mc-app-dot ${opts.ok ? "is-on" : opts.warn ? "is-warn" : "is-off"}`;
  row.appendChild(dot);

  const text = document.createElement("div");
  text.className = "mc-app-conn-text";
  const title = document.createElement("strong");
  title.textContent = opts.title;
  text.appendChild(title);
  for (const line of opts.detail.split("\n").filter(Boolean)) {
    const span = document.createElement("span");
    span.textContent = line;
    text.appendChild(span);
  }
  const unlocks = document.createElement("em");
  unlocks.className = "mc-app-conn-unlocks";
  unlocks.textContent = `unlocks: ${opts.unlocks}`;
  text.appendChild(unlocks);
  row.appendChild(text);

  const actions = document.createElement("div");
  actions.className = "mc-app-conn-actions";
  row.appendChild(actions);

  body.appendChild(row);
  return { row, actions };
}

function actionBtn(target: { actions: HTMLElement }, label: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "mc-app-modal-btn is-primary";
  btn.textContent = label;
  target.actions.appendChild(btn);
  return btn;
}

function wizardBtn(target: { actions: HTMLElement }, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "mc-app-modal-btn";
  btn.textContent = "Connect with Claude";
  btn.title = "Opens a Claude Code session that walks you through the setup";
  btn.addEventListener("click", onClick);
  target.actions.appendChild(btn);
  return btn;
}

function errorNote(container: HTMLElement, text: string) {
  container.querySelectorAll(".mc-app-conn-error").forEach((el) => el.remove());
  const el = document.createElement("div");
  el.className = "mc-app-conn-error";
  el.textContent = text;
  container.appendChild(el);
}

// ─────────────────────────── General tab ───────────────────────────

async function renderGeneralTab(body: HTMLElement, deps: DockDeps, closePanel: () => void) {
  const mcSettings = (window as any).mcSettings;

  // Beginner mode — plain-language agent + extra hand-holding (default on)
  const begRow = document.createElement("label");
  begRow.className = "mc-app-setting-row";
  const begCb = document.createElement("input");
  begCb.type = "checkbox";
  begCb.checked = mcSettings.getBeginnerMode ? ((await mcSettings.getBeginnerMode()) as boolean) : true;
  begRow.appendChild(begCb);
  const begText = document.createElement("div");
  begText.innerHTML =
    `<strong>Beginner mode</strong><span>The agent explains every step in plain language and asks before guessing. Best if you're new to AI. Applies to new chats.</span>`;
  begRow.appendChild(begText);
  begCb.addEventListener("change", () => {
    mcSettings.setBeginnerMode?.(begCb.checked);
  });
  body.appendChild(begRow);

  // Pro mode — raw Claude Code terminal instead of the friendly chat feed
  const proRow = document.createElement("label");
  proRow.className = "mc-app-setting-row";
  const proCb = document.createElement("input");
  proCb.type = "checkbox";
  proCb.checked = mcSettings.getProMode ? ((await mcSettings.getProMode()) as boolean) : false;
  proRow.appendChild(proCb);
  const proText = document.createElement("div");
  proText.innerHTML =
    `<strong>Pro mode</strong><span>New sessions open as the original Claude Code terminal (full TUI output) instead of the simplified chat. Applies to new sessions.</span>`;
  proRow.appendChild(proText);
  proCb.addEventListener("change", () => {
    mcSettings.setProMode?.(proCb.checked);
    deps.getTerminalManager()?.setProMode?.(proCb.checked);
  });
  body.appendChild(proRow);

  const autoRow = document.createElement("label");
  autoRow.className = "mc-app-setting-row";
  const autoCb = document.createElement("input");
  autoCb.type = "checkbox";
  autoCb.checked = (await mcSettings.getAutoMode()) as boolean;
  autoRow.appendChild(autoCb);
  const autoText = document.createElement("div");
  autoText.innerHTML =
    `<strong>Auto-mode</strong><span>Let the agent act without asking permission (<code>--dangerously-skip-permissions</code>). Leave off until you trust the flow.</span>`;
  autoRow.appendChild(autoText);
  autoCb.addEventListener("change", () => {
    mcSettings.setAutoMode(autoCb.checked);
    deps.getTerminalManager()?.setAutoMode(autoCb.checked);
  });
  body.appendChild(autoRow);

  const maxRow = document.createElement("div");
  maxRow.className = "mc-app-setting-row is-inline";
  const maxText = document.createElement("div");
  maxText.innerHTML = `<strong>Max sessions</strong><span>Maximum concurrent terminal sessions (1–20)</span>`;
  maxRow.appendChild(maxText);
  const maxInput = document.createElement("input");
  maxInput.type = "number";
  maxInput.min = "1";
  maxInput.max = "20";
  maxInput.className = "mc-app-setting-num";
  maxInput.value = String((await mcSettings.getMaxSessions?.()) ?? 12);
  maxInput.addEventListener("change", () => {
    const v = parseInt(maxInput.value, 10);
    if (!isNaN(v) && v >= 1 && v <= 20) mcSettings.setMaxSessions?.(v);
  });
  maxRow.appendChild(maxInput);
  body.appendChild(maxRow);

  const setupRow = document.createElement("div");
  setupRow.className = "mc-app-setting-row is-inline";
  const setupText = document.createElement("div");
  setupText.innerHTML = `<strong>Onboarding</strong><span>Re-run the setup wizard (environment check, methodology, skills)</span>`;
  setupRow.appendChild(setupText);
  const setupBtn = document.createElement("button");
  setupBtn.className = "mc-app-modal-btn";
  setupBtn.textContent = "Run setup";
  setupBtn.addEventListener("click", () => {
    closePanel();
    window.dispatchEvent(new CustomEvent("mc:rerun-onboarding"));
  });
  setupRow.appendChild(setupBtn);
  body.appendChild(setupRow);
}

// ─────────────────────────── Shortcuts tab ───────────────────────────

function renderShortcutsTab(body: HTMLElement) {
  body.innerHTML = `
    <table class="mc-app-info-table">
      <tr><td>⌘O</td><td>Open folder</td></tr>
      <tr><td>⌘S</td><td>Save active file</td></tr>
      <tr><td>⌘G</td><td>Toggle graph view</td></tr>
      <tr><td>⌘⇧F</td><td>Toggle terminal fullscreen</td></tr>
      <tr><td>Escape</td><td>Exit fullscreen / graph</td></tr>
      <tr><td>⌘B</td><td>Add bookmark (in terminal)</td></tr>
      <tr><td>⌘]</td><td>Jump to next bookmark</td></tr>
      <tr><td>⌘[</td><td>Jump to previous bookmark</td></tr>
    </table>
    <div class="mc-app-modal-section">TERMINAL PANEL</div>
    <ul class="mc-app-info-list">
      <li><strong>SKILLS</strong> — click to launch Claude + slash command</li>
      <li><strong>WORKING</strong> — agents currently running</li>
      <li><strong>TO REVIEW</strong> — completed agents waiting for your review</li>
      <li><strong>STANDBY</strong> — untracked terminal sessions</li>
    </ul>
  `;
}

// ─────────────────────────── Dock (single entry point) ───────────────────────────

export function buildLeftDock(container: HTMLElement, deps: DockDeps): HTMLElement {
  panelDeps = deps;

  const dock = document.createElement("div");
  dock.className = "mc-app-dock";

  const btn = document.createElement("button");
  btn.className = "mc-app-dock-item";
  btn.innerHTML = `${TAB_META[2].icon}<span>Settings</span>`;
  btn.title = "Skills · Connections · General · Shortcuts";
  btn.addEventListener("click", () => showSettingsPanel(deps, "skills"));
  dock.appendChild(btn);

  container.appendChild(dock);
  return dock;
}
