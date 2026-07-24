/** TerminalSession — a single xterm.js + PTY session.
 *
 *  Managed by TerminalManager. Uses window.mcPty IPC for process I/O.
 *  Exposes fields needed by AgentTracker + FullscreenManager + BookmarkManager
 *  via structural typing (matches TrackableSession from @mc/shared). */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { buildXtermTheme, BookmarkManager, SESSION_GLYPHS } from "@mc/shared";
import { createRosLoader, type RosLoader } from "./Loader";

interface McPtyApi {
  spawn(opts: { cwd: string; cols: number; rows: number; cmd?: string }): Promise<string>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  kill(id: string): Promise<void>;
  onData(cb: (id: string, data: string) => void): void;
  onExit(cb: (id: string) => void): void;
}

export interface TerminalSessionOptions {
  id: number;
  name: string;
  cwd: string;
  glyph: string;
  parent: HTMLElement;
  /** Direct command (e.g. "claude") — PTY execs it via a login shell, so the
   *  user never sees a shell prompt or commands being typed for them. */
  cmd?: string;
  onActivity?: (session: TerminalSession) => void;
  /** Called when the needs-input / permission state changes (panel refresh). */
  onStateHint?: () => void;
}

/** Parsed Claude TUI permission prompt (the scary "❯ 1. Yes" block). */
export interface PermissionPrompt {
  question: string;
  options: Array<{ digit: string; label: string }>;
}

export class TerminalSession {
  // Public fields — satisfy TrackableSession from @mc/shared
  id: number;
  name: string;
  glyph: string;
  hasActivity = false;
  _lastStdoutAt = 0;
  destroyed = false;

  // Dom + xterm
  containerEl: HTMLElement;
  terminal: Terminal;
  private fitAddon: FitAddon;
  bookmarkManager: BookmarkManager | null = null;

  // Process (loose — PTY session id from main process + emulated stdout handlers)
  // AgentTracker needs { stdout: { on(data), removeListener(data) }, on(exit), removeListener(exit) }
  process: any;

  // PTY
  private ptySessionId: string | null = null;
  private cwd: string;
  private cmd?: string;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private resizeObserver: ResizeObserver | null = null;
  private resizeTimer: number | null = null;
  private onActivity?: (s: TerminalSession) => void;
  private onStateHint?: () => void;
  private stdoutListeners: Set<(data: Buffer) => void> = new Set();
  private exitListeners: Set<() => void> = new Set();

  // Friendly-UI state (Level 1/2)
  private startOverlay: HTMLElement | null = null;
  private startLoader: RosLoader | null = null;
  private startTimeout: number | null = null;
  private permScanTimer: number | null = null;
  private permOverlay: HTMLElement | null = null;
  /** Currently shown permission prompt (null = none). */
  permissionPrompt: PermissionPrompt | null = null;

  constructor(opts: TerminalSessionOptions) {
    this.id = opts.id;
    this.name = opts.name;
    this.glyph = opts.glyph;
    this.cwd = opts.cwd;
    this.cmd = opts.cmd;
    this.onActivity = opts.onActivity;
    this.onStateHint = opts.onStateHint;

    // Build container
    this.containerEl = document.createElement("div");
    this.containerEl.className = "mc-app-terminal-session";
    this.containerEl.dataset.sessionId = String(this.id);
    opts.parent.appendChild(this.containerEl);

    // xterm host
    const xtermHost = document.createElement("div");
    xtermHost.className = "mc-app-xterm";
    this.containerEl.appendChild(xtermHost);

    // Direct-command sessions show a friendly boot card until the TUI is up —
    // no black screen with a blinking cursor.
    if (this.cmd) {
      this.startOverlay = document.createElement("div");
      this.startOverlay.className = "mc-app-session-start";
      this.startLoader = createRosLoader(56);
      this.startOverlay.appendChild(this.startLoader.el);
      const label = document.createElement("span");
      label.textContent = "Starting your agent…";
      this.startOverlay.appendChild(label);
      this.containerEl.appendChild(this.startOverlay);
      this.startLoader.start();
      this.startTimeout = window.setTimeout(() => this.hideStartOverlay(), 15000);
    }

    // xterm init
    const isDark = true; // app is always dark for now
    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13.5, // plugin default — the 12px version read as sparse/empty
      lineHeight: 1.35,
      letterSpacing: 0.2,
      fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
      fontWeight: "400",
      fontWeightBold: "600",
      theme: buildXtermTheme({
        getCssVar: (v) => getComputedStyle(document.body).getPropertyValue(v).trim(),
        isDark,
      }),
      allowProposedApi: true,
      macOptionIsMeta: false,
      scrollback: 5000,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(xtermHost);

    // Mock child_process-like `process` object for AgentTracker compatibility
    this.process = {
      stdout: {
        on: (event: string, cb: (data: Buffer) => void) => {
          if (event === "data") this.stdoutListeners.add(cb);
        },
        removeListener: (event: string, cb: (data: Buffer) => void) => {
          if (event === "data") this.stdoutListeners.delete(cb);
        },
      },
      on: (event: string, cb: () => void) => {
        if (event === "exit") this.exitListeners.add(cb);
      },
      removeListener: (event: string, cb: () => void) => {
        if (event === "exit") this.exitListeners.delete(cb);
      },
      // stdin is write-only; PTY in main handles the real bytes via IPC
      stdin: {
        write: (data: string) => {
          const mcPty = (window as any).mcPty as McPtyApi;
          if (this.ptySessionId) mcPty.write(this.ptySessionId, data);
        },
      },
    };

    this.readyPromise = new Promise<void>((res) => {
      this.resolveReady = res;
    });

    this.setup().catch((err) => console.error("[TerminalSession] setup error:", err));

    // BookmarkManager attached to containerEl
    try {
      this.bookmarkManager = new BookmarkManager(this.terminal as any, this.containerEl);
    } catch (err) {
      console.error("[TerminalSession] BookmarkManager init failed:", err);
    }
  }

  private async setup() {
    const mcPty = (window as any).mcPty as McPtyApi;

    // Wait one frame for layout, then fit
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    try {
      this.fitAddon.fit();
    } catch {}

    const cols = this.terminal.cols || 80;
    const rows = this.terminal.rows || 24;

    this.ptySessionId = await mcPty.spawn({ cwd: this.cwd, cols, rows, cmd: this.cmd });
    if (this.destroyed) {
      await mcPty.kill(this.ptySessionId);
      return;
    }

    // xterm input → PTY
    this.terminal.onData((data) => {
      if (this.ptySessionId) mcPty.write(this.ptySessionId, data);
    });

    // xterm resize → PTY
    this.terminal.onResize(({ cols, rows }) => {
      if (this.ptySessionId) mcPty.resize(this.ptySessionId, cols, rows);
    });

    // ResizeObserver for container dimension changes
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => this.fit(), 50);
    });
    this.resizeObserver.observe(this.containerEl);

    window.addEventListener("mc:panes-resized", this.handlePanesResized);

    this.resolveReady();
  }

  private handlePanesResized = () => {
    this.fit();
  };

  /** Called by TerminalManager from the shared PTY data dispatcher. */
  receivePtyData(data: string) {
    if (this.destroyed) return;
    this.terminal.write(data);
    this._lastStdoutAt = Date.now();
    // Boot card disappears the moment the TUI paints its prompt
    if (this.startOverlay && data.includes("❯")) this.hideStartOverlay();
    // Debounced scan for Claude's permission prompts → native buttons
    if (this.permScanTimer) clearTimeout(this.permScanTimer);
    this.permScanTimer = window.setTimeout(() => this.scanPermissionPrompt(), 280);
    // Notify agent tracker listeners (structural child_process stdout).
    // The renderer has no Node `Buffer` global (nodeIntegration: false) — all
    // consumers (AgentTracker, sendWhenReady) only use .length/.toString(),
    // which plain strings satisfy, so pass the string through structurally.
    const buf = (typeof Buffer !== "undefined"
      ? Buffer.from(data, "utf-8")
      : (data as unknown)) as Buffer;
    for (const cb of this.stdoutListeners) {
      try { cb(buf); } catch {}
    }
    // Activity callback for tab highlight
    if (this.onActivity) this.onActivity(this);
  }

  /** Called by TerminalManager when main process reports PTY exit. */
  receivePtyExit() {
    if (this.destroyed) return;
    this.terminal.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
    for (const cb of this.exitListeners) {
      try { cb(); } catch {}
    }
    this.ptySessionId = null;
  }

  setActivityCallback(cb: ((s: TerminalSession) => void) | null) {
    this.onActivity = cb ?? undefined;
  }

  private hideStartOverlay() {
    if (this.startTimeout) {
      clearTimeout(this.startTimeout);
      this.startTimeout = null;
    }
    this.startLoader?.destroy();
    this.startLoader = null;
    this.startOverlay?.remove();
    this.startOverlay = null;
  }

  /** Read the last N rendered lines from the xterm buffer. */
  private recentLines(n: number): string[] {
    const buf = this.terminal.buffer.active;
    const total = buf.baseY + buf.cursorY;
    const out: string[] = [];
    for (let y = Math.max(0, total - n); y <= total; y++) {
      const line = buf.getLine(y);
      if (line) out.push(line.translateToString(true));
    }
    return out;
  }

  /** Detect Claude's TUI permission prompt ("❯ 1. Yes / 2. ... / 3. No") and
   *  mirror it as native buttons — the single scariest moment of the raw TUI.
   *  Heuristic: consecutive numbered options near the bottom, one marked ❯,
   *  with a question line above. Misdetection is safe: buttons just type the
   *  same digit a human would. */
  private scanPermissionPrompt() {
    if (this.destroyed) return;
    const lines = this.recentLines(18);
    const optRe = /^\s*(?:│\s*)?(❯\s*)?(\d)[.)]\s+(.+?)\s*(?:│\s*)?$/;

    let options: Array<{ digit: string; label: string }> = [];
    let sawArrow = false;
    let firstOptIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(optRe);
      if (m) {
        if (options.length === 0) firstOptIdx = i;
        if (m[2] === String(options.length + 1)) {
          if (m[1]) sawArrow = true;
          options.push({ digit: m[2], label: m[3].replace(/\s*\(esc\)\s*$/i, "").trim() });
          continue;
        }
      }
      if (options.length > 0 && lines[i].trim() !== "" && !m) {
        // Sequence broken by other content — only keep if it ends near bottom
        if (i < lines.length - 3) {
          options = [];
          sawArrow = false;
          firstOptIdx = -1;
        }
      }
    }

    const valid = options.length >= 2 && sawArrow;
    if (!valid) {
      this.setPermissionPrompt(null);
      return;
    }

    // Question: nearest non-empty line above the options block
    let question = "Claude is asking for permission";
    for (let i = firstOptIdx - 1; i >= 0; i--) {
      const text = lines[i].replace(/[│╭╮╰╯─]/g, "").trim();
      if (text.length > 3) {
        question = text;
        break;
      }
    }
    this.setPermissionPrompt({ question, options });
  }

  private setPermissionPrompt(prompt: PermissionPrompt | null) {
    const had = !!this.permissionPrompt;
    const has = !!prompt;
    // Avoid re-rendering an identical prompt (scan runs on every output burst)
    if (had && has && JSON.stringify(this.permissionPrompt) === JSON.stringify(prompt)) return;
    this.permissionPrompt = prompt;

    this.permOverlay?.remove();
    this.permOverlay = null;

    if (prompt) {
      const overlay = document.createElement("div");
      overlay.className = "mc-app-perm-overlay";
      const q = document.createElement("div");
      q.className = "mc-app-perm-question";
      q.textContent = prompt.question.length > 120 ? prompt.question.slice(0, 117) + "…" : prompt.question;
      overlay.appendChild(q);
      const row = document.createElement("div");
      row.className = "mc-app-perm-buttons";
      for (const opt of prompt.options) {
        const btn = document.createElement("button");
        btn.className = "mc-app-perm-btn" + (opt.digit === "1" ? " is-primary" : "");
        btn.textContent = opt.label.length > 48 ? opt.label.slice(0, 45) + "…" : opt.label;
        btn.addEventListener("click", () => {
          // Same keystroke a human would press — the TUI acts on the digit
          this.process.stdin.write(opt.digit);
          this.setPermissionPrompt(null);
        });
        row.appendChild(btn);
      }
      overlay.appendChild(row);
      this.containerEl.appendChild(overlay);
      this.permOverlay = overlay;
    }

    if (had !== has) this.onStateHint?.();
  }

  /** Human status for cards/rail: what is the agent doing right now? */
  getStatusHint(): "needs-input" | "thinking" | "ready" | "working" {
    if (this.permissionPrompt) return "needs-input";
    const tail = this.recentLines(4).join("\n");
    if (/esc to interrupt|[✻✶✳✢·]\s+\w+…/u.test(tail)) return "thinking";
    if (/❯\s*$/.test(tail.trimEnd()) || /^\s*❯/m.test(tail)) return "ready";
    return "working";
  }

  getPtySessionId(): string | null {
    return this.ptySessionId;
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  fit() {
    if (this.destroyed) return;
    try {
      this.fitAddon.fit();
    } catch {}
  }

  focus() {
    if (this.destroyed) return;
    this.terminal.focus();
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.hideStartOverlay();
    if (this.permScanTimer) clearTimeout(this.permScanTimer);
    this.permOverlay?.remove();
    this.resizeObserver?.disconnect();
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    window.removeEventListener("mc:panes-resized", this.handlePanesResized);

    this.bookmarkManager?.destroy();

    if (this.ptySessionId) {
      const mcPty = (window as any).mcPty as McPtyApi;
      try {
        await mcPty.kill(this.ptySessionId);
      } catch {}
      this.ptySessionId = null;
    }

    try {
      this.terminal.dispose();
    } catch {}

    this.containerEl.remove();
  }
}

// --- Glyph assignment helper ---

export function pickUnusedGlyph(usedGlyphIds: Set<string>, fallbackId = 0): string {
  for (const g of SESSION_GLYPHS) {
    if (!usedGlyphIds.has(g.id)) return g.id;
  }
  // All used — cycle by fallback index
  return SESSION_GLYPHS[fallbackId % SESSION_GLYPHS.length].id;
}
