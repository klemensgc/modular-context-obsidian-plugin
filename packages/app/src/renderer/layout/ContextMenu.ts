/** Minimal context menu component — absolute-positioned floating menu with items.
 *  Used by TerminalManager for tab right-click + FullscreenManager adapter. */

export interface ContextMenuItem {
  title: string;
  icon?: string;
  onClick: () => void;
  separator?: boolean;
}

let openMenu: HTMLElement | null = null;

function closeOpenMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
    document.removeEventListener("mousedown", handleOutsideClick, true);
    document.removeEventListener("keydown", handleEscape);
  }
}

function handleOutsideClick(e: MouseEvent) {
  if (openMenu && !openMenu.contains(e.target as Node)) {
    closeOpenMenu();
  }
}

function handleEscape(e: KeyboardEvent) {
  if (e.key === "Escape") closeOpenMenu();
}

export function showContextMenu(items: ContextMenuItem[], x: number, y: number) {
  closeOpenMenu();

  const menu = document.createElement("div");
  menu.className = "mc-app-context-menu";
  menu.style.position = "fixed";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.style.zIndex = "9999";

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "mc-app-context-menu-separator";
      menu.appendChild(sep);
      continue;
    }

    const row = document.createElement("div");
    row.className = "mc-app-context-menu-item";
    row.textContent = item.title;
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      closeOpenMenu();
      item.onClick();
    });
    menu.appendChild(row);
  }

  document.body.appendChild(menu);
  openMenu = menu;

  // Clamp to viewport
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${window.innerWidth - rect.width - 8}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${window.innerHeight - rect.height - 8}px`;
    }
  });

  // Close handlers (deferred so the originating click doesn't close immediately)
  setTimeout(() => {
    document.addEventListener("mousedown", handleOutsideClick, true);
    document.addEventListener("keydown", handleEscape);
  }, 0);
}

/** Adapter-compatible helper that maps to FullscreenContextMenuItem interface. */
export function showContextMenuFromEvent(
  items: ContextMenuItem[],
  event: MouseEvent,
) {
  showContextMenu(items, event.clientX, event.clientY);
}
