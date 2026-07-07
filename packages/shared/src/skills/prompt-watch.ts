/** Reliable text injection into a freshly-launched Claude Code TUI.
 *
 *  Watches raw PTY stdout for the "❯" prompt marker instead of guessing with a
 *  blind setTimeout — the TUI may take 1-15s to boot depending on machine/login.
 *  Extracted from plugin main.ts launchSkill / launchOnboardingAgent (identical
 *  pattern in both, now one implementation).
 */

export interface PromptWatchProcess {
  stdout?: {
    on(event: "data", cb: (data: Buffer) => void): void;
    removeListener(event: "data", cb: (data: Buffer) => void): void;
  } | null;
  stdin?: { write(data: string): void } | null;
}

export interface PromptWatchOptions {
  /** Marker that signals the TUI is ready for input. Default "❯". */
  marker?: string;
  /** Delay between marker detection and write — lets the TUI finish painting. Default 200ms. */
  settleMs?: number;
  /** Stop watching after this long. Default 30s. */
  timeoutMs?: number;
}

/** Write `text` to `proc.stdin` once the ready marker appears on stdout.
 *  Returns a cleanup function (removes listener + cancels safety timeout) —
 *  call it if the session is destroyed before the marker shows up. */
export function sendWhenReady(
  proc: PromptWatchProcess,
  text: string,
  opts: PromptWatchOptions = {},
): () => void {
  const marker = opts.marker ?? "❯";
  const settleMs = opts.settleMs ?? 200;
  const timeoutMs = opts.timeoutMs ?? 30000;

  let sent = false;
  const onData = (data: Buffer) => {
    if (sent) return;
    if (data.toString().includes(marker)) {
      sent = true;
      proc.stdout?.removeListener("data", onData);
      setTimeout(() => {
        proc.stdin?.write(text);
      }, settleMs);
    }
  };
  proc.stdout?.on("data", onData);

  const safetyTimeout = setTimeout(() => {
    if (!sent) proc.stdout?.removeListener("data", onData);
  }, timeoutMs);

  return () => {
    proc.stdout?.removeListener("data", onData);
    clearTimeout(safetyTimeout);
  };
}
