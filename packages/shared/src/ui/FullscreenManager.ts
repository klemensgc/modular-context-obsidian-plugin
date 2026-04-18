/** Fullscreen overlay manager — converts inline terminal view to full-window overlay.
 *
 *  Extracted from plugin main.ts. Decoupled from Obsidian via FullscreenAdapter
 *  which injects setIcon + context menu implementations. The `view` host is typed
 *  loose (`any`) — plugin's TerminalView and app's equivalent both satisfy
 *  structurally at runtime. */

import type { FullscreenLayout } from "./glyphs";

export interface FullscreenContextMenuItem {
  title: string;
  icon?: string;
  onClick: () => void;
}

/** Host-provided services the fullscreen manager needs from its UI toolkit. */
export interface FullscreenAdapter {
  /** Set an icon on an HTMLElement (plugin: Obsidian setIcon, app: own impl). */
  setIcon: (el: HTMLElement, iconName: string) => void;
  /** Show a context menu at mouse event position. */
  showContextMenu: (items: FullscreenContextMenuItem[], event: MouseEvent) => void;
}

/** Loose view host type — plugin's TerminalView structurally satisfies it. */
type ViewHost = any;
type HostSession = any;

export class FullscreenManager {
  private static overlayOpen = false;

  private view: ViewHost;
  private adapter: FullscreenAdapter;
  overlay: HTMLElement | null = null;
  tabBarEl: HTMLElement | null = null;
  /** Public so view.renderLayout() can target it directly when fullscreen is active. */
  gridEl: HTMLElement | null = null;
  private savedSidebarParent: HTMLElement | null = null;
  private savedSidebarNextSibling: Node | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private isRenaming = false;

  /** focusedSession delegates to view.activeSession — no independent state. */
  get focusedSession(): HostSession | null { return this.view.activeSession; }
  set focusedSession(s: HostSession | null) {
    if (s && this.view.sessions.includes(s)) this.view.activeSession = s;
    else this.view.activeSession = null;
  }

  /** layout delegates to view.displayMode.layout — no independent state. */
  get layout(): FullscreenLayout { return this.view.displayMode.layout; }
  set layout(l: FullscreenLayout) { this.view.displayMode.layout = l; }

  constructor(view: ViewHost, adapter: FullscreenAdapter) {
    this.view = view;
    this.adapter = adapter;
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

    const resolvedLayout = layout ?? this.view.displayMode.layout ?? "single";
    this.layout = resolvedLayout;

    this.overlay = document.createElement("div");
    this.overlay.className = "mc-fullscreen-overlay";

    this.gridEl = document.createElement("div");
    this.gridEl.className = "mc-fullscreen-grid";
    this.gridEl.dataset.mode = "fullscreen";
    this.gridEl.dataset.layout = resolvedLayout;
    this.overlay.appendChild(this.gridEl);

    const sidebar = this.view.sidebarEl;
    this.savedSidebarParent = sidebar.parentElement;
    this.savedSidebarNextSibling = sidebar.nextSibling;
    this.overlay.appendChild(sidebar);

    this.tabBarEl = document.createElement("div");

    this.overlay.addEventListener("keydown", (e) => {
      if (!e.metaKey) e.stopPropagation();
    });
    this.overlay.addEventListener("wheel", (e) => e.stopPropagation());

    this.overlay.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape" && !this.isRenaming) {
        const anyAutocomplete = this.view.sessions.some(
          (s: HostSession) => (s as any).autocomplete?.active
        );
        if (!anyAutocomplete) {
          e.preventDefault();
          e.stopPropagation();
          this.exit();
        }
      }
    }, true);

    document.body.appendChild(this.overlay);

    this.view.displayMode = { kind: "fullscreen", layout: resolvedLayout };
    this.view.fs = this;
    this.view.renderLayout();
    this.renderFsTabs();
    this.setupActivityCallbacks();

    this.view.updateFsIcon();

    requestAnimationFrame(() => this.overlay?.classList.add("is-visible"));

    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        for (const s of this.view.computeVisible(this.view.displayMode.layout)) s.fit();
      }, 60);
    });
    this.resizeObserver.observe(this.gridEl);
  }

  exit() {
    if (!this.overlay) return;

    this.overlay.style.pointerEvents = "none";
    this.overlay.classList.remove("is-visible");

    const overlay = this.overlay;
    setTimeout(() => overlay.remove(), 150);

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

    for (const s of this.view.sessions) {
      this.view.parkingEl.appendChild(s.containerEl);
    }

    this.clearActivityCallbacks();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);

    this.overlay = null;
    this.tabBarEl = null;
    this.gridEl = null;
    FullscreenManager.overlayOpen = false;

    const preservedLayout = this.view.displayMode.layout;
    this.view.displayMode = { kind: "inline", layout: preservedLayout };
    this.view.fs = null;
    this.view.renderLayout();
    this.view.renderTabs();

    this.view.updateFsIcon();

    requestAnimationFrame(() => {
      this.view.activeSession?.fit();
      this.view.activeSession?.focus();
    });
  }

  setLayout(layout: FullscreenLayout) {
    this.layout = layout;
    this.view.setLayout(layout);
    this.renderFsTabs();
  }

  /** Render the fullscreen tab bar: session tabs | layout switcher | actions */
  renderFsTabs() {
    if (!this.tabBarEl || this.isRenaming) return;
    while (this.tabBarEl.firstChild) this.tabBarEl.removeChild(this.tabBarEl.firstChild);

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
        this.view.switchTo(session);
        this.focusedSession = session;
      });

      tab.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const items: FullscreenContextMenuItem[] = [
          {
            title: "Rename",
            icon: "pencil",
            onClick: () => this.startTabRename(tab, label, session),
          },
        ];
        if (this.view.sessions.length > 1) {
          items.push({
            title: "Close",
            icon: "x",
            onClick: () => this.view.closeSession(session),
          });
        }
        this.adapter.showContextMenu(items, e);
      });

      tabsArea.appendChild(tab);
    }

    const newTab = document.createElement("div");
    newTab.className = "mc-fs-tab-new";
    newTab.textContent = "+";
    newTab.addEventListener("click", () => {
      this.view.createSession();
      this.setupActivityCallbacks();
    });
    tabsArea.appendChild(newTab);

    this.tabBarEl.appendChild(tabsArea);

    const controls = document.createElement("div");
    controls.className = "mc-fs-controls";

    const layoutGroup = document.createElement("div");
    layoutGroup.className = "mc-fs-layout-group";

    const layouts: { key: FullscreenLayout; label: string; svg: string }[] = [
      { key: "single",  label: "Single",      svg: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/></svg>' },
      { key: "split-h", label: "Side by side", svg: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/><line x1="6" y1="1" x2="6" y2="11"/></svg>' },
      { key: "split-v", label: "Stacked",     svg: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/><line x1="1" y1="6" x2="11" y2="6"/></svg>' },
      { key: "grid",    label: "Grid 2×2",    svg: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/><line x1="6" y1="1" x2="6" y2="11"/><line x1="1" y1="6" x2="11" y2="6"/></svg>' },
      { key: "grid-6",  label: "Grid 2×3",    svg: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/><line x1="6" y1="1" x2="6" y2="11"/><line x1="1" y1="4.3" x2="11" y2="4.3"/><line x1="1" y1="7.7" x2="11" y2="7.7"/></svg>' },
      { key: "grid-8",  label: "Grid 2×4",    svg: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/><line x1="6" y1="1" x2="6" y2="11"/><line x1="1" y1="3.5" x2="11" y2="3.5"/><line x1="1" y1="6" x2="11" y2="6"/><line x1="1" y1="8.5" x2="11" y2="8.5"/></svg>' },
      { key: "grid-12", label: "Grid 3×4",    svg: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="1" width="10" height="10" rx="1"/><line x1="4" y1="1" x2="4" y2="11"/><line x1="8" y1="1" x2="8" y2="11"/><line x1="1" y1="3.5" x2="11" y2="3.5"/><line x1="1" y1="6" x2="11" y2="6"/><line x1="1" y1="8.5" x2="11" y2="8.5"/></svg>' },
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

    const exitBtn = document.createElement("button");
    exitBtn.className = "mc-fs-exit-btn";
    this.adapter.setIcon(exitBtn, "minimize-2");
    exitBtn.title = "Exit fullscreen";
    exitBtn.addEventListener("click", () => this.exit());
    controls.appendChild(exitBtn);

    this.tabBarEl.appendChild(controls);
  }

  private startTabRename(tab: HTMLElement, label: HTMLSpanElement, session: HostSession) {
    this.isRenaming = true;

    const input = document.createElement("input");
    input.type = "text";
    input.value = session.name;
    input.className = "mc-fs-tab-rename";
    input.style.width = `${session.name.length + 1}ch`;

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
      this.view.renderLayout();
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

  private setupActivityCallbacks() {
    for (const session of this.view.sessions) {
      session.setActivityCallback((s: HostSession) => {
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

  destroy() {
    if (this.isOpen) {
      if (this.savedSidebarParent) {
        const sidebar = this.view.sidebarEl;
        this.savedSidebarParent.appendChild(sidebar);
        this.savedSidebarParent = null;
      }
      for (const s of this.view.sessions) {
        this.view.parkingEl.appendChild(s.containerEl);
      }
      this.resizeObserver?.disconnect();
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.overlay?.remove();
      this.overlay = null;
      this.tabBarEl = null;
      this.gridEl = null;
      FullscreenManager.overlayOpen = false;
      this.view.displayMode = { kind: "inline", layout: this.view.displayMode.layout };
      this.view.fs = null;
    }
  }
}
