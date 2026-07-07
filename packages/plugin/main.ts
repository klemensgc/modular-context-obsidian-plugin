import { Plugin, ItemView, WorkspaceLeaf, App, TFile, setIcon, SuggestModal, Modal, Menu, addIcon, Setting, PluginSettingTab, Notice, requestUrl, MarkdownRenderer, Component } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import type { ChildProcess } from "child_process";
import {
  SESSION_GLYPHS,
  SLOT_COUNT,
  buildXtermTheme,
  BookmarkManager,
  AgentTracker,
  FullscreenManager,
  PTY_HELPER_SOURCE,
  spawnPtyShell,
  MIN_DWELL_MS,
  IDLE_PROMPT_MS,
  IDLE_SAFETY_MS,
  REVIVE_BYTES,
  REVIVE_WINDOW_MS,
  AUTO_DETECT_WINDOW_MS,
  emptyRestoreState,
  RESTORE_STATE_VERSION,
  SkillRegistry as SkillRegistryCore,
  sendWhenReady,
  buildOnboardingPrompt,
  type FullscreenLayout,
  type DisplayMode,
  type Bookmark,
  type TrackedSession,
  type TrackableSession,
  type SessionSnapshot,
  type RestoreState,
  type RestoreLayout,
  type SkillDef,
  type RegistrySkill,
} from "@mc/shared";
import { ConnectGoogleModal } from "./src/google/ui/connect-google-modal";
import { createStorageMethod } from "./src/google/tokens/storage";
import { startRefreshTimer, type RefreshTimerHandle } from "./src/google/tokens/refresh";
import type { TokenStorageMethod, OAuthConfig, StoredTokens, AccountIndex } from "@mc/shared";
import { GOOGLE_WORKSPACE_SCOPES } from "@mc/shared";

// Esbuild injects these from packages/plugin/.env.local (empty strings if file absent)
declare const process: { env: { GOOGLE_OAUTH_CLIENT_ID: string; GOOGLE_OAUTH_CLIENT_SECRET: string } };

const VIEW_TYPE = "mc-terminal-view";
let ptyHelperPath = "";
// PTY helper Python source now imported from @mc/shared (bundled via esbuild .py text loader).

// --- Theme helpers ---
// Build an xterm.js ITheme from Obsidian's CSS variables at runtime.
// ANSI colors use sensible defaults that adapt to light/dark mode.

/** Check if a captured ❯ input line makes a good auto-generated session name */
function isGoodAutoName(input: string): boolean {
  if (input.length < 4) return false;
  if (input === "claude" || input.startsWith("claude ")) return false;
  if (/^\d+\.\s/.test(input)) return false;
  if (/^\d+$/.test(input)) return false;
  const ephemeral = new Set([
    "yes", "no", "y", "n", "ok", "okay", "sure", "done",
    "exit", "quit", "help", "retry", "skip", "cancel",
    "resume", "res", "continue", "cont",
  ]);
  if (ephemeral.has(input.toLowerCase())) return false;
  return true;
}

function getObsidianTheme() {
  const s = getComputedStyle(document.body);
  return buildXtermTheme({
    getCssVar: (v) => s.getPropertyValue(v).trim(),
    isDark: document.body.classList.contains("theme-dark"),
  });
}

// --- WikiLinkAutocomplete ---
// Simpler approach: [[ passes through to the shell normally (user sees it typed).
// Dropdown appears overlaid. On accept we write "NoteName]]" to complete the link.
// On dismiss we just close the dropdown (the [[ is already in the shell).

interface AutocompleteEntry {
  name: string;        // display name (basename for files, link text for unresolved)
  folder: string;      // folder path for files, empty for unresolved
  isFile: boolean;     // true = existing file, false = unresolved link
  mtime: number;       // for sorting (0 for unresolved)
}

class WikiLinkAutocomplete {
  private app: App;
  private terminal: Terminal;
  private writeToShell: (data: string) => void;
  private active = false;
  private query = "";
  private results: AutocompleteEntry[] = [];
  private selectedIndex = 0;
  private lastCharWasBracket = false;
  private dropdownEl: HTMLElement | null = null;
  private filterTimer: ReturnType<typeof setTimeout> | null = null;
  private containerEl: HTMLElement;
  private previewEl: HTMLElement | null = null;
  private resizeDisposable: { dispose(): void } | null = null;

  constructor(app: App, terminal: Terminal, writeToShell: (data: string) => void, containerEl: HTMLElement) {
    this.app = app;
    this.terminal = terminal;
    this.writeToShell = writeToShell;
    this.containerEl = containerEl;

    // Intercept keys when autocomplete is active.
    // Nothing echoes to shell while active - user sees their typing in the dropdown header.
    this.terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      // Shift+Enter: send newline instead of carriage return
      if (e.type === "keydown" && e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        this.writeToShell("\n");
        return false;
      }

      if (!this.active) return true;
      if (e.type !== "keydown") return false;

      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          this.selectedIndex = Math.max(0, this.selectedIndex - 1);
          this.renderDropdown();
          return false;
        case "ArrowDown":
          e.preventDefault();
          this.selectedIndex = Math.min(this.results.length - 1, this.selectedIndex + 1);
          this.renderDropdown();
          return false;
        case "Enter":
        case "Tab":
          e.preventDefault();
          this.accept();
          return false;
        case "Escape":
          e.preventDefault();
          this.dismiss();
          return false;
        case "Backspace":
          e.preventDefault();
          if (this.query.length > 0) {
            this.query = this.query.slice(0, -1);
            this.filterResults();
          } else {
            this.dismiss();
          }
          return false;
        default:
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            this.query += e.key;
            this.filterResults();
            return false;
          }
          if (e.metaKey || e.ctrlKey) return true;
          return false;
      }
    });

    // Reposition on resize
    this.resizeDisposable = this.terminal.onResize(() => {
      if (this.active && this.dropdownEl) this.positionDropdown();
    });
  }

  /**
   * Called for every onData event. Detects [[ by tracking consecutive brackets.
   * Never consumes data - all chars go to shell normally.
   */
  handleData(data: string): void {
    if (this.active) return;

    // Check for [[ in pasted multi-char data
    if (data.length > 1) {
      if (data.includes("[[")) {
        this.activate();
      }
      this.lastCharWasBracket = data.endsWith("[");
      return;
    }

    // Single char: detect consecutive [[
    if (data === "[") {
      if (this.lastCharWasBracket) {
        this.lastCharWasBracket = false;
        this.activate();
      } else {
        this.lastCharWasBracket = true;
      }
    } else {
      this.lastCharWasBracket = false;
    }
  }

  private activate() {
    this.active = true;
    this.query = "";
    this.results = [];
    this.selectedIndex = 0;
    this.filterResults();
  }

  private accept() {
    if (this.results.length > 0 && this.selectedIndex < this.results.length) {
      const entry = this.results[this.selectedIndex];
      this.writeToShell(`${entry.name}]]`);
    } else if (this.query.length > 0) {
      // No match but user typed something - write it + close
      this.writeToShell(`${this.query}]]`);
    } else {
      this.writeToShell("]]");
    }
    this.deactivate();
  }

  private dismiss() {
    // Write whatever the user typed so far to shell so they don't lose it
    if (this.query.length > 0) {
      this.writeToShell(this.query);
    }
    this.deactivate();
  }

  private deactivate() {
    this.active = false;
    this.query = "";
    this.results = [];
    this.selectedIndex = 0;
    this.removeDropdown();
  }

  /** Gather all entries: real files + unresolved link targets */
  private getAllEntries(): AutocompleteEntry[] {
    const entries: AutocompleteEntry[] = [];
    const seen = new Set<string>();

    // Real files
    for (const f of this.app.vault.getFiles()) {
      entries.push({
        name: f.basename,
        folder: f.parent?.path || "",
        isFile: true,
        mtime: f.stat.mtime,
      });
      seen.add(f.basename.toLowerCase());
    }

    // Unresolved links from metadata cache
    const unresolved = (this.app.metadataCache as any).unresolvedLinks as Record<string, Record<string, number>> | undefined;
    if (unresolved) {
      for (const sourceFile of Object.values(unresolved)) {
        for (const linkTarget of Object.keys(sourceFile)) {
          const key = linkTarget.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            entries.push({
              name: linkTarget,
              folder: "",
              isFile: false,
              mtime: 0,
            });
          }
        }
      }
    }

    return entries;
  }

  private filterResults() {
    if (this.filterTimer) clearTimeout(this.filterTimer);
    this.filterTimer = setTimeout(() => {
      const q = this.query.toLowerCase();
      const allEntries = this.getAllEntries();

      if (q.length === 0) {
        // Show recent files first, then unresolved
        this.results = allEntries
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, 10);
      } else {
        const prefix: AutocompleteEntry[] = [];
        const contains: AutocompleteEntry[] = [];
        for (const entry of allEntries) {
          const name = entry.name.toLowerCase();
          if (name.startsWith(q)) prefix.push(entry);
          else if (name.includes(q)) contains.push(entry);
        }
        this.results = [...prefix, ...contains].slice(0, 10);
      }

      this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.results.length - 1));
      this.renderDropdown();
    }, 16);
  }

  private renderDropdown() {
    if (!this.dropdownEl) {
      this.dropdownEl = document.createElement("div");
      this.dropdownEl.className = "mc-wikilink-dropdown";
      this.containerEl.appendChild(this.dropdownEl);
    }

    this.positionDropdown();

    let html = `<div class="mc-wikilink-header">[[${this.escapeHtml(this.query)}</div>`;

    if (this.results.length === 0) {
      html += `<div class="mc-wikilink-empty">No matches</div>`;
    } else {
      html += `<div class="mc-wikilink-list">`;
      this.results.forEach((entry, i) => {
        const selected = i === this.selectedIndex ? " is-selected" : "";
        const unresolvedCls = entry.isFile ? "" : " is-unresolved";
        html += `<div class="mc-wikilink-item${selected}${unresolvedCls}" data-index="${i}">`;
        html += `<span class="mc-wikilink-name">${this.escapeHtml(entry.name)}</span>`;
        if (entry.isFile && entry.folder && entry.folder !== "/") {
          html += `<span class="mc-wikilink-path">${this.escapeHtml(entry.folder)}</span>`;
        } else if (!entry.isFile) {
          html += `<span class="mc-wikilink-path">no file yet</span>`;
        }
        html += `</div>`;
      });
      html += `</div>`;
    }

    this.dropdownEl.innerHTML = html;

    this.dropdownEl.querySelectorAll(".mc-wikilink-item").forEach((el) => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const idx = parseInt((el as HTMLElement).dataset.index || "0", 10);
        this.selectedIndex = idx;
        this.accept();
      });
    });

    this.renderPreview();
  }

  private positionDropdown() {
    if (!this.dropdownEl) return;

    const buf = this.terminal.buffer.active;
    const cursorX = buf.cursorX;
    const cursorY = buf.cursorY;

    const screen = this.containerEl.querySelector(".xterm-screen");
    if (!screen) return;
    const screenRect = screen.getBoundingClientRect();
    const containerRect = this.containerEl.getBoundingClientRect();
    const cols = this.terminal.cols;
    const rows = this.terminal.rows;
    const cellW = screenRect.width / cols;
    const cellH = screenRect.height / rows;

    const offsetX = screenRect.left - containerRect.left;
    const offsetY = screenRect.top - containerRect.top;

    const dropdownWidth = 300; // approximate width to clamp against
    const dropdownHeight = 220;
    const containerWidth = containerRect.width;
    const containerHeight = containerRect.height;

    // Horizontal: clamp so dropdown stays within container
    let left = offsetX + cursorX * cellW;
    if (left + dropdownWidth > containerWidth) {
      left = Math.max(4, containerWidth - dropdownWidth - 4);
    }

    // Vertical: prefer below cursor, flip above if not enough space
    const cursorBottom = offsetY + (cursorY + 1) * cellH;
    if ((containerHeight - cursorBottom) > dropdownHeight || cursorY < rows / 2) {
      this.dropdownEl.style.top = `${cursorBottom}px`;
      this.dropdownEl.style.bottom = "";
    } else {
      this.dropdownEl.style.bottom = `${containerHeight - (offsetY + cursorY * cellH)}px`;
      this.dropdownEl.style.top = "";
    }
    this.dropdownEl.style.left = `${left}px`;
  }

  private removeDropdown() {
    this.removePreview();
    if (this.dropdownEl) {
      this.dropdownEl.remove();
      this.dropdownEl = null;
    }
  }

  private async renderPreview() {
    const entry = this.results[this.selectedIndex];
    if (!entry || !entry.isFile) {
      this.removePreview();
      return;
    }

    if (!this.previewEl) {
      this.previewEl = document.createElement("div");
      this.previewEl.className = "mc-wikilink-preview";
      this.containerEl.appendChild(this.previewEl);
    }

    this.positionPreview();

    const file = this.app.vault.getAbstractFileByPath(
      entry.folder ? `${entry.folder}/${entry.name}.md` : `${entry.name}.md`
    );
    if (!file || !(file instanceof TFile)) {
      this.previewEl.innerHTML = `<div class="mc-preview-empty">File not found</div>`;
      return;
    }

    const content = await this.app.vault.cachedRead(file);
    const lines = content.split("\n").slice(0, 10);
    const preview = lines.join("\n");

    const cache = this.app.metadataCache.getFileCache(file);
    const tags = cache?.tags?.map(t => t.tag) ?? [];
    const frontmatterTags = cache?.frontmatter?.tags ?? [];
    const allTags = [...new Set([...tags, ...frontmatterTags])];

    const resolved = (this.app.metadataCache as any).resolvedLinks ?? {};
    let backlinkCount = 0;
    for (const source of Object.keys(resolved)) {
      if (resolved[source]?.[file.path]) backlinkCount++;
    }

    const modified = new Date(file.stat.mtime);
    const dateStr = modified.toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric"
    });

    let html = `<div class="mc-preview-meta">`;
    html += `<span class="mc-preview-date">${dateStr}</span>`;
    html += `<span class="mc-preview-backlinks">${backlinkCount} backlink${backlinkCount !== 1 ? "s" : ""}</span>`;
    html += `</div>`;
    if (allTags.length > 0) {
      html += `<div class="mc-preview-tags">${allTags.map(t => `<span class="mc-preview-tag">${this.escapeHtml(String(t))}</span>`).join("")}</div>`;
    }
    html += `<div class="mc-preview-content">${this.escapeHtml(preview)}</div>`;
    this.previewEl.innerHTML = html;
  }

  private positionPreview() {
    if (!this.previewEl || !this.dropdownEl) return;
    const dropRect = this.dropdownEl.getBoundingClientRect();
    const containerRect = this.containerEl.getBoundingClientRect();
    const previewWidth = 280;

    const rightSpace = containerRect.right - dropRect.right;
    if (rightSpace >= previewWidth) {
      this.previewEl.style.left = `${dropRect.right - containerRect.left + 4}px`;
    } else {
      this.previewEl.style.left = `${dropRect.left - containerRect.left - previewWidth - 4}px`;
    }
    this.previewEl.style.top = this.dropdownEl.style.top;
    this.previewEl.style.bottom = this.dropdownEl.style.bottom;
    this.previewEl.style.width = `${previewWidth}px`;
  }

  private removePreview() {
    if (this.previewEl) {
      this.previewEl.remove();
      this.previewEl = null;
    }
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  destroy() {
    if (this.filterTimer) clearTimeout(this.filterTimer);
    this.removePreview();
    this.removeDropdown();
    this.resizeDisposable?.dispose();
  }
}

// --- BookmarkManager ---
// Now imported from @mc/shared (see top of file).

// --- FileOverlay ---

/** Renders a vault file inside a terminal pane, replacing the terminal visually.
 *  Used when a file is dragged from Obsidian's file explorer onto a pane. */
class FileOverlay {
  containerEl: HTMLElement;
  filePath: string;       // absolute path
  private app: App;
  private component: Component;
  destroyed = false;

  constructor(parent: HTMLElement, filePath: string, app: App, onClose: () => void) {
    this.filePath = filePath;
    this.app = app;
    this.component = new Component();
    this.component.load();

    this.containerEl = document.createElement("div");
    this.containerEl.className = "mc-file-overlay";
    parent.appendChild(this.containerEl);

    const pathMod = require("path");
    const vaultPath = (app.vault.adapter as any).basePath as string;
    const vaultRelative = pathMod.relative(vaultPath, filePath);
    const basename = pathMod.basename(filePath);

    // Toolbar
    const toolbar = this.containerEl.createDiv({ cls: "mc-file-overlay-toolbar" });
    const fileInfo = toolbar.createDiv({ cls: "mc-file-overlay-info" });
    const iconEl = fileInfo.createDiv({ cls: "mc-file-overlay-icon" });
    setIcon(iconEl, "file-text");
    fileInfo.createSpan({ cls: "mc-file-overlay-name", text: basename });

    const actions = toolbar.createDiv({ cls: "mc-file-overlay-actions" });

    const openBtn = actions.createEl("button", { cls: "mc-file-overlay-btn" });
    setIcon(openBtn, "external-link");
    openBtn.title = "Open in editor";
    openBtn.addEventListener("click", () => {
      const file = this.app.vault.getAbstractFileByPath(vaultRelative);
      if (file instanceof TFile) {
        this.app.workspace.openLinkText(vaultRelative, "", false);
      }
    });

    const closeBtn = actions.createEl("button", { cls: "mc-file-overlay-btn mc-file-overlay-close" });
    setIcon(closeBtn, "x");
    closeBtn.title = "Close file view";
    closeBtn.addEventListener("click", () => onClose());

    // Content
    const contentEl = this.containerEl.createDiv({ cls: "mc-file-overlay-content" });
    this.renderContent(contentEl, vaultRelative, basename);
  }

  private async renderContent(contentEl: HTMLElement, vaultRelative: string, basename: string) {
    const pathMod = require("path");
    const ext = pathMod.extname(basename).toLowerCase();
    const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);

    if (IMAGE_EXTS.has(ext)) {
      const img = contentEl.createEl("img", { cls: "mc-file-overlay-image" });
      img.src = `file://${this.filePath}`;
      img.alt = basename;
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(vaultRelative);
    if (!(file instanceof TFile)) {
      // Try reading from filesystem directly (external file)
      try {
        const fs = require("fs");
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const pre = contentEl.createEl("pre", { cls: "mc-file-overlay-raw" });
        pre.createEl("code", { text: raw });
      } catch {
        contentEl.createSpan({ cls: "mc-file-overlay-error", text: "Cannot read file" });
      }
      return;
    }

    const content = await this.app.vault.read(file);

    if ([".md", ".markdown"].includes(ext)) {
      const wrapper = contentEl.createDiv({ cls: "mc-file-overlay-markdown markdown-rendered" });
      await MarkdownRenderer.render(this.app, content, wrapper, vaultRelative, this.component);
    } else {
      const pre = contentEl.createEl("pre", { cls: "mc-file-overlay-raw" });
      pre.createEl("code", { text: content });
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.component.unload();
    this.containerEl.remove();
  }
}

// --- TerminalSession ---

class TerminalSession {
  terminal: Terminal;
  fitAddon: FitAddon;
  process: ChildProcess;
  containerEl: HTMLElement;
  /** Body wrapper hosting the xterm element. FitAddon sizes the terminal from
   *  the xterm element's PARENT box — the 24px session toolbar must live
   *  outside that box or every fit() overshoots and clips the bottom row. */
  bodyEl: HTMLElement;
  id: number;
  name: string;
  app: App;
  textareaEl: HTMLTextAreaElement | null = null;
  private autocomplete: WikiLinkAutocomplete | null = null;
  private bookmarkManager: BookmarkManager | null = null;
  hasActivity = false;
  destroyed = false;
  fileOverlay: FileOverlay | null = null;
  /** Visual glyph for compact sidebar. Glyph id (e.g. "circle") or skill icon name (e.g. "rocket"). */
  glyph = "";
  _lastStdoutAt = 0;
  /** Skill id/label if session was launched from a skill (set by launchSkill). Null otherwise. */
  skillName: string | null = null;
  /** Cached cwd for snapshot restore. Not updated live — set on creation, restored on replay. */
  cwd: string | null = null;
  /** Claude Code session UUID bound to this terminal (transcript file in
   *  ~/.claude/projects/<munged-cwd>/). Set by TerminalView.bindClaudeSessions(). */
  claudeSessionId: string | null = null;
  /** Epoch ms when a `claude` launch command was typed into this session.
   *  While set, the binder looks for a transcript file created after it. */
  _claudeLaunchAt: number | null = null;
  private _activityCallback: ((session: TerminalSession) => void) | null = null;
  setActivityCallback(cb: ((session: TerminalSession) => void) | null) {
    this._activityCallback = cb;
  }

  constructor(
    parent: HTMLElement,
    id: number,
    cwd: string,
    app: App,
    opts: { env?: Record<string, string> } = {},
  ) {
    this.id = id;
    this.name = `zsh ${id}`;
    this.app = app;
    this.cwd = cwd;

    this.containerEl = parent.createDiv({ cls: "mc-terminal-session" });
    // Dedicated xterm host. FitAddon measures the xterm element's parent, so
    // this wrapper must contain ONLY the terminal (toolbar/overlays go to
    // containerEl). See "terminal clipped at bottom" fix.
    this.bodyEl = this.containerEl.createDiv({ cls: "mc-terminal-body" });

    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13.5,
      lineHeight: 1.4,
      letterSpacing: 0.3,
      fontFamily: "'SF Mono', 'IBM Plex Mono', ui-monospace, 'Cascadia Code', monospace",
      fontWeight: "400",
      fontWeightBold: "600",
      theme: getObsidianTheme(),
      allowProposedApi: true,
      macOptionIsMeta: false,
      macOptionClickForcesSelection: false,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(this.bodyEl);

    // WebGL renderer — eliminates DOM-renderer scroll artefacts (residual chars,
    // colour bleed). Falls back silently to default DOM renderer if WebGL2 is
    // unavailable or the GPU context is lost.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      this.terminal.loadAddon(webgl);
    } catch (e) {
      console.warn("[modular-context] WebGL renderer unavailable, falling back to DOM:", e);
    }

    // Grab the hidden textarea xterm.js creates for input
    this.textareaEl = this.containerEl.querySelector(".xterm-helper-textarea");

    // Spawn zsh inside a real PTY via shared spawnPtyShell helper (uses Python PTY helper).
    const { process: ptyProcess } = spawnPtyShell({
      helperPath: ptyHelperPath,
      cwd,
      cols: 80,
      rows: 24,
      env: opts.env,
    });
    this.process = ptyProcess;

    this.process.on("error", (err: Error) => {
      console.error("[modular-context] Failed to spawn python3:", err);
      this.terminal.write("\r\n\x1b[31m[Error] python3 not found. Install Python 3 to use the terminal.\x1b[0m\r\n");
    });

    // Wiki-link autocomplete
    this.autocomplete = new WikiLinkAutocomplete(
      app, this.terminal, (data: string) => this.process.stdin?.write(data), this.containerEl
    );

    // Bookmark manager
    this.bookmarkManager = new BookmarkManager(this.terminal, this.containerEl);

    // Wire I/O
    this.terminal.onData((data) => {
      this.autocomplete?.handleData(data);
      this.process.stdin?.write(data);
    });

    this.process.stdout?.on("data", (data: Buffer) => {
      this.terminal.write(data);
      this._lastStdoutAt = Date.now();
      if (this._activityCallback) this._activityCallback(this);
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      this.terminal.write(data);
    });

    this.process.on("exit", () => {
      this.terminal.write("\r\n[Process exited]\r\n");
    });

    // When xterm.js changes cols/rows after a fit, tell the PTY
    this.terminal.onResize(({ cols, rows }) => {
      this.process.stdin?.write(`\x1b]R;${cols};${rows}\x07`);
    });

    // Initial fit after a tick (container needs to be laid out)
    setTimeout(() => this.fit(), 50);

    // Drag-and-drop: accept files dragged onto the terminal and paste their paths.
    // Use capture phase so events reach the terminal before Obsidian's workspace
    // handlers can intercept them.
    const captureOpt = { capture: true };
    let dragCounter = 0;
    // Capture Obsidian's internal drag info (tab/file-explorer drags) early —
    // dragManager.draggable may be cleared by the time the drop event fires.
    let savedDraggable: any = null;
    this.containerEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      // Highlight active drop zone half based on cursor position
      if (this.dropZoneEl) {
        const rect = this.dropZoneEl.getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        const leftHalf = this.dropZoneEl.querySelector(".mc-dropzone-paste");
        const rightHalf = this.dropZoneEl.querySelector(".mc-dropzone-open");
        if (leftHalf && rightHalf) {
          leftHalf.classList.toggle("is-active", e.clientX <= midX);
          rightHalf.classList.toggle("is-active", e.clientX > midX);
        }
      }
    }, captureOpt);

    this.containerEl.addEventListener("dragenter", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter++;
      if (dragCounter === 1) {
        this.showDropZone();
        // Snapshot Obsidian's internal draggable (set by tab / file-explorer drags)
        const dm = (this.app as any).dragManager;
        savedDraggable = dm?.draggable ?? dm?.currentDraggable ?? null;
      }
    }, captureOpt);

    this.containerEl.addEventListener("dragleave", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        this.hideDropZone();
        savedDraggable = null;
      }
    }, captureOpt);

    this.containerEl.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Detect which drop zone half was targeted
      const dzRect = this.dropZoneEl?.getBoundingClientRect();
      const wantOpen = dzRect ? e.clientX > dzRect.left + dzRect.width / 2 : false;
      dragCounter = 0;
      this.hideDropZone();
      this.handleDrop(e, wantOpen, savedDraggable);
      savedDraggable = null;
    }, captureOpt);
  }

  private dropZoneEl: HTMLElement | null = null;
  private dropBadgeTimer: ReturnType<typeof setTimeout> | null = null;

  private showDropZone() {
    if (this.dropZoneEl) return;
    this.dropZoneEl = document.createElement("div");
    this.dropZoneEl.className = "mc-terminal-dropzone";
    this.dropZoneEl.innerHTML = `
      <div class="mc-dropzone-half mc-dropzone-paste">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 10H3"/><path d="M21 6H3"/><path d="M21 14H3"/><path d="M17 18H3"/></svg>
        <span class="mc-dropzone-label">Paste path</span>
      </div>
      <div class="mc-dropzone-half mc-dropzone-open">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
        <span class="mc-dropzone-label">Open here</span>
      </div>`;
    this.containerEl.appendChild(this.dropZoneEl);
    // Trigger animation on next frame
    requestAnimationFrame(() => this.dropZoneEl?.addClass("is-visible"));
  }

  private hideDropZone() {
    if (!this.dropZoneEl) return;
    this.dropZoneEl.remove();
    this.dropZoneEl = null;
  }

  private showDropBadge(filePaths: string[]) {
    // Clear any existing badge
    if (this.dropBadgeTimer) clearTimeout(this.dropBadgeTimer);
    this.containerEl.querySelector(".mc-drop-badge")?.remove();

    const pathMod = require("path");
    const badge = document.createElement("div");
    badge.className = "mc-drop-badge";

    const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);

    for (const fp of filePaths) {
      const item = document.createElement("div");
      item.className = "mc-drop-badge-item";

      const ext = pathMod.extname(fp).toLowerCase();
      const basename = pathMod.basename(fp);

      if (IMAGE_EXTS.has(ext)) {
        const thumb = document.createElement("img");
        thumb.className = "mc-drop-badge-thumb";
        thumb.src = `file://${fp}`;
        item.appendChild(thumb);
      }

      const nameEl = document.createElement("span");
      nameEl.className = "mc-drop-badge-name";
      nameEl.textContent = basename;
      item.appendChild(nameEl);

      badge.appendChild(item);
    }

    this.containerEl.appendChild(badge);
    requestAnimationFrame(() => badge.addClass("is-visible"));

    this.dropBadgeTimer = setTimeout(() => {
      badge.removeClass("is-visible");
      setTimeout(() => badge.remove(), 300);
    }, 3000);
  }

  /** Handle a drop event: extract file paths and write them to the shell,
   *  or open the file as a file overlay if wantOpen is true.
   *  @param draggable Obsidian's internal drag info (from dragManager), captured during dragenter */
  private handleDrop(e: DragEvent, wantOpen = false, draggable?: any) {
    const paths: string[] = [];
    const vaultPath = (this.app.vault.adapter as any).basePath as string;
    const pathMod = require("path");

    // 1. Native filesystem files (dragged from Finder, desktop, etc.)
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        const file = e.dataTransfer.files[i];
        if ((file as any).path) {
          paths.push((file as any).path);
        }
      }
    }

    // 2. Files without .path (e.g. macOS screenshot thumbnails, or files from
    //    some apps that don't expose the filesystem path). Save blob to tmp,
    //    then paste that path. Works for any file type, not just images.
    if (paths.length === 0 && e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      const blobFiles: File[] = [];
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        blobFiles.push(e.dataTransfer.files[i]);
      }
      if (blobFiles.length > 0) {
        this.saveDroppedFiles(blobFiles);
        return; // async path handles writing to shell
      }
    }

    // 3. Obsidian internal files (dragged from the file explorer sidebar).
    //    Obsidian sets multiple data types; try them in order of specificity.
    if (paths.length === 0 && e.dataTransfer) {
      let relativePath = "";

      // Obsidian may set the vault-relative path in text/plain
      const plain = e.dataTransfer.getData("text/plain")?.trim();
      if (plain && !plain.startsWith("http") && !plain.startsWith("data:")) {
        relativePath = plain;
      }

      // Also check text/uri-list (Obsidian sometimes uses file:// URIs)
      if (!relativePath) {
        const uriList = e.dataTransfer.getData("text/uri-list")?.trim();
        if (uriList) {
          for (const uri of uriList.split("\n")) {
            const trimmed = uri.trim();
            if (trimmed.startsWith("file://")) {
              try {
                paths.push(decodeURIComponent(trimmed.replace("file://", "")));
              } catch { /* skip malformed URIs */ }
            } else if (trimmed.startsWith("app://")) {
              // Obsidian app:// URIs encode vault-relative paths
              const match = trimmed.match(/app:\/\/[^/]+\/(.+)/);
              if (match) {
                paths.push(pathMod.join(vaultPath, decodeURIComponent(match[1])));
              }
            }
          }
        }
      }

      if (relativePath && paths.length === 0) {
        paths.push(pathMod.join(vaultPath, relativePath));
      }
    }

    // 4. Obsidian internal drag (tab drags, file-explorer drags via dragManager).
    //    dragManager.draggable is set by Obsidian when dragging tabs or files
    //    but doesn't populate the standard dataTransfer with file paths.
    if (paths.length === 0 && draggable) {
      const file = draggable.file ?? draggable.files?.[0];
      if (file instanceof TFile) {
        paths.push(pathMod.join(vaultPath, file.path));
      }
    }

    if (paths.length === 0) return;

    // "Open here" mode: render the file in an overlay, hiding the terminal
    if (wantOpen) {
      this.openFileOverlay(paths[0]);
      return;
    }

    // Shell-escape paths and join with spaces
    const escaped = paths.map((p) => this.shellEscape(p)).join(" ");
    this.process.stdin?.write(escaped);

    // Show confirmation badge
    this.showDropBadge(paths);
  }

  /** Save dropped file blobs to tmp files, then paste paths into the shell.
   *  Works for any file type — images, PDFs, docs, etc. */
  private async saveDroppedFiles(files: File[]) {
    const os = require("os");
    const fs = require("fs");
    const pathMod = require("path");
    const saved: string[] = [];

    for (const file of files) {
      // Derive extension from MIME type or filename
      let ext = "bin";
      if (file.name && file.name.includes(".")) {
        ext = file.name.split(".").pop() || "bin";
      } else if (file.type) {
        ext = file.type.split("/")[1]?.replace("jpeg", "jpg") || "bin";
      }
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const safeName = file.name
        ? file.name.replace(/[^a-zA-Z0-9._-]/g, "_")
        : `drop-${ts}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
      const tmpPath = pathMod.join(os.tmpdir(), safeName);

      try {
        const buf = Buffer.from(await file.arrayBuffer());
        fs.writeFileSync(tmpPath, buf);
        saved.push(tmpPath);
      } catch (err) {
        console.error("[modular-context] failed to save dropped file:", err);
      }
    }

    if (saved.length === 0) return;

    const escaped = saved.map((p: string) => this.shellEscape(p)).join(" ");
    this.process.stdin?.write(escaped);
    this.showDropBadge(saved);
  }

  /** Escape a file path for safe insertion into a shell command */
  private shellEscape(p: string): string {
    if (/^[a-zA-Z0-9_.\/\-]+$/.test(p)) return p;
    return "'" + p.replace(/'/g, "'\\''") + "'";
  }

  captureOutput(): string {
    const sel = this.terminal.getSelection();
    if (sel && sel.trim().length > 0) return sel;
    const buf = this.terminal.buffer.active;
    const lines: string[] = [];
    const start = Math.max(0, buf.length - 50);
    for (let i = start; i < buf.length; i++) {
      const line = buf.getLine(i)?.translateToString(true);
      if (line !== undefined) lines.push(line);
    }
    return lines.join("\n").trimEnd();
  }

  /** Read last N non-empty lines from terminal buffer (oldest first). */
  readTail(count: number): string[] {
    const buf = this.terminal.buffer.active;
    const collected: string[] = [];
    const start = Math.max(0, buf.length - 80);
    for (let i = buf.length - 1; i >= start && collected.length < count; i--) {
      const line = buf.getLine(i)?.translateToString(true)?.trimEnd();
      if (line && line.trim().length > 0) collected.push(line);
    }
    return collected.reverse();
  }

  /** Capture a SessionSnapshot from this session's current state.
   *  Called on view close / plugin unload for the restore picker.
   *  tracker may be null if session was never tracked (plain zsh session). */
  captureSnapshot(tracker: AgentTracker | null): SessionSnapshot {
    const trackedSkill = tracker?.getTracked(this.id)?.skillName;
    return {
      id: this.id,
      name: this.name,
      glyph: this.glyph,
      skillName: this.skillName ?? trackedSkill ?? undefined,
      agentStatus: tracker?.getStatus(this.id),
      claudeSessionId: this.claudeSessionId ?? undefined,
      bufferTail: this.readTail(30),
      cwd: this.cwd ?? undefined,
      lastActivityAt: this._lastStdoutAt || Date.now(),
      archived: false,
      savedAt: Date.now(),
    };
  }

  /** Write a read-only preamble showing the previous session's last output into xterm.
   *  Does NOT send any input to the PTY. Used when materializing a restored session. */
  replayTail(lines: string[]) {
    if (!lines || lines.length === 0) return;
    const dim = "\x1b[2m";
    const reset = "\x1b[0m";
    const header = `${dim}─── previous session tail (read-only) ───${reset}`;
    const footer = `${dim}─── end of tail — fresh shell below ───${reset}`;
    const body = lines.map((l) => `${dim}│${reset} ${l}`).join("\r\n");
    this.terminal.write(`${header}\r\n${body}\r\n${footer}\r\n\r\n`);
  }

  fit() {
    try {
      this.fitAddon.fit();
    } catch {
      // Container may not be visible yet
    }
  }

  focus() {
    // Retry focus until it actually takes (container may not be laid out yet)
    const attempt = (retries: number) => {
      if (this.textareaEl) {
        this.textareaEl.focus({ preventScroll: true });
      } else {
        this.terminal.focus();
      }
      if (document.activeElement !== this.textareaEl && retries > 0) {
        requestAnimationFrame(() => attempt(retries - 1));
      }
    };
    attempt(10);
  }

  show(skipFocus = false) {
    this.containerEl.addClass("is-active");
    requestAnimationFrame(() => {
      this.fit();
      if (!skipFocus) this.focus();
    });
  }

  hide() {
    this.containerEl.removeClass("is-active");
  }

  updateTheme() {
    this.terminal.options.theme = getObsidianTheme();
  }

  addBookmark(label?: string) { this.bookmarkManager?.addBookmark(label); }
  nextBookmark() { this.bookmarkManager?.jumpNext(); }
  prevBookmark() { this.bookmarkManager?.jumpPrev(); }
  clearBookmarks() { this.bookmarkManager?.clearAll(); }

  /** Open a file overlay, hiding the terminal. The file is rendered as
   *  markdown (for .md) or raw text. Close button restores the terminal. */
  openFileOverlay(filePath: string) {
    this.closeFileOverlay();
    this.containerEl.classList.add("has-file-overlay");
    this.fileOverlay = new FileOverlay(this.containerEl, filePath, this.app, () => {
      this.closeFileOverlay();
    });
  }

  closeFileOverlay() {
    if (this.fileOverlay) {
      this.fileOverlay.destroy();
      this.fileOverlay = null;
    }
    this.containerEl.classList.remove("has-file-overlay");
    // Re-fit and focus terminal after revealing it
    requestAnimationFrame(() => {
      this.fit();
      this.focus();
    });
  }

  destroy() {
    // Mark destroyed FIRST so any callback that slips through bails out
    this.destroyed = true;

    // Detach all process listeners BEFORE kill+dispose. process.kill() is
    // async — without this, the exit/data events fire after terminal.dispose()
    // and `terminal.write()` throws on a disposed terminal, crashing Obsidian.
    try { this.process.stdout?.removeAllListeners("data"); } catch {}
    try { this.process.stderr?.removeAllListeners("data"); } catch {}
    try { this.process.removeAllListeners("exit"); } catch {}
    try { this.process.removeAllListeners("error"); } catch {}

    this.bookmarkManager?.destroy();
    this.autocomplete?.destroy();
    if (this.fileOverlay) { this.fileOverlay.destroy(); this.fileOverlay = null; }
    try {
      this.process.kill("SIGTERM");
    } catch {
      // Already dead
    }
    try { this.terminal.dispose(); } catch {}
    this.containerEl.remove();
  }
}

// --- TerminalView ---

class TerminalView extends ItemView {
  sessions: TerminalSession[] = [];
  activeSession: TerminalSession | null = null;
  nextId = 1;
  tabBarEl!: HTMLElement;
  sessionsEl!: HTMLElement;
  sidebarEl!: HTMLElement;
  workingEl!: HTMLElement;
  reviewEl!: HTMLElement;
  resizeObserver: ResizeObserver | null = null;
  fullscreenManager: FullscreenManager | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private isRenaming = false;
  private sidebarTimerInterval: ReturnType<typeof setInterval> | null = null;
  private sidebarPollInterval: ReturnType<typeof setInterval> | null = null;
  /** Periodic snapshot persist — crash-safe restore (not only graceful close). */
  private snapshotInterval: ReturnType<typeof setInterval> | null = null;
  /** Periodic Claude session UUID binder (transcript file ↔ terminal). */
  private claudeBindInterval: ReturnType<typeof setInterval> | null = null;
  tracker: AgentTracker | null = null;
  autoMode = false;
  aiProvider: "claude" | "codex" = "claude";
  /** CLAUDE_CODE_NO_FLICKER — enables alt screen buffer rendering to fix scroll-jump / flicker bugs. */
  antiFlicker = false;
  /** Session IDs already claimed by open terminals (prevents round-robin collisions). */
  private usedSessionIds = new Set<string>();
  private sidebarDirty = true;
  /** @deprecated Use displayMode.layout. Kept until full Iter 10 cleanup. */
  inlineLayout: FullscreenLayout = "single";
  customSkills: SkillDef[] = [];
  standbyEl!: HTMLElement;
  /** Compact sidebar mode — icon-only 48px. Starts expanded (false), not persisted. */
  sidebarCompact = false;

  // --- New unified state (Iter 1) — single source of truth ---
  /** Display mode + layout. Replaces inlineLayout + FullscreenManager.layout. */
  displayMode: DisplayMode = { kind: "inline", layout: "single" };
  /** Parking zone for sessions not currently in any visible pane.
   *  Sessions stay attached to the DOM here so xterm/listeners survive. */
  parkingEl!: HTMLElement;
  /** Reference to active FullscreenManager when fullscreen is open. null otherwise.
   *  Allows renderLayout() to know if it should render into fs.gridEl or sessionsEl. */
  fs: FullscreenManager | null = null;
  /** Persistent pane→session assignment for multi-pane layouts.
   *  paneSlots[i] = session rendered in slot i. Preserved across switchTo()
   *  so swapping sessions replaces the currently FOCUSED slot, not always the last.
   *  Kept in sync by syncPaneSlots(). */
  paneSlots: TerminalSession[] = [];

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Terminal"; }
  getIcon() { return "ros-signet"; }

  getState() {
    return {
      sessions: this.sessions.map((s) => ({ id: s.id, name: s.name, glyph: s.glyph })),
      activeId: this.activeSession?.id ?? null,
      nextId: this.nextId,
      layout: this.displayMode.layout,
    };
  }

  /** Legacy session descriptors stashed by setState — resolved in onOpen against
   *  the saveData snapshots. Used only for migration fallback when plugin was
   *  upgraded from a pre-picker version (snapshots don't exist yet). */
  _pendingLegacySessions: Array<{ id: number; name: string; glyph: string }> | null = null;
  /** Guards against multiple picker invocations if Obsidian calls setState() twice */
  _pickerHandled = false;

  async setState(state: any, result: any) {
    if (state?.sessions?.length > 0) {
      // Do NOT spawn TerminalSession objects here anymore. The restore picker
      // (opened from onOpen) will materialize only user-selected sessions from
      // saveData snapshots. We just stash metadata for migration fallback
      // (pre-picker upgrade: snapshots missing but view state has sessions).
      this._pendingLegacySessions = state.sessions.map((s: any) => ({
        id: s.id,
        name: s.name ?? `zsh ${s.id}`,
        glyph: s.glyph ?? "",
      }));
      this.nextId = state.nextId ?? 1;

      // Restore layout immediately — picker respects it
      if (state.layout) {
        this.displayMode.layout = state.layout as FullscreenLayout;
        this.inlineLayout = state.layout as FullscreenLayout;
      }
    }
    return super.setState(state, result);
  }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("mc-terminal-container");

    // Stop keyboard events from bubbling to Obsidian hotkeys while typing
    container.addEventListener("keydown", (e) => {
      if (!e.metaKey) {
        e.stopPropagation();
      }
    });

    // Capture all wheel/scroll events so Obsidian doesn't intercept them.
    container.addEventListener("wheel", (e) => {
      e.stopPropagation();
    });

    // Click to focus the terminal textarea.
    container.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest(".mc-terminal-sidebar")) return;
      setTimeout(() => this.activeSession?.focus(), 0);
    });

    // Main area: terminal sessions (left)
    this.sessionsEl = container.createDiv({ cls: "mc-terminal-sessions" });

    // Parking zone — sessions live here when not visible in any pane.
    // Stays in DOM so xterm renderer + event listeners remain alive.
    // CSS hides it via display:none.
    this.parkingEl = container.createDiv({ cls: "mc-parking" });

    // Sidebar (right): dashboard + standby + working + to review
    this.sidebarEl = container.createDiv({ cls: "mc-terminal-sidebar" });
    await this.loadCustomSkills();
    this.buildSidebar();

    // Hidden tab bar (still needed for fullscreen manager compatibility)
    this.tabBarEl = document.createElement("div");

    // Resize observer to refit terminals (debounced for smooth dragging).
    // Only active in inline mode — fullscreen has its own resize observer
    // on gridEl, set up by FullscreenManager.enter().
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        if (this.displayMode.kind !== "inline") return;
        for (const s of this.computeVisible(this.displayMode.layout)) s.fit();
      }, 60);
    });
    this.resizeObserver.observe(this.sessionsEl);

    // Fullscreen manager
    this.fullscreenManager = new FullscreenManager(this, {
      setIcon: (el, iconName) => setIcon(el, iconName),
      showContextMenu: (items, ev) => {
        const menu = new Menu();
        for (const it of items) {
          menu.addItem((mi) => {
            mi.setTitle(it.title);
            if (it.icon) mi.setIcon(it.icon);
            mi.onClick(it.onClick);
          });
        }
        menu.showAtMouseEvent(ev);
      },
    });

    // Re-apply terminal theme when Obsidian theme changes
    this.registerEvent(
      this.app.workspace.on("css-change", () => {
        for (const s of this.sessions) s.updateTheme();
      })
    );

    // Smart restore picker: if saveData has snapshots, let user choose which
    // to restore. Otherwise (first run / cleared data) create a default shell.
    await this.handleRestoreFlow();

    // Sidebar timers — render only when dirty, poll every 5s
    this.sidebarTimerInterval = setInterval(() => {
      if (this.sidebarDirty) {
        this.renderSidebarCards();
        this.sidebarDirty = false;
      }
      // Update elapsed time text for working cards (lightweight, no DOM rebuild)
      this.updateWorkingTimers();
    }, 1000);
    this.sidebarPollInterval = setInterval(() => {
      this.tracker?.pollWithSessions(this.sessions);
    }, 5000);

    // Crash-safe persistence: snapshot all sessions every 30s, not only on
    // graceful close. A force-quit/crash now loses at most 30s of metadata.
    this.snapshotInterval = setInterval(() => {
      const plugin = (this as any).plugin as TerminalPlugin | undefined;
      if (!plugin?.persistSnapshots || this.sessions.length === 0) return;
      plugin
        .persistSnapshots(this.sessions, this.tracker, this.currentRestoreLayout())
        .catch((e: unknown) => console.warn("[mc] periodic snapshot failed:", e));
    }, 30000);

    // Bind Claude Code session UUIDs to terminals (enables auto-resume).
    this.claudeBindInterval = setInterval(() => this.bindClaudeSessions(), 15000);
  }

  buildSidebar() {
    this.sidebarEl.empty();
    this.sidebarEl.classList.toggle("is-compact", this.sidebarCompact);

    // --- Toolbar: collapse (left) | info (center) | fullscreen (right) ---
    const toolbar = this.sidebarEl.createDiv({ cls: "mc-sidebar-toolbar" });
    const collapseBtn = toolbar.createDiv({ cls: "mc-sidebar-toolbar-btn" });
    setIcon(collapseBtn, this.sidebarCompact ? "chevron-left" : "chevron-right");
    collapseBtn.title = this.sidebarCompact ? "Expand sidebar" : "Collapse sidebar";
    collapseBtn.addEventListener("click", () => {
      this.sidebarCompact = !this.sidebarCompact;
      this.buildSidebar();
      requestAnimationFrame(() => {
        for (const s of this.computeVisible(this.displayMode.layout)) s.fit();
      });
    });

    if (!this.sidebarCompact) {
      const infoBtn = toolbar.createDiv({ cls: "mc-sidebar-toolbar-btn" });
      setIcon(infoBtn, "info");
      infoBtn.title = "About this plugin";
      infoBtn.addEventListener("click", () => new OnboardingModal(this.app, this).open());

      const flickerBtn = toolbar.createDiv({ cls: "mc-sidebar-toolbar-btn mc-sidebar-flicker-btn" });
      flickerBtn.classList.toggle("is-active", this.antiFlicker);
      setIcon(flickerBtn, this.antiFlicker ? "monitor-check" : "monitor");
      flickerBtn.title = this.antiFlicker
        ? "Anti-flicker ON — CLAUDE_CODE_NO_FLICKER=1 (click to disable)"
        : "Anti-flicker OFF — click to enable fullscreen rendering (fixes scroll jumps)";
      flickerBtn.addEventListener("click", () => this.toggleAntiFlicker());

      const fsBtn = toolbar.createDiv({ cls: "mc-sidebar-toolbar-btn mc-sidebar-fs-btn" });
      this.updateFsIcon();
      fsBtn.addEventListener("click", () => {
        this.fullscreenManager?.toggle();
        this.updateFsIcon();
      });
    }

    if (this.sidebarCompact) {
      this.buildCompactSidebar();
      return;
    }

    // --- EXPANDED MODE ---

    // --- Layout controls (5 main layouts, one row) ---
    const layoutSection = this.sidebarEl.createDiv({ cls: "mc-sidebar-section" });
    const layoutGroup = layoutSection.createDiv({ cls: "mc-sidebar-layout-group" });
    const layouts: { key: string; label: string; svg: string }[] = [
      { key: "single", label: "Single", svg: '<svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/></svg>' },
      { key: "split-h", label: "Side by side", svg: '<svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/><line x1="6" y1="1" x2="6" y2="11"/></svg>' },
      { key: "split-v", label: "Stacked", svg: '<svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/><line x1="1" y1="6" x2="11" y2="6"/></svg>' },
      { key: "grid", label: "Grid 2×2", svg: '<svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/><line x1="6" y1="1" x2="6" y2="11"/><line x1="1" y1="6" x2="11" y2="6"/></svg>' },
      { key: "grid-12", label: "Grid 3×4", svg: '<svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/><line x1="4" y1="1" x2="4" y2="11"/><line x1="8" y1="1" x2="8" y2="11"/><line x1="1" y1="3.5" x2="11" y2="3.5"/><line x1="1" y1="6" x2="11" y2="6"/><line x1="1" y1="8.5" x2="11" y2="8.5"/></svg>' },
    ];
    for (const l of layouts) {
      const btn = layoutGroup.createEl("button", { cls: "mc-sidebar-layout-btn" });
      btn.innerHTML = l.svg;
      btn.title = l.label;
      if (l.key === this.displayMode.layout) btn.addClass("is-active");
      btn.addEventListener("click", () => {
        if (l.key === "grid-12" && !this.fullscreenManager?.isOpen) {
          this.fullscreenManager?.enter(l.key as any);
          this.updateFsIcon();
        } else {
          this.setLayout(l.key as any);
        }
        layoutGroup.querySelectorAll(".mc-sidebar-layout-btn").forEach((b, i) => {
          b.classList.toggle("is-active", layouts[i].key === l.key);
        });
      });
    }

    // --- Skills section ---
    const dashSection = this.sidebarEl.createDiv({ cls: "mc-sidebar-section" });
    dashSection.createDiv({ cls: "mc-sidebar-section-header", text: "Skills" });

    const allSkills = this.getVisibleSkills();
    const primarySkills = allSkills.filter((s: any) => s.primary);
    const secondarySkills = allSkills.filter((s: any) => !s.primary);
    for (const skill of primarySkills) {
      const btn = dashSection.createDiv({ cls: "mc-sidebar-skill-btn is-primary" });
      btn.title = skill.description;
      const btnIcon = btn.createDiv({ cls: "mc-sidebar-skill-icon" });
      setIcon(btnIcon, this.getSkillIcon(skill.id));
      const btnText = btn.createDiv({ cls: "mc-sidebar-skill-text" });
      btnText.createDiv({ cls: "mc-sidebar-skill-label", text: skill.label });
      btn.addEventListener("click", () => this.launchSkill(skill));
      btn.addEventListener("contextmenu", (e: MouseEvent) => this.showSkillMenu(e, skill));
    }
    const secondaryGrid = dashSection.createDiv({ cls: "mc-sidebar-skill-grid" });
    for (const skill of secondarySkills) {
      const btn = secondaryGrid.createDiv({ cls: "mc-sidebar-skill-btn is-secondary" });
      const btnIcon = btn.createDiv({ cls: "mc-sidebar-skill-icon" });
      setIcon(btnIcon, this.getSkillIcon(skill.id));
      btn.createSpan({ cls: "mc-sidebar-skill-label", text: skill.label });
      btn.addEventListener("click", () => this.launchSkill(skill));
      btn.addEventListener("contextmenu", (e: MouseEvent) => this.showSkillMenu(e, skill));
    }
    const addBtn = secondaryGrid.createDiv({ cls: "mc-sidebar-skill-btn is-secondary mc-sidebar-add-skill" });
    addBtn.createSpan({ text: "+" });
    addBtn.addEventListener("click", () => {
      this.showAddSkillInput(secondaryGrid, addBtn);
    });
    const libraryBtn = secondaryGrid.createDiv({ cls: "mc-sidebar-skill-btn is-secondary mc-sidebar-library-btn" });
    const libIcon = libraryBtn.createDiv({ cls: "mc-sidebar-skill-icon" });
    setIcon(libIcon, "package");
    libraryBtn.createSpan({ cls: "mc-sidebar-skill-label", text: "Library" });
    libraryBtn.addEventListener("click", () => {
      new SkillMarketplaceModal(this.app, this).open();
    });
    const hiddenIds = (this as any).hiddenSkills ?? [];
    if (hiddenIds.length > 0) {
      const hiddenToggle = dashSection.createDiv({ cls: "mc-sidebar-hidden-toggle" });
      hiddenToggle.createSpan({ text: `show ${hiddenIds.length} hidden` });
      let expanded = false;
      const hiddenList = dashSection.createDiv({ cls: "mc-sidebar-hidden-list" });
      hiddenList.style.display = "none";
      hiddenToggle.addEventListener("click", () => {
        expanded = !expanded;
        hiddenList.style.display = expanded ? "" : "none";
        (hiddenToggle.querySelector("span") as HTMLElement).textContent = expanded ? `hide ${hiddenIds.length} hidden` : `show ${hiddenIds.length} hidden`;
      });
      for (const id of hiddenIds) {
        const def = SKILLS.find((s) => s.id === id);
        const cust = this.customSkills.find((s) => s.id === id);
        const label = def?.label ?? cust?.label ?? id;
        const row = hiddenList.createDiv({ cls: "mc-sidebar-hidden-row" });
        row.createSpan({ text: label, cls: "mc-sidebar-hidden-name" });
        const restoreLink = row.createSpan({ text: "restore", cls: "mc-sidebar-hidden-restore" });
        restoreLink.addEventListener("click", (e: MouseEvent) => {
          e.stopPropagation();
          (this as any).hiddenSkills = (this as any).hiddenSkills.filter((h: string) => h !== id);
          this.saveCustomSkills();
          this.buildSidebar();
        });
      }
    }
    // --- BOTTOM SECTION: pinned to bottom via spacer ---
    const spacer = this.sidebarEl.createDiv({ cls: "mc-sidebar-spacer" });

    // Standby (top of bottom group)
    const standbySection = this.sidebarEl.createDiv({ cls: "mc-sidebar-section" });
    standbySection.createDiv({ cls: "mc-sidebar-section-header", text: "Standby" });
    this.standbyEl = standbySection.createDiv({ cls: "mc-sidebar-cards" });

    // To Review
    const revSection = this.sidebarEl.createDiv({ cls: "mc-sidebar-section" });
    revSection.createDiv({ cls: "mc-sidebar-section-header", text: "To Review" });
    this.reviewEl = revSection.createDiv({ cls: "mc-sidebar-cards" });

    // Working
    const workSection = this.sidebarEl.createDiv({ cls: "mc-sidebar-section" });
    workSection.createDiv({ cls: "mc-sidebar-section-header", text: "Working" });
    this.workingEl = workSection.createDiv({ cls: "mc-sidebar-cards" });

    // + New + Auto-mode (bottom row)
    const bottomRow = this.sidebarEl.createDiv({ cls: "mc-sidebar-bottom-row" });
    const newBtn = bottomRow.createDiv({ cls: "mc-sidebar-new-session-btn" });
    const newBtnIcon = newBtn.createDiv({ cls: "mc-sidebar-new-session-icon" });
    setIcon(newBtnIcon, "plus");
    newBtn.createSpan({ text: "New" });
    newBtn.addEventListener("click", () => this.createSession());

    const autoRow = bottomRow.createDiv({ cls: "mc-sidebar-auto-mode" });
    const checkbox = autoRow.createEl("input", { type: "checkbox" }) as HTMLInputElement;
    checkbox.checked = this.autoMode;
    checkbox.addEventListener("change", () => {
      this.autoMode = checkbox.checked;
      this.saveCustomSkills();
    });
    autoRow.createSpan({ text: "Auto", cls: "mc-sidebar-auto-label" });

    // Footer: ROS logo centered
    const footer = this.sidebarEl.createDiv({ cls: "mc-sidebar-footer" });
    footer.createDiv({ cls: "mc-sidebar-footer-divider" });
    const logo = footer.createDiv({ cls: "mc-sidebar-logo" });
    setIcon(logo, "ros-signet");
    logo.title = "ReceptionOS";
    logo.addEventListener("click", () => window.open("https://www.linkedin.com/company/receptionos/", "_blank"));

    this.renderSidebarCards();
  }

  private showAddSkillInput(container: HTMLElement, addBtn: HTMLElement) {
    addBtn.style.display = "none";
    const inputWrap = container.createDiv({ cls: "mc-sidebar-skill-input-wrap" });
    const input = inputWrap.createEl("input", { type: "text", placeholder: "/skill-name" }) as HTMLInputElement;
    input.className = "mc-sidebar-skill-input";

    let finished = false;
    const finish = (save: boolean) => {
      if (finished) return;
      finished = true;
      if (save && input.value.trim()) {
        let id = input.value.trim();
        if (id.startsWith("/")) id = id.slice(1);
        if (id && !this.customSkills.find((s) => s.id === id) && !SKILLS.find((s) => s.id === id)) {
          this.customSkills.push({ id, label: id, description: "" });
          this.saveCustomSkills();
        }
      }
      inputWrap.remove();
      addBtn.style.display = "";
      this.buildSidebar();
    };

    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    input.focus();
  }

  async saveCustomSkills() {
    const src = (this as any).plugin ?? (this.app as any).plugins?.plugins?.["modular-context"];
    if (!src) return;
    const pluginData = await src.loadData() ?? {};
    pluginData.customSkills = this.customSkills;
    pluginData.hiddenSkills = (this as any).hiddenSkills ?? [];
    pluginData.skillConfig = (this as any).skillConfig ?? {};
    pluginData.autoMode = this.autoMode ?? false;
    pluginData.aiProvider = this.aiProvider ?? "claude";
    pluginData.antiFlicker = this.antiFlicker ?? false;
    pluginData.layout = this.displayMode.layout;
    await src.saveData(pluginData);
  }

  async loadCustomSkills() {
    const src = (this as any).plugin ?? (this.app as any).plugins?.plugins?.["modular-context"];
    if (!src) return;
    const pluginData = await src.loadData() ?? {};
    this.customSkills = pluginData.customSkills ?? [];
    (this as any).hiddenSkills = pluginData.hiddenSkills ?? [];
    (this as any).skillConfig = pluginData.skillConfig ?? {};
    this.autoMode = pluginData.autoMode ?? false;
    this.aiProvider = pluginData.aiProvider ?? "claude";
    this.antiFlicker = pluginData.antiFlicker ?? false;
    this.displayMode.layout = pluginData.layout ?? "single";
    this.inlineLayout = this.displayMode.layout; // legacy mirror
    (this as any).maxSessions = pluginData.maxSessions ?? 12;
  }

  private getVisibleSkills(): any[] {
    const hidden = new Set((this as any).hiddenSkills ?? []);
    const cfg = (this as any).skillConfig ?? {};
    const builtIn = SKILLS.filter((s) => !hidden.has(s.id)).map((s) => ({ ...s, ...(cfg[s.id] ?? {}), builtIn: true }));
    const custom = (this.customSkills ?? []).filter((s) => !hidden.has(s.id)).map((s) => ({ ...s, builtIn: false }));
    return [...builtIn, ...custom];
  }

  private showSkillMenu(e: MouseEvent, skill: any) {
    e.preventDefault();
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("Edit").setIcon("pencil").onClick(() => this.showSkillEditModal(skill)));
    menu.addItem((item) => item
      .setTitle(skill.primary ? "Move to secondary" : "Move to primary")
      .setIcon(skill.primary ? "arrow-down" : "arrow-up")
      .onClick(() => {
        if (skill.builtIn) {
          const cfg = (this as any).skillConfig;
          cfg[skill.id] = { ...(cfg[skill.id] ?? {}), primary: !skill.primary };
        } else {
          const cs = this.customSkills.find((s) => s.id === skill.id);
          if (cs) (cs as any).primary = !(cs as any).primary;
        }
        this.saveCustomSkills();
        this.buildSidebar();
      })
    );
    menu.addItem((item) => item.setTitle("Hide").setIcon("eye-off").onClick(() => {
      (this as any).hiddenSkills = [...((this as any).hiddenSkills ?? []), skill.id];
      this.saveCustomSkills();
      this.buildSidebar();
    }));
    if (!skill.builtIn) {
      menu.addSeparator();
      menu.addItem((item) => item.setTitle("Remove").setIcon("trash-2").onClick(() => {
        this.customSkills = this.customSkills.filter((s) => s.id !== skill.id);
        this.saveCustomSkills();
        this.buildSidebar();
      }));
    }
    if (skill.builtIn && (this as any).skillConfig[skill.id]) {
      menu.addSeparator();
      menu.addItem((item) => item.setTitle("Reset to default").setIcon("rotate-ccw").onClick(() => {
        delete (this as any).skillConfig[skill.id];
        (this as any).hiddenSkills = ((this as any).hiddenSkills ?? []).filter((id: string) => id !== skill.id);
        this.saveCustomSkills();
        this.buildSidebar();
      }));
    }
    menu.showAtMouseEvent(e);
  }

  private showSkillEditModal(skill: any) {
    const editModal = new Modal(this.app);
    editModal.titleEl.setText("Edit Skill");
    const form = editModal.contentEl.createDiv({ cls: "mc-skill-edit-form" });
    form.createEl("label", { text: "Skill ID", cls: "mc-skill-edit-label" });
    form.createEl("div", { text: "/" + skill.id, cls: "mc-skill-edit-id" });
    form.createEl("label", { text: "Label", cls: "mc-skill-edit-label" });
    const labelInput = form.createEl("input", { type: "text" }) as HTMLInputElement;
    labelInput.value = skill.label;
    labelInput.className = "mc-skill-edit-input";
    form.createEl("label", { text: "Description", cls: "mc-skill-edit-label" });
    const descInput = form.createEl("input", { type: "text" }) as HTMLInputElement;
    descInput.value = skill.description || "";
    descInput.className = "mc-skill-edit-input";
    const btnRow = form.createDiv({ cls: "mc-skill-edit-actions" });
    const saveBtn = btnRow.createEl("button", { text: "Save", cls: "mod-cta" });
    saveBtn.addEventListener("click", () => {
      const newLabel = labelInput.value.trim() || skill.id;
      const newDesc = descInput.value.trim();
      if (skill.builtIn) {
        const cfg = (this as any).skillConfig;
        cfg[skill.id] = { ...(cfg[skill.id] ?? {}), label: newLabel, description: newDesc };
      } else {
        const cs = this.customSkills.find((s) => s.id === skill.id);
        if (cs) { cs.label = newLabel; cs.description = newDesc; }
      }
      this.saveCustomSkills();
      this.buildSidebar();
      editModal.close();
    });
    editModal.open();
    labelInput.focus();
  }

  /** Keep the fullscreen toggle button icon in sync with actual state.
   *  Called from buildSidebar, toggle click, enter(), and exit(). */
  /** Build the compact (icon-only) sidebar variant. */
  private buildCompactSidebar() {
    // --- TOP: Layout controls (vertical) + fullscreen ---
    const layoutArea = this.sidebarEl.createDiv({ cls: "mc-compact-layouts" });
    const layouts: { key: string; label: string; svg: string }[] = [
      { key: "single", label: "Single", svg: '<svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/></svg>' },
      { key: "split-h", label: "Side by side", svg: '<svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/><line x1="6" y1="1" x2="6" y2="11"/></svg>' },
      { key: "split-v", label: "Stacked", svg: '<svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/><line x1="1" y1="6" x2="11" y2="6"/></svg>' },
      { key: "grid", label: "Grid 2×2", svg: '<svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/><line x1="6" y1="1" x2="6" y2="11"/><line x1="1" y1="6" x2="11" y2="6"/></svg>' },
      { key: "grid-12", label: "Grid 3×4", svg: '<svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/><line x1="4" y1="1" x2="4" y2="11"/><line x1="8" y1="1" x2="8" y2="11"/><line x1="1" y1="3.5" x2="11" y2="3.5"/><line x1="1" y1="6" x2="11" y2="6"/><line x1="1" y1="8.5" x2="11" y2="8.5"/></svg>' },
    ];
    for (const l of layouts) {
      const btn = layoutArea.createEl("button", { cls: "mc-compact-layout-btn" });
      btn.innerHTML = l.svg;
      btn.title = l.label;
      if (l.key === this.displayMode.layout) btn.addClass("is-active");
      btn.addEventListener("click", () => {
        if (l.key === "grid-12" && !this.fullscreenManager?.isOpen) {
          this.fullscreenManager?.enter(l.key as any);
          this.updateFsIcon();
        } else {
          this.setLayout(l.key as any);
        }
        layoutArea.querySelectorAll(".mc-compact-layout-btn").forEach((b, i) => {
          b.classList.toggle("is-active", layouts[i].key === l.key);
        });
      });
    }
    const fsBtn = layoutArea.createEl("button", { cls: "mc-compact-layout-btn mc-sidebar-fs-btn" });
    this.updateFsIcon();
    fsBtn.addEventListener("click", () => {
      this.fullscreenManager?.toggle();
      this.updateFsIcon();
    });

    // Divider
    this.sidebarEl.createDiv({ cls: "mc-compact-divider" });

    // --- Skills: top 4 primary as icon buttons ---
    const skillsArea = this.sidebarEl.createDiv({ cls: "mc-compact-skills" });
    const allSkills = this.getVisibleSkills();
    const primarySkills = allSkills.filter((s: any) => s.primary).slice(0, 4);
    for (const skill of primarySkills) {
      const btn = skillsArea.createDiv({ cls: "mc-compact-icon-btn" });
      setIcon(btn, this.getSkillIcon(skill.id));
      btn.title = skill.label;
      btn.addEventListener("click", () => this.launchSkill(skill));
      btn.addEventListener("contextmenu", (e: MouseEvent) => this.showSkillMenu(e, skill));
    }
    const infoBtn = skillsArea.createDiv({ cls: "mc-compact-icon-btn" });
    setIcon(infoBtn, "info");
    infoBtn.title = "About this plugin";
    infoBtn.addEventListener("click", () => new OnboardingModal(this.app, this).open());

    // --- SPACER: pushes sessions + new to bottom ---
    this.sidebarEl.createDiv({ cls: "mc-sidebar-spacer" });

    // --- Sessions: glyph icons (bottom-anchored) ---
    const sessionsArea = this.sidebarEl.createDiv({ cls: "mc-compact-sessions" });
    this.standbyEl = sessionsArea;
    this.workingEl = sessionsArea;
    this.reviewEl = sessionsArea;

    // "+" new session button (very bottom)
    const newBtn = this.sidebarEl.createDiv({ cls: "mc-compact-icon-btn mc-compact-new" });
    setIcon(newBtn, "plus");
    newBtn.title = "New session";
    newBtn.addEventListener("click", () => this.createSession());

    this.renderSidebarCards();
  }

  updateFsIcon() {
    const btn = this.sidebarEl?.querySelector(".mc-sidebar-fs-btn") as HTMLElement | null;
    if (!btn) return;
    const isFs = this.fullscreenManager?.isOpen ?? false;
    btn.empty();
    setIcon(btn, isFs ? "minimize-2" : "maximize-2");
    btn.title = isFs ? "Exit fullscreen" : "Fullscreen";
  }

  renderSidebarCards() {
    this.sidebarDirty = true;
    if (this.isRenaming) return;
    if (!this.standbyEl || !this.workingEl || !this.reviewEl) return;
    const savedScroll = this.sidebarEl?.scrollTop ?? 0;

    // --- Compact mode: unified glyph list ---
    if (this.sidebarCompact) {
      this.standbyEl.empty();
      // Insert glyph icons BEFORE the "+" button
      const newBtnEl = this.standbyEl.querySelector(".mc-compact-new");
      for (const session of this.sessions) {
        const tracked = this.tracker?.tracked.find((t) => t.sessionId === session.id);
        const isWorking = tracked && tracked.status === "working";

        const btn = document.createElement("div");
        btn.className = "mc-compact-icon-btn mc-compact-session";
        if (session === this.activeSession) btn.classList.add("is-active");
        if (isWorking) btn.classList.add("is-working");
        btn.title = session.name;
        btn.dataset.sessionId = String(session.id);

        // Render glyph
        if (session.glyph.startsWith("skill:")) {
          setIcon(btn, this.getSkillIcon(session.glyph.slice(6)));
        } else {
          const g = SESSION_GLYPHS.find((g) => g.id === session.glyph);
          btn.innerHTML = g?.svg ?? SESSION_GLYPHS[0].svg;
        }

        btn.addEventListener("click", () => this.switchTo(session));
        btn.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const menu = new Menu();
          menu.addItem((item) => item.setTitle("Close").setIcon("x").onClick(() => this.closeSession(session)));
          menu.showAtMouseEvent(e);
        });

        if (newBtnEl) this.standbyEl.insertBefore(btn, newBtnEl);
        else this.standbyEl.appendChild(btn);
      }
      if (this.sidebarEl) this.sidebarEl.scrollTop = savedScroll;
      return;
    }

    // --- EXPANDED MODE ---

    // --- Standby: sessions without active tracking (regular terminals + dismissed) ---
    this.standbyEl.empty();
    for (const session of this.sessions) {
      const tracked = this.tracker?.tracked.find((t) => t.sessionId === session.id);
      // Only show untracked or dismissed sessions in Standby
      if (tracked && tracked.status !== "dismissed") continue;

      const card = this.standbyEl.createDiv({ cls: "mc-sidebar-card" });
      if (session === this.activeSession) card.addClass("is-active");
      const cardHeader = card.createDiv({ cls: "mc-sidebar-card-header" });
      // Glyph icon before name
      const glyphEl = cardHeader.createDiv({ cls: "mc-sidebar-card-glyph" });
      if (session.glyph.startsWith("skill:")) {
        setIcon(glyphEl, this.getSkillIcon(session.glyph.slice(6)));
      } else {
        const g = SESSION_GLYPHS.find((g) => g.id === session.glyph);
        glyphEl.innerHTML = g?.svg ?? SESSION_GLYPHS[0].svg;
      }
      cardHeader.createSpan({ cls: "mc-sidebar-card-name", text: session.name });
      if (this.sessions.length > 1) {
        const closeBtn = cardHeader.createDiv({ cls: "mc-sidebar-card-close" });
        setIcon(closeBtn, "x");
        closeBtn.title = "Close";
        closeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.closeSession(session);
        });
      }

      card.addEventListener("click", () => this.switchTo(session));
      card.dataset.sessionId = String(session.id);
      card.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.isRenaming = true; // block re-renders while menu is open
        const menu = new Menu();
        menu.addItem((item) =>
          item.setTitle("Rename").setIcon("pencil").onClick(() => {
            // Find fresh card from DOM (the 1s interval may have replaced it)
            const freshCard = this.standbyEl?.querySelector(`[data-session-id="${session.id}"]`) as HTMLElement;
            if (freshCard) {
              this.startSidebarRename(freshCard, session);
            } else {
              this.isRenaming = false;
            }
          })
        );
        menu.addItem((item) =>
          item.setTitle("Close").setIcon("x").onClick(() => {
            this.isRenaming = false;
            this.closeSession(session);
          })
        );
        (menu as any).onHide?.(() => {
          // If menu was closed without picking an item, unblock re-renders
          setTimeout(() => {
            if (this.isRenaming && !this.standbyEl?.querySelector(".mc-sidebar-rename-input")) {
              this.isRenaming = false;
            }
          }, 100);
        });
        menu.showAtMouseEvent(e);
      });
    }

    // --- Working: tracked sessions with status "working" ---
    this.workingEl.empty();
    const working = this.tracker?.getWorking() ?? [];
    for (const t of working) {
      const session = this.sessions.find((s) => s.id === t.sessionId);
      if (!session) continue;

      const card = this.workingEl.createDiv({ cls: "mc-sidebar-card" });
      if (session === this.activeSession) card.addClass("is-active");
      const cardHeader = card.createDiv({ cls: "mc-sidebar-card-header" });
      // Glyph icon before name
      const wGlyphEl = cardHeader.createDiv({ cls: "mc-sidebar-card-glyph is-working" });
      if (session.glyph.startsWith("skill:")) {
        setIcon(wGlyphEl, this.getSkillIcon(session.glyph.slice(6)));
      } else {
        const g = SESSION_GLYPHS.find((g) => g.id === session.glyph);
        wGlyphEl.innerHTML = g?.svg ?? SESSION_GLYPHS[0].svg;
      }
      cardHeader.createSpan({ cls: "mc-sidebar-card-name", text: session.name });
      const elapsed = this.formatElapsed(Date.now() - t.startedAt);
      cardHeader.createSpan({ cls: "mc-sidebar-card-time", text: elapsed });
      if (this.sessions.length > 1) {
        const closeBtn = cardHeader.createDiv({ cls: "mc-sidebar-card-close" });
        setIcon(closeBtn, "x");
        closeBtn.title = "Close";
        closeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.closeSession(session);
        });
      }

      card.addEventListener("click", () => this.switchTo(session));
      card.dataset.sessionId = String(session.id);
      card.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.isRenaming = true;
        const menu = new Menu();
        menu.addItem((item) =>
          item.setTitle("Rename").setIcon("pencil").onClick(() => {
            const freshCard = this.workingEl?.querySelector(`[data-session-id="${session.id}"]`) as HTMLElement;
            if (freshCard) {
              this.startSidebarRename(freshCard, session);
            } else {
              this.isRenaming = false;
            }
          })
        );
        menu.addItem((item) =>
          item.setTitle("Close").setIcon("x").onClick(() => {
            this.isRenaming = false;
            this.closeSession(session);
          })
        );
        (menu as any).onHide?.(() => {
          setTimeout(() => {
            if (this.isRenaming && !this.workingEl?.querySelector(".mc-sidebar-rename-input")) {
              this.isRenaming = false;
            }
          }, 100);
        });
        menu.showAtMouseEvent(e);
      });
    }

    // --- To Review: tracked sessions with status "to-review" ---
    this.reviewEl.empty();
    const toReview = this.tracker?.getToReview() ?? [];
    for (const t of toReview) {
      const session = this.sessions.find((s) => s.id === t.sessionId);
      const card = this.reviewEl.createDiv({ cls: "mc-sidebar-card is-review" });
      if (session && session === this.activeSession) card.addClass("is-active");
      const cardHeader = card.createDiv({ cls: "mc-sidebar-card-header" });
      // Glyph icon before name (same style as working)
      if (session) {
        const rGlyphEl = cardHeader.createDiv({ cls: "mc-sidebar-card-glyph is-review" });
        if (session.glyph.startsWith("skill:")) {
          setIcon(rGlyphEl, this.getSkillIcon(session.glyph.slice(6)));
        } else {
          const g = SESSION_GLYPHS.find((g) => g.id === session.glyph);
          rGlyphEl.innerHTML = g?.svg ?? SESSION_GLYPHS[0].svg;
        }
      }
      cardHeader.createSpan({
        cls: "mc-sidebar-card-name",
        text: session?.name ?? t.skillName,
      });
      if (this.sessions.length > 1 && session) {
        const closeBtn = cardHeader.createDiv({ cls: "mc-sidebar-card-close" });
        setIcon(closeBtn, "x");
        closeBtn.title = "Close";
        closeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.closeSession(session);
        });
      }

      // Click = mark as reviewed (dismiss) + switch to session
      card.addEventListener("click", () => {
        this.tracker?.dismiss(t.sessionId);
        if (session) this.switchTo(session);
      });
    }
    if (this.sidebarEl) this.sidebarEl.scrollTop = savedScroll;
  }

  private getSkillIcon(skillId: string): string {
    const icons: Record<string, string> = {
      "start-here": "rocket",
      "process-transcripts": "file-text",
      "pulse": "activity",
      "brief": "file-output",
      "log": "book-open",
      "ideas": "lightbulb",
      "reweave": "link",
      "vault-audit": "shield-check",
      "graph": "git-fork",
      "graduate": "graduation-cap",
    };
    return icons[skillId] || "terminal";
  }

  private formatElapsed(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m < 60) return `${m}m ${rs}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

  /** Unified layout setter — works in both inline and fullscreen modes.
   *  Updates displayMode.layout and triggers a full render. */
  setLayout(layout: FullscreenLayout) {
    if (this.displayMode.layout === layout) return;
    this.displayMode.layout = layout;
    // Keep legacy field in sync until Iter 10 cleanup
    this.inlineLayout = layout;
    this.renderLayout();
    this.renderSidebarCards();
    this.saveState();
  }

  /** Lightweight timer update — only touches time text elements, no DOM rebuild */
  private updateWorkingTimers() {
    const working = this.tracker?.getWorking() ?? [];
    const timeEls = this.workingEl?.querySelectorAll(".mc-sidebar-card-time");
    if (!timeEls) return;
    timeEls.forEach((el, i) => {
      if (i < working.length) {
        el.textContent = this.formatElapsed(Date.now() - working[i].startedAt);
      }
    });
  }

  async launchSkill(skill: SkillDef) {
    if (skill.id === "start-here") {
      new OnboardingModal(this.app, this).open();
      return;
    }

    // Auto-provision: install skill from registry if missing
    const plugin = (this as any).plugin as TerminalPlugin | undefined;
    if (plugin?.skillRegistry) {
      const status = await plugin.skillRegistry.getSkillStatus(skill.id);
      if (status === "not-installed") {
        new Notice(`Installing skill: ${skill.label}...`);
        const ok = await plugin.skillRegistry.installSkill(skill.id);
        if (ok) {
          new Notice(`Installed: ${skill.label}`);
        }
      }
    }

    const session = this.createSession(skill.label);
    if (!session) return;
    // Tag session with skill id so snapshot capture can attribute it even
    // after tracker state resets (e.g., after to-review dismissed).
    session.skillName = skill.id;
    // Override glyph with skill icon
    this.assignGlyph(session, skill.id);
    this.tracker?.track(session, skill.id);
    // Skills always launch fresh (no session resume)
    const agentCmd = this.buildAgentCmd();
    setTimeout(() => {
      session.process.stdin?.write(agentCmd + "\r");
    }, 300);
    if (this.aiProvider !== "codex") session._claudeLaunchAt = Date.now();
    // Listen to raw stdout for ❯ prompt — much more reliable than polling terminal buffer
    (session as any)._skillCleanup = sendWhenReady(session.process, `/${skill.id}\r`);
  }

  private startSidebarRename(card: HTMLElement, session: TerminalSession) {
    const nameEl = card.querySelector(".mc-sidebar-card-name") as HTMLElement;
    if (!nameEl) return;
    this.isRenaming = true;

    const input = document.createElement("input");
    input.type = "text";
    input.value = session.name;
    input.className = "mc-sidebar-rename-input";
    input.style.width = `${session.name.length + 2}ch`;
    nameEl.replaceWith(input);

    input.addEventListener("input", () => {
      input.style.width = `${input.value.length + 2}ch`;
    });

    const finish = (save: boolean) => {
      if (!this.isRenaming) return;
      this.isRenaming = false;
      if (save) {
        const name = input.value.trim();
        if (name) {
          session.name = name;
          (session as any)._autoNameLocked = true;
          if ((session as any)._autoNameInterval) {
            clearInterval((session as any)._autoNameInterval);
            (session as any)._autoNameInterval = null;
          }
        }
        if ((session as any)._toolbarNameEl) (session as any)._toolbarNameEl.textContent = name;
      }
      this.renderSidebarCards();
      this.saveState();
    };

    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    input.focus();
    input.select();
  }

  private setupAutoName(session: TerminalSession) {
    if ((session as any)._autoNameLocked) return;
    let done = false;
    const check = () => {
      if (done) return;
      if ((session as any)._autoNameLocked) {
        done = true; clearInterval(interval); return;
      }
      const buf = session.terminal.buffer.active;
      for (let i = buf.length - 1; i >= Math.max(0, buf.length - 40); i--) {
        const line = buf.getLine(i)?.translateToString(true)?.trim();
        if (!line) continue;
        if (/^❯\s+.+/.test(line)) {
          const input = line.replace(/^❯\s+/, "").trim();
          if (!isGoodAutoName(input)) continue;
          done = true;
          clearInterval(interval);
          const newName = input.startsWith("/") ? input.slice(1) : (input.length > 35 ? input.slice(0, 35) + "…" : input);
          session.name = newName;
          if ((session as any)._toolbarNameEl) (session as any)._toolbarNameEl.textContent = newName;
          this.renderSidebarCards();
          this.saveState();
          return;
        }
      }
    };
    const interval = setInterval(check, 2000);
    (session as any)._autoNameInterval = interval;
    setTimeout(() => { if (!done) { clearInterval(interval); done = true; } }, 60000);
  }

  private addSessionToolbar(session: TerminalSession) {
    const bar = document.createElement("div");
    bar.className = "mc-session-toolbar";
    const nameEl = document.createElement("span");
    nameEl.className = "mc-session-toolbar-name";
    nameEl.textContent = session.name;
    nameEl.addEventListener("click", (e) => {
      e.stopPropagation();
      const input = document.createElement("input");
      input.type = "text";
      input.value = session.name;
      input.className = "mc-session-toolbar-rename";
      nameEl.replaceWith(input);
      input.focus();
      input.select();
      const finish = (save: boolean) => {
        if (save) {
          const val = input.value.trim();
          if (val) {
            session.name = val;
            nameEl.textContent = val;
            (session as any)._autoNameLocked = true;
            if ((session as any)._autoNameInterval) {
              clearInterval((session as any)._autoNameInterval);
              (session as any)._autoNameInterval = null;
            }
          }
        }
        input.replaceWith(nameEl);
        this.renderSidebarCards();
        this.saveState();
        setTimeout(() => session.focus(), 0);
      };
      input.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") finish(true);
        if (ev.key === "Escape") finish(false);
      });
      input.addEventListener("blur", () => finish(true));
    });
    bar.appendChild(nameEl);
    const closeBtn = document.createElement("button");
    closeBtn.className = "mc-session-toolbar-close";
    closeBtn.innerHTML = "\u00D7";
    closeBtn.title = "Close session";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeSession(session);
    });
    bar.appendChild(closeBtn);
    session.containerEl.insertBefore(bar, session.containerEl.firstChild);
    (session as any)._toolbarNameEl = nameEl;
  }

  /** Build env overrides for new PTY sessions based on current view settings. */
  private getSessionEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    if (this.antiFlicker) env.CLAUDE_CODE_NO_FLICKER = "1";
    return env;
  }

  /** Toggle anti-flicker mode. New sessions inherit env; running shells receive
   *  an inline export/unset so the next `claude` invocation picks up the change.
   *  (Running Claude TUIs won't re-read env — user must restart `claude` to apply.) */
  private toggleAntiFlicker() {
    this.antiFlicker = !this.antiFlicker;
    const line = this.antiFlicker
      ? `export CLAUDE_CODE_NO_FLICKER=1\r`
      : `unset CLAUDE_CODE_NO_FLICKER\r`;
    for (const s of this.sessions) {
      try {
        s.process?.stdin?.write(line);
      } catch {
        // ignore — closed process
      }
    }
    new Notice(
      this.antiFlicker
        ? "Anti-flicker ON. Restart `claude` in active shells to apply."
        : "Anti-flicker OFF. Restart `claude` in active shells to apply.",
    );
    void this.saveCustomSkills();
    this.buildSidebar();
  }

  createSession(name?: string): TerminalSession | null {
    try {
      const max = (this as any).maxSessions ?? 12;
      if (this.sessions.length >= max) {
        new Notice(`Max ${max} sessions. Close one first.`);
        return null;
      }
      const id = this.nextId++;
      const vaultPath = (this.app.vault.adapter as any).basePath as string;
      // Spawn into parking — renderLayout() will move it into the right pane.
      // No more direct parent = sessionsEl + then immediate reparent by switchTo.
      const session = new TerminalSession(this.parkingEl, id, vaultPath, this.app, {
        env: this.getSessionEnv(),
      });
      if (name) {
        session.name = name;
        (session as any)._autoNameLocked = true;
      }
      this.addSessionToolbar(session);
      this.setupAutoName(session);
      this.sessions.push(session);
      // Assign a visual glyph — skill name for skill-launched, geometric shape for "+"
      this.assignGlyph(session);
      // In multi-pane mode, replace the currently focused slot with the new
      // session (same policy as switchTo), so create-in-split feels consistent
      // with sidebar-click-in-split.
      const slots = SLOT_COUNT[this.displayMode.layout] ?? 1;
      if (slots > 1) {
        this.syncPaneSlots();
        const focusedIdx = this.activeSession
          ? this.paneSlots.indexOf(this.activeSession)
          : -1;
        if (focusedIdx >= 0) {
          this.paneSlots[focusedIdx] = session;
        }
      }
      // I6: focus the new session, but DO NOT auto-flip layout. switchTo()
      // is replaced by direct state mutation + renderLayout() to avoid the
      // legacy auto-split side effect (Iter 6 will simplify switchTo itself).
      this.activeSession = session;
      this.renderLayout();
      this.renderSidebarCards();
      this.saveState();

      // Auto-launch AI agent (fresh session, no history resume).
      // Skip if name was provided (= skill launch, handled by launchSkill).
      if (!name) {
        const cmd = this.buildAgentCmd();
        setTimeout(() => session.process.stdin?.write(cmd + "\r"), 300);
        if (this.aiProvider !== "codex") session._claudeLaunchAt = Date.now();
        // Track as working so it appears in Working section immediately
        this.tracker?.track(session, session.name);
      }

      return session;
    } catch (e) {
      console.error("[mc] createSession error:", e);
      return null;
    }
  }

  saveState() {
    this.app.workspace.requestSaveLayout();
  }

  // --- Claude session binding (auto-resume support) ---

  /** Transcript dir Claude Code uses for a given cwd:
   *  ~/.claude/projects/<cwd with all non-alphanumerics replaced by "-">. */
  private claudeProjectDir(cwd: string): string {
    const path = require("path");
    const os = require("os");
    const munged = cwd.replace(/[^A-Za-z0-9]/g, "-");
    return path.join(os.homedir(), ".claude", "projects", munged);
  }

  /** True if the transcript file for a Claude session still exists on disk. */
  private claudeTranscriptExists(cwd: string, sessionId: string): boolean {
    try {
      const fs = require("fs");
      const path = require("path");
      return fs.existsSync(path.join(this.claudeProjectDir(cwd), `${sessionId}.jsonl`));
    } catch {
      return false;
    }
  }

  /** Bind Claude Code session UUIDs to terminals. For every session where the
   *  plugin typed a `claude` launch command (_claudeLaunchAt set), find the
   *  earliest unclaimed transcript file created after that moment in the
   *  session's project dir and adopt its UUID. Runs on a 15s interval —
   *  heuristic, but launches are plugin-driven and thus timestamped exactly. */
  private bindClaudeSessions() {
    if (this.aiProvider === "codex") return;
    const fs = require("fs");
    const path = require("path");
    const claimed = new Set<string>();
    for (const s of this.sessions) {
      if (s.claudeSessionId) claimed.add(s.claudeSessionId);
    }
    const pending = this.sessions
      .filter((s) => !s.destroyed && s._claudeLaunchAt && s.cwd)
      .sort((a, b) => (a._claudeLaunchAt! - b._claudeLaunchAt!));
    for (const session of pending) {
      const dir = this.claudeProjectDir(session.cwd!);
      let entries: string[] = [];
      try { entries = fs.readdirSync(dir); } catch { continue; }
      let best: { id: string; born: number } | null = null;
      for (const f of entries) {
        if (!f.endsWith(".jsonl")) continue;
        const id = f.slice(0, -".jsonl".length);
        if (claimed.has(id)) continue;
        let st: any;
        try { st = fs.statSync(path.join(dir, f)); } catch { continue; }
        const born = (st.birthtimeMs && st.birthtimeMs > 0) ? st.birthtimeMs : st.ctimeMs;
        // Allow 2s clock slack — transcript may be created just before our stamp
        if (born < session._claudeLaunchAt! - 2000) continue;
        if (!best || born < best.born) best = { id, born };
      }
      if (best) {
        session.claudeSessionId = best.id;
        claimed.add(best.id);
        session._claudeLaunchAt = null;
      } else if (Date.now() - session._claudeLaunchAt! > 10 * 60 * 1000) {
        // Claude never started (or transcript dir unknown) — stop looking
        session._claudeLaunchAt = null;
      }
    }
  }

  /** Snapshot of the current inline layout + slot order for persistence. */
  currentRestoreLayout(): RestoreLayout {
    this.syncPaneSlots();
    return {
      layout: this.displayMode.layout,
      slotIds: this.paneSlots.map((s) => s.id),
      activeId: this.activeSession?.id ?? null,
    };
  }

  // --- Smart restore flow ---

  /** Called from onOpen after all UI containers are set up. Decides whether to
   *  show the RestorePickerModal or just spawn a default shell. */
  private async handleRestoreFlow() {
    if (this._pickerHandled) {
      this.createSession();
      return;
    }
    this._pickerHandled = true;

    const plugin = (this as any).plugin as TerminalPlugin | undefined;
    if (!plugin?.loadSnapshots) {
      this.createSession();
      return;
    }

    const state = await plugin.loadSnapshots();
    const hasSnapshots = state.snapshots.length > 0;
    const hasLegacy = (this._pendingLegacySessions?.length ?? 0) > 0;

    if (!hasSnapshots && !hasLegacy) {
      // Truly fresh install or cleared data
      this.createSession();
      return;
    }

    if (!hasSnapshots && hasLegacy) {
      // Pre-picker upgrade migration: view state has sessions but no snapshots.
      // Spawn minimal restore (no agent auto-write — that's what the user
      // wanted fixed anyway). Sessions are empty fresh PTYs.
      for (const legacy of this._pendingLegacySessions!) {
        if (legacy.id >= this.nextId) this.nextId = legacy.id + 1;
        const vaultPath = (this.app.vault.adapter as any).basePath as string;
        const session = new TerminalSession(this.parkingEl, legacy.id, vaultPath, this.app, {
          env: this.getSessionEnv(),
        });
        session.name = legacy.name;
        session.glyph = legacy.glyph;
        (session as any)._autoNameLocked = true;
        this.addSessionToolbar(session);
        this.sessions.push(session);
        if (!session.glyph) this.assignGlyph(session);
      }
      this.activeSession = this.sessions[0] ?? null;
      this.renderLayout();
      this.renderTabs();
      this._pendingLegacySessions = null;
      return;
    }

    // Snapshots exist → show picker
    let resolved = false;
    const modal = new RestorePickerModal(this.app, state.snapshots, async (result) => {
      resolved = true;
      await this.applyPickerResult(state.snapshots, result, state.layout);
    });
    // Wrap onClose to catch ESC/dismiss case (user bailed without deciding)
    const origClose = modal.onClose.bind(modal);
    modal.onClose = () => {
      origClose();
      setTimeout(() => {
        if (!resolved && this.sessions.length === 0) {
          // User dismissed picker — spawn a default shell so view isn't empty
          this.createSession();
        }
      }, 150);
    };
    modal.open();
  }

  /** Execute picker decisions: materialize restored, archive skipped. */
  private async applyPickerResult(
    allSnapshots: SessionSnapshot[],
    result: PickerResult,
    savedLayout?: RestoreLayout,
  ) {
    const plugin = (this as any).plugin as TerminalPlugin | undefined;

    // Materialize selected snapshots as real sessions
    for (const snap of allSnapshots) {
      if (result.restoreIds.has(snap.id)) {
        this.materializeFromSnapshot(snap);
      }
    }

    // Update archived flags
    if (plugin?.setSnapshotsArchived) {
      const updates: Array<{ id: number; archived: boolean }> = [];
      for (const snap of allSnapshots) {
        updates.push({ id: snap.id, archived: result.archiveIds.has(snap.id) });
      }
      await plugin.setSnapshotsArchived(updates);
    }

    // If nothing was restored, give the user a default shell
    if (this.sessions.length === 0) {
      this.createSession();
    } else {
      // Best-effort layout restore: same split, same slot order, same focus.
      const byId = new Map(this.sessions.map((s) => [s.id, s]));
      if (savedLayout && SLOT_COUNT[savedLayout.layout as FullscreenLayout] !== undefined) {
        this.displayMode = { kind: "inline", layout: savedLayout.layout as FullscreenLayout };
        this.inlineLayout = savedLayout.layout as FullscreenLayout;
        this.paneSlots = savedLayout.slotIds
          .map((id) => byId.get(id))
          .filter((s): s is TerminalSession => !!s);
        this.activeSession =
          (savedLayout.activeId != null ? byId.get(savedLayout.activeId) : undefined)
          ?? this.sessions[0];
      } else {
        this.activeSession = this.sessions[0];
      }
      this.renderLayout();
      this.renderTabs();
      this.renderSidebarCards();
    }
    this._pendingLegacySessions = null;
  }

  /** Create a fresh TerminalSession, write the snapshot's tail as a read-only
   *  preamble, then — if the snapshot carries a Claude session UUID whose
   *  transcript still exists — auto-resume it with `claude -r <id>`. */
  private materializeFromSnapshot(snap: SessionSnapshot): TerminalSession | null {
    try {
      if (snap.id >= this.nextId) this.nextId = snap.id + 1;
      const vaultPath = (this.app.vault.adapter as any).basePath as string;
      const cwd = snap.cwd || vaultPath;
      const session = new TerminalSession(this.parkingEl, snap.id, cwd, this.app, {
        env: this.getSessionEnv(),
      });
      session.name = snap.name || `zsh ${snap.id}`;
      session.glyph = snap.glyph;
      session.skillName = snap.skillName ?? null;
      session.claudeSessionId = snap.claudeSessionId ?? null;
      (session as any)._autoNameLocked = true;
      this.addSessionToolbar(session);
      this.sessions.push(session);
      if (!session.glyph) this.assignGlyph(session);
      // Replay tail once PTY is ready enough to render (~150ms)
      setTimeout(() => {
        session.replayTail(snap.bufferTail);
      }, 150);
      // Auto-resume the Claude session this terminal was running. `claude -r`
      // forks into a NEW session id, so re-arm the binder to adopt it.
      if (
        this.aiProvider !== "codex"
        && snap.claudeSessionId
        && this.claudeTranscriptExists(cwd, snap.claudeSessionId)
      ) {
        const cmd = this.buildAgentCmd(snap.claudeSessionId);
        setTimeout(() => {
          if (session.destroyed) return;
          session.process.stdin?.write(cmd + "\r");
          session._claudeLaunchAt = Date.now();
          this.tracker?.track(session, session.skillName ?? session.name);
        }, 700);
      }
      return session;
    } catch (e) {
      console.error("[mc] materializeFromSnapshot failed:", e);
      return null;
    }
  }

  switchTo(session: TerminalSession) {
    if (!this.sessions.includes(session)) return;
    if (session === this.activeSession) {
      // Already focused — re-focus the input element in case focus was lost
      session.focus();
      return;
    }

    const slots = SLOT_COUNT[this.displayMode.layout] ?? 1;

    if (slots > 1) {
      // Multi-pane: if target is already visible, just move focus (no swap).
      // If not visible, replace the CURRENTLY FOCUSED slot (not always the last).
      this.syncPaneSlots();
      if (!this.paneSlots.includes(session)) {
        const focusedIdx = this.activeSession
          ? this.paneSlots.indexOf(this.activeSession)
          : -1;
        const replaceIdx = focusedIdx >= 0 ? focusedIdx : this.paneSlots.length - 1;
        this.paneSlots[replaceIdx] = session;
      }
    }

    // I6: switchTo only changes focus + re-renders. No auto-split, no
    // direct DOM mutation. renderLayout() is the single source of DOM truth.
    this.activeSession = session;
    this.renderLayout();
    this.renderSidebarCards();
    this.saveState();
  }

  // --- Iter 2: Unified render path ---

  /** Single source of truth for DOM layout. Idempotent. Called after every
   *  state change (close/create/switch/setLayout/enterFs/exitFs).
   *  Reads: this.displayMode, this.activeSession, this.sessions, this.fs
   *  Writes: target.children (panes), parkingEl (parked sessions). */
  renderLayout() {
    const { kind, layout } = this.displayMode;
    const target: HTMLElement = (kind === "fullscreen" && this.fs?.gridEl)
      ? this.fs.gridEl
      : this.sessionsEl;

    // Set data attributes for CSS layout grids
    if (kind === "inline") {
      this.sessionsEl.dataset.mode = "inline";
      this.sessionsEl.dataset.layout = layout;
      // Strip legacy class from old rebuildInlinePanes path (transitional)
      this.sessionsEl.classList.remove("mc-multi-pane");
    }
    if (kind === "fullscreen" && this.fs?.gridEl) {
      this.fs.gridEl.dataset.mode = "fullscreen";
      this.fs.gridEl.dataset.layout = layout;
    }

    const visible = this.computeVisible(layout);
    const visibleSet = new Set(visible);

    // 1. Park non-visible sessions in parkingEl (single deterministic place)
    for (const s of this.sessions) {
      if (!visibleSet.has(s)) {
        if (s.containerEl.parentElement !== this.parkingEl) {
          this.parkingEl.appendChild(s.containerEl);
        }
        s.containerEl.classList.remove("is-active");
      }
    }

    // 1b. Clean up empty pane wrappers in the OTHER container (the one we're
    //     not rendering into). This prevents leaks when toggling display mode.
    const legacySelectors = ":scope > .mc-pane, :scope > .mc-inline-pane, :scope > .mc-fullscreen-pane";
    const otherTarget: HTMLElement | null = (kind === "fullscreen")
      ? this.sessionsEl
      : (this.fs?.gridEl ?? null);
    if (otherTarget && otherTarget !== target) {
      const stalePanes = Array.from(otherTarget.querySelectorAll(legacySelectors)) as HTMLElement[];
      for (const pane of stalePanes) {
        const inner = pane.querySelector(".mc-terminal-session") as HTMLElement | null;
        if (inner) this.parkingEl.appendChild(inner);
        pane.remove();
      }
    }

    // 2. Diff existing .mc-pane wrappers against desired visible[].
    //    If they match in order AND target match, just update focus classes
    //    (avoids reparenting xterm containers which can cause flicker).
    const existingPanes = Array.from(target.querySelectorAll(legacySelectors)) as HTMLElement[];

    const sameSet = existingPanes.length === visible.length
      && existingPanes.every((pane, i) =>
        pane.classList.contains("mc-pane") &&
        pane.dataset.sessionId === String(visible[i].id)
      );

    if (sameSet) {
      // Fast path: just refresh focus class
      for (let i = 0; i < existingPanes.length; i++) {
        existingPanes[i].classList.toggle("is-focused", visible[i] === this.activeSession);
      }
    } else {
      // Slow path: rebuild panes from scratch
      for (const pane of existingPanes) {
        const inner = pane.querySelector(".mc-terminal-session") as HTMLElement | null;
        if (inner) this.parkingEl.appendChild(inner);
        pane.remove();
      }

      for (const session of visible) {
        const pane = document.createElement("div");
        pane.className = "mc-pane";
        pane.dataset.sessionId = String(session.id);
        if (session === this.activeSession) pane.classList.add("is-focused");

        session.containerEl.style.display = "";
        session.containerEl.classList.add("is-active");
        pane.appendChild(session.containerEl);

        pane.addEventListener("mousedown", () => {
          if (this.activeSession !== session) {
            this.switchTo(session);
          } else {
            session.focus();
          }
        });

        target.appendChild(pane);
      }
    }

    // 4. Fit + focus after layout settles. Skip destroyed sessions in case
    //    closeSession ran between this frame and the next (race safety).
    requestAnimationFrame(() => {
      for (const s of visible) {
        if (s.destroyed) continue;
        s.fit();
      }
      if (this.activeSession && !this.activeSession.destroyed && visibleSet.has(this.activeSession)) {
        this.activeSession.focus();
      }
    });

    // 5. Re-render fullscreen tabs if FS is active
    if (kind === "fullscreen") this.fs?.renderFsTabs();
  }

  // --- Iter 1: Helpers for new bulletproof flow (not yet wired) ---

  /** Pick a neighbor session to focus when `closing` is being removed.
   *  Strategy: prefer the next session in the array, fall back to previous,
   *  null if `closing` was the only session. */
  pickNeighbor(closing: TerminalSession): TerminalSession | null {
    const idx = this.sessions.indexOf(closing);
    if (idx < 0) return this.activeSession;
    if (idx + 1 < this.sessions.length) return this.sessions[idx + 1];
    if (idx - 1 >= 0) return this.sessions[idx - 1];
    return null;
  }

  /** Reconcile this.paneSlots with the current layout's slot count and
   *  sessions list. Preserves existing assignments where possible so swapping
   *  focus doesn't reshuffle panes. Called from computeVisible() and switchTo(). */
  syncPaneSlots() {
    const slots = SLOT_COUNT[this.displayMode.layout] ?? 1;
    // 1. Drop destroyed/removed sessions
    this.paneSlots = this.paneSlots.filter((s) => this.sessions.includes(s));
    // 2. Trim if shrinking — but ensure focused stays visible (invariant I4)
    if (this.paneSlots.length > slots) {
      const focused = this.activeSession;
      this.paneSlots = this.paneSlots.slice(0, slots);
      if (focused && this.sessions.includes(focused) && !this.paneSlots.includes(focused)) {
        this.paneSlots[slots - 1] = focused;
      }
    }
    // 3. Fill empty slots with unused sessions (stable order from this.sessions)
    if (this.paneSlots.length < slots) {
      for (const s of this.sessions) {
        if (this.paneSlots.length >= slots) break;
        if (!this.paneSlots.includes(s)) this.paneSlots.push(s);
      }
    }
  }

  /** Compute which sessions should be visible for the given layout.
   *  Invariant I4: focused session MUST be in the result if it exists in `sessions`.
   *  For multi-pane: reads persistent this.paneSlots so focus changes don't
   *  reshuffle panes and swaps target the focused slot (set by switchTo). */
  computeVisible(layout: FullscreenLayout): TerminalSession[] {
    const all = this.sessions;
    if (all.length === 0) return [];
    const slots = SLOT_COUNT[layout] ?? 1;
    // Defensive: if activeSession is stale (not in sessions), fall back to first
    const focused = (this.activeSession && all.includes(this.activeSession))
      ? this.activeSession
      : all[0];

    if (slots === 1) {
      return [focused];
    }

    // Multi-pane: use persistent paneSlots, synced against current state.
    // Ensures focused is visible (I4) without shuffling other slots.
    this.syncPaneSlots();
    if (!this.paneSlots.includes(focused)) {
      // Focused isn't in any slot — place it into the previously-focused slot
      // if we can detect one; otherwise fall back to the last slot.
      const fallbackIdx = this.paneSlots.length - 1;
      this.paneSlots[fallbackIdx >= 0 ? fallbackIdx : 0] = focused;
    }
    return [...this.paneSlots];
  }

  /** Assign a unique glyph to a session. Skill-launched sessions get the skill icon,
   *  manual "+" sessions get the next unused geometric shape. */
  assignGlyph(session: TerminalSession, skillId?: string) {
    if (skillId) {
      session.glyph = `skill:${skillId}`;
      return;
    }
    const usedGlyphs = new Set(this.sessions.map((s) => s.glyph));
    const available = SESSION_GLYPHS.find((g) => !usedGlyphs.has(g.id));
    session.glyph = available?.id ?? SESSION_GLYPHS[session.id % SESSION_GLYPHS.length].id;
  }

  /** Render a session's glyph as HTML (SVG for shapes, Lucide icon name for skills). */
  getGlyphHtml(session: TerminalSession): string {
    if (session.glyph.startsWith("skill:")) {
      const skillId = session.glyph.slice(6);
      const iconName = this.getSkillIcon(skillId);
      // Return empty — caller will use setIcon() with this name
      return iconName;
    }
    const g = SESSION_GLYPHS.find((g) => g.id === session.glyph);
    return g?.svg ?? SESSION_GLYPHS[0].svg;
  }

  // --- Session state memory: round-robin resume ---

  /** Compute the Claude project dir path for session file lookups. */
  private getClaudeProjectDir(): string {
    const vaultPath = (this.app.vault.adapter as any).basePath as string;
    const homedir = require("os").homedir();
    const encoded = vaultPath.replace(/\//g, "-");
    return require("path").join(homedir, ".claude", "projects", encoded);
  }

  /** Find the next unclaimed session ID for round-robin resume.
   *  Returns null if no sessions available (= launch fresh). */
  getNextSessionId(): string | null {
    if (this.aiProvider !== "claude") return null; // Codex uses its own mechanism
    try {
      const fs = require("fs");
      const path = require("path");
      const projectDir = this.getClaudeProjectDir();
      if (!fs.existsSync(projectDir)) return null;

      const files: { id: string; mtime: number }[] = [];
      for (const name of fs.readdirSync(projectDir)) {
        if (!name.endsWith(".jsonl")) continue;
        const id = name.replace(".jsonl", "");
        const stat = fs.statSync(path.join(projectDir, name));
        files.push({ id, mtime: stat.mtimeMs });
      }
      files.sort((a, b) => b.mtime - a.mtime);

      for (const f of files) {
        if (!this.usedSessionIds.has(f.id)) {
          this.usedSessionIds.add(f.id);
          return f.id;
        }
      }
      return null; // All sessions claimed → launch fresh
    } catch {
      return null;
    }
  }

  /** Build the shell command to launch the AI agent. */
  buildAgentCmd(sessionId?: string): string {
    if (this.aiProvider === "codex") {
      let cmd = "codex";
      if (this.autoMode) cmd += " --full-auto";
      if (sessionId) cmd += ` resume ${sessionId}`;
      return cmd;
    }
    // Default: Claude Code
    let cmd = "claude";
    if (this.autoMode) cmd += " --dangerously-skip-permissions";
    if (sessionId) cmd += ` -r ${sessionId}`;
    return cmd;
  }

  closeSession(session: TerminalSession) {
    if ((session as any)._autoNameInterval) clearInterval((session as any)._autoNameInterval);
    if ((session as any)._skillCleanup) (session as any)._skillCleanup();
    // Untrack BEFORE destroy so the tracker can detach its own process listeners
    // while the process reference is still valid.
    this.tracker?.untrack(session);

    // I7: pick neighbor BEFORE destroy so we still have valid index
    const wasFocused = this.activeSession === session;
    const newFocused = wasFocused ? this.pickNeighbor(session) : this.activeSession;

    session.destroy();
    this.sessions = this.sessions.filter((s) => s !== session);
    this.activeSession = newFocused && this.sessions.includes(newFocused)
      ? newFocused
      : (this.sessions[0] ?? null);

    // Single render path — handles both inline and fullscreen targets
    this.renderLayout();
    this.renderSidebarCards();
    this.saveState();
  }

  renderTabs() {
    // Legacy — sidebar replaces tab bar. Only re-render sidebar cards.
    if (this.isRenaming) return;
    this.renderSidebarCards();
  }

  async onClose() {
    // Capture snapshots before destroying PTYs so next reopen can show picker.
    const plugin = (this as any).plugin as TerminalPlugin | undefined;
    if (plugin?.persistSnapshots) {
      try { await plugin.persistSnapshots(this.sessions, this.tracker, this.currentRestoreLayout()); } catch (e) {
        console.error("[mc] persistSnapshots on close failed:", e);
      }
    }
    if (this.sidebarTimerInterval) clearInterval(this.sidebarTimerInterval);
    if (this.sidebarPollInterval) clearInterval(this.sidebarPollInterval);
    if (this.snapshotInterval) clearInterval(this.snapshotInterval);
    if (this.claudeBindInterval) clearInterval(this.claudeBindInterval);
    this.fullscreenManager?.destroy();
    this.fullscreenManager = null;
    this.resizeObserver?.disconnect();
    for (const session of this.sessions) {
      session.destroy();
    }
    this.sessions = [];
    this.activeSession = null;
  }
}

// --- ShortcutsModal ---

class ShortcutsModal extends Modal {
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("mc-shortcuts-modal");
    contentEl.createEl("h3", { text: "Terminal Shortcuts" });

    const shortcuts: [string, string][] = [
      ["Cmd+Shift+S", "Capture output to note"],
      ["Cmd+Shift+M", "Add bookmark"],
      ["Cmd+Shift+]", "Next bookmark"],
      ["Cmd+Shift+[", "Previous bookmark"],
      ["Escape", "Exit fullscreen"],
      ["[[ ...", "Wiki-link autocomplete"],
    ];

    const table = contentEl.createEl("table");
    for (const [key, desc] of shortcuts) {
      const row = table.createEl("tr");
      const keyCell = row.createEl("td");
      keyCell.createEl("kbd", { text: key });
      row.createEl("td", { text: desc });
    }

    contentEl.createEl("p", {
      text: "Open, fullscreen, and tab commands have no default hotkeys. Assign them in Settings > Hotkeys.",
      cls: "mc-shortcuts-hint",
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

// --- RestorePickerModal ---
//
// Shown on plugin open when saveData contains SessionSnapshots from a prior
// run. Classifies each snapshot into Attention / Idle / Archive buckets based
// on agent state + recency + buffer tail heuristics, and lets the user pick
// which ones to restore. Unselected sessions are marked archived (kept for
// future picker openings) — never silently deleted.

type RestoreBucket = "attention" | "idle" | "archive";

interface ClassifiedSnapshot {
  snap: SessionSnapshot;
  bucket: RestoreBucket;
  reason: string;
  score: number;
}

function hasClaudeTuiMarkers(lines: string[]): boolean {
  for (const line of lines) {
    if (/^[╭╰│]/.test(line)) return true;
    if (/^❯\s/.test(line) || /^❯\s*$/.test(line)) return true;
    if (/✻\s/.test(line)) return true;
    if (/Welcome to Claude/.test(line)) return true;
  }
  return false;
}

function classifySnapshot(s: SessionSnapshot): ClassifiedSnapshot {
  const now = Date.now();
  if (s.archived) {
    return { snap: s, bucket: "archive", reason: "Previously skipped", score: 0 };
  }
  if (s.agentStatus === "working") {
    return { snap: s, bucket: "attention", reason: "Agent was working", score: 100 };
  }
  if (s.agentStatus === "to-review") {
    return { snap: s, bucket: "attention", reason: "Awaiting your review", score: 90 };
  }
  const recentLines = s.bufferTail.slice(-8);
  if (hasClaudeTuiMarkers(recentLines)) {
    return { snap: s, bucket: "attention", reason: "Claude session active", score: 70 };
  }
  const ageMs = now - (s.lastActivityAt || 0);
  if (ageMs < 30 * 60 * 1000) {
    return { snap: s, bucket: "attention", reason: "Recent activity", score: 50 };
  }
  return { snap: s, bucket: "idle", reason: "Clean prompt", score: 0 };
}

function formatRelativeTime(epochMs: number): string {
  if (!epochMs) return "unknown";
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

interface PickerResult {
  restoreIds: Set<number>;
  archiveIds: Set<number>;
}

class RestorePickerModal extends Modal {
  private snapshots: SessionSnapshot[];
  private onResolve: (r: PickerResult) => void;
  private selected: Set<number> = new Set();
  private archiveExpanded = false;

  constructor(app: App, snapshots: SessionSnapshot[], onResolve: (r: PickerResult) => void) {
    super(app);
    this.snapshots = snapshots;
    this.onResolve = onResolve;
    // Default: pre-check attention bucket
    for (const s of snapshots) {
      const c = classifySnapshot(s);
      if (c.bucket === "attention") this.selected.add(s.id);
    }
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mc-restore-picker-modal");

    // --- Header ---
    const header = contentEl.createDiv({ cls: "mc-restore-header" });
    header.createEl("h2", { text: "Welcome back" });
    const nonArchived = this.snapshots.filter((s) => !s.archived).length;
    const archivedCount = this.snapshots.length - nonArchived;
    const sub = nonArchived === 0
      ? `No active sessions. ${archivedCount} archived.`
      : `${nonArchived} previous session${nonArchived === 1 ? "" : "s"}. Pick what to continue.`;
    header.createEl("p", { text: sub, cls: "mc-restore-subtitle" });

    // --- Classify + group ---
    const classified = this.snapshots.map(classifySnapshot);
    const attention = classified
      .filter((c) => c.bucket === "attention")
      .sort((a, b) => b.score - a.score || b.snap.lastActivityAt - a.snap.lastActivityAt);
    const idle = classified
      .filter((c) => c.bucket === "idle")
      .sort((a, b) => b.snap.lastActivityAt - a.snap.lastActivityAt);
    const archive = classified
      .filter((c) => c.bucket === "archive")
      .sort((a, b) => b.snap.lastActivityAt - a.snap.lastActivityAt);

    // --- Render buckets ---
    if (attention.length > 0) {
      this.renderBucket(contentEl, "Needs attention", attention, true, "attention");
    }
    if (idle.length > 0) {
      this.renderBucket(contentEl, "Idle", idle, true, "idle");
    }
    if (archive.length > 0) {
      this.renderBucket(contentEl, `Archive (${archive.length})`, archive, false, "archive");
    }

    if (this.snapshots.length === 0) {
      contentEl.createEl("p", {
        text: "No previous sessions. This modal shouldn't appear — opening a fresh shell.",
        cls: "mc-restore-empty",
      });
    }

    // --- Action buttons ---
    const actions = contentEl.createDiv({ cls: "mc-restore-actions" });
    const skipBtn = actions.createEl("button", {
      text: "Skip all",
      cls: "mc-restore-btn mc-restore-btn-secondary",
    });
    skipBtn.addEventListener("click", () => {
      // Nothing selected → archive everything (non-archived); keep archive as-is
      this.confirm();
    });

    const restoreBtn = actions.createEl("button", {
      text: "Restore selected",
      cls: "mc-restore-btn mc-restore-btn-primary",
    });
    restoreBtn.addEventListener("click", () => {
      this.confirm();
    });
  }

  private renderBucket(
    parent: HTMLElement,
    title: string,
    items: ClassifiedSnapshot[],
    expandedDefault: boolean,
    kind: RestoreBucket,
  ) {
    const section = parent.createDiv({ cls: `mc-restore-bucket mc-restore-bucket-${kind}` });
    const headerEl = section.createDiv({ cls: "mc-restore-bucket-header" });
    const chevron = headerEl.createSpan({ cls: "mc-restore-chevron" });
    chevron.textContent = expandedDefault ? "▾" : "▸";
    headerEl.createSpan({ cls: "mc-restore-bucket-title", text: title });
    headerEl.createSpan({ cls: "mc-restore-bucket-count", text: `${items.length}` });

    const body = section.createDiv({ cls: "mc-restore-bucket-body" });
    if (!expandedDefault) body.style.display = "none";

    headerEl.addEventListener("click", () => {
      const isHidden = body.style.display === "none";
      body.style.display = isHidden ? "" : "none";
      chevron.textContent = isHidden ? "▾" : "▸";
      if (kind === "archive") this.archiveExpanded = isHidden;
    });

    for (const c of items) {
      this.renderSnapshotRow(body, c);
    }
  }

  private renderSnapshotRow(parent: HTMLElement, c: ClassifiedSnapshot) {
    const row = parent.createDiv({ cls: "mc-restore-row" });
    if (this.selected.has(c.snap.id)) row.addClass("is-selected");

    // Checkbox
    const checkbox = row.createEl("input", { type: "checkbox" });
    checkbox.checked = this.selected.has(c.snap.id);
    checkbox.addClass("mc-restore-checkbox");
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) this.selected.add(c.snap.id);
      else this.selected.delete(c.snap.id);
      row.toggleClass("is-selected", checkbox.checked);
    });

    // Content column
    const content = row.createDiv({ cls: "mc-restore-row-content" });

    // Top line: glyph + name + reason badge + time
    const topLine = content.createDiv({ cls: "mc-restore-row-top" });
    const glyphEl = topLine.createSpan({ cls: "mc-restore-glyph" });
    glyphEl.textContent = this.renderGlyphChar(c.snap.glyph);
    topLine.createSpan({ cls: "mc-restore-name", text: c.snap.name || `zsh ${c.snap.id}` });
    if (c.snap.skillName && c.snap.skillName !== c.snap.name) {
      topLine.createSpan({ cls: "mc-restore-skill", text: `/${c.snap.skillName}` });
    }
    const badge = topLine.createSpan({ cls: `mc-restore-badge mc-restore-badge-${c.bucket}` });
    badge.textContent = c.reason;
    topLine.createSpan({
      cls: "mc-restore-time",
      text: formatRelativeTime(c.snap.lastActivityAt),
    });

    // Preview: last few tail lines
    const tail = c.snap.bufferTail.slice(-4);
    if (tail.length > 0) {
      const preview = content.createDiv({ cls: "mc-restore-preview" });
      for (const line of tail) {
        const truncated = line.length > 120 ? line.slice(0, 117) + "…" : line;
        preview.createDiv({ cls: "mc-restore-preview-line", text: truncated });
      }
    }

    // Whole row clickable toggles checkbox
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event("change"));
    });
  }

  /** Glyph-to-unicode mapping for picker preview. Falls back to • */
  private renderGlyphChar(glyph: string): string {
    const map: Record<string, string> = {
      "circle": "●",
      "ring": "○",
      "square": "■",
      "square-outline": "□",
      "triangle": "▲",
      "triangle-outline": "△",
      "diamond": "◆",
      "diamond-outline": "◇",
      "hex": "⬢",
      "hex-outline": "⬡",
      "star": "★",
      "cross": "✕",
    };
    return map[glyph] || "•";
  }

  private confirm() {
    const restoreIds = new Set(this.selected);
    const archiveIds = new Set<number>();
    for (const s of this.snapshots) {
      if (!restoreIds.has(s.id)) archiveIds.add(s.id);
    }
    this.onResolve({ restoreIds, archiveIds });
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

// --- OnboardingModal ---

const GOOGLE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/><path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/><path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/><path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/></svg>`;

type OnboardingTabId = "overview" | "accounts" | "skills";

const ONBOARDING_TABS: Array<{ id: OnboardingTabId; label: string; icon: string }> = [
  { id: "overview", label: "Overview", icon: "book-open" },
  { id: "accounts", label: "Accounts", icon: "user-circle-2" },
  { id: "skills", label: "Skills", icon: "sparkles" },
];

class OnboardingModal extends Modal {
  private view: TerminalView;
  private activeTab: OnboardingTabId = "overview";
  private panels: Map<OnboardingTabId, HTMLElement> = new Map();
  private tabButtons: Map<OnboardingTabId, HTMLElement> = new Map();

  constructor(app: App, view: TerminalView) {
    super(app);
    this.view = view;
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    contentEl.addClass("mc-onboarding-modal");
    modalEl.addClass("mc-onboarding-modal-container");

    this.renderHeader(contentEl);

    const body = contentEl.createDiv({ cls: "mc-onboarding-body-wrap" });
    const nav = body.createDiv({ cls: "mc-onboarding-tabs" });
    const content = body.createDiv({ cls: "mc-onboarding-content" });

    this.renderTabNav(nav);
    this.renderProviderDock(nav);
    this.renderAllPanels(content);
    this.switchTab(this.activeTab);
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "mc-onboarding-header" });
    const headerIcon = header.createDiv({ cls: "mc-onboarding-header-icon" });
    setIcon(headerIcon, "ros-signet");
    const headerText = header.createDiv();
    headerText.createEl("h3", { text: "Modular Context" });
    headerText.createEl("p", {
      text: "Your AI-native second brain — structured knowledge base in Obsidian, powered by Claude Code.",
      cls: "mc-onboarding-subtitle",
    });
  }

  private renderTabNav(container: HTMLElement): void {
    for (const tab of ONBOARDING_TABS) {
      const btn = container.createDiv({ cls: "mc-onboarding-tab" });
      const iconWrap = btn.createSpan({ cls: "mc-onboarding-tab-icon" });
      setIcon(iconWrap, tab.icon);
      btn.createSpan({ cls: "mc-onboarding-tab-label", text: tab.label });
      btn.addEventListener("click", () => this.switchTab(tab.id));
      this.tabButtons.set(tab.id, btn);
    }
  }

  private renderAllPanels(container: HTMLElement): void {
    for (const tab of ONBOARDING_TABS) {
      const panel = container.createDiv({ cls: "mc-onboarding-panel" });
      this.panels.set(tab.id, panel);
      switch (tab.id) {
        case "overview":
          this.renderOverviewPanel(panel);
          break;
        case "accounts":
          void this.renderAccountsPanel(panel);
          break;
        case "skills":
          this.renderSkillsPanel(panel);
          break;
      }
    }
  }

  private switchTab(tabId: OnboardingTabId): void {
    this.activeTab = tabId;
    for (const [id, btn] of this.tabButtons) {
      btn.classList.toggle("is-active", id === tabId);
    }
    for (const [id, panel] of this.panels) {
      panel.classList.toggle("is-active", id === tabId);
    }
  }

  // ─────────────────────────── Overview tab ───────────────────────────

  private renderOverviewPanel(container: HTMLElement): void {
    this.renderHowItWorks(container);
    this.renderBuildVault(container);
    this.renderDashboardGuide(container);
    this.renderCTA(container);
  }

  private renderHowItWorks(container: HTMLElement): void {
    container.createEl("h4", { text: "How it works" });
    const steps: [string, string][] = [
      ["Capture", "Record conversations, meetings, ideas — drop raw transcripts into the vault"],
      ["Process", "AI agents categorize, extract insights, and update knowledge modules automatically"],
      ["Connect", "Wiki-links and cross-references build a living knowledge graph across all your projects"],
      ["Act", "Skills turn vault knowledge into deliverables — briefs, audits, strategic pulses, syncs"],
    ];
    const stepsEl = container.createDiv({ cls: "mc-onboarding-steps" });
    steps.forEach(([title, desc], i) => {
      const step = stepsEl.createDiv({ cls: "mc-onboarding-step" });
      step.createDiv({ cls: "mc-onboarding-step-num", text: `${i + 1}` });
      const stepText = step.createDiv({ cls: "mc-onboarding-step-text" });
      stepText.createEl("strong", { text: title });
      stepText.createSpan({ text: ` — ${desc}` });
    });
  }

  private renderBuildVault(container: HTMLElement): void {
    container.createEl("h4", { text: "Build your own vault" });
    const vaultSteps: string[] = [
      "Start with CLAUDE.md — it teaches Claude how to navigate your vault",
      "Create project folders with index files as entry points",
      "Add _transcripts/ for raw material and _culture/ for your principles",
      "Define skills in .claude/skills/ to automate recurring workflows",
      "Use frontmatter (status, updated, depends-on) to keep everything alive",
    ];
    const vaultList = container.createEl("ol", { cls: "mc-onboarding-vault-list" });
    for (const step of vaultSteps) {
      vaultList.createEl("li", { text: step });
    }
  }

  private renderDashboardGuide(container: HTMLElement): void {
    container.createEl("h4", { text: "Dashboard" });
    container.createEl("p", {
      text: "The sidebar is your command center. Primary skills at the top are your daily drivers. Click any skill to launch a Claude Code session that executes it. Working shows running agents. To Review surfaces completed work awaiting your approval.",
      cls: "mc-onboarding-body",
    });
  }

  private renderCTA(container: HTMLElement): void {
    const cta = container.createDiv({ cls: "mc-onboarding-cta" });
    const ctaBtn = cta.createEl("button", {
      cls: "mc-onboarding-cta-btn",
      text: "Start Here →",
    });
    cta.createEl("p", {
      text: "An AI agent will scan your vault and guide you through setting up the modular-context methodology.",
      cls: "mc-onboarding-cta-desc",
    });
    ctaBtn.addEventListener("click", () => {
      this.close();
      this.launchOnboardingAgent();
    });
  }

  // ─────────────────────────── Accounts tab ───────────────────────────

  private async renderAccountsPanel(container: HTMLElement): Promise<void> {
    container.createEl("h4", { text: "Connected accounts" });
    container.createEl("p", {
      text: "Link Google Workspace so Claude Code can read Gmail, create drafts, and manage your calendar — all from inside your vault.",
      cls: "mc-onboarding-body",
    });

    const cardHost = container.createDiv({ cls: "mc-account-card-host" });
    await this.refreshAccountCard(cardHost);
  }

  private async refreshAccountCard(host: HTMLElement): Promise<void> {
    host.empty();
    const gwPlugin = (this.view as any).plugin as TerminalPlugin | undefined;
    if (!gwPlugin) {
      host.createEl("p", {
        text: "Google Workspace integration unavailable in this build.",
        cls: "mc-onboarding-body",
      });
      return;
    }

    const account = await this.loadPrimaryAccount(gwPlugin);
    if (account) {
      this.renderConnectedAccountCard(host, gwPlugin, account);
    } else {
      this.renderDisconnectedAccountCard(host, gwPlugin);
    }
  }

  private async loadPrimaryAccount(
    gwPlugin: TerminalPlugin,
  ): Promise<AccountIndex | null> {
    const storage = gwPlugin.getGoogleStorage() as any;
    const multi = typeof storage.getMulti === "function" ? storage.getMulti() : null;
    if (multi) {
      try {
        const accounts = (await multi.listAccounts()) as AccountIndex[];
        if (accounts.length === 0) return null;
        return accounts.find((a) => a.isPrimary) ?? accounts[0];
      } catch {
        return null;
      }
    }
    // Legacy fallback — synthesize minimal AccountIndex from StoredTokens
    try {
      const tokens = await storage.loadTokens();
      if (!tokens) return null;
      return {
        id: tokens.accountEmail.toLowerCase(),
        email: tokens.accountEmail,
        filename: "",
        scope: tokens.scope,
        connectedAt: new Date().toISOString(),
        isPrimary: true,
      };
    } catch {
      return null;
    }
  }

  private renderConnectedAccountCard(
    host: HTMLElement,
    gwPlugin: TerminalPlugin,
    account: AccountIndex,
  ): void {
    const card = host.createDiv({ cls: "mc-account-card is-connected" });

    const avatar = card.createDiv({ cls: "mc-account-avatar" });
    avatar.innerHTML = GOOGLE_ICON_SVG;

    const body = card.createDiv({ cls: "mc-account-body" });
    const titleRow = body.createDiv({ cls: "mc-account-title-row" });
    titleRow.createEl("strong", { text: "Google Workspace" });

    body.createDiv({ cls: "mc-account-email", text: account.email });

    const status = body.createDiv({ cls: "mc-account-status" });
    status.createSpan({ cls: "mc-account-status-dot" });
    const statusText = status.createSpan({ cls: "mc-account-status-text" });
    const when = account.lastRefreshed ?? account.connectedAt;
    const whenLabel = account.lastRefreshed ? "Last sync" : "Connected";
    statusText.setText(`Connected · ${whenLabel} ${this.formatRelativeTime(when)}`);

    const actions = card.createDiv({ cls: "mc-account-actions" });
    const manageBtn = actions.createEl("button", {
      cls: "mc-account-manage-btn",
      text: "Manage",
    });
    manageBtn.addEventListener("click", () => {
      this.openConnectModal(gwPlugin, host);
    });
  }

  private renderDisconnectedAccountCard(
    host: HTMLElement,
    gwPlugin: TerminalPlugin,
  ): void {
    const card = host.createDiv({ cls: "mc-account-card is-disconnected" });

    const body = card.createDiv({ cls: "mc-account-card-header" });
    const avatar = body.createDiv({ cls: "mc-account-avatar" });
    avatar.innerHTML = GOOGLE_ICON_SVG;
    const text = body.createDiv({ cls: "mc-account-body" });
    text.createEl("strong", { text: "Google Workspace" });
    text.createEl("div", {
      text: "Gmail + Calendar as tools for Claude Code",
      cls: "mc-account-email",
    });

    const connectBtn = card.createEl("button", {
      cls: "mc-oauth-button-google",
      text: "Connect with Google",
    });
    const iconSpan = document.createElement("span");
    iconSpan.className = "mc-oauth-button-google-icon";
    iconSpan.innerHTML = GOOGLE_ICON_SVG;
    connectBtn.prepend(iconSpan);
    connectBtn.addEventListener("click", () => {
      this.openConnectModal(gwPlugin, host);
    });
  }

  private openConnectModal(
    gwPlugin: TerminalPlugin,
    host: HTMLElement,
  ): void {
    const storage = gwPlugin.getGoogleStorage() as any;
    const multi = typeof storage.getMulti === "function" ? storage.getMulti() : null;
    if (!multi) {
      new Notice("Google Workspace: multi-account storage unavailable");
      return;
    }
    new ConnectGoogleModal(this.app, {
      storage,
      multiStorage: multi,
      quickConnect: {
        clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
        clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
      },
      onStateChange: (state) => {
        if (state.kind === "connected") {
          void gwPlugin.syncMcpOnConnect(state.tokens.accountEmail);
          void this.refreshAccountCard(host);
        } else if (state.kind === "disconnected") {
          void gwPlugin.syncMcpOnDisconnect();
          void this.refreshAccountCard(host);
        }
      },
    }).open();
  }

  private formatRelativeTime(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return "recently";
    const diff = Date.now() - then;
    if (diff < 0) return "just now";
    const sec = Math.floor(diff / 1000);
    if (sec < 30) return "just now";
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} min ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 30) return `${day}d ago`;
    const month = Math.floor(day / 30);
    if (month < 12) return `${month}mo ago`;
    const year = Math.floor(day / 365);
    return `${year}y ago`;
  }

  // ─────────────────────────── Skills tab ───────────────────────────

  private renderSkillsPanel(container: HTMLElement): void {
    container.createEl("h4", { text: "Install skills" });
    container.createEl("p", {
      text: "Skills are AI workflows launched from the sidebar. Select which to install:",
      cls: "mc-onboarding-body",
    });

    const selectedSkills = new Set<string>();
    const plugin = (this.view as any).plugin as TerminalPlugin | undefined;

    // Top control bar — master checkbox + install button (pinned, not scrolling)
    const controlBar = container.createDiv({ cls: "mc-onboarding-skill-controls" });
    const masterRow = controlBar.createDiv({ cls: "mc-onboarding-skill-row is-master" });
    const masterCb = masterRow.createEl("input", { type: "checkbox" }) as HTMLInputElement;
    masterCb.id = "mc-skill-master";
    const masterLabel = masterRow.createEl("label");
    masterLabel.htmlFor = "mc-skill-master";
    masterLabel.createEl("strong", { text: "Full Library" });
    masterLabel.createSpan({ text: " — install all" });

    const installBtn = controlBar.createEl("button", {
      cls: "mc-onboarding-install-btn",
      text: "Install Selected",
    });
    const installStatus = controlBar.createSpan({ cls: "mc-onboarding-install-status" });

    // Scrollable skills list
    const pickerEl = container.createDiv({ cls: "mc-onboarding-skill-picker" });
    const skillCheckboxes: HTMLInputElement[] = [];

    const buildPicker = async () => {
      const registry = await plugin?.skillRegistry?.fetchRegistry();
      if (!registry) {
        pickerEl.createEl("p", {
          text: "Could not load skill library. Check your internet connection.",
          cls: "mc-onboarding-error",
        });
        return;
      }

      const categories = new Map<string, RegistrySkill[]>();
      for (const skill of registry.skills) {
        const cat = skill.category;
        if (!categories.has(cat)) categories.set(cat, []);
        categories.get(cat)!.push(skill);
      }

      for (const [category, skills] of categories) {
        const catLabel = category.charAt(0).toUpperCase() + category.slice(1);
        const catHeader = pickerEl.createDiv({ cls: "mc-onboarding-skill-category" });
        catHeader.createSpan({ text: catLabel });

        for (const skill of skills) {
          const row = pickerEl.createDiv({ cls: "mc-onboarding-skill-row" });
          const cb = row.createEl("input", { type: "checkbox" }) as HTMLInputElement;
          cb.id = `mc-skill-${skill.id}`;
          cb.dataset.skillId = skill.id;
          if (skill.primary) {
            cb.checked = true;
            selectedSkills.add(skill.id);
          }
          const label = row.createEl("label");
          label.htmlFor = cb.id;
          label.createEl("strong", { text: skill.label });
          label.createSpan({ text: ` — ${skill.description.split(".")[0]}` });
          label.createSpan({ cls: "mc-onboarding-skill-size", text: skill.size });

          cb.addEventListener("change", () => {
            if (cb.checked) selectedSkills.add(skill.id);
            else selectedSkills.delete(skill.id);
            masterCb.checked = selectedSkills.size === registry.skills.length;
          });

          skillCheckboxes.push(cb);
        }
      }
    };
    void buildPicker();

    masterCb.addEventListener("change", () => {
      for (const cb of skillCheckboxes) {
        cb.checked = masterCb.checked;
        const id = cb.dataset.skillId;
        if (id) {
          if (masterCb.checked) selectedSkills.add(id);
          else selectedSkills.delete(id);
        }
      }
    });

    installBtn.addEventListener("click", async () => {
      if (selectedSkills.size === 0) {
        new Notice("No skills selected.");
        return;
      }
      installBtn.disabled = true;
      installBtn.textContent = "Installing...";
      const ids = [...selectedSkills];
      const count = await plugin?.skillRegistry?.installMultiple(ids, (done, total) => {
        installStatus.textContent = `${done}/${total}`;
      }) ?? 0;
      installBtn.textContent = `Installed ${count} ✓`;
      installStatus.textContent = "";
      new Notice(`Installed ${count} skills.`);
      this.view.buildSidebar();
    });
  }

  // ─────────────────────────── Provider dock (sidebar footer) ───────────────────────────

  private renderProviderDock(container: HTMLElement): void {
    const dock = container.createDiv({ cls: "mc-onboarding-dock" });
    dock.createDiv({ cls: "mc-onboarding-dock-label", text: "AI PROVIDER" });

    const segment = dock.createDiv({ cls: "mc-provider-segment is-compact" });
    const claudeBtn = segment.createEl("button", {
      cls: "mc-provider-segment-btn",
      text: "Claude",
    });
    const codexBtn = segment.createEl("button", {
      cls: "mc-provider-segment-btn",
      text: "Codex",
    });

    const updateActive = () => {
      claudeBtn.classList.toggle("is-active", this.view.aiProvider === "claude");
      codexBtn.classList.toggle("is-active", this.view.aiProvider === "codex");
    };
    updateActive();

    claudeBtn.addEventListener("click", () => {
      this.view.aiProvider = "claude";
      updateActive();
      this.view.saveCustomSkills();
    });
    codexBtn.addEventListener("click", () => {
      this.view.aiProvider = "codex";
      updateActive();
      this.view.saveCustomSkills();
    });
  }

  private launchOnboardingAgent() {
    const view = this.view;
    view.createSession("onboard");
    const session = view.sessions[view.sessions.length - 1];
    if (!session) return;

    view.tracker?.track(session, "onboard");

    const claudeCmd = view.autoMode
      ? `claude --dangerously-skip-permissions\r`
      : `claude\r`;

    // Prompt lives in @mc/shared (skills/onboarding-prompt) — "scan" = plugin mission.
    const onboardPrompt = buildOnboardingPrompt("scan");

    // Wait for shell to be ready, then launch Claude Code
    setTimeout(() => {
      session.process.stdin?.write(claudeCmd);
    }, 300);

    // Listen to raw stdout for ❯ prompt — reliable across TUI modes
    sendWhenReady(session.process, onboardPrompt + `\r`);
  }

  onClose() {
    this.contentEl.empty();
  }
}

// --- OutputCaptureModal ---

interface CaptureOption {
  label: string;
  action: string;
}

class OutputCaptureModal extends SuggestModal<CaptureOption> {
  private capturedText: string;

  constructor(app: App, capturedText: string) {
    super(app);
    this.capturedText = capturedText;
    this.setPlaceholder("Choose where to save terminal output...");
  }

  getSuggestions(): CaptureOption[] {
    return [
      { label: "Today's daily note", action: "daily" },
      { label: "Current open note", action: "current" },
      { label: "New note", action: "new" },
    ];
  }

  renderSuggestion(option: CaptureOption, el: HTMLElement) {
    el.createEl("div", { text: option.label });
  }

  async onChooseSuggestion(option: CaptureOption) {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const block = `\n**Terminal Capture — ${hh}:${mm}**\n\n${this.capturedText}\n`;

    if (option.action === "daily") {
      const yyyy = now.getFullYear();
      const mo = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      const dailyPath = `Daily Notes/${yyyy}-${mo}-${dd}.md`;

      const exists = await this.app.vault.adapter.exists(dailyPath);
      if (exists) {
        await this.app.vault.adapter.append(dailyPath, block);
      } else {
        await this.app.vault.create(dailyPath, block.trimStart());
      }
    } else if (option.action === "current") {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile) {
        await this.app.vault.adapter.append(activeFile.path, block);
      }
    } else if (option.action === "new") {
      const ss = String(now.getSeconds()).padStart(2, "0");
      const yyyy = now.getFullYear();
      const mo = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      const newPath = `Terminal Captures/${yyyy}-${mo}-${dd}-${hh}${mm}${ss}.md`;

      const folderExists = await this.app.vault.adapter.exists("Terminal Captures");
      if (!folderExists) {
        await this.app.vault.createFolder("Terminal Captures");
      }
      await this.app.vault.create(newPath, block.trimStart());
    }
  }
}

// --- Skill Marketplace Modal ---

class SkillMarketplaceModal extends Modal {
  private view: TerminalView;

  constructor(app: App, view: TerminalView) {
    super(app);
    this.view = view;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.addClass("mc-marketplace-modal");

    const header = contentEl.createDiv({ cls: "mc-marketplace-header" });
    header.createEl("h3", { text: "Skill Library" });

    const plugin = (this.view as any).plugin as TerminalPlugin | undefined;
    const registry = await plugin?.skillRegistry?.fetchRegistry();

    if (!registry) {
      contentEl.createEl("p", { text: "Could not load skill library. Check your internet connection." });
      return;
    }

    header.createSpan({ cls: "mc-marketplace-updated", text: `Updated: ${registry.updated}` });

    // Category filter
    const allCategories = [...new Set(registry.skills.map(s => s.category))];
    const filterRow = contentEl.createDiv({ cls: "mc-marketplace-filters" });
    let activeFilter = "all";

    const allBtn = filterRow.createEl("button", { cls: "mc-marketplace-filter is-active", text: "All" });
    allBtn.addEventListener("click", () => { activeFilter = "all"; renderSkills(); setActiveFilter(allBtn); });

    const filterBtns = [allBtn];
    for (const cat of allCategories) {
      const btn = filterRow.createEl("button", {
        cls: "mc-marketplace-filter",
        text: cat.charAt(0).toUpperCase() + cat.slice(1),
      });
      btn.addEventListener("click", () => { activeFilter = cat; renderSkills(); setActiveFilter(btn); });
      filterBtns.push(btn);
    }

    const setActiveFilter = (active: HTMLElement) => {
      filterBtns.forEach(b => b.classList.remove("is-active"));
      active.classList.add("is-active");
    };

    // Skill grid
    const gridEl = contentEl.createDiv({ cls: "mc-marketplace-grid" });

    const renderSkills = async () => {
      gridEl.empty();
      const filtered = activeFilter === "all"
        ? registry.skills
        : registry.skills.filter(s => s.category === activeFilter);

      for (const skill of filtered) {
        const card = gridEl.createDiv({ cls: "mc-marketplace-card" });
        const cardHeader = card.createDiv({ cls: "mc-marketplace-card-header" });
        cardHeader.createEl("strong", { text: skill.label });
        cardHeader.createSpan({ cls: "mc-marketplace-card-size", text: skill.size });

        const catBadge = card.createSpan({ cls: `mc-marketplace-badge mc-cat-${skill.category}` });
        catBadge.textContent = skill.category;

        card.createEl("p", { cls: "mc-marketplace-card-desc", text: skill.description.split(".")[0] + "." });

        const actions = card.createDiv({ cls: "mc-marketplace-card-actions" });
        const status = await plugin?.skillRegistry?.getSkillStatus(skill.id) ?? "not-installed";

        if (status === "installed") {
          const btn = actions.createEl("button", { cls: "mc-marketplace-btn is-installed", text: "Installed ✓" });
          btn.disabled = true;
        } else if (status === "update-available") {
          const btn = actions.createEl("button", { cls: "mc-marketplace-btn is-update", text: "Update" });
          btn.addEventListener("click", async () => {
            const modified = await plugin?.skillRegistry?.isModifiedLocally(skill.id);
            if (modified) {
              new Notice(`"${skill.label}" has local changes. Update skipped to protect your edits.`);
              return;
            }
            btn.disabled = true;
            btn.textContent = "Updating...";
            const ok = await plugin?.skillRegistry?.installSkill(skill.id);
            btn.textContent = ok ? "Updated ✓" : "Failed";
          });
        } else {
          const btn = actions.createEl("button", { cls: "mc-marketplace-btn is-install", text: "Install" });
          btn.addEventListener("click", async () => {
            btn.disabled = true;
            btn.textContent = "Installing...";
            const ok = await plugin?.skillRegistry?.installSkill(skill.id);
            btn.textContent = ok ? "Installed ✓" : "Failed";
            if (ok) {
              new Notice(`Installed: ${skill.label}`);
              this.view.buildSidebar();
            }
          });
        }
      }
    };

    renderSkills();

    // Install All button
    const footer = contentEl.createDiv({ cls: "mc-marketplace-footer" });
    const installAllBtn = footer.createEl("button", { cls: "mc-marketplace-install-all", text: "Install All" });
    installAllBtn.addEventListener("click", async () => {
      installAllBtn.disabled = true;
      installAllBtn.textContent = "Installing...";
      const ids = registry.skills.map(s => s.id);
      const count = await plugin?.skillRegistry?.installMultiple(ids) ?? 0;
      installAllBtn.textContent = `Installed ${count} skills ✓`;
      new Notice(`Installed ${count} skills.`);
      this.view.buildSidebar();
      renderSkills(); // Refresh status
    });
  }
}

// --- Skill definitions for Kanban Dashboard ---
// SkillDef type + CATEGORY_META now live in @mc/shared (skills/types).

const SKILLS: SkillDef[] = [
  // Primary — 3 daily drivers (pre-checked in onboarding + full-width in sidebar)
  { id: "process-transcripts", label: "Synthesise Files", description: "Synthesise raw files (transcripts, notes, backlog) into vault modules", primary: true, stars: 5, difficulty: "operator", value: "high", scope: "native-mc", requires: ["vault-structure"], category: "capture" },
  { id: "whatsapp-digest", label: "WhatsApp Digest", description: "Analyze WhatsApp groups — action items, blindspots, vault staleness", primary: true, stars: 4, difficulty: "expert", value: "high", scope: "native-mc", requires: ["vault-structure", "whatsapp-macos"], category: "capture" },
  { id: "gsuite-analysis", label: "Gmail + G-Suite", description: "Full Google Workspace playbook — 25 MCP tools across Gmail, Calendar, Drive, Docs, Sheets, Slides", primary: true, stars: 4, difficulty: "expert", value: "high", scope: "universal", requires: ["gsuite-connected"], category: "analyze" },
  // Secondary — available but not pre-checked
  { id: "start-here", label: "Start Here", description: "Onboarding agent — scan vault, build modular-context structure", category: "maintain" },
  { id: "pulse", label: "Pulse", description: "Vault health check — staleness radar, strategic questions, next steps", stars: 5, difficulty: "operator", value: "high", scope: "native-mc", requires: ["vault-structure"], category: "analyze" },
  { id: "brief", label: "Brief", description: "Generate PDF brief or one-pager from vault knowledge", stars: 5, difficulty: "operator", value: "high", scope: "universal", requires: ["python3"], category: "create" },
  { id: "log", label: "Log", description: "Close session — generate session log, commit changes", stars: 4, difficulty: "learner", value: "medium", scope: "universal", requires: ["git-initialized"], category: "maintain" },
  { id: "ideas", label: "Ideas", description: "Generate new ideas from vault context using creative triggers", stars: 4, difficulty: "learner", value: "medium", scope: "universal", category: "create" },
  { id: "reweave", label: "Reweave", description: "Cascade-update stale or disconnected modules", stars: 4, difficulty: "expert", value: "high", scope: "native-mc", requires: ["vault-structure", "process-transcripts"], category: "maintain" },
  { id: "vault-audit", label: "Vault Audit", description: "Audit vault structure — broken links, orphans, naming issues", stars: 4, difficulty: "operator", value: "medium", scope: "universal", category: "analyze" },
  { id: "graph", label: "Graph", description: "Analyze knowledge graph — clusters, bridges, dependency depth", stars: 4, difficulty: "expert", value: "medium", scope: "universal", requires: ["python3"], category: "analyze" },
  { id: "graduate", label: "Graduate", description: "Promote buried transcript insights into standalone modules", stars: 4, difficulty: "operator", value: "high", scope: "native-mc", requires: ["vault-structure", "process-transcripts"], category: "maintain" },
  { id: "skills-audit", label: "Skills Audit", description: "Scan your library → 4-bucket report + contribution motivators", stars: 4, difficulty: "learner", value: "medium", scope: "universal", category: "analyze" },
  // AI Company Stack — *-review family (v2.1.4)
  { id: "clickup-review", label: "ClickUp Review", description: "Review a CRM/sales-funnel list in ClickUp — stages, deals near close, stale leads, value sums", stars: 4, difficulty: "operator", value: "high", scope: "universal", requires: ["clickup-connected", "python3", "review-core"], category: "analyze" },
  { id: "comms-review", label: "Comms Review", description: "Cross-channel owner overview — ClickUp + WhatsApp + Gmail in one report", stars: 5, difficulty: "expert", value: "high", scope: "universal", requires: ["clickup-connected", "whatsapp-macos", "gsuite-connected", "python3", "review-core"], category: "analyze" },
  { id: "review-core", label: "Review Core (lib)", description: "Shared ClickUp client + normalized model for the *-review family. Internal dependency.", stars: 3, difficulty: "expert", value: "medium", scope: "universal", requires: ["clickup-connected", "python3"], category: "automate" },
];

// Setup-flag evaluation + prereq checks now live in @mc/shared (skills/setup-flags):
// evaluateSetupFlag(flag, vaultBase) / checkSkillPrereqs(skill, knownIds, installedIds, vaultBase).


// (KanbanView removed — kanban is now integrated into TerminalView sidebar)

// --- Settings Tab ---

class MCSettingTab extends PluginSettingTab {
  plugin: TerminalPlugin;
  constructor(app: App, plugin: TerminalPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  async display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Modular Context" });
    const data = await this.plugin.loadData() ?? {};
    new Setting(containerEl)
      .setName("AI Provider")
      .setDesc("Which AI coding agent to launch in new terminals")
      .addDropdown((dropdown) => dropdown
        .addOption("claude", "Claude Code")
        .addOption("codex", "OpenAI Codex")
        .setValue(data.aiProvider ?? "claude")
        .onChange(async (value) => {
          data.aiProvider = value;
          await this.plugin.saveData(data);
        })
      );
    new Setting(containerEl)
      .setName("Auto-mode")
      .setDesc((data.aiProvider ?? "claude") === "codex"
        ? "Launch Codex with --full-auto by default"
        : "Launch Claude Code with --dangerously-skip-permissions by default")
      .addToggle((toggle) => toggle
        .setValue(data.autoMode ?? false)
        .onChange(async (value) => {
          data.autoMode = value;
          await this.plugin.saveData(data);
        })
      );
    new Setting(containerEl)
      .setName("Max sessions")
      .setDesc("Maximum concurrent terminal sessions (1–20)")
      .addText((text) => text
        .setValue(String(data.maxSessions ?? 12))
        .onChange(async (value) => {
          const num = parseInt(value, 10);
          if (!isNaN(num) && num >= 1 && num <= 20) {
            data.maxSessions = num;
            await this.plugin.saveData(data);
          }
        })
      );
    new Setting(containerEl)
      .setName("Font size")
      .setDesc("Terminal font size in pixels (8–24)")
      .addText((text) => text
        .setValue(String(data.fontSize ?? 13.5))
        .onChange(async (value) => {
          const num = parseFloat(value);
          if (!isNaN(num) && num >= 8 && num <= 24) {
            data.fontSize = num;
            await this.plugin.saveData(data);
          }
        })
      );
    new Setting(containerEl)
      .setName("Default layout")
      .setDesc("Terminal pane layout")
      .addDropdown((dropdown) => dropdown
        .addOption("single", "Single")
        .addOption("split-h", "Side by side")
        .addOption("split-v", "Stacked")
        .addOption("grid", "Grid (2×2)")
        .setValue(data.layout ?? "single")
        .onChange(async (value) => {
          data.layout = value;
          await this.plugin.saveData(data);
        })
      );
  }
}

// --- Skill Registry ---

// Registry URLs + RegistrySkill/RegistryData/InstalledSkillInfo types now live in
// @mc/shared (skills/types) — one source of truth for plugin and app.

/** Thin Obsidian host over the shared SkillRegistry core (@mc/shared).
 *  Same public API as before (fetchRegistry/getSkillStatus/installSkill/
 *  installMultiple/isModifiedLocally) — implementation moved to shared so the
 *  Electron app consumes the identical install logic. */
class SkillRegistry extends SkillRegistryCore {
  constructor(app: App, plugin: TerminalPlugin) {
    super({
      fetchText: async (url: string) => {
        const resp = await requestUrl({ url });
        return { status: resp.status, text: resp.text };
      },
      readFile: (path: string) => app.vault.adapter.read(path),
      writeFile: (path: string, content: string) => app.vault.adapter.write(path, content),
      exists: (path: string) => app.vault.adapter.exists(path),
      mkdir: (path: string) => app.vault.adapter.mkdir(path),
      loadData: async () => (await plugin.loadData()) ?? {},
      saveData: (data: Record<string, any>) => plugin.saveData(data),
      notify: (message: string) => { new Notice(message); },
    });
  }
}

// --- Plugin ---

export default class TerminalPlugin extends Plugin {
  agentTracker!: AgentTracker;
  skillRegistry!: SkillRegistry;
  googleStorage: TokenStorageMethod | null = null;
  googleRefreshTimer: RefreshTimerHandle | null = null;

  getGoogleOAuthConfig(): OAuthConfig {
    return {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
      scopes: [...GOOGLE_WORKSPACE_SCOPES],
      mode: "quick-connect",
    };
  }

  getGoogleStorage(): TokenStorageMethod {
    if (!this.googleStorage) {
      const vaultRoot = (this.app.vault.adapter as any).basePath as string;
      const vaultId = (this.app as any).appId ?? "default";
      this.googleStorage = createStorageMethod({ vaultRoot, vaultId });
    }
    return this.googleStorage;
  }

  getMcpSyncOptions() {
    const vaultRoot = (this.app.vault.adapter as any).basePath as string;
    const path = require("path");
    const sourceServerPath = path.join(vaultRoot, this.manifest.dir, "mcp-server.js");
    const config = this.getGoogleOAuthConfig();
    return {
      vaultRoot,
      sourceServerPath,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      pluginVersion: this.manifest.version,
    };
  }

  /**
   * Sync MCP after a successful connect. If accountId omitted, reads primary
   * account's tokens (legacy single-account flow).
   */
  async syncMcpOnConnect(accountId?: string): Promise<void> {
    const { syncOnConnect, reconcileMcpSidecar } = await import("./src/google/mcp-config/mcp-sync");
    const storage = this.getGoogleStorage() as any;
    const multi = typeof storage.getMulti === "function" ? storage.getMulti() : null;

    let tokens = null;
    if (accountId && multi) {
      tokens = await multi.loadTokens(accountId).catch(() => null);
    } else {
      tokens = await storage.loadTokens().catch(() => null);
    }
    if (!tokens) return;
    const result = syncOnConnect(tokens, this.getMcpSyncOptions());
    if (result.message) new Notice(`Modular Context: ${result.message}`);
    if (!result.ok) console.error("[mc] MCP sync failed:", result.error);

    // Auto-reconcile sidecar with plugin-side truth — prunes zombie entries
    if (multi) {
      try {
        const accounts = await multi.listAccounts();
        const primary = await multi.getPrimaryAccountId();
        reconcileMcpSidecar(accounts, primary);
      } catch (err) {
        console.error("[mc] post-connect reconcile failed:", err);
      }
    }
  }

  /**
   * Sync MCP after a disconnect. accountId required for specific account removal.
   * If omitted, disconnects ALL accounts (full cleanup).
   */
  async syncMcpOnDisconnect(accountId?: string): Promise<void> {
    if (accountId) {
      const { syncOnDisconnect } = await import("./src/google/mcp-config/mcp-sync");
      const result = syncOnDisconnect(accountId, {
        vaultRoot: this.getMcpSyncOptions().vaultRoot,
      });
      if (result.message) new Notice(`Modular Context: ${result.message}`);
      if (!result.ok) console.error("[mc] MCP disconnect cleanup failed:", result.error);
    } else {
      const { syncDisconnectAll } = await import("./src/google/mcp-config/mcp-sync");
      const result = syncDisconnectAll({ vaultRoot: this.getMcpSyncOptions().vaultRoot });
      if (result.message) new Notice(`Modular Context: ${result.message}`);
      if (!result.ok) console.error("[mc] MCP disconnect-all failed:", result.error);
    }
  }

  async onload() {
    // Ensure pty-helper.py exists in the plugin directory.
    // BRAT and Obsidian's plugin installer only copy main.js, manifest.json,
    // and styles.css, so we write it ourselves on every load.
    const fs = require("fs");
    const path = require("path");
    const vaultBase = (this.app.vault.adapter as any).basePath as string;
    const helperPath = path.join(vaultBase, this.manifest.dir, "pty-helper.py");
    try {
      fs.writeFileSync(helperPath, PTY_HELPER_SOURCE, { mode: 0o755 });
      ptyHelperPath = helperPath;
    } catch (e) {
      console.error("[modular-context] Failed to write pty-helper.py:", e);
      new Notice("Modular Context: Failed to write terminal helper. Check console.");
    }

    // Skill registry — fetches and installs skills from GitHub
    this.skillRegistry = new SkillRegistry(this.app, this);

    // Agent tracker — notifies terminal views to re-render sidebar
    this.agentTracker = new AgentTracker(() => {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
        (leaf.view as TerminalView).renderSidebarCards();
      }
    });

    this.registerView(VIEW_TYPE, (leaf) => {
      const view = new TerminalView(leaf);
      view.tracker = this.agentTracker;
      (view as any).plugin = this;
      return view;
    });

    this.addSettingTab(new MCSettingTab(this.app, this));

    const layoutCmd = (id: string, name: string, layout: string) => {
      this.addCommand({
        id,
        name,
        callback: () => {
          const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
          if (leaves.length === 0) return;
          const view = leaves[0].view as TerminalView;
          // setLayout works the same in inline and fullscreen
          view.setLayout(layout as any);
          view.buildSidebar();
        },
      });
    };
    layoutCmd("layout-single", "Terminal: Single Pane", "single");
    layoutCmd("layout-split-h", "Terminal: Side by Side", "split-h");
    layoutCmd("layout-split-v", "Terminal: Stacked", "split-v");
    layoutCmd("layout-grid", "Terminal: Grid (2x2)", "grid");

    // Register ReceptionOS signet as custom icon
    addIcon("ros-signet", `<g transform="translate(25,0) scale(1.942)"><path fill="currentColor" d="M21.77,12.02c-.53-.83-1.09-1.6-1.68-2.33-.01-.02-.03-.03-.04-.05C15.85,4.37,10.21,1.34,4.3.38c-.4-.07-.8-.13-1.2-.18-.08,0-.15-.02-.23-.03C2.27.11,1.67.06,1.07.03.81.02.55,0,.3,0c-.1,0-.2,0-.3,0v1.03c1.07.02,2.15.1,3.23.27.26.05.51.1.77.16,2.87.83,5.58,2.49,7.8,5.1,2.46,2.92,3.66,6.32,3.82,9.69-2.49-2.67-5.69-4.76-9.42-5.92-2.07-.64-4.15-.95-6.19-.99v.96c1.93.08,3.9.42,5.87,1.07,4.02,1.33,7.33,3.86,9.71,7.03-.17,2.02-.69,3.99-1.54,5.81-3.04-4.28-8-7.26-14.03-7.3v1c5.9.18,10.57,3.4,13.22,7.83-2.65,4.43-7.31,7.65-13.22,7.83v1c6.04-.03,10.99-3.02,14.03-7.3.85,1.82,1.38,3.79,1.54,5.81-2.38,3.17-5.69,5.7-9.71,7.03-1.97.65-3.94.99-5.87,1.07v.96c2.04-.04,4.12-.34,6.19-.99,3.74-1.16,6.94-3.25,9.42-5.92-.16,3.37-1.36,6.77-3.82,9.69-2.22,2.62-4.93,4.28-7.8,5.1-.26.06-.51.11-.77.16-1.08.17-2.16.25-3.23.27v1.03c.1,0,.2,0,.3,0,.26,0,.52-.02.77-.03.6-.03,1.2-.07,1.8-.14.08,0,.15-.02.23-.03.4-.05.8-.1,1.2-.17,5.9-.96,11.55-3.99,15.75-9.25.01-.02.03-.03.04-.05.59-.74,1.15-1.51,1.68-2.33,2.76-4.19,4.02-8.97,3.98-13.73.04-4.76-1.23-9.54-3.98-13.73ZM13.74,6.82c.86.86,1.68,1.8,2.43,2.85,2.78,3.91,3.83,8.39,3.48,12.73-.63-1.46-1.43-2.85-2.37-4.14.26-3.88-.8-7.92-3.53-11.44ZM15.02,25.75c.92-1.62,1.58-3.39,1.95-5.22.94,1.64,1.66,3.4,2.12,5.22-.46,1.83-1.18,3.58-2.12,5.22-.37-1.83-1.03-3.6-1.95-5.22ZM13.74,44.67c2.74-3.52,3.8-7.55,3.53-11.44.95-1.29,1.74-2.68,2.37-4.14.35,4.33-.7,8.82-3.48,12.73-.75,1.05-1.57,1.99-2.43,2.85ZM16.4,43.71c.3-.35.6-.7.88-1.08,3.96-5.23,4.88-11.34,3.5-16.89,1.38-5.55.46-11.67-3.5-16.89-.28-.37-.58-.73-.88-1.08,4.87,4.63,7.55,11.29,7.64,17.97-.09,6.68-2.77,13.33-7.64,17.97Z"/></g>`);

    this.addRibbonIcon("ros-signet", "Modular Context", () => {
      this.toggleTerminalSide();
    });

    this.addCommand({
      id: "open-terminal",
      name: "Open Terminal",
      callback: () => this.toggleTerminalSide(),
    });

    this.addCommand({
      id: "open-terminal-tab",
      name: "Open Terminal in Tab",
      callback: () => this.openTerminalTab(),
    });

    this.addCommand({
      id: "toggle-fullscreen",
      name: "Toggle Fullscreen Terminal",
      callback: () => {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        if (leaves.length > 0) {
          const view = leaves[0].view as TerminalView;
          view.fullscreenManager?.toggle();
        }
      },
    });

    this.addCommand({
      id: "capture-terminal-output",
      name: "Capture Terminal Output to Note",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "s" }],
      callback: () => {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        if (leaves.length === 0) return;
        const view = leaves[0].view as TerminalView;
        const session = view.activeSession;
        if (!session) return;
        const text = session.captureOutput();
        if (!text.trim()) return;
        new OutputCaptureModal(this.app, text).open();
      },
    });

    this.addCommand({
      id: "add-bookmark",
      name: "Add Terminal Bookmark",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "m" }],
      callback: () => {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        if (leaves.length === 0) return;
        const view = leaves[0].view as TerminalView;
        view.activeSession?.addBookmark();
      },
    });

    this.addCommand({
      id: "next-bookmark",
      name: "Next Terminal Bookmark",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "]" }],
      callback: () => {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        if (leaves.length === 0) return;
        const view = leaves[0].view as TerminalView;
        view.activeSession?.nextBookmark();
      },
    });

    this.addCommand({
      id: "prev-bookmark",
      name: "Previous Terminal Bookmark",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "[" }],
      callback: () => {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        if (leaves.length === 0) return;
        const view = leaves[0].view as TerminalView;
        view.activeSession?.prevBookmark();
      },
    });

    this.addCommand({
      id: "clear-bookmarks",
      name: "Clear Terminal Bookmarks",
      callback: () => {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        if (leaves.length === 0) return;
        const view = leaves[0].view as TerminalView;
        view.activeSession?.clearBookmarks();
      },
    });

    this.addCommand({
      id: "show-shortcuts",
      name: "Show Terminal Shortcuts",
      callback: () => new ShortcutsModal(this.app).open(),
    });

    // --- Google Workspace commands ---

    const openConnectGoogle = () => {
      const storage = this.getGoogleStorage() as any;
      const multi = typeof storage.getMulti === "function" ? storage.getMulti() : null;
      if (!multi) {
        new Notice("Google Workspace: multi-account storage unavailable");
        return;
      }
      new ConnectGoogleModal(this.app, {
        storage,
        multiStorage: multi,
        quickConnect: {
          clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
          clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
        },
        onStateChange: (state) => {
          if (state.kind === "connected") {
            void this.syncMcpOnConnect(state.tokens.accountEmail);
          } else if (state.kind === "disconnected") {
            void this.syncMcpOnDisconnect();
          }
        },
      }).open();
    };

    this.addCommand({
      id: "google-workspace-connect",
      name: "Google Workspace: Connect (or add account)",
      callback: openConnectGoogle,
    });

    this.addCommand({
      id: "google-workspace-add-account",
      name: "Google Workspace: Add another account",
      callback: openConnectGoogle,
    });

    this.addCommand({
      id: "google-workspace-repair",
      name: "Google Workspace: Repair MCP sidecar (reconcile)",
      callback: async () => {
        const storage = this.getGoogleStorage() as any;
        const multi = typeof storage.getMulti === "function" ? storage.getMulti() : null;
        if (!multi) {
          new Notice("Google Workspace: no multi-account storage available");
          return;
        }
        const accounts = await multi.listAccounts();
        const primary = await multi.getPrimaryAccountId();
        const { reconcileMcpSidecar } = await import("./src/google/mcp-config/mcp-sync");
        const result = reconcileMcpSidecar(accounts, primary);
        new Notice(`Modular Context: ${result.message ?? (result.ok ? "reconciled" : "failed")}`);
        if (!result.ok) console.error("[mc] sidecar reconcile failed:", result.error);
      },
    });

    this.addCommand({
      id: "google-workspace-disconnect",
      name: "Google Workspace: Disconnect all accounts",
      callback: async () => {
        const storage = this.getGoogleStorage() as any;
        const multi = typeof storage.getMulti === "function" ? storage.getMulti() : null;
        if (multi) {
          const accounts = await multi.listAccounts();
          for (const a of accounts) await multi.removeAccount(a.id).catch(() => undefined);
        } else {
          await this.getGoogleStorage().clearTokens().catch(() => undefined);
        }
        await this.syncMcpOnDisconnect();
        new Notice("All Google Workspace accounts disconnected");
      },
    });

    this.addCommand({
      id: "google-workspace-reconnect",
      name: "Google Workspace: Reconnect (upgrade scopes)",
      callback: async () => {
        const storage = this.getGoogleStorage() as any;
        const multi = typeof storage.getMulti === "function" ? storage.getMulti() : null;
        if (multi) {
          // Remove all accounts and re-open modal — user reconnects each
          const accounts = await multi.listAccounts();
          for (const a of accounts) await multi.removeAccount(a.id).catch(() => undefined);
          await this.syncMcpOnDisconnect();
        } else {
          await this.getGoogleStorage().clearTokens().catch(() => undefined);
        }
        openConnectGoogle();
      },
    });

    this.addCommand({
      id: "google-workspace-status",
      name: "Google Workspace: Status",
      callback: async () => {
        const storage = this.getGoogleStorage() as any;
        const multi = typeof storage.getMulti === "function" ? storage.getMulti() : null;
        if (!multi) {
          new Notice("Google Workspace: not connected");
          return;
        }
        const accounts = await multi.listAccounts();
        if (accounts.length === 0) {
          new Notice("Google Workspace: no accounts connected");
          return;
        }
        const { computeMissingScopes } = await import("@mc/shared");
        const lines: string[] = [`Google Workspace: ${accounts.length} account(s)`];
        for (const a of accounts) {
          const tokens = await multi.loadTokens(a.id).catch(() => null);
          const remainingMin = tokens
            ? Math.max(0, Math.floor((tokens.expiresAt - Date.now()) / 60000))
            : 0;
          const missing = computeMissingScopes(a.scope);
          const scopeStatus = missing.length === 0 ? "ok" : `needs reconnect (missing ${missing.length} scopes)`;
          const primary = a.isPrimary ? " [primary]" : "";
          lines.push(`  • ${a.email}${primary} — expires ~${remainingMin}min, scopes: ${scopeStatus}`);
        }
        new Notice(lines.join("\n"), 15_000);
      },
    });

    this.addCommand({
      id: "google-workspace-show-logs",
      name: "Google Workspace: Show MCP server logs",
      callback: () => {
        const path = require("path");
        const os = require("os");
        const fs = require("fs");
        const logPath = path.join(os.homedir(), ".modular-context", "mcp-google", "logs", "server.log");
        if (!fs.existsSync(logPath)) {
          new Notice("No MCP logs yet. Server runs when Claude Code calls a tool.");
          return;
        }
        const { shell } = require("electron");
        shell.openPath(logPath).catch(() => undefined);
      },
    });

    // Start Google multi-account refresh timer. Refreshes ALL connected accounts
    // and re-syncs sidecar per account on success.
    void (async () => {
      const { startMultiRefreshTimer } = await import("./src/google/tokens/refresh");
      const storage = this.getGoogleStorage() as any;
      const multi = typeof storage.getMulti === "function" ? storage.getMulti() : null;
      if (!multi) return;
      this.googleRefreshTimer = startMultiRefreshTimer({
        multiStorage: multi,
        config: this.getGoogleOAuthConfig(),
        onTokensUpdated: async (accountId, tokens) => {
          const { syncOnRefresh } = await import("./src/google/mcp-config/mcp-sync");
          const result = syncOnRefresh(accountId, tokens, this.getMcpSyncOptions());
          if (!result.ok) console.error("[mc] MCP sidecar refresh sync failed:", result.error);
        },
      });
    })();

    // Startup scope coverage check — warn user if any account has outdated scopes.
    void (async () => {
      try {
        const { findAccountsNeedingReconnect } = await import("./src/google/tokens/refresh");
        const storage = this.getGoogleStorage() as any;
        const multi = typeof storage.getMulti === "function" ? storage.getMulti() : null;
        if (!multi) return;
        const needing = await findAccountsNeedingReconnect(multi);
        if (needing.length > 0) {
          const emails = needing.map((n: { email: string }) => n.email).join(", ");
          new Notice(
            `Google Workspace: OAuth scopes upgraded. Reconnect required for: ${emails}. ` +
              `Run "Google Workspace: Reconnect" command.`,
            15_000,
          );
        }
      } catch (e) {
        console.warn("[mc] Scope coverage check failed:", e);
      }
    })();

    // Ensure terminal leaf exists in the right sidebar on startup
    this.app.workspace.onLayoutReady(async () => {
      await this.ensureLeaf();

      // First-run: auto-trigger onboarding
      const data = await this.loadData() ?? {};
      if (!data.onboardingComplete) {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        if (leaves.length > 0) {
          new OnboardingModal(this.app, leaves[0].view as TerminalView).open();
        }
        await this.saveData({ ...data, onboardingComplete: true });
      }
    });
  }

  private async ensureLeaf() {
    if (this.app.workspace.getLeavesOfType(VIEW_TYPE).length > 0) return;
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
      // Expand right sidebar so terminal is visible and properly sized
      this.app.workspace.rightSplit.expand();
      // Delayed fit to ensure the container has been laid out
      setTimeout(() => {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        if (leaves.length > 0) {
          const view = leaves[0].view as TerminalView;
          view.activeSession?.fit();
        }
      }, 300);
    }
  }

  async toggleTerminalSide() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      const leaf = existing[0];
      const isVisible = leaf.view.containerEl.isShown();
      if (isVisible) {
        const parent = leaf.view.containerEl.closest(".workspace-split");
        if (parent && !parent.classList.contains("is-collapsed")) {
          this.app.workspace.rightSplit.collapse();
          return;
        }
      }
      this.app.workspace.revealLeaf(leaf);
      return;
    }
    await this.ensureLeaf();
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length > 0) {
      this.app.workspace.revealLeaf(leaves[0]);
    }
  }

  async openTerminalTab() {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async onunload() {
    // Capture snapshots of any live sessions before detaching leaves.
    // detachLeavesOfType would destroy them and lose tail buffers.
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view as TerminalView;
      try {
        await this.persistSnapshots(
          view.sessions ?? [],
          view.tracker ?? null,
          view.currentRestoreLayout?.(),
        );
      } catch (e) {
        console.error("[mc] persistSnapshots on unload failed:", e);
      }
    }
    this.agentTracker.stop();
    this.googleRefreshTimer?.cancel();
    this.googleRefreshTimer = null;
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  // --- Session snapshot persistence (smart restore picker) ---

  /** Persist snapshots of all live sessions to plugin saveData.
   *  Merges with existing archived snapshots so user's "skipped" history
   *  is preserved across restarts. */
  async persistSnapshots(
    sessions: TerminalSession[],
    tracker: AgentTracker | null,
    layout?: RestoreLayout,
  ) {
    const data = (await this.loadData()) ?? {};
    const prev: RestoreState = data.restoreState ?? emptyRestoreState();
    // Keep existing archived snapshots (user marked them "don't restore")
    const archived = prev.snapshots.filter((s) => s.archived);
    // Capture fresh snapshots for live sessions
    const fresh: SessionSnapshot[] = [];
    for (const session of sessions) {
      try {
        fresh.push(session.captureSnapshot(tracker));
      } catch (e) {
        console.warn(`[mc] captureSnapshot failed for session ${session.id}:`, e);
      }
    }
    // Deduplicate: if a live session's id matches an archived one, live wins
    const freshIds = new Set(fresh.map((s) => s.id));
    const merged = [...fresh, ...archived.filter((s) => !freshIds.has(s.id))];
    const nextState: RestoreState = {
      version: RESTORE_STATE_VERSION,
      snapshots: merged,
      layout: layout ?? prev.layout,
    };
    await this.saveData({ ...data, restoreState: nextState });
  }

  /** Load snapshots from plugin saveData. Returns empty state if none exist. */
  async loadSnapshots(): Promise<RestoreState> {
    const data = (await this.loadData()) ?? {};
    const raw = data.restoreState;
    if (!raw || raw.version !== RESTORE_STATE_VERSION || !Array.isArray(raw.snapshots)) {
      return emptyRestoreState();
    }
    return raw as RestoreState;
  }

  /** Update snapshot archived flag for a set of ids. Used by picker "Skip". */
  async setSnapshotsArchived(updates: Array<{ id: number; archived: boolean }>) {
    const data = (await this.loadData()) ?? {};
    const state: RestoreState = data.restoreState ?? emptyRestoreState();
    const byId = new Map(updates.map((u) => [u.id, u.archived]));
    state.snapshots = state.snapshots.map((s) =>
      byId.has(s.id) ? { ...s, archived: byId.get(s.id)! } : s,
    );
    await this.saveData({ ...data, restoreState: state });
  }

  /** Remove snapshots matching given ids. Used when picker materializes them. */
  async removeSnapshots(ids: number[]) {
    const data = (await this.loadData()) ?? {};
    const state: RestoreState = data.restoreState ?? emptyRestoreState();
    const toRemove = new Set(ids);
    state.snapshots = state.snapshots.filter((s) => !toRemove.has(s.id));
    await this.saveData({ ...data, restoreState: state });
  }
}
