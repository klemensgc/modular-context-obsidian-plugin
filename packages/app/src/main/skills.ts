/** Skills backend — Node host for the shared SkillRegistry core.
 *
 *  Same install logic as the Obsidian plugin (one source of truth in
 *  @mc/shared): fetch registry.json from GitHub raw, install skills into the
 *  vault's .claude/skills|commands, resolve dependencies, track installs.
 *  Lives in the main process — the sandboxed renderer has no fs/network.
 */

import { BrowserWindow } from "electron";
import { promises as fs, existsSync } from "fs";
import { join, dirname } from "path";
import { SkillRegistry, type SkillRegistryHost, type RegistryData } from "@mc/shared";
import type Store from "electron-store";

const registries = new Map<string, SkillRegistry>();

function notifyRenderer(message: string) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("app:notify", message);
  }
  console.log("[mc-app skills]", message);
}

function makeHost(vaultPath: string, store: Store<any>): SkillRegistryHost {
  // Registry cache is global (same registry for every vault); install tracking is per-vault.
  // The shared core reads both from one blob, so compose it on load and split on save.
  const installKey = `installedSkills:${vaultPath}`;
  return {
    fetchText: async (url: string) => {
      const resp = await fetch(url);
      return { status: resp.status, text: await resp.text() };
    },
    readFile: (path: string) => fs.readFile(join(vaultPath, path), "utf-8"),
    writeFile: async (path: string, content: string) => {
      const full = join(vaultPath, path);
      await fs.mkdir(dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf-8");
    },
    exists: async (path: string) => existsSync(join(vaultPath, path)),
    mkdir: async (path: string) => {
      await fs.mkdir(join(vaultPath, path), { recursive: true });
    },
    loadData: async () => ({
      registryCache: store.get("registryCache", null),
      registryCachedAt: store.get("registryCachedAt", null),
      installedSkills: store.get(installKey, {}),
    }),
    saveData: async (data: Record<string, any>) => {
      if (data.registryCache !== undefined) store.set("registryCache", data.registryCache);
      if (data.registryCachedAt !== undefined) store.set("registryCachedAt", data.registryCachedAt);
      if (data.installedSkills !== undefined) store.set(installKey, data.installedSkills);
    },
    notify: notifyRenderer,
  };
}

export function getRegistryFor(vaultPath: string, store: Store<any>): SkillRegistry {
  let reg = registries.get(vaultPath);
  if (!reg) {
    reg = new SkillRegistry(makeHost(vaultPath, store));
    registries.set(vaultPath, reg);
  }
  return reg;
}

export async function fetchRegistryData(vaultPath: string, store: Store<any>): Promise<RegistryData | null> {
  return getRegistryFor(vaultPath, store).fetchRegistry();
}

export async function installSkills(
  vaultPath: string,
  store: Store<any>,
  ids: string[],
): Promise<number> {
  const reg = getRegistryFor(vaultPath, store);
  return reg.installMultiple(ids, (done, total) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("skills:install-progress", done, total);
    }
  });
}

/** Filesystem scan — ground truth of what is installed in this vault,
 *  independent of our install tracking (user may have added skills by hand). */
export async function scanInstalledSkills(vaultPath: string): Promise<string[]> {
  const ids = new Set<string>();
  try {
    const skillsDir = join(vaultPath, ".claude", "skills");
    for (const item of await fs.readdir(skillsDir, { withFileTypes: true })) {
      if (item.isDirectory() && existsSync(join(skillsDir, item.name, "SKILL.md"))) {
        ids.add(item.name);
      }
    }
  } catch { /* no skills dir */ }
  try {
    const commandsDir = join(vaultPath, ".claude", "commands");
    for (const item of await fs.readdir(commandsDir, { withFileTypes: true })) {
      if (item.isFile() && item.name.endsWith(".md")) {
        ids.add(item.name.replace(/\.md$/, ""));
      }
    }
  } catch { /* no commands dir */ }
  return [...ids].sort();
}
