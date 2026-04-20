// ConnectGoogleModal — multi-account OAuth UI.
// Per specs/google-workspace-skill-spec.md, ADR-001 (dual-path: Quick Connect + BYO),
// ADR-002 (trust messaging re: local tokens), ADR-005 (multi-account).

import { App, Modal, Notice, Setting } from "obsidian";
import type {
  AccountIndex,
  MultiTokenStorage,
  OAuthConfig,
  StoredTokens,
  TokenStorageMethod,
} from "@mc/shared";
import { GOOGLE_WORKSPACE_SCOPES, normalizeAccountId } from "@mc/shared";
import { startOAuthFlow, TokenExchangeError } from "../oauth/flow";
import { OAuthDeniedError, OAuthTimeoutError } from "../oauth/loopback-server";
import { EncryptionUnavailableError, TamperedDataError } from "../tokens/storage";

export type ConnectGoogleState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "list"; accounts: AccountIndex[] }
  | { kind: "connecting"; addingAnother: boolean }
  | { kind: "connected"; tokens: StoredTokens }
  | { kind: "disconnected" }
  | { kind: "error"; message: string };

export interface ConnectGoogleModalOptions {
  /** Legacy single-account API — kept for back-compat callers (not used internally). */
  storage: TokenStorageMethod;
  /** Multi-account API — primary surface for modal operations. */
  multiStorage: MultiTokenStorage;
  /** Quick Connect credentials from build-time env (may be empty if .env.local absent) */
  quickConnect: {
    clientId: string;
    clientSecret: string;
  };
  /** Emitted on state changes — plugin/OnboardingModal listens to update status pill + sync MCP */
  onStateChange?: (state: ConnectGoogleState) => void;
}

const GOOGLE_ICON_SVG_MARKUP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/><path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/><path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/><path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/></svg>`;

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  openid: "Sign in to fetch your account email",
  email: "Read your Google account email address",
  profile: "Read basic Google profile info (name)",
  "https://www.googleapis.com/auth/gmail.modify":
    "Read, draft, send, and label Gmail messages",
  "https://www.googleapis.com/auth/calendar":
    "Full access to Calendar events, calendars, and free/busy windows",
  "https://www.googleapis.com/auth/drive.file":
    "Read and write Drive files created or opened by this plugin",
  "https://www.googleapis.com/auth/drive.metadata.readonly":
    "List and search Drive file metadata (no content access outside drive.file)",
  "https://www.googleapis.com/auth/documents":
    "Read, create, and edit Google Docs",
  "https://www.googleapis.com/auth/spreadsheets":
    "Read, create, and edit Google Sheets",
  "https://www.googleapis.com/auth/presentations":
    "Read, create, and edit Google Slides",
};

export class ConnectGoogleModal extends Modal {
  private state: ConnectGoogleState = { kind: "loading" };
  private readonly options: ConnectGoogleModalOptions;
  private byoClientId = "";
  private byoClientSecret = "";
  private useByo = false;

  constructor(app: App, options: ConnectGoogleModalOptions) {
    super(app);
    this.options = options;
  }

  async onOpen(): Promise<void> {
    await this.refreshFromStorage();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async refreshFromStorage(): Promise<void> {
    try {
      const accounts = await this.options.multiStorage.listAccounts();
      if (accounts.length === 0) {
        this.setState({ kind: "empty" });
      } else {
        this.setState({ kind: "list", accounts });
      }
    } catch (err) {
      if (err instanceof TamperedDataError) {
        this.setState({
          kind: "error",
          message: "Stored tokens were corrupted. Use 'Disconnect all' and reconnect.",
        });
      } else if (err instanceof EncryptionUnavailableError) {
        this.setState({ kind: "error", message: err.message });
      } else {
        this.setState({ kind: "empty" });
      }
    }
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

    const header = contentEl.createDiv({ cls: "mc-connect-google-header" });
    header.createEl("h2", { text: "Google Workspace" });
    header.createEl("p", {
      text: "Gmail, Calendar, Drive, Docs, Sheets, and Slides as tools for Claude Code. Local-first, open-source.",
      cls: "mc-connect-google-subtitle",
    });

    switch (this.state.kind) {
      case "loading":
        this.renderLoading(contentEl);
        break;
      case "empty":
        this.renderEmpty(contentEl);
        break;
      case "list":
        this.renderAccountList(contentEl, this.state.accounts);
        break;
      case "connecting":
        this.renderConnecting(contentEl, this.state.addingAnother);
        break;
      case "error":
        this.renderError(contentEl, this.state.message);
        break;
      // Legacy states retained in type for onStateChange consumers; no render path.
      case "connected":
      case "disconnected":
        break;
    }

    const trust = contentEl.createDiv({ cls: "mc-trust-message" });
    trust.createEl("strong", { text: "Your tokens never leave your machine. " });
    trust.createSpan({
      text:
        "Encrypted with AES-256-GCM in vault/.modular-context/accounts/. " +
        "Master key in OS keychain. No cloud. No telemetry.",
    });
  }

  private renderLoading(container: HTMLElement): void {
    const wrapper = container.createDiv({
      cls: "mc-connection-state mc-connection-state-connecting",
    });
    wrapper.createDiv({ cls: "mc-connecting-spinner", text: "⟳" });
    wrapper.createEl("p", { text: "Loading accounts..." });
  }

  private renderEmpty(container: HTMLElement): void {
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

    if (hasQuickConnect) {
      const primary = container.createEl("button", { cls: "mc-oauth-button-google" });
      const icon = primary.createSpan({ cls: "mc-oauth-button-google-icon" });
      icon.innerHTML = GOOGLE_ICON_SVG_MARKUP;
      primary.createSpan({
        cls: "mc-oauth-button-google-label",
        text: "Connect with Google",
      });
      primary.addEventListener("click", () => {
        this.useByo = false;
        void this.handleConnect(false);
      });

      const hint = container.createDiv({ cls: "mc-quick-connect-hint" });
      hint.createSpan({
        text: "Getting \"Error 403: access_denied\"? Comment your email at ",
      });
      const link = hint.createEl("a", {
        text: "issue #3",
        href: "https://github.com/klemensgc/modular-context-obsidian-plugin/issues/3",
      });
      link.setAttr("target", "_blank");
      link.setAttr("rel", "noopener");
      hint.createSpan({ text: " to be added as a test user." });
    } else {
      const notice = container.createDiv({ cls: "mc-connect-google-notice" });
      notice.createEl("p", {
        text: "Quick Connect unavailable in this build. Use 'Advanced' below.",
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

    new Setting(byo).setName("Client ID").addText((input) => {
      input.setPlaceholder("xxx.apps.googleusercontent.com");
      input.onChange((val) => {
        this.byoClientId = val.trim();
      });
    });

    new Setting(byo).setName("Client Secret").addText((input) => {
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
      void this.handleConnect(false);
    });
  }

  private renderAccountList(container: HTMLElement, accounts: AccountIndex[]): void {
    const wrapper = container.createDiv({ cls: "mc-account-list" });

    for (const account of accounts) {
      const item = wrapper.createDiv({ cls: "mc-account-list-item" });
      if (account.isPrimary) item.addClass("is-primary");

      const avatar = item.createDiv({ cls: "mc-account-list-avatar" });
      avatar.innerHTML = GOOGLE_ICON_SVG_MARKUP;

      const body = item.createDiv({ cls: "mc-account-list-body" });
      const titleRow = body.createDiv({ cls: "mc-account-list-title-row" });
      titleRow.createSpan({ cls: "mc-account-list-email", text: account.email });
      if (account.isPrimary) {
        titleRow.createSpan({ cls: "mc-account-primary-badge", text: "primary" });
      }

      const metaRow = body.createDiv({ cls: "mc-account-list-meta" });
      const expiryText = this.formatExpiry(account);
      if (expiryText) metaRow.createSpan({ cls: "mc-account-expires", text: expiryText });

      const actions = item.createDiv({ cls: "mc-account-actions-inline" });

      if (!account.isPrimary) {
        const setPrimaryBtn = actions.createEl("button", {
          cls: "mc-oauth-button-secondary mc-account-action-btn",
          text: "Set primary",
        });
        setPrimaryBtn.addEventListener("click", () =>
          void this.handleSetPrimary(account.id),
        );
      }

      const disconnectBtn = actions.createEl("button", {
        cls: "mc-oauth-button-secondary mc-account-action-btn is-destructive",
        text: "Disconnect",
      });
      disconnectBtn.addEventListener("click", () =>
        void this.handleDisconnectAccount(account),
      );
    }

    if (accounts.length >= 10) {
      const warn = wrapper.createDiv({ cls: "mc-account-list-warn" });
      warn.createEl("span", {
        text: `${accounts.length} accounts connected — consider disconnecting unused ones.`,
      });
    }

    const addBtn = wrapper.createEl("button", {
      cls: "mc-add-another-btn",
      text: "+ Add another account",
    });
    addBtn.addEventListener("click", () => {
      this.useByo = false;
      void this.handleConnect(true);
    });
  }

  private renderConnecting(container: HTMLElement, addingAnother: boolean): void {
    const wrapper = container.createDiv({
      cls: "mc-connection-state mc-connection-state-connecting",
    });
    wrapper.createDiv({ cls: "mc-connecting-spinner", text: "⟳" });
    wrapper.createEl("p", {
      text: addingAnother
        ? "Opening browser to add another account..."
        : "Opening browser... Approve in browser to continue.",
    });
    wrapper.createEl("p", {
      text: "This modal will update automatically when you authorize.",
      cls: "mc-connect-google-body",
    });
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
      void this.refreshFromStorage();
    });
  }

  private async handleConnect(addingAnother: boolean): Promise<void> {
    if (this.state.kind === "connecting") {
      new Notice("OAuth flow already in progress, please wait");
      return;
    }
    this.setState({ kind: "connecting", addingAnother });

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
      // Use multi-account API directly — MultiAccountSafeStorage.saveTokens only
      // promotes to primary when accounts array was empty (first connect).
      // Subsequent adds leave existing primary intact.
      const id = normalizeAccountId(tokens.accountEmail);
      await this.options.multiStorage.saveTokens(id, tokens);

      // Notify listeners so MCP config sync picks up the new account.
      this.options.onStateChange?.({ kind: "connected", tokens });

      new Notice(`Connected to Google Workspace as ${tokens.accountEmail}`);
      await this.refreshFromStorage();
    } catch (err) {
      const message = friendlyError(err);
      this.setState({ kind: "error", message });
    }
  }

  private async handleSetPrimary(accountId: string): Promise<void> {
    try {
      await this.options.multiStorage.setPrimary(accountId);
      // Emit a synthetic "connected" event so MCP sync refreshes with new primary.
      const tokens = await this.options.multiStorage.loadTokens(accountId).catch(() => null);
      if (tokens) this.options.onStateChange?.({ kind: "connected", tokens });
      new Notice("Primary account updated");
      await this.refreshFromStorage();
    } catch (err) {
      this.setState({ kind: "error", message: friendlyError(err) });
    }
  }

  private async handleDisconnectAccount(account: AccountIndex): Promise<void> {
    try {
      await this.options.multiStorage.removeAccount(account.id);
      const remaining = await this.options.multiStorage.listAccounts();
      if (remaining.length === 0) {
        this.options.onStateChange?.({ kind: "disconnected" });
        new Notice(`Disconnected ${account.email}. No accounts remain.`);
      } else {
        // Signal a "connected" event with new primary so MCP rewrites with remaining account.
        const primaryId = await this.options.multiStorage.getPrimaryAccountId();
        if (primaryId) {
          const tokens = await this.options.multiStorage.loadTokens(primaryId).catch(() => null);
          if (tokens) this.options.onStateChange?.({ kind: "connected", tokens });
        }
        new Notice(`Disconnected ${account.email}`);
      }
      await this.refreshFromStorage();
    } catch (err) {
      this.setState({ kind: "error", message: friendlyError(err) });
    }
  }

  private formatExpiry(account: AccountIndex): string {
    const when = account.lastRefreshed ?? account.connectedAt;
    if (!when) return "";
    const whenDate = new Date(when);
    const diffMs = Date.now() - whenDate.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `last refreshed ${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `last refreshed ${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `last refreshed ${diffDay}d ago`;
  }
}

function shortScope(scope: string): string {
  const parts = scope.split("/");
  return parts[parts.length - 1];
}

function friendlyError(err: unknown): string {
  if (err instanceof OAuthDeniedError) {
    if (err.googleError === "access_denied") {
      return (
        "Google blocked this account (\"Error 403: access_denied\"). " +
        "The shared Quick Connect client is in Testing mode — your email " +
        "must be on the test-users list. Comment your email at " +
        "https://github.com/klemensgc/modular-context-obsidian-plugin/issues/3 " +
        "to be added."
      );
    }
    return "You denied consent in the browser. Try again and approve the requested scopes.";
  }
  if (err instanceof OAuthTimeoutError) {
    return (
      "Browser authorization timed out (2 min). If you saw \"Access blocked\" / " +
      "\"Error 403: access_denied\", the shared Quick Connect client is in " +
      "Testing mode — comment your email at " +
      "https://github.com/klemensgc/modular-context-obsidian-plugin/issues/3 " +
      "to be added as a test user. Otherwise just try again."
    );
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
