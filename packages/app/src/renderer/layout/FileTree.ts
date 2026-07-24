/** FileTree — recursive folder tree built from flat FileEntry list.
 *  Emits `fileSelected(path)` via callback. Persists expanded state to localStorage. */

import type { FileEntry } from "@mc/shared";

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children: TreeNode[];
  entry: FileEntry;
}

export interface FileTreeOptions {
  onFileSelected: (path: string) => void;
}

export class FileTree {
  private container: HTMLElement;
  private onFileSelected: (path: string) => void;
  private root: TreeNode | null = null;
  private activePath: string | null = null;
  private expandedKey = "mc-app-tree-expanded";
  private expanded: Set<string>;
  private basePath = "";

  constructor(container: HTMLElement, options: FileTreeOptions) {
    this.container = container;
    this.onFileSelected = options.onFileSelected;
    this.expanded = this.loadExpanded();
  }

  private loadExpanded(): Set<string> {
    try {
      const raw = localStorage.getItem(this.expandedKey);
      if (raw) return new Set(JSON.parse(raw));
    } catch {}
    return new Set();
  }

  private saveExpanded() {
    try {
      localStorage.setItem(this.expandedKey, JSON.stringify([...this.expanded]));
    } catch {}
  }

  render(basePath: string, entries: FileEntry[]) {
    this.basePath = basePath;
    this.root = this.buildTree(entries);
    this.draw();
  }

  setActive(path: string | null) {
    this.activePath = path;
    this.container.querySelectorAll(".mc-app-tree-item").forEach((el) => {
      const p = (el as HTMLElement).dataset.path;
      el.classList.toggle("is-active", p === path);
    });
  }

  private buildTree(entries: FileEntry[]): TreeNode {
    const rootNode: TreeNode = {
      name: this.basePath.split("/").pop() || "vault",
      path: this.basePath,
      isDirectory: true,
      children: [],
      entry: {
        path: this.basePath,
        relativePath: "",
        name: "",
        extension: "",
        isDirectory: true,
        mtime: 0,
        size: 0,
      },
    };
    // Map from relativePath → node
    const nodeByRel = new Map<string, TreeNode>();
    nodeByRel.set("", rootNode);

    // Sort: directories first, then files, both alpha case-insensitive
    const sorted = [...entries].sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.relativePath.toLowerCase().localeCompare(b.relativePath.toLowerCase());
    });

    for (const entry of sorted) {
      const parts = entry.relativePath.split("/");
      const parentRel = parts.slice(0, -1).join("/");
      const parent = nodeByRel.get(parentRel);
      if (!parent) continue;
      const node: TreeNode = {
        name: entry.name,
        path: entry.path,
        isDirectory: entry.isDirectory,
        children: [],
        entry,
      };
      parent.children.push(node);
      if (entry.isDirectory) {
        nodeByRel.set(entry.relativePath, node);
      }
    }
    return rootNode;
  }

  private draw() {
    this.container.innerHTML = "";
    if (!this.root) return;
    const listEl = document.createElement("ul");
    listEl.className = "mc-app-tree-list";
    for (const child of this.root.children) {
      this.drawNode(child, listEl, 0);
    }
    this.container.appendChild(listEl);
  }

  private drawNode(node: TreeNode, parentUl: HTMLElement, depth: number) {
    const li = document.createElement("li");
    li.className = "mc-app-tree-node";
    if (depth > 0) li.classList.add("has-indent");

    const item = document.createElement("div");
    item.className = "mc-app-tree-item";
    item.dataset.path = node.path;
    // Tight Obsidian-like indent — small step per hierarchy level
    item.style.paddingLeft = `${8 + depth * 12}px`;
    if (node.path === this.activePath) item.classList.add("is-active");

    const chevron = document.createElement("span");
    chevron.className = "mc-app-tree-chevron";

    const label = document.createElement("span");
    label.className = "mc-app-tree-label";

    item.appendChild(chevron);
    item.appendChild(label);
    li.appendChild(item);

    if (node.isDirectory) {
      const isExpanded = this.expanded.has(node.path);
      item.classList.add("is-folder");
      if (isExpanded) item.classList.add("is-expanded");
      chevron.innerHTML = SVG_CHEVRON;
      label.textContent = node.name;

      item.addEventListener("click", () => {
        if (this.expanded.has(node.path)) {
          this.expanded.delete(node.path);
        } else {
          this.expanded.add(node.path);
        }
        this.saveExpanded();
        this.draw();
      });

      if (isExpanded && node.children.length > 0) {
        const childUl = document.createElement("ul");
        childUl.className = "mc-app-tree-list is-nested";
        for (const c of node.children) this.drawNode(c, childUl, depth + 1);
        li.appendChild(childUl);
      }
    } else {
      item.classList.add("is-file");
      const ext = node.entry.extension;
      item.classList.add(`is-ext-${ext || "none"}`);
      chevron.innerHTML = ""; // no chevron for files (visual gap aligned with folder items)

      // Hide .md extension in display (like Obsidian)
      label.textContent = ext === "md" ? node.name.replace(/\.md$/i, "") : node.name;

      // Extension badge for non-md files (PDF, PNG, etc.)
      if (ext && ext !== "md") {
        const badge = document.createElement("span");
        badge.className = "mc-app-tree-ext-badge";
        badge.textContent = ext.toUpperCase();
        item.appendChild(badge);
      }

      item.addEventListener("click", () => {
        this.setActive(node.path);
        this.onFileSelected(node.path);
      });
    }

    parentUl.appendChild(li);
  }
}

const SVG_CHEVRON = `<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 2 L6.5 5 L3.5 8"/></svg>`;
