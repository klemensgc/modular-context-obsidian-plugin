/** Onboarding backend — preflight doctor + deterministic vault scaffold.
 *
 *  Doctor verifies the environment the terminal/agents depend on BEFORE the
 *  user hits a silent failure (the PTY itself needs python3; skills need the
 *  claude CLI). Scaffold copies the bundled template (templates/vault/) into a
 *  new folder, substitutes placeholders, generates project folders and runs
 *  git init — so flagship skills (process-transcripts and friends) find the
 *  agents and schema files they require on day one.
 */

import { execFile } from "child_process";
import { promises as fs, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

// --- Doctor ---

export interface DoctorCheck {
  id: string;
  label: string;
  ok: boolean;
  /** Critical = the app's core loop cannot work without it. */
  critical: boolean;
  detail: string;
  fixHint?: string;
}

/** Run a command through a zsh LOGIN shell — mirrors the PATH the PTY sessions
 *  will actually see (claude is usually installed via npm-global or ~/.local). */
function zshWhich(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("/bin/zsh", ["-lc", `command -v ${binary}`], { timeout: 10000 }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(stdout.trim() || null);
    });
  });
}

function claudeLoggedIn(): boolean {
  try {
    const credPath = join(homedir(), ".claude", ".credentials.json");
    if (existsSync(credPath)) return true;
    const cfgPath = join(homedir(), ".claude.json");
    if (existsSync(cfgPath)) {
      const raw = readFileSync(cfgPath, "utf-8");
      return raw.includes("oauthAccount");
    }
  } catch {
    // fall through
  }
  return false;
}

export async function runDoctor(): Promise<DoctorCheck[]> {
  const [python3, claude, git] = await Promise.all([
    zshWhich("python3"),
    zshWhich("claude"),
    zshWhich("git"),
  ]);

  const checks: DoctorCheck[] = [
    {
      id: "python3",
      label: "Python 3",
      ok: !!python3,
      critical: true,
      detail: python3 ?? "not found",
      fixHint: python3 ? undefined : "Install Xcode Command Line Tools: xcode-select --install (terminal sessions cannot start without python3)",
    },
    {
      id: "claude-cli",
      label: "Claude Code CLI",
      ok: !!claude,
      critical: true,
      detail: claude ?? "not found",
      fixHint: claude ? undefined : "Install: npm install -g @anthropic-ai/claude-code — or see https://claude.com/claude-code",
    },
    {
      id: "claude-auth",
      label: "Claude Code logged in",
      ok: claudeLoggedIn(),
      critical: false,
      detail: claudeLoggedIn() ? "credentials found" : "no credentials found",
      fixHint: claudeLoggedIn() ? undefined : "Run `claude` once in any terminal and complete the login flow",
    },
    {
      id: "git",
      label: "Git",
      ok: !!git,
      critical: false,
      detail: git ?? "not found",
      fixHint: git ? undefined : "Install Xcode Command Line Tools: xcode-select --install (vault versioning will be skipped)",
    },
    {
      id: "zsh",
      label: "zsh shell",
      ok: existsSync("/bin/zsh"),
      critical: true,
      detail: existsSync("/bin/zsh") ? "/bin/zsh" : "missing",
    },
  ];
  return checks;
}

// --- Scaffold ---

export interface CreateVaultOptions {
  parentDir: string;
  name: string;
  /** Human-readable language name written into CLAUDE.md (e.g. "English", "Polish"). */
  language: string;
  /** 1-3 project names; folders are generated as {n}_{slug}/. */
  projects: string[];
}

export function getTemplatesDir(): string {
  // Test/CI override
  if (process.env.MC_TEMPLATES_DIR) return process.env.MC_TEMPLATES_DIR;
  // Dev: dist/main/index.js → packages/app/templates
  const devPath = join(__dirname, "../../templates");
  if (existsSync(devPath)) return devPath;
  // Packaged: electron-builder extraResources
  return join(process.resourcesPath, "templates");
}

export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/ł/g, "l").replace(/Ł/g, "L")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "project";
}

function gitRun(args: string[], cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 20000 }, (err) => resolve(!err));
  });
}

const TEMPLATE_DATE_RE = /^updated: \d{4}-\d{2}-\d{2}$/m;

export async function createVaultFromTemplate(opts: CreateVaultOptions): Promise<{ vaultPath: string; gitInitialized: boolean }> {
  const templatesDir = getTemplatesDir();
  const vaultName = opts.name.trim();
  if (!vaultName) throw new Error("Vault name is empty");
  const vaultPath = join(opts.parentDir, vaultName);

  if (existsSync(vaultPath)) {
    const entries = await fs.readdir(vaultPath);
    if (entries.length > 0) throw new Error(`Folder already exists and is not empty: ${vaultPath}`);
  }

  // 1. Copy template verbatim (includes .claude/ and .gitkeep dotfiles)
  await fs.cp(join(templatesDir, "vault"), vaultPath, { recursive: true });

  // electron-builder's extraResources drops .gitkeep files, which erases the
  // empty transcript category folders from the packaged template — recreate
  // them explicitly (list mirrors _claude/7-skill-references/category-routing.md).
  const TRANSCRIPT_CATEGORIES = ["meetings", "product", "clients", "research", "strategy", "personal", "other"];
  for (const cat of TRANSCRIPT_CATEGORIES) {
    const dir = join(vaultPath, "_transcripts", cat);
    await fs.mkdir(dir, { recursive: true });
    const keep = join(dir, ".gitkeep");
    if (!existsSync(keep)) await fs.writeFile(keep, "", "utf-8");
  }

  // 2. Placeholder + date substitution across all copied .md files
  const today = new Date().toISOString().split("T")[0];
  async function walkMd(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      if (item.isDirectory()) out.push(...(await walkMd(full)));
      else if (item.name.endsWith(".md")) out.push(full);
    }
    return out;
  }
  for (const file of await walkMd(vaultPath)) {
    let content = await fs.readFile(file, "utf-8");
    let changed = false;
    if (content.includes("{{LANGUAGE}}")) {
      content = content.split("{{LANGUAGE}}").join(opts.language);
      changed = true;
    }
    // Freshen the template's ship date so staleness signals start from vault creation
    if (TEMPLATE_DATE_RE.test(content)) {
      content = content.replace(/^updated: \d{4}-\d{2}-\d{2}$/m, `updated: ${today}`);
      changed = true;
    }
    if (changed) await fs.writeFile(file, content, "utf-8");
  }

  // 3. Generate project folders from the project-index template
  const projectTemplate = await fs.readFile(join(templatesDir, "project-index.md"), "utf-8");
  const projects = opts.projects.map((p) => p.trim()).filter(Boolean).slice(0, 3);
  const projectRows: string[] = [];
  for (let i = 0; i < projects.length; i++) {
    const n = i + 1;
    const projectName = projects[i];
    const slug = slugify(projectName);
    const folderName = `${n}_${slug}`;
    const indexBase = `${n}_${slug}_index`;
    const content = projectTemplate
      .split("{{PROJECT_NAME}}").join(projectName)
      .split("{{PROJECT_SLUG}}").join(slug)
      .split("{{N}}").join(String(n))
      .replace(/^updated: \d{4}-\d{2}-\d{2}$/m, `updated: ${today}`);
    await fs.mkdir(join(vaultPath, folderName), { recursive: true });
    await fs.writeFile(join(vaultPath, folderName, `${indexBase}.md`), content, "utf-8");
    projectRows.push(`| ${n} | ${projectName} | [[${folderName}/${indexBase}]] |`);
  }

  // 4. Inject the project table into CLAUDE.md (after the Key files table)
  if (projects.length > 0) {
    const claudePath = join(vaultPath, "CLAUDE.md");
    let claudeMd = await fs.readFile(claudePath, "utf-8");
    const anchor = "| `_workspace/_workspace_index.md` | Ad-hoc deliverables workspace |";
    if (claudeMd.includes(anchor)) {
      const table = [
        "",
        "**Projects:**",
        "",
        "| # | Project | Index |",
        "|---|---------|-------|",
        ...projectRows,
      ].join("\n");
      claudeMd = claudeMd.replace(anchor, anchor + "\n" + table);
      await fs.writeFile(claudePath, claudeMd, "utf-8");
    }
  }

  // 5. .gitignore + git init + initial commit (best-effort; doctor already warned if git is missing)
  const gitignorePath = join(vaultPath, ".gitignore");
  if (!existsSync(gitignorePath)) {
    await fs.writeFile(gitignorePath, ".DS_Store\n.obsidian/workspace*.json\n", "utf-8");
  }
  let gitInitialized = false;
  if (await gitRun(["init"], vaultPath)) {
    await gitRun(["add", "-A"], vaultPath);
    gitInitialized = await gitRun(
      ["commit", "-m", "Add: vault scaffold from Modular Context template"],
      vaultPath,
    );
  }

  return { vaultPath, gitInitialized };
}

export function defaultVaultParentDir(): string {
  // Lazy electron import keeps this module loadable in headless tests
  const { app } = require("electron");
  return join(app.getPath("documents"));
}
