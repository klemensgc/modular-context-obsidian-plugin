/** SimpleSession — native chat feed over a headless Claude Code process.
 *
 *  "Simple mode" alternative to TerminalSession: no xterm, no PTY. The main
 *  process runs `claude -p --input-format stream-json --output-format stream-json`
 *  (see src/main/simple-runner.ts) and forwards parsed NDJSON events; this class
 *  renders them as a chat feed (assistant bubbles, tool cards, permission cards).
 *
 *  Structurally compatible with TerminalSession where TerminalManager and
 *  AgentTracker touch it: id/name/glyph/_lastStdoutAt/destroyed/containerEl,
 *  a mock `process` (stdout data + exit listeners drive AgentTracker), a mock
 *  `terminal` (AgentTracker polls terminal.buffer.active for TUI markers), and
 *  ready()/fit()/focus()/destroy().
 *
 *  Dependencies: marked (markdown rendering) — nothing else beyond the DOM. */

import { marked } from "marked";

export interface SimpleSessionApi {
  /** Send a follow-up user message (simple:send). */
  send(text: string): void;
  /** Answer a can_use_tool control_request (simple:respond). */
  respond(requestId: string, allow: boolean, input: any): void;
  /** Answer an AskUserQuestion tool_use with a tool_result (simple:answer). */
  answerTool(toolUseId: string, content: string): void;
  /** Interrupt the current turn (simple:interrupt). */
  interrupt(): void;
  /** SIGTERM the process (simple:kill). */
  kill(): void;
}

export interface SimpleSessionOptions {
  id: number;
  name: string;
  glyph: string;
  parent: HTMLElement;
  api: SimpleSessionApi;
  /** Suggested starter prompts for the empty state (skill-aware). */
  suggestions?: string[];
  onActivity?: (s: SimpleSession) => void;
}

/** Rotating tips shown in the empty feed — teach the methodology gently,
 *  Claude-Code-style "※ Tip:" lines. Plain language, no jargon. */
const FEED_TIPS: string[] = [
  "Drop a transcript or note into the inbox, then ask the agent to file it for you.",
  "Everything you write is saved automatically and versioned — nothing gets lost.",
  "Notes link to each other with [[double brackets]] — press ⌘G to see the map.",
  "Ask in plain words: \"what did I decide last week?\" or \"summarise this folder\".",
  "The agent can read, write and connect your notes — just tell it what you want.",
  "Not sure where to start? Try one of the suggestions above.",
];

/** Claude-Code-style gerunds for the looping thinking indicator. */
const THINKING_WORDS: string[] = [
  "Thinking", "Pondering", "Percolating", "Ruminating", "Noodling", "Marinating",
  "Simmering", "Cogitating", "Mulling", "Synthesising", "Conjuring", "Finagling",
  "Tinkering", "Computing", "Untangling", "Connecting the dots",
];

/** Fallback starter prompts when the launcher didn't pass skill-specific ones. */
const DEFAULT_SUGGESTIONS: string[] = [
  "What's in my vault? Give me a quick tour.",
  "Summarise what I worked on this week.",
  "What needs my attention right now?",
  "Help me organise my notes.",
];

const TOOL_INPUT_MAX = 1500;
const TOOL_OUTPUT_MAX = 2000;
const MONO_COLLAPSE_AT = 200;

interface ToolCardEntry {
  cardEl: HTMLElement;
  statusEl: HTMLElement;
}

export class SimpleSession {
  // Public fields — satisfy TrackableSession / TerminalManager structural use
  id: number;
  name: string;
  glyph: string;
  hasActivity = false;
  _lastStdoutAt = 0;
  destroyed = false;
  readonly kind = "simple" as const;

  containerEl: HTMLElement;
  bookmarkManager: null = null;

  /** Mock child_process for AgentTracker — stdout "data" + "exit" listeners.
   *  stdin.write() routes text to the headless process as a user message. */
  process: any;

  /** Mock xterm for AgentTracker.getRecentLines(). The single synthetic line
   *  carries a Claude TUI marker ("│") so isClaudeCodeActive() stays true
   *  (enables revive from to-review on new output) while shell-prompt /
   *  claude-prompt / completion-marker heuristics all stay false. */
  terminal: any;

  private api: SimpleSessionApi;
  private onActivity?: (s: SimpleSession) => void;
  private externalId: string | null = null;
  private readonly readyPromise: Promise<void> = Promise.resolve();
  private suggestions: string[];
  private emptyEl: HTMLElement | null = null;
  private tipTimer: number | null = null;
  private hasContent = false;

  private stdoutListeners: Set<(data: Buffer) => void> = new Set();
  private exitListeners: Set<() => void> = new Set();

  // DOM
  private feedEl: HTMLElement;
  private inputEl: HTMLInputElement;
  private stopBtn: HTMLButtonElement;
  private thinkingEl: HTMLElement;
  private thinkingWordEl!: HTMLElement;
  private thinkingTimer: number | null = null;

  /** tool_use id → card, so tool_result can be appended later. */
  private toolCards: Map<string, ToolCardEntry> = new Map();
  private processExited = false;

  constructor(opts: SimpleSessionOptions) {
    this.id = opts.id;
    this.name = opts.name;
    this.glyph = opts.glyph;
    this.api = opts.api;
    this.onActivity = opts.onActivity;
    this.suggestions = opts.suggestions ?? [];

    // --- Container + feed + input bar ---
    this.containerEl = document.createElement("div");
    this.containerEl.className = "mc-app-terminal-session mc-app-simple-session";
    this.containerEl.dataset.sessionId = String(this.id);
    opts.parent.appendChild(this.containerEl);

    this.feedEl = document.createElement("div");
    this.feedEl.className = "mc-app-simple-feed";
    this.containerEl.appendChild(this.feedEl);

    const inputBar = document.createElement("div");
    inputBar.className = "mc-app-simple-inputbar";
    this.containerEl.appendChild(inputBar);

    this.inputEl = document.createElement("input");
    this.inputEl.className = "mc-app-simple-input";
    this.inputEl.type = "text";
    this.inputEl.placeholder = "Message the agent…";
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.submitInput();
    });
    inputBar.appendChild(this.inputEl);

    this.stopBtn = document.createElement("button");
    this.stopBtn.className = "mc-app-simple-stop";
    this.stopBtn.textContent = "Stop";
    this.stopBtn.title = "Interrupt the current turn";
    this.stopBtn.addEventListener("click", () => {
      try { this.api.interrupt(); } catch {}
    });
    inputBar.appendChild(this.stopBtn);

    // Looping "thinking" indicator — Claude-Code-style gerunds + animated dots.
    this.thinkingEl = document.createElement("div");
    this.thinkingEl.className = "mc-app-simple-thinking";
    this.thinkingWordEl = document.createElement("span");
    this.thinkingWordEl.className = "mc-app-simple-thinking-word";
    this.thinkingEl.appendChild(this.thinkingWordEl);
    const dots = document.createElement("span");
    dots.className = "mc-app-simple-thinking-dots";
    for (let i = 0; i < 3; i++) dots.appendChild(document.createElement("span"));
    this.thinkingEl.appendChild(dots);

    // --- Mock child_process (AgentTracker compatibility) ---
    this.process = {
      stdout: {
        on: (event: string, cb: (data: Buffer) => void) => {
          if (event === "data") this.stdoutListeners.add(cb);
        },
        removeListener: (event: string, cb: (data: Buffer) => void) => {
          if (event === "data") this.stdoutListeners.delete(cb);
        },
      },
      on: (event: string, cb: () => void) => {
        if (event === "exit") this.exitListeners.add(cb);
      },
      removeListener: (event: string, cb: () => void) => {
        if (event === "exit") this.exitListeners.delete(cb);
      },
      // Skill launchers write prompts here — route as a user message.
      stdin: {
        write: (text: string) => {
          const clean = String(text).replace(/[\r\n]+$/, "").trim();
          if (!clean) return;
          this.api.send(clean);
          this.addUserMessage(clean);
        },
      },
    };

    // --- Mock terminal buffer (AgentTracker polls it every 5s) ---
    const syntheticLine = { translateToString: () => "│ simple session" };
    this.terminal = {
      buffer: { active: { length: 1, getLine: () => syntheticLine } },
    };

    // Empty state — welcome + suggestions + rotating tips (until first content)
    this.renderEmptyState();
  }

  // ------------------------------------------------------------------
  // Empty state (before any conversation content)
  // ------------------------------------------------------------------

  private renderEmptyState(): void {
    const empty = document.createElement("div");
    empty.className = "mc-app-simple-empty";

    const title = document.createElement("div");
    title.className = "mc-app-simple-empty-title";
    title.textContent = "What would you like to do?";
    empty.appendChild(title);

    const sub = document.createElement("div");
    sub.className = "mc-app-simple-empty-sub";
    sub.textContent = "Ask in plain words, or pick a starting point:";
    empty.appendChild(sub);

    const suggestions = this.suggestions.length > 0 ? this.suggestions : DEFAULT_SUGGESTIONS;
    const chips = document.createElement("div");
    chips.className = "mc-app-simple-suggestions";
    for (const s of suggestions.slice(0, 4)) {
      const chip = document.createElement("button");
      chip.className = "mc-app-simple-suggestion";
      chip.textContent = s;
      chip.addEventListener("click", () => {
        if (this.processExited) return;
        try { this.api.send(s); } catch {}
        this.addUserMessage(s);
      });
      chips.appendChild(chip);
    }
    empty.appendChild(chips);

    const tip = document.createElement("div");
    tip.className = "mc-app-simple-tip";
    empty.appendChild(tip);
    let tipIdx = Math.floor(this._lastStdoutAt) % FEED_TIPS.length; // deterministic-ish start
    const showTip = () => { tip.textContent = `※ Tip: ${FEED_TIPS[tipIdx % FEED_TIPS.length]}`; tipIdx++; };
    showTip();
    this.tipTimer = window.setInterval(showTip, 6000);

    this.feedEl.appendChild(empty);
    this.emptyEl = empty;
  }

  private clearEmptyState(): void {
    if (this.tipTimer) { clearInterval(this.tipTimer); this.tipTimer = null; }
    this.emptyEl?.remove();
    this.emptyEl = null;
  }

  // ------------------------------------------------------------------
  // Event intake
  // ------------------------------------------------------------------

  /** Core entry point — TerminalManager routes "simple:event" payloads here
   *  (matched by external id). Updates the feed and emits synthetic stdout
   *  data so AgentTracker sees activity. On {type:"result"} also fires exit
   *  listeners (tracker flips to to-review) but the session stays alive —
   *  a follow-up message revives it through the tracker's revive path. */
  receiveEvent(evt: any): void {
    if (this.destroyed) return;
    this._lastStdoutAt = Date.now();
    this.hideThinking();

    // Synthetic stdout for AgentTracker activity accounting.
    this.emitStdout(safeStringify(evt));

    try {
      this.renderEvent(evt);
    } catch (err) {
      this.renderRawCollapsed("render error", `${String(err)}\n${safeStringify(evt)}`);
    }

    if (this.onActivity) this.onActivity(this);
  }

  private renderEvent(evt: any): void {
    const type = evt && typeof evt === "object" ? evt.type : undefined;
    switch (type) {
      case "system":
        // Only the init carries anything (and renderInit is silent). Everything
        // else (thinking_tokens, rate_limit_event, etc.) is protocol noise —
        // the looping "thinking" indicator already shows work is happening.
        if (evt.subtype === "init") this.renderInit(evt);
        else this.showThinking();
        break;
      case "assistant":
        this.renderAssistant(evt);
        break;
      case "user":
        this.renderUserEvent(evt);
        break;
      case "control_request":
        this.renderControlRequest(evt);
        break;
      case "control_response":
        // Ack to our own interrupt/permission traffic — no UI needed.
        break;
      case "result":
        this.renderResult(evt);
        break;
      case "stderr":
        this.renderMono(String(evt.text ?? ""));
        break;
      case "raw":
        this.renderMono(String(evt.text ?? ""));
        break;
      case "exit":
        this.renderExit(evt);
        break;
      default:
        // Unknown protocol events (take_last_event, etc.) — suppress silently,
        // keep the feed clean. Real errors come through stderr/raw/exit above.
        this.showThinking();
    }
  }

  // ------------------------------------------------------------------
  // Renderers
  // ------------------------------------------------------------------

  private renderInit(_evt: any): void {
    // Init carries model id / cwd — pure jargon for a non-technical user, and
    // rendering it would also clear the empty state. Intentionally silent.
  }

  private renderAssistant(evt: any): void {
    const content = evt?.message?.content;
    if (!Array.isArray(content)) {
      this.renderRawCollapsed("assistant", safeStringify(evt));
      return;
    }
    for (const block of content) {
      const btype = block && typeof block === "object" ? block.type : undefined;
      if (btype === "text" && typeof block.text === "string") {
        if (block.text.trim()) this.renderMarkdownBubble(block.text);
      } else if (btype === "tool_use") {
        if (block.name === "AskUserQuestion") this.renderAskQuestion(block);
        else this.renderToolUse(block);
      } else if (btype === "thinking" || btype === "redacted_thinking") {
        // Zero-jargon: the agent's internal reasoning is not shown. The
        // "thinking…" dots already signal that it's working.
        this.showThinking();
      } else {
        this.renderRawCollapsed(`block · ${String(btype ?? "?")}`, safeStringify(block));
      }
    }
  }

  private renderUserEvent(evt: any): void {
    const content = evt?.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block && typeof block === "object" && block.type === "tool_result") {
        this.attachToolResult(block);
      }
      // Plain text user blocks are echoes of our own input — already shown.
    }
  }

  private renderMarkdownBubble(text: string): void {
    const bubble = document.createElement("div");
    bubble.className = "mc-app-simple-assistant mc-app-simple-md";
    try {
      bubble.innerHTML = marked.parse(text, { gfm: true, async: false }) as string;
    } catch {
      bubble.textContent = text;
    }
    this.append(bubble);
  }

  private renderToolUse(block: any): void {
    const name = typeof block.name === "string" ? block.name : "tool";
    const input = block.input ?? {};

    const card = document.createElement("div");
    card.className = "mc-app-simple-tool";

    const head = document.createElement("div");
    head.className = "mc-app-simple-tool-head";
    card.appendChild(head);

    const label = document.createElement("span");
    label.className = "mc-app-simple-tool-label";
    label.textContent = toolLabel(name, input);
    head.appendChild(label);

    const status = document.createElement("span");
    status.className = "mc-app-simple-tool-status";
    head.appendChild(status);

    // Details: for Bash the summary shows the (collapsed) command in <code>,
    // for everything else a plain "details" caption. Body = pretty input JSON.
    const details = document.createElement("details");
    details.className = "mc-app-simple-tool-input";
    const summary = document.createElement("summary");
    if (name === "Bash" && typeof input.command === "string") {
      const code = document.createElement("code");
      code.textContent = oneLine(input.command, 120);
      summary.appendChild(code);
    } else {
      summary.textContent = "details";
    }
    details.appendChild(summary);

    const pre = document.createElement("pre");
    pre.textContent = truncate(safeStringify(input, true), TOOL_INPUT_MAX);
    details.appendChild(pre);
    card.appendChild(details);

    if (typeof block.id === "string") {
      this.toolCards.set(block.id, { cardEl: card, statusEl: status });
    }
    this.append(card);
  }

  /** AskUserQuestion tool_use → native question card(s) with option buttons.
   *  Headless mode auto-cancels the tool itself, so we DON'T answer via
   *  tool_result. Instead the chosen options are sent as a normal chat message
   *  (the agent reads it as the user's reply and continues). */
  private renderAskQuestion(block: any): void {
    const questions = Array.isArray(block?.input?.questions) ? block.input.questions : [];
    if (questions.length === 0) {
      this.renderToolUse(block); // malformed — fall back to a generic card
      return;
    }

    const card = document.createElement("div");
    card.className = "mc-app-simple-question";

    const prompt = document.createElement("div");
    prompt.className = "mc-app-simple-question-prompt";
    prompt.textContent = "The agent is asking:";
    card.appendChild(prompt);

    // Collected answers per question (index → labels)
    const answers: string[][] = questions.map(() => []);
    const submitState = { done: false };

    const finish = () => {
      if (submitState.done) return;
      const anyPicked = answers.some((a) => a.length > 0);
      if (!anyPicked) return;
      submitState.done = true;
      // Phrase the answer as a natural reply the agent will understand.
      const reply = questions
        .map((q: any, i: number) => {
          const q_text = typeof q.question === "string" ? q.question : `Question ${i + 1}`;
          return answers[i].length ? `${q_text} → ${answers[i].join(", ")}` : null;
        })
        .filter(Boolean)
        .join("\n");
      try { this.api.send(reply); } catch {}
      this.addUserMessage(reply);
      card.classList.add("is-resolved");
      card.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
      const record = document.createElement("div");
      record.className = "mc-app-simple-question-record";
      record.textContent = "✓ Answer sent";
      card.appendChild(record);
    };

    questions.forEach((q: any, qi: number) => {
      const qBlock = document.createElement("div");
      qBlock.className = "mc-app-simple-question-block";

      if (typeof q.header === "string" && q.header) {
        const hdr = document.createElement("div");
        hdr.className = "mc-app-simple-question-header";
        hdr.textContent = q.header;
        qBlock.appendChild(hdr);
      }

      const qText = document.createElement("div");
      qText.className = "mc-app-simple-question-text";
      qText.textContent = typeof q.question === "string" ? q.question : "Choose one:";
      qBlock.appendChild(qText);

      const opts = Array.isArray(q.options) ? q.options : [];
      const multi = q.multiSelect === true;
      const optsWrap = document.createElement("div");
      optsWrap.className = "mc-app-simple-question-options";

      for (const opt of opts) {
        const label = typeof opt?.label === "string" ? opt.label : String(opt);
        const desc = typeof opt?.description === "string" ? opt.description : "";
        const btn = document.createElement("button");
        btn.className = "mc-app-simple-option";
        const labelEl = document.createElement("span");
        labelEl.className = "mc-app-simple-option-label";
        labelEl.textContent = label;
        btn.appendChild(labelEl);
        if (desc) {
          const descEl = document.createElement("span");
          descEl.className = "mc-app-simple-option-desc";
          descEl.textContent = desc;
          btn.appendChild(descEl);
        }
        btn.addEventListener("click", () => {
          if (submitState.done) return;
          if (multi) {
            const on = btn.classList.toggle("is-selected");
            if (on) answers[qi].push(label);
            else answers[qi] = answers[qi].filter((l) => l !== label);
          } else {
            answers[qi] = [label];
            // single-select = immediate submit when it's the only question
            optsWrap.querySelectorAll(".mc-app-simple-option").forEach((b) => b.classList.remove("is-selected"));
            btn.classList.add("is-selected");
            if (questions.length === 1) finish();
          }
        });
        optsWrap.appendChild(btn);
      }
      qBlock.appendChild(optsWrap);
      card.appendChild(qBlock);
    });

    // Submit button for multi-select or multi-question cards
    const needsSubmit = questions.length > 1 || questions.some((q: any) => q.multiSelect === true);
    if (needsSubmit) {
      const submit = document.createElement("button");
      submit.className = "mc-app-modal-btn is-primary mc-app-simple-question-submit";
      submit.textContent = "Send answer";
      submit.addEventListener("click", finish);
      card.appendChild(submit);
    }

    this.append(card);
  }

  private attachToolResult(block: any): void {
    const entry = typeof block.tool_use_id === "string"
      ? this.toolCards.get(block.tool_use_id)
      : undefined;
    if (!entry) return; // no matching card — skip silently

    const isError = block.is_error === true;
    entry.statusEl.textContent = isError ? "✗" : "✓";
    entry.statusEl.classList.add(isError ? "is-error" : "is-ok");

    const text = normalizeResultContent(block.content);
    if (!text.trim()) return;

    const details = document.createElement("details");
    details.className = "mc-app-simple-tool-output";
    const summary = document.createElement("summary");
    summary.textContent = isError ? "error output" : "output";
    details.appendChild(summary);
    const pre = document.createElement("pre");
    pre.textContent = truncate(text, TOOL_OUTPUT_MAX);
    details.appendChild(pre);
    entry.cardEl.appendChild(details);
  }

  private renderControlRequest(evt: any): void {
    const req = evt?.request;
    if (!req || req.subtype !== "can_use_tool") {
      this.renderRawCollapsed(
        `control · ${String(req?.subtype ?? "?")}`,
        safeStringify(evt)
      );
      return;
    }

    const requestId = String(evt.request_id ?? "");
    const toolName = String(req.tool_name ?? "tool");
    const input = req.input ?? {};

    const card = document.createElement("div");
    card.className = "mc-app-simple-permission";

    const title = document.createElement("div");
    title.className = "mc-app-simple-permission-title";
    title.textContent = `Claude chce użyć ${toolName}`;
    card.appendChild(title);

    const excerpt = document.createElement("pre");
    excerpt.className = "mc-app-simple-permission-input";
    excerpt.textContent = truncate(safeStringify(input, true), 600);
    card.appendChild(excerpt);

    const actions = document.createElement("div");
    actions.className = "mc-app-simple-permission-actions";
    card.appendChild(actions);

    const decide = (allow: boolean) => {
      try { this.api.respond(requestId, allow, input); } catch {}
      // Replace buttons with a passive record of the decision.
      actions.innerHTML = "";
      const record = document.createElement("span");
      record.className = "mc-app-simple-permission-record";
      record.textContent = allow ? "✓ Allowed" : "✗ Denied";
      actions.appendChild(record);
      card.classList.add("is-resolved");
    };

    const allowBtn = document.createElement("button");
    allowBtn.className = "mc-app-modal-btn is-primary mc-app-simple-perm-btn";
    allowBtn.textContent = "Allow";
    allowBtn.addEventListener("click", () => decide(true));
    actions.appendChild(allowBtn);

    const denyBtn = document.createElement("button");
    denyBtn.className = "mc-app-modal-btn mc-app-simple-perm-btn";
    denyBtn.textContent = "Deny";
    denyBtn.addEventListener("click", () => decide(false));
    actions.appendChild(denyBtn);

    this.append(card);
  }

  private renderResult(evt: any): void {
    const footer = document.createElement("div");
    footer.className = "mc-app-simple-result";
    const secs = typeof evt.duration_ms === "number"
      ? (evt.duration_ms / 1000).toFixed(1)
      : "?";
    let text = `Done in ${secs}s`;
    if (typeof evt.total_cost_usd === "number") {
      text += ` · $${evt.total_cost_usd.toFixed(4)}`;
    }
    if (typeof evt.subtype === "string" && evt.subtype !== "success") {
      text += ` · ${evt.subtype}`;
    }
    footer.textContent = text;
    this.append(footer);

    // Tracker flips to to-review, but the process and input stay alive —
    // a follow-up message produces fresh output and revives the tracker.
    this.emitExit();
  }

  private renderExit(evt: any): void {
    this.processExited = true;
    const chip = document.createElement("div");
    chip.className = "mc-app-simple-chip is-exit";
    const code = evt?.code;
    chip.textContent = code === 0 || code == null
      ? "Process exited"
      : `Process exited (code ${code})`;
    this.append(chip);
    this.inputEl.disabled = true;
    this.inputEl.placeholder = "Process exited";
    this.stopBtn.disabled = true;
    this.emitExit();
  }

  private renderMono(text: string): void {
    if (!text.trim()) return;
    if (text.length > MONO_COLLAPSE_AT) {
      this.renderRawCollapsed(oneLine(text, 80), text);
      return;
    }
    const line = document.createElement("div");
    line.className = "mc-app-simple-mono";
    line.textContent = text;
    this.append(line);
  }

  private renderRawCollapsed(summaryText: string, body: string): void {
    const details = document.createElement("details");
    details.className = "mc-app-simple-mono is-collapsible";
    const summary = document.createElement("summary");
    summary.textContent = oneLine(summaryText, 100);
    details.appendChild(summary);
    const pre = document.createElement("pre");
    pre.textContent = truncate(body, 4000);
    details.appendChild(pre);
    this.append(details);
  }

  // ------------------------------------------------------------------
  // User input
  // ------------------------------------------------------------------

  /** A clean "launch chip" instead of dumping the internal instruction prompt
   *  as a giant user bubble (used by moves / synthesise). */
  addLaunchChip(label: string): void {
    if (this.destroyed) return;
    const chip = document.createElement("div");
    chip.className = "mc-app-simple-launch";
    const dot = document.createElement("span");
    dot.className = "mc-app-simple-launch-dot";
    dot.textContent = "▸";
    chip.appendChild(dot);
    chip.appendChild(document.createTextNode(label));
    this.append(chip);
    this.showThinking();
  }

  /** Render a user bubble + thinking indicator. Used for the initial prompt
   *  (call after spawn) and for every message sent from the input bar. */
  addUserMessage(text: string): void {
    if (this.destroyed) return;
    const bubble = document.createElement("div");
    bubble.className = "mc-app-simple-user";
    bubble.textContent = text;
    this.append(bubble);
    this.showThinking();
  }

  private submitInput(): void {
    const text = this.inputEl.value.trim();
    if (!text || this.processExited) return;
    this.inputEl.value = "";
    try { this.api.send(text); } catch {}
    this.addUserMessage(text);
  }

  private showThinking(): void {
    const stick = this.isNearBottom();
    this.feedEl.appendChild(this.thinkingEl); // (re-)append at the bottom
    if (this.thinkingTimer === null) {
      this.thinkingWordEl.textContent = THINKING_WORDS[Math.floor(this._lastStdoutAt) % THINKING_WORDS.length];
      let i = Math.floor(this._lastStdoutAt) % THINKING_WORDS.length;
      this.thinkingTimer = window.setInterval(() => {
        i = (i + 1) % THINKING_WORDS.length;
        this.thinkingWordEl.textContent = THINKING_WORDS[i];
      }, 2400);
    }
    if (stick) this.scrollToBottom();
  }

  private hideThinking(): void {
    if (this.thinkingTimer !== null) { clearInterval(this.thinkingTimer); this.thinkingTimer = null; }
    if (this.thinkingEl.parentElement) this.thinkingEl.remove();
  }

  // ------------------------------------------------------------------
  // Feed helpers (auto-scroll only when user is near the bottom)
  // ------------------------------------------------------------------

  private isNearBottom(): boolean {
    const el = this.feedEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  private scrollToBottom(): void {
    this.feedEl.scrollTop = this.feedEl.scrollHeight;
  }

  private append(el: HTMLElement): void {
    // First real content retires the empty state (welcome + tips).
    if (!this.hasContent) {
      this.hasContent = true;
      this.clearEmptyState();
    }
    const stick = this.isNearBottom();
    this.feedEl.appendChild(el);
    if (stick) this.scrollToBottom();
  }

  // ------------------------------------------------------------------
  // AgentTracker plumbing
  // ------------------------------------------------------------------

  private emitStdout(data: string): void {
    // Renderer has no Node Buffer (nodeIntegration: false) — consumers only
    // use .length, which plain strings satisfy structurally.
    const buf = (typeof Buffer !== "undefined"
      ? Buffer.from(data, "utf-8")
      : (data as unknown)) as Buffer;
    for (const cb of this.stdoutListeners) {
      try { cb(buf); } catch {}
    }
  }

  private emitExit(): void {
    for (const cb of this.exitListeners) {
      try { cb(); } catch {}
    }
  }

  // ------------------------------------------------------------------
  // TerminalSession-compatible surface
  // ------------------------------------------------------------------

  setActivityCallback(cb: ((s: SimpleSession) => void) | null): void {
    this.onActivity = cb ?? undefined;
  }

  /** Manager maps incoming "simple:event" payloads to sessions by this id. */
  setExternalId(id: string): void {
    this.externalId = id;
  }

  getExternalId(): string | null {
    return this.externalId;
  }

  /** No PTY behind this session. */
  getPtySessionId(): null {
    return null;
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  fit(): void {
    // No xterm to fit — flex layout handles resizing.
  }

  focus(): void {
    if (this.destroyed) return;
    this.inputEl.focus();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.tipTimer) { clearInterval(this.tipTimer); this.tipTimer = null; }
    if (this.thinkingTimer !== null) { clearInterval(this.thinkingTimer); this.thinkingTimer = null; }
    try { this.api.kill(); } catch {}
    this.stdoutListeners.clear();
    this.exitListeners.clear();
    this.toolCards.clear();
    this.containerEl.remove();
  }
}

// ------------------------------------------------------------------
// Module-level helpers
// ------------------------------------------------------------------

function toolLabel(name: string, input: any): string {
  switch (name) {
    case "Edit":
    case "Write":
    case "MultiEdit":
      return `✏️ Editing ${basename(input?.file_path) || "file"}`;
    case "Read":
      return `📄 Reading ${basename(input?.file_path) || "file"}`;
    case "Bash":
      return "⚡ Running command";
    case "Grep":
    case "Glob":
      return "🔍 Searching";
    case "Task":
    case "Agent":
      return "🤖 Running subagent";
    case "WebFetch":
    case "WebSearch":
      return "🌐 Web";
    case "TodoWrite":
      return "☑️ Planning";
    default:
      return name;
  }
}

function basename(p: unknown): string {
  if (typeof p !== "string" || !p) return "";
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… (+${s.length - max} chars)`;
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function safeStringify(value: unknown, pretty = false): string {
  try {
    return JSON.stringify(value, null, pretty ? 2 : undefined) ?? String(value);
  } catch {
    return String(value);
  }
}

/** tool_result content can be a string, an array of content blocks, or absent. */
function normalizeResultContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => {
        if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string") {
          return b.text;
        }
        return safeStringify(b, true);
      })
      .join("\n");
  }
  return safeStringify(content, true);
}
