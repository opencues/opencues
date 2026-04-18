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

Each future entry below has the same shape. Most-recent-on-top.

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
