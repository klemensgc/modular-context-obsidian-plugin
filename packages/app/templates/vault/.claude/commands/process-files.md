---
description: Przetwarza DOWOLNE pliki nie-transkrypcyjne z backlogu (PDF, .docx, obrazy/screenshoty, artykuły, CSV/JSON, kod, notatki) — ekstrahuje wiedzę, wplata ją w moduły wiki, reweave sąsiadów, reflect connections, wykrywa konflikty, surfacuje insighty. Pełna autonomia — pyta dopiero w Fazie 5.4 (opcjonalnie, zbiorczo).
argument-hint: [--dry-run] [--skip-pull]
---

# Przetwarzanie plików z backlogu

Jesteś orkiestratorem autonomicznego pipeline'u przetwarzania **plików nie-transkrypcyjnych** w Obsidian vault.
Repo jest po polsku. Odpowiadaj po polsku.

> **Rodzeństwo:** `/process-transcripts` zajmuje się transkrypcjami (rozmowy/spotkania). Ten skill zajmuje się **całą resztą** — PDF-ami, dokumentami, obrazami, danymi, artykułami, notatkami i kodem, które wpadły do `_transcripts-backlog/`. Heurystyka rozdziału jest w **Fazie 0.2**.

**Reguła nadrzędna: NIE PRZERYWAJ MININGU.** Działaj end-to-end autonomicznie. Wszystkie wątpliwości zapisuj do bufora `open_questions[]` i prezentuj zbiorczo na końcu w **Fazie 5.4** (opcjonalnie).

**Jedyny hard block:** git conflict w Fazie 0 (nie da się kontynuować bez resolve).

**Default behaviors w trybie autonomicznym:**
- **Ambiguous routing** (plik pasuje do 2+ modułów) → wybierz najbardziej prawdopodobny (highest confidence), zaloguj alternatywę do `open_questions["ambiguous_routing"]`
- **Plik binarny / nieczytelny** (PDF/docx, którego nie da się przeczytać) → spróbuj konwersji przez Bash (`pdftotext`, `textutil`), a jeśli się nie uda → zaloguj do `open_questions["unreadable_file"]` z notatką o wymaganej konwersji, NIE przerywaj
- **Sprzeczność danych** (consistency-checker: X w module vs Y w pliku) → newest wins (plik), zachowaj starą wersję jako `<!-- PRE-MINING (data): X -->` HTML comment w module, zaloguj do `open_questions["data_conflict"]`
- **Brakujący moduł docelowy** → stwórz szkic (`type: modul` + `status: draft` + TL;DR z pliku), zaloguj do `open_questions["new_module_draft"]` z pytaniem "rozbudować do pełnego modułu?"
- **Sensitive content** (tensje w zespole, finanse, equity, PII) → mininguj normalnie, dodaj sentinel `🔒 SENSITIVE` przy module w session log + zaloguj do `open_questions["sensitive_review"]`
- **Nowy tag nieistniejący w taksonomii** → użyj z prefixem `proposed:`, zaloguj do `open_questions["taxonomy_update"]`
- **Reweave Action = CHALLENGE** → NIE wykonuj destruktywnej zmiany, zaloguj jako blocker do `open_questions["reweave_challenge"]`
- **Reweave Action = SPLIT** → zaloguj jako recommendation do `open_questions["split_candidates"]`, nie wykonuj

**Bufor `open_questions[]`** — utrzymuj przez całą sesję, struktura:
```
[
  { phase: "1.3", type: "ambiguous_routing", item: "...", chosen: "...", alternative: "...", reason: "..." },
  { phase: "1.2", type: "unreadable_file",   item: "...", note: "wymaga pdftotext / textutil" },
  { phase: "2.3", type: "data_conflict",     module: "...", old: "...", new: "...", chosen: "newest" },
  ...
]
```

---

## FAZA 0: Setup

### 0.1 Git pull (chyba że user podał --skip-pull)

Użyj Bash tool (NIE blok kodu z wykrzyknikiem) do wykonania pull:

```bash
git pull origin master --no-rebase 2>&1 || true
```

**Obsługa wyniku:**
- Jeśli pull SUCCEEDS → kontynuuj
- Jeśli pull FAILS z "CONFLICT" → uruchom auto-resolve:
  1. Sprawdź `git status` — zidentyfikuj conflicted pliki
  2. Dla "file location" conflicts (backlog → _transcripts/files): accept theirs (`git checkout --theirs <path> && git add <path>`)
  3. Dla content conflicts: pokaż userowi, czekaj na decyzję
  4. Po resolve: `git commit -m "Fix: resolve merge conflicts from pull"`
- Jeśli pull FAILS z credential/network error → kontynuuj z ostrzeżeniem: "⚠ Pull failed (network/auth), working with local state."
- Jeśli pull FAILS z innego powodu → pokaż error, kontynuuj z ostrzeżeniem

### 0.2 Inwentaryzacja backlogu + rozdział transkrypt vs plik

Przeczytaj zawartość `_transcripts-backlog/` używając Glob (`_transcripts-backlog/**/*`).

**Heurystyka klasyfikacji (kluczowa — decyduje co BIERZESZ):**

Plik jest **TRANSKRYPTEM** (NIE bierzesz go — należy do `/process-transcripts`) gdy:
- rozszerzenie to `.md` / `.txt` / `.vtt` / `.srt`, **ORAZ**
- treść czyta się jak rozmowa / spotkanie: linie ze speakerami w bold (`**Imię** (0:00):`), timestampy `(m:ss)` lub `[0.01s]`, nagłówki typu `Attendees:` / `Duration:`, lub plik kończy się na `-summary.md` sparowany z transkryptem.

Plik jest **PLIKIEM dla tego skilla** (BIERZESZ go) gdy to wszystko inne:
- `.pdf`, `.docx`, `.docx.pdf`, `.pptx`, `.xlsx`
- obrazy: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.heic` (screenshoty, zdjęcia tablic, fotki dokumentów)
- dane: `.csv`, `.json`, `.tsv`, `.yaml`/`.yml`, `.xml`
- kod: `.py`, `.ts`, `.js`, `.sql`, `.sh`, itp.
- artykuły / notatki: `.md` / `.txt`, które NIE czytają się jak rozmowa (np. wklejony artykuł, research note, draft, lista bullet-pointów)

> **Rozstrzyganie `.md`/`.txt`:** zajrzyj do pierwszych ~30 linii. Jeśli widzisz pattern speakerów + timestampów → transkrypt (pomiń). Jeśli to prose / nagłówki / lista bez dialogu → plik (bierz). W razie wątpliwości zaloguj do `open_questions["classification"]` i **pomiń** (lepiej zostawić transkryptowi niż zmielić go źle).

Wyświetl krótki raport:
```
Backlog: X pozycji łącznie
  → transkrypty (pomijam, dla /process-transcripts): A
  → pliki (przetwarzam): B  [typy: N PDF, M obrazów, K danych, ...]
```

- Jeśli **0 plików** (są tylko transkrypty albo backlog pusty) → powiedz "Brak plików nie-transkrypcyjnych do przetworzenia. Uruchom /process-transcripts dla transkryptów." i zakończ.

Kontynuuj automatycznie (nie pytaj).

---

## FAZA 1: Ingestion plików (per typ)

### 1.1 Przeczytaj referencje

Przeczytaj te pliki PRZED ingestion (jeśli istnieją w vault):
- `_claude/7-skill-references/tagging-taxonomy.md`
- `_claude/7-skill-references/category-routing.md`

> **Uwaga:** `transcript-analyzer` jest agentem TRANSKRYPT-specyficznym (oczekuje formatu rozmowy) — **nie spawnuj go dla plików.** Ekstrakcję wiedzy z plików rób **inline w main session** (poniżej). Jeśli w przyszłości powstanie dedykowany agent `file-analyzer`, można tu podpiąć Task — ale NIE wymyślaj nieistniejącego agenta i go nie spawnuj.

### 1.2 Ekstrakcja per typ pliku

Dla KAŻDEGO pliku przeprowadź ingestion dopasowany do typu. Cel: z każdego pliku wyciągnij **ustrukturyzowany destylat** (patrz 1.3).

**Obrazy / screenshoty** (`.png`, `.jpg`, ...):
- Użyj **Read tool** na ścieżce obrazu — Claude widzi obrazy natywnie.
- Opisz co przedstawia: screenshot UI? wykres/dashboard? zdjęcie tablicy/whiteboard? skan dokumentu? zrzut czatu?
- Wyciągnij wiedzę: liczby, nazwy, decyzje, diagramy, tekst na obrazie. Jeśli to dashboard z metrykami → wypisz metryki. Jeśli whiteboard → przepisz strukturę.

**PDF / .docx.pdf / dokumenty:**
- Spróbuj **Read tool** (Read radzi sobie z PDF przez parametr `pages`; dla wielostronicowych podawaj zakresy).
- Jeśli Read zwraca binary/śmieci lub błąd → spróbuj konwersji przez Bash tool:
  ```bash
  # PDF → tekst (jeśli pdftotext dostępny)
  command -v pdftotext >/dev/null && pdftotext -layout "_transcripts-backlog/plik.pdf" "/tmp/plik.txt" 2>&1 || echo "pdftotext NIEDOSTĘPNY"
  # .docx → tekst (macOS textutil)
  command -v textutil >/dev/null && textutil -convert txt -stdout "_transcripts-backlog/plik.docx" 2>&1 || echo "textutil NIEDOSTĘPNY"
  ```
  Następnie Read na wyniku konwersji.
- Jeśli i to zawiedzie → zaloguj do `open_questions["unreadable_file"]` (note: "wymaga ręcznej konwersji — brak pdftotext/textutil") i przejdź dalej. NIE przerywaj.

**Dane** (`.csv`, `.json`, `.tsv`, `.yaml`, `.xml`):
- Read tool na pliku (dla dużych → `head`/`limit` na próbkę + policz wiersze przez `wc -l`).
- Podsumuj **strukturę** (kolumny / klucze / schema) + **kluczowe fakty** (liczność, zakresy, top wartości, anomalie). NIE wklejaj surowych danych do modułów — destyluj.
- Jeśli plik zawiera PII (emaile, telefony, nazwiska klientów) → flaguj sensitive (patrz default behaviors).

**Kod** (`.py`, `.ts`, `.sql`, ...):
- Read tool. Podsumuj: co robi, jakie zależności/integracje, jakie decyzje architektoniczne ujawnia. Wyciągnij wiedzę o systemie, nie linijki kodu.

**Artykuły / notatki** (`.md`/`.txt` nie-transkrypt):
- Read tool. Wyciągnij **claims, insighty, dane, cytaty, źródła**. Oddziel fakty od opinii autora. Zanotuj kto/co jest źródłem.

### 1.3 Destylat per plik + merge

Dla każdego pliku zbuduj rekord:

```
| # | Plik | Typ | Kategoria | Tagi | TL;DR (2-3 zdania) | Kluczowe fakty/claims | Priorytet |
|---|------|-----|-----------|------|--------------------|-----------------------|-----------|
```

**Kategoria** = ten sam zestaw co dla transkryptów (z `category-routing.md`). Plik trafia do tej samej taksonomii kategorii co transkrypt o tym temacie (np. PDF z umową klienta → `clients`, raport rynkowy → `research`, deck strategiczny → `strategy`).

**Default behaviors (NIE PYTAJ — kontynuuj):**
- Ambiguous category → wybierz najbardziej prawdopodobną, zaloguj do `open_questions["ambiguous_routing"]`
- Nowy tag spoza taksonomii → prefix `proposed:`, zaloguj do `open_questions["taxonomy_update"]`

---

## FAZA 2: Skanowanie modułów

### 2.1 Spawn agentów równolegle (3 agenty)

**Agent 1 — module-scanner (topic-based):**
```
Strategia: Topic-based. Na podstawie poniższych destylatów plików znajdź moduły wiki do aktualizacji.
[wklej tabelę destylatów z Fazy 1.3 — kolumny: Plik, Kategoria, TL;DR, Kluczowe fakty]
```

**Agent 2 — module-scanner (entity-based):**
```
Strategia: Entity-based. Przeszukaj moduły pod kątem tych encji wyciągniętych z plików:
Osoby: [lista]
Klienci/produkty/vendorzy/projekty: [lista z tagów i faktów]
```

**Agent 3 — consistency-checker:**
```
Sprawdź spójność pomiędzy faktami z plików a istniejącymi modułami.
Nowe dane: [TL;DR + kluczowe fakty/claims z Fazy 1.3]
Moduły do sprawdzenia: [lista kandydatów jeśli znana, inaczej "znajdź sam"]
```

Uruchom RÓWNOLEGLE.

### 2.2 Merge i priorytetyzacja

Połącz wyniki obu module-scannerów (deduplikacja). Stwórz finalną listę:

```
HIGH priority: [lista]
MEDIUM priority: [lista]
LOW priority: [lista]
```

### 2.3 Obsługa konfliktów (autonomous)

Jeśli consistency-checker znalazł SPRZECZNOŚCI:
- **Default: newest wins** — użyj danych z pliku (zakładamy, że plik świeżo wpadł do backlogu)
- W module zachowaj starą wersję jako HTML comment: `<!-- PRE-MINING (2026-MM-DD): X -->` tuż nad zaktualizowanym faktem
- Zaloguj do `open_questions["data_conflict"]` z polami: module, old_value, new_value, file_source
- **WYJĄTEK:** jeśli plik jest wyraźnie STARSZY niż moduł (np. PDF datowany sprzed ostatniej realnej zmiany modułu w gicie, raport historyczny) → NIE nadpisuj. Zaloguj jako `historical_reference` i potraktuj plik jako kontekst, nie źródło prawdy.
- **NIE pytaj** — kontynuuj mining

Auto-fixy (nieaktualne statusy, brakujące wiki-links) → zastosuj automatycznie w Fazie 3.
Duplikaty → pomiń w miningu.

---

## FAZA 3: Mining i aktualizacje

**WAŻNE: Ta faza w main session, NIE deleguj do agentów.**

### 3.1 Przeniesienie plików do archiwum źródeł

Pliki nie-transkrypcyjne mają swój dom: **`_transcripts/files/`** (raw sources layer, równolegle do transkryptów). Jeśli folder nie istnieje → utwórz go.

Dla każdego przetworzonego pliku — przenieś z backlogu:

```bash
mkdir -p "_transcripts/files"
mv "_transcripts-backlog/nazwa.pdf" "_transcripts/files/nazwa.pdf"
```

> **Dlaczego `_transcripts/files/` a nie nowy top-level folder:** `_transcripts/` to już zadeklarowany "raw sources layer" (immutable input). Pliki to po prostu inny format raw source niż transkrypt — trzymanie ich obok, w pod-folderze, zachowuje jedną bramę wejścia i jeden index (`transcripts_index.md`). Obrazy/PDF zostają w oryginalnej formie (binarnej) — destylat wiedzy żyje w modułach wiki, nie w pliku źródłowym.

Jeśli plik wymagał konwersji (np. `pdftotext`) i powstał tekstowy artefakt wartościowy do późniejszego grep → zapisz go obok jako `nazwa.txt` (opcjonalnie). NIE commituj plików z PII bez świadomości usera (flaguj sensitive).

### 3.2 Mining modułów

Dla każdego modułu (HIGH → MEDIUM → LOW):

1. Przeczytaj moduł docelowy (CAŁY plik)
2. Przeczytaj destylat źródłowego pliku (z Fazy 1.3) + w razie potrzeby zajrzyj ponownie do pliku
3. Sprawdź sąsiadów — `[[wiki-linki]]` w treści i krawędzie encji we frontmatterze (`owner:`, `osoby:`, `uczestnicy:`, `dotyczy:`) — czy też wymagają zmian
4. Sprawdź kontrakt edycji z `type:`:
   - `modul` / `osoba` (living-state) → wplataj fakt w `## Stan`; wpis datowany wyłącznie w `## Log`
   - `spotkanie` / `event` / `log` (write-once) → **nie edytuj**, zaloguj do `open_questions["write_once_target"]`
5. Edytuj moduł:
   - Dodaj nowe informacje (NIE nadpisuj istniejących)
   - Wstaw `[[wiki-link]]` do pliku źródłowego w treści, w miejscu gdzie fakt jest użyty. **NIE dodawaj `sources:`** — to pole żyje wyłącznie w `_transcripts/**-summary.md`
   - Zaktualizuj `status:` jeśli potrzeba (enum: `stable | draft | needs-update | archive`)
   - `updated:` stampuje pre-commit; jeśli w tym vaulcie nie ma haka — ustaw na dziś ręcznie, ale świeżość i tak czytaj z gita
   - Liczby operacyjne zapisuj jako pointer: `N (stan na RRRR-MM-DD, kanon: X)`
6. Zastosuj auto-fixy z consistency-checker (wiki-links, statusy, relikty pól `cadence:` / `depends-on:`)

**Default behaviors (NIE PYTAJ — kontynuuj):**
- **Sensitive content** (tensje, finanse, equity, PII) → mininguj normalnie. W session log oznacz moduł sentinel `🔒 SENSITIVE`. Zaloguj do `open_questions["sensitive_review"]` z listą zmienionych pól
- **Moduł docelowy nie istnieje** → stwórz szkic wg `_claude/2-templates/file-standard.md`:
  - Frontmatter kompletny: `title`, `type: modul`, `status: draft`, `updated: dziś`
  - Sekcja TL;DR z kluczowymi faktami z pliku + sekcja `## Stan`
  - Placeholder sekcje (## Kontekst, ## Open questions)
  - Link do pliku źródłowego w treści, nie w `sources:`
  - Zaloguj do `open_questions["new_module_draft"]` z polami: path, source_file, suggested_full_module: yes/no

### 3.3 Safety checks

Po każdej edycji weryfikuj:
- `type:` obecny i poprawny? `status:` w enumie?
- Zero pól `cadence:` / `depends-on:` / `audience:`? Zero `sources:` poza `-summary.md`?
- Fakt trafił do `## Stan`, a data (jeśli była) do `## Log` — nie w środek akapitu?
- Nie nadpisano nowszych danych? (szczególnie: czy plik nie jest historyczny — patrz 2.3)

### 3.4 Tracking dla Reweave

Zanotuj dane potrzebne dla Fazy 3.5:
- `touched_modules[]` — lista WSZYSTKICH modułów edytowanych w Fazie 3 (pełne ścieżki + krótki opis zmian)
- `resolved_contradictions[]` — lista sprzeczności rozwiązanych w Fazie 2.3/3 (moduł + stara vs nowa wartość)
- `updated_indexes[]` — lista index files zaktualizowanych w Fazie 3 (jeśli jakiekolwiek)

---

## FAZA 3.5: Reweave (backward pass)

Cel: sprawdź czy SĄSIEDZI zaktualizowanych modułów stali się nieaktualni.

### 3.5.0 Warunek uruchomienia

- Jeśli touched_modules PUSTA (Faza 3 nic nie edytowała) → **POMIŃ Fazę 3.5**
- Jeśli --dry-run → **POMIŃ Fazę 3.5**
- Jeśli brak `_claude/7-skill-references/reweave-standards.md` w vault → uruchom uproszczony reweave (3 testy poniżej z pamięci skilla), zaloguj `open_questions["missing_reference"]: reweave-standards.md`

### 3.5.1 Spawn reweave-scanner agenta

Użyj Task tool z `subagent_type: "reweave-scanner"`. W prompcie podaj:

```
Przeczytaj referencje (jeśli istnieje): _claude/7-skill-references/reweave-standards.md

Moduły zaktualizowane w tej sesji (Phase 3, na podstawie plików nie-transkrypcyjnych):
[wklej touched_modules[] z 3.4 — ścieżka + opis zmian]

Sprzeczności rozwiązane:
[wklej resolved_contradictions[] z 3.4, lub "brak"]

Index files zaktualizowane:
[wklej updated_indexes[] z 3.4, lub "brak"]

Wykonaj pełną ewaluację 5 triggerów. Zwróć priorytetyzowaną kolejkę reweave.
```

### 3.5.2 Reweave Execute (MAIN SESSION)

**WAŻNE: Ta faza w main session, NIE deleguj do agentów.**

Dla każdego modułu z HIGH priority (max 8, w kolejności score descending):

1. **Przeczytaj** moduł docelowy (CAŁY plik)
2. **Przeczytaj** moduł triggering (ten co spowodował reweave)
3. **Zastosuj 3 testy:**
   - Articulation Test: "Moduł [[A]] łączy się z [[B]] ponieważ ___"
   - Agent Traversal Check: "Jeśli agent podąża za linkiem, jaką decyzję podejmie?"
   - Sharpening Test: "Czy dodanie info wyostrza czy rozmywa przekaz?"
4. **Określ Reweave Action** (1 z 5):
   - **ADD CONNECTIONS** → dodaj wiki-links w treści i krawędzie encji we frontmatterze
   - **REWRITE CONTENT** → zaktualizuj fakty, statusy, liczby
   - **SHARPEN** → usuń hedging, potwierdź zrealizowane
   - **SPLIT** → FLAG dla usera, nie wykonuj automatycznie
   - **CHALLENGE** → STOP, pokaż sprzeczność, pytaj usera
5. **Zastosuj** zmiany zgodnie z kontraktem edycji typu (`## Stan` / `## Log`; write-once = nie ruszaj) + krawędzie encji we frontmatterze
6. **Zaloguj** co zrobiłeś (moduł, action, opis — do raportu w 3.5.4)

Dla MEDIUM priority: zapisz do `_claude/5-backlog/reweave-queue.md` (tabela Pending; utwórz plik jeśli brak).
Dla LOW priority: zaloguj w session logu (bez akcji).

**Default behaviors (NIE PYTAJ — kontynuuj):**
- **Reweave Action = CHALLENGE** → NIE wykonuj destruktywnej zmiany. Zaloguj do `open_questions["reweave_challenge"]` z polami: module, fundamental_assumption, contradicting_evidence, recommended_decision. Kontynuuj z innymi modułami.
- **Reweave Action = SPLIT** → zaloguj do `open_questions["split_candidates"]` z polami: module, suggested_split_axis, sub-modules-proposed. NIE wykonuj split.

### 3.5.3 Reweave Verify

Dla KAŻDEGO reweaved modułu:

1. **Cold-Read Test** — przeczytaj tytuł i pierwszą sekcję. Czy reszta modułu jest przewidywalna z kontekstu?
2. **Schema Check** — `type:` obecny? `status:` w enumie? Zero `cadence:` / `depends-on:` / `audience:`? Krawędzie encji jako `[[]]`? Daty tylko w `## Log`?
3. **Neighbor Coherence** — przeczytaj 1 moduł z sąsiedztwa (wiki-link albo krawędź encji). Czy nadal się zgadzają na fakty?

Jeśli weryfikacja FAIL → cofnij zmiany w module, dodaj do `reweave-queue.md` z notatką "verification failed, needs human review".

### 3.5.4 Raport reweave

```
REWEAVE: X modułów przetworzonych
- HIGH: Y wykonanych (lista z action type)
- MEDIUM → kolejka: Z (lista ścieżek)
- LOW → zalogowane: W
ACTIONS: A add-connections, B rewrite, C sharpen, D split-flags, E challenges
```

---

## FAZA 4: CEO Advisory

### 4.1 Spawn ceo-advisor agenta

Użyj Task tool z `subagent_type: "ceo-advisor"`. W prompcie podaj:

```
Przeanalizuj przetworzone pliki (nie-transkrypcyjne źródła):
[lista plików z typem + TL;DR z Fazy 1.3]

Zaktualizowane moduły:
[lista z Fazy 3 z opisem zmian]

Efekt kaskadowy (reweave):
[raport z Fazy 3.5.4 — jakie moduły-sąsiedzi zaktualizowano, jakie actions, jakie triggery]
[jeśli Faza 3.5 pominięta → "Faza 3.5 pominięta (brak touched modules)"]

Przeczytaj index files projektów aby zrozumieć kontekst.
Szukaj unknown unknowns — sygnały, szanse, luki, trendy. Zwróć uwagę: jakie źródła
(dokumenty, dane, obrazy) wniosły coś, czego rozmowy nie wychwyciły.
```

Ten agent używa modelu opus dla głębokiej analizy.

---

## FAZA 4.5: Reflect (forward pass)

Cel: odkryj NIEOCZYWISTE połączenia między modułami dotkniętymi w tej sesji.

### 4.5.0 Warunek uruchomienia

- Jeśli łącznie (touched_modules + reweaved_modules) < 2 → **POMIŃ Fazę 4.5**
- Jeśli --dry-run → **POMIŃ Fazę 4.5**

### 4.5.1 Spawn knowledge-weaver agenta

Użyj Task tool z `subagent_type: "knowledge-weaver"`. W prompcie podaj:

```
Przeczytaj referencje (jeśli istnieje): _claude/7-skill-references/reweave-standards.md (sekcje o połączeniach i synthesis)

Moduły dotknięte w tej sesji (Phase 3 mining + Phase 3.5 reweave):
[wklej PEŁNĄ listę — ścieżka + opis zmian]

Projekty dotknięte: [które]

Wykonaj Dual Discovery (MOC traversal + semantic search).
Dla każdego potencjalnego połączenia zastosuj Articulation Test.
Szukaj cross-project connections i synthesis opportunities.
```

### 4.5.2 Reflect Apply (MAIN SESSION)

**WAŻNE: Ta faza w main session, NIE deleguj do agentów.**

1. **New Connections** — dla każdego zaakceptowanego połączenia:
   - Przeczytaj target module
   - Dodaj wiki-link inline w odpowiednim miejscu (preferuj prose, nie "See also")
   - Jeśli bidirectional → dodaj reverse link
2. **Synthesis Opportunities** — dla każdej wykrytej:
   - **NIE** twórz nowych modułów
   - Dodaj do `_claude/5-backlog/synthesis-opportunities.md` (sekcja Open; utwórz plik jeśli brak)
3. **Index Updates** — z raportu knowledge-weaver: zastosuj bezpośrednio (dodawanie linków do index files jest bezpieczne)

### 4.5.3 Raport reflect

```
REFLECT: X nowych połączeń dodanych, Y synthesis opportunities, Z index updates
```

---

## FAZA 5: Finalizacja

### 5.1 Aktualizacja indexów

1. Przeczytaj `_transcripts/transcripts_index.md` → dodaj/zaktualizuj wiersz `files/` w tabeli kategorii (utwórz wiersz jeśli nie istnieje) + zaktualizuj counter
2. Przeczytaj `_claude/5-backlog/backlog_index.md` (jeśli istnieje) → refresh statusów

### 5.2 Session log

Stwórz session log w `_claude/4-sessions/{YYYY-MM}/`:
- Przeczytaj szablon (jeśli istnieje): `_claude/2-templates/session-log.md`
- Wypełnij: data, przetworzone pliki (z typami), zmodyfikowane moduły, decyzje, zmiany

### 5.3 Raport końcowy

Wyświetl:
```
PRZETWORZONO: X plików [N PDF, M obrazów, K danych, ...]
PRZENIESIONO: do _transcripts/files/ (+ kategoryzacja tematyczna)
ZAKTUALIZOWANO: X modułów (HIGH: Y, MEDIUM: Z, LOW: W)
KONFLIKTY: X rozwiązanych
REWEAVE: X modułów (HIGH: Y wykonanych, MEDIUM → kolejka: Z)
REFLECT: X nowych połączeń, Y synthesis opportunities, Z index updates
NIECZYTELNE: X plików (wymagają konwersji — szczegóły w open questions)
```

Następnie wyświetl CEO Advisory Report z Fazy 4.

Jeśli są synthesis opportunities → wyświetl listę.
Jeśli reweave-queue.md ma >10 pending → zaznacz: "Reweave queue ma X items — rozważ reweave loop."

### 5.4 Opcjonalne pytania zbiorcze

**Cel:** zbiorczo, na końcu, opcjonalnie. User może zignorować i przejść do commita.

Jeśli `open_questions[]` jest pusty → pomiń tę fazę.

1. **Zgrupuj** open questions wg `type`:
   - `ambiguous_routing` / `classification` (Faza 0-1)
   - `unreadable_file` (Faza 1)
   - `taxonomy_update` (Faza 1)
   - `data_conflict` / `historical_reference` (Faza 2)
   - `sensitive_review` (Faza 3)
   - `new_module_draft` / `write_once_target` (Faza 3)
   - `reweave_challenge` / `split_candidates` (Faza 3.5)
   - `missing_reference` (brakujące pliki referencyjne)

2. **Wyświetl** zwięzły raport:

```
═══════════════════════════════════════════════════════
OPEN QUESTIONS (opcjonalne — możesz pominąć)
═══════════════════════════════════════════════════════

[N] nieczytelne pliki (wymagają konwersji):
  • raport-q2.pdf — brak pdftotext, przenieść do files/ bez miningu?

[N] sprzeczności danych (newest wins applied):
  • module-a.md: "X" → "Y" (źródło: deck-strategiczny.pdf)

[N] ambiguous routing (chosen first-rank):
  • umowa-klient.pdf → clients (alternatywa: strategy)

[N] new module drafts (created):
  • _path/to/new-module.md (status: draft) — rozbudować?

[N] sensitive content flagged:
  • module-x.md (zmienione: PII / liczby finansowe)

[N] reweave challenges (NOT applied) / split candidates (NOT applied)

[N] proposed taxonomy tags
═══════════════════════════════════════════════════════
```

3. **Zapytaj jednym AskUserQuestion** (zbiorczo, max 4 pytania, multiSelect dla flag):

```
Q1: Nieczytelne pliki — przenieść do files/ bez miningu / zostawić w backlogu? [multiSelect / skip]
Q2: Szkice (`status: draft`) do rozbudowy? [lista do multiSelect / skip all]
Q3: Reweave challenges — wykonać po zaakceptowaniu? [lista do multiSelect / skip all]
Q4: Tagi proposed: → dodać do taksonomii? [yes all / select / skip]
```

Pomiń pytania których typu nie ma w `open_questions[]`.

4. **Zastosuj decyzje** (jeśli user odpowiedział) lub przejdź dalej (jeśli skip).

5. **Zapisz nieobsłużone open questions** do `_claude/5-backlog/post-mining-review.md` (append, datowane).

### 5.5 Zaproponuj commit (NIE commituj bez zgody)

Twarda reguła repo (CLAUDE.md sekcja 2: „DO NOT commit without explicit approval"). Pokaż gotową
komendę, **nie wykonuj jej**, i zapytaj jednym zdaniem: „Commitnąć te zmiany?" — potem czekaj.

```bash
git add [lista zmodyfikowanych plików]
git commit -m "$(cat <<'EOF'
Add: file processing (X plików) + Y module updates + Z reweave + W reflect connections

Sources: [lista plików]
EOF
)"
```

Jeśli paczka jest czysto mechaniczna (sweep, rename, lint-fix — zero nowej wiedzy), dopisz w treści
commita trailer `Meta: true`, żeby nie fałszować świeżości.

---

## Argumenty

- **--dry-run** — tylko analiza (Fazy 0-2), bez zmian w plikach. Pokaż co BY było zrobione.
- **--skip-pull** — pomiń git pull (gdy już zrobiony ręcznie)

## Obsługa błędów

- Brak plików nie-transkrypcyjnych → info + exit (skieruj do /process-transcripts)
- **Git conflict (Faza 0) → JEDYNY HARD BLOCK** — pokaż userowi, czekaj na resolve
- Plik binarny/nieczytelny → **próba konwersji (pdftotext/textutil)** + log do `open_questions["unreadable_file"]`, NIE przerywaj
- Plik wygląda na transkrypt → **pomiń** (należy do /process-transcripts), zaznacz w raporcie
- Moduł nie istnieje → **auto-create stub** + log do `open_questions["new_module_stub"]`
- Sprzeczne dane → **newest wins** (chyba że plik historyczny) + HTML comment PRE-MINING + log do `open_questions["data_conflict"]`
- Sensitive content / PII → **process + flag** w session log + log do `open_questions["sensitive_review"]` (NIE commituj PII bez świadomości usera)
- Reweave CHALLENGE/SPLIT → **skip destruktywnej zmiany** + log do `open_questions[...]`
- Ambiguous routing → **first-rank** + log do `open_questions["ambiguous_routing"]`
- Nowy tag → **prefix `proposed:`** + log do `open_questions["taxonomy_update"]`
- Brak `reweave-standards.md` → **uproszczony reweave** + log do `open_questions["missing_reference"]`

Wszystkie open_questions surfacują się w **Fazie 5.4** (zbiorczo, opcjonalnie). Hard block (git conflict) to jedyny wyjątek — wszystko inne czeka do końca.
