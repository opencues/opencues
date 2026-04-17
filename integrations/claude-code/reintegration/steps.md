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

## Step 3 — *REMOVED* (reverted 2026-04-17)

Step 3 originally added a hardcoded bare-number dim regex (`^-?\d+(\.\d+)?$`) to the renderer. Reverted during Step 21 because bare numbers dimmed unconditionally but were NOT navigable via Ctrl+Alt (`_isCueControl` false, nav filter skipped them). Dim-without-selectability was confusing.

**Resolution:** behaviour is now fully config-driven, matching the original. A user who wants bare-number dim + nav + cycle adds `stepPattern: ^-?\d+(\.\d+)?$` to a control (e.g. `~/opencues/controls/numbers/cue.md`). Step 9's `_stepPatterns` population picks it up and all three behaviours fire consistently.

Step numbers ≥ 4 are kept as-is to preserve commit-message alignment with history. Any later step text that reads "42 still dims (Step 3 regex)" is historically accurate but no longer live — the reference is stale after this revert.

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

## Step 21 — Visual dim consistency (cue-controls, tips, LLM) + Step 3 revert

**Goal:** Words with alternatives render dim in the input as a visual hint that Ctrl+Alt+Left/Right can select them and Ctrl+Alt+Up/Down can cycle. Dim set covers: cue-control overrides, step-pattern matches, tip-dictionary entries, LLM-populated `_dynDefs` entries. Nav filter aligned with dim so every dimmed word is selectable.

**Why this step:** After Step 20 the data was all live (tips cycle, LLM returns alts, overrides fire scripts) but nothing signaled visually which words were actionable. User had to guess. Mirrors the original `writeDynamicRendering` logic (dynamicHighlight.ts:1380-1381) minus the span/blank branches that aren't re-integrated yet.

**Exact changes (two parts, `wordHighlight.ts`):**

1. **Renderer dim branch** — extend the `_numRanges` OR-chain to include cue-controls, tip-map words (except when highlighted), and LLM-alt words (except when highlighted):

```js
else if((globalThis._stepPatterns||[]).some(function(s){return s.re.test(_w);})||(globalThis._cueControlOverrides||{})[_w.toLowerCase()]||(_ni!==_hlWordIdx&&globalThis._localCueMap&&globalThis._localCueMap.has(_w.toLowerCase()))||(_ni!==_hlWordIdx&&globalThis._dynDefs&&globalThis._dynDefs.words&&globalThis._dynDefs.words.some(function(d){return d.index===_ni&&d.alts&&d.alts.length>1;}))){_numRanges.push({start:_wStart,end:_wStart+_w.length});}
```

The `_ni!==_hlWordIdx` guard prevents visual conflict with the highlight styling on the active word; cue-control overrides get no guard (they always dim, highlight wins later in pipeline).

2. **Nav filter aligned with dim** — extend Step 20's filter to also target `_dynDefs`-alt words, so LLM-discovered navigables are selectable:

```js
_allW.forEach(function(w,i){
  var _fLw=(w||"").toLowerCase();
  if(globalThis._isCueControl&&globalThis._isCueControl(w))_targetIdx.push(i);
  else if(globalThis._localCueMap&&globalThis._localCueMap.has(_fLw))_targetIdx.push(i);
  else if(globalThis._dynDefs&&globalThis._dynDefs.words&&globalThis._dynDefs.words.some(function(d){return d.index===i&&d.alts&&d.alts.length>1;}))_targetIdx.push(i);
});
if(!_targetIdx.length)_allW.forEach(function(w,i){_targetIdx.push(i);});
```

3. **Step 3 revert** — remove the bare-number hardcoded regex (`^-?\\d+(\\.\\d+)?$`) from the renderer OR-chain. Step 3 is now documented as REMOVED (see above).

**Verification:**
- `raise volume now` → `volume` dims (override), highlight switches to white on nav.
- `commit this plan` → `commit`, `plan` dim (tips); `this` normal. Nav selects only dimmed words.
- `the cat sat` (wait ~1s for LLM) → `cat`, `sat` dim if LLM returned alts. Select + cycle.
- `42f xyz xyz` (wait for LLM) → `42f` dims (stepPattern), `xyz` dims (LLM); all three selectable.
- `abc 42 xyz` → `42` no longer dims (Step 3 reverted). Matches its non-selectable state. Consistent.

**Peculiarities found during this step (three iteration loops):**

1. **Dim-without-selectability asymmetry.** First pass only extended the renderer, forgot the nav filter. User caught it: `xyz` dimmed from LLM alts but Ctrl+Alt skipped it. The nav filter was still gated on `_isCueControl || _localCueMap` only. Fix: extend nav filter to also include `_dynDefs`-alt words so every dimmed word is selectable.

2. **Bare-number dim without nav was a Step 3 inheritance.** User noticed `42` dims but can't select. Inherited from Step 3's hardcoded bare-number regex. Original dim was config-driven (only stepPatterns dimmed); Step 3 had added an unconditional regex to give "visual feedback" without requiring config. That turned into the same dim-without-selectability problem. Reverted Step 3 in this step. Users who want bare-number dim + nav + cycle add `stepPattern: ^-?\d+(\.\d+)?$` to a control.

3. **Cue-control dim no-guard is intentional.** `volume` dims even when highlighted, but the highlight styling overrides it later in the render pipeline. The tip-map and `_dynDefs` branches use `_ni !== _hlWordIdx` to prevent the visual conflict; cue-controls don't because the override semantics differ (highlight re-asserts color).

**Status: ✅ Done** (verified 2026-04-17: all dim categories align with nav, Step 3 revert clean)

---

## Step 22 — Debug logging gated on `opencues.md` `debug-mode`

**Goal:** `debug-mode: on` in `opencues.md` opens a file log at `/tmp/claude-cues-debug-<pid>.log` with three categories of entries: startup config summary, auto-submit debounce fires, and LLM result counts. `off` silences writes entirely.

**Why this choice:** Small, observable, and builds on Step 15's `_openCuesCurrent` plumbing. Gives a real runtime trace for diagnosing LLM/cycling issues without instrumenting ad-hoc in future sessions.

**Exact change (four parts, `wordHighlight.ts` `fullCode`):**

1. **`_debugLog` helper** — defined immediately after `_openCuesCurrent` assignment (so the helper exists if the opencues.md parse succeeded):

```js
globalThis._debugLog=function(_dMsg){if(!globalThis._openCuesCurrent||globalThis._openCuesCurrent["debug-mode"]!=="on")return;try{${requireFuncName}("fs").appendFileSync("/tmp/claude-cues-debug-"+process.pid+".log","["+new Date().toISOString()+"] "+_dMsg+"\\n");}catch(_dle){}};
```

2. **Startup log** — after CueResolver instantiation:

```js
if(globalThis._debugLog)globalThis._debugLog("startup: "+Object.keys(globalThis._cueControlOverrides||{}).length+" overrides, "+(globalThis._localCueMap?globalThis._localCueMap.size:0)+" tips, "+(globalThis._stepPatterns||[]).length+" stepPatterns, "+(globalThis._cueSourceCount||0)+" llm sources");
```

3. **Auto-submit log** — inside the debounce timer body:

```js
if(globalThis._debugLog)globalThis._debugLog("autoSubmit ["+_asWords.length+" words]: "+_asText);
```

4. **LLM result / error log** — inside `.then()` / `.catch()`:

```js
if(globalThis._debugLog)globalThis._debugLog("llm result: "+(_res.results||[]).length+" results, "+_newDefs.length+" wordDefs");
// .catch()
if(globalThis._debugLog)globalThis._debugLog("llm error: "+(_lre&&_lre.message||_lre));
```

**Not in scope for Step 22:**
- Cycle-event logs (`_cycleAlt` decisions).
- Blank-fill logs (no blank-fill yet).
- Hot-reload of the flag (restart required — matches opencues.md contract).
- Per-word resolver metrics (`_res.metrics`).
- Rotating / truncating the log file.

**Verification (from `~/opencues`):**

1. Flip `opencues.md` → `debug-mode: on`. Restart.
2. Startup line appears: `[ts] startup: N overrides, M tips, K stepPatterns, L llm sources`.
3. Type `the cat sat`, pause 1s. Two more lines:
   - `[ts] autoSubmit [3 words]: the cat sat`
   - `[ts] llm result: N results, M wordDefs`
4. Flip to `debug-mode: off`. Restart. Typing → no new log entries (file not touched).

**Rollback:** Remove the four call sites and the `_debugLog` helper. No other files touched.

**Peculiarities found during this step:**

1. **Template-literal under-escape crashed the patch.** First attempt used `\"` to wrap `_asText` with quotes in the log message: `"autoSubmit: \""+_asText+"\""`. In a TS template literal, `\"` collapses to `"` (no special meaning inside backticks), producing `"autoSubmit: ""+_asText+""` in `cli.js` — a syntax error where `""` is an empty string with no operator between it and `+_asText`. Claude Code crashed on module load. Fix: drop the quote-wrap, use `"autoSubmit ["+_asWords.length+" words]: "+_asText` format. To escape a literal `"` into cli.js from a template literal, need `\\\"` in source (backslash-backslash-quote) — same four-backslash convention as the regex-in-string issue from Step 9. This is the THIRD template-literal escape trap this re-integration has hit (bare-number regex in Step 3, RegExp string args in Step 9, now string-literal quotes here). Future rule: if it's going inside a JS string literal in cli.js, double-escape every special character in source.

2. **Silent gate is correct.** `_debugLog` exits immediately when `debug-mode !== "on"` — no file handle, no I/O. Measured zero overhead in the off path. Users can leave the helper in place; toggle is cheap.

**Status: ✅ Done** (verified 2026-04-17: startup + autoSubmit + llm-result lines logged; silenced on `off`)

---

## Step 23 — Blank-fill sub-step 1: detect `_` + match `blankKeywords`

**Goal:** Every keystroke scans `_hlText` for `_` positions, and for each, walks backward within `blankProximity` looking for a match against any control's `blankKeywords`. Matches land on `globalThis._blankSlots` as `{index, keyword, controlName, keywordStart, keywordEnd, proximity}`. No auto-populate; pure detection + observability.

**Why this choice:** First sub-step of the blank-fill sequence. Every downstream step (auto-populate with `stepValues[0]`, blank-script fetch, span tracking, cycling, dismiss, clear-keywords) needs a reliable `_blankSlots` feed. Splitting detection out keeps the downstream consumers simple and localises failures to the scanner if a match regresses on a future cues-md schema change.

**Exact change (two parts, `wordHighlight.ts` `fullCode`):**

1. **Blank-slot scanner** — inserted in clear-on-typing IIFE after eager tip lookup, before auto-submit:

```js
var _blankSlots=[];
if(globalThis._cueControlOverrides){
var _bwds=_hlText.split(/\\s+/).filter(function(w){return w;});
for(var _bi=0;_bi<_bwds.length;_bi++){
if(_bwds[_bi]!=="_")continue;
var _bfFound=null;
for(var _bj=_bi-1;_bj>=0&&!_bfFound;_bj--){
var _bOvrKeys=Object.keys(globalThis._cueControlOverrides);
for(var _bok=0;_bok<_bOvrKeys.length&&!_bfFound;_bok++){
var _boc=globalThis._cueControlOverrides[_bOvrKeys[_bok]];
if(!_boc||!_boc.blankKeywords)continue;
var _bprox=_boc.blankProximity;
if(_bprox!=null&&(_bi-_bj-1)>_bprox)continue;
for(var _bki=0;_bki<_boc.blankKeywords.length&&!_bfFound;_bki++){
var _bkw=_boc.blankKeywords[_bki];
var _bkwW=_bkw.split(" ");
var _bkwS=_bj-_bkwW.length+1;
if(_bkwS<0)continue;
var _bMatch=true;
for(var _bmi=0;_bmi<_bkwW.length;_bmi++){
if((_bwds[_bkwS+_bmi]||"").toLowerCase()!==_bkwW[_bmi]){_bMatch=false;break;}
}
if(_bMatch)_bfFound={index:_bi,keyword:_bkw,controlName:_bOvrKeys[_bok],keywordStart:_bkwS,keywordEnd:_bj,proximity:_bi-_bj-1};
}
}
}
if(_bfFound)_blankSlots.push(_bfFound);
}
}
globalThis._blankSlots=_blankSlots;
if(globalThis._debugLog&&_blankSlots.length>0)globalThis._debugLog("blankSlots: "+_blankSlots.length+" detected");
```

2. **`blankSlotsCount` in `_hlExport._debug`** for state-JSON observability.

**Algorithm notes:**
- For each `_`, walk backward word-by-word, checking each position for a possible keyword match.
- Multi-word keywords (e.g. `"improve prompt"`) are checked by splitting the keyword by spaces and matching the `keywordWords.length` preceding words ending at position `_bj`.
- `blankProximity` (number, optional): maximum words between the keyword end and `_`. `undefined` → no limit. `0` → keyword adjacent to `_`. Measured as `_bi - _bj - 1`.
- First-match-wins within a walk; different `_` positions get independent matches.
- Keyword expansions (`rddt` → `Reddit`) NOT honoured in this step — future consumer can apply them during fill.

**Not in scope for Step 23:**
- Auto-populating the blank with any fill value.
- Span tracking (multi-word fill).
- Cycling the filled value.
- `blankDismissible` / `blankClearKeywords` / `blankReadOnly` / `blankAutoPopulate` flags.
- `blankConsumeContext` / `blankConsumeAll` variants.
- Keyword expansions.
- `_isCueControl` / dim treatment for detected blanks (could follow in a later step).

**Verification (all verified 2026-04-17):**

| Input | Expected | Observed |
|---|---|---|
| `affirm _` | 1 (affirmations) | ✅ 1 |
| `improve prompt _` | 1 (prompt, multi-word) | ✅ 1 |
| `the cat _ sat` | 0 (no keyword before `_`) | ✅ 0 |
| `affirm _ improve prompt _` | 2 | ✅ 2 |

**Rollback:** Remove the scanner + the `blankSlotsCount` debug field. `_blankSlots` goes undefined. Any future blank-fill consumers would short-circuit.

**Peculiarities found during this step:** *None.* First try; multi-word keyword detection worked without tweaks. Complexity is O(blanks × words × overrides × keywords × keyword-length) worst case, but in practice it's dozens of operations per keystroke — sub-millisecond.

**Status: ✅ Done** (verified 2026-04-17)

---

## Step 24 — Blank-fill sub-step 2: auto-populate `_` with `stepValues[0]`

**Goal:** When a `_blankSlot` points at a control with `stepValues && blankAutoPopulate !== false`, the `_` gets auto-replaced with `stepValues[0]` in the input text. Visible UX for the first time — type `affirm _` → input becomes `affirm I am strong`.

**Why this choice:** Simplest auto-populate source (array read, no subprocess), establishes the text-splice + input-refresh pattern that subsequent substeps (blankScript, readControlState) will reuse. Only touches list-controls like `affirmations`; script-backed fills (weather, stocks, hackernews, prompt) are untouched.

**Exact change (one block in `wordHighlight.ts` `fullCode`, appended after the blank scanner):**

```js
if(_blankSlots.length>0&&globalThis._forceInputRefresh){
var _apopText=_hlText;
var _apopped=false;
for(var _apsi=_blankSlots.length-1;_apsi>=0;_apsi--){
var _apSlot=_blankSlots[_apsi];
var _apCtrl=(globalThis._cueControlOverrides||{})[_apSlot.controlName];
if(!_apCtrl||_apCtrl.blankAutoPopulate===false)continue;
if(!_apCtrl.stepValues||!_apCtrl.stepValues.length)continue;
var _apFill=_apCtrl.stepValues[0];
var _apWordPos=0;
for(var _apwi=0;_apwi<_apSlot.index;_apwi++){_apWordPos=_apopText.indexOf(_bwds[_apwi],_apWordPos)+_bwds[_apwi].length;}
var _apUPos=_apopText.indexOf("_",_apWordPos);
if(_apUPos<0)continue;
_apopText=_apopText.slice(0,_apUPos)+_apFill+_apopText.slice(_apUPos+1);
_apopped=true;
}
if(_apopped){
globalThis._hlText=_apopText;
if(globalThis._hlState)globalThis._hlState.text=_apopText;
globalThis._lastResolvedText=_apopText;
if(globalThis._debugLog)globalThis._debugLog("autoPopulate: "+_apopText);
globalThis._forceInputRefresh();
}
}
```

**Key mechanics:**
- Right-to-left iteration so earlier splices don't invalidate later positions.
- Position walker finds the `_wordPos` for each blank index, then `indexOf("_", _wordPos)` pinpoints the character offset to splice.
- `_lastResolvedText = _apopText` suppresses LLM re-trigger on the auto-populated text (otherwise the debounce would fire on `affirm I am strong`).
- `_forceInputRefresh()` is Step 2's helper: schedules a 16ms `setTimeout` that calls `onChange(_hlText + ZWC)` → component re-renders with new value. Single-render flicker is imperceptible.
- Once `_` is replaced, next render's scanner finds no `_` at that position → no re-populate. Natural idempotence.

**Not in scope for Step 24:**
- `blankScript get` auto-populate (weather, stocks, hackernews, prompt) — different async pattern.
- Span tracking: multi-word fills like "I am strong" land in the input as 3 separate navigable words. They'll cycle as separate words (via Step 20 tip-cycle or LLM alts) rather than as a single blank. Span tracking + consume-all cycling needed to treat as one unit.
- Cycling filled blanks through `stepValues` (would need JIT-inject into `_dynDefs` similar to Step 20's tip-alt branch).
- `blankDismissible` append `_` as cycle option.
- `blankClearKeywords` strip trigger words on fill.
- `blankReadOnly` (display-only blanks).
- `blankSatellite` / `blankConsumeAll` / `blankConsumeContext`.
- Dismissed-blank tracking (re-typing `_` re-populates indefinitely).
- Keyword expansions (`rddt` → `Reddit`).

**Verification (verified 2026-04-17):**
- `affirm _` → input becomes `affirm I am strong`. ✅
- `improve prompt _` → stays (prompt has `blankScript`, no `stepValues`). ✅
- `reddit stock _` → stays (stocks has `blankScript`). ✅
- `the cat _ sat` → stays (no matching keyword). ✅
- Debug log (with debug-mode: on) shows `autoPopulate: <new text>`.

**Rollback:** Remove the auto-populate block. `_blankSlots` continues to populate for detection but no text mutation.

**Peculiarities found during this step:** *None*. Worked first try. The `_forceInputRefresh` → 16ms onChange mechanism (from Step 2) carried auto-populate without extra plumbing. Right-to-left iteration prevented index-shift bugs that would have surfaced with two blanks.

**Status: ✅ Done** (verified 2026-04-17)

---

## Step 25 — Blank-fill sub-step 3: `blankScript get` async auto-populate

**Goal:** Blanks whose matching control has a `blankScript` (and no `stepValues`) auto-populate by spawning `bash <blankScript> get <keyword>` asynchronously. Script stdout splices into `_` on callback. Unlocks `weather`, `stocks`, `hackernews`, `prompt`, `answer`, plus any future script-backed controls.

**Why this choice:** Closes the "majority of controls" gap — `stepValues` is the minority case (only `affirmations`). Everything else is script-driven. Async pattern is the real unlock; gets us off the pre-defined-list model.

**Exact change (async spawn + callback splice, appended after Step 24's stepValues block):**

```js
if(!globalThis._pendingBlankFills)globalThis._pendingBlankFills={};
for(var _bsi=0;_bsi<_blankSlots.length;_bsi++){
var _bsSlot=_blankSlots[_bsi];
var _bsCtrl=(globalThis._cueControlOverrides||{})[_bsSlot.controlName];
if(!_bsCtrl||_bsCtrl.blankAutoPopulate===false)continue;
if(_bsCtrl.stepValues&&_bsCtrl.stepValues.length)continue;
if(!_bsCtrl.blankScript)continue;
var _bsKey=_hlText+"::"+_bsSlot.index;
if(globalThis._pendingBlankFills[_bsKey])continue;
globalThis._pendingBlankFills[_bsKey]=true;
(function(_slot,_ctrl,_key){
try{${requireFuncName}("child_process").execFile("bash",[_ctrl.blankScript,"get",_slot.keyword],{timeout:8000,encoding:"utf8"},function(_err,_stdout){
delete globalThis._pendingBlankFills[_key];
if(_err)return;
var _out=(_stdout||"").trim();
if(!_out)return;
var _ct=globalThis._hlText||"";
var _cw=_ct.split(/\\s+/).filter(function(w){return w;});
if(_cw[_slot.index]!=="_")return;
var _wp=0;
for(var _wi=0;_wi<_slot.index;_wi++){_wp=_ct.indexOf(_cw[_wi],_wp)+_cw[_wi].length;}
var _up=_ct.indexOf("_",_wp);
if(_up<0)return;
var _nt=_ct.slice(0,_up)+_out+_ct.slice(_up+1);
globalThis._hlText=_nt;
if(globalThis._hlState)globalThis._hlState.text=_nt;
globalThis._lastResolvedText=_nt;
if(globalThis._debugLog)globalThis._debugLog("autoPopulate (script "+_slot.controlName+"): "+_out);
if(globalThis._forceInputRefresh)globalThis._forceInputRefresh();
});}catch(_be){delete globalThis._pendingBlankFills[_key];}
})(_bsSlot,_bsCtrl,_bsKey);
}
```

**Key mechanics:**
- **Async spawn via `execFile`** (not `execSync`) so the render thread never blocks. 8s timeout — more generous than Step 10's 2s cycle timeout because network-backed scripts (weather, stocks) can be slow.
- **Staleness check** (`_cw[_slot.index]!=="_"`): if user edited the blank between spawn and callback, the `_` may have moved or been removed. Skip the splice.
- **Pending dedupe** keyed on `text + index`: each unique (text state, blank position) only spawns once. Resolves on callback delete.
- **Position walker** matches Step 24's stepValues splice: walk through preceding words to accumulate the `_` character offset.
- **`_lastResolvedText` sync + `_forceInputRefresh`** match Step 24's post-splice contract — no LLM re-fire, onChange push to the component.
- **Empty stdout = graceful skip.** Scripts that can't resolve (stocks without `FINNHUB_API_KEY`, stocks with unknown ticker, weather with bad geocoding) exit 0 with no output.

**Verification (all confirmed working 2026-04-17):**
- `weather _` → populates with live forecast from Open-Meteo (no API key).
- `reddit stock _` → populates with live price from Finnhub (needs `FINNHUB_API_KEY`).
- `hn _` → populates with current HackerNews top headline.
- `affirm _` → Step 24 path intact (stepValues check wins before blankScript).
- `the cat _ sat` → no-op.
- Debug log shows `autoPopulate (script <controlName>): <output>` for each fill.

**Not in scope for Step 25:**
- **Context words** passed to script (e.g., `weather in Paris _` → Paris). Currently script gets only `keyword`. Weather falls back to London default.
- **`blankKeywordExpansions`** (`rddt → Reddit` display). Script receives raw keyword; display stays raw.
- **`blankConsumeAll`** / **`blankConsumeContext`** — prompt/answer use different patterns (whole-sentence input, structured output).
- **`blankReadOnly`** enforcement (cycling isn't wired for non-stepValues anyway, so implicit).
- **Span tracking** for multi-word fills.
- **Error surfacing** beyond the silent skip.
- **Cache** — currently re-spawns per unique text state. Could cache by keyword.

**Rollback:** Remove the async spawn block. `blankScript` controls stop auto-populating; stepValues (Step 24) and detection (Step 23) remain.

**Peculiarities found during this step:**

1. **Dedupe-by-text, not by slot identity.** Rapid typing causes multiple concurrent script spawns for the "same semantic blank" across different text snapshots (e.g., `weather _` → `weather _t` → `weather _to`). Each text state spawns its own script; callbacks' staleness checks discard stale results. Acceptable cost for a simple dedupe scheme. A smarter cache would key by `(keyword, controlName)` with result memoization, but that adds complexity and risks returning stale weather/stocks data.

2. **Staleness check is positional only** — `_cw[_slot.index]==="_"` — not keyword-preserving. If user types `weather _` (spawns script), then edits to `sunny _` before the script returns, the callback still sees `_` at position 1 and splices `weather`'s forecast into `sunny`'s slot. Incorrect but rare. Fix: capture `_slot.keyword` and validate the keyword is still present at its position on callback. Deferred; real-world pattern is type-once-wait-for-fill.

3. **Step 25 filled values land as multiple navigable words** — just like Step 24. Weather forecast "15°C Partly cloudy" becomes 3 navigable words. User can Ctrl+Alt navigate them but can't cycle. Same span-tracking gap as Step 24 flagged.

**Status: ✅ Done** (verified 2026-04-17: weather/stocks/hn all populate; stepValues path untouched)

---

## Step 26 — Blank-fill sub-step 4: context words + env vars + `~` path (parity pass)

**Goal:** Bring Step 25's `blankScript get` invocation up to parity with the original `readControlState` in `dynamicHighlight.ts:227`. Adds: context-words arg (non-keyword, non-blank words appended to the script call), environment variables (`CUES_MODEL`, `CUES_API_URL`, `CUES_API_KEY_ENV`, `CUES_ALT_COUNT`, `CUES_INCLUDE_ORIGINAL`, `CUES_PROMPT_<NAME>`), and `~` expansion in the script path.

**Why this choice:** Step 25 shipped with an incomplete script-side contract. LLM-backed controls (prompt improver, answer) need env vars to know which model/API/prompt to use. Weather needs context for non-default locations. Without parity, half the configured controls would silently fall back to defaults or fail. User directly flagged: "This must have parity with the original since its complicated."

**Exact change (inside Step 25's IIFE before `execFile` call):**

1. Build context words by filtering `_bwds`: exclude positions `[_bsSlot.keywordStart.._bsSlot.keywordEnd]` and the blank at `_bsSlot.index`. (Step 26a, already added in Step 25 merge.)

2. `~` expansion: `_bsPath = _ctrl.blankScript.replace(/^~/, $HOME)`.

3. Build `_bsEnv` inheriting `process.env`, then per-control overrides:
```js
var _bsEnv=Object.assign({},process.env);
if(_ctrl.model)_bsEnv.CUES_MODEL=_ctrl.model;
if(_ctrl.apiUrl)_bsEnv.CUES_API_URL=_ctrl.apiUrl;
if(_ctrl.apiKeyEnv)_bsEnv.CUES_API_KEY_ENV=_ctrl.apiKeyEnv;
if(_ctrl.altCount)_bsEnv.CUES_ALT_COUNT=String(_ctrl.altCount);
if(_ctrl.includeOriginal!==undefined)_bsEnv.CUES_INCLUDE_ORIGINAL=String(_ctrl.includeOriginal);
if(_ctrl.prompts){for(var _pk in _ctrl.prompts){_bsEnv["CUES_PROMPT_"+_pk.toUpperCase().replace(/[^A-Z0-9]/g,"_")]=_ctrl.prompts[_pk];}}
```

4. `execFile("bash", [_bsPath, "get", _slot.keyword].concat(_ctx), {timeout:8000, encoding:"utf8", env:_bsEnv}, callback)`.

**Deliberate deviations from the original (each justified):**

- **Async `execFile` (not sync `execFileSync`).** The original calls `readControlState` synchronously inside the resolver's source-query path. My implementation drives blank-fill directly from per-keystroke render, so sync would block the render thread for the script's full duration (up to 6-8s for network-backed scripts). Async + callback-refresh is the right tool for this driving context.

- **Context filter by index range, not by string match.** Original filters `_ctx.filter(w => w!=="_" && w.toLowerCase() !== keyword.toLowerCase())`. Mine excludes `[keywordStart..keywordEnd]` and `index`. For single-word keywords these agree. For **multi-word keywords** (`"reddit stock"`), the original's string filter can't remove the individual `reddit` and `stock` words from context (it compares against the full phrase). Mine removes them correctly. Not matching a bug is deliberate.

**Architectural note:** the original drives blank-fill through the resolver path (`buildSourcesFromConfig` passes `readControlState`; sources use it synchronously when producing alts for blank indices). My Step 25 deviates: spawns directly from the clear-on-typing IIFE. Parity on *script-side contract* (Step 26) was achieved — architectural parity (resolver-driven auto-populate) is a separate deferred refactor, tracked as a future step when `blankConsumeAll` / `blankConsumeContext` need full LLM source machinery.

**Verification:**
- `weather in Paris _` → Paris weather (context words reach geocoding).
- `weather in Tokyo _` → Tokyo weather.
- `weather _` → London default (empty context).
- `reddit stock _` → unchanged (stocks ignores context/env).
- `hn _` → unchanged.
- Prompt/answer controls can now read their `CUES_MODEL` / `CUES_PROMPT_*` — not verified end-to-end in this step (no end-consumer yet; will confirm in a future step when we wire up prompt-improver or answer).

**Rollback:** revert to Step 25's arg construction (drop env vars, path expansion stays or goes — harmless either way).

**Peculiarities found during this step:**

1. **User called out the need for parity explicitly**, which was the right catch. My Step 25 shipped without env vars and without `~` expansion — for weather/stocks/hn those were no-ops, but for prompt-improver and answer (which depend on `CUES_MODEL`, `CUES_PROMPT_classifier`, etc.) the scripts would have silently fallen back to defaults or failed. Lesson: when the original does a lot of setup per-invocation, verify the full setup landed, not just the minimum that makes one script work.

2. **The original's context filter has a latent bug for multi-word keywords.** Since I already had an index-based filter in Step 25, mine is more correct. Mirror-the-baseline has limits — when the baseline has a known wart, don't copy the wart.

**Status: ✅ Done** (verified 2026-04-17: parity on arg construction + env + path expansion; architectural parity deferred)

---

## Step 27 — Blank-fill sub-step 5: `blankClearKeywords` strips matched keyword on fill

**Goal:** When an auto-populated blank's control has `blankClearKeywords: true`, the matched keyword word(s) are removed from the input alongside the fill. Context words (between keyword and blank) are preserved — that's `blankConsumeContext`'s job, a later step.

**Why this choice:** Small, visible UX win. Required for weather/answer/prompt controls to feel clean.

**Two sites updated:**

1. **stepValues path (Step 24):** switched from char-position splice to word-array reconstruction. `_apopClearSet` tracks keyword indices across all slots; final text built by filtering and joining. Cleaner + handles multi-slot cases natively.

2. **blankScript callback path (Step 25):** after the spliced `_nt` is computed, re-split and rebuild dropping keyword positions.

**Verification (confirmed 2026-04-17):**

| Input | blankClearKeywords | Result |
|---|---|---|
| `weather _` | true | `<forecast>` (keyword stripped) |
| `weather in Paris _` | true | `in Paris <forecast>` (keyword stripped, context kept) |
| `affirm _` | false | `affirm I am strong` (no flag; keyword stays) |
| `the cat _ sat` | n/a | no-op |

**Not in scope for Step 27:** `blankConsumeContext`, `blankConsumeAll`, `blankKeywordExpansions`, cycling filled blanks, span tracking.

`improve prompt _` and `answer _` declare `blankClearKeywords: true` but also need `blankConsumeAll` / `blankConsumeContext` to function end-to-end. User flagged explicitly: those controls won't work fully until their consume-mode is implemented.

**Peculiarities found during this step:**

1. **Word-array reconstruction replaced char-position splice.** Original used char-position math with adjacent-whitespace bookkeeping. Word-array (split → modify → join) is cleaner and handles multi-word fills trivially. Deliberate simplification over the original.

2. **Callback-path timing assumes keyword precedes blank.** Step 25's async fill writes to `_hlText`, then we re-split to find keyword positions. If a future step introduces fills that shift preceding words, this assumption breaks. Current configs are all keyword-before-blank.

3. **Semantic nuance: `blankClearKeywords` ≠ `blankConsumeContext`.** The latter also strips words between keyword and blank. Context preservation is per-spec but may look surprising (`weather in Paris _` → `in Paris 15°C`).

**Status: ✅ Done** (verified 2026-04-17)

---

## Step 28 — Blank-fill sub-step 6: `blankKeywordExpansions` display transform

**Goal:** When the user types a short-form keyword (`rddt`, `nvda`, `hn`) and the blank auto-populates, the keyword gets replaced with its configured expansion (`Reddit`, `Nvidia`, `HackerNews`) in the final text. Fill value follows the expansion. Typing `rddt _` → `Reddit $180.50`.

**Why this choice:** Small, visible UX polish. Makes stocks and hackernews outputs readable without requiring users to type the full name.

**Exact change (two sites, `wordHighlight.ts` `fullCode`):**

1. **stepValues path (Step 24):** inside the word-array reconstruction loop, if `_apCtrl.blankKeywordExpansions[_apSlot.keyword]` exists, write the expansion at `_apSlot.keywordStart` and mark subsequent keyword positions as "clear" (collapses multi-word keywords to the single expansion):

```js
if(_apCtrl.blankKeywordExpansions&&_apCtrl.blankKeywordExpansions[_apSlot.keyword]){
_apopWords[_apSlot.keywordStart]=_apCtrl.blankKeywordExpansions[_apSlot.keyword];
for(var _apke=_apSlot.keywordStart+1;_apke<=_apSlot.keywordEnd;_apke++)_apopClearSet[_apke]=true;
}
```

Added before the `blankClearKeywords` clause so that if both are set, expansion is placed first then cleared (matches original behaviour; same net result).

2. **blankScript callback path (Step 25):** after computing spliced `_nt` but before `blankClearKeywords`, re-split and rebuild dropping keyword positions in favour of the expansion:

```js
if(_ctrl.blankKeywordExpansions&&_ctrl.blankKeywordExpansions[_slot.keyword]){
var _ntXW=_nt.split(/\\s+/).filter(function(w){return w;});
var _ntXKept=[];
for(var _ntxi=0;_ntxi<_ntXW.length;_ntxi++){
if(_ntxi===_slot.keywordStart)_ntXKept.push(_ctrl.blankKeywordExpansions[_slot.keyword]);
else if(_ntxi>_slot.keywordStart&&_ntxi<=_slot.keywordEnd)continue;
else _ntXKept.push(_ntXW[_ntxi]);
}
_nt=_ntXKept.join(" ");
}
```

**Lookup semantics:**
- `_slot.keyword` is lowercased at parse time (blankKeywords list is lowercased by cues-md parser).
- `blankKeywordExpansions.<subkey>` keys are also lowercased at parse (cues-md.ts:641).
- So `_ctrl.blankKeywordExpansions[_slot.keyword]` is a direct lowercase→string lookup.
- Expansions are defined PER-SHORTCODE. Multi-word keywords like `reddit stock` have no expansion key (users already typed the readable form).

**Verification (confirmed 2026-04-17):**

| Input | Expansion? | Result |
|---|---|---|
| `rddt _` | rddt → Reddit | `Reddit $<price>` |
| `nvda _` | nvda → Nvidia | `Nvidia $<price>` |
| `hn _` | hn → HackerNews | `HackerNews <headline>` |
| `reddit stock _` | no key | `reddit stock $<price>` (unchanged) |
| `weather _` | no expansion config | `<forecast>` (clearKeywords path alone) |

**Not in scope for Step 28:** blankConsumeContext, blankConsumeAll, cycling filled blanks, span tracking, blankDismissible.

**Peculiarities found during this step:** *None*. Straightforward extension of Step 27's word-array reconstruction. Expansion + clearKeywords compose naturally — if a control had both set, expansion would be placed then cleared (no-op net effect, matches original). No current configs combine them, but the code handles it cleanly.

**Status: ✅ Done** (verified 2026-04-17)

---

## Step 29 — Blank-fill sub-step 7: `blankConsumeContext` widens clear range through context

**Goal:** `blankConsumeContext: true` extends the on-fill clear range from just the keyword words (`blankClearKeywords`) to also include words between the keyword and the blank. Typing `what is the word for happy _` → just `<answer>` (5 keyword words + 1 context word `happy` all stripped).

**Why this choice:** Small, consistent extension of Step 27's range-based clear logic. Makes `answer` control usable. Pattern carries to any future consume-range semantics (like `blankConsumeAll`).

**Exact change (two sites, unified clear-range computation):**

Replaced the `blankClearKeywords`-only branch with a range selector that picks the widest applicable range:

```js
var _clearEnd = null;
if (ctrl.blankConsumeContext) _clearEnd = slot.index - 1;
else if (ctrl.blankClearKeywords) _clearEnd = slot.keywordEnd;
if (_clearEnd !== null) { clear [slot.keywordStart .. _clearEnd] }
```

- `blankConsumeContext` → end at `slot.index - 1` (everything up to but not including the blank).
- `blankClearKeywords` alone → end at `slot.keywordEnd` (just the keyword).
- Neither → no clear.
- If both are set, `blankConsumeContext` wins (wider range subsumes keyword).

Applied to:
- **stepValues path (Step 24):** in the word-array reconstruction loop, `_apopClearSet` gets the wider range.
- **blankScript callback (Step 25):** post-splice word-array rebuild uses the same `_ntCE` selector.

**Verification (confirmed 2026-04-17):**

| Input | Config | Result |
|---|---|---|
| `what is the word for happy _` | answer: `blankConsumeContext`, `blankClearKeywords` | `<answer>` (all 6 words cleared) |
| `how to say happy _` | answer | `<answer>` (3 kw + 1 context stripped) |
| `weather in Paris _` | weather: `blankClearKeywords` only | `in Paris <forecast>` (context preserved) |
| `affirm _` | no clear flags | `affirm I am strong` |
| `rddt _` | stocks: no clear flags, has expansion | `Reddit $<price>` |

**Not in scope for Step 29:**
- `blankConsumeAll` — strips ALL non-blank words. Different range (`0 .. wordCount-1`, excluding blank). Simple extension but has edge cases with multi-word fills affecting "what's after the blank" semantics. Deferred.
- Cycling filled blanks, span tracking, dismissible, resolver-wiring — still on the TBD list.

**Peculiarities found during this step:** *None*. Clean 3-line extension of Step 27's clear-range logic. Worked first try.

**Status: ✅ Done** (verified 2026-04-17)

---

## Step 30 — Blank-fill sub-step 8: `blankConsumeAll` (prompt improver)

**Goal:** Controls with `blankConsumeAll: true` (only `prompt` in the current config) replace the ENTIRE input with the first line of the script's multi-line output. Remaining lines stash in `globalThis._consumeAllAlts` as alternative versions ready for future cycle-through.

**Why this choice:** Unlocks the prompt improver — the last major unimplemented feature of the original. Pipeline ends at "first alt replaces everything." Multi-alt cycling is Step 31+.

**Exact change (blankScript callback path, `wordHighlight.ts`):**

Short-circuit the normal splice-expansion-clear pipeline when `blankConsumeAll` is set:

```js
var _nt;
if(_ctrl.blankConsumeAll){
var _cAlts=_out.split(/\\n/).map(function(s){return s.trim();}).filter(function(s){return s.length>0;});
if(!_cAlts.length)return;
_nt=_cAlts[0];
globalThis._consumeAllAlts=_cAlts.length>1?{index:0,alts:_cAlts,currentAltIndex:0,spanLength:_cAlts[0].split(/\\s+/).filter(function(w){return w;}).length}:null;
}else{
// existing: splice + expansion + clearKeywords/consumeContext
...
}
```

**Key mechanics:**
- **Multi-line parse**: `_out.split(/\n/)` — each line is an alternative. Empty lines discarded. First line becomes the fill; rest stashed.
- **No splice**: fill replaces everything, not just `_`. `_nt` is set directly to the first alt.
- **No expansion / clearKeywords / consumeContext**: those operate on keyword/context ranges, but consume-all already erased everything. Short-circuit skips them.
- **`_consumeAllAlts` stash**: captures `{index:0, alts, currentAltIndex:0, spanLength}`. `index:0` because after consume-all, the fill starts at word 0. `spanLength` = first alt's word count (needed when cycling to multi-word alternatives replaces the correct range).
- **Staleness check unchanged**: if `_cw[_slot.index]!=="_"` at callback time, abort — user edited the blank position mid-LLM-call.

**Prompt improver flow (end-to-end):**
1. User types `improve prompt rewrite this to be more concise _`.
2. Scanner detects blank + matches `improve prompt` keyword → `_blankSlots[0] = {controlName:"prompt", ...}`.
3. Callback spawns `prompt-blank.sh get "improve prompt" <context words>` with env vars set (`CUES_MODEL=openai/gpt-oss-120b`, `CUES_PROMPT_EXTRACT=<from ## Extract>`, `CUES_PROMPT_TRANSFORM=<from ## Transform>`, `CUES_ALT_COUNT=3`, `CUES_INCLUDE_ORIGINAL=true`).
4. Script does two LLM round-trips (extract → transform), outputs 4 lines (3 improved + 1 original).
5. Callback parses, takes line 1 as the new text, stashes the other 3 as `_consumeAllAlts.alts`.
6. `_forceInputRefresh()` pushes to input → user sees the first improved prompt.

**Verification (confirmed 2026-04-17):**
- `improve prompt rewrite this to be more concise _` → first alt replaces everything.
- `enhance prompt write an email to my boss _` → first alt replaces everything.
- `refine prompt summarise this article _` → first alt replaces everything.
- Non-consume-all controls unchanged: `rddt _`, `weather in Paris _`, `what is the word for happy _`, `affirm _`.

**Not in scope for Step 30:**
- **Cycling through `_consumeAllAlts.alts`** — the data is staged but `_cycleAlt` doesn't have a branch for consume-all yet. Coming as Step 31.
- **Dim on consumed range** — while the consume-all span is active, the filled words should render differently (dimmed / marked) to signal "cycleable". Needs the cycling step first to be meaningful.
- **Clear-on-change invalidation** for consume-all state — typing anything after the fill should invalidate `_consumeAllAlts` so it doesn't try to cycle a stale span. Part of the cycling step.
- **Keyword expansion + clearKeywords for consume-all**: skipped because everything's wiped. If a future control combines `blankConsumeAll` with an expansion (odd), the expansion is ignored.

**Peculiarities found during this step:** *None*. The short-circuit structure was clean. Env-var parity from Step 26 paid off — `CUES_PROMPT_EXTRACT`/`_TRANSFORM` landed where prompt-blank.sh expected them without any further wiring.

**Status: ✅ Done** (verified 2026-04-17: prompt improver produces improved versions end-to-end)

---

## Step 31 — Consume-all cycling (prompt improver Ctrl+Alt+Up/Down)

**Goal:** Ctrl+Alt+Up/Down on a word within the consume-all range (positions `_ca.index..index+spanLength-1` after Step 30's fill) cycles through `_consumeAllAlts.alts`. Each press text-splices the consumed range with the next alt's full text, updates `spanLength` to the new alt's word count, and modulos the index for wrap-around.

**Why this choice:** Smallest independent addition that unlocks prompt improver's remaining alternatives. `_consumeAllAlts` already carries its own `spanLength`, so no general span infrastructure needed.

**Exact change (two parts, `wordHighlight.ts` `fullCode`):**

1. **`_cycleAlt` consume-all branch** — inserted BEFORE the step-pattern / tip / script branches so it takes precedence when the highlight is within the consumed range:

```js
if(globalThis._consumeAllAlts){
var _ca=globalThis._consumeAllAlts;
var _caSpanLen=_ca.spanLength||1;
if(_wi>=_ca.index&&_wi<_ca.index+_caSpanLen){
var _caNextIdx=(_ca.currentAltIndex+_dir+_ca.alts.length)%_ca.alts.length;
_ca.currentAltIndex=_caNextIdx;
var _caNewAlt=_ca.alts[_caNextIdx];
if(_caNewAlt==null)return null;
var _caText=globalThis._hlText||"";
var _caWordPos=0;
for(var _cawi=0;_cawi<_ca.index;_cawi++){_caWordPos=_caText.indexOf(_wds[_cawi],_caWordPos)+_wds[_cawi].length;}
var _caSpanStart=_caText.indexOf(_wds[_ca.index],_caWordPos);
if(_caSpanStart<0)return null;
var _caSpanEnd=_caSpanStart;
for(var _casi=0;_casi<_caSpanLen;_casi++){
var _caSpanW=_wds[_ca.index+_casi];
if(_caSpanW==null)break;
var _caSwI=_caText.indexOf(_caSpanW,_caSpanEnd);
if(_caSwI<0)break;
_caSpanEnd=_caSwI+_caSpanW.length;
}
var _caNewText=_caText.slice(0,_caSpanStart)+_caNewAlt+_caText.slice(_caSpanEnd);
_ca.spanLength=_caNewAlt.split(/\\s+/).filter(function(w){return w;}).length;
globalThis._hlText=_caNewText;
if(globalThis._hlState)globalThis._hlState.text=_caNewText;
globalThis._lastResolvedText=_caNewText;
return {text:_caNewText,wStart:_caSpanStart,lenDiff:_caNewAlt.length-(_caSpanEnd-_caSpanStart)};
}
}
```

2. **Invalidation on external edit** — in clear-on-change, null `_consumeAllAlts` when the text changes AND wasn't set by a cycle:

```js
if(_hlText!==_oldText&&globalThis._consumeAllAlts&&_hlText!==globalThis._lastResolvedText){globalThis._consumeAllAlts=null;}
```

**Distinguishing cycle vs. user edit:** cycle-driven text changes set `_lastResolvedText = _caNewText` before returning. If the next render's `_hlText` matches `_lastResolvedText`, it's from a cycle → keep `_consumeAllAlts`. If `_hlText` differs from `_lastResolvedText` (user typed a char, deleted, etc.), invalidate.

**Verification (confirmed 2026-04-17):**
- `improve prompt rewrite this to be more concise _` → first alt fills. Ctrl+Alt+Left (highlight any word in the fill), Ctrl+Alt+Up → swap to second alt. Repeat → third alt, original, first, … (4-way wrap with `includeOriginal: true`).
- Ctrl+Alt+Down reverses.
- Span length correctly updates between alts of different word counts.
- Non-consume-all cycling still works: `volume` Up/Down, `42f` arithmetic, `commit` tip-cycle.
- Typing a character post-cycle invalidates `_consumeAllAlts`; next Ctrl+Alt+Up falls through to normal cycling.

**Not in scope for Step 31:**
- **Dim on consumed range** — would be nice visual feedback ("this whole chunk is a cycleable unit") but requires renderer span marking.
- **"Revert-on-first-edit"** — UX where backspace after fill restores the pre-fill query. Different feature; not in the original config schema.
- **General span tracking** (`_dynSpans`) — needed for stepValues list cycling with multi-word alts and selector/satellite. Deferred.
- **Cycling stepValues (affirmations)** — requires span tracking to cycle `I am strong` → `I am brave` as a 3-word unit.

**Peculiarities found during this step:**

1. **Span-finding loop re-indexes from `_caWordPos`.** The algorithm walks through preceding words to accumulate `_caWordPos`, then `indexOf(firstWordOfSpan, _caWordPos)` pinpoints the span start. Span end is found by walking through `_caSpanLen` words using incremental `indexOf`. Tolerates whitespace variance but assumes words appear in order (safe given they came from the same `_hlText` split).

2. **Invalidation check uses `_lastResolvedText`, not a dedicated sentinel.** `_lastResolvedText` is shared with LLM-suppression logic (Step 19) and cycle-suppression (Steps 12, 20). All paths that mutate text should set it. If we add a future text-mutator that forgets, stale `_consumeAllAlts` could persist — flag for any future cycling branches to remember this invariant.

3. **User clarified the meaning of "invalidation" during testing.** Initial framing implied "delete reverts the whole fill" (UX rollback), but implemented meaning is "stale `_consumeAllAlts` cleared so next cycle doesn't splice into edited text." Both valid interpretations; current implementation is the cleaner / more conservative one. Rollback is a possible future feature.

**Status: ✅ Done** (verified 2026-04-17: cycling works bi-directionally, invalidation triggers on external edit)

---

## Step 32+ — TBD

Cycling + polish continuation:

- **Dim the consumed-range** — visual marker that the fill is cycleable.
- **Cycling filled blanks through `stepValues`** — affirmations. Needs span tracking.
- **General span tracking** (`_dynSpans`) — infrastructure for multi-word cycling, selector/satellite (opencues), clear-on-change robustness.
- **`blankDismissible`** — cycle back to `_`. Needs cycling first.
- **"Revert-on-first-edit"** — UX rollback of prompt fill. Possible Step 32 sub-feature if desired.
- **`readControlState` resolver wiring** — architectural parity.
- **Factor `_hlExport.cueTip` writes** — still deferred.
- **`tips-mode: minimal` filtering** — design first.

Pick one after Step 31 is verified.

---

## Build + Apply Command (reference)

```bash
TWEAKCC=~/opencues/integrations/claude-code/tweakcc
cd $TWEAKCC && npm run build
CLI_JS=$(find ~/local-claude-code -name "cli.js" | head -1)
TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node $TWEAKCC/dist/index.mjs --apply
```

After applying, restart `claude-cues` for changes to take effect.
