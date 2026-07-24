/** GraphView — Obsidian-style force-directed note graph on a canvas.
 *
 *  Self-contained physics (no external deps): many-body repulsion with grid
 *  binning for large graphs, edge springs, weak centering force, velocity +
 *  alpha decay (the sim cools down and wakes up on drag). Renders only while
 *  the sim is hot or an interaction needs a frame — idle graph costs nothing.
 *
 *  Types come from main/graph.ts via `import type` (erased at compile time,
 *  so the browser bundle never pulls in fs/path).
 */

import type { GraphData, GraphNode } from "../../main/graph";

export interface GraphViewOptions {
  onOpenFile: (absPath: string) => void;
  onClose?: () => void;
  onRefresh?: () => void;
  /** Preview mode (home dashboard): no toolbar, no wheel-zoom hijack. */
  minimal?: boolean;
}

interface SimNode {
  data: GraphNode;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Base radius in world units (== screen px at zoom 1). */
  r: number;
  /** Pin position while dragging (null = free). */
  fx: number | null;
  fy: number | null;
  /** Highlight intensity 0..1, eased per frame (smooth hover). */
  hl: number;
  /** Entrance progress 0..1 (bloom-in). 1 = fully present / never blooms. */
  bloom: number;
  /** Extra entrance delay in ms (center-out stagger). */
  bloomDelay: number;
  /** Per-node phase so living drift is desynced across the graph. */
  phase: number;
  /** Freshness rank by mtime DESC (0 = freshest); -1 for ghosts (no pulse). */
  freshRank: number;
}

interface SimEdge {
  a: number; // index into nodes
  b: number;
  /** Highlight intensity 0..1, eased per frame. */
  hl: number;
}

// --- Tuning ---------------------------------------------------------------
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
const VELOCITY_DECAY = 0.85;
const ALPHA_MIN = 0.005;
const ALPHA_DECAY = 0.0228; // ~300 ticks to cool, d3-like
const REHEAT_ALPHA = 0.3;
const REPULSION = 220; // many-body charge strength
const REPULSION_CUTOFF = 360; // grid-binning cutoff (world units)
const FULL_PAIRS_LIMIT = 600; // below this node count: exact O(n²) pass
const LINK_DISTANCE = 70;
const LINK_STRENGTH = 0.08;
const CENTER_STRENGTH = 0.015;
const LABEL_DEGREE_ALWAYS = 5;
// Zoom gates: at fit-zoom on a big vault NO labels render; hub labels fade in
// first, the rest only when you zoom into a neighborhood. Hover always shows.
const LABEL_HUB_ZOOM_START = 0.9;
const LABEL_HUB_ZOOM_RANGE = 0.3;
const LABEL_REST_ZOOM_START = 1.6;
const LABEL_REST_ZOOM_RANGE = 0.5;
const CLICK_SLOP_PX = 4;

// --- Palette (tuned for the #1e1e1e editor surface) -------------------------
const EDGE_COLOR = "#383838";
const NODE_RGB: [number, number, number] = [158, 158, 158]; // #9e9e9e
const GHOST_RGB: [number, number, number] = [88, 88, 88]; // #585858
const ACCENT_RGB: [number, number, number] = [209, 109, 16]; // #d16d10 (user accent)
const LABEL_COLOR = "#b8b8b8";
const LABEL_FONT = '10px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';
const DIM_ALPHA = 0.1; // non-neighbors while hovering
// Eased hover (Obsidian-like): per-frame lerp rates for highlight/dim fades.
const HL_EASE = 0.22;
const DIM_EASE = 0.16;
const HOVER_RADIUS_BOOST = 0.3; // hovered node grows by up to 30%

// --- Animation tuning (bloom-in, living drift, freshness pulse) -------------
// 1) BLOOM-IN: center-out staggered entrance on fresh data.
const BLOOM_DURATION_MS = 620; // per-node grow/fade window
const BLOOM_STAGGER_MS = 280; // max extra delay for the outermost node
const BLOOM_RADIUS_FLOOR = 0.04; // keep a sliver of radius so hit-test is sane
// 2) LIVING MOTION: cheap render-only drift so the graph never freezes.
const DRIFT_AMPLITUDE = 9; // world units of sway — clearly alive, still calm
const DRIFT_PERIOD_MS = 6500; // base period — slow, breathing, but noticeable
// 3) FRESHNESS PULSE: a calm wave sweeping newest→oldest by mtime.
const PULSE_SWEEP_MS = 11000; // one full newest→oldest sweep, then repeats
const PULSE_WINDOW_RANKS = 7; // soft half-width of the wave (in ranks)
const PULSE_MAX_ALPHA = 0.34; // peak halo opacity — present but not a blink
const PULSE_HALO_SCALE = 4.4; // halo radius multiplier over the node radius

// easeOutCubic — fast settle, soft landing (good for entrances).
function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

// smoothstep — 0..1 with zero-slope ends, for the breathing pulse window.
function smoothstep(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

function mixRgb(a: [number, number, number], b: [number, number, number], t: number): string {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

export class GraphView {
  private container: HTMLElement;
  private opts: GraphViewOptions;
  private toolbar: HTMLElement;
  private statEl: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;

  private width = 0; // CSS px
  private height = 0;

  private nodes: SimNode[] = [];
  private edges: SimEdge[] = [];
  private adjacency: Array<Set<number>> = [];
  private noteCount = 0;

  // View transform: screen = world * k + (tx, ty)
  private k = 1;
  private tx = 0;
  private ty = 0;

  private alpha = 0;
  private rafId: number | null = null;
  private needsRender = false;
  private destroyed = false;
  private autoFitPending = false;
  private userMovedView = false;
  /** Smooth camera: current view eases toward this target while auto-fitting. */
  private targetK = 1;
  private targetTx = 0;
  private targetTy = 0;
  private fitting = false;
  /** Idle-frame throttling + pause when the window is hidden/blurred. */
  private lastRenderTs = 0;
  private paused = false;

  // --- Animation clocks (all driven by the rAF timestamp `ts`) -------------
  /** rAF ts captured on the first frame after setData; basis for bloom timing. */
  private bloomT0 = 0;
  /** While true, at least one node is still blooming in. */
  private bloomActive = false;
  /** Count of non-ghost nodes (for the freshness pulse sweep range). */
  private freshCount = 0;
  /** Reusable per-frame buffers of drifted SCREEN positions (O(n), no alloc). */
  private screenX: Float64Array = new Float64Array(0);
  private screenY: Float64Array = new Float64Array(0);
  /** Global dim factor 0..1 — eases in when a node is hovered, out when not. */
  private dimT = 0;

  private hovered = -1;
  private dragIndex = -1;
  private panning = false;
  private pressX = 0;
  private pressY = 0;
  private pressMoved = false;
  private lastMouseX = 0;
  private lastMouseY = 0;

  constructor(container: HTMLElement, opts: GraphViewOptions) {
    this.container = container;
    this.opts = opts;
    container.classList.add("mc-graph-overlay");

    if (opts.minimal) container.classList.add("is-minimal");

    // Toolbar (stat counter + optional refresh/close buttons)
    this.toolbar = document.createElement("div");
    this.toolbar.className = "mc-graph-toolbar";
    this.statEl = document.createElement("span");
    this.statEl.className = "mc-graph-stat";
    this.statEl.textContent = "0 notes · 0 links";
    this.toolbar.appendChild(this.statEl);
    const spacer = document.createElement("span");
    spacer.className = "mc-graph-toolbar-spacer";
    this.toolbar.appendChild(spacer);
    if (opts.onRefresh) {
      const btn = document.createElement("button");
      btn.className = "mc-graph-btn";
      btn.title = "Rebuild graph";
      btn.textContent = "⟳";
      btn.addEventListener("click", () => this.opts.onRefresh?.());
      this.toolbar.appendChild(btn);
    }
    if (opts.onClose) {
      const btn = document.createElement("button");
      btn.className = "mc-graph-btn";
      btn.title = "Close graph";
      btn.textContent = "✕";
      btn.addEventListener("click", () => this.opts.onClose?.());
      this.toolbar.appendChild(btn);
    }
    if (!opts.minimal) container.appendChild(this.toolbar);

    this.canvas = document.createElement("canvas");
    this.canvas.className = "mc-graph-canvas";
    container.appendChild(this.canvas);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("GraphView: 2d canvas context unavailable");
    this.ctx = ctx;

    this.ro = new ResizeObserver(() => this.handleResize());
    this.ro.observe(this.canvas);
    this.handleResize();

    this.canvas.addEventListener("mousedown", this.onMouseDown);
    this.canvas.addEventListener("dblclick", this.onDblClick);
    // Manual zoom everywhere, including the home mini-graph (preview).
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mouseup", this.onMouseUp);
    // Stop burning CPU when the window is in the background / another desktop.
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("blur", this.onVisibility);
    window.addEventListener("focus", this.onVisibility);
  }

  private onVisibility = (): void => {
    const shouldPause = document.hidden || !document.hasFocus();
    if (shouldPause === this.paused) return;
    this.paused = shouldPause;
    if (this.paused) {
      if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    } else {
      this.lastRenderTs = 0;
      this.schedule();
    }
  };

  // --- Public API -----------------------------------------------------------

  setData(data: GraphData): void {
    const indexById = new Map<string, number>();
    // Keep old positions across refreshes so the graph doesn't jump.
    const oldPos = new Map<string, { x: number; y: number }>();
    for (const n of this.nodes) oldPos.set(n.data.id, { x: n.x, y: n.y });

    this.nodes = data.nodes.map((d, i) => {
      indexById.set(d.id, i);
      // Phyllotaxis spiral for fresh nodes — deterministic, no overlap blowup.
      const prev = oldPos.get(d.id);
      const angle = i * 2.39996; // golden angle
      const radius = 14 * Math.sqrt(i + 1);
      const baseR = 1.8 + Math.sqrt(d.degree) * 0.85;
      return {
        data: d,
        x: prev ? prev.x : Math.cos(angle) * radius,
        y: prev ? prev.y : Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
        r: d.ghost ? baseR * 0.5 : baseR,
        fx: null,
        fy: null,
        hl: 0,
        // Nodes that kept a previous position must NOT re-bloom on refresh;
        // only brand-new ids (no oldPos hit) get the entrance from scratch.
        bloom: prev ? 1 : 0,
        bloomDelay: 0,
        // Desynced phase from a deterministic index hash (golden-angle spread).
        phase: (i * 2.39996) % (Math.PI * 2),
        freshRank: -1,
      };
    });

    // Resize the drifted-position scratch buffers to the new node count.
    if (this.screenX.length !== this.nodes.length) {
      this.screenX = new Float64Array(this.nodes.length);
      this.screenY = new Float64Array(this.nodes.length);
    }

    // --- Bloom stagger: closest-to-centroid blooms first (center-out). ------
    // Computed only over the brand-new nodes; old ones already have bloom=1.
    let cx = 0, cy = 0, fresh = 0;
    for (const n of this.nodes) {
      if (n.bloom < 1) { cx += n.x; cy += n.y; fresh++; }
    }
    if (fresh > 0) {
      cx /= fresh;
      cy /= fresh;
      let maxDist = 0;
      for (const n of this.nodes) {
        if (n.bloom >= 1) continue;
        const dx = n.x - cx, dy = n.y - cy;
        n.bloomDelay = Math.sqrt(dx * dx + dy * dy); // distance for now
        if (n.bloomDelay > maxDist) maxDist = n.bloomDelay;
      }
      // Normalize distance → delay in ms (closest = 0, outermost = full stagger).
      const inv = maxDist > 1e-6 ? BLOOM_STAGGER_MS / maxDist : 0;
      for (const n of this.nodes) {
        if (n.bloom >= 1) continue;
        n.bloomDelay *= inv;
      }
      this.bloomActive = true;
      this.bloomT0 = 0; // lazily captured from the first frame ts
    } else {
      this.bloomActive = false;
    }

    this.edges = [];
    this.adjacency = this.nodes.map(() => new Set<number>());
    for (const e of data.edges) {
      const a = indexById.get(e.source);
      const b = indexById.get(e.target);
      if (a === undefined || b === undefined || a === b) continue;
      this.edges.push({ a, b, hl: 0 });
      this.adjacency[a].add(b);
      this.adjacency[b].add(a);
    }

    // --- Freshness ranking: non-ghost nodes by mtime DESC (0 = freshest). ---
    // Ghosts (mtime 0) keep freshRank = -1 and never pulse. Computed once here.
    const rankable = this.nodes.filter((n) => !n.data.ghost && n.data.mtime > 0);
    rankable.sort((a, b) => b.data.mtime - a.data.mtime);
    rankable.forEach((n, rank) => { n.freshRank = rank; });
    this.freshCount = rankable.length;

    this.noteCount = data.nodes.reduce((acc, n) => acc + (n.ghost ? 0 : 1), 0);
    this.statEl.textContent = `${this.noteCount} notes · ${this.edges.length} links`;

    this.hovered = -1;
    this.dragIndex = -1;
    this.alpha = 1;
    this.autoFitPending = true;
    this.userMovedView = false;
    this.beginSmoothFit();
    this.needsRender = true;
    this.schedule();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.ro.disconnect();
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    this.canvas.removeEventListener("dblclick", this.onDblClick);
    this.canvas.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mouseup", this.onMouseUp);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("blur", this.onVisibility);
    window.removeEventListener("focus", this.onVisibility);
    this.toolbar.remove();
    this.canvas.remove();
    this.container.classList.remove("mc-graph-overlay");
    this.nodes = [];
    this.edges = [];
    this.adjacency = [];
  }

  // --- Layout / sizing --------------------------------------------------------

  private handleResize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (w === this.width && h === this.height) return;
    const dpr = window.devicePixelRatio || 1;
    this.width = w;
    this.height = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.needsRender = true;
    this.schedule();
  }

  /** Fit all nodes into the viewport with padding (also = "reset view"). */
  /** Compute the fit transform for the current node bounds (no side effects). */
  private computeFit(): { k: number; tx: number; ty: number } | null {
    if (this.nodes.length === 0 || this.width === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.nodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
    const pad = 60;
    const bw = Math.max(maxX - minX, 1);
    const bh = Math.max(maxY - minY, 1);
    const raw = Math.min((this.width - pad * 2) / bw, (this.height - pad * 2) / bh, 1.5);
    const k = Math.min(Math.max(raw, MIN_ZOOM), MAX_ZOOM);
    return { k, tx: this.width / 2 - ((minX + maxX) / 2) * k, ty: this.height / 2 - ((minY + maxY) / 2) * k };
  }

  /** Snap the camera to fit immediately (used by dblclick reset). */
  private fitView(): void {
    const t = this.computeFit();
    if (!t) return;
    this.k = t.k; this.tx = t.tx; this.ty = t.ty;
    this.targetK = t.k; this.targetTx = t.tx; this.targetTy = t.ty;
    this.needsRender = true;
  }

  /** Begin a smooth auto-fit that tracks the graph as it blooms/spreads. */
  private beginSmoothFit(): void {
    const t = this.computeFit();
    if (!t) return;
    // Start fitted to the spawn cluster so frame 1 isn't wildly zoomed, then
    // ease toward the expanding target each frame (no abrupt zoom-out).
    this.k = t.k; this.tx = t.tx; this.ty = t.ty;
    this.targetK = t.k; this.targetTx = t.tx; this.targetTy = t.ty;
    this.fitting = true;
  }

  // --- Simulation ------------------------------------------------------------

  private get simActive(): boolean {
    return this.alpha >= ALPHA_MIN;
  }

  private reheat(): void {
    this.alpha = Math.max(this.alpha, REHEAT_ALPHA);
    this.schedule();
  }

  private tick(): void {
    const nodes = this.nodes;
    const n = nodes.length;
    if (n === 0) return;
    const alpha = this.alpha;

    // Edge springs (degree-biased like d3-force-link: heavy nodes move less).
    for (const e of this.edges) {
      const a = nodes[e.a];
      const b = nodes[e.b];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1e-6) {
        dx = (Math.random() - 0.5) * 1e-3;
        dy = (Math.random() - 0.5) * 1e-3;
        d = 1e-3;
      }
      const f = ((d - LINK_DISTANCE) / d) * LINK_STRENGTH * alpha;
      const degA = this.adjacency[e.a].size || 1;
      const degB = this.adjacency[e.b].size || 1;
      const bias = degB / (degA + degB);
      a.vx += dx * f * bias;
      a.vy += dy * f * bias;
      b.vx -= dx * f * (1 - bias);
      b.vy -= dy * f * (1 - bias);
    }

    // Many-body repulsion: exact for small graphs, grid-binned with a cutoff
    // for large ones (cheap and visually indistinguishable at this scale).
    if (n <= FULL_PAIRS_LIMIT) {
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j];
          this.applyRepulsion(a, b, alpha, Infinity);
        }
      }
    } else {
      const cell = REPULSION_CUTOFF;
      const grid = new Map<string, number[]>();
      for (let i = 0; i < n; i++) {
        const key = Math.floor(nodes[i].x / cell) + "," + Math.floor(nodes[i].y / cell);
        const bucket = grid.get(key);
        if (bucket) bucket.push(i);
        else grid.set(key, [i]);
      }
      const cutoff2 = REPULSION_CUTOFF * REPULSION_CUTOFF;
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        const cx = Math.floor(a.x / cell);
        const cy = Math.floor(a.y / cell);
        for (let gx = cx - 1; gx <= cx + 1; gx++) {
          for (let gy = cy - 1; gy <= cy + 1; gy++) {
            const bucket = grid.get(gx + "," + gy);
            if (!bucket) continue;
            for (const j of bucket) {
              if (j <= i) continue;
              this.applyRepulsion(a, nodes[j], alpha, cutoff2);
            }
          }
        }
      }
    }

    // Weak centering pull toward origin.
    for (const node of nodes) {
      node.vx -= node.x * CENTER_STRENGTH * alpha;
      node.vy -= node.y * CENTER_STRENGTH * alpha;
    }

    // Integrate + velocity decay; pinned nodes follow the pointer exactly.
    for (const node of nodes) {
      if (node.fx !== null && node.fy !== null) {
        node.x = node.fx;
        node.y = node.fy;
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      node.vx *= VELOCITY_DECAY;
      node.vy *= VELOCITY_DECAY;
      node.x += node.vx;
      node.y += node.vy;
    }

    this.alpha += (0 - this.alpha) * ALPHA_DECAY;
  }

  /** Ease the camera toward the live fit target while auto-fitting. Tracks the
   *  graph as it blooms and spreads, so there's no abrupt zoom-out at the end. */
  private updateCameraFit(): void {
    if (!this.fitting || this.userMovedView) return;
    const t = this.computeFit();
    if (!t) return;
    this.targetK = t.k; this.targetTx = t.tx; this.targetTy = t.ty;
    const e = 0.12;
    this.k += (this.targetK - this.k) * e;
    this.tx += (this.targetTx - this.tx) * e;
    this.ty += (this.targetTy - this.ty) * e;
    this.needsRender = true;
    // Settle once the sim is cool and the camera has essentially arrived.
    const close =
      Math.abs(this.k - this.targetK) < 1e-3 &&
      Math.abs(this.tx - this.targetTx) < 0.5 &&
      Math.abs(this.ty - this.targetTy) < 0.5;
    if (!this.simActive && close) {
      this.k = this.targetK; this.tx = this.targetTx; this.ty = this.targetTy;
      this.fitting = false;
      this.autoFitPending = false;
    }
  }

  private applyRepulsion(a: SimNode, b: SimNode, alpha: number, cutoff2: number): void {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let d2 = dx * dx + dy * dy;
    if (d2 > cutoff2) return;
    if (d2 < 1) {
      dx = (Math.random() - 0.5) * 2;
      dy = (Math.random() - 0.5) * 2;
      d2 = dx * dx + dy * dy + 1;
    }
    // Force ∝ 1/d (dx/d2 normalizes direction and divides by d once more).
    const w = (REPULSION * alpha) / d2;
    a.vx -= dx * w;
    a.vy -= dy * w;
    b.vx += dx * w;
    b.vy += dy * w;
  }

  // --- Render loop --------------------------------------------------------------

  private schedule(): void {
    if (this.rafId !== null || this.destroyed) return;
    this.rafId = requestAnimationFrame(this.frame);
  }

  /** Ease hover highlight/dim toward their targets. Returns true while moving. */
  private easeHover(): boolean {
    const hovered = this.hovered;
    const highlight = hovered >= 0 ? this.adjacency[hovered] : null;
    let moving = false;

    const dimTarget = hovered >= 0 ? 1 : 0;
    const dPrev = this.dimT;
    this.dimT += (dimTarget - this.dimT) * DIM_EASE;
    if (Math.abs(this.dimT - dimTarget) < 0.01) this.dimT = dimTarget;
    if (this.dimT !== dPrev) moving = true;

    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      const target = i === hovered || (highlight !== null && highlight.has(i)) ? 1 : 0;
      if (node.hl !== target) {
        node.hl += (target - node.hl) * HL_EASE;
        if (Math.abs(node.hl - target) < 0.01) node.hl = target;
        moving = true;
      }
    }
    for (const e of this.edges) {
      const target = hovered >= 0 && (e.a === hovered || e.b === hovered) ? 1 : 0;
      if (e.hl !== target) {
        e.hl += (target - e.hl) * HL_EASE;
        if (Math.abs(e.hl - target) < 0.01) e.hl = target;
        moving = true;
      }
    }
    return moving;
  }

  private frame = (ts: number): void => {
    this.rafId = null;
    if (this.destroyed || this.paused) return;

    const interactive = this.simActive || this.bloomActive || this.fitting ||
      this.dragIndex >= 0 || this.panning;

    if (this.simActive) {
      this.tick();
      this.needsRender = true;
    }
    const hoverAnimating = this.easeHover();
    if (hoverAnimating) this.needsRender = true;

    // Smooth auto-fit camera (tracks the graph as it blooms/spreads).
    this.updateCameraFit();

    // Advance bloom-in from the rAF clock (lazy T0 on the first frame).
    if (this.bloomActive) {
      if (this.bloomT0 === 0) this.bloomT0 = ts;
      this.advanceBloom(ts);
      this.needsRender = true;
    }

    // Living drift + freshness pulse run forever, but a full canvas redraw of a
    // large graph every 16ms is expensive. When nothing interactive is going on,
    // throttle the idle "living motion" to ~30fps — looks identical for slow
    // motion, roughly halves CPU on big vaults.
    const idleInterval = interactive || hoverAnimating ? 0 : 1000 / 30;
    if (ts - this.lastRenderTs >= idleInterval) {
      this.render(ts);
      this.needsRender = false;
      this.lastRenderTs = ts;
    }
    this.schedule();
  };

  /** Drive each fresh node's bloom 0..1 from (ts - bloomT0 - delay). */
  private advanceBloom(ts: number): void {
    const t = ts - this.bloomT0;
    let stillBlooming = false;
    for (const node of this.nodes) {
      if (node.bloom >= 1) continue;
      const local = (t - node.bloomDelay) / BLOOM_DURATION_MS;
      if (local <= 0) {
        node.bloom = 0;
        stillBlooming = true;
      } else if (local >= 1) {
        node.bloom = 1;
      } else {
        node.bloom = easeOutCubic(local);
        stillBlooming = true;
      }
    }
    this.bloomActive = stillBlooming;
  }

  private render(ts: number): void {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    const { k, tx, ty, dimT } = this;
    const nodes = this.nodes;
    const n = nodes.length;
    const margin = 30;
    // Eased alpha for de-emphasized elements: 1 → DIM_ALPHA as dimT rises.
    const dimmedAlpha = 1 - dimT * (1 - DIM_ALPHA);

    // --- Living motion pre-pass (O(n)): render-only drift offsets. ----------
    // Each node sways on a slow sine/cosine desynced by its phase. We bake the
    // drifted SCREEN position once here so edges can reuse it without recompute,
    // and nothing feeds back into physics. A pinned (dragged) node never drifts.
    const tw = (ts / DRIFT_PERIOD_MS) * Math.PI * 2;
    const sxArr = this.screenX;
    const syArr = this.screenY;
    for (let i = 0; i < n; i++) {
      const node = nodes[i];
      let wx = node.x, wy = node.y;
      if (node.fx === null) {
        // dx slow, dy slightly slower (0.9w) → gentle non-circular wander.
        wx += DRIFT_AMPLITUDE * Math.sin(tw + node.phase);
        wy += DRIFT_AMPLITUDE * Math.cos(tw * 0.9 + node.phase * 1.7);
      }
      sxArr[i] = wx * k + tx;
      syArr[i] = wy * k + ty;
    }

    // --- Freshness pulse cursor: a calm wave sweeping newest→oldest. --------
    // cursorRank walks 0..freshCount each loop, then repeats. Nodes within a
    // soft rank window light up with a breathing accent halo.
    const cursorRank = this.freshCount > 0
      ? ((ts % PULSE_SWEEP_MS) / PULSE_SWEEP_MS) * this.freshCount
      : -1;

    // Edges — single pass; per-edge eased highlight blends color/width/alpha.
    // Edge endpoints use the drifted screen positions so links follow the sway,
    // and edge opacity is gated by the bloom of BOTH endpoints (fade-in last).
    for (const e of this.edges) {
      const ax = sxArr[e.a], ay = syArr[e.a];
      const bx = sxArr[e.b], by = syArr[e.b];
      if (this.edgeOffscreen(ax, ay, bx, by, margin)) continue;
      const edgeBloom = Math.min(nodes[e.a].bloom, nodes[e.b].bloom);
      if (edgeBloom <= 0.01) continue;
      const hl = e.hl;
      // Edges stay airy: 55% alpha at rest so dense vaults read as texture
      ctx.globalAlpha =
        (dimmedAlpha + (1 - dimmedAlpha) * hl) * (0.55 + 0.45 * hl) * edgeBloom;
      ctx.strokeStyle = hl > 0.01 ? mixRgb([56, 56, 56], ACCENT_RGB, hl * 0.55) : EDGE_COLOR;
      ctx.lineWidth = 0.7 + 0.45 * hl;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;

    // Nodes — color, radius and alpha follow the eased highlight; the entrance
    // bloom scales radius (with a tiny floor) and fades opacity; a freshness
    // halo breathes behind nodes the pulse wave is currently passing over.
    for (let i = 0; i < n; i++) {
      const node = nodes[i];
      const sx = sxArr[i];
      const sy = syArr[i];
      if (sx < -margin || sy < -margin || sx > this.width + margin || sy > this.height + margin) continue;
      const hl = node.hl;
      const bloom = node.bloom;
      const baseR = node.r * k * (1 + HOVER_RADIUS_BOOST * hl);
      const r = baseR * (BLOOM_RADIUS_FLOOR + (1 - BLOOM_RADIUS_FLOOR) * bloom);
      const baseRgb = node.data.ghost ? GHOST_RGB : NODE_RGB;

      // Freshness halo — soft accent glow behind the node, only while the wave
      // cursor is near this node's rank. Ghosts (freshRank < 0) never pulse.
      if (node.freshRank >= 0 && cursorRank >= 0 && bloom > 0.5) {
        const dRank = Math.abs(cursorRank - node.freshRank);
        const t = 1 - dRank / PULSE_WINDOW_RANKS;
        const pulse = smoothstep(t); // breathing in/out as the wave passes
        if (pulse > 0.01) {
          const haloR = Math.max(r, 1) * PULSE_HALO_SCALE;
          const grad = ctx.createRadialGradient(sx, sy, Math.max(r, 1), sx, sy, haloR);
          grad.addColorStop(0, `rgba(${ACCENT_RGB[0]},${ACCENT_RGB[1]},${ACCENT_RGB[2]},${(PULSE_MAX_ALPHA * pulse).toFixed(3)})`);
          grad.addColorStop(1, `rgba(${ACCENT_RGB[0]},${ACCENT_RGB[1]},${ACCENT_RGB[2]},0)`);
          ctx.globalAlpha = 1;
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(sx, sy, haloR, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.globalAlpha = (dimmedAlpha + (1 - dimmedAlpha) * hl) * bloom;
      ctx.fillStyle = hl > 0.01
        ? mixRgb(baseRgb, ACCENT_RGB, hl)
        : `rgb(${baseRgb[0]},${baseRgb[1]},${baseRgb[2]})`;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(r, 1), 0, Math.PI * 2);
      ctx.fill();
      // Soft halo around strongly-highlighted nodes
      if (hl > 0.3) {
        ctx.globalAlpha = 0.18 * hl * bloom;
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(r, 1) + 4 * hl, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // Labels are zoom-gated: nothing at overview scale, hubs first, rest later.
    const hubZoomAlpha = Math.min(Math.max((k - LABEL_HUB_ZOOM_START) / LABEL_HUB_ZOOM_RANGE, 0), 1);
    const restZoomAlpha = Math.min(Math.max((k - LABEL_REST_ZOOM_START) / LABEL_REST_ZOOM_RANGE, 0), 1);
    ctx.font = LABEL_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = LABEL_COLOR;
    for (let i = 0; i < n; i++) {
      const node = nodes[i];
      const hl = node.hl;
      let labelAlpha = node.data.degree >= LABEL_DEGREE_ALWAYS ? hubZoomAlpha : restZoomAlpha;
      // Hover fades labels in regardless of zoom; dim fades the rest out.
      // Bloom keeps labels hidden until the node has substantially arrived.
      labelAlpha = Math.max(labelAlpha * dimmedAlpha, hl) * node.bloom;
      if (labelAlpha <= 0.01) continue;
      const sx = sxArr[i]; // drifted position — labels track their node
      const sy = syArr[i];
      if (sx < -margin || sy < -margin || sx > this.width + margin || sy > this.height + margin) continue;
      ctx.globalAlpha = labelAlpha;
      ctx.fillText(node.data.label, sx, sy + node.r * k + 4);
    }
    ctx.globalAlpha = 1;
  }

  private edgeOffscreen(ax: number, ay: number, bx: number, by: number, margin: number): boolean {
    return (
      (ax < -margin && bx < -margin) ||
      (ay < -margin && by < -margin) ||
      (ax > this.width + margin && bx > this.width + margin) ||
      (ay > this.height + margin && by > this.height + margin)
    );
  }

  // --- Interaction ----------------------------------------------------------

  private toLocal(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /** Hit test in screen space, topmost (last drawn) first. */
  private nodeAt(sx: number, sy: number): number {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i];
      const nx = node.x * this.k + this.tx;
      const ny = node.y * this.k + this.ty;
      const r = Math.max(node.r * this.k, 2) + 3;
      const dx = sx - nx;
      const dy = sy - ny;
      if (dx * dx + dy * dy <= r * r) return i;
    }
    return -1;
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    const p = this.toLocal(e);
    this.pressX = p.x;
    this.pressY = p.y;
    this.pressMoved = false;
    this.lastMouseX = p.x;
    this.lastMouseY = p.y;
    const hit = this.nodeAt(p.x, p.y);
    if (hit >= 0) {
      this.dragIndex = hit;
      const node = this.nodes[hit];
      node.fx = node.x;
      node.fy = node.y;
      this.canvas.style.cursor = "grabbing";
    } else {
      this.panning = true;
      this.canvas.style.cursor = "grabbing";
    }
    e.preventDefault();
  };

  private onMouseMove = (e: MouseEvent): void => {
    const p = this.toLocal(e);
    const dx = p.x - this.lastMouseX;
    const dy = p.y - this.lastMouseY;
    this.lastMouseX = p.x;
    this.lastMouseY = p.y;
    if (Math.abs(p.x - this.pressX) > CLICK_SLOP_PX || Math.abs(p.y - this.pressY) > CLICK_SLOP_PX) {
      this.pressMoved = true;
    }

    if (this.dragIndex >= 0) {
      const node = this.nodes[this.dragIndex];
      node.fx = (p.x - this.tx) / this.k;
      node.fy = (p.y - this.ty) / this.k;
      this.reheat();
      return;
    }
    if (this.panning) {
      this.tx += dx;
      this.ty += dy;
      this.userMovedView = true;
      this.needsRender = true;
      this.schedule();
      return;
    }
    // Plain hover
    if (e.target !== this.canvas) {
      if (this.hovered !== -1) {
        this.hovered = -1;
        this.canvas.style.cursor = "default";
        this.needsRender = true;
        this.schedule();
      }
      return;
    }
    const hit = this.nodeAt(p.x, p.y);
    if (hit !== this.hovered) {
      this.hovered = hit;
      this.canvas.style.cursor = hit >= 0 ? "pointer" : "default";
      this.needsRender = true;
      this.schedule();
    }
  };

  private onMouseUp = (): void => {
    if (this.dragIndex >= 0) {
      const node = this.nodes[this.dragIndex];
      node.fx = null;
      node.fy = null;
      if (!this.pressMoved && !node.data.ghost && node.data.path) {
        this.opts.onOpenFile(node.data.path);
      }
      this.dragIndex = -1;
    }
    this.panning = false;
    this.canvas.style.cursor = this.hovered >= 0 ? "pointer" : "default";
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = this.toLocal(e);
    const factor = Math.exp(-e.deltaY * 0.0022);
    const k2 = Math.min(Math.max(this.k * factor, MIN_ZOOM), MAX_ZOOM);
    if (k2 === this.k) return;
    // Zoom toward the cursor: keep the world point under it fixed.
    const wx = (p.x - this.tx) / this.k;
    const wy = (p.y - this.ty) / this.k;
    this.k = k2;
    this.tx = p.x - wx * k2;
    this.ty = p.y - wy * k2;
    this.userMovedView = true;
    this.needsRender = true;
    this.schedule();
  };

  private onDblClick = (e: MouseEvent): void => {
    const p = this.toLocal(e);
    if (this.nodeAt(p.x, p.y) >= 0) return; // background only
    this.userMovedView = false;
    this.fitting = true; // smooth ease back to fit instead of snapping
    this.schedule();
  };
}
