// ConnectGoogleModal — 4-state OAuth onboarding UI.
// Per specs/google-workspace-skill-spec.md, ADR-001 (dual-path: Quick Connect + BYO),
// ADR-002 (trust messaging re: local tokens).

import { App, Modal, Notice, Setting } from "obsidian";
import type { OAuthConfig, StoredTokens, TokenStorageMethod } from "@mc/shared";
import { GOOGLE_WORKSPACE_SCOPES } from "@mc/shared";
import { startOAuthFlow, TokenExchangeError } from "../oauth/flow";
import { OAuthDeniedError, OAuthTimeoutError } from "../oauth/loopback-server";
import { EncryptionUnavailableError, TamperedDataError } from "../tokens/storage";

export type ConnectGoogleState =
  | { kind: "disconnected" }
  | { kind: "connecting" }
  | { kind: "connected"; tokens: StoredTokens }
  | { kind: "error"; message: string };

export interface ConnectGoogleModalOptions {
  storage: TokenStorageMethod;
  /** Quick Connect credentials from build-time env (may be empty if .env.local absent) */
  quickConnect: {
    clientId: string;
    clientSecret: string;
  };
  /** Emitted on state changes — plugin/OnboardingModal listens to update status pill */
  onStateChange?: (state: ConnectGoogleState) => void;
}

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  "https://www.googleapis.com/auth/gmail.readonly":
    "Read Gmail messages — for search and context",
  "https://www.googleapis.com/auth/gmail.send":
    "Create email drafts (never auto-sent without your click)",
  "https://www.googleapis.com/auth/calendar.events":
    "Read and create calendar events on your primary calendar",
};

export class ConnectGoogleModal extends Modal {
  private state: ConnectGoogleState = { kind: "disconnected" };
  private readonly options: ConnectGoogleModalOptions;
  private byoClientId = "";
  private byoClientSecret = "";
  private useByo = false;

  constructor(app: App, options: ConnectGoogleModalOptions) {
    super(app);
    this.options = options;
  }

  async onOpen(): Promise<void> {
    // Load existing tokens to determine initial state.
    // Handle TamperedData (corrupted tokens.enc) — force-clear + show error.
    try {
      const tokens = await this.options.storage.loadTokens();
      if (tokens) {
        this.setState({ kind: "connected", tokens });
      } else {
        this.setState({ kind: "disconnected" });
      }
    } catch (err) {
      if (err instanceof TamperedDataError) {
        await this.options.storage.clearTokens().catch(() => undefined);
        this.setState({
          kind: "error",
          message: "Stored tokens were corrupted. Cleared. Please reconnect.",
        });
      } else if (err instanceof EncryptionUnavailableError) {
        this.setState({ kind: "error", message: err.message });
      } else {
        this.setState({ kind: "disconnected" });
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private setState(newState: ConnectGoogleState): void {
    this.state = newState;
    this.render();
    this.options.onStateChange?.(newState);
  }

  getState(): ConnectGoogleState {
    return this.state;
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mc-connect-google-modal");

    // Header
    const header = contentEl.createDiv({ cls: "mc-connect-google-header" });
    header.createEl("h2", { text: "Google Workspace" });
    header.createEl("p", {
      text: "Gmail + Calendar as tools for Claude Code. Local-first, open-source.",
      cls: "mc-connect-google-subtitle",
    });

    switch (this.state.kind) {
      case "disconnected":
        this.renderDisconnected(contentEl);
        break;
      case "connecting":
        this.renderConnecting(contentEl);
        break;
      case "connected":
        this.renderConnected(contentEl, this.state.tokens);
        break;
      case "error":
        this.renderError(contentEl, this.state.message);
        break;
    }

    // Trust messaging — always present
    const trust = contentEl.createDiv({ cls: "mc-trust-message" });
    trust.createEl("strong", { text: "Your tokens never leave your machine. " });
    trust.createSpan({
      text:
        "Encrypted with AES-256-GCM in vault/.modular-context/tokens.enc. " +
        "Master key in OS keychain. No cloud. No telemetry.",
    });
  }

  private renderDisconnected(container: HTMLElement): void {
    // Scope disclosure
    const scopes = container.createEl("details", { cls: "mc-scope-disclosure" });
    scopes.createEl("summary", { text: "What access is requested" });
    const scopeList = scopes.createEl("ul");
    for (const scope of GOOGLE_WORKSPACE_SCOPES) {
      const li = scopeList.createEl("li");
      li.createEl("strong", { text: shortScope(scope) + " " });
      li.createSpan({ text: SCOPE_DESCRIPTIONS[scope] ?? "" });
    }

    const hasQuickConnect =
      this.options.quickConnect.clientId && this.options.quickConnect.clientSecret;

    // Quick Connect button (if available)
    if (hasQuickConnect) {
      const primary = container.createEl("button", {
        text: "Connect with Quick Connect (beta)",
        cls: "mc-oauth-button-primary",
      });
      primary.addEventListener("click", () => {
        this.useByo = false;
        void this.handleConnect();
      });
    } else {
      const notice = container.createDiv({ cls: "mc-connect-google-notice" });
      notice.createEl("p", {
        text: "Quick Connect unavailable in this build. Use 'Bring Your Own' below.",
      });
    }

    // BYO section (expandable)
    const byo = container.createEl("details", { cls: "mc-byo-section" });
    byo.createEl("summary", { text: "Advanced: Bring Your Own OAuth Client" });
    byo.createEl("p", {
      text:
        "Create your own Google Cloud OAuth client for unlimited users, full data sovereignty. " +
        "See troubleshooting guide for step-by-step setup (~5 min).",
      cls: "mc-connect-google-body",
    });

    new Setting(byo)
      .setName("Client ID")
      .addText((input) => {
        input.setPlaceholder("xxx.apps.googleusercontent.com");
        input.onChange((val) => {
          this.byoClientId = val.trim();
        });
      });

    new Setting(byo)
      .setName("Client Secret")
      .addText((input) => {
        input.setPlaceholder("GOCSPX-xxx");
        input.inputEl.type = "password";
        input.onChange((val) => {
          this.byoClientSecret = val.trim();
        });
      });

    const byoBtn = byo.createEl("button", {
      text: "Connect with my OAuth client",
      cls: "mc-oauth-button-secondary",
    });
    byoBtn.addEventListener("click", () => {
      if (!this.byoClientId || !this.byoClientSecret) {
        new Notice("Please enter both Client ID and Client Secret");
        return;
      }
      if (!this.byoClientId.endsWith(".apps.googleusercontent.com")) {
        new Notice("Client ID should end with .apps.googleusercontent.com");
        return;
      }
      this.useByo = true;
      void this.handleConnect();
    });
  }

  private renderConnecting(container: HTMLElement): void {
    const wrapper = container.createDiv({
      cls: "mc-connection-state mc-connection-state-connecting",
    });
    wrapper.createDiv({ cls: "mc-connecting-spinner", text: "⟳" });
    wrapper.createEl("p", {
      text: "Opening browser... Approve in browser to continue.",
    });
    wrapper.createEl("p", {
      text: "This modal will update automatically when you authorize.",
      cls: "mc-connect-google-body",
    });
  }

  private renderConnected(container: HTMLElement, tokens: StoredTokens): void {
    const wrapper = container.createDiv({
      cls: "mc-connection-state mc-connection-state-connected",
    });
    wrapper.createDiv({ cls: "mc-connection-icon", text: "✓" });
    wrapper.createEl("h3", { text: "Connected" });
    wrapper.createEl("p", { text: tokens.accountEmail });

    const remainingMs = tokens.expiresAt - Date.now();
    const remainingMin = Math.max(0, Math.floor(remainingMs / 60000));
    wrapper.createEl("p", {
      text: `Access token expires in ~${remainingMin} min (auto-refreshed).`,
      cls: "mc-connect-google-body",
    });

    const actions = container.createDiv({ cls: "mc-connected-actions" });
    const disconnectBtn = actions.createEl("button", {
      text: "Disconnect",
      cls: "mc-oauth-button-secondary",
    });
    disconnectBtn.addEventListener("click", () => void this.handleDisconnect());

    const reconnectBtn = actions.createEl("button", {
      text: "Reconnect / switch account",
      cls: "mc-oauth-button-secondary",
    });
    reconnectBtn.addEventListener("click", () => void this.handleReconnect());
  }

  private renderError(container: HTMLElement, message: string): void {
    const wrapper = container.createDiv({
      cls: "mc-connection-state mc-connection-state-error",
    });
    wrapper.createDiv({ cls: "mc-connection-icon", text: "⚠" });
    wrapper.createEl("h3", { text: "Connection failed" });
    wrapper.createEl("p", { text: message });

    const retryBtn = container.createEl("button", {
      text: "Try again",
      cls: "mc-oauth-button-primary",
    });
    retryBtn.addEventListener("click", () => {
      this.setState({ kind: "disconnected" });
    });
  }

  private async handleConnect(): Promise<void> {
    // Debounce concurrent OAuth attempts — if already connecting, ignore
    if (this.state.kind === "connecting") {
      new Notice("OAuth flow already in progress, please wait");
      return;
    }
    this.setState({ kind: "connecting" });

    const config: OAuthConfig = this.useByo
      ? {
          clientId: this.byoClientId,
          clientSecret: this.byoClientSecret,
          scopes: [...GOOGLE_WORKSPACE_SCOPES],
          mode: "byo",
        }
      : {
          clientId: this.options.quickConnect.clientId,
          clientSecret: this.options.quickConnect.clientSecret,
          scopes: [...GOOGLE_WORKSPACE_SCOPES],
          mode: "quick-connect",
        };

    try {
      const tokens = await startOAuthFlow(config);
      await this.options.storage.saveTokens(tokens);
      this.setState({ kind: "connected", tokens });
      new Notice(`Connected to Google Workspace as ${tokens.accountEmail}`);
    } catch (err) {
      const message = friendlyError(err);
      this.setState({ kind: "error", message });
    }
  }

  private async handleDisconnect(): Promise<void> {
    // Simple confirm via Notice + wait — Obsidian has no built-in confirm dialog
    // User clicks disconnect twice to confirm, but simpler: just do it (destructive is tokens, not code)
    try {
      await this.options.storage.clearTokens();
      this.setState({ kind: "disconnected" });
      new Notice("Disconnected from Google Workspace");
    } catch (err) {
      this.setState({ kind: "error", message: friendlyError(err) });
    }
  }

  private async handleReconnect(): Promise<void> {
    await this.options.storage.clearTokens().catch(() => undefined);
    this.setState({ kind: "disconnected" });
  }
}

function shortScope(scope: string): string {
  const parts = scope.split("/");
  return parts[parts.length - 1];
}

function friendlyError(err: unknown): string {
  if (err instanceof OAuthDeniedError) {
    return "You denied consent in the browser. Try again and approve the requested scopes.";
  }
  if (err instanceof OAuthTimeoutError) {
    return "Browser authorization timed out (2 min). Try again.";
  }
  if (err instanceof TokenExchangeError) {
    return `Token exchange failed. ${err.message}`;
  }
  if (err instanceof EncryptionUnavailableError) {
    return err.message;
  }
  if (err instanceof TamperedDataError) {
    return err.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
