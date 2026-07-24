/** TerminalManager — multi-session terminal controller.
 *
 *  Owns the sessions list, active session, layout, and DOM structure:
 *    .mc-app-terminal-root
 *    ├── .mc-app-terminal-tabs     (tab bar — rendered in Iter 5)
 *    ├── .mc-app-terminal-grid     (CSS grid, data-layout attribute)
 *    └── .mc-app-terminal-parking  (hidden, off-screen sessions)
 *
 *  Matches plugin's TerminalView.createSession / switchTo / renderLayout pattern. */

import { SLOT_COUNT, SESSION_GLYPHS, AgentTracker, sendWhenReady, type FullscreenLayout, type DisplayMode, type SessionGlyph } from "@mc/shared";
import { TerminalSession, pickUnusedGlyph } from "./TerminalSession";
import { SimpleSession } from "./SimpleSession";
import { showContextMenu } from "./ContextMenu";
import { showShortcutsModal } from "./AppModals";

/** Either transport behind one session list: PTY terminal or Simple chat feed. */
export type AnySession = TerminalSession | SimpleSession;

/** Friendly starter prompts shown in a blank Simple-mode chat. */
const SUGGESTED_PROMPTS: string[] = [
  "What's in my vault? Give me a quick tour.",
  "Summarise what I worked on this week.",
  "What needs my attention right now?",
  "Help me turn my latest notes into a summary.",
];

export interface Skill {
  id: string;
  label: string;
  /** Slash command to send to Claude after launch. Empty = just zsh. */
  slash: string;
  primary?: boolean;
}

// Skills are no longer hardcoded — the renderer scans the vault's .claude/
// (installed skills) and joins it with the public registry for labels, then
// calls setSkills(). An empty list renders an install hint instead of buttons
// that would send unknown slash commands to Claude.

const LAYOUT_ICONS: { key: FullscreenLayout; label: string; svg: string }[] = [
  { key: "single",  label: "Single",      svg: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="1.5" y="1.5" width="9" height="9" rx="1"/></svg>' },
  { key: "split-h", label: "Side by side", svg: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="1.5" y="1.5" width="9" height="9" rx="1"/><line x1="6" y1="1.5" x2="6" y2="10.5"/></svg>' },
  { key: "split-v", label: "Stacked",     svg: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="1.5" y="1.5" width="9" height="9" rx="1"/><line x1="1.5" y1="6" x2="10.5" y2="6"/></svg>' },
  { key: "grid",    label: "Grid 2×2",    svg: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="1.5" y="1.5" width="9" height="9" rx="1"/><line x1="6" y1="1.5" x2="6" y2="10.5"/><line x1="1.5" y1="6" x2="10.5" y2="6"/></svg>' },
];

const NEW_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/></svg>';

const FULLSCREEN_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 4V1.5H4M8 1.5h2.5V4M10.5 8v2.5H8M4 10.5H1.5V8"/></svg>';

const SKILL_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 1L7.2 4.4L10.8 4.4L7.8 6.6L9 10L6 7.8L3 10L4.2 6.6L1.2 4.4L4.8 4.4Z"/></svg>';

// Panel sits at the RIGHT edge: collapsing pushes it toward the edge (→),
// expanding pulls it back out (←).
const COMPACT_ICON_COLLAPSE = '<svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3 L8 6 L5 9"/></svg>';

const COMPACT_ICON_EXPAND = '<svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3 L4 6 L7 9"/></svg>';

// Lucide-style skill icons (mirrors the plugin's getSkillIcon mapping)
const I = (paths: string) =>
  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const SKILL_ICONS: Record<string, string> = {
  "start-here": I('<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>'),
  "process-transcripts": I('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>'),
  pulse: I('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
  brief: I('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M12 18v-6M9 15l3 3 3-3"/>'),
  log: I('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'),
  ideas: I('<path d="M9 18h6M10 22h4M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/>'),
  reweave: I('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  "vault-audit": I('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>'),
  graph: I('<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9M12 12v3"/>'),
  graduate: I('<path d="M22 10L12 5 2 10l10 5 10-5z"/><path d="M6 12v5c0 1.66 2.69 3 6 3s6-1.34 6-3v-5"/>'),
  "whatsapp-digest": I('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/>'),
  "gsuite-analysis": I('<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><path d="M22 6l-10 7L2 6"/>'),
  "skills-audit": I('<path d="M12 3l1.9 5.4 5.6.1-4.5 3.4 1.6 5.4-4.6-3.3-4.6 3.3 1.6-5.4L4.5 8.5l5.6-.1z"/>'),
};

const SKILL_ICON_FALLBACK = I('<path d="M4 17l6-6-6-6M12 19h8"/>'); // terminal

function getSkillIcon(skillId: string): string {
  return SKILL_ICONS[skillId] ?? SKILL_ICON_FALLBACK;
}

const INFO_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="4.5"/><path d="M6 4v0.1M6 5.5V8.5"/></svg>';

// Info/shortcuts modal lives in AppModals.ts (showShortcutsModal) — shared with the left dock.

interface McPtyApi {
  spawn(opts: { cwd: string; cols: number; rows: number }): Promise<string>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  kill(id: string): Promise<void>;
  onData(cb: (id: string, data: string) => void): void;
  onExit(cb: (id: string) => void): void;
}

const DEFAULT_MAX_SESSIONS = 12;

export class TerminalManager {
  private host: HTMLElement;
  private cwd: string;

  rootEl: HTMLElement;
  gridEl: HTMLElement;
  parkingEl: HTMLElement;
  panelEl: HTMLElement;  // Right-side management panel (like plugin's sidebar)
  railEl!: HTMLElement;  // Always-visible glyph tiles at the right edge
  inputBarEl!: HTMLElement; // Native "message the agent" bar under the grid

  sessions: AnySession[] = [];
  activeSession: AnySession | null = null;
  displayMode: DisplayMode = { kind: "inline", layout: "single" };

  private nextId = 1;
  private ptyDataListenerRegistered = false;
  onFullscreenToggle: (() => void) | null = null;

  // Agent tracking
  agentTracker: AgentTracker;
  onAgentsChanged: (() => void) | null = null;
  private pollInterval: number | null = null;

  // Settings
  autoMode = false; // opt-in only — launches Claude with --dangerously-skip-permissions
  proMode = false; // when on, new sessions open as the raw Claude Code terminal (TUI)
  maxSessions = DEFAULT_MAX_SESSIONS;
  compactPanel = false;
  /** Blocks panel re-renders while an inline rename input is mounted (5s poll would destroy it). */
  private isRenaming = false;

  /** Installed skills (vault .claude/ scan ∩ registry labels) — set by the renderer. */
  skills: Skill[] = [];
  /** User-added custom skills (persisted in localStorage). */
  private customSkills: Skill[] = [];
  /** Expanded state of the over-limit (hidden) secondary skills. */
  private showHiddenSkills = false;

  constructor(host: HTMLElement, cwd: string) {
    this.host = host;
    this.cwd = cwd;

    // Build DOM skeleton — horizontal: grid | panel (like plugin sidebar on right)
    this.host.innerHTML = "";
    this.host.classList.add("mc-app-terminal-root");

    // Grid + input bar live in one column; panel + rail sit to the right
    const gridColumn = document.createElement("div");
    gridColumn.className = "mc-app-terminal-grid-column";
    this.host.appendChild(gridColumn);

    this.gridEl = document.createElement("div");
    this.gridEl.className = "mc-app-terminal-grid";
    this.gridEl.dataset.layout = this.displayMode.layout;
    this.gridEl.dataset.mode = "inline";
    gridColumn.appendChild(this.gridEl);

    // Friendly input bar — type to the agent without clicking into the TUI
    this.inputBarEl = this.buildInputBar();
    gridColumn.appendChild(this.inputBarEl);

    this.panelEl = document.createElement("div");
    this.panelEl.className = "mc-app-terminal-panel";
    this.host.appendChild(this.panelEl);

    // Glyph rail — always-visible session tiles at the right edge (the
    // plugin's compact-sidebar glyphs, kept permanently in view).
    this.railEl = document.createElement("div");
    this.railEl.className = "mc-app-glyph-rail";
    this.host.appendChild(this.railEl);

    this.parkingEl = document.createElement("div");
    this.parkingEl.className = "mc-app-terminal-parking";
    this.host.appendChild(this.parkingEl);

    this.rootEl = this.host;

    this.setupPtyBridge();
    this.setupSimpleBridge();

    // Agent tracker — auto-detects Claude TUI in sessions via pollWithSessions
    this.agentTracker = new AgentTracker(() => {
      this.onAgentsChanged?.();
      this.renderTabs();
    });

    // Polling loop — 5s interval, auto-detects agent state
    this.pollInterval = window.setInterval(() => {
      this.agentTracker.pollWithSessions(this.sessions as any);
    }, 5000);

    // Load settings
    const mcSettings = (window as any).mcSettings;
    if (mcSettings?.getAutoMode) {
      mcSettings.getAutoMode().then((v: boolean) => {
        this.autoMode = v;
        this.renderTabs();
      });
    }
    if (mcSettings?.getMaxSessions) {
      mcSettings.getMaxSessions().then((v: number) => {
        if (Number.isFinite(v) && v >= 1 && v <= 20) this.maxSessions = v;
      });
    }
    if (mcSettings?.getProMode) {
      mcSettings.getProMode().then((v: boolean) => { this.proMode = v; });
    }
  }

  setProMode(value: boolean) {
    this.proMode = value;
    (window as any).mcSettings?.setProMode?.(value);
  }

  /** Route headless stream-json events to their SimpleSession. */
  private setupSimpleBridge() {
    const mcSimple = (window as any).mcSimple;
    if (!mcSimple?.onEvent) return;
    mcSimple.onEvent((extId: string, evt: any) => {
      const s = this.sessions.find(
        (x) => (x as any).kind === "simple" && (x as SimpleSession).getExternalId() === extId,
      ) as SimpleSession | undefined;
      s?.receiveEvent(evt);
    });
  }

  /** Wire window.mcPty.onData/onExit once — routes events to the right session. */
  private setupPtyBridge() {
    if (this.ptyDataListenerRegistered) return;
    const mcPty = (window as any).mcPty as McPtyApi;
    mcPty.onData((id, data) => {
      const session = this.terminalSessions().find((s) => s.getPtySessionId() === id);
      session?.receivePtyData(data);
    });
    mcPty.onExit((id) => {
      const session = this.terminalSessions().find((s) => s.getPtySessionId() === id);
      session?.receivePtyExit();
    });
    this.ptyDataListenerRegistered = true;
  }

  private terminalSessions(): TerminalSession[] {
    return this.sessions.filter((s): s is TerminalSession => (s as any).kind !== "simple");
  }

  /** Create a Simple-mode session: headless Claude rendered as a chat feed.
   *  This is the default, friendly face — the terminal is the advanced view.
   *  opts.expert = terse power-user register (for dashboard "moves");
   *  opts.displayLabel = show a clean launch chip instead of the raw prompt. */
  async createSimpleSession(
    name: string,
    prompt: string,
    opts?: { expert?: boolean; displayLabel?: string },
  ): Promise<SimpleSession | null> {
    if (this.sessions.length >= this.maxSessions) return null;
    const mcSimple = (window as any).mcSimple;
    if (!mcSimple?.spawn) return null;

    const id = this.nextId++;
    const usedGlyphs = new Set(this.sessions.map((s) => s.glyph));
    const glyph = pickUnusedGlyph(usedGlyphs, this.sessions.length);

    let externalId = "";
    const session = new SimpleSession({
      id,
      name,
      glyph,
      parent: this.parkingEl,
      suggestions: SUGGESTED_PROMPTS,
      api: {
        send: (t: string) => { if (externalId) mcSimple.send(externalId, t); },
        respond: (rid: string, allow: boolean, input: any) => {
          if (externalId) mcSimple.respond(externalId, rid, allow, input);
        },
        answerTool: (toolUseId: string, content: string) => {
          if (externalId) mcSimple.answer(externalId, toolUseId, content);
        },
        interrupt: () => { if (externalId) mcSimple.interrupt(externalId); },
        kill: () => { if (externalId) mcSimple.kill(externalId); },
      },
      onActivity: (s) => {
        if ((s as any) !== this.activeSession && !s.hasActivity) {
          s.hasActivity = true;
          this.renderTabs();
        }
      },
    });

    this.sessions.push(session);
    this.activeSession = session;
    this.renderLayout();
    this.renderTabs();

    // Expert register (moves) overrides the global beginner setting.
    const beginner = opts?.expert
      ? false
      : (window as any).mcSettings?.getBeginnerMode
        ? await (window as any).mcSettings.getBeginnerMode()
        : true;
    externalId = await mcSimple.spawn({
      cwd: this.cwd,
      prompt,
      // Auto = full autonomy; otherwise edits auto-accepted, the rest asks
      permissionMode: this.autoMode ? "bypassPermissions" : "acceptEdits",
      beginner: !!beginner,
      expert: !!opts?.expert,
    });
    session.setExternalId(externalId);
    // Show a clean launch chip for moves; a plain user bubble otherwise.
    if (opts?.displayLabel) session.addLaunchChip(opts.displayLabel);
    else if (prompt.trim()) session.addUserMessage(prompt);
    this.agentTracker.track(session as any, name);
    this.renderTabs();
    return session;
  }

  /** Launch a free prompt / dashboard move. Honors Pro mode: in Pro mode it
   *  opens the raw Claude Code terminal and types the prompt in; otherwise it
   *  uses the friendly Simple feed. (Fixes moves always opening Simple/beginner.) */
  async launchPromptSession(
    name: string,
    prompt: string,
    opts?: { expert?: boolean; displayLabel?: string },
  ): Promise<TerminalSession | SimpleSession | null> {
    if (this.proMode) {
      const session = this.create(name, this.buildAgentCmd());
      if (!session) return null;
      await session.ready();
      this.agentTracker.track(session as any, name);
      this.renderTabs();
      if (prompt.trim()) {
        (session as any)._skillCleanup = sendWhenReady(session.process, prompt + "\r");
      }
      return session;
    }
    return this.createSimpleSession(name, prompt, opts);
  }

  /** Build the agent launch command (the user never sees this string). */
  buildAgentCmd(): string {
    return this.autoMode ? "claude --dangerously-skip-permissions" : "claude";
  }

  /** Create a new session. `cmd` execs directly (no visible shell). */
  create(name?: string, cmd?: string): TerminalSession | null {
    if (this.sessions.length >= this.maxSessions) {
      console.warn(`[TerminalManager] Max ${this.maxSessions} sessions`);
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
      cmd,
      parent: this.parkingEl,
      onActivity: (s) => {
        if (s !== this.activeSession && !s.hasActivity) {
          s.hasActivity = true;
          this.renderTabs();
        }
      },
      onStateHint: () => this.renderTabs(),
    });

    this.sessions.push(session);
    this.activeSession = session;
    this.renderLayout();
    this.renderTabs();
    return session;
  }

  /** Replace the skills list and re-render the panel. Custom (user-added)
   *  skills are merged in unless a registry/installed skill shadows the id. */
  setSkills(skills: Skill[]) {
    this.loadCustomSkills();
    const ids = new Set(skills.map((s) => s.id));
    this.skills = [...skills, ...this.customSkills.filter((c) => !ids.has(c.id))];
    this.renderTabs();
  }

  private loadCustomSkills() {
    try {
      const raw = localStorage.getItem("mc-app-custom-skills");
      this.customSkills = raw ? (JSON.parse(raw) as Skill[]) : [];
    } catch {
      this.customSkills = [];
    }
  }

  addCustomSkill(id: string) {
    const slug = id.trim().replace(/^\//, "");
    if (!slug || this.skills.some((s) => s.id === slug)) return;
    const skill: Skill = { id: slug, label: slug, slash: `/${slug}` };
    this.customSkills.push(skill);
    try {
      localStorage.setItem("mc-app-custom-skills", JSON.stringify(this.customSkills));
    } catch {}
    this.skills.push(skill);
    this.renderTabs();
  }

  /** Launch a skill. Default = Simple mode (native chat feed, headless claude);
   *  Pro mode (or opts.terminal) = the raw Claude Code terminal (TUI). */
  async launchSkill(skillId: string, slashCommand?: string, opts?: { terminal?: boolean }) {
    const skill = this.skills.find((s) => s.id === skillId);
    const displayName = skill?.label ?? skillId;
    const slash = slashCommand ?? skill?.slash ?? "";

    if (!opts?.terminal && !this.proMode) {
      await this.createSimpleSession(displayName, slash);
      return;
    }

    const session = this.create(displayName, this.buildAgentCmd());
    if (!session) return;
    await session.ready();

    // Track as working immediately (before Claude TUI appears)
    this.agentTracker.track(session as any, displayName);
    this.renderTabs();

    if (slash) {
      (session as any)._skillCleanup = sendWhenReady(session.process, slash + "\r");
    }
  }

  /** [+] button default action: blank chat (or terminal agent in Pro mode). */
  async newSessionDefault() {
    if (this.proMode) {
      await this.newTerminalAgent();
      return;
    }
    await this.createSimpleSession("agent", "");
  }

  /** Advanced: full Claude TUI in a real terminal (claude execs directly). */
  async newTerminalAgent() {
    const session = this.create("agent", this.buildAgentCmd());
    if (!session) return;
    await session.ready();
    this.agentTracker.track(session as any, "agent");
    this.renderTabs();
  }

  setAutoMode(value: boolean) {
    this.autoMode = value;
    const mcSettings = (window as any).mcSettings;
    mcSettings?.setAutoMode?.(value);
    this.renderTabs();
  }

  /** Switch focus to a session. If not visible in current layout, replaces focused slot. */
  switchTo(session: AnySession) {
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
  async close(session: AnySession) {
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
  computeVisible(layout: FullscreenLayout): AnySession[] {
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

    // Manager-level input bar is a helper for the friendly terminal view only.
    // Hidden for Simple sessions (they have their own input) and in Pro mode
    // (power users type directly in the Claude Code TUI — no duplicate box).
    if (this.inputBarEl) {
      const isSimple = (this.activeSession as any)?.kind === "simple";
      this.inputBarEl.style.display = isSimple || this.proMode ? "none" : "flex";
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
    this.renderGlyphRail();
    if (this.isRenaming) return;
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
    infoBtn.addEventListener("click", () => showShortcutsModal());
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

    if (this.skills.length === 0) {
      const hint = document.createElement("div");
      hint.className = "mc-app-skill-empty";
      hint.textContent = "No skills installed yet — open Settings to install skills.";
      this.panelEl.appendChild(hint);
    } else {
      // Plugin layout: ALL primary skills as full-width icon rows, the rest as
      // a wrapping row of compact buttons. Default cap of 10 secondaries —
      // overflow collapses behind a "show hidden" toggle.
      const primaries = this.skills.filter((s) => s.primary);
      const primaryList = primaries.length > 0 ? primaries.slice(0, 3) : this.skills.slice(0, 1);
      for (const skill of primaryList) {
        const btn = document.createElement("button");
        btn.className = "mc-app-skill-btn is-primary";
        btn.innerHTML = `<span class="mc-app-skill-icon">${getSkillIcon(skill.id)}</span><span class="mc-app-skill-label">${skill.label}</span>`;
        btn.title = `Launch Claude + ${skill.slash}`;
        btn.addEventListener("click", () => this.launchSkill(skill.id));
        this.panelEl.appendChild(btn);
      }

      const SECONDARY_LIMIT = 10;
      const secondaries = this.skills.filter((s) => !primaryList.includes(s));
      const visible = this.showHiddenSkills ? secondaries : secondaries.slice(0, SECONDARY_LIMIT);
      const hiddenCount = secondaries.length - Math.min(secondaries.length, SECONDARY_LIMIT);

      const secondaryGrid = document.createElement("div");
      secondaryGrid.className = "mc-app-skill-grid";
      for (const skill of visible) {
        const btn = document.createElement("button");
        btn.className = "mc-app-skill-btn is-secondary";
        btn.innerHTML = `<span class="mc-app-skill-icon">${getSkillIcon(skill.id)}</span><span class="mc-app-skill-label">${skill.label}</span>`;
        btn.title = `Launch Claude + ${skill.slash}`;
        btn.addEventListener("click", () => this.launchSkill(skill.id));
        secondaryGrid.appendChild(btn);
      }

      // "+" — add a custom slash-command skill inline
      const addBtn = document.createElement("button");
      addBtn.className = "mc-app-skill-btn is-secondary mc-app-skill-add";
      addBtn.textContent = "+";
      addBtn.title = "Add a custom skill (slash command)";
      addBtn.addEventListener("click", () => {
        const input = document.createElement("input");
        input.className = "mc-app-skill-add-input";
        input.placeholder = "/my-skill";
        addBtn.replaceWith(input);
        this.isRenaming = true; // reuse the render lock so the poll doesn't eat the input
        const finish = (commit: boolean) => {
          this.isRenaming = false;
          if (commit && input.value.trim()) this.addCustomSkill(input.value);
          else this.renderTabs();
        };
        input.addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key === "Enter") finish(true);
          if (e.key === "Escape") finish(false);
        });
        input.addEventListener("blur", () => finish(false));
        input.focus();
      });
      secondaryGrid.appendChild(addBtn);
      this.panelEl.appendChild(secondaryGrid);

      if (hiddenCount > 0) {
        const toggle = document.createElement("button");
        toggle.className = "mc-app-skill-hidden-toggle";
        toggle.textContent = this.showHiddenSkills ? `hide ${hiddenCount} skills` : `show ${hiddenCount} hidden`;
        toggle.addEventListener("click", () => {
          this.showHiddenSkills = !this.showHiddenSkills;
          this.renderTabs();
        });
        this.panelEl.appendChild(toggle);
      }
    }

    // --- Spacer pushes session sections + footer to the bottom (plugin order:
    // spacer → STANDBY → TO REVIEW → WORKING → footer) ---
    const spacer = document.createElement("div");
    spacer.className = "mc-app-panel-spacer";
    this.panelEl.appendChild(spacer);

    const tracked = this.agentTracker.tracked;
    const working = tracked.filter((t) => t.status === "working");
    const review = tracked.filter((t) => t.status === "to-review");
    const trackedIds = new Set(tracked.map((t) => t.sessionId));
    const standby = this.sessions.filter((s) => !trackedIds.has(s.id));

    if (standby.length > 0) {
      this.renderSessionSection("STANDBY", standby, "standby");
    }

    if (review.length > 0) {
      this.renderSessionSection("TO REVIEW", review.map((t) => {
        return this.sessions.find((s) => s.id === t.sessionId)!;
      }).filter(Boolean), "review");
    }

    if (working.length > 0) {
      this.renderSessionSection("WORKING", working.map((t) => {
        return this.sessions.find((s) => s.id === t.sessionId)!;
      }).filter(Boolean), "working");
    }

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
          { title: "New agent chat (default)", onClick: () => this.newSessionDefault() },
          { title: "New agent — terminal view", onClick: () => this.newTerminalAgent() },
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
      const items = this.skills.map((s) => ({
        title: `${s.label}  ${s.slash}`,
        onClick: () => this.launchSkill(s.id),
      }));
      if (items.length > 0) showContextMenu(items, e.clientX, e.clientY);
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

  private renderSessionSection(title: string, sessions: AnySession[], kind: "working" | "review" | "standby") {
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
      // Status is conveyed by section + glyph color (no text). "Needs input"
      // gets a colour pulse so a blocked agent stands out without a label.
      if (kind === "working" && typeof (session as any).getStatusHint === "function"
          && (session as any).getStatusHint() === "needs-input") {
        card.classList.add("needs-input");
      }

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
            // window.prompt does not exist in the Electron renderer — inline input instead
            { title: "Rename", onClick: () => this.startCardRename(card, session) },
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

  /** Native input bar: users talk to the agent without touching the TUI.
   *  Enter sends to the active session's stdin; Stop sends Esc (interrupt). */
  private buildInputBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "mc-app-agent-inputbar";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Message the agent…  (Enter to send)";
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && input.value.trim()) {
        const text = input.value;
        input.value = "";
        const s = this.activeSession;
        if (s) {
          s.process.stdin.write(text);
          // Small settle gap so the TUI treats Enter as submit, not paste-newline
          setTimeout(() => s.process.stdin.write("\r"), 40);
        }
      }
      if (e.key === "Escape") {
        this.activeSession?.process.stdin.write("\x1b");
      }
    });
    bar.appendChild(input);

    const stopBtn = document.createElement("button");
    stopBtn.className = "mc-app-agent-stop";
    stopBtn.title = "Interrupt the agent (Esc)";
    stopBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor"><rect x="2.5" y="2.5" width="7" height="7" rx="1.5"/></svg>';
    stopBtn.addEventListener("click", () => {
      this.activeSession?.process.stdin.write("\x1b");
      input.focus();
    });
    bar.appendChild(stopBtn);

    return bar;
  }

  /** Always-visible glyph tiles — one per session, state-tinted like the
   *  plugin's compact sidebar (orange = working, green = to-review). */
  private renderGlyphRail() {
    if (!this.railEl) return;
    // Glyph tiles belong to the COLLAPSED (compact) panel only — when the panel
    // is expanded it already shows full session cards, so the rail is hidden.
    this.railEl.style.display = "none";
    while (this.railEl.firstChild) this.railEl.removeChild(this.railEl.firstChild);
    for (const session of this.sessions) {
      const tile = document.createElement("button");
      tile.className = "mc-app-rail-tile";
      tile.title = session.name;
      tile.innerHTML = this.getGlyphSvg(session.glyph);
      if (session === this.activeSession) tile.classList.add("is-active");
      const tracked = this.agentTracker.tracked.find((t) => t.sessionId === session.id);
      if (tracked?.status === "working") tile.classList.add("agent-working");
      else if (tracked?.status === "to-review") tile.classList.add("agent-review");
      // Pulse when the agent is blocked on the user (permission prompt)
      if (typeof (session as any).getStatusHint === "function" && (session as any).getStatusHint() === "needs-input") {
        tile.classList.add("needs-input");
      }
      tile.addEventListener("click", () => {
        if (tracked?.status === "to-review") this.agentTracker.dismiss(session.id);
        this.switchTo(session);
      });
      tile.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showContextMenu(
          [
            { title: `Switch to ${session.name}`, onClick: () => this.switchTo(session) },
            { title: "Close", onClick: () => this.close(session) },
          ],
          e.clientX,
          e.clientY,
        );
      });
      this.railEl.appendChild(tile);
    }
  }

  /** Inline rename on a session card — plugin's startSidebarRename pattern. */
  private startCardRename(card: HTMLElement, session: AnySession) {
    const nameEl = card.querySelector(".mc-app-session-card-name") as HTMLElement | null;
    if (!nameEl) return;

    const input = document.createElement("input");
    input.type = "text";
    input.value = session.name;
    input.className = "mc-app-session-rename-input";
    nameEl.replaceWith(input);
    this.isRenaming = true;

    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      this.isRenaming = false;
      const name = input.value.trim();
      if (save && name) session.name = name;
      this.renderTabs();
      this.onAgentsChanged?.();
    };

    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    // Keep card click handlers from stealing focus mid-rename
    input.addEventListener("click", (e) => e.stopPropagation());

    input.focus();
    input.select();
  }

  list(): AnySession[] {
    return this.sessions;
  }

  getActive(): AnySession | null {
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
