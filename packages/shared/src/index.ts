/** @mc/shared — portable modules shared between Obsidian plugin and Electron app. */

export {
  SESSION_GLYPHS,
  SLOT_COUNT,
  type FullscreenLayout,
  type DisplayMode,
  type SessionGlyph,
} from "./ui/glyphs";

export {
  buildXtermTheme,
  type XtermThemeColors,
  type XtermThemeOptions,
} from "./ui/xterm-theme";

export {
  BookmarkManager,
  type Bookmark,
} from "./ui/BookmarkManager";

export {
  FullscreenManager,
  type FullscreenAdapter,
  type FullscreenContextMenuItem,
} from "./ui/FullscreenManager";

export { PTY_HELPER_SOURCE } from "./terminal/pty-helper-loader";

export {
  spawnPtyShell,
  type PtySpawnOptions,
  type PtySpawnResult,
} from "./terminal/pty-spawn";

export {
  type VaultAdapter,
  type FileEntry,
  type VaultEvent,
} from "./vault/VaultAdapter";

export {
  AgentTracker,
  type TrackedSession,
  type TrackableSession,
  MIN_DWELL_MS,
  IDLE_PROMPT_MS,
  IDLE_SAFETY_MS,
  REVIVE_BYTES,
  REVIVE_WINDOW_MS,
  AUTO_DETECT_WINDOW_MS,
} from "./agent/AgentTracker";

// Google Workspace types (W1 + W2 + multi-account)
export {
  type StoredTokens,
  type OAuthConfig,
  type TokenStorageMethod,
  type TokensMeta,
  type GoogleWorkspaceScope,
  type AccountId,
  type AccountIndex,
  type AccountsIndex,
  type MultiTokenStorage,
  MCGoogleError,
  GOOGLE_WORKSPACE_SCOPES,
  emailToAccountFilename,
  normalizeAccountId,
  computeMissingScopes,
} from "./google/types";

// Session snapshots (smart restore picker)
export {
  type SessionSnapshot,
  type RestoreState,
  RESTORE_STATE_VERSION,
  emptyRestoreState,
} from "./session/snapshot";
