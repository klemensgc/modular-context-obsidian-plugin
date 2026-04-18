/** AgentCardsPanel — Working + To Review cards in the left sidebar.
 *
 *  Mirrors plugin's working/review sections. Click a card → switchTo(session).
 *  Click a to-review card → dismiss + switchTo. */

import { SESSION_GLYPHS } from "@mc/shared";
import type { TerminalManager } from "./TerminalManager";

export class AgentCardsPanel {
  private container: HTMLElement;
  private manager: TerminalManager;

  constructor(container: HTMLElement, manager: TerminalManager) {
    this.container = container;
    this.container.classList.add("mc-app-agent-cards");
    this.manager = manager;

    // Listen for tracker changes
    this.manager.onAgentsChanged = () => this.render();
    this.render();
  }

  render() {
    const working = this.manager.agentTracker.getWorking();
    const review = this.manager.agentTracker.getToReview();

    if (working.length === 0 && review.length === 0) {
      this.container.innerHTML = "";
      return;
    }

    this.container.innerHTML = "";

    if (working.length > 0) {
      const section = document.createElement("div");
      section.className = "mc-app-agent-section";

      const title = document.createElement("div");
      title.className = "mc-app-agent-title";
      title.textContent = `Working · ${working.length}`;
      section.appendChild(title);

      for (const tracked of working) {
        const session = this.manager.sessions.find((s) => s.id === tracked.sessionId);
        if (!session) continue;
        const card = this.buildCard(session.id, session.name, session.glyph, "working", tracked.stateChangedAt);
        section.appendChild(card);
      }
      this.container.appendChild(section);
    }

    if (review.length > 0) {
      const section = document.createElement("div");
      section.className = "mc-app-agent-section";

      const title = document.createElement("div");
      title.className = "mc-app-agent-title";
      title.textContent = `To Review · ${review.length}`;
      section.appendChild(title);

      for (const tracked of review) {
        const session = this.manager.sessions.find((s) => s.id === tracked.sessionId);
        if (!session) continue;
        const card = this.buildCard(session.id, session.name, session.glyph, "review", tracked.stateChangedAt);
        card.addEventListener("click", () => {
          this.manager.agentTracker.dismiss(session.id);
          this.manager.switchTo(session);
        });
        section.appendChild(card);
      }
      this.container.appendChild(section);
    }
  }

  private buildCard(
    id: number,
    name: string,
    glyphId: string,
    status: "working" | "review",
    stateChangedAt: number,
  ): HTMLElement {
    const card = document.createElement("div");
    card.className = `mc-app-agent-card is-${status}`;
    card.dataset.sessionId = String(id);

    const glyphEl = document.createElement("span");
    glyphEl.className = "mc-app-agent-glyph";
    glyphEl.innerHTML = SESSION_GLYPHS.find((g) => g.id === glyphId)?.svg ?? SESSION_GLYPHS[0].svg;
    card.appendChild(glyphEl);

    const info = document.createElement("div");
    info.className = "mc-app-agent-info";

    const nameEl = document.createElement("div");
    nameEl.className = "mc-app-agent-name";
    nameEl.textContent = name;
    info.appendChild(nameEl);

    const elapsed = document.createElement("div");
    elapsed.className = "mc-app-agent-elapsed";
    elapsed.textContent = formatElapsed(Date.now() - stateChangedAt);
    info.appendChild(elapsed);

    card.appendChild(info);

    // Click card → switch to session
    if (status === "working") {
      card.addEventListener("click", () => {
        const session = this.manager.sessions.find((s) => s.id === id);
        if (session) this.manager.switchTo(session);
      });
    }

    return card;
  }

  destroy() {
    this.container.innerHTML = "";
    this.container.classList.remove("mc-app-agent-cards");
  }
}

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60}m`;
}
