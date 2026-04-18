/** AppShell — 3-panel layout (file tree | editor | terminal) with resizable splitters.
 *  Returns the three panel elements so feature modules can render into them. */

export interface AppShellElements {
  treeEl: HTMLElement;
  editorEl: HTMLElement;
  terminalEl: HTMLElement;
}

interface PaneSizes {
  tree: number;
  terminal: number;
}

const STORAGE_KEY = "mc-app-pane-sizes";
const DEFAULT_SIZES: PaneSizes = { tree: 280, terminal: 420 };
const MIN_TREE = 180;
const MAX_TREE = 520;
const MIN_TERMINAL = 280;
const MAX_TERMINAL = 720;

function loadSizes(): PaneSizes {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SIZES };
    const parsed = JSON.parse(raw);
    return {
      tree: clamp(parsed.tree ?? DEFAULT_SIZES.tree, MIN_TREE, MAX_TREE),
      terminal: clamp(parsed.terminal ?? DEFAULT_SIZES.terminal, MIN_TERMINAL, MAX_TERMINAL),
    };
  } catch {
    return { ...DEFAULT_SIZES };
  }
}

function saveSizes(sizes: PaneSizes) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes));
  } catch {}
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function createAppShell(root: HTMLElement): AppShellElements {
  root.innerHTML = "";

  // Wrapper div holds the grid; root (#app) stays as flex-column container.
  const shellEl = document.createElement("div");
  shellEl.className = "mc-app-shell";
  root.appendChild(shellEl);

  const sizes = loadSizes();
  const updateGrid = () => {
    shellEl.style.gridTemplateColumns = `${sizes.tree}px 4px 1fr 4px ${sizes.terminal}px`;
  };
  updateGrid();

  const treeEl = document.createElement("aside");
  treeEl.className = "mc-app-tree";
  shellEl.appendChild(treeEl);

  const splitter1 = document.createElement("div");
  splitter1.className = "mc-app-splitter";
  splitter1.dataset.side = "tree";
  shellEl.appendChild(splitter1);

  const editorEl = document.createElement("section");
  editorEl.className = "mc-app-editor";
  shellEl.appendChild(editorEl);

  const splitter2 = document.createElement("div");
  splitter2.className = "mc-app-splitter";
  splitter2.dataset.side = "terminal";
  shellEl.appendChild(splitter2);

  const terminalEl = document.createElement("aside");
  terminalEl.className = "mc-app-terminal";
  shellEl.appendChild(terminalEl);

  function wireSplitter(el: HTMLElement, side: "tree" | "terminal") {
    let dragging = false;
    let startX = 0;
    let startSize = 0;

    el.addEventListener("pointerdown", (e) => {
      dragging = true;
      startX = e.clientX;
      startSize = side === "tree" ? sizes.tree : sizes.terminal;
      el.setPointerCapture(e.pointerId);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });

    el.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const delta = e.clientX - startX;
      if (side === "tree") {
        sizes.tree = clamp(startSize + delta, MIN_TREE, MAX_TREE);
      } else {
        sizes.terminal = clamp(startSize - delta, MIN_TERMINAL, MAX_TERMINAL);
      }
      updateGrid();
    });

    const finish = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      el.releasePointerCapture(e.pointerId);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      saveSizes(sizes);
      // Notify terminal pane to re-fit
      window.dispatchEvent(new CustomEvent("mc:panes-resized"));
    };
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", finish);
  }

  wireSplitter(splitter1, "tree");
  wireSplitter(splitter2, "terminal");

  return { treeEl, editorEl, terminalEl };
}
