# Refactor notes — review checklist

Companion to `refactor.md`. Points to inspect for each shipped phase. Each phase
is on its own commit — revert a phase with `git reset --hard <prev-sha>` if
needed.

Commits:
- `3628458` — Phase 0: opencues-runtime scaffold
- `3ea17ae` — Phase 1: Navigation module + v2.1 CC adapter + tweakcc v2 patch
- `3c8d69e` — Phase 1 fix: forceRender wires through to ZWS toggle at KeyDispatcher return
- `1d4d4d3` — Phase 2 (DimRender, reordered ahead of Cycling): visible navigation.
- `4cbfbd8` — Refactor: collapse v2 patch surface to single `boot.js` entry point.
- `2b50157` — Docs: REPAIR.md with version-bump scenarios.
- `74c2b94` — Docs: CLAUDE.md cues-core vs opencues-runtime layering.
- `79a5c7e` — Phase 3: Cycling + ConfigLoader (visible word cycling).
- `35df9cb` — Docs: REPAIR.md host-quirks + refactor-notes Phase 3 review.
- `fd34cd5` — Phase 4: Statusline export + `file-write` capability.
- `a0a6f16` — Phase 4.5: S6 seam — event-driven statusline refresh.
  Removes the `refreshInterval: 1` polling workaround.
- `4765ab9` — Docs: REPAIR.md S6 + Phase 4.5 review.
- `65393f8` — Phase 4.6: cue-tip plumbing into Statusline (cueTip + altCueTips).
- `d52bc32` — Phase 5: TTS on tip highlight (spawn-process capability).
- (this+) Docs: `parity.md` — v1 → v2 step-by-step parity tracker.
  Calls out the 27 of 38 v1 steps not yet ported and groups them
  into effort buckets (A through I).

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

## Phase 3 — Cycling + ConfigLoader (visible word cycling)

**Goal:** Ctrl+Alt+Up/Down rotates the highlighted word through alternatives
loaded from `~/.claude/claude-code-tips.json` at startup. Highlight follows
the new word's length. Typing clears the highlight.

### What to check

1. **`packages/opencues-runtime/src/modules/config-loader.ts`** — reads the
   tips JSON via `adapter.readFile` (not raw `fs`), parses with cues-core's
   `parseLocalCueFile` + `buildLookupMap`. Graceful no-op on missing file
   or parse failure (logs and leaves the map empty). 4 tests.

2. **`packages/opencues-runtime/src/modules/cycling.ts`** — Ctrl+Alt+Up/Down
   handler. Builds a `WordDef` on first cycle from `cueMap`; rotates with
   wrap; replaces text; updates spans; clamps cursor against the new text
   length itself (see Host quirks in REPAIR.md). 9 tests.

3. **`packages/opencues-runtime/src/state/dyn-defs.ts`** — `WordDef` is now
   mutable: `currentIndex` and `spanEnd` update as cycling progresses.

4. **`packages/opencues-runtime/src/modules/navigation.ts`** — gained
   `onTextChange` subscription. User-source drift deactivates `hlState`
   AND clears `dynDefs` (so cycling starts fresh on the new text).

5. **`packages/opencues-runtime/src/modules/dim-render.ts`** — the
   stale-activation guard is gone. Highlight clearing now flows from
   Navigation's `onTextChange` reaction, not a render-side check. This
   was the bug that made cycling deactivate highlights immediately after
   the text change.

6. **`adapters/claude-code/v2.1/boot.ts`** — substantial rework:
   - `consumePendingRender(currentText, currentCursor)` takes args. The
     stale-closure issue (see REPAIR.md §Host quirks #1) means boot
     cannot read live state from `bindings.getText`.
   - `applyRender` derives `ctx.text` from the visible content of the
     rendered string itself, guaranteeing position alignment with
     `applyDirectives`'s ANSI walker.
   - `checkTextDrift` compares visible-stripped text across calls and
     fires `textChange` events with source `'user'` on drift. This is
     what powers the highlight-clear-on-typing feature.
   - Constructs `ConfigLoader` (kicks off async `load()`), `Cycling`.

7. **`adapters/claude-code/v2.1/adapter.ts`** — `setCursorOffset` no
   longer clamps via `getText` (would use stale text and force cursor=0
   or =1). Caller responsibility now.

8. **`integrations/claude-code/patches/opencuesRuntime.ts`** —
   - Adds `readFile` callback to host bindings (uses `fs.readFile` via
     `createRequire`).
   - Passes fresh `m.text`/`m.offset` to `consumePendingRender`.
   - `log` callback writes to `/tmp/opencues.log` via
     `fs.appendFileSync` — TUI swallows stderr (REPAIR.md §Host quirks #3).
   - Dispatch debug logs route through the host log under `DEBUG_OPENCUES`.

### How to test live

```bash
cd packages/opencues-runtime && npm run build
cp -r dist ~/.claude/node_modules/opencues-runtime/   # already-installed
DEBUG_OPENCUES=1 claude-cues
# in another shell: tail -f /tmp/opencues.log
```

In claude-cues:
- Type `undo` → Ctrl+Alt+Left (highlight on `undo`) → Ctrl+Alt+Up (cycle to
  `/rewind`, full word highlighted, cursor at end) → repeat to cycle through
  `revert`, `rollback`, back to `undo`. Ctrl+Alt+Down reverses.
- Type any character with the highlight active → highlight clears.
- Try other cued words: `opus`, `fast`, `Tab`, `ultrathink` — see
  `~/.claude/claude-code-tips.json` for the full set.

### Known limitations / follow-ups

- **Single-word cycling only.** Cycling treats each word in isolation. If a
  cycle alternative contains a space (e.g. `deep thinking`), it'd insert
  it as multiple "words" by `splitWords`'s contract. DimRender then
  highlights only the first part. Multi-word cycling is a Phase 4+ concern.
- **Cue map only loads at boot.** If you edit `claude-code-tips.json`
  while claude-cues is running, the changes don't reload. Hot-reload is a
  later ConfigLoader feature.
- **No LLM-driven alts (yet).** Phase 4 (BlankFill) wires the cues-core
  `Resolver` so words without static alts get LLM suggestions on demand.
- **Span tracking on multi-word text is fragile.** If cycling word 0
  expands the text, word 1+'s spans shift but the DynDefs cache for those
  indices is stale until the user types (which clears it). Only matters
  for back-to-back cycling on different words in the same buffer.
- **Phase 3 introduced four `# Host quirks` items in REPAIR.md** — read
  those before debugging anything Claude-Code-specific in the runtime.

---

## Phase 4 — Statusline export

**Goal:** runtime writes `/tmp/claude-highlight-state-<pid>.json` on every
state change. The existing `highlight-statusline.sh` consumer reads it
and renders the highlighted word + alt index in CC's status line.

### What to check

1. **`packages/opencues-runtime/src/modules/statusline.ts`** — subscribes
   `onRender`, builds payload (matches v1's shape: active, highlightedWord,
   currentAltIndex, alts, wordCount, timestamp), dedups by content
   (timestamp stripped before comparison), writes via `adapter.writeFile`.
   ZWS chars stripped from words/alts so the consumer sees clean strings.
   7 tests.

2. **`adapters/claude-code/v2.1/adapter.ts`** — `writeFile` now bridges
   to `bindings.writeFile` (was throwing `AdapterUnsupportedError`).
   `file-write` added to V21_CAPABILITIES.

3. **`adapters/claude-code/v2.1/boot.ts`** — constructs `Statusline` if
   `host.statusFilePath` is set. Don't write to a default location to
   avoid colliding with another opencues instance.

4. **`integrations/claude-code/patches/opencuesRuntime.ts`** —
   - `writeFile` callback (fs.writeFile via createRequire) added to host
     bindings.
   - `statusFilePath` set to `/tmp/claude-highlight-state-<process.pid>.json`
     (matches v1's path so the existing consumer keeps working).

5. **`integrations/claude-code/patches/highlight-statusline.sh`** —
   - Process-tree walk now matches `^claude` OR `claude-code/cli\.js`
     (handles both the native `claude` install and `node .../cli.js`
     invocations like `claude-cues`).
   - Cue info renders **inline** with a `|` separator instead of a
     newline. CC v2.1.x only displays the first line of the status
     command output; the prior multi-line layout looked empty.

### How to test live

```bash
cd packages/opencues-runtime && npm run build
cp -r dist ~/.claude/node_modules/opencues-runtime/
# Ensure ~/.claude/settings.json has refreshInterval: 1 (see below)
DEBUG_OPENCUES=1 claude-cues
```

Then: type `undo` → Ctrl+Alt+Left → status line shows
`user@host:cwd | undo (1/1)`. Cycle with Ctrl+Alt+Up → updates within
1 second to `| /rewind (2/4)`, etc.

### **Required setup change** (host quirk #4 in REPAIR.md)

Add `refreshInterval: 1` to `~/.claude/settings.json`:
```json
{
  "statusLine": {
    "type": "command",
    "command": "/home/<user>/.claude/highlight-statusline.sh",
    "refreshInterval": 1
  }
}
```

Without this, CC only re-runs the script on host-driven events
(tool calls, permission changes); typing/cycling don't trigger it, so
the status line stays stale. **Phase 4 cannot be considered shipping
without this config.** Future setup-script work should add it
automatically. The proper fix (S6 seam to capture CC's debounced refresh
callback) is documented in REPAIR.md §Host quirks #4 as a follow-up.

### Known limitations / follow-ups

- **Polling, not event-driven.** `refreshInterval: 1` polls the script
  every second. CPU load is negligible (<5ms per invocation) but it's
  not the architecturally clean answer. S6 seam (find the host's
  debounced refresh callback, expose it to runtime, call it from
  Statusline after each write) is the proper fix; deferred until needed.
- **`cueTip` and `cueControl` fields are null/false.** Statusline doesn't
  yet plumb the cue-map lookup. The script's tip-display path is dormant
  until ConfigLoader → Statusline wiring lands. Trivial follow-up.
- **`_debug` field absent.** v1 included a kitchen-sink `_debug` block
  for the consumer to see runtime internals. Phase 4 omitted it; can
  add if useful for debugging the harness.
- **No multi-instance test.** Two simultaneous `claude-cues` should
  write to different files (path is per-PID), but I haven't verified
  the script picks the right PID when CC has spawned children.

---

## Phase 4.5 — S6 seam (event-driven statusline refresh)

**Goal:** Statusline updates immediately on navigation/cycling instead of
polling once per second. Removes the `refreshInterval: 1` requirement
from `~/.claude/settings.json`.

### What to check

1. **`packages/opencues-runtime/adapters/claude-code/v2.1/seams.ts`** —
   `findStatusLineRefresh` predicate. Matches the React useCallback that
   wraps a 300ms `setTimeout` to call the actual refresh function. 3
   tests covering canonical shape, identifier rename, and no-match.

2. **`packages/opencues-runtime/src/modules/statusline.ts`** — `Statusline`
   ctor accepts an optional `refreshHook`. Called inside the `writeFile`
   `.then()` so refresh fires only after the file is on disk (not before).

3. **`adapters/claude-code/v2.1/boot.ts`** — `HostInfo.refreshStatusline`
   is plumbed through to `Statusline`'s `refreshHook` option.

4. **`integrations/claude-code/patches/opencuesRuntime.ts`** —
   - Inline S6 detection (vendored copy of `seams.ts` predicate).
   - **S6 is OPTIONAL** — if the regex misses, the patch logs a warning
     and continues. Statusline still works in polling mode if the user
     sets `refreshInterval` in settings.json. This means a future CC
     bump won't break the patch over S6 alone.
   - S6 injection appends `,__oc_ts6=(globalThis.__oc_refreshHostStatusline=k)`
     to the matched `let` declaration (comma-operator trick to extend
     the existing chain without disrupting it).
   - `host.refreshStatusline` is a closure that calls
     `globalThis.__oc_refreshHostStatusline` (no-op until the React
     component containing S6 has rendered).
   - **Apply order updated to descending positions** (S6 > S3 > S1 in
     v2.1.110) so each injection leaves earlier indices valid.

### Setup change

`~/.claude/settings.json` no longer needs `refreshInterval`:
```json
{
  "statusLine": {
    "type": "command",
    "command": "/home/<user>/.claude/highlight-statusline.sh"
  }
}
```

### Live verified

Status line updates within ~300ms (the host's debounce window) of any
Ctrl+Alt+Left/Right or Ctrl+Alt+Up/Down. No polling, no stale state.

### Known limitations / follow-ups

- **`Statusline.refreshHook` is the only consumer of S6 today.** If
  another module ever needs to trigger a host-side refresh, expose the
  binding more generally (e.g. as an adapter method).
- **S6's behaviour is `useCallback`-shape-specific.** If CC swaps to a
  different debounce mechanism (e.g. a custom `Wn(callback, 300)` wrapper
  or a hook), the regex needs updating. Keep one fixture per known
  shape in `seams.test.ts` so regressions surface immediately.

---

## Going forward — see parity.md

Phases 0–5 ship the runtime spine + the most common path features
(navigation, visible highlight, static cycling, statusline + tips, TTS).
**That's about 4 of v1's 38 steps fully ported.** A lot of breadth is
still missing — cue-controls, blank-fill (8 sub-steps), LLM resolver
path, span infrastructure, selector/satellite, real ConfigLoader
(currently only loads `claude-code-tips.json`, not `cues.md` /
`controls.md` / `opencues.md`).

The full audit + suggested order lives at
`integrations/claude-code/reintegration/parity.md`.

Reading order when picking up cold: `refactor.md` → this file → recent
commits (`git log --oneline -10`) → `parity.md` for the v1 backlog →
`REPAIR.md` for the host quirks list.
