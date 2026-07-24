/** Simple mode runner — headless Claude Code sessions over stream-json.
 *
 *  Spawns `claude -p --input-format stream-json --output-format stream-json --verbose`
 *  through a login zsh (so PATH includes npm-global where `claude` lives), parses
 *  NDJSON stdout line-by-line and broadcasts every event to all renderer windows
 *  as "simple:event". Mirrors the PTY handler pattern in ipc-handlers.ts.
 *
 *  Renderer-facing channels:
 *    invoke "simple:spawn"     ({cwd, prompt, permissionMode}) → session id
 *    invoke "simple:send"      (id, text)                      → follow-up user message
 *    invoke "simple:respond"   (id, requestId, allow, input)   → can_use_tool decision
 *    invoke "simple:interrupt" (id)                            → interrupt current turn
 *    invoke "simple:kill"      (id)                            → SIGTERM + cleanup
 *    on     "simple:event"     (id, event)                     → parsed NDJSON event;
 *           parse failures arrive as {type:"raw",text}, stderr as {type:"stderr",text},
 *           process close as {type:"exit",code}. */

import { ipcMain, BrowserWindow } from "electron";
import { spawn, ChildProcess } from "child_process";
import { createInterface } from "readline";
import { log } from "./logger";

interface SimpleSession {
  id: string;
  process: ChildProcess;
}

const simpleSessions = new Map<string, SimpleSession>();
let nextSimpleId = 1;

function broadcast(id: string, event: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("simple:event", id, event);
  }
}

/** Write one NDJSON line to the session's stdin. Silently drops if gone.
 *  Note: a write to a dead child's stdin also emits an ASYNC 'error' (EPIPE)
 *  on the stream — try/catch only catches the sync throw, so an 'error'
 *  listener is attached at spawn time (below) to absorb the async case too. */
function writeLine(session: SimpleSession | undefined, payload: unknown): void {
  const stdin = session?.process.stdin;
  if (!stdin || stdin.destroyed) return;
  try {
    stdin.write(JSON.stringify(payload) + "\n");
  } catch (err) {
    log("simple", "stdin write failed (sync)", err);
  }
}

function userMessage(text: string): unknown {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

/** A tool_result reply (used to answer AskUserQuestion). */
function toolResultMessage(toolUseId: string, content: string): unknown {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
  };
}

/** Always appended for Simple mode. The AskUserQuestion tool is auto-cancelled
 *  in headless (`-p`) mode — so we forbid it and route questions through normal
 *  chat messages, which the user answers in the input bar (or via quick-reply
 *  chips the renderer builds from the agent's options). */
const SIMPLE_BASE_PROMPT =
  "You are running inside a friendly chat app, not a terminal. " +
  "Do NOT use the AskUserQuestion tool — it does not work here and will be cancelled. " +
  "When you need a decision or more info, simply ask the user in a normal message and stop, " +
  "waiting for their reply. If you want to offer choices, list them as a short numbered or " +
  "bulleted list inside your message so the user can pick one.";

/** Plain-language additions for non-technical users (Beginner mode). */
const BEGINNER_SYSTEM_PROMPT =
  "The person you are helping is not technical and may be new to AI. " +
  "Explain what you are doing in plain, everyday language — never use jargon like " +
  "'tokens', 'stdout', 'commit', 'CLI', or 'JSON' without a short plain explanation. " +
  "Keep replies concise and friendly. When you take an action, say in one short sentence " +
  "what you did and why it helps.";

/** Expert register — used for the strategic "moves" launched from the dashboard.
 *  Clicking a move signals a power operator who wants terse, decisive output. */
const EXPERT_SYSTEM_PROMPT =
  "The person is an expert operator who knows this vault cold. Be concise, direct and " +
  "decisive — terse commander tone. No hand-holding, no explaining basics, no filler or " +
  "preamble. Lead with the answer or recommendation, then the minimum supporting detail. " +
  "Don't narrate routine steps. Prefer one sharp next move over a long list.";

/** Shell-safe single-quote wrap for --append-system-prompt. */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function registerSimpleIpc(): void {
  ipcMain.handle(
    "simple:spawn",
    async (
      _evt,
      opts: {
        cwd: string;
        prompt: string;
        permissionMode: "acceptEdits" | "bypassPermissions";
        beginner?: boolean;
        expert?: boolean;
      }
    ): Promise<string> => {
      const id = `simple-${nextSimpleId++}`;

      // The mode is interpolated into a shell line — whitelist it.
      const mode =
        opts.permissionMode === "bypassPermissions" ? "bypassPermissions" : "acceptEdits";

      // Drop CLAUDECODE (same as pty:spawn) so the nested CLI doesn't think
      // it's running inside another Claude Code session.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { CLAUDECODE, ...cleanEnv } = process.env;

      // System prompt: always the Simple-mode base; expert register wins over
      // beginner (a strategic "move" implies a power user).
      const appendParts = [SIMPLE_BASE_PROMPT];
      if (opts.expert) appendParts.push(EXPERT_SYSTEM_PROMPT);
      else if (opts.beginner) appendParts.push(BEGINNER_SYSTEM_PROMPT);
      const beginnerArg = ` --append-system-prompt ${shellQuote(appendParts.join("\n\n"))}`;

      // zsh -lc → login shell PATH (claude installed via npm-global).
      const proc = spawn(
        "/bin/zsh",
        [
          "-lc",
          `exec claude -p --input-format stream-json --output-format stream-json --verbose --permission-mode ${mode}${beginnerArg}`,
        ],
        {
          cwd: opts.cwd,
          env: { ...cleanEnv, TERM: "dumb" },
        }
      );

      const session: SimpleSession = { id, process: proc };
      simpleSessions.set(id, session);

      // Absorb async stream errors (EPIPE on a dead child's stdin, etc.) so
      // they don't bubble up as uncaught exceptions and crash the app.
      proc.stdin?.on("error", (err) => log("simple", `stdin error ${id}`, err));
      proc.stdout?.on("error", (err) => log("simple", `stdout error ${id}`, err));
      proc.stderr?.on("error", (err) => log("simple", `stderr error ${id}`, err));

      // Initial task prompt goes straight to stdin as the first user message.
      // Empty prompt = a blank chat session: the CLI idles until the user types.
      if (opts.prompt && opts.prompt.trim()) {
        writeLine(session, userMessage(opts.prompt));
      }

      // stdout = NDJSON, one event per line. Parse defensively — a line that
      // isn't valid JSON is forwarded as {type:"raw"} instead of crashing.
      if (proc.stdout) {
        const rl = createInterface({ input: proc.stdout });
        rl.on("line", (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          let event: unknown;
          try {
            event = JSON.parse(trimmed);
          } catch {
            event = { type: "raw", text: line };
          }
          broadcast(id, event);
        });
      }

      proc.stderr?.on("data", (data: Buffer) => {
        broadcast(id, { type: "stderr", text: data.toString("utf-8") });
      });

      proc.on("error", (err) => {
        broadcast(id, { type: "stderr", text: `[spawn error] ${String(err)}` });
      });

      proc.on("close", (code) => {
        broadcast(id, { type: "exit", code });
        simpleSessions.delete(id);
      });

      return id;
    }
  );

  // Follow-up user message from the input bar.
  ipcMain.handle("simple:send", async (_evt, id: string, text: string) => {
    writeLine(simpleSessions.get(id), userMessage(text));
  });

  // Decision for a can_use_tool control_request.
  ipcMain.handle(
    "simple:respond",
    async (_evt, id: string, requestId: string, allow: boolean, input: unknown) => {
      const response = allow
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "User denied this action" };
      writeLine(simpleSessions.get(id), {
        type: "control_response",
        response: { subtype: "success", request_id: requestId, response },
      });
    }
  );

  // Answer an AskUserQuestion tool_use with a tool_result.
  ipcMain.handle("simple:answer", async (_evt, id: string, toolUseId: string, content: string) => {
    writeLine(simpleSessions.get(id), toolResultMessage(toolUseId, content));
  });

  // Interrupt the current turn (Stop button). Session keeps running.
  ipcMain.handle("simple:interrupt", async (_evt, id: string) => {
    writeLine(simpleSessions.get(id), {
      type: "control_request",
      request_id: `int-${Date.now()}`,
      request: { subtype: "interrupt" },
    });
  });

  ipcMain.handle("simple:kill", async (_evt, id: string) => {
    const session = simpleSessions.get(id);
    session?.process.kill("SIGTERM");
    simpleSessions.delete(id);
  });
}
