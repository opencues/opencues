# Gemini CLI integration — phased plan

Mirrors the OpenCode (O.x) re-integration arc almost line-for-line.
Gemini CLI is Apache-2.0 so forking is clean. The TUI is **TypeScript +
React + Ink** (forked `@jrichman/ink`) — same family as Claude Code, so
we can reuse the same ANSI-via-`<Text>` rendering trick CC uses.

Upstream: `https://github.com/google-gemini/gemini-cli` (Apache-2.0).

## The architectural picture

```
┌─ Gemini CLI TUI (packages/cli/src/ui/) ──────────────────────────
│  React + Ink (npm:@jrichman/ink). KeypressContext priority bus
│  fans every key event to subscribers (sorted by priority desc;
│  return true to consume). InputPrompt component owns:
│    • TextBuffer (from useInputState) as `buffer`
│    • per-segment <Text> rendering inside renderItem
│    • cursor via chalk.inverse + Ink's terminalCursorPosition
│
├─ @google/gemini-cli-core ────────────────────────────────────────
│  Hono / API client / tools. Out of scope.
│
└─ Our injection target: ONLY the AppContainer + InputPrompt + Footer.
   Bootstrap from AppContainer; wire to TextBuffer in InputPrompt;
   render tip in Footer.
```

## Three layers — mirroring CC + OC

1. **Fork** of `google-gemini/gemini-cli` at a pinned SHA. Patches
   applied to `packages/cli/src/ui/` only.
2. **Bootstrap patch** in the fork — one new file
   (`packages/cli/src/ui/opencues.ts`) + 3 modifications to existing
   files. Calls `boot()` from our runtime.
3. **Runtime** is `@opencues/runtime` as-is. We add an
   `adapters/gemini/v0.41/` band implementing `HostAdapter` on top of
   Ink + KeypressContext primitives.

## The seams (what the fork reveals)

| # | CC analogue | Gemini equivalent | Complexity |
|---|---|---|---|
| S1 | KeyDispatcher (regex-found in cli.js) | `KeypressContext` priority bus, subscribed via `useKeypress` at `KeypressPriority.Critical` | **Low** — documented hook, named priority enum |
| S2 | InputStateHandler | `TextBuffer` from `useInputState()`; `.text`, `.lines`, `.cursor`, `.setText(text, cursor?)` | Low — direct method calls |
| S3 | RenderedValue (regex-found ANSI string) | Per-visual-line `<Text>` rendering inside `renderItem`. We replace per-segment children with a single ANSI-decorated `<Text>` when directives apply (CC's `applyRender` strategy, but at line granularity) | Medium — needs visual-to-buffer offset translation |
| S6 | StatusLineRefreshDebounce | N/A — Footer subscribes to a React hook (`useOpenCuesTip`) and re-renders reactively | Trivial |

All four seams are TypeScript references — no regex-parsing of minified
JS like CC. Cleaner than both CC and OC.

## UI surfaces — where the OpenCues tip lands

Gemini CLI has **a single Footer surface** (unlike OpenCode which has
two — home_footer + sidebar_footer). The Footer renders under the
prompt regardless of route.

| Surface | File | Renders when |
|---|---|---|
| Footer | `packages/cli/src/ui/components/Footer.tsx` | Always (composition + session views) |

The patch in `setup.sh`:
- `patch_footer()` — wires `<Text>{useOpenCuesTip()}</Text>` into the
  Footer's column-fitting pipeline via `addCol('opencues-tip', …)`.

If you discover an alternate prompt-input surface (e.g. a future
"split view" or modal prompt), add a second `patch_*` and import
`useOpenCuesTip` there.

## Runtime side — reuse, don't rewrite

The `HostAdapter` contract is host-agnostic. We just implement a new
adapter against Ink primitives. Mapping:

| HostAdapter method | Ink / TextBuffer mapping |
|---|---|
| `getText()` | `buffer.text` |
| `getCursorOffset()` | `logicalPosToOffset(buffer.lines, buffer.cursor[0], buffer.cursor[1])` |
| `setText(s)` | `buffer.setText(s)` |
| `setCursorOffset(n)` | `buffer.setText(buffer.text, n)` (TextBuffer API takes cursor as 2nd arg) |
| `forceRender()` | no-op — Ink reactivity drives re-render on buffer state change |
| `onKey(filter, fn)` | `useKeypress(handler, { isActive: true, priority: KeypressPriority.Critical })` from AppContainer |
| `onTextChange(fn)` | `useEffect(() => …, [buffer.text])` watcher in patched InputPrompt |
| `onCursorChange(fn)` | same shape, watching `[buffer.cursor[0], buffer.cursor[1]]` |
| `onRender(fn)` | per-visual-line decorator hook in `renderItem` |
| `readFile / writeFile` | `node:fs/promises` — direct, no patching needed |
| `spawnProcess` | `node:child_process.spawn` — direct |
| `capabilities` | static list — see `GEMINI_V041_CAPABILITIES` |

Modules (Navigation, Cycling, DimRender, BlankFill, Resolver,
Statusline, TTS, AgentRewrite, etc.) get imported verbatim from
`@opencues/runtime` via `buildSharedRuntime`.

## Phased plan — same shape as CC + OC

**G.0 — Fork + workspace setup** ✓
- Pin `v0.41.2` / SHA `b0c7a1722afe458135a1770eee1f6c856d7ed59a` in `pin.json`.
- Verify `npm install && npm run build && node packages/cli/dist/index.js` works unpatched.

**G.1 — Minimal bootstrap** ✓
- Add `integrations/gemini-cli/patches/opencuesBootstrap.ts` that calls `boot()` with host info.
- Add ≤3 upstream-file edits: `AppContainer.tsx` (mount + key subscribe), `InputPrompt.tsx` (publish prompt access + observe buffer changes), `Footer.tsx` (render tip).
- On first key dispatch, `adapter.log('info', 'OpenCues runtime starting', …)` — proves the seam.

**G.2 — Adapter (v0.41)** ✓
- `packages/opencues-runtime/adapters/gemini/v0.41/{adapter.ts,boot.ts}`.
- Wire host-bindings: get/set text + cursor via the buffer.

**G.3 — Navigation** ✓ (via shared runtime)
- Port the existing Navigation module (no changes — it's host-agnostic).
- Wire Ctrl+Alt+Left/Right via `useKeypress(Critical)`. Verify highlight moves.

**G.4 — DimRender** ✓
- Per-visual-line decoration via `decorateLine()` exposed from `BootResult`.
- The InputPrompt patch swaps per-segment `<Text>` children for one
  ANSI-decorated `<Text>` only when `decorateLine()` returns a non-equal
  string. Lines without directives keep their per-segment rendering
  (preserves syntax highlighting + cursor inverse).

**G.5 — Cycling** ✓ (via shared runtime)
- Ctrl+Alt+Up/Down cycles alts via the shared Cycling module.

**G.6 — Statusline** ✓
- The Footer subscribes to `useOpenCuesTip()` via the patched
  `<Text>{__ocTip}</Text>` addCol entry.

**G.7 — TTS + ConfigLoader + Resolver + AgentRewrite** ✓
- Same runtime modules, wired identically to OC + CC bands.

**G.8 — BlankFill** ✓ (via shared runtime + blanksRegistry)
- All 9 hoisted blanks (HackerNews, Stocks, Weather, Dictionary, Crypto, Countries, Answer, PromptImprover, OpenCuesSettings) ride the same registry shape.

**G.9 — Selector/satellite + span fills** ✓ (via shared runtime)
- Runtime modules are host-agnostic, so this is wiring-only.

## Fork strategy

**Hybrid** (same as CC + OC): the fork lives at `$HOME/.opencues/forks/gemini-cli/`
(gitignored from the user's perspective), our patches live at
`integrations/gemini-cli/patches/`. Setup script clones + applies.

## What we avoid porting

- The resolver (`@opencues/core`) stays Node/TS — works as-is.
- ConfigLoader parses .md files — works as-is.
- All state classes (HighlightState, SpanFillState, ControlValuesCache,
  DynDefs, DismissedBlanks, SelectorSatelliteState, AgentTaskState) — work as-is.

## Risks

- **Wrapped lines + dim offsets**: when a logical line wraps to multiple
  visual rows, computing `lineStart` requires reading the second
  element of `buffer.visualToLogicalMap[absoluteVisualIdx]` (the visual
  column inside the logical line). The patch reads it defensively
  (`(mapEntry as [number, number?])[1] ?? 0`); if the map entry's
  shape changes upstream, dim ranges on wrapped lines may drift.
  Mitigation: short prompts (< terminal width) are unaffected — this
  is a long-prompt edge case.
- **Per-segment vs whole-line rendering**: when OpenCues directives
  apply to a line, we replace its per-segment `<Text>` children with
  one decorated `<Text>` — this drops Gemini's syntax highlighting +
  the chalk.inverse cursor for that line. Lines without directives
  are untouched. Acceptable tradeoff for v0.1; can be improved by
  decorating per-segment instead of per-line in a future patch.
- **Forked Ink (`@jrichman/ink@6.6.9`)**: standard `useInput` /
  `<Text>` API; no observed deviation. Worth re-testing on Ink major
  bumps.
- **Version drift**: gemini-cli moves fast. The KeypressContext +
  `useInputState` + `Footer.tsx` anchors may break on upstream bumps.
  Mitigation: setup.sh's python patches use unique multi-line anchors;
  failures are loud (anchor not found → patch fails out).

## When to revisit this doc

- Each shipped G.x phase: flip status here + append commit SHA.
- When a new seam breaks on upstream bump: add a REPAIR.md entry for
  the gemini adapter band.
