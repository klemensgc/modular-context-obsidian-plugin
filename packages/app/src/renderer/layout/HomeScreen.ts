/** HomeScreen — the "world dashboard" launcher shown before a vault is open.
 *
 *  Left rail: your vaults (pinned first, then recent) as rich cards with note
 *  counts and last-activity. Right: the selected vault's detail — stats and a
 *  live mini knowledge-graph (real GraphView in preview mode) plus a big Open
 *  action. First run (no vaults) shows a welcome hero. Premium, calm, dopaminey
 *  without being cheap. */

import { createRosLoader, createSignetMark, type RosLoader } from "./Loader";
import { GraphView } from "./GraphView";
import type { GraphData } from "../../main/graph";
import { showContextMenu } from "./ContextMenu";

interface ManagedVault {
  path: string;
  name: string;
  pinned: boolean;
  lastOpened: number;
}

export interface HomeScreenOptions {
  onOpenVault: (path: string) => void;
  onCreateVault: () => void;
  onPickFolder: () => void;
  /** Enter the vault and run synthesis over the backlog (uses saved per-file notes). */
  onSynthesise: (path: string) => void;
  /** Enter the vault and launch one of the action archetypes. */
  onAction: (path: string, archetype: ActionArchetype) => void;
  /** Enter the vault and launch a free-typed prompt straight away. */
  onPrompt: (path: string, text: string) => void;
  /** Enter the vault and run /log (clicking the sync line). */
  onLog: (path: string) => void;
}

export type ActionArchetype = "comms-review" | "strategize" | "copywrite" | "research";

/** The four "moves" overlaid low on the graph. Each (Comms Review · Strategize ·
 *  Copywrite · Research) grounds itself in the LIVE vault state at runtime via its
 *  prompt in ACTION_PROMPTS (index.ts), never hardcoded. */
const ACTIONS: Array<{ key: ActionArchetype; label: string; desc: string; icon: string }> = [
  {
    key: "comms-review",
    label: "Comms Review",
    desc: "Triage inbox, Slack, ClickUp — what needs a reply",
    icon: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="m9 10 2 2 4-4"/></svg>',
  },
  {
    key: "strategize",
    label: "Strategize",
    desc: "Step back — read the board, name the priority",
    icon: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V4M4 4h11l-2 3 2 3H4"/></svg>',
  },
  {
    key: "copywrite",
    label: "Copywrite",
    desc: "Write in the house voice — email, post, pitch",
    icon: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  },
  {
    key: "research",
    label: "Research",
    desc: "Dig into a topic across the vault (and web)",
    icon: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  },
];

interface BacklogItem {
  name: string;
  mtime: number;
  sizeKB: number;
}

interface McVaultHome {
  getManaged(): Promise<ManagedVault[]>;
  stats(path: string): Promise<{ noteCount: number; wordCount: number; lastActivityMs: number }>;
  buildGraph(path: string): Promise<GraphData>;
  forget(path: string): Promise<void>;
  setPinned(path: string, pinned: boolean): Promise<void>;
  backlog(path: string): Promise<BacklogItem[]>;
  getFileNotes(path: string): Promise<Record<string, string>>;
  setFileNote(path: string, filename: string, text: string): Promise<void>;
  addToBacklog(path: string, filePaths: string[]): Promise<void>;
  removeFromBacklog(path: string, filename: string): Promise<void>;
}

export class HomeScreen {
  private root: HTMLElement;
  private opts: HomeScreenOptions;
  private el: HTMLElement;
  private listEl!: HTMLElement;
  private detailEl!: HTMLElement;

  private vaults: ManagedVault[] = [];
  private selected: string | null = null;
  private heroLoader: RosLoader | null = null;
  private graph: GraphView | null = null;
  private graphCache = new Map<string, GraphData>();
  private destroyed = false;
  /** Guards against a slow graph build landing on a since-changed selection. */
  private selectToken = 0;

  constructor(root: HTMLElement, opts: HomeScreenOptions) {
    this.root = root;
    this.opts = opts;
    this.el = document.createElement("div");
    this.el.className = "mc-home";
    root.appendChild(this.el);
    void this.load();
  }

  private get api(): McVaultHome {
    return (window as any).mcVault as McVaultHome;
  }

  private async load(): Promise<void> {
    try {
      this.vaults = await this.api.getManaged();
    } catch {
      this.vaults = [];
    }
    if (this.destroyed) return;
    this.render();
  }

  private render(): void {
    this.el.innerHTML = "";
    this.teardownGraph();
    this.heroLoader?.destroy();
    this.heroLoader = null;

    if (this.vaults.length === 0) {
      this.renderFirstRun();
      return;
    }

    // Two-pane dashboard
    const sidebar = document.createElement("aside");
    sidebar.className = "mc-home-sidebar";
    this.el.appendChild(sidebar);

    // Brand header (drag region — sits under the traffic lights)
    const brand = document.createElement("div");
    brand.className = "mc-home-brand";
    brand.appendChild(createSignetMark(20));
    const brandText = document.createElement("div");
    brandText.className = "mc-home-brand-text";
    brandText.innerHTML = `<strong>Modular Context</strong><span>by receptionOS</span>`;
    brand.appendChild(brandText);
    sidebar.appendChild(brand);

    const label = document.createElement("div");
    label.className = "mc-home-label";
    label.textContent = "YOUR VAULTS";
    sidebar.appendChild(label);

    this.listEl = document.createElement("div");
    this.listEl.className = "mc-home-vaults";
    sidebar.appendChild(this.listEl);

    // Actions pinned to the bottom of the rail
    const actions = document.createElement("div");
    actions.className = "mc-home-actions";
    const newBtn = document.createElement("button");
    newBtn.className = "mc-home-new";
    newBtn.innerHTML = `<span class="mc-home-new-plus">+</span> New vault`;
    newBtn.addEventListener("click", () => this.opts.onCreateVault());
    actions.appendChild(newBtn);
    const openOther = document.createElement("button");
    openOther.className = "mc-home-open-other";
    openOther.textContent = "Open a folder…";
    openOther.addEventListener("click", () => this.opts.onPickFolder());
    actions.appendChild(openOther);
    sidebar.appendChild(actions);

    this.detailEl = document.createElement("section");
    this.detailEl.className = "mc-home-detail";
    this.el.appendChild(this.detailEl);

    this.renderList();
    // Auto-select the top (most recent / pinned) vault.
    this.select(this.vaults[0].path);
  }

  private renderList(): void {
    this.listEl.innerHTML = "";
    for (const v of this.vaults) {
      const card = document.createElement("button");
      card.className = "mc-home-vault";
      if (v.path === this.selected) card.classList.add("is-active");
      card.dataset.path = v.path;

      const dot = document.createElement("span");
      dot.className = "mc-home-vault-glyph";
      dot.innerHTML = createSignetMark(15).innerHTML;
      card.appendChild(dot);

      const text = document.createElement("span");
      text.className = "mc-home-vault-text";
      const name = document.createElement("span");
      name.className = "mc-home-vault-name";
      name.textContent = v.name;
      if (v.pinned) {
        const pin = document.createElement("span");
        pin.className = "mc-home-vault-pin";
        pin.textContent = "★";
        pin.title = "Pinned";
        name.appendChild(pin);
      }
      text.appendChild(name);
      const meta = document.createElement("span");
      meta.className = "mc-home-vault-meta";
      meta.textContent = v.lastOpened ? relativeTime(v.lastOpened) : "never opened";
      text.appendChild(meta);
      card.appendChild(text);

      card.addEventListener("click", () => this.select(v.path));
      card.addEventListener("dblclick", () => this.opts.onOpenVault(v.path));
      card.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showContextMenu(
          [
            { title: "Open", onClick: () => this.opts.onOpenVault(v.path) },
            { title: v.pinned ? "Unpin" : "Pin to top", onClick: () => this.togglePin(v) },
            { title: "Reveal in Finder", onClick: () => (window as any).mcShell?.showItemInFolder(v.path) },
            { title: "", separator: true, onClick: () => {} },
            { title: "Remove from list", onClick: () => this.forget(v.path) },
          ],
          e.clientX,
          e.clientY,
        );
      });

      this.listEl.appendChild(card);
    }
  }

  private async togglePin(v: ManagedVault): Promise<void> {
    try { await this.api.setPinned(v.path, !v.pinned); } catch {}
    await this.load();
    this.select(this.selected ?? v.path);
  }

  private async forget(path: string): Promise<void> {
    try { await this.api.forget(path); } catch {}
    this.graphCache.delete(path);
    if (this.selected === path) this.selected = null;
    await this.load();
  }

  private select(path: string): void {
    this.selected = path;
    const token = ++this.selectToken;
    this.renderList();
    const v = this.vaults.find((x) => x.path === path);
    if (!v) return;

    this.teardownGraph();
    this.detailEl.innerHTML = "";

    // Detail splits into a main column (title/stats/graph/enter) and a right
    // backlog aside (ingest inbox + focus notes + synthesise).
    const main = document.createElement("div");
    main.className = "mc-home-detail-main";
    this.detailEl.appendChild(main);

    // The graph is the canvas; title, stats and the prompt overlay on top of it.
    const stage = document.createElement("div");
    stage.className = "mc-home-graph-stage";
    const glow = document.createElement("div");
    glow.className = "mc-home-graph-glow";
    stage.appendChild(glow);
    const graphHost = document.createElement("div");
    graphHost.className = "mc-home-graph";
    stage.appendChild(graphHost);
    const graphHint = document.createElement("div");
    graphHint.className = "mc-home-graph-hint";
    graphHint.textContent = "Building your knowledge map…";
    stage.appendChild(graphHint);

    // Top-left overlay: vault name, path and stats laid over the graph.
    const overlayTL = document.createElement("div");
    overlayTL.className = "mc-home-graph-overlay-tl";
    const head = document.createElement("div");
    head.className = "mc-home-detail-head";
    const title = document.createElement("h1");
    title.className = "mc-home-detail-title";
    title.textContent = v.name;
    head.appendChild(title);
    const sub = document.createElement("div");
    sub.className = "mc-home-detail-path";
    sub.textContent = compactHome(v.path);
    head.appendChild(sub);
    overlayTL.appendChild(head);
    const stats = document.createElement("div");
    stats.className = "mc-home-stats";
    stats.innerHTML =
      this.statChip("…", "context modules") + this.statChip("…", "words") + this.statChip("…", "last active");
    overlayTL.appendChild(stats);

    // Last GitHub sync line — populated async from git info.
    const sync = document.createElement("div");
    sync.className = "mc-home-sync";
    overlayTL.appendChild(sync);
    void this.fillSyncLine(sync, v.path, token);

    stage.appendChild(overlayTL);

    main.appendChild(stage);

    // Bottom overlay over the graph: the prompt field + a sleek row of moves.
    const overlayBottom = document.createElement("div");
    overlayBottom.className = "mc-home-graph-overlay-bottom";

    // Free-form prompt — solid pill, sitting low over the graph.
    const promptWrap = document.createElement("div");
    promptWrap.className = "mc-home-prompt";
    const promptInput = document.createElement("input");
    promptInput.className = "mc-home-prompt-input";
    promptInput.type = "text";
    promptInput.placeholder = "Tell the agent what to do…";
    promptWrap.appendChild(promptInput);
    // Send button = the signet itself. On launch it plays a smooth in-place
    // flourish (spin + accent bloom) for ~0.5s, then the prompt fires.
    const sendBtn = document.createElement("button");
    sendBtn.className = "mc-home-prompt-send";
    sendBtn.type = "button";
    sendBtn.setAttribute("aria-label", "Launch");
    sendBtn.appendChild(createSignetMark(18));
    promptWrap.appendChild(sendBtn);

    const launch = () => {
      const text = promptInput.value.trim();
      if (!text || promptWrap.classList.contains("is-launching")) return;
      promptWrap.classList.add("is-launching");
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.setTimeout(() => this.opts.onPrompt(v.path, text), reduce ? 0 : 500);
    };
    promptInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); launch(); }
    });
    sendBtn.addEventListener("click", () => launch());
    overlayBottom.appendChild(promptWrap);

    // Action moves — sleek minimal chips matching the prompt pill (icon + label).
    const moves = document.createElement("div");
    moves.className = "mc-home-moves";
    for (const a of ACTIONS) {
      const chip = document.createElement("button");
      chip.className = "mc-home-move";
      chip.title = a.desc;
      chip.innerHTML =
        `<span class="mc-home-move-icon">${a.icon}</span>` +
        `<span class="mc-home-move-label">${a.label}</span>`;
      chip.addEventListener("click", () => this.opts.onAction(v.path, a.key));
      moves.appendChild(chip);
    }
    overlayBottom.appendChild(moves);

    // Quiet escape hatch: just open the vault without an action.
    const plain = document.createElement("button");
    plain.className = "mc-home-open-plain";
    plain.textContent = "…or just open the vault";
    plain.addEventListener("click", () => this.opts.onOpenVault(v.path));
    overlayBottom.appendChild(plain);

    stage.appendChild(overlayBottom);

    // Right: backlog inbox + focus notes + synthesise
    const aside = document.createElement("aside");
    aside.className = "mc-home-backlog";
    this.detailEl.appendChild(aside);
    void this.buildBacklog(aside, v.path, token);

    // Stats: context modules + words in the knowledge base + last activity
    void this.api.stats(path).then((s) => {
      if (token !== this.selectToken) return;
      const modEl = stats.querySelector('[data-stat="context modules"] .mc-home-stat-value');
      if (modEl) modEl.textContent = s.noteCount.toLocaleString();
      const wordEl = stats.querySelector('[data-stat="words"] .mc-home-stat-value');
      if (wordEl) wordEl.textContent = formatWords(s.wordCount);
      const lastEl = stats.querySelector('[data-stat="last active"] .mc-home-stat-value');
      if (lastEl) lastEl.textContent = s.lastActivityMs ? relativeTime(s.lastActivityMs) : "—";
    }).catch(() => {});

    // Real mini-graph (cached per vault for the session)
    const mountGraph = (data: GraphData) => {
      if (token !== this.selectToken || this.destroyed) return;
      graphHint.remove();
      this.graph = new GraphView(graphHost, { onOpenFile: () => this.opts.onOpenVault(v.path), minimal: true });
      this.graph.setData(data);
    };
    const cached = this.graphCache.get(path);
    if (cached) {
      mountGraph(cached);
    } else {
      void this.api.buildGraph(path).then((data) => {
        this.graphCache.set(path, data);
        if (token !== this.selectToken) return;
        mountGraph(data);
      }).catch(() => {
        if (token === this.selectToken) graphHint.textContent = "Couldn't build the map for this vault.";
      });
    }
  }

  /** Right-hand backlog panel: the ingest inbox, a focus textarea, and a
   *  /synthesise action that enters the vault, runs the synthesis skill with the
   *  focus notes folded in, and answers them afterwards. */
  private async buildBacklog(aside: HTMLElement, path: string, token: number): Promise<void> {
    const header = document.createElement("div");
    header.className = "mc-home-backlog-header";
    header.textContent = "BACKLOG";
    aside.appendChild(header);

    const sub = document.createElement("div");
    sub.className = "mc-home-backlog-sub";
    sub.textContent = "Files waiting to be synthesised · drop any file here";
    aside.appendChild(sub);

    const list = document.createElement("div");
    list.className = "mc-home-backlog-list";
    list.innerHTML = `<div class="mc-home-backlog-empty">Loading…</div>`;
    aside.appendChild(list);

    const synth = document.createElement("button");
    synth.className = "mc-home-synth";
    synth.innerHTML =
      `<span class="mc-home-synth-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg></span> /synthesise`;
    aside.appendChild(synth);

    // Drag-and-drop: copy any dropped files into _transcripts-backlog/.
    const onDragOver = (e: DragEvent) => { e.preventDefault(); aside.classList.add("is-drop"); };
    const onDragLeave = () => aside.classList.remove("is-drop");
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      aside.classList.remove("is-drop");
      const paths: string[] = [];
      for (const f of Array.from(e.dataTransfer?.files ?? [])) {
        const p = (f as File & { path?: string }).path;
        if (p) paths.push(p);
      }
      if (paths.length === 0) return;
      await this.api.addToBacklog(path, paths).catch(() => {});
      // Rebuild this panel in place.
      aside.innerHTML = "";
      void this.buildBacklog(aside, path, token);
    };
    aside.addEventListener("dragover", onDragOver);
    aside.addEventListener("dragleave", onDragLeave);
    aside.addEventListener("drop", onDrop);

    const [notes, items] = await Promise.all([
      this.api.getFileNotes(path).catch(() => ({} as Record<string, string>)),
      this.api.backlog(path).catch(() => [] as BacklogItem[]),
    ]);
    if (token !== this.selectToken) return;

    list.innerHTML = "";
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mc-home-backlog-empty";
      empty.innerHTML = `Inbox is empty.<br><span>Drag any file here, or drop it into <code>_transcripts-backlog/</code>.</span>`;
      list.appendChild(empty);
      synth.disabled = true;
      synth.title = "Nothing to synthesise — the inbox is empty";
    } else {
      header.textContent = `BACKLOG · ${items.length}`;
      for (const it of items) {
        list.appendChild(this.buildBacklogItem(path, it, notes[it.name] ?? ""));
      }
      synth.addEventListener("click", () => this.opts.onSynthesise(path));
    }
  }

  /** One backlog row: name + meta + a comment toggle that reveals an inline
   *  focus field saved per file. */
  private buildBacklogItem(vaultPath: string, it: BacklogItem, note: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "mc-home-backlog-item";

    const top = document.createElement("div");
    top.className = "mc-home-backlog-item-top";

    const text = document.createElement("div");
    text.className = "mc-home-backlog-item-text";
    const name = document.createElement("div");
    name.className = "mc-home-backlog-name";
    name.textContent = it.name;
    text.appendChild(name);
    const meta = document.createElement("div");
    meta.className = "mc-home-backlog-meta";
    meta.textContent = `${relativeTime(it.mtime)} · ${it.sizeKB}KB`;
    text.appendChild(meta);
    top.appendChild(text);

    const commentBtn = document.createElement("button");
    commentBtn.className = "mc-home-comment-btn";
    if (note.trim()) commentBtn.classList.add("has-note");
    commentBtn.title = note.trim() ? "Edit focus comment" : "Add a focus comment";
    commentBtn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/></svg>';
    top.appendChild(commentBtn);

    // Remove from backlog (→ Trash, recoverable)
    const removeBtn = document.createElement("button");
    removeBtn.className = "mc-home-remove-btn";
    removeBtn.title = "Remove from backlog (moves to Trash)";
    removeBtn.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    removeBtn.addEventListener("click", async () => {
      await this.api.removeFromBacklog(vaultPath, it.name).catch(() => {});
      row.style.transition = "opacity 0.15s ease";
      row.style.opacity = "0";
      window.setTimeout(() => row.remove(), 150);
    });
    top.appendChild(removeBtn);
    row.appendChild(top);

    const field = document.createElement("textarea");
    field.className = "mc-home-comment-field";
    field.placeholder = "What should the agent focus on in this file? (answered after synthesis)";
    field.value = note;
    field.style.display = note.trim() ? "block" : "none";
    row.appendChild(field);

    commentBtn.addEventListener("click", () => {
      const open = field.style.display !== "none";
      field.style.display = open ? "none" : "block";
      if (!open) field.focus();
    });

    let saveTimer: number | null = null;
    field.addEventListener("input", () => {
      commentBtn.classList.toggle("has-note", !!field.value.trim());
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => void this.api.setFileNote(vaultPath, it.name, field.value), 400);
    });

    return row;
  }

  private statChip(value: string, kind: string): string {
    return `<div class="mc-home-stat" data-stat="${kind}"><span class="mc-home-stat-value">${value}</span><span class="mc-home-stat-label">${kind}</span></div>`;
  }

  /** Populate the "last GitHub sync" line from git info (best-effort). */
  private async fillSyncLine(el: HTMLElement, path: string, token: number): Promise<void> {
    const gitIcon =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7.5-4M3 12a9 9 0 0 1 9-9 9 9 0 0 1 7.5 4"/><path d="M21 3v4h-4M3 21v-4h4"/></svg>';
    let info: any = null;
    try { info = await (window as any).mcGit?.info(path); } catch { /* git not available */ }
    if (token !== this.selectToken) return;

    let text: string;
    let state = "neutral";
    if (!info || !info.isRepo) {
      text = "Local only · not version-controlled";
    } else if (!info.remoteUrl) {
      text = "No GitHub remote";
    } else if (!info.hasUpstream) {
      text = "Remote set · not yet synced";
      state = "warn";
    } else {
      const synced = info.syncedRel ? `Synced ${info.syncedRel}` : "Synced";
      const extra: string[] = [];
      if (info.ahead > 0) extra.push(`${info.ahead} unpushed`);
      if (info.behind > 0) extra.push(`${info.behind} behind`);
      text = extra.length ? `${synced} · ${extra.join(" · ")}` : synced;
      state = info.ahead > 0 || info.behind > 0 ? "warn" : "ok";
    }
    el.dataset.state = state;
    el.innerHTML =
      `<button class="mc-home-sync-icon" type="button" title="Run /log — capture a worklog entry">${gitIcon}</button><span>${text}</span>`;
    const iconBtn = el.querySelector<HTMLElement>(".mc-home-sync-icon");
    iconBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.opts.onLog(path);
    });
  }

  private renderFirstRun(): void {
    const hero = document.createElement("div");
    hero.className = "mc-home-hero";

    this.heroLoader = createRosLoader(120);
    hero.appendChild(this.heroLoader.el);
    this.heroLoader.start();

    const title = document.createElement("h1");
    title.className = "mc-home-hero-title";
    title.textContent = "Modular Context";
    hero.appendChild(title);
    const tagline = document.createElement("p");
    tagline.className = "mc-home-hero-tagline";
    tagline.textContent = "Your AI-native second brain. Let's build your first vault.";
    hero.appendChild(tagline);

    const cta = document.createElement("div");
    cta.className = "mc-home-hero-cta";
    const create = document.createElement("button");
    create.className = "mc-home-open";
    create.innerHTML = `Create your vault <span class="mc-home-open-arrow">→</span>`;
    create.addEventListener("click", () => this.opts.onCreateVault());
    cta.appendChild(create);
    const open = document.createElement("button");
    open.className = "mc-home-open-other";
    open.textContent = "Open an existing folder";
    open.addEventListener("click", () => this.opts.onPickFolder());
    cta.appendChild(open);
    hero.appendChild(cta);

    this.el.appendChild(hero);
  }

  private teardownGraph(): void {
    this.graph?.destroy();
    this.graph = null;
  }

  /** Re-read the vault list (e.g. after a vault was created elsewhere). */
  refresh(): void {
    void this.load();
  }

  destroy(): void {
    this.destroyed = true;
    this.teardownGraph();
    this.heroLoader?.destroy();
    this.heroLoader = null;
    this.el.remove();
  }
}

// --- helpers ---

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}

function compactHome(p: string): string {
  // Best-effort ~ shortening; main also has the real home path.
  return p.replace(/^\/Users\/[^/]+/, "~");
}

/** Compact word count: 1,240 → "1,240"; 12,400 → "12.4k"; 1,240,000 → "1.2M". */
function formatWords(n: number): string {
  if (n < 10000) return n.toLocaleString();
  if (n < 1000000) return `${(n / 1000).toFixed(n < 100000 ? 1 : 0)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}
