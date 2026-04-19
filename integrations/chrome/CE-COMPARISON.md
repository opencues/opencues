# Chrome ext — original vs runtime port (feature parity matrix)

Single page mapping every feature the standalone Chrome extension
ships today against the runtime + chrome adapter band that's about to
replace it. Goal: prove the runtime can support every feature
*before* I delete the existing engine.

## Scope decision

**Linked words is intentionally excluded** — you said you haven't
nailed down the design yet, so neither the runtime nor the chrome
port currently implements it. Will revisit when you have an
opinion. Tracked at the bottom of this doc.

## Inventory

Feature numbers come from
`integrations/chrome-extension/docs/chrome-extension-progress.md`
(23 verified working as of 2026-04-15). For each:

- **Runtime module** — which `packages/opencues-runtime/src/...`
  module owns the logic.
- **Chrome boot wiring** — line in
  `packages/opencues-runtime/adapters/chrome/v1/boot.ts`.
- **Runtime tests** — what's covered in vitest today.
- **Status** — ✅ ready, ⚠️ wired but needs CE.x phase to migrate
  content.ts, ❌ explicit gap (linked words).

| # | Feature | Runtime module | Chrome boot | Tests | Status |
|---|---|---|---|---|---|
| 1 | Build | n/a (esbuild) | n/a | n/a | host-side |
| 2 | Load extension | n/a (manifest) | n/a | n/a | host-side |
| 3 | Popup config | n/a (extension UI) | n/a | n/a | host-side |
| 4 | Target element (contenteditable) | n/a — host adapter binds DOM | bindings.getText/setText | n/a | host-side |
| 5 | Visual cues (dimming) | `src/modules/dim-render.ts` | boot.ts:174 | dim-render.test.ts (12) | ⚠️ CE.3 |
| 6 | Navigation (Ctrl+Alt+Left/Right) | `src/modules/navigation.ts` | boot.ts:171 | navigation.test.ts (15) | ⚠️ CE.2 |
| 7 | Cycling (Ctrl+Alt+Up/Down) | `src/modules/cycling.ts` | boot.ts:177 | cycling.test.ts (22) | ⚠️ CE.4 |
| 8 | Escape (clear highlight) | `src/modules/navigation.ts` (escape handler) | implicit via Navigation | navigation.test.ts | ⚠️ CE.2 |
| 9 | Clear on typing | `src/modules/navigation.ts` onTextChange | implicit | navigation.test.ts | ⚠️ CE.2 |
| 10 | Status bar | `src/modules/statusline.ts` + `onSnapshot` hook | boot.ts:185 (gated on hook) | statusline.test.ts (16) | ⚠️ CE.6 |
| 11 | TTS (Web Speech) | `src/modules/tts.ts` + `speakFn` option (NEW: `2faf0ff`) | boot.ts:208 (gated on speakFn) | tts.test.ts (16, incl. 4 speakFn cases) | ✅ wired CE.0 |
| 12 | Instant tips (sync lookup) | `src/modules/dim-render.ts` reads `cueMap` synchronously | implicit | dim-render.test.ts | ⚠️ CE.3 |
| 13 | Multi-word spans | `src/state/span-fill.ts` + `Cycling`/`DimRender` span branches | boot.ts:166 | span-fill.test.ts + cycling.test.ts span cases | ⚠️ CE.4 |
| 14 | Blanks (math `2+2=_`) | `src/modules/blank-fill.ts` step pattern | boot.ts:181 | blank-fill.test.ts step cases (~20) | ⚠️ CE.8 |
| 15 | Weather control | `src/modules/blank-fill.ts` async script + new `controlInvoke` (NEW: `fc5a9a3`) | boot.ts:181 + adapter.controlInvoke | blank-fill.test.ts controlInvoke case | ⚠️ CE.8 |
| 16 | Stocks control | same path as weather (controlInvoke) | same | same | ⚠️ CE.8 |
| 17 | Hackernews control | same path (multi-line stdout → list alts) | same | blank-fill.test.ts list alt cases | ⚠️ CE.8 |
| 18 | Prompt improver (consume-all) | `src/modules/blank-fill.ts` `blankConsumeAll` branch | same | blank-fill.test.ts consume-all cases | ⚠️ CE.8 |
| 19 | Volume control | `src/modules/cycling.ts` runScriptControl + controlInvoke | boot.ts:177 + adapter.controlInvoke | cycling.test.ts (22, incl. 2 controlInvoke cases) | ⚠️ CE.4/CE.8 |
| 20 | Selector/satellite | `src/state/selector-satellite.ts` + cycling/blank-fill branches | boot.ts:167 | cycling.test.ts selector/satellite cases | ⚠️ CE.4/CE.8 |
| 21 | Hot-reload (popup → re-bootstrap) | `src/modules/config-loader.ts` debounced reload + `applyOpenCuesScalar` | boot.ts:155 | config-loader.test.ts | ⚠️ CE.5 |
| 22 | Input swapping (textarea/input) | n/a — explicitly out of scope per original ext | n/a | n/a | host-side / N/A |
| 23 | CORS fallback (background proxy) | n/a — chrome adapter's `httpAdapter` (FetchHttpAdapter) is host-side | host wires `httpAdapter` to runtime via `boot.ts` HostInfo.httpAdapter | resolver.test.ts (httpAdapter override path) + chrome boot.test.ts (Resolver-with-httpAdapter case) | ✅ wired CE.0 |

Linked-word counterpart (scope-deferred):

| - | Linked words | not yet in runtime | n/a | n/a | ❌ deferred (your call) |

## Runtime additions made for the chrome port

Three runtime API additions landed before the chrome port starts.
They're additive — OpenCode keeps working without them.

| Commit | Add | Why |
|---|---|---|
| `2faf0ff` | `TTSOptions.speakFn?(text, rate)` + scriptPath optional | Sandboxed hosts can't spawn bash + speak.sh. Web Speech routes through a host-supplied function. |
| `fc5a9a3` | `HostAdapter.controlInvoke?(spec)` + `'control-invoke'` capability + `Cycling.invokeOrSpawn()` helper | Chrome controls (Volume via Web Audio, Stocks via Finnhub, etc.) need a non-spawn dispatch. Falls through to `spawnProcess` when host returns null. |
| `07d7719` | Chrome boot wires TTS + CursorStateExport + `httpAdapter` flow | Adapter band now reaches every runtime module the original ext used. |

## What the chrome adapter band currently provides

`adapters/chrome/v1/boot.ts` constructs:
- 6 state classes (HighlightState, DynDefs, ControlValuesCache, SpanFillState, DismissedBlanks, SelectorSatelliteState)
- Navigation, DimRender, Cycling, BlankFill (all subscribed)
- ConfigLoader (subscribed; chrome.storage-backed via host.readFile/writeFile)
- Statusline (gated on `host.statusSnapshotHook` — chrome has no filesystem)
- Resolver (gated on `host.llmApiKey`; takes `httpAdapter`)
- TTS (gated on `host.speakFn`)
- CursorStateExport (gated on `host.cursorStatePath`)

Drift guard is observe-only from day one (mirrors OpenCode's
post-`2c92699` state). Debug logs gated on `opencues.md debug-mode`
via the same `isDebugEnabled` pattern as OpenCode.

## When you're home — verification checklist

Order matters: verify in this sequence so each step builds on the
last. Stop at the first failure and tell me what you saw.

### 1. Runtime smoke
```bash
cd ~/opencues/packages/opencues-runtime
npx vitest run
```
Expect: 281 tests, all green. (278 from before + 3 new chrome
boot wiring tests.)

### 2. OpenCode regression
The runtime additions are additive; OpenCode shouldn't notice.
```bash
cd ~/opencode-cues && bun run dev
# Type: 0.5f, navigate to it, Ctrl+Alt+Up → 1.0f
# Type: volume _ → 50%, Ctrl+Alt+Up → 60%
# Type: weather _ → forecast appears
# Type: improve prompt write me a poem _ → improved version
```
Expect: every O.8 feature still works. If any regress, the
controlInvoke wiring in cycling.ts may have broken a CLI path.

### 3. Chrome port readiness — the contract is testable
The chrome port itself isn't done (CE.1+ is unstarted). But the
runtime+adapter contract for it is locked in:
```bash
npx vitest run adapters/chrome
```
Expect: 10 tests, all green. Covers boot return shape,
no-spawn-process invariant, Navigation subscribed, statusSnapshotHook
firing, Resolver gated on llmApiKey, TTS smoke wiring, CursorStateExport
smoke wiring, Resolver-with-httpAdapter no-load-failure.

### 4. Tests for runtime additions specifically
```bash
npx vitest run src/modules/tts -t speakFn
```
Expect: 4 tests pass — speakFn preferred over spawn, works without
scriptPath, throws swallowed, opencues.md tts-rate flows through.

```bash
npx vitest run src/modules/cycling -t controlInvoke
```
Expect: 2 tests pass — selector path uses controlInvoke when
stubbed, falls through to spawn when not.

```bash
npx vitest run src/modules/blank-fill -t controlInvoke
```
Expect: 1 test passes — controlInvoke preferred over spawnProcess
for async script gets.

### 5. CE-PORT-PLAN sign-off
Read `integrations/chrome-extension/CE-PORT-PLAN.md`. The 5 open
questions there still need your call before I touch the extension's
content.ts (CE.1 onwards). Specifically:

1. Phase scope (any merging/splitting)?
2. Test strategy per chrome phase (parity with OpenCode's per-phase
   tests, or trust the manual checklist)?
3. Phase order (current is "smallest blast radius per commit")?

I picked judgement-call defaults for the runtime additions
(landed as separate commits before chrome touches), but the
content.ts migration order is yours to call.

## Confidence summary

- ✅ **Runtime supports every documented chrome feature except linked
  words.** Three additions made (speakFn, controlInvoke, chrome boot
  TTS+CursorStateExport).
- ✅ **278 + 3 = 281 runtime tests cover the contract.** Specifically:
  - 16 TTS tests (incl. 4 new speakFn)
  - 22 cycling tests (incl. 2 new controlInvoke)
  - 68 blank-fill tests (incl. 1 new controlInvoke)
  - 10 chrome boot tests (incl. 3 new wiring smoke)
  - existing runtime modules unchanged
- ⚠️ **CE.1..CE.9 migration of content.ts is unstarted.** The runtime
  is ready; the extension hasn't been rewired yet. That's the next
  multi-day effort once you sign off on the plan.
- ❌ **Linked words: deferred.** Out of scope per your call.

## Questions I'd ask before I start CE.1

(Same as the open questions in CE-PORT-PLAN.md, just shorter.)

1. **OK to default-yes on per-chrome-phase tests?** Costs ~30 min
   per phase, catches regressions early.
2. **OK to land runtime-side additions as separate commits if any
   come up mid-port?** Same pattern as the three above.
3. **Phase order: current plan is straight CE.1→CE.9, ConfigLoader
   migrates LAST. Acceptable, or want ConfigLoader earlier?**

If you say "use your judgement" again I'll proceed with: yes-tests,
yes-runtime-as-separate-commits, current order.
