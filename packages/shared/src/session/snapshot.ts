/** Session snapshot — persistent metadata captured on plugin close for smart
 *  restore picker on next open. Zero Obsidian dependencies so Electron app can
 *  eventually reuse the same shape.
 *
 *  Stored in Obsidian plugin `saveData()` — NOT view state — to keep
 *  workspace.json lean. Buffer tails of many long-running sessions can be
 *  kilobytes each; view state serialization is not the place for that. */

export interface SessionSnapshot {
  /** Stable session id (TerminalSession.id — a number) */
  id: number;
  /** Human label (skill label or "zsh N") */
  name: string;
  /** Visual glyph id (SESSION_GLYPHS key or icon name) */
  glyph: string;
  /** Skill id/label if session was launched from a skill (e.g. "pulse", "process-transcripts") */
  skillName?: string;
  /** Agent state at capture time */
  agentStatus?: "working" | "to-review" | "dismissed";
  /** Last N non-empty lines from xterm buffer, oldest → newest */
  bufferTail: string[];
  /** Working directory (best-effort cache from session) */
  cwd?: string;
  /** Epoch ms of last stdout write */
  lastActivityAt: number;
  /** True if user skipped this session in an earlier picker. Still shown in Archive bucket. */
  archived: boolean;
  /** Epoch ms of when this snapshot was written */
  savedAt: number;
}

export interface RestoreState {
  version: 1;
  snapshots: SessionSnapshot[];
}

export const RESTORE_STATE_VERSION = 1 as const;

/** Default empty restore state */
export function emptyRestoreState(): RestoreState {
  return { version: RESTORE_STATE_VERSION, snapshots: [] };
}
