# OpenCode integration — phased plan

Re-uses the Claude Code playbook: minimal fork, thin patch, fat
runtime. OpenCode is MIT-licensed so forking is clean. OpenCode's TUI
is **TypeScript + SolidJS + OpenTUI** (not Go + Bubble Tea as one blog
post suggested) — same ecosystem as `opencues-runtime`, so we can
reuse most of it.

Upstream: `https://github.com/sst/opencode` (MIT).

## The architectural picture

```
┌─ OpenCode TUI (packages/opencode/src/cli/cmd/tui/) ──────────
│  @opentui/core + @opentui/solid + solid-js
│  Prompt component (component/prompt/index.tsx) owns:
│    • TextareaRenderable (the input field) as `input`
│    • store.prompt.input — the reactive text value
│    • onInput(value) — keystroke → store + autocomplete
│    • useKeybind contexts for move-left/right etc.
│
├─ OpenCode server (packages/opencode/src/server/) ────────────
│  Hono HTTP/SSE — LLM, sessions, tools. Out of scope.
│
└─ Our injection target: ONLY the Prompt component + textarea.
   Bootstrap OpenCues from app.tsx, wire to the textarea in prompt.
```

## Three layers — mirroring the Claude Code pattern

1. **Fork** of `sst/opencode` at a pinned version. Patches applied to
   `packages/opencode/src/cli/cmd/tui/` only.
2. **Bootstrap patch** in the fork — one new file
   (`tui/opencues-bootstrap.tsx`?) + ≤3 modifications to existing
   files. Calls `boot()` from our runtime.
3. **Runtime** is `opencues-runtime` as-is. We add an
   `adapters/opencode/v<VER>/` band implementing `HostAdapter` on
   top of OpenTUI's primitives.

## The seams (what the fork reveals)

| # | Analogue in CC | OpenCode equivalent | Complexity |
|---|---|---|---|
| S1 | KeyDispatcher | `useKeyboard()` hook from `@opentui/solid`, fired in app.tsx | Low — documented React-like hook |
| S2 | InputStateHandler | `<TextareaRenderable>` inside the Prompt component, holding `.plainText` + a `ref` | Medium — access via `input` ref |
| S3 | RenderedValue | The content the textarea paints. OpenTUI lets us set a render function or ANSI-wrap the value | Medium — needs inspection |
| S6 | StatusLineRefresh | SolidJS is already reactive — setSignal/store triggers re-render. No explicit refresh needed | Trivial |

All four seams are TypeScript object references — no regex-parsing
over minified JS like CC. Much tractable.

## Runtime side — reuse, don't rewrite

The `HostAdapter` contract is host-agnostic. We just implement a new
adapter against OpenTUI primitives. Rough mapping:

| HostAdapter method | OpenTUI mapping |
|---|---|
| `getText()` | `input.plainText` (read from the TextareaRenderable ref) |
| `getCursorOffset()` | `input.cursorPosition` (TBD — inspect) |
| `setText(s)` | `setStore("prompt", "input", s)` + `input.setValue(s)` (TBD) |
| `setCursorOffset(n)` | `input.setCursor(n)` (TBD) |
| `forceRender()` | `renderer.requestRender()` from `useRenderer()` |
| `onKey(filter, fn)` | wrap `useKeyboard` inside boot, dispatch to subscribers |
| `onTextChange(fn)` | patch `onInput` in prompt/index.tsx to broadcast |
| `onRender(fn)` | SolidJS createEffect on relevant signals OR custom render wrap |
| `readFile / writeFile` | Bun / `node:fs` — direct, no patching needed |
| `spawnProcess` | `Bun.spawn` or `child_process` — direct |
| `capabilities` | static list — TBD per OpenCode version |

Modules (Navigation, Cycling, DimRender, BlankFill, Resolver,
Statusline, TTS, BlankFill, etc.) get imported verbatim from
`opencues-runtime`.

## Phased plan — same shape as the CC re-integration

**O.0 — Fork + workspace setup**
- Clone `sst/opencode` into `integrations/opencode/opencode/` (or similar) as a git submodule / subtree.
- Pin to a version. Verify `bun install && bun run packages/opencode/src/index.ts tui` works unpatched.
- Document the pinned version in REPAIR.md.

**O.1 — Minimal bootstrap**
- Add one patch file: `integrations/opencode/patches/opencuesBootstrap.tsx` that calls `boot()` with host info.
- Add ≤3 upstream-file edits: `app.tsx` (mount OpenCues), `prompt/index.tsx` (wire textarea events).
- On first key dispatch, `adapter.log('info', 'OpenCues runtime starting', …)` — proves the seam.

**O.2 — Adapter (v<VER>)**
- Implement `ClaudeCodeV21Adapter`-equivalent at
  `packages/opencues-runtime/adapters/opencode/v<VER>/adapter.ts`.
- Wire host-bindings: get/set text + cursor via the textarea ref.
- `ClaudeCodeV21Adapter` will be our reference.

**O.3 — Navigation**
- Port the existing Navigation module (no changes — it's host-agnostic).
- Wire Ctrl+Alt+Left/Right. Verify highlight moves.

**O.4 — DimRender**
- Same. Verify cue words dim.
- Figure out how OpenTUI accepts ANSI-wrapped strings.

**O.5 — Cycling**
- Ctrl+Alt+Up/Down cycles alts.

**O.6 — Statusline**
- OpenCode has its own status bar. Decide whether to append or replace.

**O.7 — TTS + ConfigLoader + Resolver**
- Same runtime modules, just wired.

**O.8 — BlankFill**
- Same.

**O.9 — Selector/satellite + span fills**
- Runtime modules are host-agnostic, so this is wiring-only.

## Fork strategy

Two options:

**A. Subtree** at `integrations/opencode/opencode/` (git subtree).
Tracks upstream. Patches live alongside. Easy to re-sync on
upstream version bumps.

**B. Patch file** approach (like tweakcc): upstream lives at a
separate clone path (user's machine), our repo only ships patch
files that are applied via a setup.sh.

Recommendation: **A** for development (read whole codebase in-tree,
easier reasoning), **B** for distribution (users don't want to ship
a ~50 MB upstream fork in the opencues repo).

Actually, hybrid: the fork lives at `/tmp/opencode-fork/` (gitignored),
our patches live at `integrations/opencode/patches/`. Setup script
clones + applies. Same as CC.

## What we avoid porting

- The resolver (opencues-core) stays Node/TS — works as-is.
- ConfigLoader parses .md files — works as-is.
- All state classes (HighlightState, SpanFillState, ControlValuesCache,
  DynDefs, DismissedBlanks, SelectorSatelliteState) — work as-is.

## Risks

- **OpenTUI rendering model** may not easily accept ANSI-wrapped text
  mid-buffer. Need to inspect `TextareaRenderable.render()`.
  Fallback: clone the whole textarea component and have our version
  honour render directives.
- **Solid reactivity**: our runtime does explicit setText; Solid
  expects signal updates. Writing to the textarea via plain method
  calls may not trigger re-render. Need to go through the store
  signal (`setStore`).
- **Version drift**: OpenCode's upstream moves fast. The S1/S2/S3
  seams may break. Mitigation: regex-free seam matching against
  named exports (e.g. `TextareaRenderable` is unlikely to be renamed).

## When to revisit this doc

- Each shipped O.x phase: flip status here + append commit SHA.
- When a new seam breaks on upstream bump: add a REPAIR.md entry for
  the OpenCode adapter band.
