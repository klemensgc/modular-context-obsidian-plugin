/** Claude Code live-session registry — mirrors ~/.claude/sessions/<pid>.json.
 *
 *  Zero Obsidian dependencies. The CLI (>= 2.1.x) writes one JSON file per
 *  process with its sessionId, status ("busy" | "idle" | "waiting") and
 *  timestamps; files are deleted on normal exit but can linger after crashes,
 *  so entries are validated with a pid liveness check — mtime is NOT a
 *  heartbeat (files are rewritten only on status change).
 *
 *  Registry files are INTERNAL CLI schema: every file is parsed defensively
 *  (try/catch per file, malformed → skipped) so consumers can degrade
 *  gracefully to buffer heuristics when the registry is absent or changes. */

export type ClaudeSessionStatus = "busy" | "idle" | "waiting";

export interface ClaudeRegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string;
  /** "derived" when the CLI auto-named from the directory; absent/null when user- or task-set. */
  nameSource: string | null;
  status: ClaudeSessionStatus;
  statusUpdatedAt: number;
  startedAt: number;
  /** "interactive" | "bg" (registry spelling; `claude agents --json` says "background"). */
  kind: string;
}

const RESCAN_INTERVAL_MS = 5000;   // fallback re-scan when fs.watch misses events
const CHANGE_DEBOUNCE_MS = 250;    // collapse bursts of registry writes into one onChange

export class ClaudeSessionRegistry {
  /** Live entries keyed by pid (one file per process). */
  private entries: Map<number, ClaudeRegistryEntry> = new Map();
  private watcher: any = null;           // fs.FSWatcher — loose to keep shared dep-free
  private rescanTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private onChange: () => void;
  private dir: string;
  private started = false;

  constructor(onChange: () => void, dir?: string) {
    this.onChange = onChange;
    const path = require("path");
    const os = require("os");
    this.dir = dir ?? path.join(os.homedir(), ".claude", "sessions");
  }

  /** Start watching the registry dir. Safe to call when the dir doesn't exist
   *  (old CLI / Claude never launched) — the 5s re-scan keeps retrying. */
  start() {
    if (this.started) return;
    this.started = true;
    this.attachWatcher();
    this.rescanTimer = setInterval(() => {
      // fs.watch can silently die (dir recreated, editor swaps) — re-attach lazily.
      if (!this.watcher) this.attachWatcher();
      this.scan();
    }, RESCAN_INTERVAL_MS);
    this.scan();
  }

  /** Stop watching — removes the fs watcher and all timers. */
  stop() {
    this.started = false;
    if (this.watcher) {
      try { this.watcher.close(); } catch {}
      this.watcher = null;
    }
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer);
      this.rescanTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.entries.clear();
  }

  /** All live registry entries (pid-verified). */
  getAll(): ClaudeRegistryEntry[] {
    return Array.from(this.entries.values());
  }

  /** Resolve an entry by Claude session UUID. Duplicate sessionIds are possible
   *  (resume without --fork-session) — prefer the freshest statusUpdatedAt. */
  getBySessionId(sessionId: string): ClaudeRegistryEntry | undefined {
    let best: ClaudeRegistryEntry | undefined;
    for (const e of this.entries.values()) {
      if (e.sessionId !== sessionId) continue;
      if (!best || e.statusUpdatedAt > best.statusUpdatedAt) best = e;
    }
    return best;
  }

  private attachWatcher() {
    const fs = require("fs");
    try {
      this.watcher = fs.watch(this.dir, () => this.scan());
      this.watcher.on?.("error", () => {
        try { this.watcher?.close(); } catch {}
        this.watcher = null;
      });
    } catch {
      this.watcher = null; // dir missing — rescan timer retries attach
    }
  }

  /** Re-read the registry dir into `entries`. Fires onChange (debounced) only
   *  when the observed state actually changed. */
  private scan() {
    const fs = require("fs");
    const path = require("path");
    const next: Map<number, ClaudeRegistryEntry> = new Map();

    let files: string[] = [];
    try { files = fs.readdirSync(this.dir); } catch { files = []; }

    for (const f of files) {
      if (!/^\d+\.json$/.test(f)) continue;
      let entry: ClaudeRegistryEntry | null = null;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8"));
        entry = this.parseEntry(raw);
      } catch { continue; } // partial write / malformed → skip this file
      if (!entry) continue;
      if (!this.isPidAlive(entry.pid)) continue; // crash leftover
      next.set(entry.pid, entry);
    }

    if (this.differs(next)) {
      this.entries = next;
      this.scheduleChange();
    } else {
      this.entries = next; // keep timestamps fresh even without a structural change
    }
  }

  /** Validate + normalize one registry JSON object. Returns null if the shape
   *  isn't usable (internal schema — never assume fields exist). */
  private parseEntry(raw: any): ClaudeRegistryEntry | null {
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.pid !== "number" || typeof raw.sessionId !== "string") return null;
    const status = raw.status;
    if (status !== "busy" && status !== "idle" && status !== "waiting") return null;
    return {
      pid: raw.pid,
      sessionId: raw.sessionId,
      cwd: typeof raw.cwd === "string" ? raw.cwd : "",
      name: typeof raw.name === "string" ? raw.name : "",
      nameSource: typeof raw.nameSource === "string" ? raw.nameSource : null,
      status,
      statusUpdatedAt: typeof raw.statusUpdatedAt === "number" ? raw.statusUpdatedAt : 0,
      startedAt: typeof raw.startedAt === "number" ? raw.startedAt : 0,
      kind: typeof raw.kind === "string" ? raw.kind : "interactive",
    };
  }

  /** Liveness = signal 0 succeeds. Never trust mtime. */
  private isPidAlive(pid: number): boolean {
    try {
      require("process").kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** Cheap structural diff — pids, sessionIds, status, names. */
  private differs(next: Map<number, ClaudeRegistryEntry>): boolean {
    if (next.size !== this.entries.size) return true;
    for (const [pid, e] of next) {
      const prev = this.entries.get(pid);
      if (!prev) return true;
      if (
        prev.sessionId !== e.sessionId
        || prev.status !== e.status
        || prev.name !== e.name
        || prev.statusUpdatedAt !== e.statusUpdatedAt
      ) return true;
    }
    return false;
  }

  private scheduleChange() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.onChange();
    }, CHANGE_DEBOUNCE_MS);
  }
}
