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

Each future entry below has the same shape. Most-recent-on-top.

---

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
