/** Setup-flag evaluation for skill prerequisite gating.
 *
 *  Flags are environment facts ("is python3 installed", "is the vault a git repo")
 *  checked locally with Node APIs. Runs in any Node-capable context:
 *  Obsidian renderer (plugin) or Electron main process (app — call via IPC,
 *  the sandboxed renderer has no fs access).
 */

import type { RegistrySkill, SkillDef } from "./types";

export function evaluateSetupFlag(flag: string, vaultBase: string): boolean {
  const fs = require("fs");
  const path = require("path");
  switch (flag) {
    case "vault-structure":
      return fs.existsSync(path.join(vaultBase, "CLAUDE.md"));
    case "gsuite-connected":
      return fs.existsSync(path.join(require("os").homedir(), ".modular-context", "mcp-google", "accounts-index.json"));
    case "whatsapp-macos":
      return (process as any).platform === "darwin" && fs.existsSync("/Applications/WhatsApp.app");
    case "git-initialized":
      return fs.existsSync(path.join(vaultBase, ".git"));
    case "python3":
      try { require("child_process").execSync("command -v python3", { stdio: "ignore" }); return true; }
      catch { return false; }
    case "clickup-connected":
      return fs.existsSync(path.join(require("os").homedir(), ".modular-context", "clickup", "credentials.json"));
    default:
      return true; // unknown flag — pass-through (don't block)
  }
}

/** Check a skill's prereqs against installed skills + setup flags.
 *  `requires` entries that match a known skill id are treated as skill dependencies,
 *  everything else as a setup flag. Returns missing items ("skill:x" / "setup:y") or []. */
export function checkSkillPrereqs(
  skill: Pick<SkillDef | RegistrySkill, "requires">,
  knownSkillIds: Set<string>,
  installedIds: Set<string>,
  vaultBase: string,
): string[] {
  if (!skill.requires || skill.requires.length === 0) return [];
  const missing: string[] = [];
  for (const req of skill.requires) {
    if (knownSkillIds.has(req)) {
      if (!installedIds.has(req)) missing.push(`skill:${req}`);
    } else {
      if (!evaluateSetupFlag(req, vaultBase)) missing.push(`setup:${req}`);
    }
  }
  return missing;
}
