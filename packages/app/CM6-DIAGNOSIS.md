# CM6-DIAGNOSIS — dlaczego CodeMirror 6 "renderował się, ale nie reagował"

Data: 2026-06-12 · Dotyczy: `packages/app` (Electron renderer, esbuild iife/browser)

## TL;DR

**Root cause (confidence: high): zduplikowane fizyczne kopie `@codemirror/state` (×3) i `@codemirror/view` (×2) w bundlu renderera.** To kanoniczny failure mode CM6: extensions (keymap, language, theme, updateListener) utworzone przez jedną kopię pakietu nie są rozpoznawane przez `EditorView`/`EditorState` z drugiej kopii — edytor montuje się i renderuje dokument, ale handlery input/scroll nigdy się nie podpinają (albo `EditorState.create` rzuca `RangeError: Unrecognized extension value`, w zależności od tego, skąd pochodziły konkretne extensions).

Czynnik wtórny (confidence: moderate): brak jawnego height setup — `.cm-editor` montowany w flex-column hoście (`.mc-app-editor-host`, `overflow: hidden`) bez `height: 100%` / `flex: 1` sizuje się do contentu i nigdy nie scrolluje wewnętrznie. Nawet po naprawie duplikatów to dawałoby "scroll nie działa".

## Dowody

### 1. Drzewo zależności (`npm ls @codemirror/state @codemirror/view`)

Przed naprawą w drzewie były **dwie wersje state (6.6.0 + 6.5.0)** i **dwie wersje view (6.41.0 + 6.38.6)**. Fizyczne lokalizacje (to one się liczą — esbuild deduplikuje po ścieżce absolutnej, nie po wersji):

| Ścieżka | Wersja | Kto to dostawał przy bundlowaniu z `packages/app` |
|---|---|---|
| `packages/app/node_modules/@codemirror/state` | 6.6.0 | bezpośrednie importy z `CmEditor.ts` / starego EditorPane |
| `node_modules/@codemirror/state` (root) | 6.5.0 | `lang-markdown`, `language`, `theme-one-dark`, `autocomplete` |
| `node_modules/@codemirror/commands/node_modules/@codemirror/state` | 6.6.0 | `@codemirror/commands` (history, defaultKeymap) |
| `packages/app/node_modules/@codemirror/view` | 6.41.0 | bezpośrednie importy (klasa `EditorView`) |
| `node_modules/@codemirror/view` (root) | 6.38.6 | wszystkie pakiety CM6 z root node_modules |

Skąd się wzięło: `packages/app/package.json` deklaruje `@codemirror/state: ^6.6.0` i `@codemirror/view: ^6.41.0`, a lockfile root miał zamrożone 6.5.0/6.38.6 (przez `obsidian@1.12.3` z `packages/plugin`). npm workspaces rozwiązał konflikt nested copies zamiast hoistingiem jednej wersji.

### 2. Dowód w bundlu (esbuild metafile)

Bundle testowy `CmEditor.ts` **przed** naprawą zawierał moduły z:

```
node_modules/@codemirror/state                                      (6.6.0)
../../node_modules/@codemirror/state                                (6.5.0)
../../node_modules/@codemirror/commands/node_modules/@codemirror/state (6.6.0)
node_modules/@codemirror/view                                       (6.41.0)
../../node_modules/@codemirror/view                                 (6.38.6)
```

= **3 kopie state + 2 kopie view w jednym iife**. Każda kopia ma własne instancje `Facet`/`StateField` — `EditorView` z jednej kopii ignoruje (lub odrzuca) extensions z pozostałych. Stąd dokładnie zaobserwowany symptom: *renders but no input/scroll*.

**Po** naprawie metafile pokazuje dokładnie jedną kopię każdego pakietu, a marker-string `"Calls to EditorView.update are not allowed"` (unikalny per kopia view) występuje w bundlu 1×.

### 3. Dlaczego textarea działał

`<textarea>` nie ma systemu extensions — layout, focus i eventy kontenera były OK od początku. To poprawnie zawęziło problem do CM6.

## Co naprawia ta implementacja

1. **Dedupe `node_modules` (env fix, wykonany):** root copies podbite do `state@6.6.0` + `view@6.41.0`, usunięte kopie nested w `packages/app/node_modules/@codemirror/` i `node_modules/@codemirror/commands/node_modules/`. Wszystkie zakresy semver pakietów CM6 (`^6.0.0` / `^6.6.0` / `^6.27.0`) są spełnione przez te wersje. `node_modules/` jest w `.gitignore` — żaden plik repo nie został zmieniony.
2. **`CmEditor.ts`** (`src/renderer/layout/CmEditor.ts`):
   - height setup w theme: `"&": { height: "100%", flex: "1 1 auto", minHeight: 0 }` + `".cm-scroller": { overflow: "auto" }` — działa w flex-column `.mc-app-editor-host` wewnątrz grida `.mc-app-shell`, bez dotykania `styles.css`;
   - markdown (GFM) highlighting, własny dark theme (#0d0d0d, akcent #eb670f), oneDark highlight jako fallback dla fenced code;
   - autosave 1.5 s, `Mod-s`, binary/size guard (kopiowane z EditorPane), undo history, line wrapping;
   - nowe API: `setExternalContent(content)` (reload po zmianie z zewnątrz, nie brudzi bufora), `isDirty()`, `getPath()`;
   - defensive guard: jeśli duplikaty wrócą i mount rzuci `Unrecognized extension value`, pokazuje czytelny komunikat z odnośnikiem do tego pliku zamiast cichego faila.

## Ryzyka rezydualne

- **Następny `npm install` przywróci duplikaty** (lockfile nadal opisuje stary układ). Trwały fix — dodać do **root** `package.json`:
  ```json
  "overrides": {
    "@codemirror/state": "6.6.0",
    "@codemirror/view": "6.41.0"
  }
  ```
  i przeinstalować (`rm -rf node_modules package-lock.json && npm install`, potem weryfikacja `npm ls @codemirror/state @codemirror/view` — wszystko "deduped" do jednej wersji). Nie zrobiono tego tutaj, bo zadanie zabraniało edycji istniejących plików.
- **`@lezer/highlight` jako phantom dependency** — `CmEditor.ts` importuje `tags` z `@lezer/highlight`, który jest w drzewie (przez `@codemirror/language`), ale nie w `dependencies` `packages/app/package.json`. Warto dopisać `"@lezer/highlight": "^1.2.0"`. Pakiety `@lezer/*` mają obecnie pojedyncze kopie (zweryfikowane), więc nie powtarzają problemu duplikatów.
- **Pre-existing, niezwiązane:** `npm run build:renderer` jest aktualnie zepsuty przez untracked `packages/shared/src/skills/setup-flags.ts` (`require("os")` przy `--platform=browser`). Fix: `--external:os` w skrypcie `build:renderer` albo guard w setup-flags. Istniało przed tą zmianą i nie dotyczy CM6.
- Obsidian plugin (`packages/plugin`) externalizuje `@codemirror/*` w buildzie, więc bump root copies 6.5.0→6.6.0 nie wpływa na runtime pluginu; typecheck przeciwko 6.6.0 przeszedł.

## Jak przetestować

1. Wpiąć CmEditor w renderer (jednolinijkowa zmiana w `src/renderer/index.ts`):
   ```ts
   import { CmEditor } from "./layout/CmEditor";
   // ...w loadVault():
   editorPane = new CmEditor(shell.editorEl);
   ```
   (interfejs jest supersetem EditorPane — `open/save/destroy` bez zmian).
2. `cd packages/app && npm run build && npx electron .` *(uwaga na pre-existing błąd `os` w build:renderer — patrz wyżej)*.
3. Otworzyć vault (⌘O), kliknąć plik `.md` i sprawdzić: pisanie działa, scroll kółkiem i strzałkami działa, nagłówki/bold/linki są pokolorowane, ⌘S zapisuje natychmiast, po 1.5 s od edycji znika kropka dirty w headerze, plik binarny (.png) pokazuje placeholder, plik >5 MB pokazuje cap.
4. Regresja duplikatów (po każdym `npm install`):
   ```bash
   cd packages/app
   npx esbuild src/renderer/layout/CmEditor.ts --bundle --platform=browser \
     --target=es2020 --format=iife --loader:.css=text \
     --outfile=/tmp/cm-editor-test.js --metafile=/tmp/cm-meta.json
   node -e "const m=require('/tmp/cm-meta.json');const s=new Set(Object.keys(m.inputs).filter(p=>/@codemirror\/(state|view)\//.test(p)).map(p=>p.replace(/\/dist\/.*$/,'')));console.log([...s].join('\n'));console.log(s.size===2?'OK — single copies':'FAIL — duplicates!')"
   ```
