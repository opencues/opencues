# OpenCode adapter — repair guide

OpenCode integration band. Pin: **opencode v1.4.11 (`5e9d5c7`)**.

The runtime side is host-agnostic; the only band-specific code lives at:

- `packages/opencues-runtime/adapters/opencode/v1.4/adapter.ts`
- `packages/opencues-runtime/adapters/opencode/v1.4/boot.ts`
- `integrations/opencode/patches/opencuesBootstrap.ts`
- `integrations/opencode/patches/setup.sh`

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
