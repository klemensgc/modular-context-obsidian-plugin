/** EditorPane — plain <textarea> markdown editor.
 *
 *  Diagnostic rewrite: CodeMirror 6 was rendering but not receiving scroll/input
 *  (unknown root cause). Swapping to native <textarea> to verify whether the
 *  layout container is actually receiving events. If textarea works, CM6 was
 *  the problem. If textarea also fails, layout/focus is the problem elsewhere. */

interface McVaultApi {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

/** Text-like extensions the editor will open. Anything else shows a binary placeholder. */
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

export class EditorPane {
  private container: HTMLElement;
  private headerEl: HTMLElement;
  private hostEl: HTMLElement;
  private textarea: HTMLTextAreaElement | null = null;
  private currentPath: string | null = null;
  private saveTimer: number | null = null;
  private dirty = false;

  constructor(container: HTMLElement) {
    this.container = container;
    this.container.classList.add("mc-app-editor-root");

    this.headerEl = document.createElement("div");
    this.headerEl.className = "mc-app-editor-header";
    this.headerEl.textContent = "No file open";

    this.hostEl = document.createElement("div");
    this.hostEl.className = "mc-app-editor-host";

    const emptyEl = document.createElement("div");
    emptyEl.className = "mc-app-editor-empty";
    emptyEl.innerHTML = "<p>Select a file from the tree to edit.</p>";
    this.hostEl.appendChild(emptyEl);

    container.appendChild(this.headerEl);
    container.appendChild(this.hostEl);
  }

  async open(path: string) {
    console.log("[EditorPane] open() called with path:", path);
    if (this.dirty && this.currentPath) {
      await this.save();
    }

    this.currentPath = path;
    this.dirty = false;
    this.updateHeader();

    // Binary file guard
    if (!isTextFile(path)) {
      const ext = extOf(path) || "unknown";
      const name = path.split("/").pop() || path;
      this.hostEl.innerHTML = `
        <div class="mc-app-binary-placeholder">
          <div class="mc-app-binary-icon">📄</div>
          <div class="mc-app-binary-name">${escapeHtml(name)}</div>
          <div class="mc-app-binary-type">Binary file (.${escapeHtml(ext)}) — preview not supported</div>
        </div>
      `;
      this.textarea = null;
      return;
    }

    const mcVault = (window as any).mcVault as McVaultApi;
    let content: string;
    try {
      content = await mcVault.readFile(path);
      console.log("[EditorPane] readFile succeeded, length:", content.length);
    } catch (err) {
      console.error("[EditorPane] readFile failed:", err);
      this.headerEl.textContent = `Error reading file: ${err}`;
      this.hostEl.innerHTML = `<div style="padding:40px;color:#ff6b6b">Error: ${String(err)}</div>`;
      this.textarea = null;
      return;
    }

    if (content.length > MAX_FILE_SIZE) {
      this.hostEl.innerHTML = `
        <div class="mc-app-binary-placeholder">
          <div class="mc-app-binary-icon">⚠︎</div>
          <div class="mc-app-binary-name">${escapeHtml(path.split("/").pop() || path)}</div>
          <div class="mc-app-binary-type">File too large (${(content.length / 1024 / 1024).toFixed(1)} MB) — editor cap is 5 MB</div>
        </div>
      `;
      this.textarea = null;
      return;
    }

    // Mount plain textarea
    this.hostEl.innerHTML = "";
    this.textarea = document.createElement("textarea");
    this.textarea.className = "mc-app-textarea";
    this.textarea.value = content;
    this.textarea.spellcheck = false;
    this.textarea.setAttribute("wrap", "soft");
    this.hostEl.appendChild(this.textarea);

    // Wire autosave on input
    this.textarea.addEventListener("input", () => this.scheduleAutosave());

    // Cmd+S manual save (handled via keydown, stops propagation)
    this.textarea.addEventListener("keydown", (e) => {
      if (e.metaKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        this.save();
      }
    });

    // Focus
    setTimeout(() => this.textarea?.focus(), 50);

    // Post-mount diagnostic
    requestAnimationFrame(() => {
      if (!this.textarea) return;
      const ta = this.textarea;
      const cs = getComputedStyle(ta);
      const host = getComputedStyle(this.hostEl);
      console.log("[EditorPane] post-mount diagnostics (textarea):", {
        taDisplay: cs.display,
        taHeight: cs.height,
        taWidth: cs.width,
        taOverflow: cs.overflow,
        taReadonly: ta.readOnly,
        taDisabled: ta.disabled,
        taTabIndex: ta.tabIndex,
        hostDisplay: host.display,
        hostHeight: host.height,
        hostOverflow: host.overflow,
        hostRect: this.hostEl.getBoundingClientRect(),
        taRect: ta.getBoundingClientRect(),
        bodyHasPointerNone: getComputedStyle(document.body).pointerEvents,
        activeElement: document.activeElement?.tagName,
      });
    });
  }

  private scheduleAutosave() {
    this.dirty = true;
    this.updateHeader();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.save(), 1500);
  }

  async save() {
    if (!this.textarea || !this.currentPath || !this.dirty) return;
    const mcVault = (window as any).mcVault as McVaultApi;
    const content = this.textarea.value;
    try {
      await mcVault.writeFile(this.currentPath, content);
      this.dirty = false;
      this.updateHeader();
    } catch (err) {
      console.error("[EditorPane] Save failed:", err);
    }
  }

  private updateHeader() {
    if (!this.currentPath) {
      this.headerEl.textContent = "No file open";
      return;
    }
    const name = this.currentPath.split("/").pop() || this.currentPath;
    this.headerEl.textContent = (this.dirty ? "• " : "") + name;
  }

  destroy() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.textarea = null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
