/** TerminalManager — multi-session terminal controller.
 *
 *  Owns the sessions list, active session, layout, and DOM structure:
 *    .mc-app-terminal-root
 *    ├── .mc-app-terminal-tabs     (tab bar — rendered in Iter 5)
 *    ├── .mc-app-terminal-grid     (CSS grid, data-layout attribute)
 *    └── .mc-app-terminal-parking  (hidden, off-screen sessions)
 *
 *  Matches plugin's TerminalView.createSession / switchTo / renderLayout pattern. */

import { SLOT_COUNT, SESSION_GLYPHS, AgentTracker, type FullscreenLayout, type DisplayMode, type SessionGlyph } from "@mc/shared";
import { TerminalSession, pickUnusedGlyph } from "./TerminalSession";
import { showContextMenu } from "./ContextMenu";

interface Skill {
  id: string;
  label: string;
  /** Slash command to send to Claude after launch. Empty = just zsh. */
  slash: string;
  primary?: boolean;
}

/** Modular-context skills registered in `.claude/skills/`. Click = new Claude session + /slash command.
 *  Based on CLAUDE.md skill registry. */
const SKILLS: Skill[] = [
  // Primary — main vault ingestion workflow
  { id: "process-transcripts", label: "Process Transcripts", slash: "/process-transcripts", primary: true },

  // Vault ops
  { id: "pulse",        label: "Pulse",        slash: "/pulse" },
  { id: "reweave",      label: "Reweave",      slash: "/reweave" },
  { id: "graph",        label: "Graph",        slash: "/graph" },
  { id: "vault-audit",  label: "Vault Audit",  slash: "/vault-audit" },
  { id: "sync",         label: "Sync",         slash: "/sync" },

  // Content
  { id: "brief",            label: "Brief",            slash: "/brief" },
  { id: "copy",             label: "Copy",             slash: "/copy" },
  { id: "learned",          label: "Learned",          slash: "/learned" },
  { id: "weekly-learnings", label: "Weekly",           slash: "/weekly-learnings" },
  { id: "xdaily",           label: "xDaily",           slash: "/xdaily" },
  { id: "whatsapp-digest",  label: "WhatsApp",         slash: "/whatsapp-digest" },

  // Discovery
  { id: "playscript", label: "Playscript", slash: "/playscript" },
  { id: "graduate",   label: "Graduate",   slash: "/graduate" },
  { id: "ideas",      label: "Ideas",      slash: "/ideas" },

  // Planning
  { id: "tasklist",      label: "Tasklist",      slash: "/tasklist" },
  { id: "overnight",     label: "Overnight",     slash: "/overnight" },
  { id: "ralph-prompt",  label: "Ralph Prompt",  slash: "/ralph-prompt" },
  { id: "ralph-factory", label: "Ralph Factory", slash: "/ralph-factory" },

  // Meta
  { id: "log",            label: "Log",         slash: "/log" },
  { id: "skill-creator",  label: "New Skill",   slash: "/skill-creator" },
];

const LAYOUT_ICONS: { key: FullscreenLayout; label: string; svg: string }[] = [
  { key: "single",  label: "Single",      svg: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="1.5" y="1.5" width="9" height="9" rx="1"/></svg>' },
  { key: "split-h", label: "Side by side", svg: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="1.5" y="1.5" width="9" height="9" rx="1"/><line x1="6" y1="1.5" x2="6" y2="10.5"/></svg>' },
  { key: "split-v", label: "Stacked",     svg: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="1.5" y="1.5" width="9" height="9" rx="1"/><line x1="1.5" y1="6" x2="10.5" y2="6"/></svg>' },
  { key: "grid",    label: "Grid 2×2",    svg: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="1.5" y="1.5" width="9" height="9" rx="1"/><line x1="6" y1="1.5" x2="6" y2="10.5"/><line x1="1.5" y1="6" x2="10.5" y2="6"/></svg>' },
];

const NEW_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/></svg>';

const FULLSCREEN_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 4V1.5H4M8 1.5h2.5V4M10.5 8v2.5H8M4 10.5H1.5V8"/></svg>';

const SKILL_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 1L7.2 4.4L10.8 4.4L7.8 6.6L9 10L6 7.8L3 10L4.2 6.6L1.2 4.4L4.8 4.4Z"/></svg>';

const COMPACT_ICON_COLLAPSE = '<svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3 L4 6 L7 9"/></svg>';

const COMPACT_ICON_EXPAND = '<svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3 L8 6 L5 9"/></svg>';

const INFO_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="4.5"/><path d="M6 4v0.1M6 5.5V8.5"/></svg>';

function showInfoModal() {
  // Remove existing if any
  document.querySelectorAll(".mc-app-info-backdrop").forEach((el) => el.remove());

  const backdrop = document.createElement("div");
  backdrop.className = "mc-app-info-backdrop";

  const modal = document.createElement("div");
  modal.className = "mc-app-info-modal";

  modal.innerHTML = `
    <h2>Modular Context</h2>
    <p class="mc-app-info-sub">Keybindings & shortcuts</p>

    <table class="mc-app-info-table">
      <tr><td>⌘O</td><td>Open folder</td></tr>
      <tr><td>⌘S</td><td>Save active file</td></tr>
      <tr><td>⌘⇧F</td><td>Toggle terminal fullscreen</td></tr>
      <tr><td>Escape</td><td>Exit fullscreen</td></tr>
      <tr><td>⌘B</td><td>Add bookmark (in terminal)</td></tr>
      <tr><td>⌘]</td><td>Jump to next bookmark</td></tr>
      <tr><td>⌘[</td><td>Jump to previous bookmark</td></tr>
    </table>

    <h3>Terminal panel sections</h3>
    <ul class="mc-app-info-list">
      <li><strong>SKILLS</strong> — click to launch Claude + slash command</li>
      <li><strong>WORKING</strong> — agents currently running</li>
      <li><strong>TO REVIEW</strong> — completed agents waiting for your review</li>
      <li><strong>STANDBY</strong> — untracked terminal sessions</li>
      <li><strong>Auto</strong> — if on, Claude launches with <code>--dangerously-skip-permissions</code></li>
    </ul>

    <button class="mc-app-info-close">Close</button>
  `;

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  modal.querySelector(".mc-app-info-close")?.addEventListener("click", close);
  const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); } };
  document.addEventListener("keydown", esc);
}

interface McPtyApi {
  spawn(opts: { cwd: string; cols: number; rows: number }): Promise<string>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  kill(id: string): Promise<void>;
  onData(cb: (id: string, data: string) => void): void;
  onExit(cb: (id: string) => void): void;
}

const MAX_SESSIONS = 12;

export class TerminalManager {
  private host: HTMLElement;
  private cwd: string;

  rootEl: HTMLElement;
  gridEl: HTMLElement;
  parkingEl: HTMLElement;
  panelEl: HTMLElement;  // Right-side management panel (like plugin's sidebar)

  sessions: TerminalSession[] = [];
  activeSession: TerminalSession | null = null;
  displayMode: DisplayMode = { kind: "inline", layout: "single" };

  private nextId = 1;
  private ptyDataListenerRegistered = false;
  onFullscreenToggle: (() => void) | null = null;

  // Agent tracking
  agentTracker: AgentTracker;
  onAgentsChanged: (() => void) | null = null;
  private pollInterval: number | null = null;

  // Settings
  autoMode = true;
  compactPanel = false;

  constructor(host: HTMLElement, cwd: string) {
    this.host = host;
    this.cwd = cwd;

    // Build DOM skeleton — horizontal: grid | panel (like plugin sidebar on right)
    this.host.innerHTML = "";
    this.host.classList.add("mc-app-terminal-root");

    this.gridEl = document.createElement("div");
    this.gridEl.className = "mc-app-terminal-grid";
    this.gridEl.dataset.layout = this.displayMode.layout;
    this.gridEl.dataset.mode = "inline";
    this.host.appendChild(this.gridEl);

    this.panelEl = document.createElement("div");
    this.panelEl.className = "mc-app-terminal-panel";
    this.host.appendChild(this.panelEl);

    this.parkingEl = document.createElement("div");
    this.parkingEl.className = "mc-app-terminal-parking";
    this.host.appendChild(this.parkingEl);

    this.rootEl = this.host;

    this.setupPtyBridge();

    // Agent tracker — auto-detects Claude TUI in sessions via pollWithSessions
    this.agentTracker = new AgentTracker(() => {
      this.onAgentsChanged?.();
      this.renderTabs();
    });

    // Polling loop — 5s interval, auto-detects agent state
    this.pollInterval = window.setInterval(() => {
      this.agentTracker.pollWithSessions(this.sessions as any);
    }, 5000);

    // Load auto-mode from settings
    const mcSettings = (window as any).mcSettings;
    if (mcSettings?.getAutoMode) {
      mcSettings.getAutoMode().then((v: boolean) => {
        this.autoMode = v;
        this.renderTabs();
      });
    }
  }

  /** Wire window.mcPty.onData/onExit once — routes events to the right session. */
  private setupPtyBridge() {
    if (this.ptyDataListenerRegistered) return;
    const mcPty = (window as any).mcPty as McPtyApi;
    mcPty.onData((id, data) => {
      const session = this.sessions.find((s) => s.getPtySessionId() === id);
      session?.receivePtyData(data);
    });
    mcPty.onExit((id) => {
      const session = this.sessions.find((s) => s.getPtySessionId() === id);
      session?.receivePtyExit();
    });
    this.ptyDataListenerRegistered = true;
  }

  /** Create a new session. Returns the session or null if at max. */
  create(name?: string): TerminalSession | null {
    if (this.sessions.length >= MAX_SESSIONS) {
      console.warn(`[TerminalManager] Max ${MAX_SESSIONS} sessions`);
      return null;
    }
    const id = this.nextId++;
    const usedGlyphs = new Set(this.sessions.map((s) => s.glyph));
    const glyph = pickUnusedGlyph(usedGlyphs, this.sessions.length);

    // Spawn into parking first — renderLayout() moves it into the active pane
    const session = new TerminalSession({
      id,
      name: name ?? `term ${id}`,
      cwd: this.cwd,
      glyph,
      parent: this.parkingEl,
      onActivity: (s) => {
        if (s !== this.activeSession && !s.hasActivity) {
          s.hasActivity = true;
          this.renderTabs();
        }
      },
    });

    this.sessions.push(session);
    this.activeSession = session;
    this.renderLayout();
    this.renderTabs();
    return session;
  }

  /** Launch a modular-context skill: opens new session, runs claude, sends /slash command. */
  async launchSkill(skillId: string, slashCommand?: string) {
    const skill = SKILLS.find((s) => s.id === skillId);
    const displayName = skill?.label ?? skillId;
    const slash = slashCommand ?? skill?.slash ?? "";

    const session = this.create(displayName);
    if (!session) return;
    await session.ready();

    const claudeCmd = this.autoMode ? "claude --dangerously-skip-permissions" : "claude";

    // Track as working immediately (before Claude TUI appears)
    this.agentTracker.track(session as any, displayName);
    this.renderTabs();

    // Step 1: launch claude
    setTimeout(() => {
      session.process.stdin.write(claudeCmd + "\r");

      // Step 2: wait for Claude TUI to load (~2.5s), then send slash command
      if (slash) {
        setTimeout(() => {
          session.process.stdin.write(slash + "\r");
        }, 2800);
      }
    }, 300);
  }

  /** [+] button default action: auto-launches Claude Code (no slash). */
  async newSessionDefault() {
    const session = this.create("claude");
    if (!session) return;
    await session.ready();
    const claudeCmd = this.autoMode ? "claude --dangerously-skip-permissions" : "claude";
    this.agentTracker.track(session as any, "claude");
    this.renderTabs();
    setTimeout(() => {
      session.process.stdin.write(claudeCmd + "\r");
    }, 300);
  }

  setAutoMode(value: boolean) {
    this.autoMode = value;
    const mcSettings = (window as any).mcSettings;
    mcSettings?.setAutoMode?.(value);
    this.renderTabs();
  }

  /** Switch focus to a session. If not visible in current layout, replaces focused slot. */
  switchTo(session: TerminalSession) {
    if (!this.sessions.includes(session) || session === this.activeSession) {
      session.focus();
      return;
    }
    session.hasActivity = false;
    this.activeSession = session;
    this.renderLayout();
    this.renderTabs();
  }

  /** Close a session. Auto-selects neighbor. Destroys PTY + DOM. */
  async close(session: TerminalSession) {
    const idx = this.sessions.indexOf(session);
    if (idx < 0) return;

    // Pick neighbor before removal
    const neighbor = this.sessions[idx + 1] ?? this.sessions[idx - 1] ?? null;

    this.sessions.splice(idx, 1);
    await session.destroy();

    if (this.activeSession === session) {
      this.activeSession = neighbor;
    }

    this.renderLayout();
    this.renderTabs();
  }

  setLayout(layout: FullscreenLayout) {
    this.displayMode = { ...this.displayMode, layout };
    this.gridEl.dataset.layout = layout;
    this.renderLayout();
    this.renderTabs();
  }

  getLayout(): FullscreenLayout {
    return this.displayMode.layout;
  }

  /** Compute which sessions should be visible in the current layout.
   *  Priority: active session first, then surrounding sessions. */
  computeVisible(layout: FullscreenLayout): TerminalSession[] {
    const slotCount = SLOT_COUNT[layout] ?? 1;
    if (this.sessions.length === 0) return [];
    if (slotCount >= this.sessions.length) return [...this.sessions];

    // Center window around active session
    const activeIdx = this.activeSession ? this.sessions.indexOf(this.activeSession) : 0;
    const half = Math.floor((slotCount - 1) / 2);
    let start = Math.max(0, activeIdx - half);
    const end = Math.min(this.sessions.length, start + slotCount);
    if (end - start < slotCount) start = Math.max(0, end - slotCount);
    return this.sessions.slice(start, end);
  }

  /** Single source of truth for DOM layout. Reparents visible sessions to grid panes,
   *  parks others. Called after every state change. */
  renderLayout() {
    const { layout } = this.displayMode;
    const visible = this.computeVisible(layout);
    const visibleSet = new Set(visible);

    // 1. Park invisible sessions
    for (const s of this.sessions) {
      if (!visibleSet.has(s)) {
        if (s.containerEl.parentElement !== this.parkingEl) {
          this.parkingEl.appendChild(s.containerEl);
        }
        s.containerEl.classList.remove("is-active");
        s.containerEl.classList.remove("is-focused");
      }
    }

    // 2. Clear existing panes in grid (but move their session containers back to parking first)
    const existingPanes = Array.from(this.gridEl.querySelectorAll<HTMLElement>(":scope > .mc-pane"));
    for (const pane of existingPanes) {
      const inner = pane.querySelector<HTMLElement>(".mc-app-terminal-session");
      if (inner) this.parkingEl.appendChild(inner);
      pane.remove();
    }

    // 3. Create panes for visible sessions
    for (const session of visible) {
      const pane = document.createElement("div");
      pane.className = "mc-pane";
      pane.dataset.sessionId = String(session.id);
      if (session === this.activeSession) pane.classList.add("is-focused");

      session.containerEl.classList.add("is-active");
      if (session === this.activeSession) session.containerEl.classList.add("is-focused");
      else session.containerEl.classList.remove("is-focused");
      pane.appendChild(session.containerEl);

      pane.addEventListener("mousedown", () => {
        if (this.activeSession !== session) {
          this.switchTo(session);
        } else {
          session.focus();
        }
      });

      this.gridEl.appendChild(pane);
    }

    // 4. Fit + focus after layout settles
    requestAnimationFrame(() => {
      for (const s of visible) {
        if (!s.destroyed) s.fit();
      }
      if (this.activeSession && !this.activeSession.destroyed && visibleSet.has(this.activeSession)) {
        this.activeSession.focus();
      }
    });
  }

  /** Render the right-side management panel (plugin-style wide sidebar ~200px).
   *  Sections: toolbar → layout → SKILLS → WORKING → TO REVIEW → STANDBY → footer (+ New + Auto) */
  renderTabs() {
    while (this.panelEl.firstChild) this.panelEl.removeChild(this.panelEl.firstChild);

    // --- Toolbar: compact, info, fullscreen (plugin-style) ---
    const toolbar = document.createElement("div");
    toolbar.className = "mc-app-panel-toolbar";

    const compactBtn = document.createElement("button");
    compactBtn.className = "mc-app-panel-icon-btn";
    compactBtn.innerHTML = this.compactPanel ? COMPACT_ICON_EXPAND : COMPACT_ICON_COLLAPSE;
    compactBtn.title = this.compactPanel ? "Expand panel" : "Collapse to compact";
    compactBtn.addEventListener("click", () => {
      this.compactPanel = !this.compactPanel;
      this.panelEl.classList.toggle("is-compact", this.compactPanel);
      this.renderTabs();
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent("mc:panes-resized"));
      });
    });
    toolbar.appendChild(compactBtn);

    const infoBtn = document.createElement("button");
    infoBtn.className = "mc-app-panel-icon-btn";
    infoBtn.innerHTML = INFO_ICON_SVG;
    infoBtn.title = "Keybindings & info";
    infoBtn.addEventListener("click", () => showInfoModal());
    toolbar.appendChild(infoBtn);

    const fsBtn = document.createElement("button");
    fsBtn.className = "mc-app-panel-icon-btn";
    fsBtn.innerHTML = FULLSCREEN_ICON_SVG;
    fsBtn.title = "Fullscreen (⌘⇧F)";
    fsBtn.addEventListener("click", () => this.onFullscreenToggle?.());
    toolbar.appendChild(fsBtn);

    this.panelEl.appendChild(toolbar);

    // Compact mode skips most sections — only shows toolbar + layout + sessions tiles + footer
    if (this.compactPanel) {
      this.renderCompactPanel();
      return;
    }

    // --- Layout switcher row ---
    const layoutRow = document.createElement("div");
    layoutRow.className = "mc-app-panel-row mc-app-layout-row";
    for (const l of LAYOUT_ICONS) {
      const btn = document.createElement("button");
      btn.className = "mc-app-layout-btn";
      btn.title = l.label;
      btn.innerHTML = l.svg;
      if (this.displayMode.layout === l.key) btn.classList.add("is-active");
      btn.addEventListener("click", () => this.setLayout(l.key));
      layoutRow.appendChild(btn);
    }
    this.panelEl.appendChild(layoutRow);

    // --- Skills section ---
    const skillsHeader = document.createElement("div");
    skillsHeader.className = "mc-app-panel-header";
    skillsHeader.textContent = "SKILLS";
    this.panelEl.appendChild(skillsHeader);

    const primary = SKILLS.find((s) => s.primary)!;
    const primaryBtn = document.createElement("button");
    primaryBtn.className = "mc-app-skill-primary";
    primaryBtn.textContent = primary.label;
    primaryBtn.title = `Launch Claude + ${primary.slash}`;
    primaryBtn.addEventListener("click", () => this.launchSkill(primary.id));
    this.panelEl.appendChild(primaryBtn);

    const secondaryGrid = document.createElement("div");
    secondaryGrid.className = "mc-app-skill-grid";
    for (const skill of SKILLS.filter((s) => !s.primary)) {
      const btn = document.createElement("button");
      btn.className = "mc-app-skill-secondary";
      btn.textContent = skill.label;
      btn.title = `Launch Claude + ${skill.slash}`;
      btn.addEventListener("click", () => this.launchSkill(skill.id));
      secondaryGrid.appendChild(btn);
    }
    this.panelEl.appendChild(secondaryGrid);

    // --- Session sections (working / review / standby) ---
    const tracked = this.agentTracker.tracked;
    const working = tracked.filter((t) => t.status === "working");
    const review = tracked.filter((t) => t.status === "to-review");
    const trackedIds = new Set(tracked.map((t) => t.sessionId));
    const standby = this.sessions.filter((s) => !trackedIds.has(s.id));

    if (working.length > 0) {
      this.renderSessionSection("WORKING", working.map((t) => {
        return this.sessions.find((s) => s.id === t.sessionId)!;
      }).filter(Boolean), "working");
    }

    if (review.length > 0) {
      this.renderSessionSection("TO REVIEW", review.map((t) => {
        return this.sessions.find((s) => s.id === t.sessionId)!;
      }).filter(Boolean), "review");
    }

    if (standby.length > 0) {
      this.renderSessionSection("STANDBY", standby, "standby");
    }

    // --- Spacer pushes footer to bottom ---
    const spacer = document.createElement("div");
    spacer.className = "mc-app-panel-spacer";
    this.panelEl.appendChild(spacer);

    // --- Footer: + New + Auto toggle ---
    const footer = document.createElement("div");
    footer.className = "mc-app-panel-footer";

    const newBtn = document.createElement("button");
    newBtn.className = "mc-app-panel-new-btn";
    newBtn.innerHTML = `${NEW_ICON_SVG}<span>New</span>`;
    newBtn.title = "New terminal (auto-launches Claude Code)";
    newBtn.addEventListener("click", () => this.newSessionDefault());
    newBtn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showContextMenu(
        [
          { title: "New Claude Code (default)", onClick: () => this.newSessionDefault() },
          { title: "New zsh session", onClick: () => this.create() },
        ],
        e.clientX,
        e.clientY,
      );
    });
    footer.appendChild(newBtn);

    const autoWrap = document.createElement("label");
    autoWrap.className = "mc-app-auto-toggle";
    autoWrap.title = "When on, Claude launches with --dangerously-skip-permissions";

    const autoInput = document.createElement("input");
    autoInput.type = "checkbox";
    autoInput.checked = this.autoMode;
    autoInput.addEventListener("change", () => this.setAutoMode(autoInput.checked));
    autoWrap.appendChild(autoInput);

    const autoLabel = document.createElement("span");
    autoLabel.textContent = "Auto";
    autoWrap.appendChild(autoLabel);

    footer.appendChild(autoWrap);
    this.panelEl.appendChild(footer);
  }

  /** Compact mode: narrow icon-only panel (layout buttons + + new + session glyphs + fullscreen). */
  private renderCompactPanel() {
    // Layout buttons stacked vertically
    const layoutGroup = document.createElement("div");
    layoutGroup.className = "mc-app-panel-row mc-app-layout-row is-vertical";
    for (const l of LAYOUT_ICONS) {
      const btn = document.createElement("button");
      btn.className = "mc-app-layout-btn";
      btn.title = l.label;
      btn.innerHTML = l.svg;
      if (this.displayMode.layout === l.key) btn.classList.add("is-active");
      btn.addEventListener("click", () => this.setLayout(l.key));
      layoutGroup.appendChild(btn);
    }
    this.panelEl.appendChild(layoutGroup);

    // + New (auto-claude)
    const newBtn = document.createElement("button");
    newBtn.className = "mc-app-panel-icon-btn mc-app-panel-btn-new-compact";
    newBtn.innerHTML = NEW_ICON_SVG;
    newBtn.title = "New Claude Code session";
    newBtn.addEventListener("click", () => this.newSessionDefault());
    newBtn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const items = SKILLS.map((s) => ({
        title: `${s.label}  ${s.slash}`,
        onClick: () => this.launchSkill(s.id),
      }));
      showContextMenu(items, e.clientX, e.clientY);
    });
    this.panelEl.appendChild(newBtn);

    // Session glyph tiles
    const tilesWrap = document.createElement("div");
    tilesWrap.className = "mc-app-panel-tiles";
    for (const session of this.sessions) {
      const tile = document.createElement("button");
      tile.className = "mc-app-panel-tile";
      tile.title = session.name;
      tile.innerHTML = this.getGlyphSvg(session.glyph);
      if (session === this.activeSession) tile.classList.add("is-active");
      const tracked = this.agentTracker.tracked.find((t) => t.sessionId === session.id);
      if (tracked?.status === "working") tile.classList.add("agent-working");
      else if (tracked?.status === "to-review") tile.classList.add("agent-review");
      tile.addEventListener("click", () => this.switchTo(session));
      tilesWrap.appendChild(tile);
    }
    this.panelEl.appendChild(tilesWrap);

    // Spacer
    const spacer = document.createElement("div");
    spacer.className = "mc-app-panel-spacer";
    this.panelEl.appendChild(spacer);
  }

  private renderSessionSection(title: string, sessions: TerminalSession[], kind: "working" | "review" | "standby") {
    const header = document.createElement("div");
    header.className = "mc-app-panel-header";
    header.textContent = `${title} · ${sessions.length}`;
    this.panelEl.appendChild(header);

    const list = document.createElement("div");
    list.className = `mc-app-session-cards is-${kind}`;
    for (const session of sessions) {
      const card = document.createElement("div");
      card.className = "mc-app-session-card";
      card.dataset.id = String(session.id);
      if (session === this.activeSession) card.classList.add("is-active");

      const glyph = document.createElement("span");
      glyph.className = "mc-app-session-card-glyph";
      glyph.innerHTML = this.getGlyphSvg(session.glyph);
      card.appendChild(glyph);

      const name = document.createElement("span");
      name.className = "mc-app-session-card-name";
      name.textContent = session.name;
      card.appendChild(name);

      const closeBtn = document.createElement("button");
      closeBtn.className = "mc-app-session-card-close";
      closeBtn.innerHTML = "×";
      closeBtn.title = "Close session";
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.close(session);
      });
      card.appendChild(closeBtn);

      card.addEventListener("click", () => {
        if (kind === "review") {
          this.agentTracker.dismiss(session.id);
        }
        this.switchTo(session);
      });

      card.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showContextMenu(
          [
            { title: `Switch to ${session.name}`, onClick: () => this.switchTo(session) },
            { title: "Rename", onClick: () => {
              const newName = prompt("Rename session:", session.name);
              if (newName?.trim()) { session.name = newName.trim(); this.renderTabs(); }
            }},
            { title: "Duplicate", onClick: () => this.create(session.name + " copy") },
            { title: "", separator: true, onClick: () => {} },
            { title: "Close", onClick: () => this.close(session) },
          ],
          e.clientX,
          e.clientY,
        );
      });

      list.appendChild(card);
    }
    this.panelEl.appendChild(list);
  }



  list(): TerminalSession[] {
    return this.sessions;
  }

  getActive(): TerminalSession | null {
    return this.activeSession;
  }

  getGlyphSvg(glyphId: string): string {
    return SESSION_GLYPHS.find((g) => g.id === glyphId)?.svg ?? SESSION_GLYPHS[0].svg;
  }

  allGlyphs(): SessionGlyph[] {
    return SESSION_GLYPHS;
  }

  async destroy() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.agentTracker.stop();
    for (const s of [...this.sessions]) {
      await s.destroy();
    }
    this.sessions = [];
    this.activeSession = null;
    this.host.innerHTML = "";
  }
}
