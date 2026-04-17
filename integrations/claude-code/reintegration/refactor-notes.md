# Refactor notes — review checklist

Companion to `refactor.md`. Points to inspect for each shipped phase. Each phase
is on its own commit — revert a phase with `git reset --hard <prev-sha>` if
needed.

Commits:
- `3628458` — Phase 0: opencues-runtime scaffold
- `3ea17ae` — Phase 1: Navigation module + v2.1 CC adapter + tweakcc v2 patch
- `3c8d69e` — Phase 1 fix: forceRender wires through to ZWS toggle at KeyDispatcher return
- `1d4d4d3` — Phase 2 (DimRender, reordered ahead of Cycling): visible navigation.
  S3 seam, applyDirectives helper, DimRender module, bootstrap wraps
  renderedValue.
- (this+) Refactor: collapse v2 patch surface to single `boot.js` entry point.

**Repairing the integration when Claude Code bumps versions:**
see `packages/opencues-runtime/adapters/claude-code/REPAIR.md` — scenarios
in increasing difficulty + diagnostic flow + what's never touched.

---

## Phase 0 — opencues-runtime scaffold

**Goal:** new package exists with HostAdapter types, a stub Runtime, a
MockAdapter, and a conformance suite. No runtime behaviour change. Current
reintegration still owns all features.

### What to check

1. **Package layout** — `packages/opencues-runtime/`:
   - `src/adapter.ts` — copied verbatim from `refactor.md` §2.2 (HostAdapter,
     capabilities enum, version constant, error classes).
   - `src/runtime.ts` — `Runtime.create(adapter)` validates
     `interfaceVersion` and the `file-read` required capability, logs
     startup via `adapter.log('info', ...)`, returns a `Runtime`. `dispose()`
     is idempotent.
   - `src/state/*.ts` — stub classes for HighlightState, DynDefs,
     ConsumeAllState, DismissedBlanks. No feature logic yet.
   - `src/modules/*.ts` — one empty class per module listed in §5.1. All
     constructors take `adapter: HostAdapter`. Intentionally minimal.
   - `testing/mock-adapter.ts` — full HostAdapter implementation with
     `fireKey`, `pushText`, `fireRender` driver helpers.
   - `testing/conformance.ts` — vitest suite that asserts the §2.3 invariants
     against any adapter factory.

2. **Build + tests** — from the repo root:
   ```bash
   npm install                            # root workspace resolver
   npm run build --workspaces             # all four packages build clean
   npm test --workspaces --if-present     # opencues-runtime: 47/47 passing
   ```
   Or inside the package:
   ```bash
   cd packages/opencues-runtime && npm test && npm run build
   ```
   (The workspace was broken before `9b6099d` — cues-browser/cues-node
   pinned `cues-core@^1.0.0` but cues-core is 0.1.0. Fixed by pinning
   dependents to `"*"` plus a `types: ["node"]` scope on cues-node's
   tsconfig to keep hoisted `@types/chrome` out of its compile.)

3. **Conformance suite sanity** — `src/runtime.test.ts` feeds MockAdapter
   into `adapterConformanceSuite(...)`. Later phases + any new adapter
   (browser, test) run the same suite.

4. **No tweakcc changes** — confirmed by diff. Nothing under
   `integrations/claude-code/` was touched in the Phase 0 commit.

### Non-obvious choices

- **`skipLibCheck: true` in `tsconfig.json`** — added because vitest pulls in
  vite's type defs which reference `rollup/parseAst` under a moduleResolution
  we don't use. Skipping lib check is the standard workaround.
- **`rootDir: ./`** (not `./src`) — because adapters live as siblings of
  `src/` per §11.1. `main` points to `dist/src/index.js` to accommodate.
- **`testing/` excluded from the build** — test helpers are ts-imported by
  vitest directly; no need to ship them compiled. Still listed in `include`
  so tsc typechecks them.
- **Conformance suite doesn't require the `globals: true` vitest mode** —
  suites import `describe/it/expect` explicitly. Makes the helper callable
  from any consumer without globals setup.

### Known limitations

- Module stubs pass `adapter` through to a field then reference `void this.x`
  to silence unused warnings. When Phase 2+ implements them these references
  disappear naturally.
- No `dispose` plumbing yet for modules — Phase 2 introduces it as needed.

---

## Phase 1 — Navigation module + v2.1 CC adapter + tweakcc v2 patch

**Goal:** First feature (Ctrl+Alt+Left/Right navigation) reimplemented on the
HostAdapter interface. v2 is opt-in via `settings.misc.opencuesRuntime = 'v2'`
in tweakcc config; v1 remains default.

### What to check

1. **Seam predicates** — `packages/opencues-runtime/adapters/claude-code/v2.1/seams.ts`:
   - `findKeyDispatcher(source)` → finds S1. Regex-first; AST fallback via
     `acorn` + `acorn-walk` when regex misses (e.g. whitespace variants).
     Tests in `seams.test.ts`:
     - canonical v2.1.110 shape matches (regex)
     - whitespace-expanded variant matches (AST fallback)
     - absence of `switch(x.key)` → null
     - absence of the `"escape"` case → null
   - `findInputStateHandler(source)` → finds S2 via the same regex shape as
     the current cursorStateExport/wordHighlight patches (known to hold on
     v2.1.110). Captures every identifier future phases will need
     (inputZoneVar, inputZoneClass, columnsVar, handleKeyDownName, etc.).
     AST fallback is NOT implemented for S2 — the shape is deep enough that a
     faithful AST matcher is a bigger task. Deferred.
   - `runSeams` + `assertAllFound` assemble a fail-loud error message that
     mirrors §8.3 of the spec. Missing-seam list is human-readable.

2. **v2.1 adapter** — `packages/opencues-runtime/adapters/claude-code/v2.1/adapter.ts`:
   - Constructor takes a `HostBindings` object that the cli.js bootstrap
     constructs. This isolates all "inside cli.js" identifiers from the
     runtime code.
   - Capabilities declared for Phase 1: `file-read` (stubbed to return null),
     `force-render`, `render-override`, `dim-ranges`, `highlight-range`.
     Other caps land as their modules land.
   - `onKey(filter, handler)` uses a single root key subscription on the
     bindings and multiplexes per-filter. `matchesFilter` is exported for
     reuse/testing.
   - `normaliseKeyEvent(raw, text, offset)` maps Ink's flag names
     (alt/option/meta/super) onto the canonical `Modifiers` shape. Tested.
   - `dispose()` tears down root subscriptions and is idempotent.

3. **Navigation module** — `packages/opencues-runtime/src/modules/navigation.ts`:
   - `subscribe()` attaches two `onKey` handlers filtered to
     `{requireModifiers: ['ctrl','alt'], keys: ['left'|'right']}`.
   - `splitWords(text)` returns whitespace-separated word spans with start/end
     offsets + index. Exported; tested.
   - Step direction convention mirrors the v1 patch: activate on rightmost,
     Left walks toward the left (higher posFromRight), Right steps back and
     deactivates once it passes the initial activation.
   - **Cue filtering is NOT implemented.** The v1 patch filters by
     `globalThis._isCueControl`, `_localCueMap`, `_dynDefs`. Those live in
     later phases once DynDefs is populated. Phase 1 navigation targets all
     whitespace-separated tokens — matches v1's fallback behaviour.

4. **tweakcc v2 patch** — tracked at
   `integrations/claude-code/patches/opencuesRuntime.ts` (vendored copy in
   the gitignored `integrations/claude-code/tweakcc/src/patches/` locally):
   - Inlined seam regexes (NOT an import from opencues-runtime). **Source of
     truth is `seams.ts`; this is a build-time vendored copy.** If you bump
     the regexes, update both. See inline comment.
   - Injects a bootstrap at the `KeyDispatcher` body start. The KeyDispatcher
     sits inside the InputStateHandler closure (S2), so S2's locals
     (`inputZoneVar`, `inputZoneClass`, `columnsVar`) are in scope at the
     injection site — the bootstrap uses them to rebuild an InputZone.
   - On first invocation: `require()`s opencues-runtime + v2.1 adapter +
     Navigation + HighlightState + DynDefs, constructs `HostBindings`
     (backed by `InputZone.text`/`.offset` at key-dispatch time), calls
     `Runtime.create()`, subscribes Navigation.
   - On every invocation: builds a KeyEvent from the current dispatcher's
     event arg + InputZone snapshot, runs it through `globalThis.__oc.keyHandlers`.
     If a handler consumed the event:
     - if `pendingRender` is set → early-return
       `InputZone.fromText(toggleZeroWidth(text), columns, offset)` —
       React sees a changed string and re-renders.
     - else → early-return the existing InputZone (prevents the host's
       default switch from firing).
   - `toggleZeroWidth` is a pure helper exported from the v2.1 adapter;
     unit-tested (strip-then-toggle, preserves mid-string ZW chars).
   - `DEBUG_OPENCUES=1` env var enables `adapter.log` output to stderr.
   - Fails loud (returns null + `console.error`) when a seam is missing.
     Caller in `index.ts` skips the v2 path gracefully — cli.js stays
     unmodified on seam miss.

5. **tweakcc wiring** — reflected in the tracked `patches/*-additions.ts`
   files so future setup.sh runs can reproduce the edits:
   - `types-additions.ts` — adds `opencuesRuntime?: 'v1' | 'v2'` to the
     MiscSettings interface block.
   - `defaultSettings-additions.ts` — adds `opencuesRuntime: 'v1' as const`.
   - `index-additions.ts` — shows the `if (runtimeVersion === 'v2') { ... }
     else { /* v1 patches */ }` branch.
   - The mirror edits in the live tweakcc tree (gitignored) have also been
     made. Full tweakcc test suite (221 tests) still passes.

### How to opt-in (E2E, **not yet run**)

1. Build the runtime and copy dist to the Claude user path:
   ```bash
   cd packages/opencues-runtime
   npm run build
   mkdir -p ~/.claude/node_modules/opencues-runtime
   cp -r package.json dist ~/.claude/node_modules/opencues-runtime/
   ```
2. Flip the flag in `~/.tweakcc/config.json` (or via a tweakcc UI edit):
   ```json
   { "settings": { "misc": { "opencuesRuntime": "v2" } } }
   ```
3. Rebuild tweakcc and apply:
   ```bash
   cd integrations/claude-code/tweakcc
   npm run build:dev
   CLI_JS=$(find ~/local-claude-code -name "cli.js" | head -1)
   TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node dist/index.mjs --apply
   ```
4. Restart `claude-cues` and verify Ctrl+Alt+Left/Right navigates words
   identically to v1. (Expected to be *visible* only if the forceRender path
   lands — see caveat below.)

### Known limitations / follow-ups

(Phase 2 below closes the visibility gap. Items here are now strictly about
the navigation logic itself — same as before.)
- **No S2 AST fallback** — if v2.1.x minifier output shifts enough that the
  S2 regex stops matching, the installer fails loud (no crash) but needs a
  patch. Adding AST fallback is a stand-alone item.
- **setup.sh not updated** — CLAUDE.md already notes setup.sh is outdated
  pending reintegration. Users who want to try v2 today must manually copy
  `opencuesRuntime.ts` into tweakcc and install opencues-runtime (see
  "How to opt-in" above).
- **Nothing exercises the v2 path against real cli.js yet.** Unit tests
  cover the navigation logic + seam shape predicates, but there's no
  integration test asserting that the injected bootstrap produces a
  working KeyDispatcher. The `opencues-auto` harness in `~/.claude/` would
  be the right place; left for you to sanity-check manually or for a later
  testing phase.

### Quick verification commands

```bash
# All workspaces green (from repo root)
npm test --workspaces --if-present     # opencues-runtime: 79/79 after Phase 2

# Tweakcc still green (sanity — we changed nothing destructive)
cd integrations/claude-code/tweakcc && npx vitest run

# Build artifacts present
ls packages/opencues-runtime/dist/src/index.js \
   packages/opencues-runtime/dist/adapters/claude-code/v2.1/adapter.js \
   packages/opencues-runtime/dist/adapters/claude-code/v2.1/seams.js \
   packages/opencues-runtime/dist/src/modules/navigation.js \
   packages/opencues-runtime/dist/src/modules/dim-render.js \
   packages/opencues-runtime/dist/src/render-directives.js
```

---

## Phase 2 — DimRender (reordered ahead of Cycling)

**Goal:** make the navigation that landed in Phase 1 actually visible.
Spec §10.2 has Cycling as Phase 2 and DimRender as Phase 3 — we swapped them
so each phase ships something a user can see.

### What to check

1. **`packages/opencues-runtime/src/render-directives.ts`** —
   `applyDirectives(rendered, directives)`. Pure ANSI-aware string rewrite:
   walks the input char-by-char, distinguishes visible chars from `\x1b[...m`
   escapes, and inserts attribute codes (`\x1b[7m`/`\x1b[27m` for highlight,
   `\x1b[2m`/`\x1b[22m` for dim) at the right visible positions. Existing
   ANSI codes pass through untouched. `textOverride` short-circuits.
   Tests at `render-directives.test.ts` (14 cases) cover plain text,
   ANSI-styled, multi-range, ranges past end, empty ranges, ANSI-only input.

2. **`packages/opencues-runtime/src/modules/dim-render.ts`** —
   `DimRender.subscribe()` attaches an `onRender` handler.
   `compute(ctx)` returns `{highlight: {start, end}}` for the active word
   from `HighlightState`, or `null` if inactive / wordIndex out of range /
   no `highlight-range` capability. Tests at `dim-render.test.ts` (6 cases),
   including a Navigation+DimRender integration test that fires a key,
   asserts the highlight directive lands on the right word.

3. **S3 seam — `findRenderedValue`** in
   `adapters/claude-code/v2.1/seams.ts`. Matches `renderedValue:VAR.render(...)`
   in 3/4/5-arg variants AND the rainbow-wrapped IIFE
   (`renderedValue:(function(){...})()`). For the rainbow case it does
   paren-balancing to find the matching `})()`. Captures the *entire*
   expression so the patch can wrap it. Tests in `seams.test.ts` cover
   all four shapes plus the no-match case.

4. **Bootstrap changes** —
   `integrations/claude-code/patches/opencuesRuntime.ts`:
   - Now requires three seams (S1, S2, **S3**); fails loud if any miss.
   - The S1 bootstrap additionally requires `dim-render.js` and
     `render-directives.js`, instantiates `DimRender`, subscribes it, and
     installs `globalThis.__oc.applyRender(rendered, text, offset)`. That
     function builds a `RenderContext`, runs every registered onRender
     handler, and folds each non-null `RenderDirectives` through
     `applyDirectives`.
   - **Second injection at S3:** replaces the original `renderedValue:<EXPR>`
     with `(globalThis.__oc&&globalThis.__oc.applyRender ?
     globalThis.__oc.applyRender(<EXPR>, IZ.text, IZ.offset) : <EXPR>)`.
     The guard means the host's render passes through unchanged until the
     async runtime init resolves — no flicker, no race.
   - Two-injection ordering: S3 first (later position, no shift), then S1.

### How to opt-in (E2E, **still not yet run on live cli.js**)

Same as Phase 1, plus rebuild the runtime so the new
`render-directives.js` and `dim-render.js` are present in
`~/.claude/node_modules/opencues-runtime/dist/`:

```bash
cd packages/opencues-runtime
npm run build
mkdir -p ~/.claude/node_modules/opencues-runtime
cp -r package.json dist ~/.claude/node_modules/opencues-runtime/
# then rebuild + apply tweakcc as in Phase 1's "How to opt-in"
```

Expected on `claude-cues` after restart with `opencuesRuntime: 'v2'`:
**Ctrl+Alt+Left/Right shows the highlighted word in inverse video** as it
moves left/right. That's the proof Phases 0 + 1 + 2 are intact end-to-end.

### Known limitations / follow-ups

- **Highlight colour is hard-coded to ANSI inverse (`\x1b[7m`).** v1 supported
  configurable colours (cyan/yellow/underline). The DimRender module currently
  ignores the `color` field of `HighlightRange` because applyDirectives only
  emits inverse. Adding more colour mappings is a small follow-up — touches
  `render-directives.ts` only.
- **No cue filtering yet.** Same caveat as Phase 1: Navigation + DimRender
  treat every whitespace-separated token as a target. Once DynDefs is
  populated (BlankFill phase), filtering will land naturally because both
  modules share `DynDefs`.
- **Number dimming, span tracking, shimmer suppression** — all v1 features
  that DimRender will eventually own. Phase 2 only paints the active word.
- **applyDirectives algorithm choice:** insertion codes emit *just before*
  the visible position they pertain to, ahead of any leading host ANSI for
  that position. Visually equivalent to v1 (which buffered host ANSI and
  discarded it under highlight); functionally simpler. If you see colour
  bleed in practice, the algorithm in `render-directives.ts` is the place
  to look.
- **No live-install test yet** — same as Phase 1.

---

## Going forward (next phases)

The next phase (Cycling) will:
- Extend `HostBindings` with whatever the cycling UX needs (likely a hook
  into the return-value of KeyDispatcher so Up/Down can return the rewritten
  InputZone).
- Introduce the S2-based bootstrap shim that owns text replacement, which
  transitively fixes the forceRender gap above.
- Port `globalThis._cycleAlt` from `wordHighlight.ts:525` onto the new
  Cycling module, keeping the v1 cue resolver call intact.

Reading order when picking up again: `refactor.md` → this file → recent
commits (`git log --oneline -5`).
