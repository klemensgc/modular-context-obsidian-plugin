/** xterm.js theme builder — CSS-host agnostic.
 *
 *  Originally built against Obsidian CSS vars (--background-primary, --text-normal,
 *  --interactive-accent, --text-muted). Refactored to accept any CSS var source
 *  via `getCssVar` callback so the Electron app can supply its own palette. */

export interface XtermThemeColors {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface XtermThemeOptions {
  /** Return trimmed CSS var value, or empty string if unset. */
  getCssVar: (name: string) => string;
  /** True for dark palette, false for light. */
  isDark: boolean;
}

export function buildXtermTheme(opts: XtermThemeOptions): XtermThemeColors {
  const { getCssVar, isDark } = opts;

  const bg = getCssVar("--background-primary") || (isDark ? "#1e1e1e" : "#ffffff");
  const fg = getCssVar("--text-normal") || (isDark ? "#dcddde" : "#1a1a1a");
  const muted = getCssVar("--text-muted") || (isDark ? "#999" : "#666");

  const ansi = isDark
    ? {
        black:         "#1a1a2e",
        red:           "#e06c75",
        green:         "#98c379",
        yellow:        "#e5c07b",
        blue:          "#61afef",
        magenta:       "#c678dd",
        cyan:          "#56b6c2",
        white:         "#abb2bf",
        brightBlack:   "#5c6370",
        brightRed:     "#e88388",
        brightGreen:   "#a9d18e",
        brightYellow:  "#ebd09c",
        brightBlue:    "#7ec8e3",
        brightMagenta: "#d19de0",
        brightCyan:    "#73cdd6",
        brightWhite:   "#f0f0f0",
      }
    : {
        black:         "#383a42",
        red:           "#d73a49",
        green:         "#22863a",
        yellow:        "#b08800",
        blue:          "#0366d6",
        magenta:       "#6f42c1",
        cyan:          "#0598bc",
        white:         "#6a737d",
        brightBlack:   "#959da5",
        brightRed:     "#cb2431",
        brightGreen:   "#28a745",
        brightYellow:  "#dbab09",
        brightBlue:    "#2188ff",
        brightMagenta: "#8a63d2",
        brightCyan:    "#3192aa",
        brightWhite:   "#24292e",
      };

  return {
    background: bg,
    foreground: fg,
    cursor: muted,
    cursorAccent: bg,
    selectionBackground: isDark ? "rgba(255, 255, 255, 0.15)" : "rgba(0, 0, 0, 0.15)",
    selectionForeground: isDark ? "#f0f0f0" : "#1a1a1a",
    ...ansi,
  };
}
