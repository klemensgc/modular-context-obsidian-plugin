## Fix: blank terminals after a GPU process restart

After macOS restarted Obsidian's GPU process (sleep/wake, driver hiccup), every terminal pane — including newly opened ones — showed only the cursor and cell backgrounds, no text. Sessions kept running underneath; only a plugin restart brought the text back, and that restart killed every session.

Root cause: xterm's WebGL renderer keeps its glyph atlas in GPU-backed canvases shared by all terminals. The GPU restart wiped them, xterm restored the WebGL context by itself and re-uploaded the blank atlas. A second bug made the fallback worse: `@xterm/addon-webgl` 0.19.0 belongs to the xterm 6 line, and with xterm 5.5 its `dispose()` throws — a context that never came back left the terminal with no renderer at all.

### Fixed
- Terminals repaint themselves after any WebGL context loss/restore — all of them in one pass, so the shared atlas is rebuilt consistently.
- `@xterm/addon-webgl` pinned to `^0.18.0`, the release built for xterm 5.5; the DOM fallback works again.

### Added
- Command **Terminal: Repaint All (fix blank text)** — manual repaint, no restart, sessions untouched.
- `render-events.log` in the plugin folder — renderer events (context lost/restored, fallback, repaint) that survive a restart, for the next time something goes blank.
