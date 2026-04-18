import { promises as fs } from "fs";
import { join, relative, extname, sep } from "path";
import chokidar from "chokidar";
import type { VaultAdapter, FileEntry, VaultEvent } from "@mc/shared";

const IGNORED_NAMES = new Set([
  "node_modules",
  ".git",
  ".obsidian",
  ".DS_Store",
  "dist",
  "dist-app",
  ".cache",
]);

export function createVaultAdapter(basePath: string): VaultAdapter {
  return {
    basePath,

    async getFiles(): Promise<FileEntry[]> {
      const entries: FileEntry[] = [];
      async function walk(dir: string) {
        let items;
        try {
          items = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const item of items) {
          if (item.name.startsWith(".") || IGNORED_NAMES.has(item.name)) continue;
          const full = join(dir, item.name);
          let stat;
          try {
            stat = await fs.stat(full);
          } catch {
            continue;
          }
          const rel = relative(basePath, full).split(sep).join("/");
          entries.push({
            path: full,
            relativePath: rel,
            name: item.name,
            extension: item.isFile() ? extname(item.name).replace(/^\./, "") : "",
            isDirectory: item.isDirectory(),
            mtime: stat.mtimeMs,
            size: stat.size,
          });
          if (item.isDirectory()) await walk(full);
        }
      }
      await walk(basePath);
      return entries;
    },

    async readFile(path: string): Promise<string> {
      return fs.readFile(path, "utf-8");
    },

    async writeFile(path: string, content: string): Promise<void> {
      await fs.writeFile(path, content, "utf-8");
    },

    watch(callback: (event: VaultEvent) => void): () => void {
      const watcher = chokidar.watch(basePath, {
        ignored: (p: string) => {
          const name = p.split(sep).pop() || "";
          return name.startsWith(".") || IGNORED_NAMES.has(name);
        },
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 300,
          pollInterval: 100,
        },
      });
      watcher.on("add", (path: string) => callback({ type: "create", path }));
      watcher.on("change", (path: string) => callback({ type: "modify", path }));
      watcher.on("unlink", (path: string) => callback({ type: "delete", path }));
      return () => {
        watcher.close();
      };
    },
  };
}
