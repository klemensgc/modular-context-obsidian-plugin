/** Spawn a PTY-wrapped shell via the bundled Python helper.
 *
 *  Used by both plugin (Obsidian) and app (Electron) to start a PTY.
 *  Host is responsible for writing `pty-helper.py` to a known path and
 *  providing it as `helperPath`. Returns Node ChildProcess via loose type
 *  (we avoid importing child_process types in shared to stay loader-agnostic). */

export interface PtySpawnOptions {
  /** Absolute path to pty-helper.py on disk (host wrote it there). */
  helperPath: string;
  /** Working directory for the shell. */
  cwd: string;
  /** Initial cols and rows for the PTY. */
  cols?: number;
  rows?: number;
  /** Extra env vars (merged with process.env, minus CLAUDECODE). */
  env?: Record<string, string>;
}

export interface PtySpawnResult {
  /** Node ChildProcess instance. Loose type to avoid child_process import. */
  process: any;
  /** Helper function to send a resize sequence through stdin.
   *  The Python helper listens for \\x1b]R;cols;rows\\x07 on stdin. */
  resize: (cols: number, rows: number) => void;
}

/** Spawn python3 running the PTY helper. Caller must have already written
 *  the helper script to disk at `helperPath`. */
export function spawnPtyShell(opts: PtySpawnOptions): PtySpawnResult {
  // Use require so this module works in both Node bundler contexts
  // (esbuild externalizes child_process as declared in plugin's esbuild config).
  const { spawn } = require("child_process");

  // Strip CLAUDECODE env var so Claude Code can be launched inside the terminal
  const { CLAUDECODE, ...cleanEnv } = process.env;

  const proc = spawn("python3", [opts.helperPath], {
    cwd: opts.cwd,
    env: {
      ...cleanEnv,
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      MC_TERM_COLS: String(opts.cols ?? 80),
      MC_TERM_ROWS: String(opts.rows ?? 24),
      ...(opts.env ?? {}),
    },
  });

  const resize = (cols: number, rows: number) => {
    // Python helper parses \x1b]R;cols;rows\x07 from stdin and calls TIOCSWINSZ
    proc.stdin?.write(`\x1b]R;${cols};${rows}\x07`);
  };

  return { process: proc, resize };
}
