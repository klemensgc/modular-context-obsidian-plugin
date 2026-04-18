---
title: ADR-001 — OAuth Strategy
updated: 2026-04-17
status: accepted
---
# ADR-001: OAuth Strategy — Hybrid (Shared Testing + Per-user Bring-Your-Own)

## Context

Integracja Google Workspace wymaga OAuth 2.0 flow. Scope'y które potrzebujemy (`gmail.readonly`, `gmail.send`, `calendar.events`) są wszystkie **restricted scopes** Google — wymagają CASA assessment (3rd party audit, $15k-$75k/rok, 6-8 tygodni) dla **publicznej** publikacji OAuth clienta.

Trade-off: UX (zero-friction "Connect" button) vs koszt/time ($15k+ audit, miesiące delay) vs scale (Testing mode limit 100 users).

## Decision

**Hybrid strategia** — dwa tory współistnieją w UI onboardingu, user wybiera:

1. **"Quick Connect" (Beta, hosted):** nasz shared OAuth client w **Testing mode** — limit 100 autoryzowanych users. Zero setup dla usera. Default dla early adopters, fundraise demo, private beta.

2. **"Bring Your Own Client" (Advanced):** user tworzy własny OAuth client w swoim Google Cloud Console — brak limitu users, brak CASA dependency. Step-by-step wizard w onboardingu (screenshots, link do GCP console). Default dla scale + privacy-maxxers.

W UI: default **Quick Connect** (checkbox "use hosted beta client"); **Bring Your Own** expandable section "I want full control →".

## Alternatives considered

| Option | Pros | Cons | Reason rejected |
|--------|------|------|-----------------|
| **A. Shared client (published, CASA verified)** | Zero friction, unlimited users | $15-75k/rok, 6-8 tyg audit, blokuje launch do Q3+ | Ekonomia + timeline |
| **B. Shared client (Testing mode ONLY)** | Free, immediate, zero friction | 100 users hard cap blokuje scale | Non-starter post-beta |
| **C. Per-user client (BYO ONLY)** | Zero cost, unlimited, privacy-aligned | Friction ~15min GCP setup — odcina mainstream | Rezygnacja z OSS adoption |
| **D. Shared client (Testing) + Per-user (optional)** | Zero cost, no user limit w BYO mode, beta UX intact | Dual-path complexity w code | **ACCEPTED** — best of both |
| **E. Third-party OAuth broker (Pipedream, Nango)** | Offload OAuth | Middleware — sprzeczne z "local-only" narrative | Zasadnicze: pitch story |

## Consequences

### Positive
- **Immediate launch** possible — Quick Connect działa today, no external dependencies
- **Privacy narrative intact** — "Your tokens never leave your machine" pozostaje prawdą (tokens trzymane lokalnie in both tracks; client credentials w Quick Connect są OUR concern, nie user's)
- **Scale path ready** — post-100 users, BYO jest już w UI (kwestia marketingu, nie engineeringu)
- **Optionality** — w razie CASA ever się opłaci, Quick Connect może upgrade z Testing → Published bez zmian user-facing
- **Differentiator** — "You can bring your own OAuth client" to rare feature vs cloud SaaS

### Negative
- **Dual-path maintenance** — 2 onboarding flows w UI, więcej test cases
- **Client secret shipping** — Quick Connect wymaga że client_secret jest w kodzie pluginu (OAuth 2.0 installed apps tak działa — desktop apps nie mają prawdziwego "secret", ale dobra praktyka: obfuskacja, rotation plan)
- **Sensitive support burden** — jeśli 100-user cap się zepełni, zanim BYO instrukcja dotrze, user experience = "connect failed with cryptic message"
- **Brand risk** — jeśli Google revoke nasz test client z powodu policy violation (e.g. 3rd party bot abuses it), wszyscy users odcinani naraz

### Mitigations
- **Usage dashboard:** monitor Testing mode user count (GCP console). At 80/100 → automated Warning Banner w pluginie: "Beta slots almost full. Consider switching to Bring Your Own."
- **BYO wizard quality:** minimum 5 screenshots, copy-paste commands, video recording — obniż friction z 15min → 5min
- **Invite gating:** Quick Connect gated behind `request beta access` form (email capture). Funnel users do waitlist jeśli limit hit → email z BYO instructions.
- **Client secret rotation:** raz na kwartał rotate secret (requires plugin update). Breaking change acceptable w beta.
- **Monitoring:** GCP API usage dashboard + alert na anomaly (potential abuse).
- **Fallback plan:** jeśli Quick Connect się złamie (Google revokes, abuse, quota), UI wymusza BYO — nikt nie jest zablokowany beyond onboarding step.

## Implementation notes for W1

- **OAuth client creation:** `klemens@receptionos.com` GCP account, dedicated project `modular-context-oauth`, OAuth Consent screen in Testing mode, add up to 100 test user emails as they register
- **Scopes:** `gmail.readonly`, `gmail.send`, `calendar.events` (wszystkie restricted — confirmed w Testing mode też działają)
- **Client ID type:** Desktop app
- **Redirect URI:** `http://127.0.0.1` (bez portu — ephemeral)
- **Client secret handling:**
  - Embed w plugin build (obfuscation OK dla desktop apps per RFC 8252)
  - Gitignore source config, inject at build time via CI secret
  - W1 MVP: może być plaintext w source dla fazy prototyp (rotate przed public release)
- **UI:**
  - Primary button: "Connect Google Workspace" → defaults to Quick Connect
  - Under primary: small link "Advanced: use your own OAuth client →" → expands BYO panel
  - BYO panel: paste client ID + secret fields, validate on save

## References

- [[../research/01-oauth-desktop-flow]] — restricted scopes, CASA costs, Testing mode limits
- [[../research/04-existing-solutions]] — YukiGasai stale, reason + OAuth UX "tedious"
- [[ADR-002-token-storage]] — token storage contract (independent of OAuth flow choice)
- [[ADR-004-skill-registry-integration]] — how google-workspace skill triggers onboarding
- RFC 8252 — OAuth 2.0 for Native Apps (section 8.6: client_secret handling)

## Open questions for user

- Czy klient poprawny dla beta: nowy GCP project `modular-context-oauth` czy podpiąć pod istniejący `klemens@receptionos.com` default project?
- Brand: Quick Connect nazwa OK, czy wolisz "Hosted Beta" / "Easy Connect" / etc.?
- Timeline: CASA submission — plan przy fundraise Q3 czy później?
