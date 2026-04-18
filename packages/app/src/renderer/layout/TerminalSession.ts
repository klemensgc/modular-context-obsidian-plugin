/** TerminalSession — a single xterm.js + PTY session.
 *
 *  Managed by TerminalManager. Uses window.mcPty IPC for process I/O.
 *  Exposes fields needed by AgentTracker + FullscreenManager + BookmarkManager
 *  via structural typing (matches TrackableSession from @mc/shared). */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { buildXtermTheme, BookmarkManager, SESSION_GLYPHS } from "@mc/shared";

interface McPtyApi {
  spawn(opts: { cwd: string; cols: number; rows: number }): Promise<string>;
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
  onActivity?: (session: TerminalSession) => void;
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
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private resizeObserver: ResizeObserver | null = null;
  private resizeTimer: number | null = null;
  private onActivity?: (s: TerminalSession) => void;
  private stdoutListeners: Set<(data: Buffer) => void> = new Set();
  private exitListeners: Set<() => void> = new Set();

  constructor(opts: TerminalSessionOptions) {
    this.id = opts.id;
    this.name = opts.name;
    this.glyph = opts.glyph;
    this.cwd = opts.cwd;
    this.onActivity = opts.onActivity;

    // Build container
    this.containerEl = document.createElement("div");
    this.containerEl.className = "mc-app-terminal-session";
    this.containerEl.dataset.sessionId = String(this.id);
    opts.parent.appendChild(this.containerEl);

    // xterm host
    const xtermHost = document.createElement("div");
    xtermHost.className = "mc-app-xterm";
    this.containerEl.appendChild(xtermHost);

    // xterm init
    const isDark = true; // app is always dark for now
    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: 12,
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

    this.ptySessionId = await mcPty.spawn({ cwd: this.cwd, cols, rows });
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
    // Notify agent tracker listeners (structural child_process stdout)
    const buf = Buffer.from(data, "utf-8");
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
