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

## Step 4 — Navigation filter narrows to cue-control words

**Goal:** When the input contains a cue-control word (e.g. `volume`), `Ctrl+Alt+Left/Right` highlights only that word, skipping normal words. When the input has no cue-control word, navigation behaves exactly as Step 2 (all words navigable).

**Why this choice:** After Step 2, the full filter plumbing is already compiled into `cli.js`:
- `globalThis._cueControlOverrides` populated from the tweakcc config (line 791 of patched `cli.js` — contains `{"volume":{"control":"volume",...}}` by default).
- Navigation filter reads `globalThis._isCueControl` (lines 698, 725, 1019, 1044 of patched `cli.js`).
- Defensive fallback: if `_isCueControl` filters to zero matches, all words become navigable (`if(!_targetIdx.length) ... all words`).

The only missing piece is the function itself. Step 4 adds one line.

**Exact change (single line inside `wordHighlight.ts` `fullCode`, right after `_cueControlOverrides` is set):**

```js
if(!globalThis._isCueControl)globalThis._isCueControl=function(_w){return !!(globalThis._cueControlOverrides||{})[(_w||"").toLowerCase()];};
```

**Not in scope for Step 4:**
- `_stepPatterns` check inside `_isCueControl` (a future step once step-patterns are populated).
- Loading cues-core, parsing `controls.md`, folder discovery, hot-reload.
- Any tip / LLM / rendering behaviour.

**Verification:**
1. Type `raise volume now` + Ctrl+Alt+Left → only `volume` highlights. `raise` and `now` are skipped.
2. Type `the cat sat` + Ctrl+Alt+Left → all three words cycle as before (defensive fallback keeps navigation alive when no cue-control word is present).
3. `/tmp/claude-highlight-state-<pid>.json` `_debug.isCA` flips `true` on `volume`, `false` on non-cue words (check via `_debug` dump).
4. No regression on Steps 1-3 (cursor JSON, navigation, Escape clear, number dim).

**Rollback:** Delete the one line from `wordHighlight.ts`'s `fullCode`. No other files touched.

**Peculiarities found during this step:**

1. **Step 3's dim and Step 4's filter are independent code paths.** A word can dim (via Step 3's hardcoded number regex) without being a cue-control (via Step 4's `_isCueControl`). Test 3 (`abc 42 xyz`) confirms: all three words navigable (`42` is not in overrides → defensive fallback → all words navigable) but `42` still renders dim. This is expected and fine right now, but it means Step 7 (when we eventually swap the dim regex for `_stepPatterns`) will tighten the coupling — "dims" and "is cue-control" will both be driven by the same config. Anticipate the behavioural change.

2. **Defensive `!_targetIdx.length` fallback is load-bearing.** Test 2 (`the cat sat` — no cue-control word present) navigates all three words. That only works because of the fallback in `wordHighlight.ts:464`: `if(!_targetIdx.length) _allW.forEach(...)`. Without it, sentences without any cue-control word would have zero navigable targets. Keep the fallback in every future filter iteration.

3. **Minimal `_isCueControl` is `_cueControlOverrides`-only — does NOT check `_stepPatterns`.** The full IIFE version in `dynamicHighlight.ts` also returns true for words matching any `_stepPatterns`. When a future step populates `_stepPatterns`, this one-liner will need upgrading (otherwise step-pattern words like `42f` won't be recognized as cue-controls even though they dim). Flag this when sizing Step 7 / the cues-core init.

**Status: ✅ Done** (verified 2026-04-16: all three tests pass, no regressions)

---

## Step 5 — Load cues-core at startup, tip-having words are cue-controls

**Goal:** Words present in `~/.claude/claude-code-tips.json` become navigable via the cue-control filter (in addition to the static `_cueControlOverrides` already picked up by Step 4). Other behaviour unchanged.

**Why this choice:** `_isCueControl` is already the central filter consumer (Step 4). Combining "load cues-core + populate `_localCueMap`" with "extend `_isCueControl` to check the map" keeps this to a single anchor (the existing `fullCode` template literal in `writeWordHighlightClearOnTyping`). Separating them would leave the load observable only via a new debug export — not worth the extra edit.

`writeWordHighlightClearOnTyping` already extracts `requireFuncName` (line 570), so `${requireFuncName}` templates in cleanly — no new infra.

**Exact change (two parts, same template literal, `wordHighlight.ts`):**

Insert cues-core load right after `_cueControlOverrides` init:
```js
if(!globalThis._cuesCore){try{
var _ccHome=process.env.HOME||"~";
var _cues=${requireFuncName}(_ccHome+"/.claude/node_modules/cues-core");
var _tipsC=${requireFuncName}("fs").readFileSync(_ccHome+"/.claude/claude-code-tips.json","utf8");
var _td=_cues.parseLocalCueFile(_tipsC);
globalThis._cuesCore=_cues;
globalThis._localCueMap=_cues.buildLookupMap(_td);
}catch(_e){globalThis._cuesCore=null;globalThis._localCueMap=null;}}
```

Upgrade Step 4's `_isCueControl` to check both maps:
```diff
- if(!globalThis._isCueControl)globalThis._isCueControl=function(_w){return !!(globalThis._cueControlOverrides||{})[(_w||"").toLowerCase()];};
+ if(!globalThis._isCueControl)globalThis._isCueControl=function(_w){var _low=(_w||"").toLowerCase();if((globalThis._cueControlOverrides||{})[_low])return true;if(globalThis._localCueMap&&globalThis._localCueMap.has(_low))return true;return false;};
```

**Not in scope for Step 5:**
- `_reloadCuesConfig` / hot-reload / folder-config discovery.
- Parsing `cues.md` / `blanks.md` / `controls.md` from cwd.
- `_stepPatterns` population (bare-number dim still uses hardcoded regex from Step 3).
- LLM triggers, cycling, rendering wrap, clear-on-change.

**Verification:**
1. From a clean restart, type `commit this plan` + Ctrl+Alt+Left → only `commit` and `plan` highlight (both tips in `claude-code-tips.json`); `this` is skipped.
2. Type `raise volume now` (Step 4 test) → `volume` still highlights alone. Static overrides still work.
3. Type `abc 42 xyz` (Step 3 test) → `42` still dims. Number regex still fires.
4. Type `the cat sat` (no tips, no overrides) → all three navigable (defensive fallback).
5. If `~/.claude/node_modules/cues-core` is missing or `claude-code-tips.json` is unreadable, cues-core load silently falls back to null. Step 4 behaviour preserved exactly (static `_cueControlOverrides` path).

**Rollback:** Remove the cues-core load block and revert `_isCueControl` to the Step 4 single-map version. One contiguous edit.

**Peculiarities found during this step:** *None.* All four verification cases passed first try. No regex escapes in the injected code (avoided Step 3's template-literal gotcha), no anchor surprises, no version-specific issues. This suggests the "module-level require func + globalThis IIFE inside `fullCode`" pattern is robust — reuse it for future cues-core-adjacent steps (config parsing, `_reloadCuesConfig`) instead of re-inventing a new anchor in `dynamicHighlight.ts`.

**Status: ✅ Done** (verified 2026-04-16: all four tests pass, no regressions)

---

## Step 6 — Parse cwd `controls.md` on startup

**Goal:** Cue-controls declared in a `controls.md` file at the cwd (e.g. `~/opencues/controls.md`) augment the static `_cueControlOverrides` populated by Step 2. No hot-reload — controls.md is read once at startup.

**Why this choice (and why controls.md before cues.md):** Both files use the same `parseCuesMd` parser and the same merge-into-a-global pattern — mechanically symmetric. Split chosen to keep "one anchor, one test" per the runbook principle. Order swapped from intuition: `controls.md` goes first because the stock file is `{}` → any new entry is visibly additive. `cues.md` has near-100% overlap with `claude-code-tips.json` (128 of 128 words already covered by Step 5), so a clean test requires a contrived unique keyword — defer to Step 7 where the code path is already proven.

**Exact change (appended to Step 5's try body, `wordHighlight.ts` `fullCode`):**

```js
try{
var _rfs=${requireFuncName}("fs");
var _ctrlPath=process.cwd()+"/controls.md";
if(_rfs.existsSync(_ctrlPath)){
var _parsedCtrl=_cues.parseCuesMd(_rfs.readFileSync(_ctrlPath,"utf8"));
if(_parsedCtrl&&_parsedCtrl.controls)Object.assign(globalThis._cueControlOverrides,_parsedCtrl.controls);
}
}catch(_cte){}
```

Inner try/catch so a malformed controls.md doesn't tear down Step 5's already-loaded `_localCueMap`. Uses `Object.assign` into the existing `_cueControlOverrides` — cwd entries override matching static ones, static entries for keys absent from controls.md stay intact.

**Not in scope for Step 6:**
- `cues.md` parsing (Step 7 — needs contrived test word).
- `blanks.md` parsing.
- Folder-config discovery (`controls/`, `cues/`, `blanks/` subdirs).
- Hot-reload — controls.md edits require restart.
- `_stepPatterns` population (even if controls.md declares step-patterns, Step 3's hardcoded number regex still rules dim behaviour).

**Verification (requires a temporary test entry in controls.md):**

From `~/opencues`, edit `controls.md`'s `## Controls` block to add a test keyword — for example:

```json
{
  "duck": {
    "control": "volume",
    "upArgs": ["up", "5"],
    "downArgs": ["down", "5"]
  }
}
```

Restart `claude-cues` (cwd must be `~/opencues`). Then:

1. Type `raise duck now` + Ctrl+Alt+Left → only `duck` highlights. (Step 6 merged the entry into `_cueControlOverrides` → `_isCueControl("duck")` returns true via Step 5's dual-source filter.)
2. Type `raise volume now` → still works (`volume` still in `_cueControlOverrides` from Step 2 static config — `Object.assign` doesn't clobber unrelated keys).
3. Type `commit this plan` → still works (Step 5 tip filter still active — cues-core load + `_localCueMap` untouched).
4. Type `abc 42 xyz` → `42` still dims (Step 3 regex).
5. Revert the test entry to `{}` once verified — keeps the repo clean.

**Rollback:** Remove the inner try block from `wordHighlight.ts`. No other files touched.

**Peculiarities found during this step:**

1. **Statusline shows `control` field as a fallback tip** when the override has no `tip` field. In `wordHighlight.ts:605`: `_caTip=_caOvr.tip||_caOvr.control`. Our test entry `{"duck":{"control":"volume",...}}` had no `tip`, so highlighting `duck` displayed `volume` in the statusline. Not a bug — it's the "keyword delegates to control X" hint. Add `"tip":"<custom text>"` to the override to customize. Worth knowing so future verification runs don't misread this as a mislabel.

2. **`upArgs`/`downArgs` are inert data until cycling lands.** The override schema accepts them and Step 6 correctly merges them in, but no Step so far wires Ctrl+Alt+Up/Down handlers to consume them. User may expect volume to shift when pressing Up/Down on `duck` — it won't. That's Step N (cycling), not a Step 6 regression.

**Status: ✅ Done** (verified 2026-04-16: all four tests pass, no regressions; statusline fallback behaviour documented)

---

## Step 7 — Parse cwd `cues.md` on startup

**Goal:** Tips declared in a `cues.md` file at the cwd augment `_localCueMap` (populated in Step 5 from `~/.claude/claude-code-tips.json`). Cwd entries override tips.json entries on keyword collision.

**Why this choice:** Direct mirror of Step 6's `parseCuesMd` + merge pattern, reusing the same `_rfs`, `_cues`, and outer try block. Validates that the "single parse-and-merge recipe" is reusable across config files — if Step 7 works identically to Step 6, we can apply the same shape to blanks.md (Step 8) and folder-config readers without re-discovery.

**Exact change (appended inside Step 6's try body, before the closing `}catch(_cte){}`):**

```js
var _cuesPath=process.cwd()+"/cues.md";
if(_rfs.existsSync(_cuesPath)){
var _parsedCues=_cues.parseCuesMd(_rfs.readFileSync(_cuesPath,"utf8"));
if(_parsedCues&&_parsedCues.tips){
var _cwdMap=_cues.buildLookupMap(_parsedCues.tips);
_cwdMap.forEach(function(v,k){globalThis._localCueMap.set(k,v);});
}
}
```

`_cwdMap.forEach(..._localCueMap.set)` semantics: cwd tips override tips.json entries for any keyword collision (latest `set` wins).

**Not in scope for Step 7:**
- `blanks.md` parsing (Step 8 candidate).
- Folder-config discovery (`cues/`, `controls/`, `blanks/` subdirs).
- Hot-reload — cues.md edits require restart.
- `ignore:` list from cues.md (not plumbed through filter yet).
- `promptConfig` section from cues.md (LLM-tuning, later).

**Verification (requires a temporary test keyword):**

A unique test entry has been added to `~/opencues/cues.md`:

```json
{
  "id": "step7-test",
  "words": {
    "flurbletest7": {
      "tip": "Temporary Step 7 verification keyword — revert after test",
      "alts": ["flurbletest7"]
    }
  }
}
```

Restart `claude-cues` **from inside `~/opencues`**. Then:

1. Type `raise flurbletest7 now` + Ctrl+Alt+Left → only `flurbletest7` highlights. (Step 7 merged the entry into `_localCueMap` → `_isCueControl("flurbletest7")` returns true via Step 5's dual-source filter.)
2. Type `commit this plan` → `commit` and `plan` still highlight (Step 5 tips.json entries still merged).
3. Type `raise volume now` → `volume` still highlights (Step 2 + Step 6 path untouched).
4. Type `abc 42 xyz` → `42` still dims (Step 3 regex).
5. Revert the `step7-test` block from `cues.md` once verified.

**Rollback:** Remove the appended cues.md block inside the try. No other files touched.

**Peculiarities found during this step:**

1. **Cwd cues.md overrides tips.json on keyword collision.** This is an intentional contract (`Map.set()` last-write-wins, and the cwd load runs after the tips.json load), but it's silent — the user has no warning that a keyword they redefined in cues.md just shadowed a built-in. Document if we add user-facing error/info later. Matters most when debugging "why isn't my tip showing?" — check whether tips.json has a conflicting entry.

2. **Shared inner `}catch(_cte){}` couples controls.md and cues.md failures.** Step 6's controls.md parse and Step 7's cues.md parse sit inside the same outer try body. A malformed controls.md will throw before cues.md is even read — users with both files may see silent cues.md failure if controls.md has a syntax error. Acceptable trade-off for step-size (separate try blocks would mean a bigger diff), but if this bites someone later, the fix is splitting them into independent try blocks at whatever step discovers the symptom.

3. **Step 7 has a hard ordering dependency on Step 5.** The cues.md merge writes into `globalThis._localCueMap` which Step 5 initializes from tips.json. If Step 5's cues-core load fails (module missing, tips.json unreadable), `_localCueMap` is `null` and the Step 7 merge would crash — but the outer catch swallows it, leaving cues.md silently ignored. If we ever want cues.md to load independently of tips.json, Step 7 needs its own `_localCueMap = _localCueMap || new Map()` guard.

**Status: ✅ Done** (verified 2026-04-16: all four tests pass, no regressions; cwd cues.md + tips.json coexist with cwd taking precedence)

---

## Step 8 — Folder-config discovery for `controls/`

**Goal:** Cue-controls defined as individual `controls/<name>/cue.md` files (the folder pattern used throughout `~/opencues/controls/`) augment `_cueControlOverrides`. Only `controls/` is consumed; `cues/` and `blanks/` folders are scanned but their output is ignored until the LLM/blanks steps land.

**Why this choice:** The real cue-controls in the repo (`brightness`, `affirmations`, `numbers`, `stocks`, `weather`, `hackernews`, `prompt`, `answer`, `opencues`, plus folder-version `volume`) are sitting idle — Steps 1-7 only pick up the static tweakcc config plus anything in the mono `controls.md` (which is `{}`). This step unlocks them with no contrived test data.

`discoverFolderConfigs` is a public cues-core API that takes I/O adapter functions and walks `cues/`, `blanks/`, `controls/` subdirs. We provide sync-fs adapters and consume only `.controlOverrides`.

**Exact change (appended inside Step 7's try body, before the closing `}catch(_cte){}`):**

```js
var _rFsAdp={readFile:function(p){try{return _rfs.readFileSync(p,"utf8");}catch(_fe){return null;}},readDir:function(p){try{return _rfs.readdirSync(p,{withFileTypes:true}).map(function(d){return{name:d.name,isDirectory:d.isDirectory()};});}catch(_fe){return null;}}};
var _folderCfgs=_cues.discoverFolderConfigs({basePath:process.cwd(),readFile:_rFsAdp.readFile,readDir:_rFsAdp.readDir});
if(_folderCfgs.controlOverrides)Object.assign(globalThis._cueControlOverrides,_folderCfgs.controlOverrides);
```

`Object.assign` semantics: folder controls override both static tweakcc config AND cwd `controls.md` entries on key collision.

**Not in scope for Step 8:**
- Consuming `_folderCfgs.cuesConfig` (prompt sources for LLM, invisible until LLM step).
- Consuming `_folderCfgs.blanksConfig` (blank-fill config, invisible until blank steps).
- Consuming `_folderCfgs.ignoreWords` (ignore list for navigation filter — no consumer wired yet).
- `_stepPatterns` population (`~/opencues/controls/numbers/cue.md` has `stepSuffixes: f` — Step 8 merges the entry but `_stepPatterns` stays empty until a future step).
- Hot-reload — folder edits require restart.

**Verification (uses real configs in `~/opencues/controls/`, no test data required):**

Restart `claude-cues` from inside `~/opencues`. Then:

1. Type `raise brightness now` + Ctrl+Alt+Left → only `brightness` highlights (from `controls/brightness/cue.md`).
2. Type `say affirmations today` → only `affirmations` highlights (from `controls/affirmations/cue.md`).
3. Type `raise volume now` → `volume` still highlights (folder version overwrites static; functionally equivalent, same control name).
4. Type `commit this plan` → Step 5 tips still navigable.
5. Type `abc 42 xyz` → `42` still dims (Step 3 hardcoded regex, unaffected by folder discovery).

**Rollback:** Remove the three appended lines. No other files touched.

**Peculiarities found during this step:**

1. **Controls with a `script` field fire real shell commands on highlight.** `~/opencues/controls/volume/cue.md` declares `script: ./volume.sh`. When Step 8 merges the volume override into `_cueControlOverrides`, the Step 2 renderer path at `wordHighlight.ts:613` (`execSync("bash "+_caOvr.script+" get",{timeout:2000,...})`) now has a real script to call — so highlighting `volume` queries the live audio level and the statusline shows the current percentage. This was invisible in Steps 6-7 because their test entries had no `script` field. Semantically correct, but worth knowing: **every Ctrl+Alt+Left/Right landing on a script-backed cue-control spawns a bash subprocess** with a 2s timeout. Budget accordingly when writing scripts (fast / cacheable preferred).

2. **Folder discovery overrides static and mono-file `controls.md` entries on key collision.** `Object.assign` order: static (Step 2) → mono controls.md (Step 6) → folder `controls/<name>/cue.md` (Step 8). Last write wins. Functionally harmless when folder-version and static-version agree on the same control (e.g. `volume`), but if a user declares the same key twice with different scripts, the folder version silently clobbers the static one. Document as the resolution rule.

3. **`cues/` and `blanks/` folder scans happen but are discarded.** `discoverFolderConfigs` always walks all three subdirs. We consume only `_folderCfgs.controlOverrides`. This means the cwd still pays the I/O cost of reading every `cues/<name>/cue.md` and (in future) `blanks/<name>/cue.md` at startup — wasted work until LLM/blank steps consume them. Acceptable tradeoff for API simplicity; revisit only if startup time becomes an issue.

4. **Step 3 hardcoded number regex still reigns.** `controls/numbers/cue.md` declares `stepSuffixes: f` (would match `42f`) but `_stepPatterns` remains empty — Step 8 merges the control into `_cueControlOverrides` but doesn't populate step-pattern regexes. Bare `42` dims via Step 3's hardcoded regex; `42f` does NOT dim because no consumer reads the step-suffix metadata yet. Flagged as a deferred feature, not a regression.

**Status: ✅ Done** (verified 2026-04-16: all 5 tests pass, no regressions; volume script fires on highlight as expected from Step 2 plumbing)

---

## Step 9 — Populate `_stepPatterns` and extend the dim renderer

**Goal:** Control definitions with `stepPattern` or `stepSuffixes` (e.g. `controls/numbers/cue.md` → `stepSuffixes: f`) produce runtime regexes. Words matching those regexes dim alongside bare numbers. `42f` visibly dims; bare `42` still dims via the Step 3 hardcoded regex.

**Why this choice:** Smallest additive diff that closes Step 3 gotcha #3. Two edits:
1. After folder discovery, iterate `_cueControlOverrides` and build `_stepPatterns` (lift logic from the old `dynamicHighlight.ts` — proven regex-escape approach).
2. In the renderer's dim branch, OR the step-pattern check alongside the hardcoded bare-number regex.

Both paths coexist — no existing behaviour replaced, so bare numbers don't regress.

**Exact change (two parts):**

Part 1 — append inside Step 7's try body, after the folder-discovery merge:
```js
var _stepPats=[];
Object.values(globalThis._cueControlOverrides||{}).forEach(function(_sc){
if(_sc.stepPattern){try{_stepPats.push({re:new RegExp(_sc.stepPattern),ctrl:_sc});}catch(_spe){}}
if(_sc.stepSuffixes&&_sc.stepSuffixes.length){_sc.stepSuffixes.forEach(function(_sf){var _esc=_sf.replace(/[^a-zA-Z0-9]/g,'\\\\$&');try{_stepPats.push({re:new RegExp('^-?\\\\d+(\\\\.\\\\d+)?'+_esc+'$'),ctrl:_sc});}catch(_spe){}});}
});
globalThis._stepPatterns=_stepPats;
```

Part 2 — extend the renderer's dim branch (`wordHighlight.ts` ~line 1123):
```diff
- else if(/^-?\\d+(\\.\\d+)?$/.test(_w)){_numRanges.push({start:_wStart,end:_wStart+_w.length});}
+ else if(/^-?\\d+(\\.\\d+)?$/.test(_w)||(globalThis._stepPatterns||[]).some(function(s){return s.re.test(_w);})){_numRanges.push({start:_wStart,end:_wStart+_w.length});}
```

**Not in scope for Step 9:**
- Upgrading `_isCueControl` to recognize `_stepPatterns` matches (would make `42f` navigable as cue-control — deferred to future step).
- Cycling (Up/Down) using step metadata.
- Tip display for step-matched words (the status-line path at `wordHighlight.ts:606` already reads `_spsT[i].ctrl.stepTip`, so it'll kick in automatically when such a word is highlighted — but that's an inherited behaviour, not a new feature of this step).

**Verification:** from `~/opencues`, restart `claude-cues` and then:

1. Type `abc 42f xyz` → `42f` dims. (New: stepSuffixes from `controls/numbers/cue.md` registered.)
2. Type `abc 42 xyz` → `42` still dims. (Step 3 hardcoded regex path intact.)
3. Type `abc 3.5f xyz` → `3.5f` dims. (Decimal stepSuffix also matches.)
4. Type `abc 42px xyz` → `42px` does NOT dim. (No `px` suffix declared in any control.)
5. Prior steps unaffected: `commit this plan` (Step 5), `raise brightness now` (Step 8), `raise volume now`, all still work.

**Rollback:** Remove the two changes. No other files touched.

**Peculiarities found during this step:**

1. **Dim path is now dual-sourced.** Both the hardcoded bare-number regex AND `_stepPatterns` matches push into `_numRanges`. If a user later declares a catch-all `stepPattern: ^-?\d+(\.\d+)?$` for a control, bare numbers will match both — harmless (each word only dims once per render), but structurally redundant. If/when we finally retire the hardcoded regex, either add a catch-all stepPattern somewhere or accept that bare numbers need an explicit control declaration.

2. **`_stepPatterns` is snapshot-on-startup.** Population sits inside the `if(!globalThis._cuesCore)` guard, so it only runs once per process. Editing a control's `stepSuffixes` after launch won't take effect until restart. Hot-reload (Step 10 candidate) will need to factor the population into the re-runnable function.

3. **Regex escape pattern proven twice.** The `\\\\d+(\\\\.\\\\d+)?` source-level escape emitted clean `\\d+(\\.\\d+)?` in `cli.js` → correct regex at runtime. Combined with the Step 3 gotcha (template literal eats single backslashes), this confirms the "4 source backslashes for RegExp string args" convention. Reusable for any future injected regex construction.

**Status: ✅ Done** (verified 2026-04-16: all 5 tests pass, no regressions)

---

## Step 10 — `_cycleAlt` for script-backed cue-controls (Ctrl+Alt+Up/Down)

**Goal:** Pressing `Ctrl+Alt+Up`/`Down` on a highlighted cue-control word that has both a `.script` and corresponding `upArgs`/`downArgs` spawns `bash <script> <...args>` as a detached process. On `volume`, audible level change; on `brightness`, the display brightens/dims. Fire-and-forget — no text substitution, no state update beyond clearing the tip cache so the next render fetches fresh state.

**Why this choice:** Step 2 already injected the Ctrl+Alt+Up/Down handler that calls `globalThis._cycleAlt(dir, null, null, null, requireFn)`. The function was simply undefined, so every arrow press no-opped. Defining a minimal `_cycleAlt` completes the loop without touching the key dispatcher.

**Exact change (one function definition appended right after `_isCueControl` in `wordHighlight.ts`'s `fullCode`):**

```js
if(!globalThis._cycleAlt)globalThis._cycleAlt=function(_dir,_a,_b,_c,_req){
if(!globalThis._hlState||!globalThis._hlState.active)return null;
var _wds=(globalThis._hlText||"").split(/\\s+/).filter(function(w){return w;});
var _wi=globalThis._hlState.wordIndex;
if(_wi==null||_wi<0||_wi>=_wds.length)return null;
var _lw=(_wds[_wi]||"").toLowerCase();
var _ovr=(globalThis._cueControlOverrides||{})[_lw];
if(!_ovr||!_ovr.script)return null;
var _args=_dir>0?_ovr.upArgs:_ovr.downArgs;
if(!_args||!_args.length)return null;
if(!globalThis._cueControlTip)globalThis._cueControlTip=_ovr.tip||_ovr.control;
if(!globalThis._cueControlTimers)globalThis._cueControlTimers={};
var _ctrl=_ovr.control;var _script=_ovr.script;var _aargs=_args;
if(globalThis._cueControlTimers[_ctrl])clearTimeout(globalThis._cueControlTimers[_ctrl]);
globalThis._cueControlTimers[_ctrl]=setTimeout(function(){
try{_req("child_process").spawn("bash",[_script].concat(_aargs),{detached:true,stdio:"ignore"}).unref();}catch(_e){}
setTimeout(function(){
try{
if(globalThis._cueControlTipWord==null)return;
var _lt=_req("child_process").execSync("bash "+_script+" get",{timeout:1000,encoding:"utf8"}).trim();
if(_lt){
globalThis._cueControlTip=_lt;
var _ep="/tmp/claude-highlight-state-"+process.pid+".json";
var _fs=_req("fs");
var _ex=JSON.parse(_fs.readFileSync(_ep,"utf8"));
_ex.cueTip=_lt;_ex.timestamp=Date.now();
_fs.writeFileSync(_ep,JSON.stringify(_ex));
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
}
}catch(_e){}
},200);
},50);
return {refresh:true};
};
```

Shape mirrors `dynamicHighlight.ts:284-328` precisely: outer 50ms timer debounces rapid presses (holding Up collapses into a single spawn with final value), inner 200ms timer reads live state post-mutation and writes directly into the highlight-state JSON, then pokes Claude Code's debounced statusline via `_triggerStatusLineRefresh`. Returns `{refresh:true}` immediately so the input never blocks — this is what makes the keypress feel instant.

**Not in scope for Step 10:**
- Step-controls with numeric increment in the input text (`stepSuffixes` / `stepPattern` with `step`).
- List-controls cycling through `stepValues`.
- Read-only controls (`blankReadOnly`, API-backed).
- Tip-alternatives cycling (needs LLM / `_dynDefs`).
- Any control whose `script` is absent or whose `upArgs`/`downArgs` is missing — `_cycleAlt` returns `null` and key handler returns the InputZone unchanged.

**Verification (from `~/opencues` after restart):**

1. Type `raise volume now`, Ctrl+Alt+Left to highlight `volume`. Statusline shows current volume level.
2. Press Ctrl+Alt+Up → audio volume rises 5%, statusline refreshes to new value.
3. Press Ctrl+Alt+Down → audio volume drops 5%.
4. Type `raise brightness now`, highlight `brightness`, Ctrl+Alt+Up/Down → display brightness changes (if `brightness.sh` is wired for the user's platform; no-op otherwise).
5. Type `commit this plan`, highlight `commit`, Ctrl+Alt+Up → nothing happens (no script on tip-backed entries). Filter falls through cleanly; navigation via Left/Right still works.
6. Prior steps unaffected: number dim, cue-control filter, tip filter all intact.

**Rollback:** Remove the `_cycleAlt` definition. No other files touched; Step 2's key handler will resume no-op on Up/Down.

**Peculiarities found during this step (two wrong attempts before the right one):**

1. **First attempt — `spawn({detached:true}).unref()` introduced a silent UX regression.** User caught it: statusline stayed one cycle behind because the renderer's `execSync("get")` fired before the async spawn finished mutating system state. I had reflexively chosen fire-and-forget spawn without checking the old `dynamicHighlight.ts:284-328` design.

2. **Second attempt — `execFileSync` made it WORSE, not better.** I then swapped to sync exec, reasoning "the old version must have been sync." This was also wrong: it blocked the keypress for 370ms+ (volume.sh runtime), so the input itself froze briefly on every Ctrl+Alt+Up. User's feedback ("still slow versus the original") forced me to actually read the old code. The old pattern isn't sync OR detached — it's **immediate return + debounced setTimeout(50ms) + inner setTimeout(200ms) for the live-read**. Keypress never blocks; the status-line update happens on a fast async pipeline.

3. **Third attempt — full mirror of the old pattern.** Debounced setTimeout(50ms) per control name (so holding Up collapses into one spawn), inner setTimeout(200ms) that executes `bash <script> get` synchronously off the event loop, writes into the highlight-state JSON directly, and pokes the debounced statusline. This is what the user remembered as instant UX.

4. **Lesson — for `_cycleAlt` specifically, "sync vs async" is the wrong framing.** The real question was "does the keypress path block or not?" Both async-spawn-only AND sync-exec-only block or fail differently. The old design was carefully three-layer: instant return → debounced spawn → deferred live read. Each layer had a reason. Recognise this pattern family ("input returns now, side effect debounces, read settles later") and copy it wholesale from `dynamicHighlight.ts` when re-integrating any step that runs system-mutation scripts.

5. **Side detour — almost re-invoked `writeStatusLineTriggerExport` redundantly.** I hypothesised Step 2 was missing the trigger export, but `writeWordHighlight` already calls `writeStatusLineTriggerExport(content)` internally at `wordHighlight.ts:1486`. Adding a second invocation produced a doubled `globalThis._triggerStatusLineRefresh=k` assignment in cli.js (harmless — both assign the same value — but wasteful and confusing). Always check what orchestrator functions wrap before adding manual sub-patch calls to `index.ts`.

**Status: ✅ Done** (verified 2026-04-16 after mirroring the old three-layer pattern; volume cycling feels native, matches user's muscle memory; prior steps intact)

---

## Step 11 — `_isCueControl` recognises `_stepPatterns` matches

**Goal:** Words matching a registered step-pattern regex (e.g. `42f` via `controls/numbers/cue.md` `stepSuffixes: f`) filter as cue-controls in Step 4's navigation. Step 9 made them dim; this step makes them navigable alone when the sentence has them.

**Why this choice:** Smallest possible diff (one extra `||` branch in a single function). Closes the gap between "word dims" and "word is a cue-control for filtering purposes" that Step 9 left open intentionally.

**Exact change (one line, `wordHighlight.ts` `fullCode`):**

```diff
- if(!globalThis._isCueControl)globalThis._isCueControl=function(_w){var _low=(_w||"").toLowerCase();if((globalThis._cueControlOverrides||{})[_low])return true;if(globalThis._localCueMap&&globalThis._localCueMap.has(_low))return true;return false;};
+ if(!globalThis._isCueControl)globalThis._isCueControl=function(_w){var _low=(_w||"").toLowerCase();if((globalThis._cueControlOverrides||{})[_low])return true;if(globalThis._localCueMap&&globalThis._localCueMap.has(_low))return true;if((globalThis._stepPatterns||[]).some(function(s){return s.re.test(_w);}))return true;return false;};
```

Order matters for cost, not correctness: cheapest (dict lookups) first, regex array iteration last.

**Not in scope for Step 11:**
- Actually cycling step-pattern-matched words (`_cycleAlt` still returns null for `42f` because there's no override keyed on `"42f"` — the override is keyed on the control name `"numbers"`). That's Step 12.
- Step-control numeric arithmetic / text substitution.
- Catch-all bare-number cue-control (`42` still takes the fallback-all-navigable path, which is fine).

**Verification (from `~/opencues` after restart):**

1. Type `abc 42f xyz` + Ctrl+Alt+Left → only `42f` highlights. (Before this step: all three navigated via the empty-targetIdx fallback.)
2. Type `abc 42f xyz` + Ctrl+Alt+Up on `42f` → nothing happens. `_cycleAlt` bails at `if(!_ovr||!_ovr.script)` because `_cueControlOverrides["42f"]` is undefined. Graceful no-op; cursor and highlight preserved.
3. Prior steps intact: `raise volume now`, `commit this plan`, `abc 42 xyz`, `raise brightness now`.

**Rollback:** Remove the added `||` branch. No other files touched.

**Peculiarities found during this step:** *None* — worked first try. Single regex-array iteration, no template-literal escape issues, no orchestration pitfalls. Confirms the `_isCueControl` function is now the single choke-point for cue-control membership logic; any future source (e.g. `_dynDefs` LLM words) will be added as another conditional branch here.

**Status: ✅ Done** (verified 2026-04-16: all tests pass, no regressions)

---

## Step 12 — Step-control cycling (arithmetic in-place)

**Goal:** Ctrl+Alt+Up/Down on a word that matches a step-pattern regex (e.g. `42f` via `stepSuffixes: f`) applies `step * direction` arithmetic, clamps to `stepMin`/`stepMax`, reformats per `stepFormat`, reattaches the suffix, and splices the new word back into the input text in place. `42f` → `42.5f` → `43f` on repeated Up; stops at `0f` on Down (numbers control's `stepMin: 0`).

**Why this choice:** Closes the loop Step 11 teed up (`42f` is now cue-control-filterable but `_cycleAlt` no-ops on it). Smallest useful cycling extension — pure arithmetic, no subprocess, no debounce needed, mirrors `dynamicHighlight.ts:515-555` precisely.

**Two changes in `wordHighlight.ts` `fullCode`:**

**1. Fix `_stepPatterns` entries to carry `stepSuffix` singular** (Step 9 stored the raw control, which only has `stepSuffixes` plural):

```diff
- _stepPats.push({re:new RegExp('^-?\\\\d+(\\\\.\\\\d+)?'+_esc+'$'),ctrl:_sc});
+ _stepPats.push({re:new RegExp('^-?\\\\d+(\\\\.\\\\d+)?'+_esc+'$'),ctrl:Object.assign({},_sc,{stepSuffix:_sf})});
```

Latent bug from Step 9: the forEach over `stepSuffixes` pushed a fresh regex but shared the single parent ctrl object. Per-entry `stepSuffix` is needed by the cycling branch to strip/reattach the right suffix.

**2. Insert step-pattern branch into `_cycleAlt`, BEFORE the script-branch bail** (`if(!_ovr||!_ovr.script)return null;`):

```js
var _spList=globalThis._stepPatterns||[];
var _stepCtrl=null;
for(var _spi=0;_spi<_spList.length;_spi++){if(_spList[_spi].re.test(_wds[_wi])){_stepCtrl=_spList[_spi].ctrl;break;}}
if(_stepCtrl){
var _stStep=(_stepCtrl.step!=null)?_stepCtrl.step:1;
var _stMin=(_stepCtrl.stepMin!=null)?_stepCtrl.stepMin:null;
var _stMax=(_stepCtrl.stepMax!=null)?_stepCtrl.stepMax:null;
var _stFmt=_stepCtrl.stepFormat||null;
var _stSuffix=_stepCtrl.stepSuffix||"";
var _curWord=_wds[_wi];
var _stRaw=(_stSuffix&&_curWord.endsWith(_stSuffix))?_curWord.slice(0,-_stSuffix.length):_curWord;
var _stNum=parseFloat(_stRaw);
if(isNaN(_stNum))return null;
var _stResult=_stNum+(_stStep*_dir);
if(_stMin!=null&&_stResult<_stMin)_stResult=_stMin;
if(_stMax!=null&&_stResult>_stMax)_stResult=_stMax;
var _stFormatted=(_stFmt==="integer")?String(Math.round(_stResult)):String(_stResult);
var _stNewWord=_stFormatted+_stSuffix;
var _stText=globalThis._hlText||"";
var _stWordPos=0;
for(var _stWli=0;_stWli<_wi;_stWli++){_stWordPos=_stText.indexOf(_wds[_stWli],_stWordPos)+_wds[_stWli].length;}
var _stWStart=_stText.indexOf(_curWord,_stWordPos);
if(_stWStart<0)return null;
var _stNewText=_stText.slice(0,_stWStart)+_stNewWord+_stText.slice(_stWStart+_curWord.length);
globalThis._hlText=_stNewText;
globalThis._hlState.text=_stNewText;
return {text:_stNewText,wStart:_stWStart,lenDiff:_stNewWord.length-_curWord.length};
}
```

Return shape `{text, wStart, lenDiff}` matches the Step 2 key handler's text-substitution branch at `wordHighlight.ts:521` which reads exactly those fields.

**Not in scope for Step 12:**
- `stepScript` branch (old code supports an external script to compute the next value — no current control uses it).
- List-control cycling (`stepValues` array).
- Alt / LLM / consume-all cycling variants.
- Cursor preservation after substitution for lengths that shift the caret past the word (key handler already handles this via `wStart < offset ? offset+lenDiff : offset`).

**Verification (from `~/opencues` after restart):**

1. `abc 42f xyz`, Ctrl+Alt+Left → `42f` highlights. Ctrl+Alt+Up → `abc 42.5f xyz`. Keep pressing → `43f`, `43.5f`, `44f`…
2. Ctrl+Alt+Down many times → stops at `0f` (`stepMin: 0` clamp).
3. `abc 42 xyz` (bare, no suffix) → `42` dims, Ctrl+Alt+Up no-op (no step pattern without `f`).
4. `raise volume now` → Ctrl+Alt+Up still cycles audio (script branch still reachable — step branch checked first but doesn't match "volume").
5. `commit this plan` → nav still works, Ctrl+Alt+Up no-op.

**Rollback:** Remove the inserted step branch from `_cycleAlt` and revert the `Object.assign(...,{stepSuffix:_sf})` to plain `_sc`. No other files touched.

**Peculiarities found during this step:**

1. **Step 9 had a latent bug.** `_stepPatterns` entries stored the raw control object with `stepSuffixes` (plural array) instead of a per-entry ctrl with `stepSuffix` (singular string). Step 9 worked anyway because only the `.re` field was consumed by the dim renderer. Surfaced now because cycling needs the singular suffix. Fixed in this step via `Object.assign({},_sc,{stepSuffix:_sf})` — same idiom as `dynamicHighlight.ts:158`. General lesson: when lifting proven code, lift the *exact* shape of the stored data, not just the generator expression; seemingly-equivalent simplifications hide latent requirements.

2. **Branch ordering in `_cycleAlt` is load-bearing.** Step pattern check MUST precede `if(!_ovr||!_ovr.script)return null`. Step-pattern-matched words like `42f` are never in `_cueControlOverrides` (only the control name `"numbers"` is), so the script-branch bail would have early-returned before the step branch ran. One-line ordering bug would make the whole step silently no-op.

3. **No debounce needed for arithmetic cycling.** Unlike Step 10's script cycling (50ms debounce to avoid spawn flood on key repeat), arithmetic is pure in-memory — per-keypress firing is cheap. Fast repeat feels snappy on `42f` → `42.5f` → `43f`.

4. **Text-splice walking pattern will recur.** The `_wordPos` accumulator that walks through prior words to find the current word's start index is the same pattern consume-all cycling uses (`dynamicHighlight.ts:572`), and any future alt-swap / LLM-substitution step will need it again. Consider factoring if we add a third copy.

**Status: ✅ Done** (verified 2026-04-16: arithmetic cycling works on `42f`, clamps at stepMin, prior steps intact)

---

## Step 13 — Tip text for `_localCueMap` words in the statusline

**Goal:** When highlighting a word that exists in `claude-code-tips.json` or cwd `cues.md` (e.g. `commit`, `plan`, `debug`, `opus`), the status line shows that word's `cueTip` text. Before this step: `_isCA` was `true` for tip words (Step 5 made them cue-controls), but `_caTip` stayed `null` because the renderer only read tips from `_cueControlOverrides` and `_stepPatterns` — so the status line displayed nothing for half the cue-controls in the system.

**Why this choice:** One-shot bug fix surfaced after ignoreWords (Step 13 attempt #1) was reverted. User confirmed the symptom directly: "it shows nothing" on highlighting `commit`. Three-line edit in the renderer's `_caTip` lookup chain — purely additive, doesn't touch existing override or stepPattern paths.

**Exact change (renderer tip-lookup chain, `wordHighlight.ts` ~line 605):**

```diff
- if(_caOvr){_caTip=_caOvr.tip||_caOvr.control;}
- else{var _spsT=globalThis._stepPatterns||[];for(var _sptI=0;_sptI<_spsT.length;_sptI++){if(_spsT[_sptI].re.test(_hlWords[_idx]||"")){var _stc=_spsT[_sptI].ctrl;if(_stc.stepTip)_caTip=_stc.stepTip;break;}}}
+ if(_caOvr){_caTip=_caOvr.tip||_caOvr.control;}
+ else if(globalThis._localCueMap){var _lcm=globalThis._localCueMap.get(_caWord);if(_lcm&&_lcm.cueTip)_caTip=_lcm.cueTip;}
+ if(!_caTip){var _spsT=globalThis._stepPatterns||[];for(var _sptI=0;_sptI<_spsT.length;_sptI++){if(_spsT[_sptI].re.test(_hlWords[_idx]||"")){var _stc=_spsT[_sptI].ctrl;if(_stc.stepTip)_caTip=_stc.stepTip;break;}}}
```

**Structural note:** the old shape was `if override ELSE stepPattern` — exclusive branches. New shape is `if override; else if localCueMap; if still empty, stepPattern`. The step-pattern check is no longer an `else` of override — it's a final fallback that runs when neither override nor `_localCueMap` produced a tip. This also fixes a latent gap where an override-less step-pattern word couldn't flow into stepTip (previously reached only when overrides were unavailable; still reaches now via the `if(!_caTip)` guard).

**Resolution order** (most specific → least specific):
1. `_cueControlOverrides[word]` → uses `.tip` or falls back to `.control` name.
2. `_localCueMap[word]` → uses `.cueTip`.
3. Any `_stepPatterns` regex matching the word → uses `.ctrl.stepTip`.

Any word in overrides AND localCueMap will display the override tip.

**Not in scope for Step 13:**
- Tip-word *dimming* in the renderer (visual-faded rendering to signal "has alternatives"). Status line only.
- `altCueTips` / alternatives display (needs cycling-alt step + LLM).
- `_localCueMap.speak` flag for TTS.
- `ignoreWords` plumbing (first attempt was invisible-in-current-state; reverted).

**Verification (from `~/opencues` after restart):**

1. `commit this plan` + Ctrl+Alt+Left → `commit` highlights, statusline shows its tip from `claude-code-tips.json`. Next Left → `plan` with a different tip.
2. `raise volume now`, highlight `volume` → statusline still shows live audio level (override path runs first, unchanged).
3. `abc 42f xyz`, highlight `42f` → statusline shows `±0.5f` (stepTip reached via the new `if(!_caTip)` guard).
4. No regression on prior steps (nav, dim, cycling).

**Rollback:** Revert the three renderer lines. No other files touched.

**Peculiarities found during this step:**

1. **Broken fallback chain (latent in Step 2).** The renderer used `if override else stepPattern` — exclusive branches. A tip word from `_localCueMap` would have `_isCA=true` (so `cueControl:true` flagged in the state JSON) but `_caTip=null` (no branch fetched its tip). The status line script checks both — no tip printed. This bug predated this session's re-integration but only became visible once Step 5 populated `_localCueMap`. Step 13 rewires the chain to a three-tier fallback with `if(!_caTip)` guards so adding future sources (LLM `_dynDefs`, span metadata) is one more `if` without restructuring.

2. **Test case "`this` has no tip" was invalid.** I wrote a verification step to highlight `this` and confirm no tip — but `_isCueControl("this")` returns false, so `this` is never navigable in a sentence that contains any cue-control word (Step 4 filter). User caught it ("this cannot be highlighted remember its not in the loop"). Lesson: before writing verification cases for the renderer, mentally run the Step 4 filter — any test subject word must be selectable by Ctrl+Alt+Left/Right in the intended sentence, or the test plan is fiction.

3. **`_ignoreWords` was a failed Step 13 attempt** (reverted in this commit series) — the ignore-list plumbing is invisible in the current re-integration state because none of the baseline `blanks.md ## Ignore` words (`Anthropic`, `Claude`, `OpenCues`, etc.) are in `_localCueMap` or `_cueControlOverrides`, so filtering them changes nothing. Ignore becomes useful only once LLM classification starts suggesting them as alternatives. Defer until LLM lands.

**Status: ✅ Done** (verified 2026-04-16: `commit` shows tip, `volume` still shows live level, `42f` still shows stepTip, no regressions)

---

## Step 14 — TTS speak on tip highlight (`_localCueMap.speak`)

**Goal:** Tip words with `"speak": true` in `claude-code-tips.json` or cwd `cues.md` (today: `ultrathink` and `Tab` via `~/opencues/cues.md`) speak their tip aloud when highlighted, matching the existing behaviour of script-backed controls like `volume`.

**Why this choice:** Small, audible, purely additive. The TTS plumbing (debounce, spawn, cancel-on-deselect, SpeakCtl.exe fallback) was already injected by Step 2's renderer — what's missing is a single branch that checks `_localCueMap.speak` when the word didn't come from `_cueControlOverrides` or `_dynDefs`. User confirmed `volume` already speaks, so the speaker path is working; only the source-of-speak-flag needed widening.

**Exact change (one line expanded to four, `wordHighlight.ts` in the TTS check block):**

```diff
- else if(_hlExport.cueControl){var _ttsCtrl=(globalThis._cueControlOverrides||{})[(_hlExport.highlightedWord||"").toLowerCase()];if(_ttsCtrl&&_ttsCtrl.speak)_ttsShouldSpeak=true;}
+ else if(_hlExport.cueControl){var _ttsLw=(_hlExport.highlightedWord||"").toLowerCase();var _ttsCtrl=(globalThis._cueControlOverrides||{})[_ttsLw];if(_ttsCtrl&&_ttsCtrl.speak){_ttsShouldSpeak=true;}else if(globalThis._localCueMap){var _ttsLcm=globalThis._localCueMap.get(_ttsLw);if(_ttsLcm&&_ttsLcm.speak)_ttsShouldSpeak=true;}}
```

Chain: `_dynDefs[idx].speak` (unwired, LLM step) → `_cueControlOverrides[word].speak` (Step 8 path — volume, brightness) → `_localCueMap[word].speak` (**new**: ultrathink, Tab, plus any cwd cues.md entry with the flag).

**Not in scope for Step 14:**
- Opting out of TTS via `globalThis._openCuesCurrent["voice-mode"]==="inactive"` — the check is in the code but `_openCuesCurrent` is only populated by an `opencues.md` parser we haven't wired. Today `_ttsVoiceOff` is always undefined/false. Opt-out requires wiring that parser (a future step).
- `_dynDefs[idx].speak` — needs LLM.
- TTS on alt-cycle (reading the new alternative aloud) — needs alt cycling.

**Verification (from `~/opencues` after restart):**

1. Type `type ultrathink now`, Ctrl+Alt+Left → highlights `ultrathink`, tip speaks aloud ("Add ultrathink to prompt for max reasoning").
2. `raise volume now`, highlight `volume` → still speaks live audio level (override path unchanged).
3. `commit this plan`, highlight `commit` → silent. `commit` has no `speak: true` flag in tips.json or cues.md. Confirms we're reading the flag, not speaking every tip.
4. No regression on nav / dim / cycling / tip display.

**Rollback:** Revert the one modified TTS-check line. No other files touched.

**Peculiarities found during this step:** *None* — worked first try. Note: the three-source fallback chain (`_dynDefs` → `_cueControlOverrides` → `_localCueMap`) now mirrors the same precedence structure as Step 13's `_caTip` fallback. If we add a fourth source later (e.g. span metadata), both chains need the new branch — candidate for factoring when a fourth slot opens.

**Status: ✅ Done** (verified 2026-04-16: `ultrathink` speaks, `volume` still speaks, `commit` silent)

---

## Step 15 — Parse `opencues.md` frontmatter → `_openCuesCurrent` (voice-mode opt-out)

**Goal:** Setting `voice-mode: inactive` in cwd `opencues.md` silences TTS globally. Setting it back to `active` (or any non-`"inactive"` value) re-enables TTS. The renderer's existing check `globalThis._openCuesCurrent && _openCuesCurrent["voice-mode"]==="inactive"` becomes functional.

**Why this choice:** Small, directly testable opt-out that users can toggle without code. The renderer already reads the flag; we just need to populate it from the config file that's already in the repo (`~/opencues/opencues.md`).

**Exact change** (inline frontmatter parser, appended inside Step 8's try body after `_stepPatterns` population):

```js
var _ocPath=process.cwd()+"/opencues.md";
if(_rfs.existsSync(_ocPath)){
var _ocContent=_rfs.readFileSync(_ocPath,"utf8");
var _ocCurrent={};
var _ocLines=_ocContent.split(/\\r?\\n/);
var _inFm=false;
for(var _oli=0;_oli<_ocLines.length;_oli++){
var _ol=_ocLines[_oli];
var _olT=_ol.trim();
if(_olT==="---"){_inFm=!_inFm;continue;}
if(!_inFm||_ol.charAt(0)===" "||_ol.charAt(0)==="\\t")continue;
var _ci=_olT.indexOf(":");
if(_ci<=0)continue;
var _ocKey=_olT.slice(0,_ci).trim();
var _ocVal=_olT.slice(_ci+1).trim();
if(_ocKey==="settings")break;
_ocCurrent[_ocKey]=_ocVal;
}
globalThis._openCuesCurrent=_ocCurrent;
}
```

Parses only top-level frontmatter `key: value` pairs inside the `---`/`---` delimiters. Bails on `settings:` so the nested settings block is ignored.

**Not in scope for Step 15:**
- Parsing the `settings:` block (`_openCuesSettings`, `_openCuesTips`, `_openCuesSatTips`) — needed for a settings UI that isn't re-integrated.
- Hot-reload — opencues.md edits require restart (same contract as controls.md, cues.md).
- Consumers for other populated keys (`debug-mode`, `tips-mode`, `cursor-navigate`, `output-format`, `display mode`) — no downstream code reads these yet. Defensive wire-up; future steps that need them just read `globalThis._openCuesCurrent[<key>]`.

**Verification (from `~/opencues` after restart):**

1. **Baseline (`voice-mode: active`):** highlight `volume` → speaks live level (Step 14 path).
2. **Flip to `voice-mode: inactive`, restart:** highlight `volume` → silent. Highlight `ultrathink` → silent. Statusline tips still display (Step 13 path unaffected — voice-mode only gates TTS, not tip text). Volume cycling (Ctrl+Alt+Up) still changes audio (script execution unaffected; only the speaker is gated).
3. **Flip back to `active`, restart:** TTS returns for both volume and ultrathink.

**Rollback:** Remove the appended parser block. No other files touched.

**Peculiarities found during this step:** *None.* Worked first try; the `/\\r?\\n/` regex-in-template-literal convention (established Step 9) survived intact. Note: the strict `==="inactive"` check means setting `voice-mode: off` or `voice-mode: disabled` would NOT silence TTS — the documented values (per `opencues.md`'s own `settings:` section) are `active`/`inactive`. Intentional, but worth knowing if a user copies the `debug-mode: off` idiom.

**Status: ✅ Done** (verified 2026-04-16: round-trip active→inactive→active confirmed)

---

## Step 16 — Gate tip display + TTS on `tips-mode: off`

**Goal:** Setting `tips-mode: off` in `opencues.md` suppresses all tip text in the statusline AND silences TTS, regardless of `voice-mode`. Setting it to any other value (`minimal`, `active`, etc.) restores both.

**Why this choice:** Opencues.md had `tips-mode: minimal` declared as if it were a gate, but nothing was reading it. One consumer for a populated-but-unwired `_openCuesCurrent` key from Step 15.

**Exact change — two write sites, both need the gate:**

1. **Renderer (Step 2's cueTip assignment):**
```diff
+ if(globalThis._openCuesCurrent&&globalThis._openCuesCurrent["tips-mode"]==="off")_caTip=null;
  _hlExport.cueTip=_caTip;
```

2. **`_cycleAlt` deferred-read path (Step 10's inner setTimeout):**
```diff
  if(globalThis._cueControlTipWord==null)return;
+ if(globalThis._openCuesCurrent&&globalThis._openCuesCurrent["tips-mode"]==="off")return;
  var _lt=_req("child_process").execSync("bash "+_script+" get",...);
```

**TTS gating for free:** Clearing `_caTip` before `_hlExport.cueTip=_caTip` means TTS (which reads `_hlExport.cueTip` as its gate) falls through silently. No separate TTS edit needed. Same mechanism carries `tips-mode: off` into the cycle path.

**Not in scope for Step 16:**
- Distinguishing `minimal` vs `active` — currently anything not `"off"` passes through. `opencues.md`'s docs suggest `minimal` should filter to "essential" tips; that filtering logic is deferred until we know what "essential" means (probably a tip-level flag like `essential: true`).
- Hot-reload — requires restart (same contract as other opencues.md values).
- Per-category tip gating (overrides vs step patterns vs tips dictionary).

**Verification (round-trip):**

1. Baseline (`tips-mode: minimal`): highlight `commit`/`volume`/`ultrathink` → tips show, TTS speaks where flagged.
2. Flip to `tips-mode: off`, restart:
   - Highlight `commit`/`volume`/`ultrathink` → **no tips, no TTS**.
   - Ctrl+Alt+Up on `volume` → audio still changes, **no tip refresh**. Cycle subprocess still fires; only the display/speak is gated.
3. Flip back to `minimal`, restart → tips + TTS return on both highlight and cycle.

**Rollback:** Remove the two `_caTip=null` / `return` gate lines. No other files touched.

**Peculiarities found during this step:**

1. **Multi-site write pattern.** `_hlExport.cueTip` is written from at least two independent paths — the renderer (Step 2) and `_cycleAlt`'s deferred read (Step 10). A gate at only one site leaks through the other. First-pass implementation gated only the renderer; user caught the leak via cycling volume. Second edit gated `_cycleAlt`. General lesson: before gating any `_hlExport` field, grep for every write-site. Worth factoring `_hlExport.cueTip` writes through a helper when a third source emerges (likely the LLM path).

2. **Renderer gate silences TTS for free.** Clearing `_caTip` before `_hlExport.cueTip=_caTip` means TTS's `if(_hlExport.cueTip...)` guard naturally falls through. No separate TTS edit in the renderer path. Keeps the gate simple.

3. **`minimal` is currently a no-op.** Anything not equal to `"off"` passes through. The opencues.md docs distinguish `active/minimal/off`, but the `minimal` distinction isn't implemented. Documented in "Not in scope" for future refinement.

**Status: ✅ Done** (verified 2026-04-16: tips + TTS gated on `off`, return on `minimal`, cycle path respected via the second gate)

---

## Step 17 — Instantiate `NodeHttpAdapter` on startup (LLM infra prereq)

**Goal:** First sub-step of the LLM pipeline. `globalThis._httpAdapter` is a live `NodeHttpAdapter` (keep-alive, connection pool, provider overrides) after startup. If `GROQ_API_KEY` is set in the env, a warmup GET to `https://api.groq.com/openai/v1/models` fires 1s after startup so the first real request lands on a warm socket.

**Why this choice:** Every subsequent LLM-related step (auto-submit, `CueResolver.resolve()`, `_dynDefs` population) depends on an HTTP client. Splitting the adapter load into its own visible step keeps blame localised when something breaks on a future version (module path changes, constructor signature drift, etc.) — rather than being bundled into the resolver or trigger step.

**Exact change (two parts, `wordHighlight.ts`):**

1. Inside the `if(!globalThis._cuesCore){try{...}}` block, after `_localCueMap` is built:
```js
try{
var _NodeHttpAdapter=${requireFuncName}(_ccHome+"/.claude/node_modules/cues-core/node-http-adapter").NodeHttpAdapter;
globalThis._httpAdapter=new _NodeHttpAdapter({maxSockets:2,timeout:30000,providerOverrides:{}});
if(process.env.GROQ_API_KEY)setTimeout(function(){try{globalThis._httpAdapter.warmup("https://api.groq.com/openai/v1/models",{Authorization:"Bearer "+process.env.GROQ_API_KEY});}catch(_we){}},1000);
}catch(_ha){globalThis._httpAdapter=null;}
```

2. Append `httpAdapterLoaded:!!globalThis._httpAdapter` to the `_hlExport._debug` block so the state JSON makes success/failure observable without instrumenting further.

**Not in scope for Step 17:**
- Instantiating `CueResolver` (next sub-step; needs source configs wired).
- Auto-submit debounce trigger (future).
- Any actual LLM call at analysis time.
- Warmup against non-Groq providers.

**Verification:**

Restart `claude-cues`. Highlight any cue word (`volume` works). Then:

```bash
cat /tmp/claude-highlight-state-<pid>.json | python3 -m json.tool | grep httpAdapter
# Expected: "httpAdapterLoaded": true
```

If `false`, check:
- `~/.claude/node_modules/cues-core/node-http-adapter.js` exists.
- `cues-core/node-http-adapter` exports `NodeHttpAdapter`.
- Constructor accepts `{maxSockets, timeout, providerOverrides}` (signature drift from cues-core updates).

**Rollback:** Remove the two patch locations (the adapter `try` block + the `httpAdapterLoaded` debug field). No other files touched.

**Peculiarities found during this step:** *None.* Worked first try (user confirmed `httpAdapterLoaded: true` via state JSON). Note: silent-failure-with-null fallback is intentional for Steps 18+ — they'll need to guard on `if(globalThis._httpAdapter)` before attempting LLM calls.

**Status: ✅ Done** (verified 2026-04-16: state JSON shows `httpAdapterLoaded: true`)

---

## Step 18 — Instantiate `CueResolver` with merged cues/blanks sources

**Goal:** `globalThis._cueResolver` is a live `CueResolver` after startup, populated with sources built from merged cwd + folder-discovered cues.md / blanks.md prompt configs. Step 19+ will call `.resolve()` on it.

**Why this choice:** Second LLM-infra prereq. After Step 17's adapter, the resolver binds it to actual prompt sources via `buildSourcesFromConfig`. Splitting adapter-load (Step 17) and resolver-load (Step 18) keeps blame localised if a future cues-core release drifts on either API.

**Exact change (three sub-edits in `wordHighlight.ts` `fullCode`):**

1. **Capture `_parsedCues` as a named binding** (previously an inline expression) and parse cwd `blanks.md`:
```js
var _parsedCues=null;
if(_rfs.existsSync(_cuesPath)){
  _parsedCues=_cues.parseCuesMd(...);
  if(_parsedCues&&_parsedCues.tips){...tips merge...}
}
var _blanksPath=process.cwd()+"/blanks.md";
var _parsedBlanks=null;
if(_rfs.existsSync(_blanksPath))_parsedBlanks=_cues.parseCuesMd(_rfs.readFileSync(_blanksPath,"utf8"));
```

2. **Merge + build sources + instantiate resolver** at the end of the inner config try (new inner try to isolate resolver errors from config-load errors):
```js
try{
var _mergedDC=_cues.mergeConfigs({cuesConfig:_parsedCues||undefined,blanksConfig:_parsedBlanks||undefined},_folderCfgs);
var _srcs=_cues.buildSourcesFromConfig(_mergedDC.cuesConfig,_mergedDC.blanksConfig,{httpAdapter:globalThis._httpAdapter,endpoint:"https://api.groq.com/openai/v1/chat/completions",apiKey:process.env.GROQ_API_KEY||"",defaultModel:"openai/gpt-oss-120b",controls:globalThis._cueControlOverrides});
globalThis._cueResolver=new _cues.CueResolver(_srcs);
globalThis._cueSourceCount=_srcs.length;
}catch(_re){globalThis._cueResolver=null;globalThis._cueSourceCount=0;}
```

3. **Expose `cueResolverLoaded` + `cueSourceCount` in `_hlExport._debug`** — visible via state JSON without extra instrumentation.

**Source-count expectation: 2.** `buildSourcesFromConfig` combines all word-scope alternatives prompts (grammar, legal, medical, financial from `~/opencues/cues/*/cue.md` + any inline cues.md word prompts) into ONE merged `ConfigSource`, and wraps any blanks sources + classifier into ONE `ClassifiedSourceGroup`. So the steady-state count is 2 for the current repo, not per-folder.

**Not in scope for Step 18:**
- Any actual `.resolve()` call (Step 19 — auto-submit trigger).
- `readControlState` callback for control-bound blanks — requires sync-exec wiring to call `blankScript get`. Deferred until blank-fill step.
- Per-source debug breakdown (`cueSources` list with names/priorities). Opportunity if debugging gets painful.
- Error propagation when `GROQ_API_KEY` is missing. Resolver instantiates fine; calls from Step 19+ will fail loudly via `.resolve()`'s error channel.

**Verification:**

Restart, highlight any cue word, then:
```bash
cat /tmp/claude-highlight-state-<pid>.json | python3 -m json.tool | grep -E "cueResolver|cueSource|httpAdapter"
```
Expected:
- `"httpAdapterLoaded": true`
- `"cueResolverLoaded": true`
- `"cueSourceCount": 2` (user setup) — will differ on other machines per cues/ folder contents.

**Rollback:** Remove the resolver try block + blanks.md parse + debug fields. `_cueResolver` goes undefined; Step 17 still intact.

**Peculiarities found during this step:** *None.* Worked first try (verified `cueResolverLoaded: true, cueSourceCount: 2`). Note the count = 2 is because `buildSourcesFromConfig` combines word-prompts rather than one-per-folder — future debugging that assumes "one source per folder" will be misleading. Document upstream if we refactor the builder.

**Status: ✅ Done** (verified 2026-04-16)

---

## Step 19 — Auto-submit debounce → `_cueResolver.resolve()` → `_dynDefs`

**Goal:** Typing input with ≥2 words triggers an LLM analysis 500ms after the last keystroke. The result populates `globalThis._dynDefs.words` (WordDef[]) which the renderer's existing `_dynDefs` branch already reads (cli.js:1131, gated on `!_isCA && !_cbDw`). Non-cue-control words (the vast majority of everyday text) get cueTip + alts displayed in the statusline.

**Why this choice:** First step where LLM actually fires. Closes the loop from Steps 17 (adapter) + 18 (resolver) + text-change detection (Step 2's clear-on-typing IIFE).

**Exact change (two parts, `wordHighlight.ts` `fullCode`):**

1. **Auto-submit block** inside clear-on-typing IIFE, immediately after `globalThis._hlText=_hlText;`:
```js
if(globalThis._cueResolver&&process.env.GROQ_API_KEY){
var _asText=_hlText;
if(_asText!==globalThis._lastResolvedText){
if(globalThis._autoSubmitTimer)clearTimeout(globalThis._autoSubmitTimer);
globalThis._autoSubmitTimer=setTimeout(function(){
var _asWords=_asText.split(/\\s+/).filter(function(w){return w;});
if(_asWords.length<2)return;
var _gen=(globalThis._resolveGen=(globalThis._resolveGen||0)+1);
globalThis._lastResolvedText=_asText;
globalThis._cueResolver.resolve({text:_asText,words:_asWords,domain:"claude-code"}).then(function(_res){
if(_gen!==globalThis._resolveGen)return;
globalThis._dynDefs={words:globalThis._cuesCore.convertCueResultsToWordDefs(_res.results||[])};
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
}).catch(function(){});
},500);
}
}
```

2. **`dynDefsCount` in `_hlExport._debug`** for observability.

**Gates:**
- `_cueResolver` exists (Step 18).
- `GROQ_API_KEY` env var set.
- Text changed since last resolve (`_lastResolvedText` cache).
- ≥2 words (arbitrary cheap filter).

**Race handling:** `_resolveGen` monotonic counter. The `.then()` callback compares its captured generation to the current global; late responses from earlier text states are discarded.

**Not in scope for Step 19:**
- Showing LLM alts for cue-control words (`commit`, `plan`, `ultrathink`, etc.). The renderer's `_dynDefs` branch is gated on `!_isCA`, so tip words take the `_isCA` branch which sets `alts=[originalWord]`. Merging `_dynDefs` into the `_isCA` branch is a separate step.
- Cycling LLM alts via Ctrl+Alt+Up/Down. `_cycleAlt` only handles cue-control overrides; alt-cycling for `_dynDefs` words is deferred.
- Clear-on-change / staleness invalidation — `_dynDefs` persists until the next successful resolve. If a user edits text mid-response, the renderer shows stale alts briefly until the new resolve completes.
- Cost controls / caching. Every text change within 500ms of the last keystroke fires a fresh Groq request.
- Error surfacing. `.catch(function(){})` swallows everything. Debug via Groq logs or add a `_debug.lastResolveError` field.

**Verification:**

Restart `claude-cues` from `~/opencues`. Confirm `GROQ_API_KEY` is set.

1. Type `the cat sat`. Pause ≥1 second (500ms debounce + LLM round-trip).
2. Ctrl+Alt+Left to enter manual nav. All three words navigate via empty-targetIdx fallback.
3. Land on `cat` → statusline shows `cat (1/N) - <tip>`. Same for `sat`. `the` may show or not depending on whether grammar prompt classifies it as a function word.
4. State JSON: `_debug.dynDefsCount` > 0, `alts` array populated.

User observed statusline `1/N` format for both `cat` and `sat` in ~/opencues on 2026-04-16 — LLM pipeline functional end-to-end.

**Rollback:** Remove the auto-submit block + the `dynDefsCount` debug field. `_dynDefs` stays undefined; renderer `_dynDefs` branch never fires.

**Peculiarities found during this step:** *None.* Worked first try. The generation counter + `.catch(()=>{})` pattern worked as designed — no crash on invalid input, stale responses discarded. Note: the absence of visible cycling/dim for LLM alts is intentional per the "not in scope" list; Step 20 adds renderer wrap.

**Status: ✅ Done** (verified 2026-04-16)

---

## Step 20 — Tip-word cycling end-to-end (JIT injection + cycle + stale invalidation)

**Goal:** Highlighting a tip word (e.g. `commit`, `attribution`, `ultrathink`) shows `(1/N) - <tip>` format in the statusline. Ctrl+Alt+Up/Down cycles through the word's curated tip alternatives in place (text-splicing into the input). All N positions render consistently (no asymmetry between keyword-alts and alt-only-values). Subsequent LLM analysis never overwrites the tip cycle. Editing the text invalidates stale cycle state so the next sentence starts fresh.

**Why this step is big:** The plumbing for tip-word cycling straddles five code paths that all need to stay consistent. Getting any one wrong causes user-visible glitches — we iterated through three wrong intermediate states with user feedback before landing the final shape. Documenting the final state and the traps along the way so future version bumps can skip the wrong paths.

**Final implementation (six intertwined changes in `wordHighlight.ts` `fullCode`):**

**1. Narrow `_isCueControl`** — revert Step 5's over-extension. Tip words (`_localCueMap`) are NOT cue-controls anymore:
```diff
- if((globalThis._cueControlOverrides||{})[_low])return true;if(globalThis._localCueMap&&globalThis._localCueMap.has(_low))return true;if((globalThis._stepPatterns||[]).some(function(s){return s.re.test(_w);}))return true;return false;
+ if((globalThis._cueControlOverrides||{})[_low])return true;if((globalThis._stepPatterns||[]).some(function(s){return s.re.test(_w);}))return true;return false;
```

**2. Navigation filter includes `_localCueMap`** — keeps tip words navigable via Ctrl+Alt+Left/Right even though they're no longer `_isCueControl`:
```diff
- if(globalThis._isCueControl){_allW.forEach(function(w,i){if(globalThis._isCueControl(w))_targetIdx.push(i);});}
- else{_allW.forEach(function(w,i){_targetIdx.push(i);});}
+ _allW.forEach(function(w,i){
+   var _fLw=(w||"").toLowerCase();
+   if(globalThis._isCueControl&&globalThis._isCueControl(w))_targetIdx.push(i);
+   else if(globalThis._localCueMap&&globalThis._localCueMap.has(_fLw))_targetIdx.push(i);
+ });
  if(!_targetIdx.length)_allW.forEach(function(w,i){_targetIdx.push(i);});
```

**3. Eager tip lookup on every keystroke** — populates `_dynDefs.words` with tip entries before the debounce/LLM fires, so highlighting a tip word shows `(1/N)` immediately. Mirrors original dynamicHighlight.ts:1133-1143:
```js
if(globalThis._cuesCore&&globalThis._localCueMap&&globalThis._cuesCore.lookupMultiple){
try{
var _eagerWords=_hlText.split(/\\s+/).filter(function(w){return w;});
var _eagerLookup=globalThis._cuesCore.lookupMultiple(_eagerWords,globalThis._localCueMap,{skipPattern:/^_$/,skipFn:globalThis._isCueControl});
if(_eagerLookup.found.length>0){
if(!globalThis._dynDefs)globalThis._dynDefs={words:[]};
globalThis._dynDefs.words=globalThis._cuesCore.mergeWordDefs(globalThis._dynDefs.words,_eagerLookup.found);
}
}catch(_eleE){}
}
```

**4. Clear-on-change invalidation** — when text changes, per-position check: if new word is in old alts → valid cycle (update index); else → clear alts. Positions past new length also cleared. Runs BEFORE eager lookup so stale entries are wiped first. Mirrors original writeDynamicClearOnChange:
```js
if(_hlText!==_oldText&&globalThis._dynDefs&&globalThis._dynDefs.words){
var _cocOld=_oldText.split(/\\s+/).filter(function(w){return w;});
var _cocNew=_hlText.split(/\\s+/).filter(function(w){return w;});
var _cocMin=Math.min(_cocOld.length,_cocNew.length);
for(var _cwi=0;_cwi<_cocMin;_cwi++){
if(_cocOld[_cwi]!==_cocNew[_cwi]){
var _cdef=globalThis._dynDefs.words.find(function(d){return d.index===_cwi;});
if(_cdef){
if(_cdef.alts&&_cdef.alts.indexOf(_cocNew[_cwi])>=0){_cdef.word=_cocNew[_cwi];_cdef.currentAltIndex=_cdef.alts.indexOf(_cocNew[_cwi]);}
else{_cdef.word=_cocNew[_cwi];_cdef.alts=null;_cdef.currentAltIndex=0;_cdef.cueTip=null;_cdef.altCueTips=null;_cdef.source=null;}
}
}
}
if(_cocNew.length<_cocOld.length){
for(var _cri=_cocNew.length;_cri<_cocOld.length;_cri++){
var _crdef=globalThis._dynDefs.words.find(function(d){return d.index===_cri;});
if(_crdef){_crdef.alts=null;_crdef.currentAltIndex=0;_crdef.cueTip=null;_crdef.altCueTips=null;_crdef.source=null;}
}
}
}
```

**5. `_cycleAlt` tip-alt branch** — when cycling a word with a `_localCueMap` entry (and no script-backed override), overrides `_dWord` with tip data and cycles through `_tipR.alternatives` with wrap-around modulo. Text-splice the result into `_hlText`:
```js
if(globalThis._localCueMap&&!(_ovr&&_ovr.script)){
var _dyn=globalThis._dynDefs=globalThis._dynDefs||{words:[]};
var _dWord=_dyn.words.find(function(w){return w.index===_wi;});
var _tipR=globalThis._localCueMap.get(_lw);
if(_tipR&&_tipR.alternatives&&_tipR.alternatives.length>1){
if(_dWord&&_dWord.source==="tips"){}
else if(_dWord){_dWord.alts=_tipR.alternatives;_dWord.cueTip=_tipR.cueTip;_dWord.altCueTips=_tipR.altCueTips;_dWord.speak=_tipR.speak||false;_dWord.source="tips";_dWord.currentAltIndex=0;}
else{var _tipDef={index:_wi,word:_wds[_wi],alts:_tipR.alternatives,cueTip:_tipR.cueTip,altCueTips:_tipR.altCueTips,speak:_tipR.speak||false,source:"tips",currentAltIndex:0};_dyn.words.push(_tipDef);_dWord=_tipDef;}
}
if(_dWord&&_dWord.alts&&_dWord.alts.length>1){
var _curA=typeof _dWord.currentAltIndex==="number"?_dWord.currentAltIndex:0;
var _nextA=(_curA+_dir+_dWord.alts.length)%_dWord.alts.length;
_dWord.currentAltIndex=_nextA;
var _newWord=_dWord.alts[_nextA];
if(_newWord==null)return null;
var _taText=globalThis._hlText||"";
var _taCurWord=_wds[_wi];
var _taWordPos=0;
for(var _tawi=0;_tawi<_wi;_tawi++){_taWordPos=_taText.indexOf(_wds[_tawi],_taWordPos)+_wds[_tawi].length;}
var _taWStart=_taText.indexOf(_taCurWord,_taWordPos);
if(_taWStart<0)return null;
var _taNewText=_taText.slice(0,_taWStart)+_newWord+_taText.slice(_taWStart+_taCurWord.length);
globalThis._hlText=_taNewText;
globalThis._hlState.text=_taNewText;
globalThis._lastResolvedText=_taNewText;
return {text:_taNewText,wStart:_taWStart,lenDiff:_newWord.length-_taCurWord.length};
}
}
```

Inserted BEFORE the `if(!_ovr||!_ovr.script)return null;` bail so tip words (which have no script override) don't early-return.

**6. Step 19 LLM merge uses `mergeWordDefs` gap-fill** (not replacement) — preserves tip-source entries across subsequent LLM runs:
```diff
- globalThis._dynDefs={words:globalThis._cuesCore.convertCueResultsToWordDefs(_res.results||[])};
+ var _newDefs=globalThis._cuesCore.convertCueResultsToWordDefs(_res.results||[]);
+ if(!globalThis._dynDefs)globalThis._dynDefs={words:[]};
+ globalThis._dynDefs.words=globalThis._cuesCore.mergeWordDefs(globalThis._dynDefs.words,_newDefs);
```

**Also applied to Step 12 (arithmetic cycle):** added `globalThis._lastResolvedText=_stNewText;` after text-splice to prevent LLM re-firing on step-control arithmetic cycles.

**Verification matrix:**

- `commit this plan`: `commit`/`attribution`/`co-authored` all show `(N/3) - <tip>` consistently.
- Cycle from `commit` through its 3 alts: stays on curated list, never shows LLM words.
- After cycling, no new LLM request fires (`_lastResolvedText` kept current).
- Clear input, retype `the cat sat`: each word navigates to its own LLM-populated alts (or none if LLM declined). `the` does NOT inherit `commit`'s alts.
- `raise volume now`: `volume` still shows live audio level (script-override path unaffected; `_isCueControl` still true for volume).
- `abc 42f xyz`: `42f` still cycles numeric (step-pattern path unaffected).

**Peculiarities found during this step (iteration log):**

1. **Step 5 was too broad.** I originally made `_isCueControl` return true for `_localCueMap` words. Consequence: tip words went through the `_isCA` renderer branch which unconditionally sets `alts=[word]` and `cueControl:true`. Statusline showed just the tip (no `(N/N)`) for tip-keywords but showed `(N/N)` for alt-only-values like `co-authored` that weren't in the map. User caught the asymmetry: "one of the words in commit had a (3/3) on co-authored in the tips [but the other bits don't]". Fix: narrow `_isCueControl` back to overrides + stepPatterns only. Tip words go through `_dynDefs` branch for consistent `(N/N)` display.

2. **Mirror-the-baseline rule applied twice.** First wrong attempt: I proposed overlaying `_dynDefs` INTO the `_isCA` branch (displaying `(1/N)` for cue-controls). User asked "is that how it works on the original" — checking `418066f`'s code showed the original kept `_isCA` asymmetric (just static tip). Saved a detour. Second wrong attempt: I used `_dynDefs={words: newDefs}` replacement in Step 19; the original used `mergeWordDefs` gap-fill. Switched to gap-fill so tip-source entries survive LLM updates.

3. **Stale `_dynDefs` across text changes.** Initial implementation invalidated nothing. User reported: "those positions are persisting when I have 'the cat sat' 'the' has alternatives from commit". The `_dynDefs.words` array is keyed by position, not content; stale entries survive text edits. Fix: per-position clear-on-change that checks "is the new word in the old alts?" — yes → valid cycle; no → clear.

4. **LLM re-fired on every cycle.** Text-splice changed `_hlText`; clear-on-typing saw "new text" and debounced a fresh LLM call. Wasteful. Fix: `_cycleAlt` sets `_lastResolvedText = _taNewText` (and same for Step 12's step-arithmetic cycle) before returning, so the next render sees no change needing analysis.

5. **Tips win over LLM on cycle.** If both LLM and tips populate a word, cycling a tip word should use the curated tip alts (matches original's `mergeWordDefs` gap-fill semantics + user's explicit "stays on local/defined alts not generated ones"). Step 20's `_cycleAlt` branch overrides `_dWord` with `_tipR` data whenever the word is in `_localCueMap` AND not a script-backed override. Resets `currentAltIndex=0` on the override so cycle starts cleanly.

6. **Precedence in `_cycleAlt` must be: step-patterns → tip-alts → script-override bail.** Tip branch goes BEFORE the `if(!_ovr||!_ovr.script)return null;` bail because tip words have no script override; the bail would short-circuit them out. Step-patterns come first because the step branch returns for matches before reaching the tip branch.

**Status: ✅ Done** (verified 2026-04-17: consistent `(N/N)` on all three tip positions; no LLM mixing; no cross-sentence leakage; prior steps unaffected)

---

## Step 21+ — TBD

LLM/blank continuation:

- **`readControlState` wiring** — control-bound blanks can read their live value during auto-populate.
- **Blank-fill (Steps 13-scope from earlier pitch)** — detect `_` placeholder, match nearby keyword, auto-populate. Large; decompose at step time.
- **Factor `_hlExport.cueTip` writes** — still deferred refactor motivated by Step 16's peculiarity.
- **Implement `tips-mode: minimal` filtering** — design first.
- **Dynamic render wrap** — tip-word fade / visual hint that a word has alternatives.

Pick one after Step 20 is verified.

---

## Build + Apply Command (reference)

```bash
TWEAKCC=~/opencues/integrations/claude-code/tweakcc
cd $TWEAKCC && npm run build
CLI_JS=$(find ~/local-claude-code -name "cli.js" | head -1)
TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node $TWEAKCC/dist/index.mjs --apply
```

After applying, restart `claude-cues` for changes to take effect.
