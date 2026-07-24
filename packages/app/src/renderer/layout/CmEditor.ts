/** CmEditor — CodeMirror 6 markdown editor pane.
 *
 *  Replacement for the diagnostic <textarea> EditorPane. Root cause of the
 *  original "CM6 renders but ignores scroll/input" failure was duplicate
 *  copies of @codemirror/state (x3) and @codemirror/view (x2) in the esbuild
 *  bundle — extensions created by one copy are not recognized by an
 *  EditorView/EditorState from another copy, so keymaps/event handlers and
 *  scroll never wire up. See packages/app/CM6-DIAGNOSIS.md for details and
 *  the required dedupe fix.
 *
 *  This implementation additionally hardens the two CSS/layout pitfalls:
 *  - .cm-editor gets an explicit height via theme ("&": height 100% +
 *    flex 1 1 auto) so it fills the flex-column .mc-app-editor-host inside
 *    the .mc-app-shell grid.
 *  - .cm-scroller gets overflow: auto so long documents scroll internally
 *    instead of being clipped by the host's overflow: hidden.
 *
 *  Interface is a superset of EditorPane: constructor(container), open(path),
 *  save(), destroy() + setExternalContent(content), isDirty(), getPath().
 */

import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  dropCursor,
  highlightActiveLine,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching } from "@codemirror/language";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { tags as t } from "@lezer/highlight";
import { marked } from "marked";
import { showContextMenu } from "./ContextMenu";

interface McVaultApi {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

export interface CmEditorOptions {
  /** Resolve a [[wiki-link]] target to an absolute file path (null = unresolved). */
  resolveWiki?: (target: string) => string | null;
  /** Open a path through the tab system (wiki-link navigation). Falls back to
   *  this.open() if not provided. */
  onNavigate?: (path: string) => void;
}

// --- Reading view helpers ---------------------------------------------------

/** Split YAML frontmatter from the body. Flat key: value parsing only —
 *  enough for the methodology's standard fields (title/updated/status/...). */
function splitFrontmatter(content: string): { props: Array<[string, string]>; body: string } {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { props: [], body: content };
  const props: Array<[string, string]> = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim().replace(/^["']|["']$/g, "");
    if (value.startsWith("[") && value.endsWith("]") && !value.startsWith("[[")) {
      value = value.slice(1, -1); // [a, b] → a, b
    }
    props.push([kv[1], value]);
  }
  return { props, body: content.slice(m[0].length) };
}

/** Turn [[target]] / [[target|alias]] into anchor tags BEFORE markdown parsing. */
function preprocessWikiLinks(body: string): string {
  return body.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_all, target: string, alias?: string) => {
    const label = (alias ?? target.split("/").pop() ?? target).trim();
    const t = target.trim().replace(/"/g, "&quot;");
    return `<a class="mc-wiki" data-target="${t}">${label}</a>`;
  });
}

/** Text-like extensions the editor will open. Anything else shows a binary placeholder.
 *  (Copied from EditorPane.ts — keep in sync until EditorPane is retired.) */
const TEXT_EXTENSIONS = new Set([
  "md", "markdown", "txt", "text", "log",
  "json", "yaml", "yml", "toml", "xml", "csv", "tsv",
  "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "py", "rb", "rs", "go", "java", "kt", "swift", "c", "h", "cpp", "hpp",
  "sh", "bash", "zsh", "fish",
  "html", "htm", "css", "scss", "sass", "less",
  "vue", "svelte", "astro",
  "gitignore", "env", "dockerfile",
]);

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB hard cap

const AUTOSAVE_DELAY_MS = 1500;

function extOf(path: string): string {
  const base = path.split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

function isTextFile(path: string): boolean {
  const ext = extOf(path);
  if (!ext) return true; // dotfiles
  return TEXT_EXTENSIONS.has(ext);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** Absolute path → file:// URL (each segment encoded; spaces etc. handled). */
function fileUrl(absPath: string): string {
  return "file://" + absPath.split("/").map(encodeURIComponent).join("/");
}

const MONO_FONT = 'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace';
const UI_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", sans-serif';

/** Dark theme matching the app palette (bg #0d0d0d, accent #d16d10).
 *  CRITICAL: "&" height 100% + ".cm-scroller" overflow auto — without these
 *  CM6 sizes itself to its content inside the flex host and never scrolls. */
const appTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      flex: "1 1 auto",
      minHeight: "0",
      minWidth: "0",
      backgroundColor: "#1e1e1e", // matches --mc-bg-editor (Obsidian content surface)
      color: "#cfcfcf",
      fontSize: "12.5px",
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-scroller": {
      overflow: "auto",
      fontFamily: UI_FONT,
      lineHeight: "1.62",
    },
    ".cm-content": {
      padding: "16px 26px 140px 26px",
      caretColor: "#d16d10",
    },
    ".cm-line": {
      padding: "0",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "#d16d10",
      borderLeftWidth: "2px",
    },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "rgba(209, 109, 16, 0.25)",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(255, 255, 255, 0.025)",
    },
    ".cm-matchingBracket": {
      backgroundColor: "rgba(209, 109, 16, 0.18)",
      outline: "none",
    },
  },
  { dark: true }
);

/** Markdown-focused highlight style; one-dark as fallback for fenced code. */
const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.28em", fontWeight: "650", color: "#f5f5f5" },
  { tag: t.heading2, fontSize: "1.15em", fontWeight: "650", color: "#efefef" },
  { tag: t.heading3, fontSize: "1.06em", fontWeight: "600", color: "#eaeaea" },
  { tag: t.heading, fontWeight: "600", color: "#e4e4e4" },
  { tag: t.strong, fontWeight: "700", color: "#f0f0f0" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "#7a7a7a" },
  { tag: t.link, color: "#d16d10" },
  { tag: t.url, color: "#a85a23" },
  { tag: t.monospace, fontFamily: MONO_FONT, fontSize: "0.92em", color: "#f0a060" },
  { tag: t.quote, color: "#9a9a9a", fontStyle: "italic" },
  { tag: t.contentSeparator, color: "#555" },
  { tag: [t.meta, t.processingInstruction], color: "#6a6a6a" },
  { tag: t.comment, color: "#777" },
]);

export class CmEditor {
  private container: HTMLElement;
  private headerEl: HTMLElement;
  private pathEl: HTMLElement;
  private modeBtn: HTMLButtonElement;
  private shareBtn!: HTMLButtonElement;
  private hostEl: HTMLElement;
  private view: EditorView | null = null;
  private currentPath: string | null = null;
  private saveTimer: number | null = null;
  private dirty = false;
  /** Guard: updateListener must not mark external/setState changes as dirty. */
  private suppressDirty = false;
  /** Timestamp of our last write — used to ignore the watcher echo of our own save. */
  private lastSaveAt = 0;
  private conflictBanner: HTMLElement | null = null;
  private opts: CmEditorOptions;
  /** Reading view (Obsidian-like rendered markdown) vs raw CM6 editing. */
  private mode: "read" | "edit" = "read";
  /** Last loaded content — reading view re-renders from it. */
  private lastContent = "";

  constructor(container: HTMLElement, opts: CmEditorOptions = {}) {
    this.container = container;
    this.opts = opts;
    this.container.classList.add("mc-app-editor-root");

    this.headerEl = document.createElement("div");
    this.headerEl.className = "mc-app-editor-header";
    this.pathEl = document.createElement("span");
    this.pathEl.className = "mc-app-editor-path";
    this.pathEl.textContent = "No file open";
    this.headerEl.appendChild(this.pathEl);
    this.modeBtn = document.createElement("button");
    this.modeBtn.className = "mc-app-editor-mode";
    this.modeBtn.style.display = "none";
    this.modeBtn.addEventListener("click", () => void this.toggleMode());
    this.headerEl.appendChild(this.modeBtn);

    // Share / Export — send the current file somewhere.
    this.shareBtn = document.createElement("button");
    this.shareBtn.className = "mc-app-editor-mode mc-app-editor-share";
    this.shareBtn.title = "Share / export this file";
    this.shareBtn.style.display = "none";
    this.shareBtn.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="M12 3v13M8 7l4-4 4 4"/></svg>';
    this.shareBtn.addEventListener("click", (e) => this.openShareMenu(e));
    this.headerEl.appendChild(this.shareBtn);

    this.hostEl = document.createElement("div");
    this.hostEl.className = "mc-app-editor-host";

    const emptyEl = document.createElement("div");
    emptyEl.className = "mc-app-editor-empty";
    emptyEl.innerHTML = "<p>Select a file from the tree to edit.</p>";
    this.hostEl.appendChild(emptyEl);

    container.appendChild(this.headerEl);
    container.appendChild(this.hostEl);
  }

  /** Reading ↔ editing toggle (also bound to ⌘E). */
  async toggleMode() {
    if (!this.currentPath || extOf(this.currentPath) !== "md") return;
    if (this.mode === "edit") {
      // Leaving edit: capture + persist, then render
      if (this.view) this.lastContent = this.view.state.doc.toString();
      await this.save();
      this.mode = "read";
      this.renderRead();
    } else {
      this.mode = "edit";
      this.mountView(this.lastContent);
    }
    this.updateModeBtn();
  }

  /** Share/export menu: open in the default app (Preview → macOS share sheet),
   *  reveal in Finder, or save a copy to a chosen location. */
  private openShareMenu(e: MouseEvent) {
    if (!this.currentPath) return;
    const path = this.currentPath;
    const sh = (window as any).mcShell;
    showContextMenu(
      [
        { title: "Send a copy to…", onClick: () => void sh?.saveCopy(path) },
        { title: "Open in default app", onClick: () => void sh?.openPath(path) },
        { title: "Reveal in Finder", onClick: () => void sh?.showItemInFolder(path) },
      ],
      e.clientX,
      e.clientY,
    );
  }

  private updateModeBtn() {
    const isMd = !!this.currentPath && extOf(this.currentPath) === "md";
    this.modeBtn.style.display = isMd ? "" : "none";
    this.shareBtn.style.display = this.currentPath ? "" : "none";
    this.modeBtn.title = this.mode === "read" ? "Edit (⌘E)" : "Reading view (⌘E)";
    this.modeBtn.innerHTML = this.mode === "read"
      ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>'
      : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>';
  }

  async open(path: string) {
    // Navigating away from an unresolved conflict = the disk version wins
    if (this.conflictBanner) {
      this.dismissConflictBanner();
      this.dirty = false;
    }
    if (this.dirty && this.currentPath) {
      await this.save();
    }

    this.currentPath = path;
    this.dirty = false;
    this.updateHeader();

    const ext = extOf(path);

    // PDF → Chromium's built-in viewer (read-only) in an iframe.
    if (ext === "pdf") {
      this.showPlaceholder(
        `<iframe class="mc-app-pdf" src="${fileUrl(path)}" title="PDF preview"></iframe>`,
      );
      this.updateModeBtn();
      return;
    }
    // Images → inline preview.
    if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"].includes(ext)) {
      this.showPlaceholder(
        `<div class="mc-app-image-wrap"><img class="mc-app-image" src="${fileUrl(path)}" alt="${escapeHtml(path.split("/").pop() || "")}"></div>`,
      );
      this.updateModeBtn();
      return;
    }

    // Other binaries → placeholder.
    if (!isTextFile(path)) {
      const name = path.split("/").pop() || path;
      this.showPlaceholder(`
        <div class="mc-app-binary-placeholder">
          <div class="mc-app-binary-icon">&#128196;</div>
          <div class="mc-app-binary-name">${escapeHtml(name)}</div>
          <div class="mc-app-binary-type">Binary file (.${escapeHtml(ext || "unknown")}) &mdash; preview not supported</div>
        </div>
      `);
      return;
    }

    const mcVault = (window as any).mcVault as McVaultApi;
    let content: string;
    try {
      content = await mcVault.readFile(path);
    } catch (err) {
      console.error("[CmEditor] readFile failed:", err);
      this.headerEl.textContent = `Error reading file: ${err}`;
      this.showPlaceholder(`<div style="padding:40px;color:#ff6b6b">Error: ${escapeHtml(String(err))}</div>`);
      return;
    }

    // Stale-response guard: user may have clicked another file while reading.
    if (this.currentPath !== path) return;

    if (content.length > MAX_FILE_SIZE) {
      this.showPlaceholder(`
        <div class="mc-app-binary-placeholder">
          <div class="mc-app-binary-icon">&#9888;&#xfe0e;</div>
          <div class="mc-app-binary-name">${escapeHtml(path.split("/").pop() || path)}</div>
          <div class="mc-app-binary-type">File too large (${(content.length / 1024 / 1024).toFixed(1)} MB) &mdash; editor cap is 5 MB</div>
        </div>
      `);
      return;
    }

    this.lastContent = content;
    // Markdown opens in the reading view (Obsidian-style); other text = raw edit.
    if (extOf(path) === "md" && this.mode === "read") {
      this.renderRead();
    } else {
      if (extOf(path) !== "md") this.mode = "edit";
      this.mountView(content);
    }
    this.updateModeBtn();
  }

  // --- Reading view (rendered markdown + properties) -------------------------

  private renderRead() {
    this.destroyView();
    this.hostEl.innerHTML = "";

    const root = document.createElement("div");
    root.className = "mc-app-read-root";

    const name = (this.currentPath ?? "").split("/").pop()?.replace(/\.md$/i, "") ?? "";
    const title = document.createElement("h1");
    title.className = "mc-app-read-title";
    title.textContent = name;
    root.appendChild(title);

    const { props, body } = splitFrontmatter(this.lastContent);
    if (props.length > 0) {
      const propsEl = document.createElement("div");
      propsEl.className = "mc-app-props";
      const propsHeader = document.createElement("div");
      propsHeader.className = "mc-app-props-header";
      propsHeader.textContent = "Properties";
      propsEl.appendChild(propsHeader);
      for (const [key, value] of props) {
        const row = document.createElement("div");
        row.className = "mc-app-props-row";
        const k = document.createElement("span");
        k.className = "mc-app-props-key";
        k.textContent = key;
        row.appendChild(k);
        const v = document.createElement("span");
        v.className = "mc-app-props-value";
        // Wiki-links in values render as clickable pills
        if (value.includes("[[")) {
          v.innerHTML = preprocessWikiLinks(escapeHtml(value).replace(/&quot;/g, '"'));
        } else {
          v.textContent = value;
        }
        row.appendChild(v);
        propsEl.appendChild(row);
      }
      root.appendChild(propsEl);
    }

    const bodyEl = document.createElement("div");
    bodyEl.className = "mc-app-md";
    bodyEl.innerHTML = marked.parse(preprocessWikiLinks(body), { async: false, gfm: true }) as string;
    root.appendChild(bodyEl);

    // Click handling: links navigate; a plain click in the text switches to
    // edit mode at (approximately) the clicked position — Obsidian-style.
    root.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest("a") as HTMLAnchorElement | null;
      if (a) {
        e.preventDefault();
        const wikiTarget = a.dataset.target;
        if (wikiTarget) {
          const resolved = this.opts.resolveWiki?.(wikiTarget) ?? null;
          if (resolved) {
            if (this.opts.onNavigate) this.opts.onNavigate(resolved);
            else void this.open(resolved);
          }
          return;
        }
        // External URLs → system browser
        if (a.href && /^https?:/.test(a.href)) {
          (window as any).mcShell?.openExternal?.(a.href);
        }
        return;
      }
      // Drag-selection (copying text) must not flip into edit mode
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      this.enterEditAtClick(e);
    });

    this.hostEl.appendChild(root);
  }

  /** Switch to edit mode, best-effort placing the cursor where the user
   *  clicked: probe the text under the pointer and find it in the source.
   *  Rendered text differs from markdown (no ** markers etc.), so this is a
   *  heuristic — on miss the cursor lands at the start, still in edit mode. */
  private enterEditAtClick(e: MouseEvent) {
    let probe = "";
    let probeOffset = 0;
    const range = (document as any).caretRangeFromPoint?.(e.clientX, e.clientY) as Range | undefined;
    if (range && range.startContainer.nodeType === Node.TEXT_NODE) {
      const txt = range.startContainer.textContent ?? "";
      const off = range.startOffset;
      const start = Math.max(0, off - 24);
      probe = txt.slice(start, off + 24).trim();
      probeOffset = Math.min(off - start, probe.length);
    }

    this.mode = "edit";
    this.mountView(this.lastContent);
    this.updateModeBtn();

    if (!this.view) return;
    let pos = -1;
    if (probe.length >= 6) {
      const idx = this.lastContent.indexOf(probe);
      if (idx >= 0) pos = idx + probeOffset;
      else {
        // Fallback: first half of the probe (rendered text may span styling)
        const half = probe.slice(0, Math.max(6, Math.floor(probe.length / 2)));
        const idx2 = this.lastContent.indexOf(half);
        if (idx2 >= 0) pos = idx2 + Math.min(probeOffset, half.length);
      }
    }
    if (pos >= 0) {
      this.view.dispatch({
        selection: { anchor: Math.min(pos, this.view.state.doc.length) },
        scrollIntoView: true,
      });
    }
  }

  /** Replace editor content after the file changed on disk (file watcher,
   *  agent edits, git checkout). Does NOT mark the buffer dirty.
   *  If the user has unsaved local edits, external content wins — callers
   *  that want to protect local edits should check isDirty() first. */
  setExternalContent(content: string) {
    if (!this.view) return;
    const current = this.view.state.doc.toString();
    if (current === content) return;

    if (this.dirty) {
      console.warn("[CmEditor] setExternalContent over unsaved local edits — external content wins");
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    const prevSelection = this.view.state.selection.main.head;
    this.suppressDirty = true;
    try {
      this.view.dispatch({
        changes: { from: 0, to: this.view.state.doc.length, insert: content },
        selection: { anchor: Math.min(prevSelection, content.length) },
      });
    } finally {
      this.suppressDirty = false;
    }
    this.dirty = false;
    this.updateHeader();
  }

  async save() {
    if (!this.view || !this.currentPath || !this.dirty) return;
    // A conflict banner means the file changed under us — autosave must not
    // clobber the on-disk version until the user picks Reload / Keep mine.
    if (this.conflictBanner) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const mcVault = (window as any).mcVault as McVaultApi;
    const content = this.view.state.doc.toString();
    try {
      this.lastSaveAt = Date.now();
      await mcVault.writeFile(this.currentPath, content);
      this.lastContent = content;
      this.dirty = false;
      this.updateHeader();
    } catch (err) {
      console.error("[CmEditor] Save failed:", err);
    }
  }

  /** Called by the renderer when the vault watcher reports a modify event.
   *  An agent in the terminal pane editing the open file is the everyday case —
   *  without this, the 1.5s autosave would silently overwrite the agent's work. */
  async handleExternalChange(path: string) {
    if (!this.currentPath || path !== this.currentPath) return;
    // Watcher echo of our own save (awaitWriteFinish gives ~300-400ms lag)
    if (Date.now() - this.lastSaveAt < 2000) return;

    // Reading view has no local edits — just re-render with the fresh content
    if (this.mode === "read" && extOf(path) === "md") {
      const mcVault = (window as any).mcVault as McVaultApi;
      try {
        this.lastContent = await mcVault.readFile(path);
        this.renderRead();
      } catch (err) {
        console.error("[CmEditor] Read-view reload failed:", err);
      }
      return;
    }

    if (!this.view) return;

    if (!this.dirty) {
      const mcVault = (window as any).mcVault as McVaultApi;
      try {
        const content = await mcVault.readFile(path);
        this.setExternalContent(content);
      } catch (err) {
        console.error("[CmEditor] External reload failed:", err);
      }
      return;
    }

    // Local edits + external change = real conflict. Pause autosave, ask the user.
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.showConflictBanner(path);
  }

  private showConflictBanner(path: string) {
    if (this.conflictBanner) return;
    const banner = document.createElement("div");
    banner.className = "mc-app-editor-conflict";

    const msg = document.createElement("span");
    msg.textContent = "File changed on disk (likely an agent). Your unsaved edits conflict.";
    banner.appendChild(msg);

    const reloadBtn = document.createElement("button");
    reloadBtn.textContent = "Reload from disk";
    reloadBtn.addEventListener("click", async () => {
      this.dismissConflictBanner();
      this.dirty = false;
      await this.open(path);
    });
    banner.appendChild(reloadBtn);

    const keepBtn = document.createElement("button");
    keepBtn.textContent = "Keep my version";
    keepBtn.addEventListener("click", () => {
      this.dismissConflictBanner();
      void this.save();
    });
    banner.appendChild(keepBtn);

    this.conflictBanner = banner;
    this.container.insertBefore(banner, this.hostEl);
  }

  private dismissConflictBanner() {
    this.conflictBanner?.remove();
    this.conflictBanner = null;
  }

  /** Reset to the empty state (no tabs open). */
  clear(): void {
    void this.save();
    this.currentPath = null;
    this.dirty = false;
    this.lastContent = "";
    this.dismissConflictBanner();
    this.showPlaceholder(`<div class="mc-app-editor-empty"><p>Select a file from the tree to edit.</p></div>`);
    this.pathEl.textContent = "No file open";
    this.modeBtn.style.display = "none";
    this.shareBtn.style.display = "none";
  }

  isDirty(): boolean {
    return this.dirty;
  }

  getPath(): string | null {
    return this.currentPath;
  }

  destroy() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.dismissConflictBanner();
    this.destroyView();
  }

  // --- internals ---

  private buildExtensions() {
    return [
      // Mod-s first so it wins over any default binding.
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            this.save();
            return true;
          },
        },
        {
          key: "Mod-e",
          preventDefault: true,
          run: () => {
            void this.toggleMode();
            return true;
          },
        },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      history(),
      drawSelection(),
      dropCursor(),
      highlightActiveLine(),
      indentOnInput(),
      bracketMatching(),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage }), // GFM (tables, strikethrough, task lists)
      syntaxHighlighting(mdHighlight),
      syntaxHighlighting(oneDarkHighlightStyle, { fallback: true }), // fenced code blocks
      appTheme,
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !this.suppressDirty) {
          this.scheduleAutosave();
        }
      }),
    ];
  }

  private mountView(content: string) {
    // Simplest correct lifecycle: fresh view per file. CM6 view creation is
    // cheap at vault-note sizes and avoids stale state/undo bleeding across files.
    this.destroyView();
    this.hostEl.innerHTML = "";

    try {
      this.view = new EditorView({
        state: EditorState.create({
          doc: content,
          extensions: this.buildExtensions(),
        }),
        parent: this.hostEl,
      });
    } catch (err) {
      // A RangeError "Unrecognized extension value" here means duplicate
      // @codemirror/state copies are back in the bundle (see CM6-DIAGNOSIS.md).
      console.error("[CmEditor] EditorView mount failed:", err);
      this.showPlaceholder(
        `<div style="padding:40px;color:#ff6b6b">Editor failed to mount: ${escapeHtml(String(err))}<br><br>` +
        `If this is "Unrecognized extension value", the bundle contains duplicate copies of ` +
        `@codemirror/state — see packages/app/CM6-DIAGNOSIS.md.</div>`
      );
      return;
    }

    requestAnimationFrame(() => this.view?.focus());
  }

  private showPlaceholder(html: string) {
    this.destroyView();
    this.hostEl.innerHTML = html;
  }

  private destroyView() {
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }
  }

  private scheduleAutosave() {
    this.dirty = true;
    this.updateHeader();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.save(), AUTOSAVE_DELAY_MS);
  }

  private updateHeader() {
    if (!this.currentPath) {
      this.pathEl.textContent = "No file open";
      return;
    }
    // Breadcrumb-ish: last 3 path segments, Obsidian header style
    const parts = this.currentPath.split("/").filter(Boolean);
    const crumb = parts.slice(-3).join(" / ").replace(/\.md$/i, "");
    this.pathEl.textContent = (this.dirty ? "• " : "") + crumb;
  }
}
