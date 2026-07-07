/** SkillRegistry — host-agnostic skill installer for the modular-context skill library.
 *
 *  Fetches registry.json from GitHub raw, installs skills into the vault's
 *  `.claude/skills/{id}/` (type "skill") or `.claude/commands/{id}.md` (type "command"),
 *  resolves skill→skill dependencies recursively, tracks installs with a content hash
 *  so locally-modified skills are detectable.
 *
 *  Hosts plug in via SkillRegistryHost:
 *    - Obsidian plugin: requestUrl + app.vault.adapter + plugin.loadData/saveData + Notice
 *    - Electron app: fetch + fs/promises (vault-relative) + electron-store + toast/console
 */

import {
  SKILL_REGISTRY_URL,
  SKILL_BASE_URL,
  type RegistryData,
  type InstalledSkillInfo,
} from "./types";

export interface SkillRegistryHost {
  /** HTTP GET returning status + body text. Throw on network failure. */
  fetchText(url: string): Promise<{ status: number; text: string }>;
  /** Vault-relative file ops. Paths use forward slashes (".claude/skills/x/SKILL.md"). */
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  /** Persistent key-value blob (plugin data.json / electron-store namespace). */
  loadData(): Promise<Record<string, any>>;
  saveData(data: Record<string, any>): Promise<void>;
  /** User-visible notification (Notice in Obsidian, toast/console in app). */
  notify(message: string): void;
}

const CACHE_TTL_MS = 3600000; // 1h — registry changes propagate within an hour

export class SkillRegistry {
  private host: SkillRegistryHost;
  private cache: RegistryData | null = null;

  constructor(host: SkillRegistryHost) {
    this.host = host;
  }

  async fetchRegistry(force = false): Promise<RegistryData | null> {
    if (this.cache && !force) return this.cache;

    // Try cached data from host storage first
    const data = await this.host.loadData();
    const cachedAt = data.registryCachedAt;
    const now = Date.now();
    // Use cache if less than 1 hour old and not forced
    if (!force && cachedAt && now - new Date(cachedAt).getTime() < CACHE_TTL_MS && data.registryCache) {
      this.cache = data.registryCache;
      return this.cache;
    }

    try {
      const response = await this.host.fetchText(SKILL_REGISTRY_URL);
      if (response.status === 200) {
        this.cache = JSON.parse(response.text) as RegistryData;
        // Persist cache
        data.registryCache = this.cache;
        data.registryCachedAt = new Date().toISOString();
        await this.host.saveData(data);
        return this.cache;
      }
    } catch (e) {
      console.warn("[mc] Failed to fetch skill registry:", e);
      // Fall back to persisted cache
      if (data.registryCache) {
        this.cache = data.registryCache;
        return this.cache;
      }
    }
    return null;
  }

  async getSkillStatus(skillId: string): Promise<"not-installed" | "installed" | "update-available"> {
    const isCommand = await this.isCommandType(skillId);
    const path = isCommand
      ? `.claude/commands/${skillId}.md`
      : `.claude/skills/${skillId}/SKILL.md`;
    const exists = await this.host.exists(path);
    if (!exists) return "not-installed";

    const registry = await this.fetchRegistry();
    if (!registry) return "installed";

    const data = await this.host.loadData();
    const installed = data.installedSkills?.[skillId] as InstalledSkillInfo | undefined;
    if (!installed) return "installed"; // Installed but not tracked by us

    const regSkill = registry.skills.find((s) => s.id === skillId);
    if (regSkill && regSkill.version !== installed.version) return "update-available";

    return "installed";
  }

  async getInstalledIds(): Promise<Set<string>> {
    const data = await this.host.loadData();
    return new Set(Object.keys(data.installedSkills ?? {}));
  }

  private async isCommandType(skillId: string): Promise<boolean> {
    const registry = await this.fetchRegistry();
    if (!registry) return false;
    const skill = registry.skills.find((s) => s.id === skillId);
    return skill?.type === "command";
  }

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      hash = (hash << 5) - hash + ch;
      hash |= 0;
    }
    return hash.toString(36);
  }

  async isModifiedLocally(skillId: string): Promise<boolean> {
    const data = await this.host.loadData();
    const installed = data.installedSkills?.[skillId] as InstalledSkillInfo | undefined;
    if (!installed?.contentHash) return false; // Can't tell, assume not modified

    const isCommand = await this.isCommandType(skillId);
    const path = isCommand
      ? `.claude/commands/${skillId}.md`
      : `.claude/skills/${skillId}/SKILL.md`;

    try {
      const content = await this.host.readFile(path);
      const currentHash = this.simpleHash(content);
      return currentHash !== installed.contentHash;
    } catch {
      return false;
    }
  }

  async installSkill(skillId: string, _seen: Set<string> = new Set()): Promise<boolean> {
    const registry = await this.fetchRegistry();
    if (!registry) {
      this.host.notify("Cannot fetch skill registry. Check your internet connection.");
      return false;
    }

    const regSkill = registry.skills.find((s) => s.id === skillId);
    if (!regSkill) {
      this.host.notify(`Skill "${skillId}" not found in registry.`);
      return false;
    }

    // Auto-install skill dependencies: any `requires` entry that is itself a registry
    // skill (e.g. clickup-review requires review-core) — recursive, cycle-guarded.
    _seen.add(skillId);
    const installedIds = await this.getInstalledIds();
    const deps = (regSkill.requires ?? []).filter((r) => registry.skills.some((s) => s.id === r));
    for (const dep of deps) {
      if (_seen.has(dep) || installedIds.has(dep)) continue;
      const okDep = await this.installSkill(dep, _seen);
      if (okDep) this.host.notify(`Installed dependency: ${dep}`);
    }

    const isCommand = regSkill.type === "command";
    const tierPath = regSkill.tier === "community" ? "community" : "core";

    try {
      if (isCommand) {
        // Commands go to .claude/commands/
        await this.ensureDir(".claude/commands");
        const url = `${SKILL_BASE_URL}${tierPath}/${skillId}/COMMAND.md`;
        const resp = await this.host.fetchText(url);
        const destPath = `.claude/commands/${skillId}.md`;
        await this.host.writeFile(destPath, resp.text);

        // Track installation
        await this.trackInstall(skillId, regSkill.version, this.simpleHash(resp.text));
      } else {
        // Skills go to .claude/skills/{id}/
        const skillDir = `.claude/skills/${skillId}`;
        await this.ensureDir(skillDir);

        for (const file of regSkill.files) {
          const url = `${SKILL_BASE_URL}${tierPath}/${skillId}/${file}`;
          const resp = await this.host.fetchText(url);
          const destPath = `${skillDir}/${file}`;
          // Ensure subdirs exist (e.g., references/)
          const lastSlash = destPath.lastIndexOf("/");
          if (lastSlash > skillDir.length) {
            await this.ensureDir(destPath.substring(0, lastSlash));
          }
          await this.host.writeFile(destPath, resp.text);
        }

        // Track installation with hash of main SKILL.md
        const mainContent = await this.host.readFile(`${skillDir}/SKILL.md`);
        await this.trackInstall(skillId, regSkill.version, this.simpleHash(mainContent));
      }

      return true;
    } catch (e) {
      console.error(`[mc] Failed to install skill ${skillId}:`, e);
      this.host.notify(`Failed to install "${regSkill.label}". Check console for details.`);
      return false;
    }
  }

  async installMultiple(
    skillIds: string[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<number> {
    let installed = 0;
    for (let i = 0; i < skillIds.length; i++) {
      const ok = await this.installSkill(skillIds[i]);
      if (ok) installed++;
      onProgress?.(i + 1, skillIds.length);
    }
    return installed;
  }

  private async ensureDir(path: string) {
    // Create intermediate directories one level at a time — Obsidian's adapter.mkdir
    // is not recursive, and the Node host may also be non-recursive.
    const parts = path.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.host.exists(current))) {
        await this.host.mkdir(current);
      }
    }
  }

  private async trackInstall(skillId: string, version: string, contentHash: string) {
    const data = await this.host.loadData();
    if (!data.installedSkills) data.installedSkills = {};
    data.installedSkills[skillId] = {
      version,
      installedAt: new Date().toISOString().split("T")[0],
      modified: false,
      contentHash,
    } as InstalledSkillInfo;
    await this.host.saveData(data);
  }
}
