# Chrome extension → opencues-runtime port plan

Single-page roadmap for swapping the extension's bespoke engine
(`src/core/cue-engine.ts` + `src/ui/word-navigator.ts` + `src/ui/`
+ blank logic in `src/content.ts`) for the host-agnostic
`opencues-runtime` modules. Mirrors the O.0..O.8 phasing we used for
OpenCode.

## Why bother

The extension works (23 features verified Apr 2026). It duplicates
~600 lines of logic the runtime already owns — Navigation, Cycling,
BlankFill, Resolver, Statusline, ConfigLoader, all six state
classes. New runtime fixes (drift guard tweaks, async-render fix,
LF-1..LF-8) currently land in the OpenCode adapter band only; the
Chrome extension stays frozen at its forked snapshot of the same
ideas. Consolidation = fewer divergent bug fixes, easier feature
work (cursor-navigate, span fills, etc.).

## What's done

**CE.0 — adapter band scaffold** (`f1dcfc6`)
- `packages/opencues-runtime/adapters/chrome/v1/adapter.ts`
- `packages/opencues-runtime/adapters/chrome/v1/boot.ts`
- `packages/opencues-runtime/adapters/chrome/v1/boot.test.ts` (7 tests, all pass)
- No content.ts changes; the band ships unused.

## Phase plan

### CE.1 — Bootstrap alongside existing engine
**Goal:** Have `content.ts` call `boot(host)` from
`opencues-runtime/dist/adapters/chrome/v1/boot` once on injection. The
existing CueEngine keeps running. We just verify the runtime starts
clean inside a content-script context.

**Files to add/edit:**
- `integrations/chrome-extension/src/opencues-bootstrap.ts` — new file:
  builds `HostInfo` from browser APIs + `chrome.storage`, calls
  `boot()`, exposes `dispatchKey/notifyTextChange/dispose` for
  content.ts to invoke.
- `integrations/chrome-extension/esbuild.config.mjs` — add
  `opencues-runtime` to the bundle (it lives at
  `packages/opencues-runtime/dist/`; esbuild `external: []` and a path
  alias should be enough since the runtime is already plain ES modules).
- `integrations/chrome-extension/src/content.ts` — call
  `startOpenCuesRuntime()` from existing init; forward keydown +
  textChange to the bootResult alongside the existing handlers (no
  removal yet — both run in parallel).

**Risks:**
- Bundling: `opencues-core` lives in `packages/opencues-core/`. The extension
  already imports it via the workspace; adding `opencues-runtime`
  should follow the same pattern. Confirm the dist files are pure ES
  modules (no `node:fs` imports) — already audited; only the resolver's
  optional `opencues-core/node-http-adapter` is Node-only and is gated.
- Polyfill: `process.env` is referenced by some modules' default
  fallbacks. esbuild already does build-time defines for the existing
  code; extend the same to `process.env.HOME`, `process.env.DEBUG_OPENCUES`
  → empty strings.

**Live test:** Reload extension. Open ChatGPT (or any contenteditable
site). Open devtools console — should see `[opencues] OpenCues
runtime starting (Chrome v1)`. Existing features still work.

**Commit message:** `feat(chrome): CE.1 — runtime boots alongside CueEngine`

### CE.2 — Replace WordNavigator with runtime Navigation
**Goal:** Ctrl+Alt+Left/Right go through `Navigation`, not
`WordNavigator`. Highlight state lives in runtime's `HighlightState`,
which the renderer reads via `bootResult.collectRenderDirectives()`.

**Files to edit:**
- `src/content.ts` — strip the keydown handler's left/right branches
  (move to runtime via `dispatchKey`). The render call changes from
  reading `engine.activeWordIndex` to reading directives.highlight.
- `src/ui/highlight-renderer.ts` — accept a directives bag instead of
  `engine` + `activeWordIndex`. Translate `directives.highlight` →
  `Range` + push to CSS Highlight API.
- `src/ui/word-navigator.ts` — keep alive for cycling (CE.4), strip
  navigateLeft/navigateRight.

**Risks:**
- Range mapping. The runtime gives plain-text offsets; the
  contenteditable's text node tree may not map 1:1. `src/ui/highlight-renderer.ts`
  already has helpers for this; reuse them.
- Selector/satellite navigation paths in the existing navigator must
  stay until CE.7+ (state classes wired then).

**Live test:** Ctrl+Alt+Left/Right cycles the active highlight on
ChatGPT. Status bar still updates from old engine.

**Commit message:** `feat(chrome): CE.2 — Navigation via runtime`

### CE.3 — Replace HighlightRenderer dim path with runtime DimRender
**Goal:** The "dim words that have alts" + "active word bright" tiers
come from `DimRender.collectRenderDirectives()` instead of computed
in `highlight-renderer.ts`.

**Files to edit:**
- `src/ui/highlight-renderer.ts` — render `directives.dimRanges` +
  `directives.highlight` ranges. Remove the engine.words
  walk-and-classify logic.
- `src/content.ts` — render-trigger path: on each text/keystroke
  change, call `bootResult.collectRenderDirectives()` and feed result
  to renderer.

**Risks:**
- The CSS Highlight API needs explicit `Range` objects (Web standard).
  Mapping plain-text offsets → DOM `Range` for a contenteditable that
  may have nested spans is the tricky bit. Existing code does this
  already; just route the offsets from a different source.

**Live test:** Cue words look the same as before (mid-gray vs
bright-white) but the source is now runtime.

**Commit message:** `feat(chrome): CE.3 — DimRender via runtime`

### CE.4 — Replace WordNavigator.cycle with runtime Cycling
**Goal:** Ctrl+Alt+Up/Down rotates alts via `Cycling.handleKey`.
Multi-word spans, linked words, dismissible alts all routed through
the runtime.

**Files to edit:**
- `src/content.ts` — strip up/down handler.
- `src/ui/word-navigator.ts` — DELETE (or shrink to nothing).
- `src/ui/highlight-renderer.ts` — read alt index from
  `directives.highlight` text instead of `engine.words[i].currentAltIndex`.

**Risks:**
- Cycling calls `adapter.setText(newText)` to commit. The
  contenteditable's `textContent` setter blows away the cursor; need
  to re-set cursor offset after, which `setCursorOffset` does — verify
  the chrome adapter's setCursor implementation handles range
  boundaries correctly across nested elements.

**Live test:** `volume _` → cycles 50% → 60% → 70% via runtime
Cycling. Multi-word affirmations cycle as a single unit.

**Commit message:** `feat(chrome): CE.4 — Cycling via runtime`

### CE.5 — ConfigLoader on chrome.storage
**Goal:** The runtime's ConfigLoader becomes the source of truth for
cues.md / blanks.md / opencues.md / blanks.md. The popup writes to
`chrome.storage.local` with keys matching the virtual paths
(`/chrome-storage/cues.md`, etc.); the chrome adapter's `readFile`
implementation reads from `chrome.storage.local.get()` keyed by path.

**Files to edit:**
- `src/opencues-bootstrap.ts` — wire `readFile/writeFile/readDir` to
  chrome.storage.
- `src/popup/popup.ts` — write-side keys updated to match virtual
  paths the runtime expects.
- `src/core/parse-config.ts` — DELETE (runtime ConfigLoader replaces).
- esbuild defines that bake in `cues/*.md` + `controls/*.md` at build
  time → reformulate as a `readDir` shim that returns the baked
  manifest (since chrome can't enumerate "files").

**Risks:**
- The build-time bake is currently a string concatenation. Move to a
  JSON manifest the bootstrap reads at startup and serves via the
  adapter's `readDir`.
- Hot-reload: today the extension reloads via `onConfigChange` →
  re-bootstrap. Runtime ConfigLoader has its own debounced reload
  path; align the two so popup save still picks up immediately.

**Live test:** Edit cues.md in popup, save. Type a cue word — runtime
sees the new alt without reloading the tab.

**Commit message:** `feat(chrome): CE.5 — ConfigLoader on chrome.storage`

### CE.6 — Statusline + TTS
**Goal:** Replace `src/ui/status-bar.ts` with a `statusSnapshotHook`
that updates a SolidJS-style signal feeding the existing floating div.
TTS routes through runtime's TTS module (which currently uses
spawnProcess) — needs an extension point.

**Files to edit:**
- `src/ui/status-bar.ts` — accept `StatuslinePayload`, render its
  `cueTip` + `currentAltIndex/alts.length`. Remove the engine reads.
- `src/opencues-bootstrap.ts` — wire `statusSnapshotHook` to invoke
  the new status-bar render.
- **Runtime change required:** TTS module currently spawns a script.
  Add a host-supplied `speakFn?(text: string, rate?: number): void`
  option to TTSOptions; when set, use it instead of `spawnProcess`.
  This is one or two lines in `tts.ts` and unblocks both Chrome and
  any future host without OS-level audio.
- `src/opencues-bootstrap.ts` — pass `speakFn: (text, rate) =>
  webSpeechAdapter.speak(text, rate)`.
- `src/adapters/web-speech-adapter.ts` — keep as-is, just make sure
  it exports a `speak()` function the bootstrap can pass directly.

**Risks:**
- The TTS module's gating on `voice-mode === 'inactive'` already
  works (we verified in OpenCode). Should transfer cleanly.
- `cueTip` shape must match what the existing status-bar renders.
  The runtime payload shape is documented at `statusline.ts:33`.

**Live test:** Active highlight on a cue word triggers Web Speech.
`voice-mode: inactive` in opencues.md silences it. Footer/status div
shows tip text.

**Commit message:** `feat(chrome): CE.6 — Statusline + TTS via runtime`

### CE.7 — Resolver via runtime
**Goal:** Replace the `CueEngine.resolve()` LLM path with runtime's
Resolver module. The existing `FetchHttpAdapter` is passed via
`httpAdapter` option (already wired in CE.0's boot.ts).

**Files to edit:**
- `src/core/cue-engine.ts` — strip the resolver lifecycle (createResolver,
  scheduleResolve). Keep only what remains uncovered (tips lookup
  cache? probably nothing).
- `src/opencues-bootstrap.ts` — pass `llmApiKey, llmEndpoint,
  llmDefaultModel, httpAdapter: new FetchHttpAdapter()`.

**Risks:**
- The existing engine has a 3-tier analysis cascade (50ms after
  space / 50ms after edit / 300ms idle). The runtime Resolver only has
  one debounce (`debounceMs`, default 500). If the cascade gives
  measurably better UX, port it as part of the runtime Resolver
  rather than keeping a parallel implementation here.
- Test the LLM endpoint (Groq) returns alts via the runtime path —
  parser format may differ slightly; the existing
  `FetchHttpAdapter` does some normalization (space → pipe in
  index-prefixed responses) that the runtime expects in opencues-core.

**Live test:** Type "the cat sat on a mat", pause ~500ms, see dim
appear on the cue words. Cycle one and verify alt comes from LLM.

**Commit message:** `feat(chrome): CE.7 — Resolver via runtime`

### CE.8 — BlankFill via runtime
**Goal:** Replace `checkBlanks()` (the ~300-line block in content.ts)
with runtime's BlankFill module. Async script paths (stocks, weather,
HN, prompt-improver) need a different routing in Chrome since
`spawnProcess` is unavailable.

**Files to edit:**
- `src/content.ts` — DELETE checkBlanks. The runtime's BlankFill is
  triggered automatically via the `_` keystroke through `Cycling`'s
  key dispatch.
- `src/blanks/*` — chrome controls (volume, stocks, weather, HN,
  prompt-improver) are currently called directly from `checkBlanks`.
  They need a different entry point. Two options:
  1. **Route via `pushText`** — the chrome adapter intercepts certain
     "spawn" requests and returns the result via pushText. Hacky.
  2. **Add a `controlGet?(controlName, args)` host capability** to
     the runtime's ControlValuesCache + BlankFill. Cleaner; lets any
     host (Chrome, future Electron) provide native control impls.
- (Runtime change) Probably option 2 — a small extension to
  ControlValuesCache + a new `controlGet` HostAdapter method, falling
  back to spawnProcess when absent.

**Risks:**
- The runtime change is the only place where Chrome forces a runtime
  API extension. Worth doing because every non-CLI host (Chrome,
  Electron, future browser-only TUI) hits the same wall.

**Live test:** `volume _` → 50%. `weather _` → forecast. `improve
prompt write a poem _` → improved version. All via runtime BlankFill.

**Commit message:** `feat(chrome): CE.8 — BlankFill via runtime`

### CE.9 — Cleanup
**Goal:** Delete duplicated code now that the runtime owns it.

**Files to delete:**
- `src/core/cue-engine.ts` (Resolver + state in runtime now)
- `src/ui/word-navigator.ts` (Navigation + Cycling in runtime now)
- Significant portions of `src/types.ts` (state types in runtime now)
- `src/core/parse-config.ts` (ConfigLoader replaces)

**Files that stay:**
- `src/content.ts` (thin bootstrap)
- `src/opencues-bootstrap.ts` (host bindings)
- `src/adapters/*` (FetchHttpAdapter, WebSpeechAdapter, ChromeStorageAdapter — runtime feeds on these)
- `src/blanks/*` (browser-native control impls — entry-point shape changes per CE.8)
- `src/popup/*` (UI for config — unchanged)
- `src/background.ts` (CORS proxy — unchanged)

**Live test:** Re-run all 23 features from
`docs/chrome-extension-progress.md`. Each should still work.

**Commit message:** `chore(chrome): CE.9 — drop duplicated engine`

## Open questions for you to answer first

1. **Scope** — happy with the CE.0..CE.9 cut? Anything I should split
   further or merge?
2. **Runtime-side changes** — CE.6 (TTS speakFn) and CE.8 (controlGet)
   touch the runtime, not just the chrome adapter. Both also benefit
   OpenCode. Want me to land these in the runtime under separate
   commits before touching the chrome side?
3. **Esbuild integration** — CE.1 needs the runtime in the bundle.
   Confirm the workspace already has `opencues-runtime` as a workspace
   reference, or do I need to add a build step that copies dist
   somewhere first?
4. **Test plan** — there's no automated test harness for the
   extension (manual test list at `docs/chrome-extension-progress.md`).
   Want me to write Vitest tests for the chrome adapter band as we go,
   like we did for OpenCode? Worth the time?
5. **Order** — straight CE.1→CE.9, or interleave (e.g. CE.5
   ConfigLoader before CE.2 Navigation, since later phases depend on
   it)? My current order optimises for "least breakage per phase",
   but ConfigLoader-first is technically more correct.

## Estimated effort

Rough sizing per phase, assuming the live tests pass first try:

| Phase | Lines added | Lines removed | Real-time |
|---|---|---|---|
| CE.1 | 200 (bootstrap+esbuild) | 0 | 1h |
| CE.2 | 30 | 80 | 1h |
| CE.3 | 30 | 100 | 1h |
| CE.4 | 30 | 200 | 1h |
| CE.5 | 80 | 200 | 2h |
| CE.6 | 100 (incl. runtime change) | 100 | 2h |
| CE.7 | 30 | 150 | 1h |
| CE.8 | 200 (incl. runtime change) | 300 | 3h |
| CE.9 | 0 | 500 | 1h |

Total ~13h. Practically a multi-day effort with live testing per phase.
