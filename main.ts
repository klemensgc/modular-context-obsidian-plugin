import { Plugin, ItemView, WorkspaceLeaf, App, TFile, setIcon, SuggestModal, Modal, Menu, addIcon, Setting, PluginSettingTab, Notice, requestUrl } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { ChildProcess } from "child_process";

const VIEW_TYPE = "mc-terminal-view";
let ptyHelperPath = "";

const PTY_HELPER_PY = `\
"""PTY helper for modular-context. Wraps zsh in a real PTY with resize support."""
import os, select, signal, struct, fcntl, termios, pty

def main():
    cols = int(os.environ.get("MC_TERM_COLS", "80"))
    rows = int(os.environ.get("MC_TERM_ROWS", "24"))
    master, slave = pty.openpty()
    fcntl.ioctl(master, termios.TIOCSWINSZ,
                struct.pack("HHHH", rows, cols, 0, 0))
    pid = os.fork()
    if pid == 0:
        os.close(master)
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        os.dup2(slave, 0)
        os.dup2(slave, 1)
        os.dup2(slave, 2)
        if slave > 2:
            os.close(slave)
        os.execvp("/bin/zsh", ["/bin/zsh", "-i", "-l"])
    os.close(slave)
    def resize(c, r):
        fcntl.ioctl(master, termios.TIOCSWINSZ,
                    struct.pack("HHHH", r, c, 0, 0))
        os.kill(pid, signal.SIGWINCH)
    buf = b""
    SEQ_START = b"\\x1b]R;"
    SEQ_END = b"\\x07"
    try:
        while True:
            rlist, _, _ = select.select([0, master], [], [])
            if 0 in rlist:
                data = os.read(0, 4096)
                if not data:
                    break
                buf += data
                while SEQ_START in buf:
                    idx = buf.index(SEQ_START)
                    end = buf.find(SEQ_END, idx)
                    if end < 0:
                        if idx > 0:
                            os.write(master, buf[:idx])
                        buf = buf[idx:]
                        break
                    if idx > 0:
                        os.write(master, buf[:idx])
                    seq = buf[idx + len(SEQ_START):end]
                    buf = buf[end + 1:]
                    try:
                        parts = seq.split(b";")
                        if len(parts) == 2:
                            resize(int(parts[0]), int(parts[1]))
                    except (ValueError, IndexError):
                        pass
                else:
                    if buf:
                        os.write(master, buf)
                        buf = b""
            if master in rlist:
                try:
                    data = os.read(master, 4096)
                    if not data:
                        break
                    os.write(1, data)
                except OSError:
                    break
    except Exception:
        pass
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass

if __name__ == "__main__":
    main()
`;

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

function getObsidianTheme(): Record<string, string> {
  const s = getComputedStyle(document.body);
  const get = (v: string) => s.getPropertyValue(v).trim();
  const isDark = document.body.classList.contains("theme-dark");

  const bg = get("--background-primary") || (isDark ? "#1e1e1e" : "#ffffff");
  const fg = get("--text-normal") || (isDark ? "#dcddde" : "#1a1a1a");
  const accent = get("--interactive-accent") || (isDark ? "#7f6df2" : "#705dcf");
  const muted = get("--text-muted") || (isDark ? "#999" : "#666");

  // ANSI palette: two variants for dark and light backgrounds
  const ansi = isDark
    ? {
        black:         "#1a1a2e",
        red:           "#e06c75",
        green:         "#98c379",
        yellow:        "#e5c07b",
        blue:          "#61afef",
        magenta:       "#c678dd",
        cyan:          "#56b6c2",
        white:         "#abb2bf",
        brightBlack:   "#5c6370",
        brightRed:     "#e88388",
        brightGreen:   "#a9d18e",
        brightYellow:  "#ebd09c",
        brightBlue:    "#7ec8e3",
        brightMagenta: "#d19de0",
        brightCyan:    "#73cdd6",
        brightWhite:   "#f0f0f0",
      }
    : {
        black:         "#383a42",
        red:           "#d73a49",
        green:         "#22863a",
        yellow:        "#b08800",
        blue:          "#0366d6",
        magenta:       "#6f42c1",
        cyan:          "#0598bc",
        white:         "#6a737d",
        brightBlack:   "#959da5",
        brightRed:     "#cb2431",
        brightGreen:   "#28a745",
        brightYellow:  "#dbab09",
        brightBlue:    "#2188ff",
        brightMagenta: "#8a63d2",
        brightCyan:    "#3192aa",
        brightWhite:   "#24292e",
      };

  return {
    background: bg,
    foreground: fg,
    cursor: muted,
    cursorAccent: bg,
    selectionBackground: isDark ? "rgba(255, 255, 255, 0.15)" : "rgba(0, 0, 0, 0.15)",
    selectionForeground: isDark ? "#f0f0f0" : "#1a1a1a",
    ...ansi,
  };
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

interface Bookmark {
  id: number;
  marker: any; // IMarker
  decoration: any; // IDecoration | null
  label: string;
  timestamp: number;
  pipEl: HTMLElement | null;
}

class BookmarkManager {
  private bookmarks: Bookmark[] = [];
  private nextId = 1;
  private terminal: Terminal;
  private containerEl: HTMLElement;
  private stripEl: HTMLElement;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private disposables: { dispose(): void }[] = [];

  constructor(terminal: Terminal, containerEl: HTMLElement) {
    this.terminal = terminal;
    this.containerEl = containerEl;

    // Create the bookmark strip (vertical rail on right edge)
    this.stripEl = document.createElement("div");
    this.stripEl.className = "mc-bookmark-strip";
    this.containerEl.appendChild(this.stripEl);

    // Listen for events that require pip repositioning
    const debouncedUpdate = () => {
      if (this.updateTimer) clearTimeout(this.updateTimer);
      this.updateTimer = setTimeout(() => this.updateStrip(), 50);
    };

    this.disposables.push(this.terminal.onScroll(debouncedUpdate));
    this.disposables.push(this.terminal.onLineFeed(debouncedUpdate));
    this.disposables.push(this.terminal.onResize(debouncedUpdate));
  }

  addBookmark(label?: string) {
    const buf = this.terminal.buffer.active;
    // If scrolled back, bookmark the top of the viewport; otherwise bookmark cursor line
    const viewportTop = buf.viewportY;
    const cursorLine = buf.baseY + buf.cursorY;
    const isScrolledBack = viewportTop < buf.baseY;
    const line = isScrolledBack ? viewportTop : cursorLine;

    const marker = this.terminal.registerMarker(line - cursorLine);
    if (!marker) return;

    const id = this.nextId++;
    const bookmarkLabel = label || `#${id}`;

    // Try to create a gutter decoration
    let decoration: any = null;
    try {
      decoration = this.terminal.registerDecoration({ marker, anchor: "left" });
      if (decoration) {
        decoration.onRender((el: HTMLElement) => {
          el.classList.add("mc-bookmark-gutter");
          el.title = bookmarkLabel;
          el.addEventListener("click", () => this.jumpTo(bookmark));
        });
      }
    } catch {
      // Alt buffer or other issue - decoration stays null
    }

    // Create pip in the strip
    const pipEl = document.createElement("div");
    pipEl.className = "mc-bookmark-pip";
    pipEl.title = bookmarkLabel;
    pipEl.addEventListener("click", () => this.jumpTo(bookmark));
    this.stripEl.appendChild(pipEl);

    const bookmark: Bookmark = { id, marker, decoration, label: bookmarkLabel, timestamp: Date.now(), pipEl };
    this.bookmarks.push(bookmark);

    // Auto-remove when scrollback is trimmed
    marker.onDispose(() => this.removeBookmark(bookmark));

    this.updateStrip();
  }

  jumpTo(bookmark: Bookmark) {
    const line = bookmark.marker.line;
    this.terminal.scrollToLine(line);

    // Briefly highlight the pip
    if (bookmark.pipEl) {
      bookmark.pipEl.addClass("is-active");
      setTimeout(() => bookmark.pipEl?.removeClass("is-active"), 600);
    }
  }

  jumpNext() {
    if (this.bookmarks.length === 0) return;
    const sorted = [...this.bookmarks].sort((a, b) => a.marker.line - b.marker.line);
    const viewportY = this.terminal.buffer.active.viewportY;
    const next = sorted.find((b) => b.marker.line > viewportY + 1);
    this.jumpTo(next ?? sorted[0]); // wrap around
  }

  jumpPrev() {
    if (this.bookmarks.length === 0) return;
    const sorted = [...this.bookmarks].sort((a, b) => a.marker.line - b.marker.line);
    const viewportY = this.terminal.buffer.active.viewportY;
    const prev = sorted.slice().reverse().find((b) => b.marker.line < viewportY);
    this.jumpTo(prev ?? sorted[sorted.length - 1]); // wrap around
  }

  clearAll() {
    for (const b of [...this.bookmarks]) {
      this.removeBookmark(b);
    }
  }

  private removeBookmark(bookmark: Bookmark) {
    const idx = this.bookmarks.indexOf(bookmark);
    if (idx === -1) return;
    this.bookmarks.splice(idx, 1);
    bookmark.pipEl?.remove();
    try { bookmark.decoration?.dispose(); } catch { /* already disposed */ }
    try { bookmark.marker?.dispose(); } catch { /* already disposed */ }
  }

  private updateStrip() {
    const totalLines = this.terminal.buffer.active.length;
    if (totalLines === 0) return;
    for (const b of this.bookmarks) {
      if (b.pipEl) {
        const pct = (b.marker.line / totalLines) * 100;
        b.pipEl.style.top = `${pct}%`;
      }
    }
  }

  destroy() {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.clearAll();
    this.stripEl.remove();
  }
}

// --- TerminalSession ---

class TerminalSession {
  terminal: Terminal;
  fitAddon: FitAddon;
  process: ChildProcess;
  containerEl: HTMLElement;
  id: number;
  name: string;
  app: App;
  textareaEl: HTMLTextAreaElement | null = null;
  private autocomplete: WikiLinkAutocomplete | null = null;
  private bookmarkManager: BookmarkManager | null = null;
  hasActivity = false;
  _lastStdoutAt = 0;
  private _activityCallback: ((session: TerminalSession) => void) | null = null;
  setActivityCallback(cb: ((session: TerminalSession) => void) | null) {
    this._activityCallback = cb;
  }

  constructor(parent: HTMLElement, id: number, cwd: string, app: App) {
    this.id = id;
    this.name = `zsh ${id}`;
    this.app = app;

    this.containerEl = parent.createDiv({ cls: "mc-terminal-session" });

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
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(this.containerEl);

    // Grab the hidden textarea xterm.js creates for input
    this.textareaEl = this.containerEl.querySelector(".xterm-helper-textarea");

    // Spawn zsh inside a real PTY via Python helper.
    // The helper accepts resize commands so the shell reflows to fit the panel.
    const { spawn } = require("child_process");
    const helperScript = ptyHelperPath;

    // Strip CLAUDECODE env var so Claude Code can be launched inside the terminal
    const { CLAUDECODE, ...cleanEnv } = process.env;
    this.process = spawn("python3", [helperScript], {
      cwd,
      env: {
        ...cleanEnv,
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        MC_TERM_COLS: "80",
        MC_TERM_ROWS: "24",
      },
    });

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
    this.containerEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    }, captureOpt);

    this.containerEl.addEventListener("dragenter", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter++;
      if (dragCounter === 1) this.showDropZone();
    }, captureOpt);

    this.containerEl.addEventListener("dragleave", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        this.hideDropZone();
      }
    }, captureOpt);

    this.containerEl.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter = 0;
      this.hideDropZone();
      this.handleDrop(e);
    }, captureOpt);
  }

  private dropZoneEl: HTMLElement | null = null;
  private dropBadgeTimer: ReturnType<typeof setTimeout> | null = null;

  private showDropZone() {
    if (this.dropZoneEl) return;
    this.dropZoneEl = document.createElement("div");
    this.dropZoneEl.className = "mc-terminal-dropzone";
    this.dropZoneEl.innerHTML = `<span class="mc-dropzone-label">Drop file here</span>`;
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

  /** Handle a drop event: extract file paths and write them to the shell */
  private handleDrop(e: DragEvent) {
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

    // 2. In-memory image data (e.g. macOS screenshot thumbnail dragged before
    //    it's saved to disk). The File object exists but has no .path.
    //    Read the blob, write it to a temp file, then paste that path.
    if (paths.length === 0 && e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      const imageFiles: File[] = [];
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        const file = e.dataTransfer.files[i];
        if (file.type.startsWith("image/")) {
          imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        this.saveDroppedImages(imageFiles);
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

    if (paths.length === 0) return;

    // Shell-escape paths and join with spaces
    const escaped = paths.map((p) => this.shellEscape(p)).join(" ");
    this.process.stdin?.write(escaped);

    // Show confirmation badge
    this.showDropBadge(paths);
  }

  /** Save in-memory image blobs (e.g. macOS screenshot thumbnails) to tmp files,
   *  then paste the paths into the shell. */
  private async saveDroppedImages(files: File[]) {
    const os = require("os");
    const fs = require("fs");
    const pathMod = require("path");
    const saved: string[] = [];

    for (const file of files) {
      const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const name = `drop-${ts}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
      const tmpPath = pathMod.join(os.tmpdir(), name);

      try {
        const buf = Buffer.from(await file.arrayBuffer());
        fs.writeFileSync(tmpPath, buf);
        saved.push(tmpPath);
      } catch (err) {
        console.error("[modular-context] failed to save dropped image:", err);
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

  destroy() {
    this.bookmarkManager?.destroy();
    this.autocomplete?.destroy();
    try {
      this.process.kill("SIGTERM");
    } catch {
      // Already dead
    }
    this.terminal.dispose();
    this.containerEl.remove();
  }
}

// --- FullscreenManager ---

type FullscreenLayout = "single" | "split-h" | "split-v" | "grid";

interface SavedPosition {
  parent: HTMLElement;
  nextSibling: Node | null;
}

class FullscreenManager {
  private static overlayOpen = false;

  private view: TerminalView;
  private overlay: HTMLElement | null = null;
  private tabBarEl: HTMLElement | null = null;
  private gridEl: HTMLElement | null = null;
  private savedPositions = new Map<TerminalSession, SavedPosition>();
  private savedSidebarParent: HTMLElement | null = null;
  private savedSidebarNextSibling: Node | null = null;
  private layout: FullscreenLayout = "single";
  private focusedSession: TerminalSession | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private isRenaming = false;

  constructor(view: TerminalView) {
    this.view = view;
  }

  get isOpen() {
    return this.overlay !== null;
  }

  toggle() {
    if (this.isOpen) {
      this.exit();
    } else {
      this.enter();
    }
  }

  enter(layout?: FullscreenLayout) {
    if (this.isOpen || FullscreenManager.overlayOpen) return;
    if (this.view.sessions.length === 0) return;

    FullscreenManager.overlayOpen = true;
    if (layout) this.layout = layout;

    // Always sync focused session from the view's current active session
    this.focusedSession = this.view.activeSession ?? this.view.sessions[0];

    // Build overlay DOM
    this.overlay = document.createElement("div");
    this.overlay.className = "mc-fullscreen-overlay";

    // Grid container
    this.gridEl = document.createElement("div");
    this.gridEl.className = "mc-fullscreen-grid";
    this.gridEl.dataset.layout = this.layout;
    this.overlay.appendChild(this.gridEl);

    // Move the existing sidebar into the overlay (keeps same UI)
    const sidebar = this.view.sidebarEl;
    this.savedSidebarParent = sidebar.parentElement;
    this.savedSidebarNextSibling = sidebar.nextSibling;
    this.overlay.appendChild(sidebar);

    // Hidden tab bar ref (needed for compatibility but not rendered)
    this.tabBarEl = document.createElement("div");

    // Stop keyboard events from bubbling to Obsidian
    this.overlay.addEventListener("keydown", (e) => {
      if (!e.metaKey) e.stopPropagation();
    });
    this.overlay.addEventListener("wheel", (e) => e.stopPropagation());

    // Escape to exit (only when autocomplete is not active)
    this.overlay.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape" && !this.isRenaming) {
        const anyAutocomplete = this.view.sessions.some(
          (s) => (s as any).autocomplete?.active
        );
        if (!anyAutocomplete) {
          e.preventDefault();
          e.stopPropagation();
          this.exit();
        }
      }
    });

    // Save positions and move sessions into panes
    this.saveAndMoveAll();

    // Set up activity detection on all sessions
    this.setupActivityCallbacks();

    // Append to body
    document.body.appendChild(this.overlay);

    // Animate in
    requestAnimationFrame(() => this.overlay?.classList.add("is-visible"));

    // ResizeObserver on grid
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.fitAllVisible(), 60);
    });
    this.resizeObserver.observe(this.gridEl);

    // Fit after layout settles
    setTimeout(() => this.fitAllVisible(), 100);
  }

  exit() {
    if (!this.overlay) return;

    // Immediately stop blocking clicks and start fade
    this.overlay.style.pointerEvents = "none";
    this.overlay.classList.remove("is-visible");

    // Remove overlay after fade animation
    const overlay = this.overlay;
    setTimeout(() => overlay.remove(), 150);

    // Restore sidebar to its original position BEFORE removing overlay
    const sidebar = this.view.sidebarEl;
    if (this.savedSidebarParent) {
      if (this.savedSidebarNextSibling && this.savedSidebarNextSibling.parentNode === this.savedSidebarParent) {
        this.savedSidebarParent.insertBefore(sidebar, this.savedSidebarNextSibling);
      } else {
        this.savedSidebarParent.appendChild(sidebar);
      }
    }
    this.savedSidebarParent = null;
    this.savedSidebarNextSibling = null;

    // Clear refs immediately so re-entry works
    this.overlay = null;
    this.tabBarEl = null;
    this.gridEl = null;
    FullscreenManager.overlayOpen = false;

    // Clear activity callbacks
    this.clearActivityCallbacks();

    // Restore sessions to their original containers
    try {
      this.restoreAll();
    } catch (e) {
      console.error("[modular-context] restoreAll error:", e);
    }

    // Clean up observer
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);

    // Sync active session back to view
    // Force switchTo by clearing activeSession first
    const target = (this.focusedSession && this.view.sessions.includes(this.focusedSession))
      ? this.focusedSession
      : this.view.sessions[0] || null;
    this.view.activeSession = null;
    if (target) this.view.switchTo(target);
    this.view.renderTabs();

    // Refit after DOM settles
    requestAnimationFrame(() => {
      this.view.activeSession?.fit();
      this.view.activeSession?.focus();
    });
  }

  setLayout(layout: FullscreenLayout) {
    if (layout === this.layout && this.gridEl) return;
    this.layout = layout;
    if (this.gridEl) this.gridEl.dataset.layout = layout;
    this.renderFsTabs();
    this.rebuildPanes();
  }

  private saveAndMoveAll() {
    this.savedPositions.clear();

    // Save original DOM positions for ALL sessions so we can restore them on exit
    for (const session of this.view.sessions) {
      const parent = session.containerEl.parentElement;
      if (parent) {
        this.savedPositions.set(session, {
          parent,
          nextSibling: session.containerEl.nextSibling,
        });
      }
    }

    this.renderFsTabs();
    this.rebuildPanes();
  }

  /** Render the fullscreen tab bar: session tabs | layout switcher | actions */
  private renderFsTabs() {
    if (!this.tabBarEl || this.isRenaming) return;
    while (this.tabBarEl.firstChild) this.tabBarEl.removeChild(this.tabBarEl.firstChild);

    // Session tabs
    const tabsArea = document.createElement("div");
    tabsArea.className = "mc-fs-tabs";

    for (const session of this.view.sessions) {
      const tab = document.createElement("div");
      tab.className = "mc-fs-tab";
      if (session === this.focusedSession) tab.classList.add("is-active");
      if (session.hasActivity && session !== this.focusedSession) tab.classList.add("has-activity");

      const label = document.createElement("span");
      label.className = "mc-fs-tab-label";
      label.textContent = session.name;
      tab.appendChild(label);

      tab.addEventListener("click", () => {
        if (this.isRenaming) return;
        session.hasActivity = false;
        this.focusedSession = session;
        this.renderFsTabs();
        this.rebuildPanes();
      });

      tab.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const menu = new Menu();
        menu.addItem((item) =>
          item.setTitle("Rename").setIcon("pencil").onClick(() => {
            this.startTabRename(tab, label, session);
          })
        );
        if (this.view.sessions.length > 1) {
          menu.addItem((item) =>
            item.setTitle("Close").setIcon("x").onClick(() => {
              this.view.closeSession(session);
              this.savedPositions.delete(session);
              if (this.focusedSession === session) {
                this.focusedSession = this.view.sessions[this.view.sessions.length - 1] || null;
              }
              this.renderFsTabs();
              this.rebuildPanes();
            })
          );
        }
        menu.showAtMouseEvent(e);
      });

      tabsArea.appendChild(tab);
    }

    // New session button
    const newTab = document.createElement("div");
    newTab.className = "mc-fs-tab-new";
    newTab.textContent = "+";
    newTab.addEventListener("click", () => {
      this.view.createSession();
      const newest = this.view.sessions[this.view.sessions.length - 1];
      // Save position for the new session
      this.savedPositions.set(newest, {
        parent: newest.containerEl.parentElement!,
        nextSibling: newest.containerEl.nextSibling,
      });
      this.focusedSession = newest;
      this.setupActivityCallbacks();
      this.renderFsTabs();
      this.rebuildPanes();
    });
    tabsArea.appendChild(newTab);

    this.tabBarEl.appendChild(tabsArea);

    // Right side: layout switcher + exit
    const controls = document.createElement("div");
    controls.className = "mc-fs-controls";

    // Layout switcher
    const layoutGroup = document.createElement("div");
    layoutGroup.className = "mc-fs-layout-group";

    const layouts: { key: FullscreenLayout; label: string; svg: string }[] = [
      { key: "single", label: "Single", svg: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/></svg>' },
      { key: "split-h", label: "Side by side", svg: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/><line x1="6" y1="1" x2="6" y2="11"/></svg>' },
      { key: "split-v", label: "Stacked", svg: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/><line x1="1" y1="6" x2="11" y2="6"/></svg>' },
      { key: "grid", label: "Grid", svg: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/><line x1="6" y1="1" x2="6" y2="11"/><line x1="1" y1="6" x2="11" y2="6"/></svg>' },
    ];

    for (const l of layouts) {
      const btn = document.createElement("button");
      btn.className = "mc-fs-layout-btn";
      if (l.key === this.layout) btn.classList.add("is-active");
      btn.innerHTML = l.svg;
      btn.title = l.label;
      btn.addEventListener("click", () => this.setLayout(l.key));
      layoutGroup.appendChild(btn);
    }
    controls.appendChild(layoutGroup);

    // Exit button
    const exitBtn = document.createElement("button");
    exitBtn.className = "mc-fs-exit-btn";
    setIcon(exitBtn, "minimize-2");
    exitBtn.title = "Exit fullscreen";
    exitBtn.addEventListener("click", () => this.exit());
    controls.appendChild(exitBtn);

    this.tabBarEl.appendChild(controls);
  }

  private startTabRename(tab: HTMLElement, label: HTMLSpanElement, session: TerminalSession) {
    this.isRenaming = true;

    const input = document.createElement("input");
    input.type = "text";
    input.value = session.name;
    input.className = "mc-fs-tab-rename";
    input.style.width = `${session.name.length + 1}ch`;

    // Hide buttons while renaming
    tab.querySelectorAll(".mc-fs-tab-btn").forEach((el) => {
      (el as HTMLElement).style.display = "none";
    });
    label.replaceWith(input);

    input.addEventListener("input", () => {
      input.style.width = `${input.value.length + 1}ch`;
    });

    let finished = false;
    const finish = (save: boolean) => {
      if (finished) return;
      finished = true;
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
      this.renderFsTabs();
      this.rebuildPanes();
      this.view.renderTabs();
      this.view.saveState();
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

  /** Rebuild the grid panes based on current layout and sessions */
  private rebuildPanes() {
    if (!this.gridEl || this.isRenaming) return;

    // Detach sessions from panes before clearing (so they don't get destroyed)
    while (this.gridEl.firstChild) this.gridEl.removeChild(this.gridEl.firstChild);

    const visibleSessions = this.getVisibleSessions();
    const visibleSet = new Set(visibleSessions);
    const multiPane = visibleSessions.length > 1;

    // Hide non-visible sessions (park them off-screen in overlay so they're not orphaned)
    for (const session of this.view.sessions) {
      if (!visibleSet.has(session)) {
        session.containerEl.classList.remove("is-active");
        session.containerEl.style.display = "none";
        this.overlay?.appendChild(session.containerEl);
      }
    }

    for (const session of visibleSessions) {
      const pane = document.createElement("div");
      pane.className = "mc-fullscreen-pane";
      if (session === this.focusedSession) pane.classList.add("is-focused");

      // Show a thin label in multi-pane layouts so you know which is which
      // Session toolbar inside each session already provides name + close

      session.containerEl.style.display = "";
      session.containerEl.classList.add("is-active");
      pane.appendChild(session.containerEl);

      // Click pane to focus it
      pane.addEventListener("mousedown", () => {
        if (this.focusedSession !== session) {
          session.hasActivity = false;
          this.focusedSession = session;
          this.gridEl?.querySelectorAll(".mc-fullscreen-pane").forEach((p) => {
            p.classList.toggle("is-focused", p === pane);
          });
          this.renderFsTabs();
        }
        session.focus();
      });

      this.gridEl.appendChild(pane);
    }

    requestAnimationFrame(() => this.fitAllVisible());
  }

  private getVisibleSessions(): TerminalSession[] {
    const all = this.view.sessions;
    if (all.length === 0) return [];

    switch (this.layout) {
      case "single":
        return this.focusedSession && all.includes(this.focusedSession)
          ? [this.focusedSession]
          : [all[0]];
      case "split-h":
      case "split-v":
        if (all.length === 1) return [all[0]];
        if (this.focusedSession) {
          const idx = all.indexOf(this.focusedSession);
          const other = all[(idx + 1) % all.length];
          return this.focusedSession === other ? [this.focusedSession] : [this.focusedSession, other];
        }
        return all.slice(0, 2);
      case "grid":
        return [...all];
    }
  }

  private fitAllVisible() {
    if (!this.gridEl) return;
    const sessions = this.getVisibleSessions();
    for (const session of sessions) {
      session.fit();
    }
    // Don't steal focus from rename input
    if (!this.isRenaming && this.focusedSession && sessions.includes(this.focusedSession)) {
      this.focusedSession.focus();
    }
  }

  private setupActivityCallbacks() {
    for (const session of this.view.sessions) {
      session.setActivityCallback((s) => {
        if (s !== this.focusedSession && !s.hasActivity) {
          s.hasActivity = true;
          const tabs = this.tabBarEl?.querySelectorAll('.mc-fs-tab');
          if (tabs) {
            const idx = this.view.sessions.indexOf(s);
            if (idx >= 0 && tabs[idx]) {
              tabs[idx].classList.add('has-activity');
            }
          }
        }
      });
    }
  }

  private clearActivityCallbacks() {
    for (const session of this.view.sessions) {
      session.setActivityCallback(null);
    }
  }

  private restoreAll() {
    for (const [session, saved] of this.savedPositions) {
      // Reset any inline display override
      session.containerEl.style.display = "";
      try {
        if (saved.nextSibling && saved.nextSibling.parentNode === saved.parent) {
          saved.parent.insertBefore(session.containerEl, saved.nextSibling);
        } else {
          saved.parent.appendChild(session.containerEl);
        }
      } catch {
        // Fallback: put it back in the sessions container
        this.view.sessionsEl.appendChild(session.containerEl);
      }
    }

    // Also restore any sessions not in savedPositions (created during fullscreen)
    for (const session of this.view.sessions) {
      if (!this.savedPositions.has(session)) {
        session.containerEl.style.display = "";
        this.view.sessionsEl.appendChild(session.containerEl);
      }
      session.hide();
    }
    this.savedPositions.clear();
  }

  destroy() {
    if (this.isOpen) {
      // Restore sidebar before destroying
      if (this.savedSidebarParent) {
        const sidebar = this.view.sidebarEl;
        this.savedSidebarParent.appendChild(sidebar);
        this.savedSidebarParent = null;
      }
      // Quick exit without animation
      this.restoreAll();
      this.resizeObserver?.disconnect();
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.overlay?.remove();
      this.overlay = null;
      this.tabBarEl = null;
      this.gridEl = null;
      FullscreenManager.overlayOpen = false;
    }
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
  tracker: AgentTracker | null = null;
  autoMode = false;
  private sidebarDirty = true;
  inlineLayout: "single" | "split-h" | "split-v" | "grid" = "single";
  private visibleSessions: TerminalSession[] = [];
  customSkills: SkillDef[] = [];
  standbyEl!: HTMLElement;

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Terminal"; }
  getIcon() { return "ros-signet"; }

  getState() {
    return {
      sessions: this.sessions.map((s) => ({ id: s.id, name: s.name })),
      activeId: this.activeSession?.id ?? null,
      nextId: this.nextId,
    };
  }

  async setState(state: any, result: any) {
    if (state?.sessions?.length > 0) {
      // Destroy default session created by onOpen
      for (const s of this.sessions) s.destroy();
      this.sessions = [];
      this.activeSession = null;
      this.nextId = state.nextId ?? 1;

      for (const saved of state.sessions) {
        const id = saved.id ?? this.nextId++;
        if (id >= this.nextId) this.nextId = id + 1;
        const vaultPath = (this.app.vault.adapter as any).basePath as string;
        const session = new TerminalSession(this.sessionsEl, id, vaultPath, this.app);
        session.name = saved.name ?? `zsh ${id}`;
        (session as any)._autoNameLocked = true;
        this.addSessionToolbar(session);
        this.sessions.push(session);
        session.hide();
      }

      const target = this.sessions.find((s) => s.id === state.activeId) ?? this.sessions[0];
      if (target) this.switchTo(target);
      this.renderTabs();

      // Auto-resume: launch Claude Code in all restored sessions
      const claudeCmd = this.autoMode
        ? `claude --dangerously-skip-permissions -c\r`
        : `claude -c\r`;
      for (const session of this.sessions) {
        setTimeout(() => {
          session.process.stdin?.write(claudeCmd);
        }, 500);
        // No setupAutoName — restored sessions already have names
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

    // Sidebar (right): dashboard + standby + working + to review
    this.sidebarEl = container.createDiv({ cls: "mc-terminal-sidebar" });
    await this.loadCustomSkills();
    this.buildSidebar();

    // Hidden tab bar (still needed for fullscreen manager compatibility)
    this.tabBarEl = document.createElement("div");

    // Resize observer to refit terminals (debounced for smooth dragging)
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        if (this.inlineLayout !== "single" && this.visibleSessions.length > 0) {
          this.fitAllInlineVisible();
        } else {
          this.activeSession?.fit();
        }
      }, 60);
    });
    this.resizeObserver.observe(this.sessionsEl);

    // Fullscreen manager
    this.fullscreenManager = new FullscreenManager(this);

    // Re-apply terminal theme when Obsidian theme changes
    this.registerEvent(
      this.app.workspace.on("css-change", () => {
        for (const s of this.sessions) s.updateTheme();
      })
    );

    // Create first session (setState will replace this if restoring)
    this.createSession();

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
  }

  buildSidebar() {
    this.sidebarEl.empty();

    // --- Toolbar (info icon) ---
    const toolbar = this.sidebarEl.createDiv({ cls: "mc-sidebar-toolbar" });
    const infoBtn = toolbar.createDiv({ cls: "mc-sidebar-info-btn" });
    setIcon(infoBtn, "info");
    infoBtn.title = "About this plugin";
    infoBtn.addEventListener("click", () => new OnboardingModal(this.app, this).open());

    // --- Dashboard section ---
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

    // Skill Library button
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

    // Auto-mode checkbox
    const autoRow = dashSection.createDiv({ cls: "mc-sidebar-auto-mode" });
    const checkbox = autoRow.createEl("input", { type: "checkbox" }) as HTMLInputElement;
    checkbox.checked = this.autoMode;
    checkbox.addEventListener("change", () => {
      this.autoMode = checkbox.checked;
      this.saveCustomSkills();
    });
    autoRow.createSpan({ text: "Auto-mode", cls: "mc-sidebar-auto-label" });

    // --- Standby section (regular terminals + dismissed) ---
    const standbySection = this.sidebarEl.createDiv({ cls: "mc-sidebar-section" });
    standbySection.createDiv({ cls: "mc-sidebar-section-header", text: "Standby" });
    this.standbyEl = standbySection.createDiv({ cls: "mc-sidebar-cards" });
    const newBtn = standbySection.createDiv({ cls: "mc-sidebar-new-session-btn" });
    const newBtnIcon = newBtn.createDiv({ cls: "mc-sidebar-new-session-icon" });
    setIcon(newBtnIcon, "plus");
    newBtn.createSpan({ text: "New" });
    newBtn.addEventListener("click", () => this.createSession());

    // --- Working section (tracked agents) ---
    const workSection = this.sidebarEl.createDiv({ cls: "mc-sidebar-section" });
    workSection.createDiv({ cls: "mc-sidebar-section-header", text: "Working" });
    this.workingEl = workSection.createDiv({ cls: "mc-sidebar-cards" });

    // --- To Review section ---
    const revSection = this.sidebarEl.createDiv({ cls: "mc-sidebar-section" });
    revSection.createDiv({ cls: "mc-sidebar-section-header", text: "To Review" });
    this.reviewEl = revSection.createDiv({ cls: "mc-sidebar-cards" });

    // --- Footer: controls + logo ---
    const footer = this.sidebarEl.createDiv({ cls: "mc-sidebar-footer" });

    // Layout controls
    const controls = footer.createDiv({ cls: "mc-sidebar-controls" });

    const layoutGroup = controls.createDiv({ cls: "mc-sidebar-layout-group" });
    const layouts: { key: string; label: string; svg: string }[] = [
      { key: "single", label: "Single", svg: '<svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/></svg>' },
      { key: "split-h", label: "Side by side", svg: '<svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/><line x1="6" y1="1" x2="6" y2="11"/></svg>' },
      { key: "split-v", label: "Stacked", svg: '<svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/><line x1="1" y1="6" x2="11" y2="6"/></svg>' },
      { key: "grid", label: "Grid", svg: '<svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/><line x1="6" y1="1" x2="6" y2="11"/><line x1="1" y1="6" x2="11" y2="6"/></svg>' },
    ];
    for (const l of layouts) {
      const btn = layoutGroup.createEl("button", { cls: "mc-sidebar-layout-btn" });
      btn.innerHTML = l.svg;
      btn.title = l.label;
      // Highlight current inline layout (or fullscreen layout if in fullscreen)
      const currentLayout = this.fullscreenManager?.isOpen
        ? (this.fullscreenManager as any).layout
        : this.inlineLayout;
      if (l.key === currentLayout) btn.addClass("is-active");
      btn.addEventListener("click", () => {
        if (this.fullscreenManager?.isOpen) {
          // If in fullscreen, change fullscreen layout
          this.fullscreenManager?.setLayout(l.key as any);
        } else {
          // In normal mode, switch inline layout (no fullscreen)
          this.setInlineLayout(l.key as any);
        }
        // Re-highlight active
        layoutGroup.querySelectorAll(".mc-sidebar-layout-btn").forEach((b, i) => {
          b.classList.toggle("is-active", layouts[i].key === l.key);
        });
      });
    }

    const fsBtn = controls.createEl("button", { cls: "mc-sidebar-fs-btn" });
    setIcon(fsBtn, this.fullscreenManager?.isOpen ? "minimize-2" : "maximize-2");
    fsBtn.title = this.fullscreenManager?.isOpen ? "Exit fullscreen" : "Fullscreen";
    fsBtn.addEventListener("click", () => {
      this.fullscreenManager?.toggle();
      // Update icon after toggle
      fsBtn.empty();
      setIcon(fsBtn, this.fullscreenManager?.isOpen ? "minimize-2" : "maximize-2");
    });

    // Divider
    footer.createDiv({ cls: "mc-sidebar-footer-divider" });

    // ROS logo
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

  private async saveCustomSkills() {
    const src = (this as any).plugin ?? (this.app as any).plugins?.plugins?.["modular-context"];
    if (!src) return;
    const pluginData = await src.loadData() ?? {};
    pluginData.customSkills = this.customSkills;
    pluginData.hiddenSkills = (this as any).hiddenSkills ?? [];
    pluginData.skillConfig = (this as any).skillConfig ?? {};
    pluginData.autoMode = this.autoMode ?? false;
    pluginData.layout = this.inlineLayout ?? "single";
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
    this.inlineLayout = pluginData.layout ?? "single";
    (this as any).maxSessions = pluginData.maxSessions ?? 8;
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

  renderSidebarCards() {
    this.sidebarDirty = true;
    if (this.isRenaming) return;
    if (!this.standbyEl || !this.workingEl || !this.reviewEl) return;
    const savedScroll = this.sidebarEl?.scrollTop ?? 0;

    // --- Standby: sessions without active tracking (regular terminals + dismissed) ---
    this.standbyEl.empty();
    for (const session of this.sessions) {
      const tracked = this.tracker?.tracked.find((t) => t.sessionId === session.id);
      // Only show untracked or dismissed sessions in Standby
      if (tracked && tracked.status !== "dismissed") continue;

      const card = this.standbyEl.createDiv({ cls: "mc-sidebar-card" });
      if (session === this.activeSession) card.addClass("is-active");
      const cardHeader = card.createDiv({ cls: "mc-sidebar-card-header" });
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
      cardHeader.createSpan({ cls: "mc-sidebar-dot is-active" });
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
      card.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const menu = new Menu();
        menu.addItem((item) =>
          item.setTitle("Close").setIcon("x").onClick(() => {
            this.closeSession(session);
          })
        );
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
      cardHeader.createSpan({ cls: "mc-sidebar-card-name", text: t.skillName });

      const actions = card.createDiv({ cls: "mc-sidebar-card-actions" });
      const dismissBtn = actions.createEl("button", { cls: "mc-sidebar-card-action is-dismiss", text: "Dismiss" });
      dismissBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.tracker?.dismiss(t.sessionId);
      });

      card.addEventListener("click", () => {
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

  /** Apply inline layout — show multiple sessions in CSS grid */
  setInlineLayout(layout: "single" | "split-h" | "split-v" | "grid") {
    this.inlineLayout = layout;
    this.sessionsEl.dataset.layout = layout;

    if (layout === "single") {
      // Revert to normal single-session mode
      this.sessionsEl.classList.remove("mc-multi-pane");
      // Remove pane wrappers, put sessions back directly
      for (const session of this.sessions) {
        const pane = session.containerEl.closest(".mc-inline-pane");
        if (pane) {
          this.sessionsEl.appendChild(session.containerEl);
          pane.remove();
        }
        session.containerEl.classList.remove("is-visible");
        session.containerEl.style.display = "";
      }
      this.visibleSessions = [];
      // Re-show active session
      if (this.activeSession) {
        this.activeSession.show(true);
      }
      requestAnimationFrame(() => this.activeSession?.fit());
    } else {
      // Multi-pane mode
      this.sessionsEl.classList.add("mc-multi-pane");
      this.rebuildInlinePanes();
    }
    this.renderSidebarCards();
  }

  /** Rebuild inline panes based on current layout */
  private rebuildInlinePanes() {
    // Clear existing panes
    const existingPanes = this.sessionsEl.querySelectorAll(".mc-inline-pane");
    existingPanes.forEach((p) => {
      // Move sessions back to sessionsEl before removing pane
      const sessionEl = p.querySelector(".mc-terminal-session");
      if (sessionEl) this.sessionsEl.appendChild(sessionEl);
      p.remove();
    });

    // Determine which sessions to show
    const all = this.sessions;
    let visible: TerminalSession[];
    const activeIdx = this.activeSession ? all.indexOf(this.activeSession) : 0;

    switch (this.inlineLayout) {
      case "split-h":
      case "split-v": {
        if (all.length <= 1) {
          visible = [...all];
        } else {
          const other = all[(activeIdx + 1) % all.length];
          visible = this.activeSession
            ? (this.activeSession === other ? [this.activeSession] : [this.activeSession, other])
            : all.slice(0, 2);
        }
        break;
      }
      case "grid":
        visible = all.slice(0, 4);
        break;
      default:
        visible = this.activeSession ? [this.activeSession] : all.slice(0, 1);
    }

    this.visibleSessions = visible;
    const visibleSet = new Set(visible);

    // Hide non-visible sessions
    for (const session of all) {
      if (!visibleSet.has(session)) {
        session.containerEl.style.display = "none";
        session.containerEl.classList.remove("is-active", "is-visible");
      }
    }

    // Create pane wrappers for visible sessions
    for (const session of visible) {
      const pane = document.createElement("div");
      pane.className = "mc-inline-pane";
      if (session === this.activeSession) pane.classList.add("is-focused");

      // Label in multi-pane
      // Session toolbar inside each session already provides name + close

      session.containerEl.style.display = "";
      session.containerEl.classList.add("is-active", "is-visible");
      pane.appendChild(session.containerEl);

      pane.addEventListener("mousedown", () => {
        if (this.activeSession !== session) {
          this.activeSession = session;
          this.sessionsEl.querySelectorAll(".mc-inline-pane").forEach((p) => {
            p.classList.toggle("is-focused", p === pane);
          });
          session.focus();
          this.renderSidebarCards();
        }
      });

      this.sessionsEl.appendChild(pane);
    }

    requestAnimationFrame(() => this.fitAllInlineVisible());
  }

  /** Fit all visible sessions in inline multi-pane mode */
  private fitAllInlineVisible() {
    for (const session of this.visibleSessions) {
      session.fit();
    }
    if (this.activeSession && this.visibleSessions.includes(this.activeSession)) {
      this.activeSession.focus();
    }
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
    this.tracker?.track(session, skill.id);
    const claudeCmd = this.autoMode
      ? `claude --dangerously-skip-permissions\r`
      : `claude\r`;
    setTimeout(() => {
      session.process.stdin?.write(claudeCmd);
    }, 300);
    // Listen to raw stdout for ❯ prompt — much more reliable than polling terminal buffer
    let sent = false;
    const onData = (data: Buffer) => {
      if (sent) return;
      if (data.toString().includes("❯")) {
        sent = true;
        session.process.stdout?.removeListener("data", onData);
        setTimeout(() => {
          session.process.stdin?.write(`/${skill.id}\r`);
        }, 200);
      }
    };
    session.process.stdout?.on("data", onData);
    // Safety: stop listening after 30s
    const safetyTimeout = setTimeout(() => {
      if (!sent) session.process.stdout?.removeListener("data", onData);
    }, 30000);
    (session as any)._skillCleanup = () => {
      session.process.stdout?.removeListener("data", onData);
      clearTimeout(safetyTimeout);
    };
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

  createSession(name?: string): TerminalSession | null {
    try {
      const max = (this as any).maxSessions ?? 8;
      if (this.sessions.length >= max) {
        new Notice(`Max ${max} sessions. Close one first.`);
        return null;
      }
      const id = this.nextId++;
      const vaultPath = (this.app.vault.adapter as any).basePath as string;
      const session = new TerminalSession(this.sessionsEl, id, vaultPath, this.app);
      if (name) {
        session.name = name;
        (session as any)._autoNameLocked = true;
      }
      this.addSessionToolbar(session);
      this.setupAutoName(session);
      this.sessions.push(session);
      this.switchTo(session);
      this.renderSidebarCards();
      this.saveState();
      return session;
    } catch (e) {
      console.error("[mc] createSession error:", e);
      return null;
    }
  }

  saveState() {
    this.app.workspace.requestSaveLayout();
  }

  switchTo(session: TerminalSession) {
    if (session === this.activeSession) return;
    if (this.inlineLayout === "single") {
      if (this.activeSession) this.activeSession.hide();
      this.activeSession = session;
      session.show(this.isRenaming);
    } else {
      // Multi-pane: just change active focus, rebuild panes if needed
      this.activeSession = session;
      if (!this.visibleSessions.includes(session)) {
        this.rebuildInlinePanes();
      } else {
        // Just update focus highlight
        this.sessionsEl.querySelectorAll(".mc-inline-pane").forEach((pane) => {
          const hasSession = pane.contains(session.containerEl);
          pane.classList.toggle("is-focused", hasSession);
        });
        session.focus();
      }
    }
    this.renderSidebarCards();
    this.saveState();
  }

  closeSession(session: TerminalSession) {
    if ((session as any)._autoNameInterval) clearInterval((session as any)._autoNameInterval);
    if ((session as any)._skillCleanup) (session as any)._skillCleanup();
    session.destroy();
    this.sessions = this.sessions.filter((s) => s !== session);
    this.visibleSessions = this.visibleSessions.filter((s) => s !== session);
    this.tracker?.untrack(session.id);

    if (this.activeSession === session) {
      this.activeSession = null;
      if (this.sessions.length > 0) {
        this.switchTo(this.sessions[this.sessions.length - 1]);
      }
    }
    // Rebuild panes if in multi-pane mode
    if (this.inlineLayout !== "single" && this.sessions.length > 0) {
      this.rebuildInlinePanes();
    }
    this.renderSidebarCards();
    this.saveState();
  }

  renderTabs() {
    // Legacy — sidebar replaces tab bar. Only re-render sidebar cards.
    if (this.isRenaming) return;
    this.renderSidebarCards();
  }

  async onClose() {
    if (this.sidebarTimerInterval) clearInterval(this.sidebarTimerInterval);
    if (this.sidebarPollInterval) clearInterval(this.sidebarPollInterval);
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

// --- OnboardingModal ---

class OnboardingModal extends Modal {
  private view: TerminalView;

  constructor(app: App, view: TerminalView) {
    super(app);
    this.view = view;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("mc-onboarding-modal");

    // Header with ROS signet
    const header = contentEl.createDiv({ cls: "mc-onboarding-header" });
    const headerIcon = header.createDiv({ cls: "mc-onboarding-header-icon" });
    setIcon(headerIcon, "ros-signet");
    const headerText = header.createDiv();
    headerText.createEl("h3", { text: "Modular Context" });
    headerText.createEl("p", {
      text: "Your AI-native second brain — structured knowledge base in Obsidian, powered by Claude Code.",
      cls: "mc-onboarding-subtitle",
    });

    // Methodology
    contentEl.createEl("h4", { text: "How it works" });

    const steps: [string, string][] = [
      ["Capture", "Record conversations, meetings, ideas — drop raw transcripts into the vault"],
      ["Process", "AI agents categorize, extract insights, and update knowledge modules automatically"],
      ["Connect", "Wiki-links and cross-references build a living knowledge graph across all your projects"],
      ["Act", "Skills turn vault knowledge into deliverables — briefs, audits, strategic pulses, syncs"],
    ];

    const stepsEl = contentEl.createDiv({ cls: "mc-onboarding-steps" });
    steps.forEach(([title, desc], i) => {
      const step = stepsEl.createDiv({ cls: "mc-onboarding-step" });
      step.createDiv({ cls: "mc-onboarding-step-num", text: `${i + 1}` });
      const stepText = step.createDiv({ cls: "mc-onboarding-step-text" });
      stepText.createEl("strong", { text: title });
      stepText.createSpan({ text: ` — ${desc}` });
    });

    // Dashboard guide
    contentEl.createEl("h4", { text: "Dashboard" });
    contentEl.createEl("p", {
      text: "The sidebar is your command center. Primary skills at the top are your daily drivers. Click any skill to launch a Claude Code session that executes it. Working shows running agents. To Review surfaces completed work awaiting your approval.",
      cls: "mc-onboarding-body",
    });

    // Build your own vault
    contentEl.createEl("h4", { text: "Build your own vault" });

    const vaultSteps: string[] = [
      "Start with CLAUDE.md — it teaches Claude how to navigate your vault",
      "Create project folders with index files as entry points",
      "Add _transcripts/ for raw material and _culture/ for your principles",
      "Define skills in .claude/skills/ to automate recurring workflows",
      "Use frontmatter (status, updated, depends-on) to keep everything alive",
    ];

    const vaultList = contentEl.createEl("ol", { cls: "mc-onboarding-vault-list" });
    for (const step of vaultSteps) {
      vaultList.createEl("li", { text: step });
    }

    // Skill Library picker
    contentEl.createEl("h4", { text: "Install skills" });
    contentEl.createEl("p", {
      text: "Skills are AI workflows you can launch from the sidebar. Select which ones to install:",
      cls: "mc-onboarding-body",
    });

    const pickerEl = contentEl.createDiv({ cls: "mc-onboarding-skill-picker" });
    const selectedSkills = new Set<string>();

    // "Full Library" master checkbox
    const masterRow = pickerEl.createDiv({ cls: "mc-onboarding-skill-row is-master" });
    const masterCb = masterRow.createEl("input", { type: "checkbox" }) as HTMLInputElement;
    masterCb.id = "mc-skill-master";
    const masterLabel = masterRow.createEl("label");
    masterLabel.htmlFor = "mc-skill-master";
    masterLabel.createEl("strong", { text: "Full Modular Context Library" });
    masterLabel.createSpan({ text: " — install all core skills" });

    const skillCheckboxes: HTMLInputElement[] = [];

    // Load registry and build checkboxes
    const plugin = (this.view as any).plugin as TerminalPlugin | undefined;
    const buildPicker = async () => {
      const registry = await plugin?.skillRegistry?.fetchRegistry();
      if (!registry) {
        pickerEl.createEl("p", { text: "Could not load skill library. Check your internet connection.", cls: "mc-onboarding-error" });
        return;
      }

      // Group by category
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
          const sizeSpan = label.createSpan({ cls: "mc-onboarding-skill-size", text: skill.size });

          cb.addEventListener("change", () => {
            if (cb.checked) selectedSkills.add(skill.id);
            else selectedSkills.delete(skill.id);
            masterCb.checked = selectedSkills.size === registry.skills.length;
          });

          skillCheckboxes.push(cb);
        }
      }
    };
    buildPicker();

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

    // Install button
    const installRow = pickerEl.createDiv({ cls: "mc-onboarding-install-row" });
    const installBtn = installRow.createEl("button", {
      cls: "mc-onboarding-install-btn",
      text: "Install Selected Skills",
    });
    const installStatus = installRow.createSpan({ cls: "mc-onboarding-install-status" });

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
      installBtn.textContent = `Installed ${count} skills ✓`;
      installStatus.textContent = "";
      new Notice(`Installed ${count} skills.`);
      // Rebuild sidebar to show new skills
      this.view.buildSidebar();
    });

    // Divider
    contentEl.createEl("hr", { cls: "mc-onboarding-divider" });

    // CTA: Start Here onboarding session
    const cta = contentEl.createDiv({ cls: "mc-onboarding-cta" });
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

  private launchOnboardingAgent() {
    const view = this.view;
    view.createSession("onboard");
    const session = view.sessions[view.sessions.length - 1];
    if (!session) return;

    view.tracker?.track(session, "onboard");

    const claudeCmd = view.autoMode
      ? `claude --dangerously-skip-permissions\r`
      : `claude\r`;

    const onboardPrompt = [
      `You are the Modular Context setup agent. You help people build a personal LLM Wiki — a persistent, compounding knowledge base where the LLM does all the bookkeeping and the human focuses on sourcing, exploration, and thinking.`,
      ``,
      `## The Pattern (credit: Andrej Karpathy's "LLM Wiki")`,
      ``,
      `Most people use LLMs like RAG — upload files, retrieve chunks, generate answers. The LLM rediscovers knowledge from scratch every time. Nothing compounds.`,
      ``,
      `The LLM Wiki is different. Instead of retrieving from raw documents, the LLM incrementally builds and maintains a persistent wiki — structured, interlinked markdown files. When you add a source, the LLM reads it, extracts key info, and integrates it into existing pages. Cross-references are already there. Contradictions are flagged. Synthesis reflects everything. The wiki keeps getting richer with every source.`,
      ``,
      `You never write the wiki yourself — the LLM writes and maintains all of it. You curate sources, direct analysis, ask questions. The LLM does summarizing, cross-referencing, filing, and bookkeeping. Obsidian is the IDE. The LLM is the programmer. The wiki is the codebase.`,
      ``,
      `## Three Layers`,
      ``,
      `1. RAW SOURCES — your curated collection of source documents. Immutable. The LLM reads but never modifies.`,
      `   Implementation: _transcripts/ (categorized) + _transcripts-backlog/ (inbox)`,
      ``,
      `2. THE WIKI — LLM-generated markdown files. Summaries, entity pages, concept pages, comparisons, syntheses.`,
      `   Implementation: Project folders (1_project/, 2_project/) with modules. Each folder has an index file as navigation hub.`,
      ``,
      `3. THE SCHEMA — tells the LLM how the wiki is structured, conventions, workflows.`,
      `   Implementation: CLAUDE.md (root config) + _claude/ (standards, templates, skill references)`,
      ``,
      `## Three Operations`,
      ``,
      `INGEST — Drop a source, LLM processes it. Reads source, discusses takeaways, writes summary, updates index, updates entity/concept pages across the wiki. One source might touch 10-15 pages.`,
      `Implementation: Drop transcript in _transcripts-backlog/ then run /process-transcripts`,
      ``,
      `QUERY — Ask questions against the wiki. LLM reads relevant pages, synthesizes answer. Good answers get filed back as new wiki pages. Explorations compound.`,
      `Implementation: Ask Claude Code anything. Use /brief to generate deliverables from wiki content.`,
      ``,
      `LINT — Health-check the wiki. Find contradictions, stale claims, orphan pages, missing cross-references, data gaps.`,
      `Implementation: /pulse (strategic overview), /vault-audit (structure), /reweave (cascade updates), /graph (knowledge graph analysis)`,
      ``,
      `## Key Conventions`,
      ``,
      `- Every file has frontmatter: title, updated (YYYY-MM-DD), status (stable/draft/needs-update/stub), cadence (hot=7d/tactical=30d/iron-cold=60d/frozen), depends-on (wiki-links), sources (wiki-links to transcripts)`,
      `- Files: kebab-case.md. Index files: {folder}_index.md`,
      `- Wiki-links: [[file-name]] create a visible dependency graph. depends-on: in frontmatter tracks what breaks when something changes`,
      `- Cadence = self-healing: files past their cadence window auto-surface as stale. The wiki tells you what's outdated.`,
      `- Git versions everything — free changelog, rollback, blame`,
      `- index.md per folder = content-oriented navigation hub (what's here, one-line summary per page)`,
      `- Session logs in _claude/4-sessions/ = chronological record of what happened (the "log.md")`,
      ``,
      `## Your Mission`,
      ``,
      `1. SCAN the vault:`,
      `   - Check: does CLAUDE.md already exist? If YES: read it fully, then ask user: "You already have a CLAUDE.md. Should I extend it with modular-context conventions (frontmatter, cadence, navigation algorithm), or start fresh?" If extend: add missing sections, preserve existing content. If fresh: back up as CLAUDE-backup.md, create new.`,
      `   - List top-level folders, count .md files per folder`,
      `   - Check: do _transcripts/ and _transcripts-backlog/ exist? (raw sources layer)`,
      `   - Check: are there project folders with *_index.md files? (wiki layer)`,
      `   - Check: does _claude/ exist with standards? (schema layer)`,
      `   - Check: do files have frontmatter? Wiki-links?`,
      ``,
      `2. DIAGNOSE which layer is weakest:`,
      `   - No CLAUDE.md / _claude/ → Schema layer missing. LLM is flying blind.`,
      `   - No _transcripts/ pipeline → Source layer missing. No raw material to build from.`,
      `   - No index files / no frontmatter / no wiki-links → Wiki layer is flat files, not a knowledge graph.`,
      `   - All three exist but stale → Maintenance gap. Need lint operations.`,
      ``,
      `3. PRESENT vault state: "Here's what you have, here's what's missing, here's what's strong."`,
      ``,
      `4. RECOMMEND top 3 actions (pick based on diagnosis):`,
      ``,
      `   IF empty vault:`,
      `   a) Create CLAUDE.md — the schema that teaches the LLM your vault. Include: what this vault is about, project list, folder conventions, frontmatter standard, navigation algorithm.`,
      `   b) Create first project folder with index: 1_project/1_project_index.md`,
      `   c) Create _transcripts-backlog/ and drop your first source (meeting notes, article, journal entry)`,
      ``,
      `   IF has content, no structure:`,
      `   a) Create CLAUDE.md describing what exists`,
      `   b) Add frontmatter to existing files (title, updated, status)`,
      `   c) Create index files for each folder, add wiki-links between related files`,
      ``,
      `   IF structured, no pipeline:`,
      `   a) Set up _transcripts/ with categories + _transcripts-backlog/`,
      `   b) Create _claude/ with standards (frontmatter spec, naming conventions)`,
      `   c) Do a first ingest: process one source end-to-end, show how wiki pages get updated`,
      ``,
      `   IF mature vault:`,
      `   a) Run lint: find stale files, orphans, broken links, missing cross-references`,
      `   b) Suggest new wiki pages based on concepts mentioned but lacking their own page`,
      `   c) Identify sources that could fill knowledge gaps`,
      ``,
      `5. ASK user what they want to focus on. Then DO IT — create files, add frontmatter, build index pages. Show, don't tell.`,
      ``,
      `Remember: the human curates and thinks. You do the bookkeeping. The wiki stays maintained because the cost of maintenance is near zero. Respond in the same language as CLAUDE.md (or English if none exists).`,
    ].join("\\n");

    // Wait for shell to be ready, then launch Claude Code
    setTimeout(() => {
      session.process.stdin?.write(claudeCmd);
    }, 300);

    // Listen to raw stdout for ❯ prompt — reliable across TUI modes
    let sent = false;
    const onData = (data: Buffer) => {
      if (sent) return;
      if (data.toString().includes("❯")) {
        sent = true;
        session.process.stdout?.removeListener("data", onData);
        setTimeout(() => {
          session.process.stdin?.write(onboardPrompt + `\r`);
        }, 200);
      }
    };
    session.process.stdout?.on("data", onData);
    setTimeout(() => {
      if (!sent) session.process.stdout?.removeListener("data", onData);
    }, 30000);
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

interface SkillDef {
  id: string;
  label: string;
  description: string;
  primary?: boolean;
}

const SKILLS: SkillDef[] = [
  { id: "start-here", label: "Start Here", description: "Onboarding agent — scan vault, build modular-context structure", primary: true },
  { id: "process-transcripts", label: "Ingest Data", description: "Process new sources — categorize, extract insights, update wiki modules", primary: true },
  { id: "pulse", label: "Pulse", description: "Vault health check — staleness radar, strategic questions, next steps", primary: true },
  { id: "brief", label: "Brief", description: "Generate PDF brief or one-pager from vault knowledge", primary: true },
  { id: "log", label: "Log", description: "Close session — generate session log, commit changes" },
  { id: "ideas", label: "Ideas", description: "Generate new ideas from vault context using creative triggers" },
  { id: "reweave", label: "Reweave", description: "Cascade-update stale or disconnected modules" },
  { id: "vault-audit", label: "Vault Audit", description: "Audit vault structure — broken links, orphans, naming issues" },
  { id: "graph", label: "Graph", description: "Analyze knowledge graph — clusters, bridges, dependency depth" },
  { id: "graduate", label: "Graduate", description: "Promote buried transcript insights into standalone modules" },
];

// --- Agent Tracker ---

const MIN_DWELL_MS = 5000;       // minimum time in any state before transition
const IDLE_PROMPT_MS = 15000;     // idle + shell prompt → to-review
const IDLE_SAFETY_MS = 90000;     // idle safety net → to-review regardless
const REVIVE_BYTES = 200;         // bytes needed to revive from to-review
const REVIVE_WINDOW_MS = 5000;    // window for revive byte counting
const AUTO_DETECT_WINDOW_MS = 8000; // window for auto-detect

interface TrackedSession {
  sessionId: number;
  skillName: string;
  startedAt: number;
  lastActivityAt: number;
  status: "working" | "to-review" | "dismissed";
  stateChangedAt: number;
  recentOutputBytes: number;
  outputWindowStart: number;
}

class AgentTracker {
  tracked: TrackedSession[] = [];
  private listeners: Map<number, (data: Buffer) => void> = new Map();
  private exitListeners: Map<number, () => void> = new Map();
  private onChange: () => void;

  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  // Polling is driven by TerminalView — no internal timer needed

  stop() {
    this.listeners.clear();
    this.exitListeners.clear();
  }

  track(session: TerminalSession, skillName: string) {
    this.untrack(session.id);

    const now = Date.now();
    const entry: TrackedSession = {
      sessionId: session.id,
      skillName,
      startedAt: now,
      lastActivityAt: now,
      status: "working",
      stateChangedAt: now,
      recentOutputBytes: 0,
      outputWindowStart: now,
    };
    this.tracked.push(entry);
    this.attachListeners(session, entry);
    this.onChange();
  }

  private attachListeners(session: TerminalSession, entry: TrackedSession) {
    // stdout: accumulate bytes + update activity timestamp (do NOT change state here)
    const stdoutListener = (data: Buffer) => {
      const t = this.tracked.find((tr) => tr.sessionId === entry.sessionId);
      if (!t) return;
      t.lastActivityAt = Date.now();
      t.recentOutputBytes += data.length;
    };
    session.process.stdout?.on("data", stdoutListener);
    this.listeners.set(session.id, stdoutListener);

    // process exit: immediate transition to to-review
    const exitListener = () => {
      const t = this.tracked.find((tr) => tr.sessionId === entry.sessionId);
      if (t && t.status === "working") {
        t.status = "to-review";
        t.stateChangedAt = Date.now();
        this.onChange();
      }
    };
    session.process.on("exit", exitListener);
    this.exitListeners.set(session.id, exitListener);
  }

  untrack(sessionId: number) {
    this.tracked = this.tracked.filter((t) => t.sessionId !== sessionId);
    this.listeners.delete(sessionId);
    this.exitListeners.delete(sessionId);
    this.onChange();
  }

  dismiss(sessionId: number) {
    const t = this.tracked.find((t) => t.sessionId === sessionId);
    if (t) {
      t.status = "dismissed";
      t.stateChangedAt = Date.now();
      this.onChange();
    }
  }

  getWorking(): TrackedSession[] {
    return this.tracked.filter((t) => t.status === "working");
  }

  getToReview(): TrackedSession[] {
    return this.tracked.filter((t) => t.status === "to-review");
  }

  /** Read recent non-empty lines from terminal buffer */
  private getRecentLines(session: TerminalSession, count: number): string[] {
    const buf = session.terminal.buffer.active;
    const lines: string[] = [];
    for (let i = buf.length - 1; i >= Math.max(0, buf.length - 50) && lines.length < count; i--) {
      const line = buf.getLine(i)?.translateToString(true)?.trim();
      if (line) lines.push(line);
    }
    return lines;
  }

  /** Check if the terminal shows a bare shell prompt (NOT Claude Code's prompt) */
  private isShellPrompt(session: TerminalSession): boolean {
    const lines = this.getRecentLines(session, 5);
    if (lines.length === 0) return false;
    const last = lines[0];

    // If Claude Code TUI is visible in recent lines, this is NOT a shell prompt
    if (this.hasClaudeTuiMarkers(lines)) return false;

    // Common shell prompt endings
    if (/[$%#]\s*$/.test(last)) return true;
    // Oh-my-zsh arrow
    if (/^➜\s/.test(last)) return true;
    // username@host with prompt char
    if (/^\S+@\S+[^╭╰]*[$%#]\s*$/.test(last)) return true;

    return false;
  }

  /** Check if Claude Code output contains a completion marker */
  private hasClaudeCompletionMarker(lines: string[]): boolean {
    for (const line of lines) {
      if (/✻\s*(Cooked for|Done|Completed)/.test(line)) return true;
      if (/^✻\s/.test(line)) return true;
    }
    return false;
  }

  /** Check if Claude Code TUI markers are present in buffer lines */
  private hasClaudeTuiMarkers(lines: string[]): boolean {
    for (const line of lines) {
      if (/^[╭╰│]/.test(line)) return true;
      if (/Allow\?\s*\[/.test(line)) return true;
      if (/Welcome to Claude/.test(line)) return true;
      if (/^❯\s/.test(line)) return true;
    }
    return false;
  }

  /** Check if Claude Code appears active in the terminal buffer */
  private isClaudeCodeActive(session: TerminalSession): boolean {
    return this.hasClaudeTuiMarkers(this.getRecentLines(session, 30));
  }

  /** Single unified poll — called from TerminalView every 5s */
  pollWithSessions(sessions: TerminalSession[]) {
    let changed = false;
    const now = Date.now();
    const trackedIds = new Set(this.tracked.map((t) => t.sessionId));

    // --- Auto-detect: untracked sessions with Claude TUI visible + recent output ---
    for (const session of sessions) {
      if (trackedIds.has(session.id)) continue;
      if (session._lastStdoutAt === 0 || now - session._lastStdoutAt > AUTO_DETECT_WINDOW_MS) continue;
      if (!this.isClaudeCodeActive(session)) continue;

      const entry: TrackedSession = {
        sessionId: session.id,
        skillName: session.name,
        startedAt: now,
        lastActivityAt: now,
        status: "working",
        stateChangedAt: now,
        recentOutputBytes: 0,
        outputWindowStart: now,
      };
      this.tracked.push(entry);
      trackedIds.add(session.id);
      this.attachListeners(session, entry);
      changed = true;
    }

    // --- State transitions for tracked sessions ---
    for (const t of this.tracked) {
      const dwellMs = now - t.stateChangedAt;

      // Reset output byte counter periodically
      if (now - t.outputWindowStart > REVIVE_WINDOW_MS) {
        t.recentOutputBytes = 0;
        t.outputWindowStart = now;
      }

      if (t.status === "working") {
        if (dwellMs < MIN_DWELL_MS) continue;
        const idleMs = now - t.lastActivityAt;
        const session = sessions.find((s) => s.id === t.sessionId);
        if (!session) continue;

        // Only check completion marker in last 3 lines AND when idle >2s
        // Prevents false positives from old markers still in buffer after revive
        if (idleMs > 2000) {
          const tailLines = this.getRecentLines(session, 3);
          if (this.hasClaudeCompletionMarker(tailLines)) {
            t.status = "to-review";
            t.stateChangedAt = now;
            t.recentOutputBytes = 0;
            changed = true;
            continue;
          }
        }

        // Primary: idle + shell prompt visible → done
        if (idleMs > IDLE_PROMPT_MS && this.isShellPrompt(session)) {
          t.status = "to-review";
          t.stateChangedAt = now;
          t.recentOutputBytes = 0;
          changed = true;
        }
        // Safety net: very long idle → done regardless
        else if (idleMs > IDLE_SAFETY_MS) {
          t.status = "to-review";
          t.stateChangedAt = now;
          t.recentOutputBytes = 0;
          changed = true;
        }
      }
      else if (t.status === "to-review") {
        if (dwellMs < MIN_DWELL_MS) continue;
        const session = sessions.find((s) => s.id === t.sessionId);
        if (!session) continue;

        // Revive: sustained output + Claude TUI visible → back to working
        if (t.recentOutputBytes > REVIVE_BYTES && this.isClaudeCodeActive(session)) {
          t.status = "working";
          t.stateChangedAt = now;
          t.recentOutputBytes = 0;
          changed = true;
        }
      }
    }

    if (changed) this.onChange();
  }
}

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
      .setName("Auto-mode")
      .setDesc("Launch Claude Code with --dangerously-skip-permissions by default")
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
        .setValue(String(data.maxSessions ?? 8))
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

const SKILL_REGISTRY_URL = "https://raw.githubusercontent.com/klemensgc/modular-context-skills/main/registry.json";
const SKILL_BASE_URL = "https://raw.githubusercontent.com/klemensgc/modular-context-skills/main/";

interface RegistrySkill {
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
}

interface RegistryData {
  version: string;
  updated: string;
  source: string;
  skills: RegistrySkill[];
}

interface InstalledSkillInfo {
  version: string;
  installedAt: string;
  modified: boolean;
  contentHash?: string;
}

class SkillRegistry {
  private app: App;
  private plugin: TerminalPlugin;
  private cache: RegistryData | null = null;

  constructor(app: App, plugin: TerminalPlugin) {
    this.app = app;
    this.plugin = plugin;
  }

  async fetchRegistry(force = false): Promise<RegistryData | null> {
    if (this.cache && !force) return this.cache;

    // Try cached data from plugin storage first
    const pluginData = await this.plugin.loadData() ?? {};
    const cachedAt = pluginData.registryCachedAt;
    const now = Date.now();
    // Use cache if less than 1 hour old and not forced
    if (!force && cachedAt && (now - new Date(cachedAt).getTime()) < 3600000 && pluginData.registryCache) {
      this.cache = pluginData.registryCache;
      return this.cache;
    }

    try {
      const response = await requestUrl({ url: SKILL_REGISTRY_URL });
      if (response.status === 200) {
        this.cache = response.json as RegistryData;
        // Persist cache
        pluginData.registryCache = this.cache;
        pluginData.registryCachedAt = new Date().toISOString();
        await this.plugin.saveData(pluginData);
        return this.cache;
      }
    } catch (e) {
      console.warn("[mc] Failed to fetch skill registry:", e);
      // Fall back to persisted cache
      if (pluginData.registryCache) {
        this.cache = pluginData.registryCache;
        return this.cache;
      }
    }
    return null;
  }

  async getSkillStatus(skillId: string): Promise<"not-installed" | "installed" | "update-available"> {
    const adapter = this.app.vault.adapter;
    const isCommand = await this.isCommandType(skillId);
    const path = isCommand
      ? `.claude/commands/${skillId}.md`
      : `.claude/skills/${skillId}/SKILL.md`;
    const exists = await adapter.exists(path);
    if (!exists) return "not-installed";

    const registry = await this.fetchRegistry();
    if (!registry) return "installed";

    const pluginData = await this.plugin.loadData() ?? {};
    const installed = pluginData.installedSkills?.[skillId] as InstalledSkillInfo | undefined;
    if (!installed) return "installed"; // Installed but not tracked by us

    const regSkill = registry.skills.find(s => s.id === skillId);
    if (regSkill && regSkill.version !== installed.version) return "update-available";

    return "installed";
  }

  private async isCommandType(skillId: string): Promise<boolean> {
    const registry = await this.fetchRegistry();
    if (!registry) return false;
    const skill = registry.skills.find(s => s.id === skillId);
    return skill?.type === "command";
  }

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + ch;
      hash |= 0;
    }
    return hash.toString(36);
  }

  async isModifiedLocally(skillId: string): Promise<boolean> {
    const pluginData = await this.plugin.loadData() ?? {};
    const installed = pluginData.installedSkills?.[skillId] as InstalledSkillInfo | undefined;
    if (!installed?.contentHash) return false; // Can't tell, assume not modified

    const adapter = this.app.vault.adapter;
    const isCommand = installed ? await this.isCommandType(skillId) : false;
    const path = isCommand
      ? `.claude/commands/${skillId}.md`
      : `.claude/skills/${skillId}/SKILL.md`;

    try {
      const content = await adapter.read(path);
      const currentHash = this.simpleHash(content);
      return currentHash !== installed.contentHash;
    } catch {
      return false;
    }
  }

  async installSkill(skillId: string): Promise<boolean> {
    const registry = await this.fetchRegistry();
    if (!registry) {
      new Notice("Cannot fetch skill registry. Check your internet connection.");
      return false;
    }

    const regSkill = registry.skills.find(s => s.id === skillId);
    if (!regSkill) {
      new Notice(`Skill "${skillId}" not found in registry.`);
      return false;
    }

    const adapter = this.app.vault.adapter;
    const isCommand = regSkill.type === "command";
    const tierPath = regSkill.tier === "community" ? "community" : "core";

    try {
      if (isCommand) {
        // Commands go to .claude/commands/
        await this.ensureDir(".claude/commands");
        const url = `${SKILL_BASE_URL}${tierPath}/${skillId}/COMMAND.md`;
        const resp = await requestUrl({ url });
        const destPath = `.claude/commands/${skillId}.md`;
        await adapter.write(destPath, resp.text);

        // Track installation
        await this.trackInstall(skillId, regSkill.version, this.simpleHash(resp.text));
      } else {
        // Skills go to .claude/skills/{id}/
        const skillDir = `.claude/skills/${skillId}`;
        await this.ensureDir(skillDir);

        for (const file of regSkill.files) {
          const url = `${SKILL_BASE_URL}${tierPath}/${skillId}/${file}`;
          const resp = await requestUrl({ url });
          const destPath = `${skillDir}/${file}`;
          // Ensure subdirs exist (e.g., references/)
          const lastSlash = destPath.lastIndexOf("/");
          if (lastSlash > skillDir.length) {
            await this.ensureDir(destPath.substring(0, lastSlash));
          }
          await adapter.write(destPath, resp.text);
        }

        // Track installation with hash of main SKILL.md
        const mainContent = await adapter.read(`${skillDir}/SKILL.md`);
        await this.trackInstall(skillId, regSkill.version, this.simpleHash(mainContent));
      }

      return true;
    } catch (e) {
      console.error(`[mc] Failed to install skill ${skillId}:`, e);
      new Notice(`Failed to install "${regSkill.label}". Check console for details.`);
      return false;
    }
  }

  async installMultiple(skillIds: string[], onProgress?: (done: number, total: number) => void): Promise<number> {
    let installed = 0;
    for (let i = 0; i < skillIds.length; i++) {
      const ok = await this.installSkill(skillIds[i]);
      if (ok) installed++;
      onProgress?.(i + 1, skillIds.length);
    }
    return installed;
  }

  private async ensureDir(path: string) {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(path))) {
      await adapter.mkdir(path);
    }
  }

  private async trackInstall(skillId: string, version: string, contentHash: string) {
    const pluginData = await this.plugin.loadData() ?? {};
    if (!pluginData.installedSkills) pluginData.installedSkills = {};
    pluginData.installedSkills[skillId] = {
      version,
      installedAt: new Date().toISOString().split("T")[0],
      modified: false,
      contentHash,
    } as InstalledSkillInfo;
    await this.plugin.saveData(pluginData);
  }
}

// --- Plugin ---

export default class TerminalPlugin extends Plugin {
  agentTracker!: AgentTracker;
  skillRegistry!: SkillRegistry;
  async onload() {
    // Ensure pty-helper.py exists in the plugin directory.
    // BRAT and Obsidian's plugin installer only copy main.js, manifest.json,
    // and styles.css, so we write it ourselves on every load.
    const fs = require("fs");
    const path = require("path");
    const vaultBase = (this.app.vault.adapter as any).basePath as string;
    const helperPath = path.join(vaultBase, this.manifest.dir, "pty-helper.py");
    try {
      fs.writeFileSync(helperPath, PTY_HELPER_PY, { mode: 0o755 });
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
          if (view.fullscreenManager?.isOpen) {
            view.fullscreenManager.setLayout(layout as any);
          } else {
            view.setInlineLayout(layout as any);
          }
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
    this.agentTracker.stop();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }
}
