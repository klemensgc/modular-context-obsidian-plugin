/** Terminal output bookmarks — gutter decorations + pip strip.
 *
 *  Zero Obsidian dependencies (originally used Obsidian's addClass/removeClass —
 *  replaced with standard DOM classList API). Works with any xterm.js terminal. */

// Loose type for xterm.js Terminal — avoids importing @xterm/xterm in shared.
// Using `any` here because xterm's real types are strict literal unions that
// vary across versions; the plugin/app both pass real xterm Terminal instances.
type XtermTerminal = any;

export interface Bookmark {
  id: number;
  marker: any;
  decoration: any;
  label: string;
  timestamp: number;
  pipEl: HTMLElement | null;
}

export class BookmarkManager {
  private bookmarks: Bookmark[] = [];
  private nextId = 1;
  private terminal: XtermTerminal;
  private containerEl: HTMLElement;
  private stripEl: HTMLElement;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private disposables: { dispose(): void }[] = [];

  constructor(terminal: XtermTerminal, containerEl: HTMLElement) {
    this.terminal = terminal;
    this.containerEl = containerEl;

    this.stripEl = document.createElement("div");
    this.stripEl.className = "mc-bookmark-strip";
    this.containerEl.appendChild(this.stripEl);

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
    const viewportTop = buf.viewportY;
    const cursorLine = buf.baseY + buf.cursorY;
    const isScrolledBack = viewportTop < buf.baseY;
    const line = isScrolledBack ? viewportTop : cursorLine;

    const marker = this.terminal.registerMarker(line - cursorLine);
    if (!marker) return;

    const id = this.nextId++;
    const bookmarkLabel = label || `#${id}`;

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
      // Alt buffer or other issue — decoration stays null
    }

    const pipEl = document.createElement("div");
    pipEl.className = "mc-bookmark-pip";
    pipEl.title = bookmarkLabel;
    pipEl.addEventListener("click", () => this.jumpTo(bookmark));
    this.stripEl.appendChild(pipEl);

    const bookmark: Bookmark = { id, marker, decoration, label: bookmarkLabel, timestamp: Date.now(), pipEl };
    this.bookmarks.push(bookmark);

    marker.onDispose(() => this.removeBookmark(bookmark));

    this.updateStrip();
  }

  jumpTo(bookmark: Bookmark) {
    const line = bookmark.marker.line;
    this.terminal.scrollToLine(line);

    if (bookmark.pipEl) {
      bookmark.pipEl.classList.add("is-active");
      setTimeout(() => bookmark.pipEl?.classList.remove("is-active"), 600);
    }
  }

  jumpNext() {
    if (this.bookmarks.length === 0) return;
    const sorted = [...this.bookmarks].sort((a, b) => a.marker.line - b.marker.line);
    const viewportY = this.terminal.buffer.active.viewportY;
    const next = sorted.find((b) => b.marker.line > viewportY + 1);
    this.jumpTo(next ?? sorted[0]);
  }

  jumpPrev() {
    if (this.bookmarks.length === 0) return;
    const sorted = [...this.bookmarks].sort((a, b) => a.marker.line - b.marker.line);
    const viewportY = this.terminal.buffer.active.viewportY;
    const prev = sorted.slice().reverse().find((b) => b.marker.line < viewportY);
    this.jumpTo(prev ?? sorted[sorted.length - 1]);
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
