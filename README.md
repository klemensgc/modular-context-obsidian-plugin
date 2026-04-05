# Modular Context

![banner](banner.png)

> AI-native knowledge terminal for Obsidian — agent dashboard, skills sidebar, wiki-link autocomplete, and the modular-context methodology. By receptionOS.

![Version](https://img.shields.io/github/v/release/klemensgc/modular-context-obsidian-plugin)
![License](https://img.shields.io/github/license/klemensgc/modular-context-obsidian-plugin)
![Platform](https://img.shields.io/badge/platform-macOS-blue)
![Obsidian](https://img.shields.io/badge/Obsidian-0.15+-purple)

---

## What is this?

An Obsidian plugin that turns your vault into an **LLM Wiki** — a persistent, compounding knowledge base where AI agents do the bookkeeping and you focus on thinking.

**Terminal** — Real PTY terminal (zsh) inside Obsidian with multi-tab, wiki-link autocomplete `[[`, drag-and-drop, fullscreen with split layouts.

**Agent Dashboard** — Skills sidebar to launch Claude Code sessions with one click. Working / To Review agent tracking. Auto-mode for autonomous operation.

**Methodology** — Opinionated vault structure: frontmatter standards, cadence-based staleness, three-layer architecture (Sources → Wiki → Schema).

---

## Features

- **Real PTY terminal** — Full zsh shell in a pseudo-terminal, not a basic command runner
- **Multi-tab support** — Multiple terminal sessions with named, persistent tabs
- **Wiki-link autocomplete** — Type `[[` inside the terminal to search vault notes
- **Skills sidebar** — One-click Claude Code agent sessions for recurring workflows
- **Agent tracker** — Working / To Review / Standby states for running agents
- **Custom skills** — Add your own via the `[+]` button (maps to `/skill-name` commands)
- **Drag-and-drop** — Drag files from Finder or Obsidian to paste shell-escaped paths
- **Screenshot drop** — Drag macOS screenshot thumbnails directly into the terminal
- **Fullscreen mode** — Expand terminal to fill Obsidian with split layouts (single, side-by-side, stacked, grid)
- **Terminal bookmarks** — Mark important output positions with scrollbar indicators
- **Output capture** — Save terminal output to notes (Cmd+Shift+S)
- **Session persistence** — Tab names and layout survive restarts
- **Auto-onboarding** — First install triggers a setup agent that builds your vault structure

---

## The Modular Context Methodology

### Three Layers

1. **Raw Sources** (`_transcripts/`, `_transcripts-backlog/`) — Your curated source material. Immutable. The LLM reads but never modifies.
2. **The Wiki** (project folders with `*_index.md`) — LLM-generated, interlinked knowledge modules. Summaries, entity pages, syntheses.
3. **The Schema** (`CLAUDE.md` + `_claude/`) — Conventions, templates, and skill references that teach the LLM how your vault works.

### Three Operations

| Operation | What it does | Skill |
|-----------|-------------|-------|
| **INGEST** | Process new sources into wiki modules | `/process-transcripts` |
| **QUERY** | Ask questions, synthesize answers, file insights back | `/brief`, `/ideas` |
| **LINT** | Health-check: staleness, orphans, broken links | `/pulse`, `/vault-audit`, `/reweave`, `/graph` |

### Frontmatter Standard

Every file gets structured metadata:

```yaml
---
title: Module Name
updated: 2026-04-05
status: stable        # stable | draft | needs-update | stub
cadence: tactical     # hot (7d) | tactical (30d) | iron-cold (60d) | frozen
depends-on: [[related-file]]
sources: [[transcript-name]]
---
```

### Cadence System

Temperature-based staleness scoring:

```
staleness = days_since_update / cadence_days

< 0.5  → fresh (green)
0.5–1  → aging (yellow)
1–2    → stale (orange)
> 2    → critical (red)
```

A `pipeline.md` (hot, 7d) untouched for 10 days is **stale** (ratio 1.4). A `vision.md` (iron-cold, 60d) untouched for 40 days is **fresh** (ratio 0.67). The vault tells you what needs attention.

---

## Built-in Skills

| Skill | Description |
|-------|-------------|
| **Ingest Data** | Process new sources — categorize, extract insights, update wiki modules |
| **Pulse** | Vault health check — staleness radar, strategic questions, next steps |
| **Brief** | Generate PDF brief or one-pager from vault knowledge |
| **Log** | Close session — generate session log, commit changes |
| **Ideas** | Generate new ideas from vault context using creative triggers |
| **Reweave** | Cascade-update stale or disconnected modules |
| **Vault Audit** | Audit vault structure — broken links, orphans, naming issues |
| **Graph** | Analyze knowledge graph — clusters, bridges, dependency depth |
| **Graduate** | Promote buried transcript insights into standalone modules |

Add custom skills with the **[+]** button. Each skill maps to a Claude Code `/skill-name` command defined in `.claude/skills/`.

---

## Installation

### With BRAT (recommended — auto-updates)

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat) from Obsidian's community plugins
2. Open BRAT settings and click **Add Beta plugin**
3. Enter `klemensgc/modular-context-obsidian-plugin` and click Add Plugin
4. Enable the plugin in Settings > Community Plugins

### Manual

1. Download from the [latest release](https://github.com/klemensgc/modular-context-obsidian-plugin/releases/latest)
2. Unzip into your vault's `.obsidian/plugins/modular-context/`
3. Restart Obsidian, then enable the plugin in Settings > Community Plugins

---

## Requirements

- **macOS** (desktop only — uses Python PTY for real terminal)
- **Python 3** (included with macOS)
- **Claude Code CLI** (for agent skills — [install guide](https://docs.anthropic.com/en/docs/claude-code/overview))

---

## Usage

### Opening the terminal

- Click the receptionOS icon in the ribbon (left sidebar)
- Or use Command Palette → "Open Terminal"

### Terminal basics

- **`+`** — New tab (new zsh session)
- **Double-click** tab name — Rename it
- **`[[`** — Wiki-link autocomplete from inside the terminal
- **Drag files** onto the terminal — Pastes shell-escaped path
- **Cmd+Shift+S** — Capture terminal output to a note

### Skills

Click any skill in the sidebar to launch a Claude Code session that executes it. The agent tracker shows:
- **Working** — Agent is actively running
- **To Review** — Agent finished, output ready for your review
- **Standby** — Dismissed but still available

### Auto-mode

Toggle in the sidebar. When enabled, Claude Code runs with `--dangerously-skip-permissions` for fully autonomous operation. **Off by default** — enable when you trust the agent to work independently.

---

## Onboarding

On first install, the plugin automatically opens a setup wizard. Click **"Start Here →"** to launch an AI agent that:

1. Scans your vault structure
2. Checks if CLAUDE.md exists (offers to extend or create fresh)
3. Diagnoses which layer is weakest (sources, wiki, schema)
4. Recommends and builds the modular-context structure for you

You can re-trigger onboarding anytime from the sidebar.

---

## Building from source

```bash
git clone https://github.com/klemensgc/modular-context-obsidian-plugin.git
cd modular-context
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` to your vault's `.obsidian/plugins/modular-context/`.

---

## Credits

Built on [internetvin-terminal](https://github.com/internetvin/internetvin-terminal) by Vin Verma (MIT License). Extended with agent dashboard, skills sidebar, onboarding system, and the modular-context methodology.

Inspired by Andrej Karpathy's [LLM Wiki](https://x.com/karpathy/status/1937538198696460718) concept.

---

## License

MIT — see [LICENSE](LICENSE)
