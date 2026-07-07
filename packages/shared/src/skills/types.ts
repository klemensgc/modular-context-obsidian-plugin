/** Skill registry types — shared between Obsidian plugin and Electron app.
 *  Extracted from plugin main.ts (v2.1.4) so both hosts consume one source of truth. */

export const SKILL_REGISTRY_URL =
  "https://raw.githubusercontent.com/klemensgc/modular-context-skills/main/registry.json";
export const SKILL_BASE_URL =
  "https://raw.githubusercontent.com/klemensgc/modular-context-skills/main/";

export interface SkillDef {
  id: string;
  label: string;
  description: string;
  primary?: boolean;
  // v2.1 library extensions (all optional — backwards compat w registries without these fields)
  stars?: 1 | 2 | 3 | 4 | 5;
  difficulty?: "learner" | "operator" | "expert";
  value?: "low" | "medium" | "high";
  scope?: "universal" | "native-mc";
  requires?: string[];
  category?: "analyze" | "capture" | "create" | "maintain" | "automate";
}

// Category → (label, emoji) for sidebar/onboarding section headers
export const CATEGORY_META: Record<string, { label: string; icon: string }> = {
  capture: { label: "Capture", icon: "📥" },
  analyze: { label: "Analyze", icon: "🔍" },
  create: { label: "Create", icon: "✏️" },
  maintain: { label: "Maintain", icon: "🧹" },
  automate: { label: "Automate", icon: "🤖" },
  other: { label: "Other", icon: "•" }, // fallback for skills w/o category
};

export interface RegistrySkill {
  id: string;
  label: string;
  description: string;
  version: string;
  category: string;
  tier: string;
  files: string[];
  size: string;
  primary?: boolean;
  type?: string; // "command" for .claude/commands/ items
  requires?: string[]; // setup flags + skill-id dependencies (auto-installed)
}

export interface RegistryData {
  version: string;
  updated: string;
  source: string;
  skills: RegistrySkill[];
}

export interface InstalledSkillInfo {
  version: string;
  installedAt: string;
  modified: boolean;
  contentHash?: string;
}
