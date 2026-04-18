/** Agent state machine — Working → To Review → Dismissed transitions.
 *
 *  Zero Obsidian dependencies. Session type is loose (`TrackableSession`) to avoid
 *  pulling xterm.js or child_process types into shared. The plugin's TerminalSession
 *  and the app's TerminalSession both satisfy this shape via structural typing. */

export const MIN_DWELL_MS = 5000;        // minimum time in any state before transition
export const IDLE_PROMPT_MS = 8000;      // idle + prompt visible → to-review
export const IDLE_SAFETY_MS = 30000;     // idle safety net → to-review regardless
export const REVIVE_BYTES = 200;         // bytes needed to revive from to-review
export const REVIVE_WINDOW_MS = 5000;    // window for revive byte counting
export const AUTO_DETECT_WINDOW_MS = 8000; // window for auto-detect

export interface TrackedSession {
  sessionId: number;
  skillName: string;
  startedAt: number;
  lastActivityAt: number;
  status: "working" | "to-review" | "dismissed";
  stateChangedAt: number;
  recentOutputBytes: number;
  outputWindowStart: number;
}

/** Minimal session shape needed by the tracker. Structural typing matches any
 *  TerminalSession implementation that exposes these fields. */
export interface TrackableSession {
  id: number;
  name: string;
  _lastStdoutAt: number;
  terminal: any;  // xterm.js Terminal
  process: any;   // Node ChildProcess
}

export class AgentTracker {
  tracked: TrackedSession[] = [];
  private listeners: Map<number, (data: Buffer) => void> = new Map();
  private exitListeners: Map<number, () => void> = new Map();
  private onChange: () => void;

  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  stop() {
    this.listeners.clear();
    this.exitListeners.clear();
  }

  track(session: TrackableSession, skillName: string) {
    this.untrack(session);

    const now = Date.now();
    const entry: TrackedSession = {
      sessionId: session.id,
      skillName,
      startedAt: now,
      lastActivityAt: now,
      status: "working",
      stateChangedAt: now,
      recentOutputBytes: 0,
      outputWindowStart: now,
    };
    this.tracked.push(entry);
    this.attachListeners(session, entry);
    this.onChange();
  }

  private attachListeners(session: TrackableSession, entry: TrackedSession) {
    const stdoutListener = (data: Buffer) => {
      const t = this.tracked.find((tr) => tr.sessionId === entry.sessionId);
      if (!t) return;
      t.lastActivityAt = Date.now();
      t.recentOutputBytes += data.length;
    };
    session.process.stdout?.on("data", stdoutListener);
    this.listeners.set(session.id, stdoutListener);

    const exitListener = () => {
      const t = this.tracked.find((tr) => tr.sessionId === entry.sessionId);
      if (t && t.status === "working") {
        t.status = "to-review";
        t.stateChangedAt = Date.now();
        this.onChange();
      }
    };
    session.process.on("exit", exitListener);
    this.exitListeners.set(session.id, exitListener);
  }

  untrack(sessionOrId: TrackableSession | number) {
    const sessionId = typeof sessionOrId === "number" ? sessionOrId : sessionOrId.id;
    const session = typeof sessionOrId === "number" ? null : sessionOrId;

    const stdoutListener = this.listeners.get(sessionId);
    const exitListener = this.exitListeners.get(sessionId);
    if (session) {
      try {
        if (stdoutListener) session.process.stdout?.removeListener("data", stdoutListener);
      } catch {}
      try {
        if (exitListener) session.process.removeListener("exit", exitListener);
      } catch {}
    }

    this.tracked = this.tracked.filter((t) => t.sessionId !== sessionId);
    this.listeners.delete(sessionId);
    this.exitListeners.delete(sessionId);
    this.onChange();
  }

  dismiss(sessionId: number) {
    const t = this.tracked.find((t) => t.sessionId === sessionId);
    if (t) {
      t.status = "dismissed";
      t.stateChangedAt = Date.now();
      this.onChange();
    }
  }

  getWorking(): TrackedSession[] {
    return this.tracked.filter((t) => t.status === "working");
  }

  getToReview(): TrackedSession[] {
    return this.tracked.filter((t) => t.status === "to-review");
  }

  /** Read status for a given session id, or undefined if not tracked */
  getStatus(sessionId: number): TrackedSession["status"] | undefined {
    return this.tracked.find((t) => t.sessionId === sessionId)?.status;
  }

  /** Read the TrackedSession entry for a given session id (exposes skillName, lastActivityAt) */
  getTracked(sessionId: number): TrackedSession | undefined {
    return this.tracked.find((t) => t.sessionId === sessionId);
  }

  /** Read recent non-empty lines from terminal buffer (public helper used by snapshot capture) */
  readRecentLines(session: TrackableSession, count: number): string[] {
    return this.getRecentLines(session, count);
  }

  /** Read recent non-empty lines from terminal buffer */
  private getRecentLines(session: TrackableSession, count: number): string[] {
    const buf = session.terminal.buffer.active;
    const lines: string[] = [];
    for (let i = buf.length - 1; i >= Math.max(0, buf.length - 50) && lines.length < count; i--) {
      const line = buf.getLine(i)?.translateToString(true)?.trim();
      if (line) lines.push(line);
    }
    return lines;
  }

  /** Check if the terminal shows a bare shell prompt (NOT Claude Code's prompt) */
  private isShellPrompt(session: TrackableSession): boolean {
    const lines = this.getRecentLines(session, 5);
    if (lines.length === 0) return false;
    const last = lines[0];

    if (this.hasClaudeTuiMarkers(lines)) return false;

    if (/[$%#]\s*$/.test(last)) return true;
    if (/^➜\s/.test(last)) return true;
    if (/^\S+@\S+[^╭╰]*[$%#]\s*$/.test(last)) return true;

    return false;
  }

  /** Check if Claude Code output contains a completion marker */
  private hasClaudeCompletionMarker(lines: string[]): boolean {
    for (const line of lines) {
      if (/✻\s*(Cooked for|Done|Completed)/.test(line)) return true;
      if (/^✻\s/.test(line)) return true;
    }
    return false;
  }

  /** Check if Claude Code TUI markers are present in buffer lines */
  private hasClaudeTuiMarkers(lines: string[]): boolean {
    for (const line of lines) {
      if (/^[╭╰│]/.test(line)) return true;
      if (/Allow\?\s*\[/.test(line)) return true;
      if (/Welcome to Claude/.test(line)) return true;
      if (/^❯\s/.test(line)) return true;
    }
    return false;
  }

  /** Check if the terminal is idle at Claude Code's input prompt (❯).
   *  This means Claude finished its task and is waiting for the next user message. */
  private isAtClaudePrompt(session: TrackableSession): boolean {
    const lines = this.getRecentLines(session, 5);
    if (lines.length === 0) return false;
    const last = lines[0];
    if (/^❯\s*$/.test(last)) return true;
    if (/^❯/.test(last) && last.length < 10) return true;
    return false;
  }

  /** Check if Claude Code appears active in the terminal buffer */
  private isClaudeCodeActive(session: TrackableSession): boolean {
    return this.hasClaudeTuiMarkers(this.getRecentLines(session, 30));
  }

  /** Single unified poll — called from host view every 5s */
  pollWithSessions(sessions: TrackableSession[]) {
    let changed = false;
    const now = Date.now();
    const trackedIds = new Set(this.tracked.map((t) => t.sessionId));

    // --- Auto-detect: untracked sessions with Claude TUI visible + recent output ---
    for (const session of sessions) {
      if (trackedIds.has(session.id)) continue;
      if (session._lastStdoutAt === 0 || now - session._lastStdoutAt > AUTO_DETECT_WINDOW_MS) continue;
      if (!this.isClaudeCodeActive(session)) continue;

      const entry: TrackedSession = {
        sessionId: session.id,
        skillName: session.name,
        startedAt: now,
        lastActivityAt: now,
        status: "working",
        stateChangedAt: now,
        recentOutputBytes: 0,
        outputWindowStart: now,
      };
      this.tracked.push(entry);
      trackedIds.add(session.id);
      this.attachListeners(session, entry);
      changed = true;
    }

    // --- State transitions for tracked sessions ---
    for (const t of this.tracked) {
      const dwellMs = now - t.stateChangedAt;

      if (now - t.outputWindowStart > REVIVE_WINDOW_MS) {
        t.recentOutputBytes = 0;
        t.outputWindowStart = now;
      }

      if (t.status === "working") {
        if (dwellMs < MIN_DWELL_MS) continue;
        const idleMs = now - t.lastActivityAt;
        const session = sessions.find((s) => s.id === t.sessionId);
        if (!session) continue;

        if (idleMs > 2000) {
          const tailLines = this.getRecentLines(session, 15);
          if (this.hasClaudeCompletionMarker(tailLines)) {
            t.status = "to-review";
            t.stateChangedAt = now;
            t.recentOutputBytes = 0;
            changed = true;
            continue;
          }
        }

        if (idleMs > IDLE_PROMPT_MS && this.isAtClaudePrompt(session)) {
          t.status = "to-review";
          t.stateChangedAt = now;
          t.recentOutputBytes = 0;
          changed = true;
        }
        else if (idleMs > IDLE_PROMPT_MS && this.isShellPrompt(session)) {
          t.status = "to-review";
          t.stateChangedAt = now;
          t.recentOutputBytes = 0;
          changed = true;
        }
        else if (idleMs > IDLE_SAFETY_MS) {
          t.status = "to-review";
          t.stateChangedAt = now;
          t.recentOutputBytes = 0;
          changed = true;
        }
      }
      else if (t.status === "to-review") {
        if (dwellMs < MIN_DWELL_MS) continue;
        const session = sessions.find((s) => s.id === t.sessionId);
        if (!session) continue;

        if (t.recentOutputBytes > REVIVE_BYTES && this.isClaudeCodeActive(session)) {
          t.status = "working";
          t.stateChangedAt = now;
          t.recentOutputBytes = 0;
          changed = true;
        }
      }
      else if (t.status === "dismissed") {
        if (dwellMs < MIN_DWELL_MS) continue;
        const session = sessions.find((s) => s.id === t.sessionId);
        if (!session) continue;

        const recentlyActive = session._lastStdoutAt > 0 && now - session._lastStdoutAt < AUTO_DETECT_WINDOW_MS;
        if (recentlyActive && this.isClaudeCodeActive(session)) {
          t.status = "working";
          t.stateChangedAt = now;
          t.recentOutputBytes = 0;
          changed = true;
        }
      }
    }

    if (changed) this.onChange();
  }
}
