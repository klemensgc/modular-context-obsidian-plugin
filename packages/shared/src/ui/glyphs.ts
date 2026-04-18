/** Session glyphs + layout slot counts.
 *
 *  Shared between Obsidian plugin and standalone app. Zero runtime dependencies.
 *  Plugin and app import these directly to keep visual identity consistent. */

export type FullscreenLayout =
  | "single"
  | "split-h"
  | "split-v"
  | "grid"
  | "grid-6"
  | "grid-8"
  | "grid-12";

/** Display mode is the single source of truth for "what mode + which layout".
 *  Owned by the host view. FullscreenManager reads from host, never writes its own. */
export interface DisplayMode {
  kind: "inline" | "fullscreen";
  layout: FullscreenLayout;
}

export interface SessionGlyph {
  id: string;
  svg: string;
}

/** 12 distinct geometric shapes for visual terminal identification.
 *  Stroke-only SVGs, 14×14, designed to be distinguishable at small sizes. */
export const SESSION_GLYPHS: SessionGlyph[] = [
  { id: "circle",   svg: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="7" cy="7" r="5.5"/></svg>' },
  { id: "square",   svg: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2" width="10" height="10" rx="1"/></svg>' },
  { id: "triangle", svg: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M7 2 L12.5 12 L1.5 12 Z"/></svg>' },
  { id: "diamond",  svg: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M7 1.5 L12.5 7 L7 12.5 L1.5 7 Z"/></svg>' },
  { id: "hexagon",  svg: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M7 1 L12.2 4 L12.2 10 L7 13 L1.8 10 L1.8 4 Z"/></svg>' },
  { id: "star",     svg: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M7 1 L8.8 5.2 L13 5.2 L9.6 8 L10.8 12.5 L7 9.8 L3.2 12.5 L4.4 8 L1 5.2 L5.2 5.2 Z"/></svg>' },
  { id: "cross",    svg: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M7 2 L7 12 M2 7 L12 7"/></svg>' },
  { id: "chevron",  svg: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 3 L8 7 L3 11 M7 3 L12 7 L7 11"/></svg>' },
  { id: "arrow",    svg: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 7 L12 7 M8 3 L12 7 L8 11"/></svg>' },
  { id: "dot3",     svg: '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><circle cx="3" cy="7" r="1.5"/><circle cx="7" cy="7" r="1.5"/><circle cx="11" cy="7" r="1.5"/></svg>' },
  { id: "slash",    svg: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M10 2 L4 12"/></svg>' },
  { id: "wave",     svg: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1 7 C3 3, 5 3, 7 7 C9 11, 11 11, 13 7"/></svg>' },
];

/** Number of pane slots for each layout. Used by computeVisible() and renderLayout(). */
export const SLOT_COUNT: Record<FullscreenLayout, number> = {
  "single": 1,
  "split-h": 2,
  "split-v": 2,
  "grid": 4,
  "grid-6": 6,
  "grid-8": 8,
  "grid-12": 12,
};
