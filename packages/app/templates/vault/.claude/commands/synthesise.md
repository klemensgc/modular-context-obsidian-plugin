---
description: Orkiestrator przycisku "/synthesise" w aplikacji — przetwarza CAŁY backlog za jednym razem. Dzieli pozycje na transkrypty i pliki, odpala oba pipeline'y (process-transcripts + process-files), wplata Twoje komentarze "focus" w analizę i odpowiada na nie na końcu. Jedna sesja, jeden session log, jeden commit.
argument-hint: [--dry-run] [--skip-pull] [focus block: "- nazwa-pliku: komentarz"]
---

# Synthesise — orkiestrator backlogu (transkrypty + pliki)

Jesteś nadrzędnym orkiestratorem. Aplikacja wywołuje Cię przyciskiem "/synthesise", żeby
**za jednym razem** przerobić wszystko, co leży w `_transcripts-backlog/` — i transkrypty, i pliki.
Repo jest po polsku. Odpowiadaj po polsku.

> **Relacja do rodzeństwa:** ten skill **nie duplikuje** logiki — wykonuje te same fazy co
> `/process-transcripts` (dla transkryptów) i `/process-files` (dla plików), w **jednej sesji**,
> z jednym wspólnym buforem `open_questions[]`, jednym session logiem i jednym commitem na końcu.
> Czytaj oba pliki komend jako źródło szczegółów każdej fazy:
> - `.claude/commands/process-transcripts.md`
> - `.claude/commands/process-files.md`

**Reguła nadrzędna: NIE PRZERYWAJ MININGU.** Działaj end-to-end autonomicznie. Wszystkie wątpliwości
trafiają do wspólnego bufora `open_questions[]` i prezentujesz je zbiorczo na końcu (FAZA 9), opcjonalnie.

**Jedyny hard block:** git conflict w FAZIE 0.

**Default behaviors:** identyczne jak w obu komendach-rodzeństwie (newest wins + PRE-MINING comment,
auto-stub dla brakujących modułów, `proposed:` dla nowych tagów, sensitive → flag, reweave
CHALLENGE/SPLIT → log bez wykonania, nieczytelny plik → próba konwersji + log). Nie powielam ich tu —
obowiązują w całości.

---

## FOCUS COMMENTS — Twoje komentarze z aplikacji

Wiadomość wywołująca ten skill **może** zawierać blok "focus" — komentarze, które wpisałeś przy
konkretnych plikach w aplikacji. Format:

```
focus:
- nazwa-pliku-1.pdf: na czym mam się skupić / o co pytam przy tym pliku
- rozmowa-z-klientem.md: zweryfikuj czy to potwierdza X / wyciągnij Y
- dashboard.png: jakie liczby tu są i co z nich wynika
```

**Jak traktować focus:**
1. Na starcie sparsuj blok focus do mapy `focus[plik] = komentarz`. Jeśli bloku nie ma → `focus = {}`.
2. **Wplataj** każdy komentarz w analizę DOKŁADNIE tego pliku (FAZA 1/2 transkryptów lub plików):
   komentarz steruje tym, czego szukasz, co weryfikujesz i które moduły traktujesz priorytetowo.
3. Komentarz **podbija priorytet** powiązanych modułów do HIGH (user jawnie się tym interesuje).
4. Jeśli komentarz odnosi się do pliku, którego NIE ma w backlogu → zaloguj do `open_questions["focus_orphan"]`.
5. Na końcu (FAZA 8) **odpowiadasz** na każdy komentarz wprost, cytując dotknięte moduły.

---

## FAZA 0: Setup + rozdział backlogu

### 0.1 Git pull (chyba że --skip-pull)

Użyj Bash tool (NIE blok kodu z wykrzyknikiem):

```bash
git pull origin master --no-rebase 2>&1 || true
```

Obsługa wyniku jak w process-transcripts (FAZA 0.1): success → kontynuuj; CONFLICT → auto-resolve
(location conflicts: accept theirs; content conflicts: pokaż usera, czekaj — **hard block**);
network/auth → ostrzeżenie + kontynuuj.

### 0.2 Inwentaryzacja + klasyfikacja

Przeczytaj `_transcripts-backlog/**/*` (Glob). Zastosuj **heurystykę rozdziału z `process-files.md` (FAZA 0.2):**

- **TRANSKRYPT** = `.md`/`.txt`/`.vtt`/`.srt`, który czyta się jak rozmowa/spotkanie (speakerzy w bold, timestampy `(m:ss)`/`[0.01s]`, `Attendees:`/`Duration:`, lub `-summary.md` sparowany).
- **PLIK** = wszystko inne (PDF, .docx, obrazy, CSV/JSON, kod, artykuły/notatki prose).
- `.md`/`.txt` graniczne → zajrzyj w pierwsze ~30 linii; przy realnej wątpliwości potraktuj jak transkrypt i zaloguj `open_questions["classification"]`.

Sparsuj też blok **focus** (sekcja wyżej).

Wyświetl raport startowy:
```
Backlog: X pozycji
  → TRANSKRYPTY: A (par: ..., standalone: ...)
  → PLIKI: B [N PDF, M obrazów, K danych, ...]
Focus comments: C (powiązane z: lista plików)
```

Decyzja o ścieżce:
- A>0 i B>0 → uruchom OBA pipeline'y (FAZA 1 transkryptów, potem FAZA 2 plików)
- tylko A>0 → tylko pipeline transkryptów
- tylko B>0 → tylko pipeline plików
- A=0 i B=0 → "Backlog pusty, nic do przetworzenia." i zakończ

Kontynuuj automatycznie (nie pytaj).

---

## FAZA 1: Pipeline TRANSKRYPTÓW (jeśli A>0)

Wykonaj fazy z `process-transcripts.md` dla **podzbioru transkryptów** — TRAKTUJ tamten plik jako
specyfikację i przejdź przez nie w main session (NIE wołaj `/process-transcripts` jako osobnej sesji —
to jedna sesja, współdzielony stan):

1. **Referencje** (process-transcripts FAZA 1.1): tagging-taxonomy, category-routing, transcript-standards.
2. **transcript-analyzer** (FAZA 1.2-1.3) — spawn agentów (batche jak w oryginale), merge do tabeli kategoryzacji.
   - **FOCUS:** dla transkryptów z komentarzem dołącz komentarz do promptu agenta jako "Zwróć szczególną uwagę na: {komentarz}".
3. **module-scanner ×2 + consistency-checker** (FAZA 2) — równolegle, merge, priorytetyzacja.
   - **FOCUS:** moduły powiązane z plikami z focus → podbij do HIGH.
4. **Mining** (FAZA 3) — przenieś transkrypty do `_transcripts/{kategoria}/`, edytuj moduły, trackuj `touched_modules[]` itd.

**WAŻNE — odroczenie wspólnych faz:** Reweave (3.5), CEO Advisory (4), Reflect (4.5), finalizację i commit
z process-transcripts **POMIŃ tutaj** — zrobisz je RAZ, wspólnie dla obu pipeline'ów, w FAZACH 4-9 poniżej.
Z tej fazy wynieś: `touched_modules[]`, `resolved_contradictions[]`, `updated_indexes[]`, destylaty TL;DR.

---

## FAZA 2: Pipeline PLIKÓW (jeśli B>0)

Wykonaj fazy z `process-files.md` dla **podzbioru plików** — w tej samej sesji:

1. **Referencje** (process-files FAZA 1.1): tagging-taxonomy, category-routing. (transcript-analyzer NIE dla plików.)
2. **Ingestion per typ** (FAZA 1.2): obrazy → Read tool (Claude widzi obrazy); PDF/docx → Read, a przy
   binary → Bash `pdftotext`/`textutil`; dane → struktura + fakty; kod → co robi + integracje;
   artykuły/notatki → claims + insighty. Zbuduj destylat per plik (FAZA 1.3).
   - **FOCUS:** komentarz danego pliku steruje ekstrakcją — szukaj dokładnie tego, o co user pyta
     (np. "jakie liczby na dashboardzie" → wypisz liczby; "czy potwierdza X" → zweryfikuj X wprost).
3. **module-scanner ×2 + consistency-checker** (FAZA 2) — równolegle. Połącz z wynikami z FAZY 1 jeśli
   ten sam moduł jest kandydatem z obu źródeł (dedup).
   - **FOCUS:** moduły powiązane z plikami z focus → HIGH.
4. **Mining** (FAZA 3) — przenieś pliki do `_transcripts/files/` (utwórz folder jeśli brak), edytuj moduły,
   dopisz do wspólnych `touched_modules[]` itd. Pamiętaj o sensitive/PII flagach i regule "plik historyczny → nie nadpisuj".

**Odroczenie wspólnych faz:** jak w FAZIE 1 — reweave/advisory/reflect/finalizacja/commit robione raz, niżej.

---

## FAZA 3: Konsolidacja stanu

Zbierz w jeden zestaw (z FAZY 1 + FAZY 2, deduplikacja po ścieżce modułu):
- `touched_modules[]` — wszystkie edytowane moduły (transkrypty + pliki) + opis zmian + źródło
- `resolved_contradictions[]` — wszystkie sprzeczności rozwiązane
- `updated_indexes[]` — wszystkie zaktualizowane index files
- `distilled[]` — TL;DR per źródło (transkrypt LUB plik), z oznaczeniem typu i czy miało focus

To jest wspólne wejście do reweave / advisory / reflect.

---

## FAZA 4: Reweave (backward pass) — RAZ dla całości

Zasady i warunki uruchomienia jak w process-transcripts FAZA 3.5 (i fallback "brak reweave-standards.md →
uproszczony reweave" jak w process-files 3.5.0):

- Jeśli `touched_modules[]` PUSTA lub --dry-run → **POMIŃ**.
- Spawn `reweave-scanner` (Task) z PEŁNYM `touched_modules[]` z FAZY 3 (transkrypty + pliki).
- Execute w main session: max 8 HIGH, 3 testy (Articulation / Agent Traversal / Sharpening), 5 actions
  (ADD CONNECTIONS / REWRITE / SHARPEN / SPLIT→flag / CHALLENGE→stop+log). MEDIUM → `reweave-queue.md`. LOW → log.
- Verify (Cold-Read / Schema / Neighbor Coherence). FAIL → revert + queue.
- Raport reweave (jak 3.5.4).

---

## FAZA 5: CEO Advisory — RAZ dla całości

Spawn `ceo-advisor` (Task, opus). W prompcie podaj **łącznie** transkrypty i pliki:

```
Przeanalizuj przetworzony backlog (jedna sesja synthesise):
TRANSKRYPTY: [lista + TL;DR]
PLIKI (nie-transkrypcyjne źródła): [lista + typ + TL;DR]

Zaktualizowane moduły: [touched_modules z opisem zmian]
Efekt kaskadowy (reweave): [raport z FAZY 4, lub "pominięte"]

Przeczytaj index files projektów. Szukaj unknown unknowns — sygnały, szanse, luki, trendy.
Zwróć uwagę: gdzie dane/dokumenty potwierdziły lub PODWAŻYŁY to, co padło w rozmowach (cross-source).
```

---

## FAZA 6: Reflect (forward pass) — RAZ dla całości

Warunek: (touched + reweaved) >= 2 i nie --dry-run. Spawn `knowledge-weaver` (Task) z pełną listą
dotkniętych modułów. Apply w main session: New Connections (inline wiki-links + reverse),
Synthesis Opportunities → `_claude/5-backlog/synthesis-opportunities.md`, Index Updates → bezpośrednio.
Raport reflect (jak 4.5.3). Szczegóły: process-transcripts FAZA 4.5.

---

## FAZA 7: Aktualizacja indexów

1. `_transcripts/transcripts_index.md` → countery kategorii dla transkryptów **oraz** wiersz/counter `files/` dla plików.
2. `_claude/5-backlog/backlog_index.md` (jeśli istnieje) → refresh.

---

## FAZA 8: Odpowiedzi na focus + raport końcowy

### 8.1 Sekcja "## Odpowiedzi na Twój focus"

Jeśli `focus` było niepuste — wygeneruj dedykowaną sekcję. Dla KAŻDEGO komentarza odpowiedz **wprost**,
opierając się na tym, czego się dowiedziałeś, i **cytuj dotknięte moduły** (ścieżki):

```
## Odpowiedzi na Twój focus

### raport-q2.pdf — "jakie liczby i co z nich wynika"
[Konkretna odpowiedź na bazie ekstrakcji. Liczby: ... . Wniosek: ... .
 Zaktualizowane moduły: `path/do/modułu.md` (dodano X), `path/inny.md` (reweave: Y).]

### rozmowa-z-klientem.md — "czy potwierdza X"
[Tak/Nie + dowód z transkryptu. Wpływ: `path/pipeline-lub-status.md`. Sprzeczność (jeśli): ... → newest wins.]
```

Jeśli focus dotyczył pliku, którego nie było w backlogu (`focus_orphan`) → powiedz to wprost.
Jeśli `focus` było puste → pomiń tę sekcję (zaznacz krótko "Brak komentarzy focus.").

### 8.2 Raport końcowy

```
SYNTHESISE — podsumowanie sesji
PRZETWORZONO: A transkryptów + B plików [typy]
PRZENIESIONO: transkrypty → _transcripts/{kategorie}; pliki → _transcripts/files/
ZAKTUALIZOWANO: X modułów (HIGH/MEDIUM/LOW)
KONFLIKTY: X rozwiązanych
REWEAVE: ... | REFLECT: ... | NIECZYTELNE: ...
FOCUS: C komentarzy → odpowiedzi w sekcji wyżej
```

Następnie: CEO Advisory Report (FAZA 5) + lista synthesis opportunities (jeśli są).

---

## FAZA 9: Open questions (opcjonalne, zbiorczo)

Jeśli wspólny `open_questions[]` pusty → pomiń. W przeciwnym razie: zgrupuj wg `type` (wszystkie typy z
obu rodzeństw + `focus_orphan` + `classification`), wyświetl zwięzły raport, zapytaj jednym
AskUserQuestion (max 4, multiSelect dla flag), zastosuj decyzje lub skip, a nieobsłużone zapisz do
`_claude/5-backlog/post-mining-review.md` (append, datowane). Dokładny format: process-transcripts FAZA 5.4.

---

## FAZA 10: Session log + JEDEN commit

### 10.1 Session log

Jeden wspólny log w `_claude/4-sessions/{YYYY-MM}/` (szablon `_claude/2-templates/session-log.md` jeśli jest).
Uwzględnij OBA źródła (transkrypty + pliki), focus comments i odpowiedzi.

### 10.2 Zaproponuj commit (RAZ — nie podwójnie, i NIE bez zgody)

Twarda reguła repo (CLAUDE.md sekcja 2: „DO NOT commit without explicit approval"). Pokaż gotową
komendę i czekaj na „tak" — również poza `--dry-run`. Jeden commit obejmujący zmiany z obu
pipeline'ów, nigdy dwa:

```bash
git add [lista WSZYSTKICH zmodyfikowanych plików — transkrypty + pliki + moduły + indexy + logi]
git commit -m "$(cat <<'EOF'
Add: synthesise backlog (A transkryptów + B plików) + X module updates + reweave + reflect

Sources: [lista transkryptów i plików]
EOF
)"
```

---

## Argumenty

- **--dry-run** — analiza obu podzbiorów bez zmian i bez commita. Pokaż plan + odpowiedzi na focus na bazie samej analizy.
- **--skip-pull** — pomiń git pull.
- **focus block** — w treści wywołania; mapuj `plik → komentarz` (sekcja FOCUS COMMENTS).

## Obsługa błędów

- Backlog pusty → info + exit.
- **Git conflict (FAZA 0) → JEDYNY HARD BLOCK.**
- Wszystkie pozostałe przypadki (nieczytelny plik, sprzeczność, sensitive, brakujący moduł, ambiguous,
  nowy tag, reweave CHALLENGE/SPLIT, brak reweave-standards) → obsługa **dokładnie jak w
  process-transcripts.md i process-files.md** (default behaviors + `open_questions[]`), surfaced w FAZIE 9.
- `focus_orphan` (komentarz do pliku spoza backlogu) → odpowiedz wprost w sekcji focus, że pliku nie było.
- **Nie commituj dwa razy.** Cała sesja = jeden commit (FAZA 10).
