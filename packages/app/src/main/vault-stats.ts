/** Per-vault stats for the home dashboard (selected vault only, not per-card).
 *
 *  "Context modules" = the knowledge layer: markdown notes EXCLUDING raw sources
 *  (_transcripts/, _transcripts-backlog/) and schema (_claude/, .claude/). The
 *  word count sums those modules — "how much knowledge you've built". Reads each
 *  module file, so this is run lazily for the selected vault only. */

import { promises as fs } from "fs";
import { join, extname } from "path";

const IGNORED = new Set([
  "node_modules", ".git", ".obsidian", ".cache", "dist", "dist-app",
  ".claude", "_claude",
  // Raw sources are not "context modules" — exclude transcripts from both
  // the module count and the word count.
  "_transcripts", "_transcripts-backlog",
]);

export interface VaultStats {
  /** Knowledge modules: .md notes excluding transcripts + schema. */
  noteCount: number;
  /** Total words across those modules — the size of the knowledge base. */
  wordCount: number;
  /** Most recent module mtime in ms (last activity), 0 if empty. */
  lastActivityMs: number;
}

export async function getVaultStats(basePath: string): Promise<VaultStats> {
  let noteCount = 0;
  let wordCount = 0;
  let lastActivityMs = 0;

  async function walk(dir: string): Promise<void> {
    let items: import("fs").Dirent[];
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.name.startsWith(".") || IGNORED.has(item.name)) continue;
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        await walk(full);
      } else if (extname(item.name).toLowerCase() === ".md") {
        noteCount++;
        try {
          const st = await fs.stat(full);
          if (st.mtimeMs > lastActivityMs) lastActivityMs = st.mtimeMs;
          const text = await fs.readFile(full, "utf-8");
          wordCount += countWords(text);
        } catch {
          /* skip unreadable */
        }
      }
    }
  }

  await walk(basePath);
  return { noteCount, wordCount, lastActivityMs };
}

/** Word count of prose: strip YAML frontmatter, then count whitespace tokens. */
function countWords(md: string): number {
  const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const m = body.trim().match(/\S+/g);
  return m ? m.length : 0;
}
