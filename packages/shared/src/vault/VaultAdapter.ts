/** Vault adapter — abstraction over file system / markdown store.
 *
 *  Plugin implements this over Obsidian's `app.vault` API.
 *  Electron app implements this over Node's `fs/promises` + `chokidar`.
 *  Consumers (e.g. a future shared WikiLinkAutocomplete) can operate on either
 *  host without knowing which one. */

export interface FileEntry {
  /** Absolute path on disk. */
  path: string;
  /** Path relative to vault basePath (forward slashes). */
  relativePath: string;
  /** Basename (e.g. "README.md"). */
  name: string;
  /** Extension without the dot (e.g. "md"). Empty string for directories. */
  extension: string;
  isDirectory: boolean;
  /** Last modified time in milliseconds (epoch). */
  mtime: number;
  /** File size in bytes. 0 for directories. */
  size: number;
}

export type VaultEvent =
  | { type: "create"; path: string }
  | { type: "modify"; path: string }
  | { type: "delete"; path: string }
  | { type: "rename"; oldPath: string; newPath: string };

export interface VaultAdapter {
  /** Absolute path to vault root. */
  basePath: string;

  /** Return all files and directories in the vault (recursive). */
  getFiles(): Promise<FileEntry[]>;

  /** Read file contents as UTF-8 string. */
  readFile(path: string): Promise<string>;

  /** Write file contents as UTF-8 string. Creates parent dirs if needed. */
  writeFile(path: string, content: string): Promise<void>;

  /** Subscribe to file change events. Returns an unsubscribe function. */
  watch(callback: (event: VaultEvent) => void): () => void;
}
