# OpenCode adapter — repair guide

OpenCode integration band. Pin: **opencode v1.4.11 (`5e9d5c7`)**.

The runtime side is host-agnostic; the only band-specific code lives at:

- `packages/opencues-runtime/adapters/opencode/v1.4/adapter.ts`
- `packages/opencues-runtime/adapters/opencode/v1.4/boot.ts`
- `integrations/opencode/patches/opencuesBootstrap.ts`
- `integrations/opencode/patches/setup.sh`

## Live-fixes discovered during testing (O.2 → O.6)

Five bugs surfaced once we ran the patched fork in a real terminal.
All five are folded into `integrations/opencode/patches/advance.sh`'s
fix block so every advance applies + verifies them. If you see any of
the **symptoms** below, check the corresponding fix is still in place.

### LF-1. Adapter `onKey` ignored its `KeyFilter` (O.3)

**File:** `adapters/opencode/v1.4/adapter.ts` — `onKey()`.

**Symptom:** can only type one character before keystrokes get swallowed.

**Why:** without filter wrapping, every registered handler ran for
every key. Navigation's "left" handler activated highlight on the
first non-empty text, then `preventDefault()` blocked every
subsequent keypress.

**Fix:** wrap the handler so it only runs when `filter.keys` /
`filter.requireModifiers` / `filter.forbidModifiers` all match.

### LF-2. `useTheme().syntax` is a SolidJS memo, not the SyntaxStyle (O.4)

**File:** `integrations/opencode/patches/setup.sh` — Prompt component
patch.

**Symptom:** `[trig] dim style err: syntax.getStyleId is not a function`.

**Why:** `syntax` from `useTheme()` is a `createMemo(...)` accessor.
You have to CALL it to get the SyntaxStyle instance. Easy to miss
because TypeScript types it loosely via the proxy.

**Fix:** `syntax: useTheme().syntax() as any` (note the `()`).

### LF-3. Extmark removal is `.delete(id)`, not `.remove(id)` (O.4)

**File:** `integrations/opencode/patches/opencuesBootstrap.ts` —
`triggerOpenCuesRender`.

**Symptom:** highlights/dims stack on every cycle — old extmarks
never clear, you get a rainbow of overlapping styles.

**Why:** I guessed `.remove(id)` from the v1 patch convention. The
actual OpenTUI API is `.delete(id)` (returns boolean).

**Fix:** swap to `.delete?.(id)`.

### LF-4. ConfigLoader looked at the TUI's cwd, not OpenCues home (O.5/O.6)

**File:** `integrations/opencode/patches/setup.sh` — `cwd:` line in the
app.tsx bootstrap call.

**Symptom:** Cycling on a known cue word (`volume`, `brightness`)
returns `consumed=false`. cueMap appears empty even though
`~/.claude/claude-code-tips.json` exists.

**Why:** the bootstrap passed `process.cwd()`, which is the OpenCode
fork directory (`~/opencode-cues`). That's not where the user keeps
their `cues.md`, `controls/`, `cues/` folders. ConfigLoader loaded
the tips JSON but missed all folder configs.

**Fix:** `cwd: process.env.OPENCUES_HOME || "/home/wilfred/opencues"`.
Users with a different layout set `OPENCUES_HOME` before launching.

### LF-5. `setText`-driven changes were tagged `source: 'user'` (O.6)

**File:** `integrations/opencode/patches/opencuesBootstrap.ts` —
`notifyOpenCuesTextChange`.

**Symptom:** highlight disappears when Cycling rotates text (`0.5f`
→ `1.0f`, `ultrathink` → next alt). Visually, the active word
flashes off after each cycle.

**Why:** Cycling.setText → bootstrap's setText → SolidJS store update
→ Prompt's `onContentChange` → `notifyOpenCuesTextChange("user")` →
Navigation.onTextChange clears `hlState` (it interprets user changes
as the user typing).

**Fix:** module-scope `lastRuntimeSetText` set when we push;
`notifyOpenCuesTextChange` checks if incoming text matches → re-tag
`source: "runtime"` so Navigation skips the deactivate. Mirrors CC's
`pendingText`/`lastSeenText` pattern (REPAIR.md #1 for CC).

## Host quirks

### 1. SolidJS reactivity vs imperative writes

OpenCode's prompt input lives in two places: the SolidJS store
(`store.prompt.input`) and the `TextareaRenderable` ref's internal
state. Updates need to hit BOTH — write to the store via `setStore`
to trigger reactive re-render AND call the textarea's mutator so its
internal cursor stays in sync.

The `setText` binding in `opencuesBootstrap.ts` does both via the
`promptAccess.write()` callback supplied from `prompt/index.tsx`.

### 2. OpenTUI accepts plain strings, not ANSI

Our DimRender produces ANSI-wrapped text via `applyDirectives`. OpenTUI
might strip ANSI before drawing — TBD. If so, we'll need either:
- A render hook in OpenTUI that lets us hand a pre-wrapped string.
- Or a custom textarea component with hand-painted ANSI.

If highlight + dim don't visually appear post-O.4, this is the first
thing to check.

### 3. `useKeyboard` fires per-event, no synthetic dispatch

Unlike Claude Code's KeyDispatcher (which we synthesise events back
to), OpenCode's `useKeyboard` is called by OpenTUI directly.
`dispatchOpenCuesKey` returns true when consumed; the patched hook
calls `evt.preventDefault()` so the event doesn't reach the textarea.

If you find the textarea STILL receives consumed keys, OpenTUI might
not honour preventDefault on the keyboard channel. Check
`@opentui/core`'s key event emitter.

## Version-bump scenarios

OpenCode releases frequently. Each bump may move the seams.

| Severity | What changed | Where to look |
|---|---|---|
| **Trivial** | Identifier renames (e.g. `useKeyboard` → `useKeys`) | Update import in `opencuesBootstrap.ts`. |
| **Small** | New required prop on `TextareaRenderable` | Update bootstrap's bindings. |
| **Medium** | `Prompt` component restructured (autocomplete, history) | Re-derive the read/write/cursor accessors against the new tree. |
| **Large** | TUI moves off OpenTUI (e.g. back to Bubble Tea) | New adapter band: `adapters/opencode/v<NEW>/`. Runtime stays. |

## Diagnostic flow

Symptom: nothing happens after `setup.sh + bun run dev`:
1. `cat /tmp/opencues.log` — should have the boot line.
2. If empty: bootstrap never ran. Check `app.tsx` was patched
   (`grep startOpenCues app.tsx`).
3. If present but no key events: the patched `useKeyboard` isn't
   firing. Check `@opentui/solid` exports the same hook name.
4. If keys flow but text doesn't change: `setText` plumbing broken.
   Inspect `promptAccess.write()` in the prompt component patch.
