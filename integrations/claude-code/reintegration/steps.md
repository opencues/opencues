# OpenCues Re-integration Steps

Re-integrating OpenCues patches against Claude Code v2.1.110 (`claude-cues` at `~/local-claude-code`).
Each step is verified before proceeding to the next.

---

## Step 0 — tweakcc setup

**Goal:** Clean, working tweakcc install that applies non-OpenCues patches without errors.

**Actions:**

1. Clone tweakcc (if not present):
   ```bash
   TWEAKCC=~/opencues/integrations/claude-code/tweakcc
   git clone https://github.com/Piebald-AI/tweakcc $TWEAKCC
   cd $TWEAKCC && npm install
   ```

2. Copy OpenCues patch files into tweakcc:
   ```bash
   TWEAKCC=~/opencues/integrations/claude-code/tweakcc
   PATCHES=~/opencues/integrations/claude-code/patches
   cp $PATCHES/cursorStateExport.ts $TWEAKCC/src/patches/
   cp $PATCHES/wordHighlight.ts $TWEAKCC/src/patches/
   cp $PATCHES/dynamicHighlight.ts $TWEAKCC/src/patches/
   ```

3. Edit `$TWEAKCC/src/patches/index.ts` — remove three broken/noisy patches:
   - **`verbose-property`** — fails on v2.1.110 (pattern changed). Remove import, PATCH_DEFINITIONS entry, patchImplementations entry.
   - **`thinker-format`** — fails on v2.1.110 (pattern changed). Remove import, PATCH_DEFINITIONS entry, patchImplementations entry.
   - **`patches-applied-indication`** — prints a large banner listing every prompt at startup. Remove import, PATCH_DEFINITIONS entry, patchImplementations entry.

4. Comment out the `// --- Cues Patches ---` block entirely (re-enable per step below).

5. Build and verify clean:
   ```bash
   TWEAKCC=~/opencues/integrations/claude-code/tweakcc
   cd $TWEAKCC && npm run build
   CLI_JS=$(find ~/local-claude-code -name "cli.js" | head -1)
   TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node $TWEAKCC/dist/index.mjs --apply
   ```
   Expected: `Customizations applied successfully!` — no `patch:` error lines.

> See `docs/tweakcc-setup.md` for the full detail on each removal.

**Status: ✅ Done**

---

## Step 1 — `cursorStateExport`

**Goal:** On every keystroke, write `{text, cursorPosition, currentWord, atEnd, timestamp}` to `/tmp/claude-cursor-state.json`.

**What broke:**
The return statement inside the input handler (`Dy8`) changed:
- Old: `return{onInput:X,renderedValue:`
- New: `return{handleKeyDown:X,renderedValue:`

**Fix:** In `cursorStateExport.ts`, updated `returnPattern` from `onInput` to `handleKeyDown`.

**Re-enabled in `index.ts`:**
```ts
if (config.settings.misc?.enableCursorStateExport) {
  const exportPath = config.settings.misc?.cursorStateExportPath || '/tmp/claude-cursor-state.json';
  if ((result = writeCursorStateExport(content, exportPath))) content = result;
}
```

**Verification:**
Start `claude-cues`, type text, move cursor onto a word:
```bash
cat /tmp/claude-cursor-state.json
# {"text":"testing the system","cursorPosition":37,"currentWord":"system","atEnd":false,...}
```

**Status: ✅ Done**

---

## Step 2 — `wordHighlight`: full navigation + highlight

**Goal:** `Ctrl+Alt+Left`/`Right` navigates between words with visual highlight. Escape and typing clear it. State exported to `/tmp/claude-highlight-state-<pid>.json`.

### Sub-patches & status

| Sub-patch | Role | v2.1.110 status |
|---|---|---|
| `writeWordHighlightKeyHandler` | Injects Ctrl+Alt+Left/Right/Up/Down cases into key dispatcher `t()` | ✅ Regex + filter fallback updated |
| `writeWordHighlightClearOnEscape` | Clears highlight when user presses Escape | ✅ Regex tightened — was matching wrong location |
| `writeWordHighlightClearOnTyping` | Clears highlight when text changes; exports state JSON every render | ✅ Inherits input-handler fix from Step 1 |
| `writeWordHighlightRendering` | Wraps `renderedValue` to color the highlighted word (+ number dimming stub) | ✅ Works on 5-param `m.render(X,H,M,j6,G)` shape |
| `writeWordHighlightRawSequence` | Fallback for terminals that send raw `\x1B[1;7D`/`[1;7C` without modifier flags | ⚠️ Pattern not present in v2.1.110 — skipped with warning (modern dispatcher already maps modifiers) |

### v2.1.110 structural changes

**Old key dispatcher (v2.0.x–v2.0.x):**
```js
function X(Y){switch(!0){case Y.escape:...;case Y.leftArrow:...}}
```
Key object with boolean flags.

**New key dispatcher (v2.1.110):**
```js
function t(O6,k6){switch(O6.key){case"escape":...;case"left":...}}
```
DOM-style event; `O6.key` is a string.

- `O6.ctrl`, `O6.meta`, `O6.alt`, `O6.option` are booleans.
- `Ctrl+Alt+Left` on WSL / Windows Terminal delivers `{key:"left", ctrl:true, meta:true}`.
- Our cases are prepended **before** `switch(O6.key){` (handled before the built-in cases match).
- `t()` is called from `z6(O6)` (the `handleKeyDown` returned by the outer input-handler function):
  ```js
  function z6(O6){
    let k6 = V ? V(O6.key, O6) : O6.key;
    ...
    let Z6 = t(O6, k6);
    if (Z6 === void 0) return;
    if (O6.preventDefault(), !m.equals(Z6)) {
      if (m.text !== Z6.text) K(Z6.text);  // onChange
      B(Z6.offset), m = Z6                 // onOffsetChange + commit
    }
  }
  ```

### Regex anchors

**Key dispatcher anchor** (`findKeyDispatcherLocation`):
```
/function ([$\w]+)\(([$\w]+),([$\w]+)\)\{switch\(\2\.key\)\{case"escape":/
```
Captures function name, event param (`O6`), and resolved-key param (`k6`). Replaces the substring *before* `switch(O6.key){` with our Ctrl+Alt cases + the original `switch` header.

**InputZone `fromText` signature** (for key handler return value):
```
/([$\w]+)=([$\w]+)\.fromText\(([$\w]+),([$\w]+),([$\w]+)\)/
```
Captures `m` (instance), `cK` (class), `q` (text), `P` (columns), `x` (offset). Used to build `cK.fromText(m.text+zwc, P, m.offset)`.

**Escape clear anchor** (`writeWordHighlightClearOnEscape`) — **CRITICAL FIX**:
```
/case"escape":if\([$\w]+\)return;return [$\w]+\(\),[$\w]+;/
```
A bare `/case"escape":/` also matches an **earlier ANSI-sequence parser state machine** (used to decode terminal input bytes). Every Ctrl+Alt+Arrow keystroke transits that parser state, clobbering `_hlState` between presses → "goes back to the first word only" symptom. The full-branch anchor is unique.

### InputZone class shape (for the invisible-char re-render mechanism)

```js
class cK {
  measuredText;  // Aw4 instance (NOT a string)
  selection;
  offset;
  constructor(q, K=0, _=0) { this.measuredText = q; /* ... */ }
  static fromText(q, K, _=0, z=0) { return new cK(new Aw4(q, K-1), _, z) }
  get text() { return this.measuredText.text }  // Aw4.text, raw (incl. ZWCs)
  equals(q) { return this.offset === q.offset && this.measuredText === q.measuredText }
}
class Aw4 { constructor(q, K) { this.text = q.normalize("NFC") } }
```

`equals` compares `measuredText` **by reference** (Aw4 instance identity). Each `fromText` call creates a *new* Aw4, so `equals` returns `false` → `z6` calls `K(Z6.text)` + `B(Z6.offset)` + `m=Z6` → React re-render happens. This is what makes each keypress trigger a real re-render even though the visible text is identical (zero-width chars don't widen the line).

### Key handler logic

State machine (`_hlState`):
```ts
{ active: boolean, index: number|null, wordIndex: number|null, text: string }
```

- **First Left press** (state inactive): `active=true`, `index=0`, `wordIndex = lastNavigableIdx`.
- **Subsequent Left**: `index++` if not at leftmost; `wordIndex = targetIdx[len-1-index]`.
- **First Right press** (state inactive): same as first Left (starts at rightmost).
- **Subsequent Right**: `index--` if `>0`; at 0 → deactivate (`_hlState={active:false,...}`).

**Navigation filter fallback** — cue/all-words resolution (needed because Step 3 hasn't landed yet):
```js
var _targetIdx=[];
if(globalThis._isCueControl){
  _allW.forEach(function(w,i){ if(globalThis._isCueControl(w)) _targetIdx.push(i); });
} else {
  _allW.forEach(function(w,i){ _targetIdx.push(i); });
}
if(!_targetIdx.length) _allW.forEach(function(w,i){ _targetIdx.push(i); });
```
When `_isCueControl` is undefined (Step 3 pending), all words become navigable. Final `if(!_targetIdx.length)` guard is defensive — in Step 3+ it catches the case where cue-matching returns no hits.

**Re-render toggle** — we return `cK.fromText(m.text + zwc, P, m.offset)` where `zwc` alternates between `\u200B` and `\u200C` based on `_parentValue`. This:
1. Makes `Z6.measuredText` a new object → `equals` false → K/B fire → React state update → re-render.
2. The zero-width chars are stripped from `R` at the top of the clear-on-typing IIFE, so downstream code sees clean text.
3. The alternation prevents React bailing on an unchanged-string `setState`.

### Number dimming

Rendering patch injects a dim branch keyed on `globalThis._stepPatterns`. That array is populated by `_reloadCuesConfig` inside `dynamicHighlight`. **Number dimming is dark until Step 3 lands** — this is expected.

### Verification checklist (all confirmed ✅)

1. Type words, Ctrl+Alt+Left → rightmost word turns white.
2. Ctrl+Alt+Left again → previous word; keep pressing → cycles to leftmost and stops.
3. Ctrl+Alt+Right → moves back right; past the rightmost → highlight deactivates.
4. Escape while active → highlight clears, state export `active:false`.
5. Typing while active → highlight clears, state export `active:false`.
6. Multi-line input works across lines.
7. Cursor position is preserved throughout (no cursor jumps from navigation).
8. `/tmp/claude-highlight-state-<pid>.json` updates live: `{active, highlightedWordIndex, highlightedWord, wordCount, ...}`.
9. `/tmp/claude-cursor-state.json` (Step 1) still updates on every keystroke.

### Rollback notes

- Full state is in `src/patches/wordHighlight.ts`. To disable Step 2 without disabling Step 1, comment out the `if (config.settings.misc?.enableWordHighlight)` block in `src/patches/index.ts` and re-run `--apply` — no further cleanup needed.
- Backup of pre-patch `cli.js` is kept by tweakcc; `node dist/index.mjs --restore` brings it back pristine.
- If the escape pattern regresses (upstream changes the branch body), the symptom is: "state resets to inactive between every arrow press"; re-anchor the regex against the new `case"escape":...` branch body in the dispatcher.

**Status: ✅ Done**

---

## Principle for Step 3+

**Each step must be the smallest diff over the previous step that produces a single visible, testable change.** No speculative wiring. No "while we're in here" additions. If a step needs infrastructure (cues-core, hot-reload, LLM), give it its own step first. Bigger steps → harder to debug when verification fails.

Don't pre-plan all the way to the end — decompose the next step only, execute it, verify it, then plan the next. Steps below Step 3 are placeholders to be refined as we get there.

**Why the sizing matters beyond this re-integration:** this step list is the *runbook* for every future Claude Code version bump. When v2.1.111 (or v2.2.x) changes upstream internals, re-running Steps 1-N one at a time is how we localise the break — whichever step's regex/anchor stops matching is the one needing a fix. If a step bundles three changes, a failure forces us to untangle which of the three broke. So calibrate step size to "one anchor, one behavioural change, one test" — that's the unit we can re-verify against any version without guesswork.

---

## Step 3 — Bare numbers dim in the input

**Goal:** When the user types `abc 42 xyz`, the `42` renders in dark gray while everything else renders normally. That is the only behavioural change over Step 2.

**Why this choice:** Step 2 already injected a `_numRanges`/dim code path in the renderer, but it reads `globalThis._stepPatterns` — which is empty without the cues-core IIFE. The simplest testable Step 3 is to swap that read for a hardcoded bare-number regex. No cues-core load, no config parsing, no `_reloadCuesConfig`, no `_isCueControl`. Just one-line swap in `wordHighlight.ts`.

**Exact change (single line, `wordHighlight.ts` ~line 1095):**

```diff
- else if((globalThis._stepPatterns||[]).some(function(s){return s.re.test(_w);})){_numRanges.push({start:_wStart,end:_wStart+_w.length});}
+ else if(/^-?\d+(\.\d+)?$/.test(_w)){_numRanges.push({start:_wStart,end:_wStart+_w.length});}
```

**Not in scope for Step 3** (each will be its own step later):
- Loading cues-core.
- Populating `_localCueMap` / `_cueControlOverrides` / `_isCueControl` / `_stepPatterns`.
- Cue-control navigation filter (all words remain navigable, as in Step 2).
- `_reloadCuesConfig`, folder-config discovery, hot-reload.
- LLM triggers, cycling, rendering wrap, clear-on-change.

**Verification:**
1. Type `abc 42 xyz` in a fresh `claude-cues` session. `42` dims; `abc`/`xyz` render normally.
2. Also try `3.14`, `-7`, `0`, `42.0` — all dim.
3. `hello42` stays normal (regex is anchored, not substring).
4. No regression on Step 1 (cursor JSON) or Step 2 (Ctrl+Alt navigation, Escape clear, typing clear).

**Rollback:** Revert the one line in `wordHighlight.ts` to read `_stepPatterns`. No other files touched.

**Gotchas found during this step:**

1. **Template-literal backslash eats regex escapes.** The regex lives in a TypeScript template literal (`` ` ``) inside `wordHighlight.ts`. Single-escape (`\d`, `\.`) gets consumed by the template parser and lands in `cli.js` as bare `d` — matches nothing, silent failure. Source must be double-escaped: `\\d`, `\\.`. Applies to any regex injected into `cli.js` through a template literal — worth checking Steps 1 and 2 if they ever regress.

2. **The dim render slot was already wired at Step 2.** `_numRanges.push(...)` lives in `wordHighlight.ts`'s renderer from Step 2 onwards, gated behind a read of `globalThis._stepPatterns`. Step 3 did NOT add a new render branch — it just swapped the condition that feeds `_numRanges`. Useful to remember: when "Step 2 works but nothing dims" is the symptom, it's because `_stepPatterns` is empty (the feed), not because the renderer is missing the dim path (the slot).

3. **The original `controls/numbers/cue.md` uses `stepSuffixes: f`, NOT a bare-integer pattern.** Generated regex is `^-?\d+(\.\d+)?f$` — matches `42f`, not `42`. This means a future step that replaces the hardcoded regex with a live `_stepPatterns` read (candidate Step 7 below) will **regress bare-number dimming** unless:
   - The user adds `stepPattern: ^-?\d+(\.\d+)?$` to some control, OR
   - Step 7 keeps both code paths (hardcoded number regex + `_stepPatterns` lookup), OR
   - We explicitly accept the regression (bare numbers stop dimming; only `42f`-style step-suffix words dim).
   Decide which before executing Step 7.

**Status: ✅ Done** (verified 2026-04-16: bare numbers dim, Steps 1-2 not regressed)

---

## Step 4+ — TBD

Deferred decomposition. Candidate next-step options, in rough order of size:

- **Load cues-core + populate `_localCueMap` only** (no reload fn, no overrides) — just enough to confirm cues-core loads cleanly on v2.1.110.
- **Static `_cueControlOverrides` + `_isCueControl`** — hardcoded from the tweakcc config block; enables the navigation filter.
- **Parse `controls.md` / `cues.md` / `blanks.md` on startup** — one pass, no hot-reload, no folder discovery.
- **Folder-config discovery** (controls/, cues/, blanks/ subdirs).
- **`_reloadCuesConfig` hot-reload** on keystroke.
- **Replace hardcoded number regex with `_stepPatterns` read** once `_stepPatterns` is populated by the above.
- **Auto-submit debounce**.
- **LLM trigger → `_dynDefs`**.
- **Ctrl+Alt+Up/Down cycling**.
- **Dynamic render wrap** (tip dim, alt substitution, spans).
- **Clear-on-change**.

Pick one after Step 3 is verified.

---

## Build + Apply Command (reference)

```bash
TWEAKCC=~/opencues/integrations/claude-code/tweakcc
cd $TWEAKCC && npm run build
CLI_JS=$(find ~/local-claude-code -name "cli.js" | head -1)
TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node $TWEAKCC/dist/index.mjs --apply
```

After applying, restart `claude-cues` for changes to take effect.
