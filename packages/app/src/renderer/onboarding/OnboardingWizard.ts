/** OnboardingWizard — first-run flow that takes a fresh download to a working
 *  Modular Context vault.
 *
 *  Steps: welcome (create/open) → doctor (preflight) → methodology (LLM Wiki)
 *  → setup (create path only: name/location/language/projects) → skills
 *  (registry picker + install) → finish (Start Here agent opt-in).
 *
 *  The completion flag is set ONLY when the user reaches finish — closing the
 *  window early means the wizard shows again next launch (the plugin's
 *  "flag-on-show" bug is deliberately not reproduced here).
 *
 *  Methodology copy is ported 1:1 from the plugin's OnboardingModal.
 */

import type { RegistryData, RegistrySkill } from "@mc/shared";
import { CATEGORY_META } from "@mc/shared";
import { createSignetMark } from "../layout/Loader";

export type WizardMission = "scaffolded" | "scan";

export interface WizardResult {
  vaultPath: string;
  mission: WizardMission;
  launchStartHere: boolean;
}

export interface WizardOptions {
  /** Revisit mode — vault already open; skips welcome + setup, installs into it. */
  existingVaultPath?: string | null;
  recentFolders?: string[];
  onFinished: (result: WizardResult) => void;
  /** Revisit mode only — wizard can be dismissed without finishing. */
  onDismiss?: () => void;
}

interface DoctorCheck {
  id: string;
  label: string;
  ok: boolean;
  critical: boolean;
  detail: string;
  fixHint?: string;
}

type StepId = "welcome" | "doctor" | "methodology" | "setup" | "skills" | "finish";

/** Skills pre-checked in the picker — high-value, no external prereqs
 *  (gsuite/whatsapp/clickup-gated skills stay opt-in). */
const PRECHECKED_SKILLS = new Set([
  "process-transcripts", "pulse", "vault-audit", "log", "ideas", "skills-audit",
]);

const HOW_IT_WORKS: [string, string][] = [
  ["Capture", "Record conversations, meetings, ideas — drop raw transcripts into the vault"],
  ["Process", "AI agents categorize, extract insights, and update knowledge modules automatically"],
  ["Connect", "Wiki-links and cross-references build a living knowledge graph across all your projects"],
  ["Act", "Skills turn vault knowledge into deliverables — briefs, audits, strategic pulses, syncs"],
];

const BUILD_VAULT_STEPS: string[] = [
  "Start with CLAUDE.md — it teaches Claude how to navigate your vault",
  "Create project folders with index files as entry points",
  "Add _transcripts/ for raw material and keep its backlog as your inbox",
  "Define skills in .claude/skills/ to automate recurring workflows",
  "Use frontmatter (status, updated, depends-on) to keep everything alive",
];

const DASHBOARD_COPY =
  "The terminal panel is your command center. Skills at the top are your daily drivers — click any to launch a Claude Code session that executes it. Working shows running agents. To Review surfaces completed work awaiting your approval.";

const LANGUAGES = ["English", "Polish", "German", "Spanish", "French", "Ukrainian"];

export class OnboardingWizard {
  private overlay: HTMLElement;
  private bodyEl!: HTMLElement;
  private footerEl!: HTMLElement;
  private opts: WizardOptions;

  private mode: "create" | "open" = "create";
  private step: StepId;
  private vaultPath: string | null = null;
  private doctorChecks: DoctorCheck[] | null = null;
  private registry: RegistryData | null = null;
  private selectedSkills = new Set<string>(PRECHECKED_SKILLS);
  private installedCount = 0;
  private gitInitialized = false;

  // setup-step state
  private parentDir: string | null = null;
  private vaultName = "my-vault";
  private language = "English";
  private projects: string[] = ["", "", ""];

  constructor(root: HTMLElement, opts: WizardOptions) {
    this.opts = opts;
    if (opts.existingVaultPath) {
      this.vaultPath = opts.existingVaultPath;
      this.mode = "open";
      this.step = "doctor";
    } else {
      this.step = "welcome";
    }

    this.overlay = document.createElement("div");
    this.overlay.className = "mc-wizard-overlay";
    root.appendChild(this.overlay);
    this.render();
  }

  /** Called by the renderer when the user picked an existing folder via dialog. */
  setExistingVault(path: string) {
    this.vaultPath = path;
    this.mode = "open";
    if (this.step === "welcome") this.step = "doctor";
    this.render();
  }

  destroy() {
    this.overlay.remove();
  }

  // ─────────────────────────── step plumbing ───────────────────────────

  private stepOrder(): StepId[] {
    return this.mode === "create"
      ? ["welcome", "doctor", "methodology", "setup", "skills", "finish"]
      : this.opts.existingVaultPath
        ? ["doctor", "methodology", "skills", "finish"]
        : ["welcome", "doctor", "methodology", "skills", "finish"];
  }

  private goNext() {
    const order = this.stepOrder();
    const idx = order.indexOf(this.step);
    if (idx < order.length - 1) {
      this.step = order[idx + 1];
      this.render();
    }
  }

  private goBack() {
    const order = this.stepOrder();
    const idx = order.indexOf(this.step);
    if (idx > 0) {
      this.step = order[idx - 1];
      this.render();
    }
  }

  private render() {
    this.overlay.innerHTML = "";

    const panel = document.createElement("div");
    panel.className = "mc-wizard-panel";
    this.overlay.appendChild(panel);

    // Header
    const header = document.createElement("div");
    header.className = "mc-wizard-header";
    const titleRow = document.createElement("div");
    titleRow.className = "mc-wizard-title-row";
    titleRow.appendChild(createSignetMark(22));
    const titleWrap = document.createElement("div");
    const title = document.createElement("h2");
    title.textContent = "Modular Context";
    titleWrap.appendChild(title);
    const byline = document.createElement("span");
    byline.className = "mc-wizard-byline";
    byline.textContent = "by receptionOS";
    titleWrap.appendChild(byline);
    titleRow.appendChild(titleWrap);
    header.appendChild(titleRow);
    const subtitle = document.createElement("p");
    subtitle.className = "mc-wizard-subtitle";
    subtitle.textContent = "Your AI-native second brain — a structured knowledge base, powered by Claude Code.";
    header.appendChild(subtitle);
    if (this.opts.onDismiss) {
      const closeBtn = document.createElement("button");
      closeBtn.className = "mc-wizard-close";
      closeBtn.innerHTML = "&times;";
      closeBtn.title = "Close";
      closeBtn.addEventListener("click", () => {
        this.destroy();
        this.opts.onDismiss?.();
      });
      header.appendChild(closeBtn);
    }
    panel.appendChild(header);

    // Progress dots
    const order = this.stepOrder();
    if (this.step !== "welcome") {
      const dots = document.createElement("div");
      dots.className = "mc-wizard-dots";
      for (const s of order) {
        if (s === "welcome") continue;
        const dot = document.createElement("span");
        dot.className = "mc-wizard-dot";
        if (s === this.step) dot.classList.add("is-active");
        else if (order.indexOf(s) < order.indexOf(this.step)) dot.classList.add("is-done");
        dots.appendChild(dot);
      }
      panel.appendChild(dots);
    }

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "mc-wizard-body";
    panel.appendChild(this.bodyEl);

    this.footerEl = document.createElement("div");
    this.footerEl.className = "mc-wizard-footer";
    panel.appendChild(this.footerEl);

    switch (this.step) {
      case "welcome": this.renderWelcome(); break;
      case "doctor": this.renderDoctor(); break;
      case "methodology": this.renderMethodology(); break;
      case "setup": this.renderSetup(); break;
      case "skills": this.renderSkills(); break;
      case "finish": this.renderFinish(); break;
    }
  }

  private footerNav(opts: { back?: boolean; next?: string; nextDisabled?: boolean; onNext?: () => void }) {
    this.footerEl.innerHTML = "";
    if (opts.back) {
      const backBtn = document.createElement("button");
      backBtn.className = "mc-wizard-btn is-secondary";
      backBtn.textContent = "Back";
      backBtn.addEventListener("click", () => this.goBack());
      this.footerEl.appendChild(backBtn);
    }
    const spacer = document.createElement("div");
    spacer.className = "mc-wizard-footer-spacer";
    this.footerEl.appendChild(spacer);
    if (opts.next) {
      const nextBtn = document.createElement("button");
      nextBtn.className = "mc-wizard-btn is-primary";
      nextBtn.textContent = opts.next;
      nextBtn.disabled = !!opts.nextDisabled;
      nextBtn.addEventListener("click", () => (opts.onNext ? opts.onNext() : this.goNext()));
      this.footerEl.appendChild(nextBtn);
    }
  }

  // ─────────────────────────── welcome ───────────────────────────

  private renderWelcome() {
    const wrap = this.bodyEl;

    const intro = document.createElement("p");
    intro.className = "mc-wizard-lead";
    intro.textContent =
      "Modular Context is an LLM Wiki: you curate sources and ask questions, the AI writes and maintains the knowledge base. Let's set yours up.";
    wrap.appendChild(intro);

    const choices = document.createElement("div");
    choices.className = "mc-wizard-choices";

    const createCard = this.choiceCard(
      "Create a new vault",
      "Start from the Modular Context template — schema, agents, sample content, git. Ready for the first ingest in under a minute.",
      () => {
        this.mode = "create";
        this.goNext();
      },
    );
    createCard.classList.add("is-recommended");
    choices.appendChild(createCard);

    choices.appendChild(this.choiceCard(
      "Open an existing folder",
      "Bring your own notes — an AI agent will scan the structure and propose how to weave the methodology into it.",
      () => {
        this.mode = "open";
        const mcVault = (window as any).mcVault;
        // Main shows the dialog and emits vault:opened → renderer routes it back
        // to setExistingVault(). No state change until the user actually picks.
        mcVault.pickFolder();
      },
    ));
    wrap.appendChild(choices);

    const recents = this.opts.recentFolders ?? [];
    if (recents.length > 0) {
      const recentHeader = document.createElement("div");
      recentHeader.className = "mc-wizard-section-label";
      recentHeader.textContent = "RECENT";
      wrap.appendChild(recentHeader);
      const list = document.createElement("div");
      list.className = "mc-wizard-recents";
      for (const folder of recents.slice(0, 5)) {
        const item = document.createElement("button");
        item.className = "mc-wizard-recent-item";
        item.textContent = folder;
        item.addEventListener("click", () => this.setExistingVault(folder));
        list.appendChild(item);
      }
      wrap.appendChild(list);
    }

    this.footerNav({});
  }

  private choiceCard(title: string, desc: string, onClick: () => void): HTMLElement {
    const card = document.createElement("button");
    card.className = "mc-wizard-choice";
    const t = document.createElement("strong");
    t.textContent = title;
    card.appendChild(t);
    const d = document.createElement("span");
    d.textContent = desc;
    card.appendChild(d);
    card.addEventListener("click", onClick);
    return card;
  }

  // ─────────────────────────── doctor ───────────────────────────

  private renderDoctor() {
    const wrap = this.bodyEl;
    const h = document.createElement("h3");
    h.textContent = "Environment check";
    wrap.appendChild(h);
    const p = document.createElement("p");
    p.className = "mc-wizard-lead";
    p.textContent = "Modular Context drives Claude Code in a real terminal. Checking everything that needs to be in place:";
    wrap.appendChild(p);

    const listEl = document.createElement("div");
    listEl.className = "mc-wizard-doctor-list";
    wrap.appendChild(listEl);

    const renderChecks = (checks: DoctorCheck[]) => {
      listEl.innerHTML = "";
      for (const check of checks) {
        const row = document.createElement("div");
        row.className = "mc-wizard-doctor-row";
        row.classList.add(check.ok ? "is-ok" : check.critical ? "is-fail" : "is-warn");

        const icon = document.createElement("span");
        icon.className = "mc-wizard-doctor-icon";
        icon.textContent = check.ok ? "✓" : check.critical ? "✕" : "!";
        row.appendChild(icon);

        const text = document.createElement("div");
        text.className = "mc-wizard-doctor-text";
        const label = document.createElement("strong");
        label.textContent = check.label;
        text.appendChild(label);
        const detail = document.createElement("span");
        detail.textContent = check.ok ? check.detail : (check.fixHint ?? check.detail);
        text.appendChild(detail);
        row.appendChild(text);

        listEl.appendChild(row);
      }
    };

    const runChecks = async () => {
      listEl.innerHTML = `<div class="mc-wizard-doctor-running">Running checks…</div>`;
      const mcOnboarding = (window as any).mcOnboarding;
      this.doctorChecks = (await mcOnboarding.runDoctor()) as DoctorCheck[];
      renderChecks(this.doctorChecks);
      updateFooter();
    };

    const updateFooter = () => {
      const criticalFailed = (this.doctorChecks ?? []).some((c) => c.critical && !c.ok);
      this.footerEl.innerHTML = "";
      const back = document.createElement("button");
      back.className = "mc-wizard-btn is-secondary";
      back.textContent = this.stepOrder()[0] === "doctor" ? "Re-check" : "Back";
      back.addEventListener("click", () => (this.stepOrder()[0] === "doctor" ? runChecks() : this.goBack()));
      this.footerEl.appendChild(back);

      if (this.doctorChecks && this.stepOrder()[0] !== "doctor") {
        const recheck = document.createElement("button");
        recheck.className = "mc-wizard-btn is-secondary";
        recheck.textContent = "Re-check";
        recheck.addEventListener("click", () => runChecks());
        this.footerEl.appendChild(recheck);
      }

      const spacer = document.createElement("div");
      spacer.className = "mc-wizard-footer-spacer";
      this.footerEl.appendChild(spacer);

      const next = document.createElement("button");
      next.className = "mc-wizard-btn is-primary";
      next.textContent = criticalFailed ? "Continue anyway" : "Continue";
      next.disabled = !this.doctorChecks;
      next.addEventListener("click", () => this.goNext());
      this.footerEl.appendChild(next);
    };

    updateFooter();
    if (this.doctorChecks) renderChecks(this.doctorChecks);
    else void runChecks();
  }

  // ─────────────────────────── methodology ───────────────────────────

  private renderMethodology() {
    const wrap = this.bodyEl;

    const h1 = document.createElement("h3");
    h1.textContent = "How it works";
    wrap.appendChild(h1);

    const steps = document.createElement("div");
    steps.className = "mc-wizard-steps";
    HOW_IT_WORKS.forEach(([title, desc], i) => {
      const step = document.createElement("div");
      step.className = "mc-wizard-step";
      const num = document.createElement("div");
      num.className = "mc-wizard-step-num";
      num.textContent = String(i + 1);
      step.appendChild(num);
      const text = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = title;
      text.appendChild(strong);
      const span = document.createElement("span");
      span.textContent = ` — ${desc}`;
      text.appendChild(span);
      step.appendChild(text);
      steps.appendChild(step);
    });
    wrap.appendChild(steps);

    const h2 = document.createElement("h3");
    h2.textContent = "Your vault, layer by layer";
    wrap.appendChild(h2);
    const ol = document.createElement("ol");
    ol.className = "mc-wizard-vault-list";
    for (const stepText of BUILD_VAULT_STEPS) {
      const li = document.createElement("li");
      li.textContent = stepText;
      ol.appendChild(li);
    }
    wrap.appendChild(ol);

    const h3 = document.createElement("h3");
    h3.textContent = "Dashboard";
    wrap.appendChild(h3);
    const dash = document.createElement("p");
    dash.className = "mc-wizard-body-text";
    dash.textContent = DASHBOARD_COPY;
    wrap.appendChild(dash);

    this.footerNav({ back: true, next: "Continue" });
  }

  // ─────────────────────────── setup (create path) ───────────────────────────

  private renderSetup() {
    const wrap = this.bodyEl;
    const h = document.createElement("h3");
    h.textContent = "Create your vault";
    wrap.appendChild(h);

    const form = document.createElement("div");
    form.className = "mc-wizard-form";
    wrap.appendChild(form);

    // Vault name
    const nameField = this.field(form, "Vault name");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = this.vaultName;
    nameInput.addEventListener("input", () => {
      this.vaultName = nameInput.value;
      updateCreateBtn();
    });
    nameField.appendChild(nameInput);

    // Location
    const locField = this.field(form, "Location");
    const locRow = document.createElement("div");
    locRow.className = "mc-wizard-loc-row";
    const locLabel = document.createElement("span");
    locLabel.className = "mc-wizard-loc-path";
    locLabel.textContent = this.parentDir ?? "Choose a folder…";
    const locBtn = document.createElement("button");
    locBtn.className = "mc-wizard-btn is-secondary";
    locBtn.textContent = "Choose…";
    locBtn.addEventListener("click", async () => {
      const mcOnboarding = (window as any).mcOnboarding;
      const dir = await mcOnboarding.pickParentDir();
      if (dir) {
        this.parentDir = dir;
        locLabel.textContent = dir;
        updateCreateBtn();
      }
    });
    locRow.appendChild(locLabel);
    locRow.appendChild(locBtn);
    locField.appendChild(locRow);

    // Language
    const langField = this.field(form, "Vault language (Claude responds in it; structure stays English)");
    const langSelect = document.createElement("select");
    for (const lang of LANGUAGES) {
      const opt = document.createElement("option");
      opt.value = lang;
      opt.textContent = lang;
      if (lang === this.language) opt.selected = true;
      langSelect.appendChild(opt);
    }
    langSelect.addEventListener("change", () => {
      this.language = langSelect.value;
    });
    langField.appendChild(langSelect);

    // Projects
    const projField = this.field(form, "Your projects or areas (1-3 — folders are generated for each)");
    for (let i = 0; i < 3; i++) {
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = i === 0 ? "e.g. My Startup (required)" : "optional";
      input.value = this.projects[i];
      input.addEventListener("input", () => {
        this.projects[i] = input.value;
        updateCreateBtn();
      });
      projField.appendChild(input);
    }

    const errEl = document.createElement("div");
    errEl.className = "mc-wizard-error";
    wrap.appendChild(errEl);

    const canCreate = () =>
      this.vaultName.trim().length > 0 && !!this.parentDir && this.projects[0].trim().length > 0;

    let createBtn: HTMLButtonElement;
    const updateCreateBtn = () => {
      if (createBtn) createBtn.disabled = !canCreate();
    };

    this.footerEl.innerHTML = "";
    const backBtn = document.createElement("button");
    backBtn.className = "mc-wizard-btn is-secondary";
    backBtn.textContent = "Back";
    backBtn.addEventListener("click", () => this.goBack());
    this.footerEl.appendChild(backBtn);
    const spacer = document.createElement("div");
    spacer.className = "mc-wizard-footer-spacer";
    this.footerEl.appendChild(spacer);
    createBtn = document.createElement("button");
    createBtn.className = "mc-wizard-btn is-primary";
    createBtn.textContent = "Create vault";
    createBtn.disabled = !canCreate();
    createBtn.addEventListener("click", async () => {
      createBtn.disabled = true;
      createBtn.textContent = "Creating…";
      errEl.textContent = "";
      const mcOnboarding = (window as any).mcOnboarding;
      try {
        const result = await mcOnboarding.createVault({
          parentDir: this.parentDir,
          name: this.vaultName.trim(),
          language: this.language,
          projects: this.projects.map((p) => p.trim()).filter(Boolean),
        });
        this.vaultPath = result.vaultPath;
        this.gitInitialized = result.gitInitialized;
        this.goNext();
      } catch (err) {
        errEl.textContent = String((err as Error)?.message ?? err).replace(/^Error invoking remote method.*?: Error: /, "");
        createBtn.disabled = false;
        createBtn.textContent = "Create vault";
      }
    });
    this.footerEl.appendChild(createBtn);
  }

  private field(form: HTMLElement, label: string): HTMLElement {
    const field = document.createElement("div");
    field.className = "mc-wizard-field";
    const l = document.createElement("label");
    l.textContent = label;
    field.appendChild(l);
    form.appendChild(field);
    return field;
  }

  // ─────────────────────────── skills ───────────────────────────

  private renderSkills() {
    const wrap = this.bodyEl;
    const h = document.createElement("h3");
    h.textContent = "Install skills";
    wrap.appendChild(h);
    const p = document.createElement("p");
    p.className = "mc-wizard-lead";
    p.textContent =
      "Skills are ready-made workflows for Claude Code — they live inside your vault (.claude/). Recommended ones are pre-selected; you can add more anytime.";
    wrap.appendChild(p);

    const listEl = document.createElement("div");
    listEl.className = "mc-wizard-skills";
    listEl.innerHTML = `<div class="mc-wizard-doctor-running">Loading skill library…</div>`;
    wrap.appendChild(listEl);

    const statusEl = document.createElement("div");
    statusEl.className = "mc-wizard-skill-status";
    wrap.appendChild(statusEl);

    const renderFooter = (installing: boolean) => {
      this.footerEl.innerHTML = "";
      const back = document.createElement("button");
      back.className = "mc-wizard-btn is-secondary";
      back.textContent = "Back";
      back.disabled = installing;
      back.addEventListener("click", () => this.goBack());
      this.footerEl.appendChild(back);

      const spacer = document.createElement("div");
      spacer.className = "mc-wizard-footer-spacer";
      this.footerEl.appendChild(spacer);

      const skip = document.createElement("button");
      skip.className = "mc-wizard-btn is-secondary";
      skip.textContent = "Skip";
      skip.disabled = installing;
      skip.addEventListener("click", () => this.goNext());
      this.footerEl.appendChild(skip);

      const install = document.createElement("button");
      install.className = "mc-wizard-btn is-primary";
      install.textContent = installing ? "Installing…" : `Install selected (${this.selectedSkills.size})`;
      install.disabled = installing || this.selectedSkills.size === 0 || !this.registry;
      install.addEventListener("click", async () => {
        if (!this.vaultPath) return;
        renderFooter(true);
        const mcSkills = (window as any).mcSkills;
        mcSkills.onInstallProgress((done: number, total: number) => {
          statusEl.textContent = `Installing ${done}/${total}…`;
        });
        const count = await mcSkills.install(this.vaultPath, [...this.selectedSkills]);
        this.installedCount = count;
        statusEl.textContent = "";
        this.goNext();
      });
      this.footerEl.appendChild(install);
    };
    renderFooter(false);

    void (async () => {
      const mcSkills = (window as any).mcSkills;
      this.registry = (await mcSkills.getRegistry(this.vaultPath)) as RegistryData | null;
      listEl.innerHTML = "";

      if (!this.registry) {
        listEl.innerHTML = `<div class="mc-wizard-error">Could not load the skill library. Check your internet connection — you can install skills later from the panel.</div>`;
        renderFooter(false);
        return;
      }

      // Drop entries already selected but absent from the registry
      for (const id of [...this.selectedSkills]) {
        if (!this.registry.skills.some((s) => s.id === id)) this.selectedSkills.delete(id);
      }

      const byCategory = new Map<string, RegistrySkill[]>();
      for (const skill of this.registry.skills) {
        const cat = skill.category && CATEGORY_META[skill.category] ? skill.category : "other";
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat)!.push(skill);
      }

      for (const [cat, skills] of byCategory) {
        const meta = CATEGORY_META[cat] ?? CATEGORY_META.other;
        const catHeader = document.createElement("div");
        catHeader.className = "mc-wizard-section-label";
        catHeader.textContent = `${meta.icon} ${meta.label.toUpperCase()}`;
        listEl.appendChild(catHeader);

        for (const skill of skills) {
          const row = document.createElement("label");
          row.className = "mc-wizard-skill-row";

          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = this.selectedSkills.has(skill.id);
          cb.addEventListener("change", () => {
            if (cb.checked) this.selectedSkills.add(skill.id);
            else this.selectedSkills.delete(skill.id);
            renderFooter(false);
          });
          row.appendChild(cb);

          const text = document.createElement("div");
          text.className = "mc-wizard-skill-text";
          const name = document.createElement("strong");
          name.textContent = skill.label;
          text.appendChild(name);
          const desc = document.createElement("span");
          desc.textContent = skill.description.split(".")[0];
          text.appendChild(desc);
          const reqs = (skill.requires ?? []).filter((r) => !this.registry!.skills.some((s) => s.id === r));
          if (reqs.length > 0) {
            const req = document.createElement("em");
            req.className = "mc-wizard-skill-req";
            req.textContent = `requires: ${reqs.join(", ")}`;
            text.appendChild(req);
          }
          row.appendChild(text);
          listEl.appendChild(row);
        }
      }
      renderFooter(false);
    })();
  }

  // ─────────────────────────── finish ───────────────────────────

  private renderFinish() {
    const wrap = this.bodyEl;
    const h = document.createElement("h3");
    h.textContent = "You're set";
    wrap.appendChild(h);

    const summary = document.createElement("ul");
    summary.className = "mc-wizard-summary";
    const lines: string[] = [];
    if (this.vaultPath) lines.push(`Vault: ${this.vaultPath}`);
    if (this.mode === "create") lines.push(this.gitInitialized ? "Git repository initialized with the first commit" : "Git skipped (not available)");
    lines.push(this.installedCount > 0 ? `${this.installedCount} skills installed into .claude/` : "No skills installed — add them later from the panel");
    if (this.mode === "create") lines.push("Sample transcript is waiting in _transcripts-backlog/ for your first ingest");
    for (const line of lines) {
      const li = document.createElement("li");
      li.textContent = line;
      summary.appendChild(li);
    }
    wrap.appendChild(summary);

    const agentWrap = document.createElement("label");
    agentWrap.className = "mc-wizard-agent-optin";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    agentWrap.appendChild(cb);
    const text = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = "Launch the Start Here agent";
    text.appendChild(strong);
    const span = document.createElement("span");
    span.textContent =
      this.mode === "create"
        ? " — a Claude Code session opens, explains the methodology on your actual vault, personalizes your project pages, and walks you through the first ingest."
        : " — a Claude Code session opens, scans your existing notes, diagnoses what's missing, and weaves the methodology into what you already have.";
    text.appendChild(span);
    agentWrap.appendChild(text);
    wrap.appendChild(agentWrap);

    const note = document.createElement("p");
    note.className = "mc-wizard-note";
    note.textContent =
      "Note: Claude asks for permission before file edits by default. The Auto toggle in the panel footer skips permission prompts (--dangerously-skip-permissions) — leave it off until you trust the flow.";
    wrap.appendChild(note);

    this.footerEl.innerHTML = "";
    const spacer = document.createElement("div");
    spacer.className = "mc-wizard-footer-spacer";
    this.footerEl.appendChild(spacer);
    const finishBtn = document.createElement("button");
    finishBtn.className = "mc-wizard-btn is-primary";
    finishBtn.textContent = "Open my vault →";
    finishBtn.disabled = !this.vaultPath;
    finishBtn.addEventListener("click", async () => {
      const mcOnboarding = (window as any).mcOnboarding;
      await mcOnboarding.complete();
      const result: WizardResult = {
        vaultPath: this.vaultPath!,
        mission: this.mode === "create" ? "scaffolded" : "scan",
        launchStartHere: cb.checked,
      };
      this.destroy();
      this.opts.onFinished(result);
    });
    this.footerEl.appendChild(finishBtn);
  }
}
