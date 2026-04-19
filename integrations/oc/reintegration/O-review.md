# OpenCode integration — per-step review log

For each phase you can:
- Check what changed.
- Roll back via `git reset --hard <PRIOR>` (the commit BEFORE the phase).
- Run the live-test instructions and compare against expected.
- Read the peculiarity notes for context.

Phases shipped so far:

| Step | Commit | Prior (rollback target) | Status |
|---|---|---|---|
| O.0 + O.1 (scaffold + boot) | `19723e1` | `095f4ff` | Live-test stub bindings work |
| O.1 smoke + tests | `ac38791` | `19723e1` | 5 unit tests in adapter band |
| O.2 (real prompt access) | `ad6ff0e` | `ac38791` | Holder pattern, Prompt patches |
| O.3 Navigation | `91e47f7` | `f4d088b` | Ctrl+Alt+Left/Right activates highlight |
| O.4 DimRender (extmarks) | `db27817` | `97fe5dd` | Highlight + dim render via OpenTUI extmarks |
| O.5 + O.6 ConfigLoader + Cycling | `da46931` | `6d57e3f` | Cycling subscribed, ConfigLoader loads tips |
| O.7 Statusline + Resolver + TTS | `4078e94` | `0a1a9fd` | Middle layer wired; opt-in via host paths |
| O.8 BlankFill + spans + selector | `6fc4b24` | `f5324c9` | Full feature parity reached; `_` triggers blank fill |

Each future entry below has the same shape. Most-recent-on-top.

---

## O.8 — BlankFill + spans + selector/satellite

**Commit:** `6fc4b24`
**Rollback to (prior):** `f5324c9`

**Modules touched:**
- `packages/opencues-runtime/adapters/opencode/v1.4/boot.ts` — constructs SpanFillState, DismissedBlanks, SelectorSatelliteState; threads them into Navigation, DimRender, Cycling, Statusline, TTS. Subscribes BlankFill (after ConfigLoader.load resolves).

**What it does:**
The full Bucket E + F + G feature set comes online:
- `affirm _` → fills with stepValues; cycles I am strong → I am brave → ... (multi-word span).
- `weather _` → script fill, suffix appended, dim+highlight as one block.
- `improve prompt write a poem _` → consume-all (LLM-driven prompt improver if `GROQ_API_KEY` set).
- `opencues settings _` → selector/satellite pair with cycling write-back to opencues.md.
- `volume _` → numeric fill with `%` suffix; cycle adjusts via blankScript set.

**Live test (full sweep):**
1. `export GROQ_API_KEY=...` (only needed for prompt improver / answer / hackernews via LLM).
2. Re-run setup.sh; restart `bun run dev`.
3. Type `affirm _` → text becomes `affirm I am strong`. Ctrl+Alt+Left → highlight span. Ctrl+Alt+Up → cycles to next affirmation.
4. Type `weather in Paris _` → `in Paris <forecast>` (clearKeyword + suffix appended).
5. Type `volume _` → `volume 50%`; Ctrl+Alt+Up on `50%` → bumps system volume.
6. Type `opencues settings _` → `voice-mode active`. Cycle satellite to inactive → opencues.md updated.
7. Type `improve prompt write me a poem _` → first improved version replaces input.

**Expected:**
- All blank-fill flavors work (sync stepValues, async script, satellite, consume-all).
- Statusline shows the right tip per context (span tip, selector/satellite tip, control word tip with live %).
- TTS speaks `Daily affirmations` etc. when speak:true.

**Peculiarities found:**
- BlankFill subscribes AFTER `configLoader.load()` resolves (not synchronously) so the cueMap is populated when `_` is pressed. Same pattern as CC.
- The `_` keystroke routes via `adapter.onKey({keys:['_']})` — verify OpenTUI's key.name matches `'_'` exactly. If not, add an alias.
- All five blank-related state classes (SpanFillState, DismissedBlanks, SelectorSatelliteState, DynDefs, ControlValuesCache) are now constructed and threaded through. Order matters — declared before any module that needs them.

**Notes:**
- Bucket complete. Same feature parity as Claude Code v2.1 modulo the visual rendering layer (extmarks vs ANSI inserts).
- If anything looks off live, the corresponding REPAIR.md entries (`adapters/claude-code/REPAIR.md` for general runtime quirks; `adapters/opencode/REPAIR.md` for OpenCode-specific) should help.

---

## O.7 — Statusline + Resolver + TTS

**Commit:** `4078e94`
**Rollback to (prior):** `0a1a9fd`

**Modules touched:**
- `packages/opencues-runtime/adapters/opencode/v1.4/boot.ts` — adds Statusline + Resolver + TTS (all opt-in via host paths/keys); ControlValuesCache constructed and threaded into Cycling + Statusline.
- `integrations/opencode/patches/opencuesBootstrap.ts` — passes `statusFilePath`, `ttsScriptPath`, `ttsRate`, `llmApiKey` (from `GROQ_API_KEY`), `llmEndpoint`, `llmDefaultModel` from env.

**What it does:**
- Statusline writes JSON snapshot to `/tmp/claude-highlight-state-<pid>.json` (matches CC) on every render. OpenCode's own status bar is left alone — users can `tail` the file or run a separate consumer.
- Resolver kicks in when `GROQ_API_KEY` is set: 500ms debounce after text-change, populates DynDefs from cues-core's CueResolver. Cycling can then rotate LLM-resolved alts.
- TTS speaks `cueTip` when active word has `speak: true`; reads `tts-rate` / `tts-script` from opencues.md (overrides patch defaults).

**Live test:**
1. `export GROQ_API_KEY=...`
2. Re-run setup.sh; restart `bun run dev`.
3. `tail -f /tmp/claude-highlight-state-*.json` in another terminal.
4. Type `volume` → highlight, statusline JSON updates with `cueControl: true` + `cueTip: "system volume control"` + the live `volume.sh get` value.
5. Type `the cat sat` → after ~500ms, words gain LLM alts; cycling them rotates through.
6. If TTS script (`~/.claude/actions/speak.sh`) exists and the cue has `speak:true`, audio plays.

**Expected:**
- Statusline JSON updates per render.
- Resolver "built with N sources" line in `/tmp/opencues.log`.
- TTS only fires for `speak:true` cues.

**Peculiarities found:**
- Resolver early-returns with "no cuesConfig/blanksConfig, skipping build" if neither file is present in cwd. Matches CC behavior.
- Statusline only writes when `host.statusFilePath` is set; default path uses `process.pid` so two TUIs don't clobber.
- LLM env vars (`OPENCUES_LLM_ENDPOINT`, `OPENCUES_LLM_MODEL`) override patch defaults.

**Notes for the next step:**
- O.8 wires BlankFill + the four blank-related state classes (SpanFillState, SelectorSatelliteState, DismissedBlanks, ControlValuesCache already in place).
- The `_` keystroke needs to route into BlankFill via `adapter.onKey({keys:['_']})` — check OpenTUI key event names match.

---

## O.5 + O.6 — ConfigLoader + Cycling

**Commit:** `da46931`
**Rollback to (prior):** `6d57e3f`

**Modules touched:**
- `packages/opencues-runtime/adapters/opencode/v1.4/boot.ts` — constructs ConfigLoader + Cycling; subscribes both. Navigation + DimRender now also receive configLoader so the cueMap-aware filter applies.
- `integrations/opencode/patches/setup.sh` — installs `cues-core` into the fork's node_modules (ConfigLoader + Resolver depend on it).

**What it does:**
- ConfigLoader reads `~/.claude/claude-code-tips.json` (overridable via `host.tipsPath`) + cwd `cues.md`/`controls.md`/`blanks.md`/`opencues.md` + folder `cues/*/cue.md` + `controls/*/cue.md`.
- After load, Navigation / DimRender filter to navigable words (cue map + control words + step patterns) instead of the all-words fallback.
- Cycling subscribes Ctrl+Alt+Up/Down. Static-alts (path 4) + step-pattern (path 3) + script (path 1) + list (path 2) all wired.
- Span/satellite/dismissed states wait for O.7 — those modules aren't constructed yet.

**Live test:**
1. Ensure `~/.claude/claude-code-tips.json` exists (the CC integration uses it; should already be populated).
2. Re-run `setup.sh`; restart `bun run dev`.
3. Type a known cue word (e.g. `volume`).
4. Press Ctrl+Alt+Left → highlight on `volume` (single nav target).
5. Press Ctrl+Alt+Up → cycle script-control fires (`volume.sh up 6` runs in background).
6. Type `0.5f` → highlight via stepPattern; cycle adjusts by 0.5.

**Expected:**
- Cycling visible (text changes).
- Static-alt cycling (e.g. `fast` → `quick`) only works if `tips.json` has alts for the word.

**Peculiarities found:**
- `cues-core` must be installed into the fork's node_modules. setup.sh now builds it (if missing) and copies dist + package.json. Same pattern as the runtime.
- ConfigLoader's hot-reload depends on text-change events. Editing `opencues.md` doesn't trigger a reload until you type something in the prompt. Same as CC behavior.

**Notes for the next step:**
- O.7 wires the heavier modules: Statusline, Resolver, TTS, BlankFill + state classes. ConfigLoader + ControlValuesCache + DismissedBlanks + SpanFillState + SelectorSatelliteState all need construction.

---

## O.4 — DimRender via OpenTUI extmarks

**Commit:** `db27817`
**Rollback to (prior):** `97fe5dd`

**Modules touched:**
- `packages/opencues-runtime/adapters/opencode/v1.4/boot.ts` — subscribes DimRender; new `collectRenderDirectives(text, cursor)` on BootResult.
- `integrations/opencode/patches/opencuesBootstrap.ts` — `triggerOpenCuesRender` collects directives + applies extmarks. Lazy-registers `opencues-dim` (`{dim:true}`) + `opencues-highlight` (`{fg:white, bold:true}`) styles. PromptInputAccess gains `textarea` + `syntax` fields.
- `integrations/opencode/patches/setup.sh` — Prompt patch publishes the textarea ref + `useTheme().syntax`; calls `triggerOpenCuesRender` from `onContentChange`. Bootstrap also fires it after every consumed keypress (so nav-driven highlight changes paint).

**What it does:**
DimRender's directives are translated to OpenTUI extmarks instead of inline ANSI. Each render: clear our previously-owned extmarks, then create new ones for `dimRanges` + `highlight`. Styles are registered lazily on first render so we don't depend on the theme system at boot.

**Live test:**
1. Re-run setup.sh; restart `bun run dev`.
2. Type `volume brightness foo`.
3. Press Ctrl+Alt+Left.
4. **Expected:** `foo` (or whichever rightmost word) gets a bright-white highlight; other navigable words appear dimmed.
5. Step left again — highlight moves to `brightness`, `volume` stays dim, `foo` un-dims (since it's now the active highlight target was rightmost; if cue map isn't loaded, ALL words are navigable so all dim).

**Expected (without ConfigLoader yet):**
- All-words fallback applies, so EVERY non-active word gets a dim extmark.
- Highlight extmark on the active word.
- If extmarks render visibly: O.4 done.
- If extmarks don't appear: see Peculiarities below.

**Peculiarities found:**
- TextareaRenderable's `extmarks.remove(id)` may not exist (it's not in the .d.ts surface I checked). Code guards with `?.`. If the visible state shows STACKED highlights/dims (not cleared between renders), this is the cause — need a different cleanup strategy (perhaps `extmarks.clear()` filtered by typeId).
- `useTheme().syntax` access requires being inside the SolidJS component tree. Patched into the textarea's `ref={...}` callback which runs inside the component — should work.
- `RGBA.fromValues(1,1,1,1)` for white: extracted from `@opentui/core` exports. May fail at runtime if the constructor signature differs from what I guessed; check REPAIR.md for fallback.

**Notes for the next step:**
- O.5 wires Cycling. Same module as CC; subscribed in boot. Config loader still missing so cycling will need at least a basic alts source — defer until O.6.

---

## O.3 — Navigation module

**Commit:** `91e47f7`
**Rollback to (prior):** `f4d088b`

**Modules touched:**
- `packages/opencues-runtime/adapters/opencode/v1.4/boot.ts` — constructs HighlightState + DynDefs; subscribes Navigation.
- `integrations/opencode/patches/opencuesBootstrap.ts` — `dispatchOpenCuesKey` now reads text + cursor from the holder so the KeyEvent has populated `text`/`cursorOffset` (Navigation.step needs these).

**What it does:**
Navigation now subscribes during boot. Ctrl+Alt+Left activates the rightmost word; subsequent presses step left. Ctrl+Alt+Right reverses. With nothing else wired, the rendered text doesn't change YET — DimRender (O.4) is what makes the highlight visible.

**Live test:**
1. Re-run setup.sh; restart `bun run dev`.
2. Type `alpha beta gamma` in the prompt input.
3. Press Ctrl+Alt+Left.
4. Watch `/tmp/opencues.log` — no specific log per highlight (could add later), but `forceRender` should fire.

**Expected:**
- Pressing the nav keys should be CONSUMED (the textarea's own cursor should NOT move). This is the primary visible signal at O.3.
- If the textarea cursor moves anyway, `evt.preventDefault()` from the patched useKeyboard isn't blocking OpenTUI's internal handler — see REPAIR.md #3.

**Peculiarities found:**
- KeyEvent must carry `text` + `cursorOffset` for Navigation.step. We populate from the holder in `dispatchOpenCuesKey`. Empty/wrong values silently skip Navigation.
- Navigation falls back to all-words filtering until ConfigLoader provides cueMap (O.6). At O.3, EVERY word is navigable.

**Notes for the next step:**
- O.4 hits the OpenTUI rendering question. We need to either (a) wrap the textarea's display string with ANSI dim/highlight codes (if OpenTUI passes them through) or (b) use OpenTUI's extmarks API to attach style ranges (more idiomatic).
- Look at `input.extmarks.registerType("prompt-part")` in prompt/index.tsx — that's the API we may need.

---

## O.x — TEMPLATE

## O.2 — Real prompt access via singleton holder

**Commit:** `ad6ff0e`
**Rollback to (prior):** `ac38791`

**Modules touched:**
- `integrations/opencode/patches/opencuesBootstrap.ts` — adds `publishPromptAccess` + `holderBackedPromptAccess` + the singleton `__ocPromptHolder`.
- `integrations/opencode/patches/setup.sh` — patches Prompt component to call `publishPromptAccess` on textarea ref + forward `onContentChange` to `notifyOpenCuesTextChange`. Updates app.tsx to use `holderBackedPromptAccess()` instead of stub.
- `packages/opencues-runtime/adapters/opencode/v1.4/holder.test.ts` — locks the holder pattern (3 tests).

**What it does:**
The runtime now bootstraps with a deferred-binding "holder" — reads/writes go through a singleton that the Prompt component populates on mount. Before publish, reads return defaults; after publish, the bootstrap sees live text + cursor.

**Live test:**
1. Re-run `~/opencues/integrations/opencode/patches/setup.sh` (idempotent).
2. `cd ~/opencode-cues && bun run dev`.
3. Watch `/tmp/opencues.log` for `OpenCues runtime starting (OpenCode v1.4)` on TUI mount.
4. Type a few characters in the prompt input.
5. Look for additional log lines if you have any text-change subscribers (none yet at O.2; see O.3+).

**Expected:**
- Boot line appears before Prompt mounts (holder backs reads with `""`).
- Once Prompt mounts, `publishPromptAccess` runs and the holder routes through.
- No crash from setText path — the patched `write` calls both `input.setText(t)` AND `setStore("prompt", "input", t)` (SolidJS reactivity needs both).

**Peculiarities found:**
- TextareaRenderable's API: `plainText` (read), `setText(s)` (write), `cursorOffset = N` (write cursor), `insertText(s)` (insert at cursor). Documented in REPAIR.md `adapters/opencode/REPAIR.md`.
- Writing JUST `input.setText(s)` won't trigger SolidJS re-renders that depend on `store.prompt.input`. We update both. v1 lesson would have surfaced this; we caught it from reading the existing onContentChange handler.
- The order in app.tsx matters: `startOpenCues` fires onMount; the Prompt component mounts later. The holder pattern absorbs this without explicit await.

**Notes for the next step:**
- O.3 wires the Navigation module. Should be a 3-line addition in boot.ts (mirrors CC's pattern).
- DimRender (O.4) will hit the OpenTUI ANSI question — TextareaRenderable may render `plainText` literally and ignore embedded ANSI. If so, we'll need `applyDirectives` to write to OpenTUI's extmark-based highlighting API instead.

---

## O.x — TEMPLATE

**Commit:** `<sha>`
**Rollback to (prior):** `<prior-sha>`
**Modules touched:**
- `<file>` — ...

**What it does:**
A 1-3 sentence description.

**Live test:**
1. (steps to verify in the running TUI)
2. ...

**Expected:**
- ...

**Peculiarities found:**
- ...

**Notes for the next step:**
- ...

---
