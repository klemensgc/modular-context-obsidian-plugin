# Modular Context na macOS + iOS + App Store — plan implementacji

> Status: draft 2026-06-13 · właściciel: Klemens · fakty brzegowe zweryfikowane web-researchem (źródła inline)

## 0. Zweryfikowane fakty brzegowe (determinują architekturę)

| # | Fakt | Pewność | Konsekwencja |
|---|------|---------|--------------|
| 1 | **Mac App Store + lokalny PTY = ślepa uliczka.** App Sandbox dziedziczy się kernelowo na child-processes; dynamiczne granty (Powerbox) NIE przechodzą na dzieci. `claude` CLI w odziedziczonym sandboxie nie widzi `~/.claude`, `~/.npm-global`, projektów — jest funkcjonalnie martwe. Quinn/Apple DTS wprost: niesandboxowany helper w MAS-apce = odrzucenie. iTerm2/Warp/Ghostty — wszystkie poza MAS. | high | Pełna apka macOS = **Developer ID + notaryzacja poza MAS** (jak cała kategoria terminali) |
| 2 | **Claude Code lokalnie na iPhonie = niemożliwe** (2.5.2: zakaz pobierania/wykonywania kodu; brak fork/exec; brak JIT — DMA/UE tego nie zmieniło, JIT-entitlement tylko dla silników przeglądarek). Anthropic rozwiązał to sam: cloud sandbox (10.2025) i **Remote Control (02.2026)** — telefon jako okno do sesji Claude Code na komputerze użytkownika (QR pairing). | high | iOS = **klient zdalnego runtime'u**. Model "Twój Mac jako host" ma świeży precedens od samego Anthropica |
| 3 | **Capacitor/WKWebView na iOS = udeptana ścieżka.** Obsidian mobile TO Capacitor + CodeMirror 6 w WKWebView (App Store od 07.2021); Logseq podobnie; Code App = Monaco + terminal w webview. Guideline 4.2 odrzuca "przepakowane strony", nie web-tech — wymaga bundlowanych assetów + natywnej wartości (Files, share sheet, push, offline). | high | **Reuse naszego renderera TS/DOM** (CmEditor, GraphView, reading view, wizard) w Capacitor — niskie ryzyko review |
| 4 | **ToS Anthropica dla gateway/proxy z marżą + multi-user użycie subskrypcji** — NIEZWERYFIKOWANE (research padł na timeout). Wiedza ogólna (moderate): API w produkcie komercyjnym OK; konsumencka subskrypcja Claude jest single-user — używanie OAuth usera na wielodostępnym serwerze to szara strefa. | **do weryfikacji** | Przed budową cloud-runtime: przeczytać Commercial Terms + Claude Code terms, ew. kontakt z Anthropic sales |

Źródła kluczowe: developer.apple.com/forums/thread/685544 i /123873 (sandbox inheritance), App Review Guidelines 2.4.5/2.5.2/4.2/4.2.7/4.7, ish.app/blog/ish-jit-and-eu, helpnetsecurity.com (Remote Control 25.02.2026), forum.obsidian.md/t/40125 (Obsidian=Capacitor), apps.apple.com id1512938504 (Code App).

---

## 1. Architektura docelowa: jeden rdzeń, trzy hosty

```
┌────────────────────────────────────────────────────────────┐
│                      packages/core (TS/DOM)                │
│  CmEditor (read+edit) · GraphView · OnboardingWizard ·     │
│  TerminalManager UI · skills/registry · prompts · Loader   │
│  — czysty DOM, zero Node — (zweryfikowane: ten sam stack   │
│     co Obsidian mobile)                                    │
└──────────┬──────────────────┬──────────────────┬───────────┘
           │ HostAPI          │ HostAPI          │ HostAPI
┌──────────▼─────────┐ ┌──────▼─────────┐ ┌──────▼──────────┐
│  macOS / Electron  │ │  iOS Capacitor │ │ (opc.) MAS-lite │
│  PTY LOKALNY       │ │  vault: Files/ │ │  bez lokalnego  │
│  Developer ID +    │ │  iCloud; term: │ │  PTY; terminale │
│  notarization,     │ │  REMOTE (WS +  │ │  tylko remote   │
│  poza MAS          │ │  xterm.js)     │ │                 │
└──────────┬─────────┘ └──────┬─────────┘ └──────┬──────────┘
           │                  │                  │
           │   ┌──────────────▼──────────────────▼──────┐
           └──▶│         REMOTE RUNTIME (2 warianty)    │
               │ A) "Your Mac as host": daemon w apce   │
               │    macOS + relay + QR pairing          │
               │    (model = Anthropic Remote Control)  │
               │ B) Cloud: kontener per user + LiteLLM  │
               │    gateway (= monetyzacja, prowizja)   │
               └─────────────────────────────────────────┘
```

**HostAPI** = formalizacja dzisiejszych `window.mc*` (mcVault, mcPty, mcSkills, mcOnboarding, mcGit, mcConnections) jako interfejs z trzema implementacjami: `ElectronHost` (IPC→main, dziś), `CapacitorHost` (Filesystem plugin + WS), `RemoteHost` (wszystko po WS).

## 2. Sync vaulta między urządzeniami

| Opcja | Plusy | Minusy | Werdykt |
|-------|-------|--------|---------|
| **iCloud Drive folder** (vault w `~/Library/Mobile Documents/`) | zero backendu, natywny Files provider na iOS, model Obsidian | konflikty przy równoległej edycji, brak historii | **Faza 3 (start)** |
| **Git sync** (już jest w metodologii!) | historia=changelog, konflikt-resolution, działa z GitHub remote z panelu Connections | iOS potrzebuje gita: isomorphic-git (JS, działa w WKWebView) albo native plugin (precedens: logseq/capacitor-file-sync) | **Faza 4** |
| CloudKit własny | pełna kontrola | dużo pracy, lock-in | nie |

## 3. Fazy wdrożenia

### Faza 1 — macOS "dorosła dystrybucja" (1–2 tyg, prereq: Apple Developer Program $99/rok)
- Developer ID certificate + `electron-builder` notarization w CI (GitHub Actions, `notarytool`)
- `electron-updater` z GitHub Releases (auto-update — poza MAS wolno)
- Crash reporting (Sentry electron)
- Landing z downloadem + stronka "first 60 seconds"
- **Deliverable:** publiczny, podpisany DMG — podwójny klik działa, koniec right-click→Open

### Faza 2 — ekstrakcja `packages/core` (2–4 tyg, równolegle z F1)
- Renderer components → `packages/core` (są już czystym DOM-em; @mc/shared zostaje jak jest)
- `HostAPI` interface + `ElectronHost` (refaktor obecnych `window.mc*` — mechaniczny)
- Build core jako lib konsumowana przez Electron i Capacitor
- **Test wyjścia:** apka Electron działa identycznie na nowym core

### Faza 3 — iOS MVP na Capacitor (4–8 tyg)
Zakres (wszystko OFFLINE = natywna wartość pod 4.2):
- Vault z Files/iCloud (Capacitor Filesystem + security-scoped bookmarks)
- Drzewo + **reading view** (mamy!) + edycja CM6 (Obsidian-proven na mobile) + **graf** (canvas działa w WKWebView)
- **Capture do `_transcripts-backlog/`**: share sheet (tekst/URL/audio), szybka notatka, dyktowanie — *killer feature*: telefon = inbox metodologii, ingest robi się na Macu
- Onboarding wizard (reuse) w wariancie mobile
- Natywna warstwa: splash/ikona, haptics, keyboard accessory bar, safe-areas, local notifications
- TestFlight → App Store (checklist §5)
- **Świadomie poza MVP iOS:** terminale (czekają na Fazę 4), skills install (skille i tak wykonuje runtime)

### Faza 4 — Remote sessions (3–6 tyg, można równolegle z F3)
Wariant **A: "Your Mac as host"** (start, zero kosztów infra):
- Daemon w apce macOS: wystawia sesje PTY przez relay (WebSocket, E2E token z QR-pairingu jak Remote Control Anthropica)
- iOS: xterm.js po WS (precedens Code App), karty Working/To Review przez ten sam kanał, push "agent finished" (APNs przez lekki relay)
- Relay = jedyny element serwerowy (cienki, stateless, tani)

Wariant **B: Cloud runtime** (= plan monetyzacji z prowizją):
- Kontener per user (Firecracker/Fly machines) z claude CLI + vault git-clone
- **LiteLLM gateway z per-user keys** — ANTHROPIC_BASE_URL wstrzykiwany w sesje; metering + Stripe top-ups; marża 10–20%
- ⚠️ Bramka: weryfikacja ToS Anthropica (fakt #4) PRZED budową
- To także odblokowuje MAS-lite (F5) i "Managed Claude" tier (zero instalacji CLI)

### Faza 5 — MAS-lite macOS (opcjonalna)
Tylko jeśli kanał MAS okaże się istotny marketingowo: build Capacitor/sandboxed bez lokalnego PTY, terminale wyłącznie przez runtime z F4. Nie wcześniej niż po walidacji F4.

## 4. Reuse map

| Komponent | Electron | iOS Capacitor | Uwagi |
|-----------|----------|---------------|-------|
| CmEditor (read+edit, properties, wiki-links) | ✅ dziś | ✅ reuse | Obsidian robi dokładnie to |
| GraphView (canvas, force sim) | ✅ | ✅ reuse | touch: pinch-zoom do dodania |
| Reading view CSS / paleta | ✅ | ✅ | |
| OnboardingWizard + prompty (@mc/shared) | ✅ | ✅ reuse (bez doctor/PTY kroków) | |
| TerminalManager UI + xterm.js | ✅ lokalny PTY | ✅ po WebSocket | sloty/glify/tracker bez zmian |
| AgentTracker, BookmarkManager, glify | ✅ | ✅ | już w @mc/shared |
| SkillRegistry | ✅ | runtime-side | instalacja w vault na hoście runtime'u |
| main-process (PTY, fs, doctor, scaffold, git) | ✅ | ❌ → CapacitorHost/RemoteHost | jedyna realna praca portowa |

## 5. App Store compliance checklist (iOS)

- [ ] **4.2 native value:** offline vault + share sheet + notifications + haptics + natywna nawigacja (NIE remote URL — assets w bundle)
- [ ] **2.5.2:** kod wykonywany wyłącznie server-side (terminal po WS = legalny); JS UI bundlowany
- [ ] **4.2.7 (remote clients):** host = urządzenie/konto użytkownika; nie mirrorujemy sklepu
- [ ] **Demo dla reviewera:** konto testowe z działającym hosted runtime / nagrany przepływ — apka nie może wyglądać na pustą skorupę
- [ ] **Privacy nutrition labels** + privacy policy (vault = dane użytkownika, lokalne/iCloud)
- [ ] **Export compliance:** standardowe szyfrowanie (HTTPS/WSS) → `ITSAppUsesNonExemptEncryption=false`
- [ ] **IAP:** jeśli sprzedajemy tokeny/subskrypcję w apce iOS → Apple IAP (30/15%) albo (USA, po Epic) external purchase link; web-billing poza apką legalny, ale bez "steeringu" w UI poza dozwolonym zakresem
- [ ] Nazwa/trademark: "Modular Context — by receptionOS"

## 6. Decyzje i koszty

| Decyzja | Opcje | Rekomendacja |
|---------|-------|--------------|
| Apple Developer Program | $99/rok, wymagany wszędzie (notaryzacja też!) | kupić teraz (odblokowuje F1) |
| Runtime dla iOS | A: Mac-as-host / B: cloud | **A na start** (zero infra, precedens Anthropica), B gdy monetyzacja |
| Stack iOS | Capacitor (reuse) / SwiftUI native | **Capacitor** — F3 w tygodnie zamiast kwartałów; SwiftUI tylko jeśli WKWebView-ergonomia okaże się barierą |
| Sync | iCloud → git | start iCloud, git w F4 |
| ToS Anthropic (fakt #4) | — | **zadanie blokujące wariant B**: przeczytać Commercial Terms / spytać Anthropic |

## 7. Ryzyka

1. **Klawiatura/scroll w WKWebView** — największy znany ból Capacitora (inżynieria, nie polityka); Obsidian to przeszedł, ich workaroundy są publiczne na forum
2. **Review 4.2 przy terminal-first appce** — mitygacja: iOS MVP najpierw jako vault+capture (samodzielna wartość), terminale dochodzą później jako feature
3. **ToS Anthropica dla wariantu B** — niezweryfikowane; wariant A wolny od ryzyka (klucz/subskrypcja zostaje u usera, na jego sprzęcie)
4. **Konflikty iCloud sync** — mitygacja: konwencja "ingest tylko na jednym hoście" + git w F4
5. **Apple zmienia zasady** — fakty #1–#3 stabilne od lat (sandbox od 2012, 2.5.2 od zawsze); Remote Control Anthropica zmniejsza ryzyko precedensu
