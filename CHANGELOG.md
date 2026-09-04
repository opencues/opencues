# Changelog

All notable changes to OpenCues will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed — Claude Code pin 2.1.206 → 2.1.236 (Anthropic `stable`); 2.1.243+ documented as blocked (`@opencues/claude-code` 0.2.11 → 0.2.12)

Both pins move together per the runbook: `current-pin` 2.1.236 + `tweakcc-pin` `371a5c46c` ("Prompts for 2.1.236"). All FOUR seams hit on 2.1.236 — including **S7 (RenderKick), which was missing on 2.1.206**, so `__oc_pushHostText` returns to the clean explicit-re-render path instead of the ZWS-toggle fallback (S6 remains gone since 2.1.150; statusline stays on interval polling). The § 4e system-prompt-pipeline disable anchor verified present at the new tweakcc commit.

Why not latest (2.1.260): CC **2.1.243+ builds with Bun code splitting** — a ~19KB entry stub importing ~1400 bytecode-carrying chunk modules. Our seam regexes survive (S1/S2/S3 verified present in a single chunk on 2.1.259) but the patch pipeline doesn't yet: upstream tweakcc has code-split concat support (#969) with two OPEN blockers — #978 (parse gate rejects the ESM entry chunk, every apply rolls back) and #979 (repack bloats the binary ~2× with duplicated chunks, config not applied) — plus an unverified text-vs-stale-bytecode execution question. `2.1.242` is the last pre-split version; the ceiling + re-validation checklist is documented in `compat.json://code-split-ceiling` and UPGRADING.md. 2.1.236 is Anthropic's `stable` dist-tag.

### Added — render-path observability so the viewport-slice bug class can never hide again (`@opencues/runtime` 0.38.2 → 0.38.3)

The viewport bug survived months of green suites because nothing could SEE paint: state assertions (defs/events/buffer) all passed, and the bridge dump's `render` hook *recomputes* directives against the full buffer — a different code path from production's slice-fed `applyRender`, so it stayed green while the real pipeline painted nothing. Three additions close the gap: (1) the event-bridge dump gains a **`lastRender`** block — the REAL render pipeline's most recent invocation (`textLen/sliceLen/viewportOffset/translated/handlerHits/rangeCount/painted`), wired from the CC band's `applyRender`; (2) **DimRender self-diagnoses** — when a compute pass returns nothing while a managed def's span is live in the ctx, a debug-level line names the span and the coordinate-space-mismatch class ("why isn't it grey?" becomes a one-line log answer, free when `debug-mode: off`); (3) the spans-and-cycling bugs table and status-line doc gain their rows. Companion scenario in the harness asserts `lastRender.viewportOffset > 0` + `rangeCount > 0` + `painted` on a 40-line transform — the exact observables that were structurally invisible before.

### Fixed — CC viewport scroll silently unpainted every span taller than the input zone (`@opencues/runtime` 0.38.1 → 0.38.2)

`draft email _` produced a correct multi-line rewrite whose span never went grey and looked unselectable. Root cause (reproduced identically on CC 2.1.206 and 2.1.236 — a runtime bug, not a host-version one): CC renders tall buffers through a **scrolled viewport**, and the S3 seam hands `applyRender` only the visible lines, while DynDef spans, highlight state and cue spans are all in full-buffer coordinates. The render ctx was built from the slice, so every scrolled span failed DimRender's stale-def guard (`defSpanLive` — the guard that stops dim leaking onto new text) and dropped its dim, inline note, and highlight. Short buffers fit the viewport, which is why every harness scenario and everyday transform looked fine.

Fix in the CC band (`adapters/cc/v2.1/viewport.ts` + `boot.ts:applyRender`): locate the rendered slice inside the full buffer (handles CC's one-space cursor-cell pad; ambiguity resolves toward the occurrence containing the caret), hand handlers the FULL text so spans validate, then translate every directive family (dim/markdown/colored ranges, highlight, inlineNote, the glimmer whole-buffer `textOverride`) back into slice coordinates, clipping off-screen ranges. No contiguous match (soft-wrap inserts, mid-render mutation) → pre-fix behaviour byte-for-byte. Pinned by `viewport.test.ts` + boot-level scenario tests (scrolled slice paints dim; pad-space handled; fully off-screen span paints nothing; fallback never throws); verified live on an isolated fork against the original `draft an email _` repro.

### Added — `opencues doctor` sweeps every CC project for dead statusLine scripts (`opencues` CLI 0.7.9 → 0.7.10)

A project-level `.claude/settings.json` statusLine SHADOWS the user-level one for CC sessions launched from that directory — and a stale entry (e.g. the retired `~/claude-code-cues` layout from before the compact-footprint move) means "no statusline, only in this one project", invisible to a cwd-scoped doctor run (Sep 2026: `~/testing` carried exactly this for three months). `cc-statusline.cjs` gains `commandScriptExists` (tri-state over shell command strings — absolute-path tokens stat'd, bare `$PATH` commands never judged) and `auditProjectStatuslines` (walks CC's own `~/.claude.json` project registry); doctor surfaces each dead entry as a warn row naming the directory, with the rewrite-vs-edit fix per whether the dead path is ours.

### Added — Cerebras `qwen-3.8-27b` first-class; `gemma-4-31b` deprecated by Cerebras (`@opencues/core` 0.56.1 → 0.57.0, `@opencues/runtime` 0.38.0 → 0.38.1, `opencues` CLI 0.7.8 → 0.7.9)

Cerebras shipped `qwen-3.8-27b` (probed live 2026-09-03 on `/v1/models`) and moved `gemma-4-31b` to Public preview (deprecated — still served, kept here for back-compat, no longer advised). qwen is now in cerebras's `knownModels`, selectable via the config menu, `blanks-llm-model: qwen-3.8-27b`, or natural language (`use qwen for blanks _` — new fluid-config alias at parity with `gemma`/`haiku`).

Wire shape: qwen is a **hybrid reasoning model** — it thinks by default when `reasoning_effort` is absent, so the `isReasoningModelName` gate now matches `qwen-3.8` and `model-thinking.ts` pins it to `low` (ceiling) / `none` (`max-thinking: off`) — the same forward-to-control trap zai-glm-4.7 taught us. Like gemma it 400s on the Predicted-Outputs `prediction` field; the existing capabilities allowlist already excludes it. Pinned by `llm-provider.qwen.test.ts`.

Same-session bench, 2026-09-03 (judge pinned groq gpt-oss-120b, parallel 4): **fluid-blank 137/137 (100%) at `low`, 274ms avg** — ties gpt-oss-120b (137/137 @ 288ms), beats gemma (136/137 @ 245ms); `none` drops to 135/137. **transform-blank 424/487 (87.1%) at `low`, 1153ms avg** — ties gemma (424/487 @ 413ms) for top accuracy, beats gpt-oss-120b (415/487 @ 531ms), but ~2× gpt-oss's latency on long rewrites. Verdict: recommended small-model pick (lookup-heavy configs especially); `gpt-oss-120b` stays the cerebras default. Raw runs: `tests/results/qwen-3.8-discovery/`.

Docs switched from gemma advice to qwen: `docs/guides/llm-providers.md`, `docs/architecture/{llm-routing,cerebras,max-thinking}.md`, `docs/features/max-thinking.md`, `defaults/blanks/model/BLANK.md`, `opencues models` hint (CLI 0.7.9). Runtime 0.38.1 is a test-only pin update (the `list models` line now includes qwen).

### Fixed — FluidBlank can WIPE a bare terminal lookup with no host field declaration (`@opencues/core` 0.55.2 → 0.56.0; `@opencues/dsh` 0.2.17 → 0.2.18 — inline bundle regenerated with this core)

`ffmpeg command to convert a video to web-ready mp4 _` used to always FILL — the ask stayed on screen and only `_` was replaced — because WIPE (replacing the whole field with the answer) required a host to declare the field `singleLine`, and no native host adapter does that; it's a browser field shape. The README's hero video claimed WIPE for exactly this case and was wrong.

The WIPE gate now has two independent checks instead of one: the existing `disposable` host declaration (unchanged), or — new — `bufferIsExactlyTheLookup` (the buffer is provably nothing but the query, no paragraph break) **combined with the model's own MODE vote**, with no host declaration required. Buffer-is-exactly-the-lookup alone isn't enough to fire WIPE: it's true for both a terse lookup ("capital of france _") and a compact factual sentence with a mid-span gap ("Water boils at _ degrees Celsius" — FluidBlank's own segmentation rule makes SPAN the whole buffer there too). Only the model's shape classification tells those two apart, and the deterministic floor is what makes trusting that vote safe — it already proves nothing else is in the buffer to lose before the vote is consulted, so the vote only picks which of two non-destructive splices applies. This is not the model-decides-alone heuristic that got retired in `f62dcd28` for flattening real documents; that one let the model authorize destroying content it might have misjudged with no floor underneath it at all.

Accepted tradeoff: a model that mis-votes WIPE on a copula/equation sentence ("the answer is _") now loses that sentence's phrasing in favour of the bare answer, same as it always could on a `disposable` field. Verified live against cerebras + groq (temp=0, seed=42): both correctly WIPE the ffmpeg case and the MODE_RULES worked example ("capital of france _"); both also vote WIPE on compact factual sentences like "Water boils at _ degrees Celsius", which MODE_RULES nominally routes to FILL — but that's benign here, not a regression, because of the fix below.

Full design + the compact-factual-sentence tradeoff table: [`docs/architecture/blank-sources.md`](docs/architecture/blank-sources.md) § WIPE gate.

### Fixed — FluidBlank's FILL splice duplicated the sentence on a restated-clause answer (`@opencues/core` 0.56.0 → 0.56.1)

Found while validating the fix above, against real provider output rather than a mock: `There are _ continents` answered with the full restated clause `There are 7 continents` (FluidBlank's own ANSWER RULE 5 tells the model to do this for a mid-sentence gap) — and FILL spliced that answer at just the `_` character, producing `There are There are 7 continents continents`. Confirmed live on both cerebras and groq, and reproduced directly against the resolver's real splice primitive (`applyMarkdownAwareSplice`), not just theorized.

Pre-existing bug, unrelated to and untouched by the WIPE-gate work above — FILL's splice range never changed until now. New `findRestatedClauseSpan` detects the shape deterministically: no model-vote trust needed, just a string check on whether the model's own answer echoes the verified span's prefix and suffix around `_`. When it does, the splice widens from the bare `_` character to the whole verified span (still tagged `FILL`, not `WIPE` — the ask outside the span, if any, survives); a bare-delta answer ("3", "Paris") is unaffected, and a span the model can't verify verbatim in the buffer falls back to the pre-fix behavior rather than risk a wrong range.

## [0.7.8] - 2026-08-29

### Removed — glimmer's real-write machinery deleted (`@opencues/runtime` 0.37.0 → 0.38.0, `@opencues/chrome` 0.2.199 → 0.2.200, `@opencues/dsh` 0.2.16 → 0.2.17 — inline bundle regenerated)

With the OpenTUI overlay mode live-verified on both hosts (entry below), the write-mode code is gone rather than dormant: `GlimmerRenderOptions.realWrite`, `_writeFrame`, the restore-on-cancel branch, `ActiveGlimmer.bufferedText`, `BuildSharedRuntimeOptions.glimmerRealWrite`, and the 9 write-mode tests. `locate()` simplifies to anchoring on `finalText` (the buffer is never written, so the landed text is always the anchor). `HostAdapter.markRuntimeWrite` stays — it's the general host contract for out-of-band buffer writers (blank-loading still uses the host-side reclassifier path), only its glimmer consumer died. `glimmer-realwrite-extension-plan.md` carries a superseded banner as the design record. Chrome band's dead `glimmerRealWrite: undefined` line removed (bundle bytes change → lockstep bump).

### Changed — glimmer goes display-only on OpenCode + shell: textOverride frames painted as an overlay, the buffer never holds a scrambled frame (`@opencues/runtime` 0.36.2 → 0.37.0, `@opencues/shell` 0.2.22 → 0.2.23, `@opencues/opencode` 0.2.16 → 0.2.17)

Real-write mode is retired on both OpenTUI bands. The bands now boot glimmer render-only (the CC/Gemini branch — no new runtime concepts), the 1:1-length `textOverride` frames flow out through `collectRenderDirectives`, and each host bootstrap diffs the frame against the true text and floats the scrambled slice as an absolute overlay box over the textarea — the inline-note overlay pattern generalized (shell: `app.tsx` signal + box; OC: `opencuesGlimmerOverlay` signal + a `setup.sh`-injected box in the patched prompt). Overlay geometry is cursor-anchored (OpenTUI exposes no offset→visual API): single-logical-line, caret-on-line, unwrapped-line guards, else the overlay simply doesn't paint and the real final text shows — the same graceful give-up chrome's engine uses.

What this deletes rather than manages: per-frame `setText` writes (~13/sec) with reclassifier marking, the per-frame extmark wipe/rebuild those writes forced, and the settle-restore races (submit/crash mid-frame). Pinned on both bands by a new render-only contract test (`boot.test.ts`: frames arrive as textOverride, `setText` is NEVER called, cancel stops the override); `BootResult.glimmer` exposed on both bands for tests/hosts. NOT yet live-verified on either host — the write-mode machinery in `glimmer-render.ts` stays until it is (see `docs/architecture/glimmer-opentui-overlay-plan.md` § sequencing).

### Changed — `glimmer-transition-ms` default 300 → 900 (`@opencues/core` 0.55.1 → 0.55.2, `@opencues/runtime` 0.36.1 → 0.36.2, `@opencues/chrome` 0.2.194 → 0.2.195)

The full slow decode becomes the default everywhere the scalar is absent or unrecognised: `parseGlimmerTransitionMs` fallback, the registry menu order, the shipped `defaults/OPENCUES.md` template, and the feature doc. Existing user files with an explicit value are untouched. (Chrome-specific note: a stale bake-time config snapshot in `dist/configs/` can shadow a newer `~/.cues/OPENCUES.md` when the chrome-host isn't connected — re-running `opencues install chrome` or `opencues sync chrome` refreshes the bake; the live chrome-host push makes edits land without either.)

### Added — `glimmer-transition-ms: 1500` (`@opencues/core` 0.55.0 → 0.55.1, `@opencues/runtime` 0.36.0 → 0.36.1, `@opencues/chrome` 0.2.188 → 0.2.189)

A fourth duration for the scramble-settle transition: `1500` ("Extended — a long, deliberate decode", ~21 frames at the 70ms tick), alongside the existing `300`/`600`/`900`/`off`. One registry value + the `parseGlimmerTransitionMs` allow-list + the feature doc; every host picks it up through the shared scalar, no per-host wiring.

### Added — glimmer returns to chrome as a host-owned CSS Highlight API animation (`@opencues/runtime` 0.35.3 → 0.36.0, `@opencues/chrome` 0.2.187 → 0.2.188)

The replacement for the real-write mode disabled in the entry below — a different mechanism, not a tuned retry. The scramble-settle transition on chrome is now played entirely by the host via the CSS Custom Highlight API (`integrations/chrome/src/highlight-glimmer.ts`): per-character `Range`s move between registered `Highlight` buckets whose rules displace glyphs (`text-shadow`), hide them (`color: transparent`), or decorate them. **The text DOM is never written** — managed editors (Lexical/ProseMirror/Quill/Draft.js) cannot see, revert, or record any of it; the undo stack is untouched; per-frame cost is O(animated span), never O(field). That is the structural property real-write lacked (its Gmail freeze was a cost-model problem, not a tuning problem).

Mechanism (developed + measured in `integrations/chrome/experiments/glimmer-highlight-scramble/` — NOTES.md and PERFORMANCE.md carry the full evidence): word-scoped permutation swaps (collision-free by bijection, no runtime overlap checks), offset-bucketed highlight registration (O(distinct-offsets), independent of span length), lazy phase-separated geometry (all layout reads before any style writes per tick — interleaving costs a forced reflow per word), and an appear-mode settle-front with tail scrambling over the configured `glimmer-transition-ms`.

Runtime seam: `GlimmerRenderOptions.playHostAnimation` — a band that provides it delegates the whole animation and the runtime generates no frames (no timer, no writes, no `textOverride`); takes priority over both existing modes; every other band is unchanged byte-for-byte. Threaded as `BuildSharedRuntimeOptions.glimmerHostAnimation` → chrome band `HostInfo.playGlimmer` → the bootstrap's engine binding. Chrome-side safety contract: the animation is destroyed on any real text change (baseline compare, so a managed editor's late write-echo of the same text does NOT cancel it), on focus change, and on runtime cancel; normal `<input>`/`<textarea>` and browsers without the Highlight API get no animation (never a real-write fallback); targets inside shadow roots get the stylesheet adopted into their root. Pinned by 6 new unit tests on the delegation contract (`glimmer-render.test.ts`).

### Fixed — glimmer's real-write mode froze Gmail tabs; disabled for chrome (`@opencues/runtime` 0.35.2 → 0.35.3, `@opencues/chrome` 0.2.186 → 0.2.187)

Shipped earlier this cycle (see "the answer glimmers in" below) with chrome explicitly flagged as "wired but not yet verified against its documented empirically-fragile write path." That risk materialized: reported live minutes after the reclassifier-TTL fix below shipped, as the whole Gmail tab freezing. User's own diagnosis nailed it — "the blinker is fine, it's the glimmer" — separating it cleanly from `BlankLoadingAnimator` (the loading spinner, unaffected) and pointing at the glimmer scramble-settle animation specifically.

Root cause (best available evidence — never load-tested against a real managed editor before shipping, only a lightweight synthetic e2e fixture page): glimmer's real-write mode fires up to ~13 `execCommand`-driven writes in under a second per landed substitution. Gmail's DOM reconciliation is heavy enough that a write's own echo can plausibly arrive later than the reclassifier's TTL expects — a late echo gets misclassified as a fresh user edit and re-triggers the resolver on the runtime's own output, which does more writes, which pushes echoes later still. That's the same runaway-loop failure class the source-reclassifier mechanism exists to prevent (see the entry below and the original May 2026 fix it was built for), coming back from a new angle.

Fix: `glimmerRealWrite` is now hard-disabled for chrome (`adapters/chrome/v1/boot.ts`) — forced `undefined` regardless of host capability, not just left unwired. OpenCode and shell are unaffected; both are independently live-verified and don't share chrome's `execCommand` write cost. Chrome falls back to no glimmer animation at all (matches its pre-this-cycle behavior — a landed substitution just swaps, no scramble) until real load-testing against Gmail/Lexical/ProseMirror/Quill with devtools performance profiling clears it for re-enable.

**The reclassifier TTL shortened by the entry below was reverted alongside it, out of caution** — not because it was independently confirmed guilty, but because shipping a second unverified guess while recovering from an incident is how incidents compound. With glimmer's write volume removed, 400ms may well have been fine on its own; that needs to be re-derived with real load-testing, not reasoned about under time pressure a second time. `tests/e2e/reclassifier-poison-ce.e2e.test.ts` is `test.skip`'d rather than deleted — it still accurately describes a real, live, currently-unfixed bug on chrome/Gmail (a bare `_` retry within 1.5s can still be silently swallowed there). Un-skip it once a properly load-tested fix lands.

### Fixed — a bare `_` retry on Gmail (and any contenteditable) could be silently swallowed for up to 1.5s — TTL fix shipped, then reverted (see entry above) (`@opencues/runtime` 0.35.1 → 0.35.2, `@opencues/chrome` 0.2.185 → 0.2.186)

> **This fix was reverted the same day** (chrome no longer overrides the TTL — see the entry above). Left here for the record: the bug this describes is real and still unfixed on chrome; the fix described below correctly solved it in isolation but shipped alongside an unrelated, more severe regression that forced a rollback of both.

Reported live on Gmail: fill a bare `_` in an empty compose body, clear it, retype `_` — nothing happens. Wait a beat and retry again and it works, which read like a rate limit. It wasn't one.

`sourceReclassifier` (`boot-common.ts`) stashes every runtime-authored write for `RUNTIME_WRITE_TTL_MS` (1500ms) so the DOM-echo events that write produces aren't misread as a fresh user edit and re-fire the resolver on the runtime's own output — necessary, because contenteditable's `execCommand`-driven echoes are genuinely `isTrusted: true` (unlike a plain `<input>`'s, which get dropped by an earlier gate regardless — the distinction the normal-input reclassifier-poison fix, issue #348, already relied on). `BlankLoadingAnimator`'s default bounce frame is the literal string `_`; on a short/empty field the spinner's own first frame write *is* `_`, stashed for the full 1.5s. Clear and retype bare `_` inside that window and the real keystroke reproduces the identical text, matches the stale stash, and gets reclassified `runtime` — silently dropped by the resolver.

1500ms is tuned for opencode's SolidJS echo lag (issue #306), not for chrome — chrome's `execCommand` echoes are near-synchronous DOM events; the *original* 250ms default already covered chrome's documented 50-200ms Gmail/Lexical/PM echo window with margin, before the opencode-specific bump made chrome collateral damage. `createSourceReclassifier` now takes a per-caller `ttlMs` (every other host keeps the unchanged 1500ms default); chrome passes a much shorter 400ms, restoring the original margin — long enough for its own multi-echo window (Gmail fires 2-4 input events per write, all within tens of ms), far too short for a real clear-and-retype to land inside.

New permanent regression test (`tests/e2e/reclassifier-poison-ce.e2e.test.ts`) mirrors the existing normal-input pin but for contenteditable — mutation-verified: an immediate clear-and-retype, no artificial wait, fails against the unfixed 1500ms-everywhere TTL and passes with chrome's 400ms override. Three new unit tests in `boot-common.test.ts` pin the `ttlMs` override contract directly. Full chrome e2e suite (24 tests) and runtime suite (2313 tests + 1 pre-existing unrelated expected-fail) both green.

### Fixed — the loading spinner no longer drags the cursor to buffer-start on OpenTUI hosts (`@opencues/runtime` 0.35.0 → 0.35.1)

Reported live: "when I put down the `_` my cursor moves, then after it renders the result it corrects." On OpenTUI (OpenCode, shell), `textarea.setText()` unconditionally resets `cursorOffset` to 0 as a side effect — confirmed via a raw `textarea.cursorOffset` trace. `BlankLoadingAnimator`'s two write paths (`_writeChar`, the per-frame spinner glyph write, and `_rescueDisplacedGlyph`, its self-heal path) call `setText` on every ~150ms animation tick and never restored the cursor afterward, so it visibly snapped to 0 on every tick for the whole wait — then jumped back once `BlankFill.commitText` set the real final position, reading as "moves, then corrects." `glimmer-render.ts`'s `_writeFrame` already carried the save-before/restore-after pattern for its own writes (added earlier in this cycle for real-write mode); both `blank-loading.ts` write paths now do the same, one fix in the shared module so every host benefits.

Live-verified in shell via a temporary per-write trace: 7 consecutive spinner-frame writes across a 432ms resolve window all held `cursor=22` before and after `setCursorOffset`, where the unfixed code held `cursor=0`. Mutation-tested at the unit level too — both new `blank-loading.test.ts` cursor-preservation cases fail against the reverted source and pass with the fix. Confirmed on OpenCode as well (same shared module, same final landed-cursor position). The fix is host-agnostic (`getCursorOffset`/`setCursorOffset` are both required `HostAdapter` methods) so it costs nothing on a host whose `setText` doesn't reset cursor.

**Chrome checked separately (`@opencues/chrome` 0.2.185, no version bump — test-only):** a new real-extension e2e test (`tests/e2e/blank-loading-cursor.e2e.test.ts`) drives a delayed fluid-blank fill through a live spinner and samples `selectionStart` throughout the resolve window — passes clean. Mutation-testing it turned up something worth recording: reverting this exact runtime fix and rebuilding, the chrome test **still passed**. Chrome's own `diffWriteText` (`opencues-bootstrap.ts`) already wraps every `setText` call — normal-input and contenteditable alike — with its own independent capture-before/restore-after of the cursor, regardless of the caller. So this OpenTUI-class bug structurally cannot reproduce on chrome's adapter layer, with or without today's fix; the new test is kept as an end-to-end pin of that observable contract (via chrome's own protection), not as evidence the runtime module's fix does anything there.

### Added — the answer glimmers in: a scramble-settle transition when a substitution lands (`@opencues/core` 0.54.0 → 0.55.0, `@opencues/runtime` 0.34.6 → 0.35.0, `@opencues/chrome` 0.2.184 → 0.2.185, `@opencues/opencode` 0.2.15 → 0.2.16, `@opencues/shell` 0.2.21 → 0.2.22; dsh bundle regen folded into the Removed entry at the top)

Until now a landed substitution just swapped: `capital of france _` became `Paris` between two frames. New `glimmer-transition-ms` scalar (Appearance; `off | 300 | 600 | 900`, default 300): when a fluid-blank answer, a transform-blank rewrite, or a keyword blank fill lands, the landed span first blinks, then churns through confusable glyphs — a letter only ever swaps within its own confusable group, so the text reads as *decoding* rather than noise — easing to the clean final text over the configured window. The animation is ported from the Glimmer extension prototype's scramble engine (`experiments/roi-debug/lib/scramble.js`).

**Two delivery modes.** Render-only (Claude Code, Gemini CLI): the buffer commits instantly, exactly as before — the animation lives entirely in the render pipeline (`RenderDirectives.textOverride`) with frames driven by bare `forceRender()` kicks; no `setText` per frame means no resolver re-dispatch, no AgentRewrite debounce reset, no ConfigLoader reload churn. Real-write (OpenCode, shell): hosts whose renderer never consumed `textOverride` now animate too — every frame is a real `setText` call, marked through the host's own source-reclassifier (the same mechanism the loading-animation spinner already uses) so it's classified `'runtime'` and doesn't poison the same three modules render-only mode sidesteps by never touching the buffer at all. Live-verified in both OpenCode and shell via the agentic test harness — a running OpenCode session's write trace shows the genuine blink → scramble → settle sequence, and shell confirms `glimmer: start` firing correctly (including picking up a hot-reloaded duration change mid-session). Chrome was wired the same way; **now hard-disabled there** after that exact fragile-write-path risk materialized as a tab freeze on Gmail — see "glimmer's real-write mode froze Gmail tabs" above. Both modes self-cancel the moment a user edit touches the landed span — the buffer is always the truth. For transform-blank's whole-buffer merge, only the *changed* region glimmers (prefix/suffix diff of what you saw vs what landed) — untouched prose stays rock-steady.

`off` reproduces pre-feature behaviour byte-for-byte on every host. Runtime-only knob — no spec change.

### Fixed — AgentRewrite's debounce and ConfigLoader's hot-reload check now ignore the runtime's own writes (`@opencues/runtime` 0.34.4 → 0.35.0)

Found while scoping the glimmer entry above: only `BlankFill` actually gated its `onTextChange` handler on `e.source === 'user'`. `AgentRewrite.scheduleTick()` and `ConfigLoader.maybeReload()` fired on every text change regardless of source — so any runtime write (a landed substitution, a loading-animation frame) reset AgentRewrite's debounce timer and spent a config-reload check, neither of which the write had anything to do with. `docs/architecture/agent-task.md` § Cadence already documented the debounce as "user-source `onTextChange`" — the code just didn't gate on it. Both now mirror BlankFill's existing gate; the background reload poll (unaffected) remains the safety net for OPENCUES.md edits made with no keystrokes at all.

### Fixed — the monorepo's shell build silently jumped to Babel 8 and broke (root `package.json`, no package version — build tooling only)

Root `package.json`'s `pnpm.overrides` pinned `"@babel/core": ">=7.29.6"` — a floor with no ceiling, originally meant to force a patched 7.x version. When Babel 8.0.1 shipped, pnpm's resolver satisfied that range with the new major release for every peer edge in the workspace, including `babel-preset-solid` (a `@opentui/solid` dependency `integrations/shell`'s bundler needs), which only supports Babel 7. `bun run bundle` in `integrations/shell` failed outright: "Requires Babel ^7.0.0-0, but was loaded with 8.0.1." Bounded the override to `">=7.29.6 <8.0.0"` — keeps the original security-floor intent, stops a future major bump from silently propagating across every peer-resolved package in the workspace again.
### Fixed — a replace no longer eats the space beside it (`@opencues/runtime` 0.34.5 → 0.34.6, `@opencues/chrome` 0.2.183 → 0.2.184, `@opencues/dsh` 0.2.15 → 0.2.16)

`replace-parse-mode` splices your value in where the old text was and consumes the imperative that asked for it. When something sat BETWEEN the two, the space that separated them went with the imperative:

```
her name is Sarha in the invite fix the spelling _
  →  her name is Sarahin the invite
```

And when the imperative came first, the words that followed it were moved behind the value rather than in front of it:

```
uppercase it _ the ticker is aapl
  →  AAPLthe ticker is
```

**Where you saw it.** Any correction made mid-sentence, which is most of them. It was invisible until now because the branch's only previous caller rewrote the whole body, so the target and the imperative were always touching and the gap between them was always just the one space.

The gap's two edges are no longer the same thing. The edge that touched the imperative goes with it; the edge that touched your text is a word boundary in text that survives, and stays. A gap of newlines is structure and is preserved as it always was.

### Fixed — chrome popup no longer silently disables the chrome-host integration, and its diagnostics stop lying about a dead host (`@opencues/chrome` 0.2.182 → 0.2.183)

Three related fixes to the popup's relationship with the native-messaging host, all found chasing one user report ("the chrome-host toggle vanished and *test api key* does nothing, but self-check passes"):

- **The defer force-off race is defused.** Opening the popup while the host port was momentarily down (MV3 worker waking cold, the 30-second reconnect window, a WSL restart) used to silently write `deferToChromeHost: false` — after which the service worker ignored every future host push and the next Save wiped the host-pushed keys and bundle. A transient blip became a persistently disabled integration with no error anywhere. Now the toggle stays visible, checked, and unpersisted with a hover explaining the host is reconnecting; only the user unticks it.
- **Self-check reports the LIVE port state.** The keys/bundle lines it prints are storage reads that persist from past connections, so a dead host still looked fully healthy. A new `chrome-host: connected / NOT connected` line distinguishes "host live" from "storage warm", and the disconnected form says explicitly that the stored keys/bundle do not prove the host is running.
- **`test api key` probes host-pushed keys too.** The popup deliberately never prefills host-forwarded keys into its inputs (that would invite copying secrets out of the host's env into popup storage) — but for most chrome-host users those are the *only* keys, so the button reported "no API keys entered" against a fully working runtime. Host-bag keys are now probed with a `(host)` label; values still never render, only the env name and HTTP status.
- **The `chrome://restart` requirement is finally written down.** Chrome on Windows reads the `NativeMessagingHosts` registry key at browser startup and caches it for the life of the browser process — registering the chrome-host while Chrome is running leaves every connection attempt failing against the stale cache, with nothing wrong on disk and an extension reload powerless to fix it (it restarts the service worker, not the browser process). The install-host success print now leads with the restart requirement, the popup self-check's disconnected advice names it, and the full debugging signature (dead port + correct artefacts + hand-driven `.bat` works + zero `[chrome]` log lines because the log relay routes through the very port that's down) is documented in `integrations/chrome/CLAUDE.md` and `docs/features/chrome-sync.md`.

### Added — `replace-parse-mode`: single-substring edits splice deterministically instead of whole-buffer merging (`@opencues/core` 0.54.0 → 0.55.0, `@opencues/runtime` 0.34.4 → 0.34.5, `@opencues/dsh` 0.2.14 → 0.2.15, `@opencues/chrome` 0.2.179 → 0.2.182)

New scalar, **on by default** (`replace-parse-mode: off` disables and saves the extra call). An imperative `_` ask ("her name is Sarha fix the spelling _") dispatches a small replace-detector LLM call **in parallel** with TransformBlank's fused call — zero added wall-clock, one extra small prefix-cached call per imperative `_`. When the detector identifies a single-substring replacement AND every claim survives the runtime's deterministic gate (command and target verified as verbatim buffer substrings, target unique outside the command, first-occurrence-safe), the result takes the resolver's bounded-splice path — text you didn't point at is structurally untouchable, and the diff is the two words that changed rather than a whole-buffer merge. Anything else — wrong shape, unverifiable claim, detector error — falls back to the fused merge exactly as before: the detector can only upgrade a dispatch, never degrade one.

The default was earned, not assumed: `tests/benchmarks/fluid-blank-replace/` (66 cases, driving the shipping prompt/parser/verifier from `@opencues/core` directly) shows gemma-4-31b at 100% class accuracy, 100% verified splices, **zero** fill→replace false positives, and **zero** under-application false positives on the dedicated transform-vs-replace boundary category — and every failure mode (wrong class, unverifiable claim, detector error, provider throttle) degrades to the fused path byte-identically. In the first live test the splice also *corrected* a fused mistake (`the ticker aapl in uppercase _` → fused rewrote the whole buffer wrong; the splice produced `the ticker AAPL`).

### Fixed — a note no longer quotes a whole paragraph when the script has no spaces (`@opencues/runtime` 0.34.3 → 0.34.4, `@opencues/chrome` 0.2.178 → 0.2.179, `@opencues/dsh` 0.2.13 → 0.2.14)

A note that lists what `_` walks back to shortens each stop to its first two words, so a whole-sentence rewrite identifies itself without being printed twice. The shortening splits on whitespace — and Japanese, Chinese and Thai do not write spaces between words, so the entire answer came back as one "word", the two-word guard never fired, and the note quoted the paragraph.

**Where you saw it.** Anywhere a note lists the stops: a chain of blanks ending in `translate to japanese _` put eight lines of Japanese into a note sitting under a five-line answer, longer than the thing it was annotating.

The length is capped as well as the word count, by code point rather than by string length — the latter counts UTF-16 units and would cut an emoji or a surrogate pair in half. English is unaffected: two words rarely reach the cap, so every existing note reads exactly as before.

## [0.7.7] - 2026-08-19

### Added — dsh serves company rules too (`@opencues/dsh` 0.2.12 → 0.2.13)

`RULES.md` reached the DeepSeek Harness: the plugin's node half now merges project rules (from the **session's** workspace — never the dsh server's own cwd, the same trap this integration fixed once for the watchlist key) and user rules into the same route the browser polls, using the same core parser and merge the native ingest uses — so the route cannot drift from what native hosts serve. Verified live in the composer: "mirror the customer table to us-east-1" draws `⚠ Customer data must stay in eu-west-1` from a project rules file, the compliant phrasing stays silent, project beats user, cross-file duplicates collapse, and user-scope rules serve even before the first session kick. Chrome stays out deliberately — no filesystem, and the security posture prefers it that way.

### Added — `kimi` provider: Moonshot AI's Kimi models via their direct API (`@opencues/core` 0.53.0 → 0.54.0, `@opencues/runtime` 0.34.2 → 0.34.3, `opencues` 0.7.6 → 0.7.7, `@opencues/chrome` 0.2.177 → 0.2.178, `@opencues/dsh` 0.2.11 → 0.2.12)

New `kimi` provider adapter talking to Moonshot AI's own OpenAI-compatible API (`api.moonshot.ai`) — distinct from the kimi-k2 copies hosted on Groq/OpenRouter, which use different model names. Catalogue + request shape verified against Moonshot's Aug-2026 docs: default model `kimi-k2.6` (thinking disabled for the inline latency floor; modern kimi models take `max_completion_tokens` and reject `temperature`), `kimi-k3` on the shortlist (always-thinking flagship, `reasoning_effort` coerced into its legal `low|high` set), legacy `moonshot-v1-*` still dispatches until its 2026-08-31 sunset; auth via `MOONSHOT_API_KEY` (works with `opencues set-key`); mainland-`.cn` platform reachable via an `llm-endpoint:` override. Valid in all three bucket scalars (menu-hidden until benched, like ollama/openrouter) and appended last to the auto-route order, so a lone Moonshot key auto-routes without outranking benched providers. No spec change — providers are reference-impl runtime knobs. Guide: `docs/guides/llm-providers.md` § Kimi.

### Added — DeepSeek provider (`@opencues/core` 0.52.0 → 0.53.0, `opencues` 0.7.5 → 0.7.6, `@opencues/chrome` 0.2.176 → 0.2.177, `@opencues/dsh` 0.2.10 → 0.2.11)

New built-in `deepseek` provider — OpenAI-compatible chat-completions at
`api.deepseek.com`, serving `deepseek-v4-flash` (default, the 0731 build:
284B MoE, 13B active, 1M context) and `deepseek-v4-pro`. Set
`DEEPSEEK_API_KEY` and select it per bucket, e.g. `blanks-llm-provider:
deepseek`. It appears in all three bucket menus (cues / auditors /
blanks) and flows into `opencues check-keys` and `set-key` automatically
via its `keyProbe`.

**Why:** it is the cheapest option in the matrix by a wide margin —
**≈$0.021 per 1K correct fluid-blank answers**, roughly 8× cheaper than
the previous best row. That comes from a measured 91% prefix-cache hit
rate on the production fused prompt (1024 of 1123 tokens) against
$0.0028/M cached vs $0.14/M uncached. Cost is computed from live `usage`
blocks, not estimated from prompt length.

Benchmarked across **seven surfaces** in one session against a
same-session `cerebras gpt-oss-120b` baseline: wins sentence-cues (100%
vs 97.1%) and transform-blank (85.8% vs 84.8%); ties agent-rewrite
(83.3%), next-prompt-cues (100%) and fluid-blank-ambient (99.4%); loses
fluid-blank (98.5% vs 99.3%) and fluid-config precision. Accuracy is a
wash; the trade is **latency — 1.6×–4× slower on every surface**, so it
is not viable for word-cues (~500ms budget) and is deliberately **not in
`PROVIDER_AUTO_ORDER`** (auto-route serves users who chose nothing; the
slowest provider is the wrong silent default). Full table +
category-level inversions in `tests/benchmarks/BENCHMARKS.md`.

Reasoning is on at DeepSeek's API default and OpenCues pins it **off**
via the standard `reasoning_effort: 'none'` path (no provider-specific
body field). `deepseek-*` doesn't match `isReasoningModelName`, so the
adapter opens the forward gate with `includeReasoningEffort: true` —
without it the field is silently dropped and the model reasons anyway, at
~2× the latency with no signal. Pinned `{ max: 'none', off: 'none' }` in
`model-thinking.ts` alongside the `zai-glm-4.7` / `gemma-4-31b`
precedent, with the bench trade recorded there (reasoning-on is worse on
short lookups and buys +2.7pp on long rewrites for 5.4× the latency).

Also corrects the `deepseek-v4-flash-free` row in the OpenCode Zen free-pool
table, which reads at 46.7% and is **not** representative of DeepSeek's own
API (98.5% on the same suite) — the Zen free tier serves something degraded.

### Fixed — the spelling mark stopped leading every word-cue (`@opencues/runtime` 0.34.1 → 0.34.2, `@opencues/chrome` 0.2.175 → 0.2.176, `@opencues/dsh` 0.2.9 → 0.2.10)

The inline note has one rule: an **emoji leads a notification** (something is
flagged) and a **bare count leads an improvement** (nothing is wrong, there is
just a better option). `inlineNoteText`'s plain-word-cue branch was
`if (!def.blankName)`, which catches EVERY word-cue and not only the spelling
one it was written for, so a legal or medical alternative was announced with
`✍️` - telling the reader their word was a mistake when a synonym was merely on
offer. `attorney → lawyer` is an improvement.

`WordDef` now carries `cueSource` (the producing cue's `CueResult.source`,
stamped where the resolver registers a word-cue def), and the mark is emitted
only for `spelling`. A def with no recorded source is treated as an improvement:
a note that fails to flag an error is a smaller lie than one that calls a
synonym a mistake.

Found while writing the cycling reference page, which had been documenting the
behaviour the docs describe rather than the behaviour the code had.

### Fixed — the loading animator no longer strands its glyph in the buffer (`@opencues/runtime` 0.34.0 → 0.34.1, `@opencues/chrome` 0.2.174 → 0.2.175, `@opencues/dsh` 0.2.8 → 0.2.9)

Type into a `_` slot while its blank is still in flight and the spinner character was left behind for good: `weather ▘!!`. The animator gives up whenever the slot's word stops being one of its frames — the documented behaviour, since the substitution path is expected to take the word — but it gave up *without putting `_` back*, so the blank it was animating could never resolve either. There was no `_` left to splice into. Two ways to reach it, both fixed:

**The user types beside the glyph.** The animator owns exactly one character, the frame it last wrote, so a slot now records it (`lastWritten`) and peels that single occurrence back out on give-up: `▘!!` → `_!!`, keeping the user's edit and the blank. Matching is on the exact character last written, never the frame set, because `bounce` and `flipper` frames are ordinary ASCII (`-`, `|`, `/`) and matching the set would rewrite a `-` the user typed themselves. Applies on the tick path and on `stop()`, which had the same hole.

**An edit before the slot shifts every word index.** The animator then watches the wrong word entirely while its glyph sits elsewhere, so neither the tracked word nor the give-up check ever sees it. A last-resort rescue scans the buffer, on two conditions that together make it unambiguous: the glyph is non-ASCII (the braille and custom marks, so `bounce`/`flipper` are excluded by construction) and it occurs exactly once. Anything less certain is left alone — a stray glyph is a blemish, rewriting a character the user typed is data loss.

Found on DeepSeek Harness, whose asynchronous composer writes widen the window, but the give-up path is host-agnostic and every host could hit it. Eight new `blank-loading.test.ts` cases cover both recoveries plus the three refusals (substitution took the word, ASCII frame, glyph appears twice); 91 pass in that file.

### Fixed — the loading animator no longer strands its glyph in the buffer (`@opencues/runtime` 0.30.3 → 0.30.4)

Type into a `_` slot while its blank is still in flight and the spinner character was left behind for good: `weather ▘!!`. The animator gives up whenever the slot's word stops being one of its frames — the documented behaviour, since the substitution path is expected to take the word — but it gave up *without putting `_` back*, so the blank it was animating could never resolve either. There was no `_` left to splice into. Two ways to reach it, both fixed:

**The user types beside the glyph.** The animator owns exactly one character, the frame it last wrote, so a slot now records it (`lastWritten`) and peels that single occurrence back out on give-up: `▘!!` → `_!!`, keeping the user's edit and the blank. Matching is on the exact character last written, never the frame set, because `bounce` and `flipper` frames are ordinary ASCII (`-`, `|`, `/`) and matching the set would rewrite a `-` the user typed themselves. Applies on the tick path and on `stop()`, which had the same hole.

**An edit before the slot shifts every word index.** The animator then watches the wrong word entirely while its glyph sits elsewhere, so neither the tracked word nor the give-up check ever sees it. A last-resort rescue scans the buffer, on two conditions that together make it unambiguous: the glyph is non-ASCII (the braille and custom marks, so `bounce`/`flipper` are excluded by construction) and it occurs exactly once. Anything less certain is left alone — a stray glyph is a blemish, rewriting a character the user typed is data loss.

Found on DeepSeek Harness, whose asynchronous composer writes widen the window, but the give-up path is host-agnostic and every host could hit it. Eight new `blank-loading.test.ts` cases cover both recoveries plus the three refusals (substitution took the word, ASCII frame, glyph appears twice); 91 pass in that file.


## [0.6.1] - 2026-08-16

### Changed — an inline note's `↳` points AT the span, not two cells left of it (`@opencues/runtime` 0.30.2 → 0.30.3)

The note line's indent aligned the MESSAGE under the flagged span, with the `↳ ` connector hanging in the margin to its left. It aligns the CONNECTOR now: the arrow lands on the value's first character. The reason is that a message's alignment depends on whichever character it begins with — an emoji's mark is drawn narrower than its cell and lands a fraction off, while a word lands on exactly — so the same note sat differently by message and by host. The connector is one glyph the renderer controls, so pointing IT at the span is stable, and it is the rule the artifact kit and opencues.com have used for a while: this closes a divergence rather than opening one. `applyDirectives` pads by `col` instead of `col - prefixCells`, and `inlineNoteBoxColumn` (the column the OpenTUI hosts float their overlay line at) returns the span's own column, so the terminal splice and the overlay hosts still land in the same place.

**Claude Code's first-line indent goes to 0 with it**, and the two errors it was cancelling are worth recording. `CC_INPUT_FIRST_LINE_INDENT` existed because the note is injected as a continuation line, which the comment said gets no `❯ ` prompt — so the pad added the prompt width back. CC's input box indents continuation lines too, so that addition and the connector's own two-cell subtraction cancelled: on screen the arrow already sat on the span and the message two cells past it, which is what CC has always shown and why nobody noticed the runtime was nominally message-aligned. With the subtraction gone the addition double-counted and the arrow moved two cells INTO the word. Zero is the honest value and it agrees with the OpenTUI hosts, which never had a compensation. Still overridable live with `OPENCUES_CC_NOTE_INDENT` for a host that really does indent only its first line.

Nine `dim-render.test.ts` expectations and five `render-directives.test.ts` ones pinned the old rule and now pin the new; 2245 runtime tests pass, with opencode (54), gemini-cli (23) and shell (45). Not a spec change — a rendering rule, no scalar.

## [0.6.0] - 2026-08-09

### Added — dismiss a cue from its own note (`@opencues/core` 0.42.7 → 0.43.0, `@opencues/runtime` 0.29.11 → 0.30.2, `opencues` 0.5.5 → 0.6.0)

Contradiction and sentence cues are on by default and passive, so a wrong or badly-timed one cost nothing to ignore once — and everything to ignore forever, because the only recourse was turning the whole feature off. A cue can now be silenced from the note itself, in **two grains**: `_` once mutes it for 30 minutes (in memory, lapses on its own, nothing written); `_` again within a 3s offer window forgets it (written to `<cues>/dismissals.json`, listed and reversible). The note teaches the gesture with `(underscore to dismiss)`. **The offer window is load-bearing**: a mute stops the note painting, so without it there would be nothing left on screen to press `_` on a second time and the forget grain would be unreachable through the UI (the first cut of this had exactly that hole, hidden by a scenario test that re-registered the def by hand between presses). For `FORGET_GRACE_MS` after the first press the note keeps painting with its hint replaced by `(muted · underscore again to forget)`, and Cycling claims `_` only while it is visible — so a muted cue never swallows a keystroke over an invisible note. The gesture is confined to a **pure advisory** — a `cueTip` def with nothing to cycle to (calendar clash, advisory contradiction verdict) — so `_` keeps meaning "cycle" wherever there are alternatives to walk, which is the answer for those cues. Enforced in three places, each covering what the others cannot: the gesture (`Cycling.stepUnderscore`, before the cycleable guard, so the `_` is consumed and never lands in the buffer), the paint (`DimRender`, covering defs registered before the dismissal), and registration (`Resolver`, which also keeps a dismissed cue off the secondary display).

**The key is the normalized TEXT, never a commitment id.** Ids (`c1`, `c2`, …) look like identities and are not: `buildSessionCommitmentsSnapshot` assigns them positionally on every write and `mergeSessionCommitments` emits fresh entries first, so one new decision renumbers the watchlist — verified on real snapshots, where the same decision is `c1` in one and `c5` in another. Keying on an id would silence whichever cue landed in that slot next tick. `dismissalKey` is pinned by test to `normalizeCommitmentStatement`, the normalization the merge and supersession passes already use, so the feature has one notion of "the same claim". Documented limit: a rephrased restatement reads as a new cue.

New **`opencues dismissals`** is the undo surface — an interactive toggle list (nothing written until you accept; Esc changes nothing) plus scriptable `list [--json]` / `restore <n|phrase>` / `clear` / `path`. `startCueDismissals` (wired from `buildSharedRuntime` for the six bands that call it, and by hand in the Claude Code band, which predates that helper — a `boot-bands-wiring.test.ts` asserts on the CALL rather than the mention, because grepping for the name matched CC's comments and hid exactly this gap) hydrates at boot and re-reads the file on a 4s mtime gate, which makes a restore land in the session you already have open — no restart. The file is user-level, deliberately not cwd-scoped like the commitments watchlist: a watchlist is session state, "never show me this again" is a standing preference. Chrome has no filesystem, so no sink is registered and forget degrades to a 24h mute rather than claiming a permanence the next restart would expose. Docs: `docs/architecture/cue-dismissal.md`, `docs/features/cue-dismissal.md`. Not a spec change — a runtime gesture, no scalar.

### Added — volume/brightness as live actuators: inline note + caret-armed adjust (`@opencues/core` 0.42.6 → 0.42.7, `@opencues/runtime` 0.29.8 → 0.29.11)

Numeric-step blanks (`volume`, `brightness`) were silently cycleable: they filled a value but drew no inline note, and stepping only worked after an explicit navigate. They are now proper live actuators. The filled value shows a standard inline note in the `emoji · label · (hint)` format — the emoji from a new optional `icon:` blank frontmatter field (🔊 volume, 🔆 brightness), the label from the blank's existing `tip:` (`system volume` / `screen brightness`), and a one-time `(ctrl+alt+up/down to adjust)` hint that drops after the first adjust (like the cycle hint's `(underscore to cycle)`). The **label persists** while the caret is in the span (the standing "this is a live knob" signal); the value itself stays in the buffer, shown once (`volume 32%`). **GET arms the knob**: with the caret in a filled value, `Ctrl+Alt+↑/↓` adjusts it (±`blankStep`, clamped 0–100, written back via the blank's script) with no separate navigate — the fallback is confined to `blankStep` actuators, so plain cues still require a navigate. `cycleBlankStep` now syncs the def's `alternatives` to the stepped value so the note's liveness check keeps matching across adjusts. New `icon:` field: `BlankConfig.icon`, parsed in `cues-md.ts`, rendered by `dim-render.ts`. No new glyph class — it reuses the existing note format. Bare `_` in the value also nudges it UP one step (the one-direction analogue of a text cue's `_`), clamping at the top; down stays `Ctrl+Alt+↓`. **The how-to hint is now dismissed PER NOTE** (`HINT_DISMISSAL_SCOPE` in `dyn-defs.ts`, default `per-note`): retiring one note's hint (keyed by `noteHintKey` — blankName, else original word, so it survives re-resolution) leaves other notes' hints intact, fixing the cross-note coupling where cycling any one note silenced every hint. Flip the const to `session` to restore the old global behaviour (a maintenance knob, not a user setting). Docs: `docs/architecture/inline-cues.md` § note vocabulary, `docs/features/inline-cues.md`. Not a spec change.

### Added — `opencues usage`: aggregate LLM token usage + estimated cost (`@opencues/core` 0.42.5 → 0.42.6, `@opencues/runtime` 0.29.1 → 0.29.2, `opencues` 0.5.3 → 0.5.5)

OpenCues fans out to many sources on a single buffer edit (word-cues, sentence-cues, session-contradiction, ask-cues, contradiction-cues, blanks…), each making its own LLM call — so per-feature cost estimates understate the real total once you stack features. This adds the missing meter. A process-global usage sink (`registerUsageSink`) that `dispatchChat` — the one chokepoint every source's LLM call funnels through — reports each call to, so coverage is automatic (a new source needs no wiring). Each host writes a `/tmp/opencues-usage-<pid>.json` snapshot from an in-process `UsageMeter`; the new **`opencues usage`** command merges snapshots across running hosts, prices them (`MODEL_PRICING` — cerebras/gpt-oss-120b confirmed, other providers approximate), and prints per-model calls / tokens / cache-hit-rate / cost + a total (`--json`, `--reset`). Cache-aware: cost is `(prompt − cached)·input + cached·cachedInput + completion·output`, so a provider's cache discount is reflected, not hand-waved. Passive accounting — makes no LLM calls, adds no token cost. **No in-editor UI** — a CLI command like `doctor`. The session-contradiction **producer** (a separate short-lived process) appends its calls to a shared `opencues-usage-producer.jsonl` (atomic small-write appends → no lock, no race), so it's counted too — shown as a `producer` host. Remaining gap: Chrome registers no sink (no `/tmp`), so it's a no-op there.

### Added — AskUserQuestion cues: a generic "populate cues from a well-known tool prompt" primitive (`@opencues/core` 0.42.0 → 0.42.3, `@opencues/runtime` 0.29.0, `@opencues/chrome` 0.2.152 → 0.2.153)

A new cue that turns the sentence under your cursor into an inline **question with cyclable options**, populated by the AskUserQuestion tool's own (well-known, reliably-emitted) system prompt. The question becomes the cue tip; each option becomes a cycle alternative on the sentence; options carrying a concrete `apply` rewrite the sentence when chosen, advisory ones just inform. **No new UI** — it reuses the existing navigate + cycle + tip surface. Generic + pluggable: `ToolPromptCueSource` + a `TOOL_PROMPTS` registry (AskUserQuestion is the first entry; adding a tool is one entry). OFF by default (`ask-cues-mode: on`). **Works on every host**, grounded on whatever context that host has: the distilled session (`summary` + decisions) on the transcript hosts, and **page + field ambient in the browser** (Chrome, which has no session), so a vague sentence gets a relevant question either way. Restraint-tuned — silence is the default; it stays quiet on sentences that need no clarification. Cached per sentence (one LLM call per new sentence). Docs: `docs/features/ask-cues.md`. Also fixed a test-harness gap: three vitest-style core test files are now excluded from the `node --test` build path and added to the vitest include (they'd otherwise fail the `node --test` half of `pnpm test`).

### Added — session-contradiction cues: catch yourself contradicting a decision you made earlier in a coding session (`@opencues/core` 0.41.0 → 0.42.4, `@opencues/runtime` 0.28.21 → 0.29.1, `opencues` 0.4.2 → 0.5.3, `@opencues/claude-code` 0.2.10 → 0.2.11)

A new cue that flags when your draft message goes against a decision established earlier in the same session — you agreed "runtime is Bun, not Node," then start typing "switch this to node"; you scoped the work to the cache module, then reach for auth; you said "no new deps," then ask to add a package. Works on **Claude Code, OpenCode, and Gemini CLI** (every host with a session transcript). OFF by default (`session-contradiction-mode: on`).

Two-stage, distinct from the deterministic `contradiction-cues-mode`: a background producer (`opencues extract-commitments`) distils the session transcript into a terse **commitments watchlist** (categories: stack / architecture / constraint / memory / scope / decision, plus a one-line session summary); a fast matcher (`SessionContradictionSource`, priority 88) checks each draft against it and surfaces a contradiction as a passive `⚠` sentence-cue (`Ctrl+Alt+↑` applies a reconciled rewrite; never auto-splices). **Incremental distillation**: the producer only reads the last 256KB of the transcript, so in a long session early decisions would age out of every re-distillation (a real-transcript benchmark measured recall dropping to ~55% for exactly this reason). The watchlist now *accumulates* within a session — fresh tail decisions are merged into what was already recorded (preservation + dedup are deterministic so nothing is silently lost), and a separate focused LLM call handles supersession (a revised "actually, switch to X" replaces the old decision rather than leaving a stale entry that would false-alarm). It resets on a new session. The producer is triggered per host — the CC statusline kick on Claude Code, a boot-band transcript poller on OpenCode (SQLite) and Gemini CLI (JSONL) — and reads via Claude Haiku when available (cheap large-context distillation). The watchlist is **scoped per working directory** (`<cues>/session-commitments/<key>.json`), so two sessions in different repos never clobber each other. Grounded: a flag survives only if its quote is an exact buffer substring AND its cited commitment is on the watchlist. Data-minimized: only your and the assistant's prose reaches the producer — tool I/O, file contents, and thinking blocks are dropped before anything is sent. It shares one fused `SessionCueSource` with the ask-cues source (above), running contradiction-first. New CLI command `opencues extract-commitments`. **Stage-A extraction now defaults to the cues bucket (cerebras) rather than auto-routing to Claude Haiku when `ANTHROPIC_API_KEY` is set** — the real-transcript benchmark showed the cues default extracts in ~0.5s and never comes back empty on messy sessions, while Haiku is ~4× slower for a marginal recall edge; Haiku stays reachable via `OPENCUES_EXTRACT_PROVIDER=anthropic`. **The producer is now kicked from every host's boot band** (a `startSessionCommitmentsKick` transcript poller, with per-host locators including `locateNewestCCTranscript`), so the feature works out of the box — on Claude Code it no longer depends on the opt-in statusline being enabled (previously the statusline was CC's only trigger, so the feature was silently inert whenever it was off, which is the default). The statusline stays a belt-and-braces kick when enabled; a double-kick is harmless (the producer self-debounces + locks). Docs: `docs/features/session-contradiction.md`, `docs/architecture/session-contradiction.md`. Not a spec change (runtime-only knob).
### Added — contradiction cues Tier 5d: subreddit-rules conflicts on reddit (chrome) (`@opencues/core` 0.41.1 → 0.42.0, `@opencues/runtime` 0.28.22 → 0.29.0, `@opencues/chrome` 0.2.152 → 0.2.153)

Drafting a post or comment on reddit now checks each sentence against the **subreddit's own posted rules** and raises the passive ⚠ contradiction rail when a sentence clearly conflicts with one (e.g. an off-topic draft on a sub whose rule 2 is "Be relevant"). New `RedditRulesProvider` fetches `/r/<sub>/about/rules.json` **same-origin from the content script** (rides the page session — no service-worker hop, no new host permission), TTL-cached per subreddit and keyed off a new live `pageLocation` getter threaded chrome-bootstrap → chrome band → runtime resolver → build-sources (native hosts omit it → tier silent). The conflict judgement is a **dedicated per-sentence LLM judge call** (`COMMUNITY_RULE_JUDGE_SYSTEM`) — never folded into the benched extract prompt — and is the one declared exception to "the correction is DATA": the tip text itself is still built from the cached rule (community + number + sanitized name), a hallucinated rule number or ungrounded quote is dropped by `verifyCommunityRuleClaim`, and rule text is sanitized/length-capped untrusted data with no side-effect channel. Rides the existing `contradiction-cues-mode` scalar (off by default; no new scalar, no new UI surface). See `docs/architecture/contradiction-cues.md` § Tier 5d.

Companion: the shipped `more-formal` cue now declares `not-on-site: [*.reddit.com]` — reddit's register is deliberately casual, so a background formality rewrite there is noise, and the subreddit-rules tier (priority 87) owns reddit sentence spans over `more-formal` (85) on every overlap anyway. Same shape as its `not-on-host` CLI scoping from the previous release.

### Changed — calendar-conflict cue is now auto-implied by `calendar-context-mode` (core 0.41.0 → 0.41.1, runtime 0.28.21 → 0.28.22)

The shipped calendar-conflict cue (`defaults/cues/calendar/CUE.md`, `scope: sentence`, `uses-calendar-context: true`) flags a sentence that proposes a day/time you're already booked ("let's meet October 1st" when Oct 1 is busy → appends a terse `— heads up: <event> …`). It was gated behind `sentence-cues-mode`, a *separately named* toggle from the `calendar-context-mode` a user actually turns on to get calendar reasoning — so enabling calendar context did nothing until you also discovered the second switch. It didn't fire even for the author. Now a `uses-calendar-context` sentence cue is **auto-implied by `calendar-context-mode: on`**: `buildSourcesFromConfig` gains an `enableCalendarContext` option (wired from the resolver, same polarity as the resolve-time calendar snapshot), and a calendar-aware sentence cue bypasses the `sentence-cues-mode` gate. The source still self-inerts when there's no calendar feed, so this is a no-op until you add one (`opencues calendar add`). Every *other* sentence-scope cue stays behind `sentence-cues-mode`. Verified against a real feed on `cerebras/gpt-oss-120b` and `cerebras/gemma-4-31b` (flags all conflicting events, hydrates real titles locally, cedes on free days + non-scheduling prose). Pinned by 4 new gating cases in `build-sources.test.ts`.

### Changed — `more-formal` sentence cue scoped off the coding/agent CLIs

The shipped `more-formal` cue (`scope: sentence` — background "make this more formal" rewrites) now declares `not-on-host: claude-code, gemini-cli, opencode`. Those hosts are for terse instructions to a model, not prose you'd want formalized, so a background formality rewrite there is noise. The cue keeps running on the prose-first surfaces (chrome text fields, the shell editor). Discover-time host filter (`inferHostCompat`) drops it on the three CLI hosts; the calendar-conflict cue is unaffected.

## [0.4.2] - 2026-08-02

Patch release: launch-readiness for the published `opencues` CLI — a user-facing npm README, Apache-2.0 reconciled across every package, and a time-bomb test fix. Highlights in the [GitHub Release](https://github.com/opencues/opencues/releases/tag/v0.4.2).

### Changed — user-facing npm README (`opencues` 0.4.1 → 0.4.2)

Replaced the CLI package's internal contributor README (the one npmjs.com/package/opencues renders) with a launch-ready, user-facing one: the "you type / you get" hook table, a real quickstart (`npm i -g opencues` → `set-key` → `install` → `run`), the 5 integrations, the feature + provider summary, a security one-liner, and links. Fixes the stale "Coming (Tier 2/3)" tables that listed dozens of already-shipped commands (`run`, `doctor`, `import`, `init`, `validate`, …) as unbuilt, and drops the internal "Stage 8 / thin dispatcher / architecture tree" language. All doc links are absolute GitHub URLs (npm resolves relative links against `repository.directory`, which is the CLI subpath, so relative links would 404).

### Fixed — Apache-2.0 reconciled across all packages; stale proprietary LICENSE files dropped

The repo root is Apache-2.0 and everything is positioned as "fully open source", but three packages shipped a leftover **proprietary "All Rights Reserved"** LICENSE and most `package.json` files declared no `license` at all — worst of all the **published `opencues` CLI**, whose npm page therefore read as proprietary, and `@opencues/core` / `-runtime`, which declared `"license": "Apache-2.0"` in `package.json` while shipping a proprietary LICENSE file (a direct contradiction). Replaced the proprietary LICENSE files in `opencues-cli` / `-core` / `-runtime` with the root Apache-2.0 text, and added `"license": "Apache-2.0"` to every one of our `package.json` files that lacked it (root, cli, all 6 integrations). Metadata only; third-party licenses untouched.

### Fixed — calendar re-sync test was a time-bomb (hardcoded dates fell out of the sync window)

`calendar.test.cjs`'s `remove with feeds REMAINING re-syncs immediately` hardcoded a calendar event at `2026-08-01`. The sync keeps only events inside `[now-1h, now+60d]`, so once the clock passed that date the event dropped out of the window — the re-sync produced 0 events instead of 1 and the assertion flipped to `0 == 1`, failing on **every** PR against master from 2026-08-02 onward (unrelated to any diff). Fixed by computing the event's dates relative to `now` via a small `icsUtc` helper, so the test can't expire again. No product-code change — the sync was always correct.

## [0.4.1] - 2026-07-30

Patch release: chained-transform fix + the install channels (curl / bun / brew). Highlights in the [GitHub Release](https://github.com/opencues/opencues/releases/tag/v0.4.1).

### Added — install channels: `curl | bash` installer, bun-only bootstrap, Homebrew tap (CLI 0.4.0 → 0.4.1)

Three new ways in, matching the site's install bar: **curl** — `install.sh` at the repo root (served as `https://opencues.com/install` via a site redirect): checks Node 22+ and git with actionable errors, runs `npm i -g opencues`, prints next steps; covered by the shell-portability lint (root installers now in its scan). **bun** — `resolvePnpm` gains a `bun x pnpm` rung so `bun add -g opencues` bootstraps on bun-only machines (no node ⇒ no corepack); verified end-to-end in a pristine `oven/bun` container. **brew** — new tap `opencues/homebrew-opencues` (`brew install opencues/opencues/opencues`), formula tracks the npm release tarball; bumping it joins the release steps.


### Fixed — CC: chained transforms broke — the bridge's synthetic `_` was consumed as a note-cycle (`@opencues/runtime` 0.28.20 → 0.28.21)

Six agentic scenarios (stacked bolds, three-stack, multi-blank, both chains) failed only on Claude Code: after a transform substitute, the next injected `… <instruction> _` never fired. Root cause: the event-bridge's `text:` inject frames its synthetic `_` keystroke as the final keypress of the NEW string (0.28.20's fix), but the CC band's inline bridge `dispatchKey` re-sampled adapter state and clobbered that framing — the stale cursor sat exactly at the filled span's end, inside Cycling's inclusive `_`-note gate, so the `_` cycled the def back to its original instead of arming the blank gate (the resolver then saw old-`_`/new-`_` in its diff and stayed silent). Every other band passes the bridge event through untouched; CC's inline construction had drifted — the same band-drift class as the July secret-guard incident. Fix: honour the caller's `text`/`cursorOffset` when supplied, adapter sampling only as fallback. Pinned by the six agentic scenarios (41/43/45/46/100/101).


### Removed — `packages/opencues-park/` (the npm parking placeholder)

`opencues@0.4.0` (the real CLI) is published to public npm and superseded the placeholder's `0.0.1` as `latest`, so the park package's source is no longer needed (the published 0.0.1 stays on npm as history). README npm badge wired; CLAUDE.md version map updated.


## [0.4.0] - 2026-07-30

First npm-published release (`npm install -g opencues`). Highlights in the [GitHub Release](https://github.com/opencues/opencues/releases/tag/v0.4.0).

### Added — standalone CLI: `npm install -g opencues` now works (CLI 0.3.0 → 0.3.1)

The CLI no longer assumes it lives inside a repo checkout. A resolution ladder (`src/lib/repo-root.cjs`) finds the runtime repo — dev clone → `$OPENCUES_REPO` → `~/.opencues/repo` — and, for a global npm install with no repo present, **fetches it on demand pinned to the CLI's own version tag** (`git clone --depth 1 --branch v<version>`), then bootstraps it (workspace deps via pnpm, falling back to corepack's bundled pnpm; `@opencues/core` built). npm version = git tag = repo snapshot, so a published CLI always drives the matching runtime. Only repo-needing commands (`install`, `run`, `validate`, …) trigger the fetch; light commands (`set-key`, `config`, `identity`, …) work repo-less. The prepublish guard gained a CLI launch path: publish to public npmjs is allowed only when the matching repo tag exists upstream; `@opencues/*` libraries remain blocked from public registries. README + install docs updated to the live-npm quickstart. Pinned by 19 hermetic tests (`repo-root.test.cjs`) + a packed-tarball sandbox smoke (fetch → bootstrap → `validate` green end-to-end).


### Changed — SPEC 0.10-alpha → 0.11-alpha: the trigger character inside a revealed span (`@opencues/core` 0.40.4 → 0.41.0, `@opencues/chrome` 0.2.151 → 0.2.152)

The Open Standard now specifies when a typed `_` is **not** a blank trigger (`spec/core.md` § Routing → "The trigger character inside a revealed span"): with the caret inside a runtime-revealed span, a cycling-capable runtime SHOULD treat bare `_` as "advance this span" and MUST consume the keystroke; outside every such span it keeps its trigger meaning — `_` is the single interaction verb (summon on plain text, cycle on presented results, caret decides). And a bare blank keyword is a **pure trigger**: no cycling affordance / nav stop / indication until its `_` fires. This standardizes the uniform interaction model the reference runtime shipped this cycle (`_`-cycle on every note-bearing span + bare-keyword-affordance removal). Other cycle keys stay out of scope. No file-format surface → no schema/fixture changes (also fixed the `spec-too-new` fixture's stale "supports only 0.7" summary string). Full checklist applied: `SPEC_VERSION` constant, root `SPEC.md`, all spec-doc banners, `spec/CHANGELOG.md` 0.11.0-alpha release. Core suites green (1318 node:test + conformance 70).

### Fixed — contradiction weekday-date check flagged CORRECT claims once the written date passed (explicit year was ignored) (`@opencues/core` 0.40.3 → 0.40.4, `@opencues/chrome` 0.2.150 → 0.2.151)

A date-dependent **time-bomb false positive** caught by the agentic negative-control scenario (117): `resolveDate` never read an explicit year, so "see you on **Friday, 24 July 2026**" — a correct claim — was resolved as *the next* July 24 once `now` passed the 24th → 2027-07-24 = Saturday → the cue flagged a true statement with "the 24th is a Saturday, not Friday". The scenario passed when authored (before the 24th) and silently went red after. Fix in `checks.ts`: (1) `resolveDate` gains an explicit-year parameter — a stated 4-digit year (1900–2200, month required) pins the date verbatim, no future-rolling; yearless phrases keep the next-occurrence behaviour. (2) The LLM path (`verifyClaim` weekday_date) reads the year from the **grounded quote** (already verified as a verbatim sentence substring) — no extract-prompt change, no new claim field. (3) The deterministic word-walk now also parses **day-first (UK) order** ("Friday, 24 **July** 2026" — month after the day), which it previously resolved as a bare day. Pinned by 3 new `checks.test.ts` cases (explicit-year correct → silent after the date passes; explicit-year wrong → still flags; yearless → rolling unchanged); verified live on a headless host — negative control silent, weekday/bill-split positives still flag. Core suites green (1318 node:test + 298 vitest).

### Fixed — event-bridge `text:` inject synthesized its `_` keystroke in the WRONG frame, so the `_`-cycle consumed it and chained transforms broke (`@opencues/runtime` 0.28.19 → 0.28.20, `@opencues/chrome` 0.2.149 → 0.2.150)

The debug event-bridge's `text:` inject synthesizes a `_` keystroke before the text change (so the explicit-`_` gate sees the keystroke→change pair a real user produces). It framed that keystroke with the **pre-change buffer + the OLD cursor** — and after a transform substitute the old cursor sits exactly at the span's END, inside the `_`-cycle's inclusive note-gate. Result: the synthetic `_` was CONSUMED as a cycle (reverting the def to the original), the arm flag was eaten, and the subsequent inject text mismatched the reverted buffer → def dropped → the second transform in a chained flow never fired (caught by the agentic chain scenarios going red serially; live users are unaffected — a real `_` keypress lands at the end of what was just typed, past the span). Fix: frame the synthetic keystroke as the FINAL `_` of the injected string (text = decoded minus that `_`, cursor = its position — `lastIndexOf`, matching the blank anchor), which is exactly what a real user's last keypress looks like. Also more faithful for BlankFill's standalone-`_` insertion simulation. Same commit: OC's bridge wiring gains the `renderedText` dump binding (the painted, ANSI-stripped buffer — mirrors CC's), so note-alignment scenarios are assertable on opencode; it was `null` there. NOTE: adapter-band changes sit outside srcHash — deploying this to an existing OC fork needs `integrations/opencode/patches/setup.sh`, not just `opencues run`.

### Fixed — a whole-buffer rewrite (translate, etc.) silently dropped when the buffer ended in blank lines and the rewrite didn't (`@opencues/runtime` 0.28.18 → 0.28.19, `@opencues/chrome` 0.2.148 → 0.2.149)

`translate to japanese _` on `whats up buddy ` produced the correct rewrite (`よぉ、元気か？`) but the buffer kept the English — the translation never landed. Root cause: the three-way-merge's **paragraph-break-preservation** rule (`word-diff.ts` `surviveAndAdjustHunk` rule 2) counted the editor's **trailing empty lines** (`\n\n\n\n`) as a content paragraph break. The rewrite legitimately had no trailing newlines, so the rule saw "1 break → 0 breaks" and concluded the LLM was collapsing a paragraph, **dropping the entire hunk** — the merge returned the original text unchanged. This only bit rewrites whose output is disjoint from the input AND drops the trailing blank lines (translations are the clean example: English→Japanese share no words). Fix: at end-of-buffer, exclude trailing whitespace from the paragraph-break count (rule 3 already re-appends it), gated on `atBufEnd = raw.aEnd === snapshot.length` so an **internal** `\n\n → ' '` collapse is still correctly dropped. Same trailing-whitespace-isn't-content theme as the transform-span fix above, in the merge layer. Verified directly against `threeWayMerge` (translate applies; internal-collapse still dropped; internal-break-kept applies) and pinned by two new `word-diff.test.ts` cases. Affects every whole-buffer source that merges (TransformBlank + AgentRewrite). Full suite green (2190).

### Fixed — transform-blank span died on a trailing edit (space / newline / continuing to type) then re-resolved, causing a dim/note flicker (`@opencues/runtime` 0.28.17 → 0.28.18, `@opencues/chrome` 0.2.147 → 0.2.148)

A whole-buffer transform (`… make it formal _`) registered its DynDef with `spanEnd = bufferText.length` — the **entire** buffer, **including the editor's trailing empty lines** (`\n\n\n`) — and `alternatives[0]` was that whole string. So the span *covered* the trailing whitespace. The moment you touched anything in that region — pressed space, added a newline, or just kept typing after the result — the chars inside the span changed, `slice(0,spanEnd) !== alt[0]` broke, the def went STALE, `pruneStale` DROPPED it, and the next resolve re-emitted it: the gray dim + note vanished then reappeared ~300ms later (a visible flicker). Sentence-cues never had this because they trim their span to the sentence and leave trailing whitespace outside it. Fix: the transform def now trims trailing whitespace out of BOTH the span and the stored alts (`bodyText`/`originalBody`), so `spanEnd` ends at the rewrite body and the trailing `\n\n\n` stays in the buffer but *outside* the span — exactly the sentence-cue shape. A trailing edit is now "after the span" and the def survives (no drop, no re-resolve, no flicker). The `slice(spanStart,spanEnd) === alt[0]` invariant is preserved (both sides trimmed), so the original reason for full-length (span/text must agree) still holds; trailing whitespace has no glyph, so nothing visible stops being highlighted. Diagnosed via a new debug-gated `DynDefs` span-lifecycle trace (`slideCharSpans` / `pruneStale` drop-relocate lines). Pinned by a new `transform-blank.scenarios.test.ts` case (span excludes trailing `\n\n\n`; a trailing space does NOT drop the def) + the existing alt-shape test updated to the trimmed body.

### Added — `_`-cycle now reaches EVERY note-bearing gray span (filled blanks + selector-satellite), not just DynDef cues (`@opencues/runtime` 0.28.15 → 0.28.16, `@opencues/chrome` 0.2.145 → 0.2.146)

Pressing bare `_` while the caret sits inside a painted note rotates that cue forward — the discoverable complement to Ctrl+Alt+↑ (which stays as the backward/power path, now deprioritized as the primary gesture). The `_`-cycle handler (`cycling.ts:stepUnderscore`) previously only iterated **DynDefs**, so it worked for word-cues, spelling, sentence/contradiction cues, and transform/fluid history — but silently missed the two note-bearing states that aren't DynDefs: **filled list/script blanks** (`SpanFillState` — volume, brightness, affirmations) and **settings selector-satellite** (`SelectorSatelliteState`). Those gained inline notes in the uniform-note-model change above but couldn't be `_`-cycled. Now `stepUnderscore` handles them explicitly after the DynDef loop, using the SAME cursor-gate dim-render.ts uses to paint their notes and the SAME cycle helpers Ctrl+Alt+↑ uses (`cycleSpanFill` / `cycleSelectorSatellite`) — just deriving the target from the caret instead of `hlState`. Selector-satellite is **cursor-aware**: `_` on the selector cycles setting names, on the satellite cycles that setting's values — matching the cursor-aware note. The gate is unchanged in spirit: caret inside a live note span → `_` cycles + is consumed (not inserted); caret past the span (after a space) or an edited-away span → `_` falls through to its normal blank meaning. Wired on every host (CC directly; OC/gemini/shell/chrome via `buildSharedRuntime` — both already construct `Cycling` with `spanFillState` + `selectorSatelliteState`). Pinned by 3 new `cycling.test.ts` cases (SpanFill rotate, selector name-cycle, satellite value-cycle). Docs: `inline-cue-cycle.md` table + generalization section updated.

### Changed — chrome inline note wraps and grows into extra rows instead of running off-screen (`@opencues/chrome` 0.2.144 → 0.2.145)

The chrome inline-note overlay was `white-space:pre` with no `max-width`, so a long note (a wordy setting description, multi-token word-cue suggestions) rendered on a single line and ran off the right edge of the viewport. Now the note **wraps within the field's text column** (`white-space:pre-wrap` + `overflow-wrap:anywhere`, `max-width` = span-left → field-right edge, floored to 160px so a span near the right edge still gets a usable width) and grows DOWNWARD into as many rows as it needs. The push-down that keeps the note from occluding the line below already keys off the note's *measured* height (`pushPx = noteH`), so setting the wrap + max-width BEFORE the measurement makes the opened gap auto-grow to the full multi-line height — a 3-line note opens a 3-row gap, content shifts down 3 rows, note sits in the freed space. No change to short notes (they still measure one line). Pinned by a new `runtime-renderer.test.ts` case (note element carries `pre-wrap` + a bounded `max-width`). (Terminal hosts — CC/OC/shell/gemini — already grow via the terminal's natural soft-wrap of the inserted note line; aligned continuation-line indentation there would need the terminal width plumbed into the painter, tracked separately.)

### Added — uniform inline-note model: every cyclable span reveals what's behind it (`@opencues/runtime` 0.28.11 → 0.28.15, `@opencues/chrome` 0.2.140 → 0.2.144)

The inline note is now "the useful reveal" for **every** cue/blank type, not just passive cues. Previously only `cueTip`-bearing spans (sentence/contradiction cues) and history-bearing `_`-blanks got a note; word-cues, filled blanks, and settings blanks dimmed but revealed nothing. Now:

- **Word-cues (including spelling)** show their **suggestions** — `alternatives[1..]` (e.g. `lawyer · counsel`, or the spelling correction `receive`), capped at 3, `·`-joined. No fetch, no separate tip channel: word-cue results already register a DynDef carrying their alternatives on resolve (`resolver.ts`), so `inlineNoteText` just reads them off the def.
- **Filled list/script blanks** (`SpanFillState`) show their `tip` (e.g. `system volume`), falling back to their cycle options when tip-less.
- **Selector-satellite** (settings blanks) show a **cursor-position-aware** tip mirroring the statusline's per-part logic (`statusline.ts:282`): caret on the selector (setting name) → the setting's own `def.tip`; caret on the satellite (value) → that value's `def.valueTips` entry. So the note describes the part the focus is actually on, not just "what the span controls".

`SpanFillState` and `SelectorSatelliteState` aren't DynDefs, so the note loop handles them explicitly after the DynDef pass — no auto-select there (they carry their own highlight/dim model). The OC agentic bridge also gained `renderDirectives` wiring (mirrors CC) so the note is observable in the dump — it was `render: null` before, which is why notes couldn't be harness-tested on opencode. Pinned by new `dim-render.test.ts` cases (word-cue suggestions, single-alt → no note, SpanFill tip + tip-less options, selector-satellite per-part cursor tip). Full runtime suite green.

### Changed — dim no longer marks bare blank keywords (removed the overloaded third meaning) (`@opencues/runtime` 0.28.9 → 0.28.10, `@opencues/chrome` 0.2.138 → 0.2.139)

Dim (gray text) carries exactly two meanings: "cycle me (Ctrl+Alt)" and "select me → info in the statusline". A bare **blank keyword** (`volume`, `weather`, `translate`, …) is neither — it can't be cycled and shows no statusline tip until `_` fires the blank — yet it used to dim whenever a `_` landed within ~12 words (`shouldGateBlankKeywordDim`'s proximity exception). That was a third "you could trigger a blank here" meaning that overloaded dim. Removed: a word that is ONLY a blank keyword now **never dims**. Word-cue entries (CUES.md `## Tips`, folder/spelling cues) and filled-blank/passive-cue DynDef spans still dim — those are genuine cycle/statusline affordances. Dim-render test flipped to assert no dim with `_` adjacent. (Navigation + statusline are handled in the follow-up entry below so dim/nav/tip stay consistent.)


### Changed — bare blank keywords are now pure `_` triggers: not navigable, no statusline tip (`@opencues/runtime` 0.28.10 → 0.28.11, `@opencues/chrome` 0.2.139 → 0.2.140)

Completes the dim removal above into a coherent rule. A word that is ONLY a blank keyword (`volume`, `weather`, `translate`, …) is a double-use word — ordinary prose OR a blank trigger — so while it's ambiguous it now carries ZERO affordance: not dimmed (previous entry), **not a Ctrl+Alt nav target**, and **no statusline tip** (a consequence of not being selectable). The affordance appears only once `_` fires the blank, which registers a DynDef that legitimately dims + navigates + tips. Fix: `Navigation` builds its targets from `cueMap` (word-cues) + DynDefs instead of `navigableWords` (which unions in blank keywords) — restoring this method's own documented "matched cueMap or has a DynDef" contract; the drift to `navigableWords` is what made bare keywords silently navigable. Blank *firing* is unaffected (`blanksByWord` + the keyword window, not `navigableWords`). Pinned by a new navigation test (cue word IS a target, bare blank keyword is NOT). Full runtime suite green.

### Added — chrome inline-note push-down on managed editors (claude.ai/ProseMirror etc.) via a safe margin nudge (`@opencues/chrome` 0.2.110 → 0.2.117)

The push-down that stops the note occluding the line below now works on managed editors too, not just plain contenteditables. A node spacer can't be used there: managed editors (ProseMirror/Lexical/Quill) revert externally-inserted nodes, AND OpenCues doesn't own their send button — a real inserted line would ship in the user's message. Instead, on managed editors the note nudges the span's containing block's `margin-bottom` via inline **style**: layout only, so it can never reach the submitted text (`walkPlainText` reads text, not styles) and creates no editor transaction (no undo-stack entry). If the editor reverts the style on its next redraw the push-down simply doesn't hold and the note floats — no worse than before, never unsafe. The push mode is now a three-way `'node' | 'margin' | 'none'` (`applyDirectives`'s third arg): plain CE → `node`, managed → `margin`, normal inputs → render skipped. The margin path has two branches, each chosen to survive the editor's reconciler (ProseMirror reverts inline styles on child nodes it owns): (1) **mid-buffer** opens the row with an **injected stylesheet rule** on the LINE block whose next sibling is the line below — found by walking up from the caret to the first block ancestor with a following sibling (Draft.js nests each line several divs deep, so the nearest block is a sibling-less inner wrapper; the real line block is higher up), anchored by position to that block's REAL parent (`[data-oc-editor] > :nth-child(N)`, the parent carrying the mark) — PM can't see or revert an external stylesheet, so the margin holds, unlike the inline child style it reverted; (2) **last/only line** (a bottom margin on the last child is swallowed anyway) grows the EDITOR root via inline `padding-bottom` (PM doesn't reconcile its own root's style). The mid-buffer branch was verified needed by the debug diagnostic: `block-margin` was applying on claude.ai yet no row opened, because PM reverted the child `<p>`'s inline style. Prior inline value is restored verbatim on clear. The gap height is measured from the note's OWN rendered height (one line in the field's font) rather than the field's `line-height` — robust to `line-height: normal` (where the prior span-rect fallback over-counted a wrapped sentence's full height) and to any note/field metric mismatch; a wrapped sentence still opens exactly one row below it. A debug-mode diagnostic (`[chrome] marginPush …`) reports which path ran + the target tag, so a managed editor that reverts the nudge is visible in `/tmp/opencues.log`. Pinned by jsdom tests (stylesheet-rule target, root-padding fallback, exact restore) in `runtime-renderer.test.ts`.

### Fixed — sentence-cue segmenter merged across hard line breaks, so a cue span (and its highlight) crossed onto the next line (`@opencues/core` 0.40.2 → 0.40.3, `@opencues/chrome` 0.2.109 → 0.2.110)

`segmentSentences`' content run (`[\s\S]+?`) matched across `\n`, so a buffer like `"thanks a bunch guys\ndasdasda"` (two lines, no `.`/`?`/`!` between them) segmented as ONE sentence spanning the newline. The resulting sentence-cue span [start,end) then covered both lines — its auto-select highlight painted across line 2 and cycling replaced text spanning two lines (observed live on Gmail; host-agnostic — chrome's CSS-highlight paint just made it visible). Fix: add a hard line break (`\n+`) as a sentence terminator, so content on separate visual lines is never one sentence. Also makes the documented "markdown headers / list items are each their own sentence" behaviour actually hold (those are `\n`-separated). Shared segmenter, so the contradiction-cue source inherits the fix. Pinned by 3 new unit tests in `sentence-cue-source.test.ts` (cross-line split, blank-line collapse, markdown lines). Re-run the sentence-cue bench before further segmenter edits (single-line bench cases are unaffected by this boundary change).

### Fixed — chrome inline-note push-down failed on Gmail/YouTube (first-line-unwrapped shape), leaving the note overlapping (`@opencues/chrome` 0.2.108 → 0.2.109)

The push-down spacer (an empty `contenteditable=false` block that moves content below the flagged span DOWN so the inline note sits in the freed row instead of occluding the next line) only fired when the span's line was a per-line block element. Gmail and YouTube leave the **first line as a direct text node in the contenteditable root** and only wrap *subsequent* lines in `<div>`s — so `blockAncestorWithin` found no per-line block, `insertNoteSpacer` bailed, and the note overlapped the line below. Since a cue almost always lands on that first line, the spacer never fired on those sites. Fix: when the span's line has no wrapping block, anchor the spacer to the line's terminating `<br>` (insert after) or the next block element (insert before) via `firstLineBreakAfter` — handles both DOM shapes; a span on the last line (nothing below) correctly inserts no spacer. Pinned by 5 jsdom tests in `runtime-renderer.test.ts`. (Managed editors — claude.ai/ChatGPT/Reddit/LinkedIn/Twitter — still float the note by design: their MutationObservers revert any inserted node, so a true push-down there would require editing the user's document.)

### Fixed — shell: a consumed key double-inserted into the textarea; `_`-cycle "cycled then inserted / can't cycle twice" (`@opencues/shell` 0.2.20 → 0.2.21)

The shell's `useKeyboard` handler forwarded keys to `dispatchOpenCuesKey(evt)` but ignored its boolean return and never called `evt.preventDefault()`. OpenTUI runs global keypress listeners (this `useKeyboard`) BEFORE the focused textarea's own insert handler and skips that handler only when a global listener has called `preventDefault()` — so every key the runtime consumed was ALSO inserted by the textarea. For `_`-cycle inside a painted cue note, that stray `_` pushed the caret one past the span end, so `Cycling.stepUnderscore`'s `cursor <= spanEnd` gate rejected the next `_` and it inserted literally (killing the span). Fixed by mirroring the OpenCode band: `if (dispatchOpenCuesKey(evt)) { evt.preventDefault?.(); evt.stopPropagation?.(); }`. The bridge harness calls `bootResult.dispatchKey` directly, bypassing this seam, so no headless test saw it — documented as terminal REPAIR.md LT-5.

### Added — inline-cue note on Gemini CLI (`@opencues/runtime` 0.28.5 → 0.28.8, `@opencues/gemini-cli` 0.2.8 → 0.2.10)

Gemini CLI (React/Ink) now gets the inline-cue note too. Its input renders each visual line as a **fixed-height (1-row) item** in a virtualized list, so a line can't grow to two rows (an embedded `\n` clips) — the note has to be its OWN list item. The `gemini/v0.41` adapter advertises `inline-note` and exposes `getInlineNote(text, cursor)`; the bootstrap's `getOpencuesInlineNote` formats it (`↳ …` + column), and the patched InputPrompt appends an `opencuesNote` item to `scrollableData` when a note is active. That grows the list height (`Math.min(viewportHeight, scrollableData.length)`) by one — a real extra row under the input, the same input-grows-by-one behaviour CC gets from the terminal. Cursor-gating is inherited from the runtime (the note only emits while the caret is in the span).

### Added — inline-cue notes + `_`-cycle on OpenCode / shell, as a REAL inserted line (`@opencues/runtime` 0.28.3 → 0.28.7, `@opencues/opencode` 0.2.8 → 0.2.13, `@opencues/shell` 0.2.7 → 0.2.13)

Brings the inline-cue UX (already live on terminal/CC + chrome) to the OpenTUI hosts. The `oc/v1.14` and `shell/v1` adapters now advertise the `inline-note` capability, so note-bearing spans (sentence-cues, contradiction-cues, and history-bearing transform/fluid blanks) get their advisory painted and `_`-cycle lights up.

The note renders as a **real line directly under the flagged span that pushes existing text down** — the same result Claude Code produces — revealed when the caret enters the span. OpenTUI's textarea draws its buffer lines contiguously in a native (Zig/FFI) library with no virtual-text / display-line primitive, so we **extend OpenTUI at the TS layer** rather than a native rebuild: each host hooks the textarea's `renderAfter` and, after the textarea has drawn normally, shifts every rendered row below the span DOWN by one (operating on the exposed framebuffer cell arrays) and draws the dim note in the freed row. The edit buffer is never touched (submitted text stays clean); the cursor/selection sit on the span line ABOVE the note, so the downward shift never disturbs them. `row` = the caret's viewport-relative visual row + 1, `col` = the span's column via the shared `inlineNoteBoxColumn` (connector-hung, CJK-cell-aware). Same `↳ <note>` text (`inlineNoteDisplayText`) every host paints.

Both hosts render the note as a **flow element that reserves its own row** — growing the input by one — rather than a framebuffer draw. (An earlier framebuffer row-shift landed the note in native memory but OpenTUI's compositor never painted rows the editorView treats as empty content area, so it was abandoned.) This requires a content-sized textarea so the note sits directly under the content:

- OpenCode: the note is a `<text>` sibling after the textarea in the patched `prompt/index.tsx` (its textarea is already content-sized, `minHeight=1/maxHeight=6`), driven by the `opencuesInlineNote` signal set in `triggerOpenCuesRender`.
- Shell: `app.tsx`'s textarea switched from full-pane (`height:100%`) to content-sized (`minHeight=1`) so a `<text>` note below it sits under the content; fed by the `onInlineNoteChange` boot callback, a note change requests a frame so it appears/clears immediately.

**Clears on vertical caret moves.** OpenTUI's `onCursorChange` fires on horizontal moves only, so `dispatchOpenCuesKey` — which re-rendered only on *consumed* keys — never re-evaluated the cursor gate on an unconsumed up/down, leaving the note on the line you left. Fixed by deferring a re-render one macrotask after any non-consumed cursor-moving key (`up`/`down`/`left`/`right`/`home`/`end`/`pageup`/`pagedown`) so it settles against the new caret.

Pinned by 5 `inlineNoteBoxColumn` unit tests. Verified live on headless OpenCode + shell (note emits, no crash); the on-screen row growth is confirmed on a live host.
## [0.3.0] - 2026-07-29

First public release. Full highlights in the [GitHub Release](https://github.com/opencues/opencues/releases/tag/v0.3.0).

### Removed — shipped niche word-cues `legal` / `medical` / `financial`

Deleted the three professional-domain word-cue packs from `defaults/cues/`. Low value for a general audience, and because cues compete for the span via priority eviction they crowd out the genuinely useful cues (contradiction, sentence rewrites). The per-word cue **mechanism** (`RoutedWordSourceGroup`) and its docs are unchanged — only the shipped instances go. Docs, templates, and spec/conformance fixtures repointed to the remaining shipped cues (`spelling`, `more-formal`) or neutral examples. No package behaviour change (tests + comments only); the shipped-content change lands in the next release.

### Fixed — `inherit` is now a universal provider fall-through sentinel (`@opencues/core` 0.40.1 → 0.40.2, `@opencues/chrome` 0.2.101 → 0.2.102)

`inherit` means "no override at this tier — use the one below" and is a documented value for BOTH the bucket scalars (`cues-llm-provider: inherit`) and the per-feature ones (`word-cues-provider: inherit`, `agent-provider: inherit`, …). But `resolveLLMTuple` only honored it for the bucket scalars (collapsed upstream); a per-feature `inherit` arrived verbatim and was looked up as a LITERAL provider → unknown → `null` → the source was silently dropped with `"no API key for provider 'inherit'"`. Symptom: setting every routing scalar to `inherit` (to make one global provider authoritative) silently disabled all word-cues / sentence-cues — most visible on chrome, where the whole cue set went dark.

Fix: `resolveLLMTuple` now skips any tier whose provider OR model is `inherit` (treats it identically to absent), so it falls through to the global at every tier. `getProvider('inherit')` returns `null` WITHOUT the "unknown provider" warning (it's a sentinel, not a provider), and chrome's CUES.md provider audit no longer flags `inherit` as misconfigured. Pinned by two `resolveLLM` tests (feature-tier `inherit` → global; all-tiers `inherit` → auto-route) plus the full routing suite. No behaviour change for real provider values.

### Added — satellite provider cycling silently skips an unreachable provider (`@opencues/runtime` 0.28.2 → 0.28.3)

Extends the provider-switch liveness gate to the `Ctrl+Alt` settings-cycle. `Cycling.eligibleValues` already dropped `*-llm-provider` values with no key set (you never land on a keyless provider); it now also drops any menu provider a recent liveness probe found UNREACHABLE — a present-but-invalid key, or a down host — so the cycle steps right over it, exactly like the keyless ones. Consistent with the "silently skip" model you picked: dead providers just aren't offered as a cycle stop; no flicker, no revert.

The probe runs in the background (fire-and-forget) and is cached with a short TTL, so cycling stays instant; a still-un-probed (cold) value stays in the cycle optimistically and is resolved on the next step once its probe lands. Only REAL providers are probed — sentinel values like `inherit` are never pinged or dropped. Transport is the host's `httpAdapter` (chrome) or a NodeHttpAdapter fallback (native). Every probe failure mode resolves to "reachable" so a flaky probe can never freeze or distort the menu — the gate only removes a value it positively pinged as dead.

Shared `buildCyclingProviderProbe` in boot-common wires both `buildSharedRuntime` and the hand-built CC adapter band (which constructs its modules inline), so the two can't drift. Pinned by two cycling scenario tests (dead provider skipped mid-lap, `inherit` never probed; no-probe-wired → back-compat, every keyed provider stays). Note: today's cyclable menu providers are the cloud ones (`cerebras`/`groq`/`gemini`/`anthropic`/`openai`) — Ollama is not in the cycle menu (`exposeInMenu: false`), so this catches invalid-key/down cloud providers during cycling; the Ollama case is covered by the fluid-config `"switch to ollama _"` gate.

### Changed — a config-command slot-claim now aborts racing lower-priority siblings (`@opencues/core` 0.40.0 → 0.40.1)

Follow-up to the provider-liveness probe. When `ConfigIntentSource` claims the `_` (returns `consumedBlankSlots`) for a provider/settings command — applied **or refused** — the resolver now **aborts** any strictly-lower-priority sibling (FluidBlank / TransformBlank) still racing on that slot, cancelling its in-flight LLM call. Previously the claim only *filtered* the sibling's result after the fact, so on a refused provider switch FluidBlank still ran a full wasted round-trip (and it was that late result that used to overwrite the tailored message before the `consumedBlankSlots` filter landed). This generalises the existing abort — which fired only on a whole-buffer claim or an undo/redo ACTION — to any explicit slot-claim, so it works even for the refusal's `_`-only (or empty-results) shape that carries no spanning result. Scoped by construction: `ConfigIntentSource` is the only source that returns source-level `consumedBlankSlots`. Pinned by two resolver tests (claim → in-flight sibling aborted; no claim → sibling runs to completion).

### Added — provider switches ping the target before committing; stay put + inline error on failure (`@opencues/core` 0.39.0 → 0.40.0)

A fluid-config provider switch (`"switch to ollama _"`, `"use anthropic for cues _"`) now **pings the provider it's about to change to** before writing the scalar. If the target can't answer — Ollama isn't running, a required key is missing, the provider rejects the model — OpenCues writes **nothing** (the current provider stays) and surfaces the reason **inline**, via the same `[err]`-style substitute every other blank LLM failure uses. Previously a switch to an unreachable provider applied blindly and then every subsequent call silently failed.

New `probeProviderReachable(providerId, model, { apiKeys, httpAdapter, … })` in `@opencues/core`: it pings the **target** provider directly (`getProvider(id)` → its default endpoint + the key from the bag), no `resolveLLM` cascade — the provider is already decided by the verdict. Tiers: CLI-transport providers (`claude-code-cli`) check the binary is on PATH; key-required providers with no key fast-fail with no network hop; `optionalAuth` providers (Ollama, keyless) are still pinged for real; everything else does a minimal `maxTokens: 1` completion (≤6s). A `429` counts as reachable (provider/key/model are valid, just throttled) so transient rate-limits don't block a switch. `ConfigIntentSource` runs the probe in its provider-verdict branch and, on failure, emits the inline error instead of applying.

On both the applied and refused paths `ConfigIntentSource` now returns `consumedBlankSlots: [blankIdx]`, so the resolver filters a lower-priority FluidBlank answer on the same `_` — the user sees ONLY the tailored "kept current provider" message, never a stray generic fluid-blank fill overwriting it (a successful switch already aborted siblings via its whole-buffer claim; the refusal, which only replaces `_`, needed the explicit claim).

Scope: the fluid-config `"switch to X"` path. Satellite `Ctrl+Alt` cycling (which renders optimistically as you cycle) is unchanged for now. Pins: 9 `probeProviderReachable` unit tests + 3 `ConfigIntentSource` gate tests (refused → no write + inline error + slot claimed; reachable → applies + slot claimed; no callback → applies unconditionally).

### Fixed — chrome: `_` silently ignored on normal `<input>`/`<textarea>` after a fill (loading-animation vs source-reclassifier) (`@opencues/chrome` 0.2.90 → 0.2.97)

On a non-cycling chrome field (Luma's form fields, any normal `<input>`/`<textarea>`), a `_` was intermittently swallowed with no log — most visibly the first `_` in a freshly-focused field, where deleting and retyping "fixed" it. Root cause: the loading-animation blank's default bounce frames are `['_', '-', '‾', '-']`, so while the LLM resolves it writes `'_'` into the field as a runtime write, which called `sourceReclassifier.markRuntimeWrite('_')`. The reclassifier keeps written strings for `RUNTIME_WRITE_TTL_MS` (1.5s) and reclassifies any matching text-change to `runtime` (so a runtime write's DOM echo never re-fires a blank). Within that window the user's next real `_` keystroke matched the stale `'_'` frame, was reclassified `runtime`, and the resolver correctly skipped it — silently, before the explicit-`_` gate ever ran. The retype worked only because the 1.5s TTL had aged the frame out; the alternation was just which animation frame was last marked.

The reclassifier match itself is correct (it stops the animation frame from re-triggering the blank mid-load). The bug is that `markRuntimeWrite` had no business running on the normal-input write path at all: `writeNormalInputValue` dispatches an `isTrusted=false` synthetic `input` event that content.ts's trust gate always drops, so on a normal input there is no runtime-write DOM echo to reclassify — the mark could only ever false-match a later real keystroke. Fix: drop the single `markRuntimeWrite` call from `writeNormalInputValue`. Managed editors (Gmail/Reddit/PM/Quill/Draft) write through different paths that fire *trusted* echoes and legitimately keep their own `markRuntimeWrite`, so they're unaffected. Verified live on Luma: real `_` now classifies `user` and fills every time.

### Changed — field-kind scoping is ungated: `on-field:` / WIPE work independent of `ambient-context-mode` (`@opencues/core` 0.38.0 → 0.39.0, `@opencues/runtime` 0.28.1 → 0.28.2)

`on-field:` scoping (#343) and the field-declared WIPE gate (#342) both read the field's SHAPE from `AmbientContext` (`singleLine` / `disposable`). But the resolver only populated `context.ambient` when `ambient-context-mode: on`, so both features silently rode a **privacy** toggle they have no business depending on: a user who turned ambient-context off (to keep field metadata off the wire) also lost on-field cede — the `more-formal` formalizer reappeared in their browser omnibox, and WIPE stopped firing.

The fix splits the ambient object into two tiers by *what reaches the LLM*, at the single resolver chokepoint:

- **Field METADATA** (`label` / `placeholder` / `pageTitle` / `app` / `pageUrl` — the wire payload that disambiguates a fluid-blank lookup) stays gated by `ambient-context-mode`. Unchanged.
- **Field SHAPE** (`singleLine` / `disposable` — on-machine booleans that never reach an LLM) is now forwarded **unconditionally**. Field-kind scoping is structural routing, the same category as `on-host` / `on-site` — none of which have a master toggle — not a privacy opt-in.

New `structuralAmbientOnly()` in `@opencues/core` whitelists an ambient down to its shape booleans; the resolver applies it when `ambient-context-mode` is off (and passes the full ambient when on). This is a **whitelist**, so it preserves "no field metadata to the LLM when the mode is off" *by construction* — strictly stronger than the old "don't consult the host at all" stance, which was a blacklist that broke field-shape awareness as collateral. The host still returns null for sensitive fields (password/CC/OTP) and native hosts with no DOM, so a redacted-to-empty ambient becomes `undefined` (kind unknown) exactly as before. Not a spec change — spec 0.10 already defines `on-field` as evaluated per-resolve from the field kind; it never mandated a mode gate, so this is purely more spec-compliant.

5 `structuralAmbientOnly` unit tests (strip metadata / keep both shape booleans / undefined passthrough / metadata-only → undefined / end-to-end cede on a redacted ambient). Verified on the agentic host: `more-formal` cedes in a single-line field **with `ambient-context-mode: off`** (private harness scenario 121), alongside the existing WIPE (119) and on-field (120) scenarios.

### Added — agentic harness `ambient:` inject command for field-declared behaviour (`@opencues/runtime` 0.28.0 → 0.28.1)

The event bridge gained an `ambient:` command that injects a synthetic `AmbientContext` the resolver reads via `adapter.getAmbientContext` (`ambient:{"singleLine":true,"app":"chrome"}` sets it; `ambient:null` clears it). Production hosts supply ambient from the real focused field, but the headless harness has no field, so field-declared behaviour — the field-declared WIPE gate (#342) and `on-field:` scoping (#343) — had no agentic coverage. The override installs once and falls through to the adapter's own `getAmbientContext` when nothing is injected, so a host that genuinely reports ambient is unaffected until injected. Test-only; requires `ambient-context-mode: on` for the resolver to consult it. Paired with two new scenarios: `119-fluid-blank-field-declared-wipe` (asserts the runtime's `mode` decision — WIPE under `singleLine`, FILL with no ambient — never LLM text) and `120-on-field-cede-single-line` (control-first: `more-formal` lands a passive def in a multi-line field, then cedes to an empty def list under the SAME budget in a single-line field, proving the gate not slowness).

### Added — `on-field:` / `not-on-field:` field-kind scoping for cues/blanks/auditors (`@opencues/core` 0.37.0 → 0.38.0, spec `0.9-alpha → 0.10-alpha`)

A new per-source scoping axis, sibling to `on-host` / `on-site`: a cue declares which KIND of input field it may run in (`single-line` — a search box / omnibox / one-line field; `multi-line` — a prose editor / textarea). Motivation: a system-wide host (Windows) attaches to many fields, so a prose cue like the `more-formal` formalizer is nonsensical in a browser omnibox — it tried to "make `https://www.reddit.com` more formal" after the omnibox WIPE. `not-on-field: single-line` drops such a cue in every search box / address bar across every app and browser, while keeping it in prose surfaces — one declaration, no per-app upkeep. Chosen over app-name scoping (`not-on-app: chrome`) because that would both wrongly kill the cue in a browser's `<textarea>` comment box AND miss every other browser's omnibox.

Wired against the `singleLine` field declaration hosts already report (`AmbientContext`, added with the field-declared WIPE): `inferFieldCompat` predicate in `@opencues/core` (mirrors `inferSiteCompat`), parsed on cue/blank/auditor frontmatter, evaluated PER-RESOLVE in the source `supports()` gate (sentence-cues + word-cues). Dynamic by design — the focused field changes every focus, unlike the load-once `on-host`. Purely additive: a source with no field frontmatter, or a host that reports no field shape, is unaffected (`not-on-field` never excludes an unknown kind; `on-field` never matches one). Shipped `defaults/cues/more-formal/CUE.md` with `not-on-field: single-line`.

Spec `0.9 → 0.10`: documented in `core.md` § Field-kind scoping (the normative semantics + dynamic contract + graceful unknown-kind default), `cue-spec.md` / `blank-spec.md` / `auditor-spec.md` frontmatter tables, and the three JSON schemas. 6 `inferFieldCompat` unit tests (allow/deny/unknown/deny-wins/case-tolerant). Full core suite green.

### Added — field-declared WIPE: fluid-blank replaces the whole field for search/address boxes, data-loss-free (`@opencues/core` 0.36.1 → 0.37.0, `@opencues/runtime` 0.27.0 → 0.28.0, `@opencues/windows` 0.2.3 → 0.2.4)

App-aware `_` steering (#341) reshaped the fluid-blank ANSWER to an app's field format but couldn't remove the query, so a Chrome omnibox `reddit com _` produced `reddit com https://www.reddit.com` — the URL appended, the query left behind ("formats without removing the question"). Root cause: fluid-blank is FILL-only — the FILL/WIPE machinery was deliberately retired in the July-2026 blank-API slim-down (commit `f62dcd28`) for buffer-safety, because the old WIPE guessed FILL/WIPE from sentence shape and destroyed content it couldn't prove was disposable (an English-anchored regex collapsed foreign-language sentences to a bare value; multi-paragraph buffers were flattened — the "2 paragraphs → 1" incident). A prompt-only fix is impossible: the runtime ignores the model's MODE line by design.

The fix re-introduces WIPE the data-loss-free way, driven by the field's OWN declaration instead of a sentence-shape guess (the `a534a99e` "standalone-value WIPE" shape, generalised). Two new `AmbientContext` fields the host declares:

- **`singleLine`** — the field holds a single line (a search box, an address bar, a one-line form field). Fluid replaces the whole field ONLY when the buffer is *exactly* the lookup — the new exported precedent `bufferIsExactlyTheLookup(buffer, span)` (trimmed buffer === trimmed span, no `\n\n`) — so there is provably nothing but the query to remove.
- **`disposable`** — the field's content is a transient query/command (an omnibox, a launcher); replace it wholesale even when it holds more than the bare query. The `\n\n` paragraph floor stays absolute even here.

`bufferIsExactlyTheLookup` is THE reusable gate: any future source that wants to replace beyond the `_` MUST route through it (or a host `disposable`), never a sentence-shape heuristic — a header comment + the runtime `SPEC.md` § "FILL by default; field-declared WIPE" say so, with pointers to `f62dcd28` (why the old form was retired) and `a534a99e` (the safe shape). Wiring: `singleLine`/`disposable` on both `AmbientContext` types → the WIPE branch in `fluid-blank-source.ts` (emits `spanStart=0`/`spanEnd=len`; the resolver's existing multi-word-span splice applies it) + a per-key wipe flag in the variant cache so repeat lookups stay consistent. The Windows shim declares `singleLine` from the UIA control shape (`ControlType.Edit` = one-line; `.Document` = multi-line prose); the daemon forwards it. FILL stays the default for every host that declares nothing — CC/OC/chrome web fields are byte-identical.

Solves Chrome omnibox + Explorer search (`reddit com _` → `https://www.reddit.com`; `my tax pdfs _` → `*.pdf`, query gone). Pinned by 7 `fluid-blank-source.test.ts` cases (the precedent predicate; singleLine+buffer===query WIPES; buffer with other content FILLs; no-declaration FILLs; disposable WIPEs unconditionally; disposable multi-paragraph FILLs). Full core + runtime suites green; ambient bench unaffected (no-declaration prompts unchanged). Docs about the retired always-FILL machinery updated to the new reality (`fill-in-the-blank.md`, `blank-sources.md`, runtime `SPEC.md`) with the retirement/re-introduction commit pointers, per the "state deprecation + why, or remove" rule.

Supersedes the ineffective prompt-only attempt (an earlier `appSteer` `MODE=WIPE` rule that the runtime ignored).


### Added — input-box context → app-aware `_` output steering on Windows (`@opencues/core` 0.35.0 → 0.36.0, `@opencues/runtime` 0.26.1 → 0.27.0, `@opencues/windows` 0.2.2 → 0.2.3)

Extends `ambient-context-mode` to the Windows host: a `_` in a native input box is reshaped to that app's expected input. The daemon already tracked the focused foreground process name (`currentApp`); it now also builds a sanitized `AmbientContext` from the focus event (control Name → label, HelpText → placeholder, window title → pageTitle, process name → `app`), the `windows` adapter exposes it via a new `getAmbientContext()`, and `FluidBlankSource` receives it — chrome parity on Windows.

New optional `AmbientContext.app` field (the native equivalent of chrome's page/site). When present, `renderAmbientBlock` appends a short **app-steer sentence to the trusted framing of the USER message** (never the shared `FUSED_SYSTEM_PROMPT`): a file-manager / file-explorer search box → a bare file-search token (`my tax pdfs _` → `*.pdf`, `the downloads folder _` → `Downloads`), with a hard anti-empty floor (echo the user's own words rather than blank the answer).

**Field-only, by construction:** only the focused field's own metadata + the window title are read — never a sibling control's value, never OS/env/cwd data. The steer lives in the user message emitted only when `app` is present, so every app-less prompt (all of chrome + the 176-case ambient bench) stays byte-identical to baseline — `fluid-blank-ambient/fused-bench.ts` holds at 175/176. The `app` field is UNTRUSTED and sanitized like every ambient field. `getAmbientContext()` returns null while detached (a stale field's app can't leak into a later prompt) and degrades to null on any binding error (never crashes the keystroke path). Full design + threat-model: `docs/architecture/ambient-context.md` § *App-aware output steering*.

Re-applied on top of the Windows phase-2 integration (#334) after #334 landed first; supersedes the standalone PR #309 (whose windows integration was the older 33-file copy #334 replaced). Pinned by the app-steer render cases in `fluid-blank-source.test.ts` + the `getAmbientContext` delegation contract in `adapters/windows/v1/adapter.test.ts`.

### Fixed — cueMap word-cues leaked onto the no-cycling profile (`@opencues/runtime` 0.26.1)

The universal-integration prune covered the source-build path but not the cueMap/tips path: `DimRender` and `Navigation` read `configLoader.navigableWords` directly, so tips-based word-cues dimmed (and targeted) on fields whose adapter reports `supportsCycling() === false` — a dim that IS the offer to cycle, on a field that can't. Same path-2 class the doc records for BlankFill; made visible by the windows per-field profile and caught by the new phase-2 wire e2e (journey D). Both consumers now consult `adapter.supportsCycling?.()` per pass (dynamic — windows shares one module set across cycling and non-cycling fields); Navigation's no-cueMap test-scaffold fallback is guarded so it can't fire on the suppressed profile. New `integrations/windows/tests/phase2-cycling.e2e.mjs` (in pre-pr): real daemon + fake shim over the wire protocol — focus/chord/render/set-text journeys incl. slideCharSpans and the deactivation kick, LLM-free via tips cues.

### Changed — windows-integration PR version reconciliation (`@opencues/core` 0.35.0, `@opencues/runtime` 0.26.1, CLI 0.2.57, `@opencues/windows` 0.2.2)

Final version bumps for the windows-integration branch (PR #334) after a second `master` merge (map-card fix #340 / spaced-weave #337 / docs #338 landed on master first): the branch's earlier entries below cite the in-branch version numbers they were written against (core 0.21.x / runtime 0.18.x era); the shipping bumps are core 0.35.0 — bumped from master's 0.34.0 since the branch's core src (RoutedWordSourceGroup never caches error envelopes + `log` sink; windows host-compat + no-cycling build-sources) differs — runtime 0.26.1 (`DynDefs.slideCharSpans`, `HostAdapter.markdownPassthrough`, navigation deactivation render-kick, cueMap no-cycling-profile fix), CLI 0.2.57 (windows host install/run wiring, bumped from master's 0.2.56).

### Fixed — RoutedWordSourceGroup cached error envelopes as "no cues", silently and permanently (`@opencues/core` 0.21.0 → 0.21.1, `@opencues/windows` 0.2.0 → 0.2.1)

A transient word-cue dispatch failure (abort, 429, provider schema-validation flake) returns `{error, results: []}` — and the group's per-source LRU cached that empty unconditionally, answering "no cues" for the exact word set until the next source rebuild. Because `ConfigSource` never logs and the resolver ignores per-source `error` fields, the poison was fully silent. Found live on the Windows phase-2 branch: groq/gpt-oss intermittently fails its own JSON-schema enforcement on the spelling prompt (~1/3 of dispatches, reproduced in isolation), which read as "word-cues never fire on windows" for whole sessions. Now: error envelopes are NEVER cached (next identical call re-dispatches) and the failure is logged via a new `log` sink on `RoutedWordSourceGroupConfig`, wired from `buildSourcesFromConfig`'s existing `options.log`. Pinned by a new case in `routed-word-source-group.test.ts` (fail → logged + not cached; recover → cached). Also: the windows `capture` overlay style re-captures spans the caret sits inside on every refresh tick ("hot" spans), so the caret blink and live edits under the patch stay visible; the retired `repaint` style is replaced by `capture` (the app's own glyph pixels, luminance-pulled toward the corner-sampled background).

### Added — Windows phase 2: word-cues + cycling + click-through overlay + real caret (`@opencues/windows` 0.1.1 → 0.2.0, `@opencues/runtime` 0.18.6 → 0.18.7)

The Windows host graduates from the Universal-Integration (no-cycling) profile to a **per-field dynamic** one. The shim gains a WH_KEYBOARD_LL hook (Ctrl+Alt+arrows swallowed and forwarded as `key` messages while a cycling-capable field is attached; unconsumed chords re-injected with an `INJECT_MARK` extra-info so the hook passes them through; Escape observe-only), a layered click-through overlay (`OverlayForm` — dim/highlight char spans resolved to physical screen rects via TextPattern `GetBoundingRectangles`, three switchable dim looks via the daemon's `OPENCUES_WIN_OVERLAY_STYLE=underline|wash|repaint`), and real caret tracking (native `IUIAutomationTextPattern2.GetCaretRange`, with `set-cursor` applied via `EM_SETSEL` / native collapsed `Select()`). The daemon collects `RenderDirectives` on every user event + `forceRender` and ships flattened `render {dim, hl, style}` messages (`src/render-wire.cjs`); `supportsCycling` is now `PHASE2 && attached && fieldCycling` where `fieldCycling` arrives on the `focus` message (UIA attach + managed TextPattern → true; MSAA/Electron fields keep phase-1 behaviour). The windows band advertises `dim-ranges` + `highlight-range` + `render-rgb-color`, which is what un-inerts the already-wired DimRender. Kill switches: `OPENCUES_WIN_PHASE2=0` (daemon), `OPENCUES_WIN_HOOK=0` / `OPENCUES_WIN_OVERLAY=0` (shim). Pinned by `integrations/windows/tests/render-wire-invariants.mjs` (wire-mapping units + hook/overlay/daemon source guards, wired into pre-pr). Also ASCII-sweeps pre-existing non-ASCII glyphs in `native/` that tripped `check-windows-native-ascii.sh`.

**Same-field resume (first live-test fix):** the blanket `resetBufferState()` on every focus change wiped all spans on a click-away-and-back — substitution DynDefs are unrecoverable by re-resolve, so marks never came back. The reset is now DEFERRED from blur to the next focus: same `fieldId` (new on the focus message) + unchanged text → resume with spans preserved + instant overlay repaint; different field or text → full reset as before. Two write guards close the landmine the deferral exposes (both fired/verified live): the daemon drops `setText`/`pushText` with no attached field AND poisons the resume; the shim verifies the focused element IS the attached one (UIA runtime-id match) before any write path — a late in-flight result can no longer land in whatever the user focused next. Known edge: focus-away DURING the loading animation leaves the field with a stale spinner glyph (the final write is correctly dropped; recoverable by deleting the glyph and re-typing `_`).
### Security — Windows config server is same-origin-only; closes drive-by API-key theft (`@opencues/windows` 0.1.2)

The Windows integration's WSL daemon runs an HTTP config server (`config-server.cjs`) on a fixed loopback port (default 51790) whose `GET /api/keys` returns the user's **raw** LLM provider keys for the same-origin settings popup. It was sending `Access-Control-Allow-Origin: *` on every response, so **any web page the user visited could `fetch('http://127.0.0.1:51790/api/keys')` and exfiltrate every key** (Groq/OpenAI/Anthropic/Cerebras/Gemini/OpenRouter) — the 127.0.0.1 bind stops LAN access but not browsers, which any website can pilot into loopback. `POST /api/config` had the same exposure for deleting/tampering keys and settings (CSRF).

The only legitimate client is the popup the daemon itself serves (same-origin — `http-config-adapter.ts` uses relative `/api/*` URLs), so the fix is a same-origin trust gate that fires before routing: **no CORS headers at all** (browser blocks cross-origin reads), a **loopback `Host` allow-list** (defeats DNS-rebinding), and **refusal of any non-loopback `Origin`** incl. the opaque `"null"` (defeats cross-site fetch/POST). Defence-in-depth: scalar and `.env` writes strip CR/LF so a value can't inject extra OPENCUES.md/`.env` lines. Keys stay readable by same-user native processes (same trust as the `~/.cues/.env` file). The TCP shim socket is unaffected — it speaks newline-JSON, not HTTP, so a browser can't drive it. Pinned by `integrations/windows/tests/config-server-security.mjs` (8 invariants, wired into pre-pr); new `security-audit.md` row #30. Also removed a stray `test.txt` accidentally committed at the repo root.

### Added — per-target markdown pass-through for hosts without a styling surface (`@opencues/runtime` 0.13.4 → 0.13.5)

New optional `HostAdapter.markdownPassthrough?(): boolean` hook, consulted at the single markdown-write chokepoint (`applyMarkdownAwareSplice`). When it returns true, LLM-emitted markdown markers (`**bold**`, `*italic*`, …) are written to the buffer VERBATIM instead of the default strip-then-render-natively pipeline, and no `markdown.styled` event fires. Motivation: the windows host has no styling surface (no overlay in phase 1), so the strip destroyed requested styling with nowhere to re-render it — while markdown-native composers (Discord) render the markers themselves at send time. The windows band wires the hook per focused app (daemon-side `OPENCUES_MD_PASSTHROUGH_APPS`, default `discord`; Slack deliberately excluded — its WYSIWYG composer only interprets markup typed live). Hosts that omit the hook — every in-process host — keep the strip+render path byte-identically (pinned by four new cases in `markdown-substitute.test.ts`).
### Fixed — multi-line blank answers (`map _` card) no longer truncated to their first line (`@opencues/core` 0.34.0, `@opencues/runtime` 0.25.3, spec `0.8-alpha → 0.9-alpha`)

The location `map` card (name / full address / Google Maps link), the claude-status block, and the `model` catalog are each a SINGLE multi-line answer, but `BlankFill.applyAsyncFill` split every multi-line `get` result on `\n` into cycleable alternatives and committed only line[0]. So `map east finchley station _` delivered just `East Finchley Station` and silently dropped the address + the map URL (reported on macOS as opencues #339). That split is correct for genuine list blanks (a top-N feed like hackernews, whose lines ARE separate choices), so the fix is a per-blank opt-in rather than a global change: a new `blankMultilineIsAnswer: true` frontmatter key (default `false`) makes the fill join the lines into one answer instead of truncating. New spec frontmatter key (§ Frontmatter optional + § Flag obligations in `blank-spec.md`, `blank.schema.json`, `SPEC_VERSION 0.8 → 0.9` — additive, `0.8` readers ignore the unknown key). The three single-card default blanks (`location`, `claude-status`, `model`) declare the flag AND are additionally listed in a code-side set (`SINGLE_ANSWER_BUILTIN_BLANKS` in `@opencues/runtime`), so an **upgrading** user gets the fix from the runtime bundle alone — `seed-configs` is first-time-copy only and never overwrites an existing `~/.cues/blanks/*/BLANK.md`, so the flag would otherwise never reach them; the code set closes that upgrade-boundary gap. hackernews, `note` recall (multiple matches the user cycles through), and other list blanks are in neither and keep per-line cycling. Pinned by four `blank-fill.test.ts` cases (with-flag joins; without-flag splits; built-in name with no flag still joins; non-built-in with no flag still splits) + agentic scenario 112 (`map _` end-to-end retains the `Map:` URL line, verified against a flag-less location config). Note: a user whose `~/.cues/blanks/location/BLANK.md` predates the `map` keyword entirely (not just the flag) still needs `opencues seed-configs` after deleting that file to route `map _` to the location card at all — the code set fixes the truncation, not a missing keyword.

### Fixed — spaced blank-trigger + integration-weave dropped the fill silently (`@opencues/runtime` 0.25.2)

With `blank-trigger-mode: spaced` AND `integration-weave-mode: on` (both non-default), a script blank that weaves its `integration:` output (e.g. `volume _` → "volume is now 30%") emitted `blank.substituted` but never committed to the buffer — it stayed `volume _ `. Root cause: `spaced` fires BOTH BlankFill and the resolver on the confirming space, so the loading slot is co-owned and BlankFill's own `stop` doesn't restore the `_`. The weave's staleness check (`liveNow !== cleaned`, full-string) then read the transient loading-frame char at the slot as a user edit and dropped the fill. The earlier `ourSlot` guard already proves the slot was ours at dispatch, so the check now compares every word EXCEPT the slot word — a real edit elsewhere still drops (their edit wins), a transient slot char does not. Pinned by two new cases in `blank-weave-fill.scenarios.test.ts` (lingering slot char commits; real edit drops) + the agentic scenario 32. Found by the 2026-07-25 full agentic suite run (opencues #336); default-config users unaffected (both modes off by default).

### Fixed — `opencues run <host> --no-cleanup` leaked the flag into the host's own CLI (CLI 0.2.56)

`--no-cleanup` gated the predecessor-kill correctly but was never consumed in the argv loop (unlike `--skip-banner` / `--no-rebuild-check`), so it rode `passthrough` into the spawned host's command line. opencode prints its help and EXITS on an unknown flag — which silently killed every agentic-harness pool shard ("0/N shards live"; without the flag, concurrent shard launches SIGTERM each other via the predecessor-kill instead, so parallel harness runs were broken both ways). The flag is now consumed opencues-side; the predecessor-kill gate still reads it from the original argv.

### Security — ground the contradiction-cue geocoder inputs + cap calendar feed size (`@opencues/core` 0.33.0)

Static security review of the July 2026 external-HTTP feature cluster (calendar ingest + Tier-0…5c contradiction cues). Two hardenings; both features are `contradiction-cues-mode` / calendar-feed opt-in, so neither is a live default-on exposure.

- **Journey cue (Tier 5c) — LLM output no longer reaches the external geocoder ungrounded.** `verifyJourneyClaim` grounded only the `quote` before geocoding `origin`/`destination` via `photon.komoot.io`, but those two fields are LLM-emitted and were sent outward without being checked against the sentence — the one place the "no LLM-output → side-effect channel" invariant (`security-audit.md`) was touched. A prompt-injection could route arbitrary text to the third-party geocoder, and a hallucinated place could fire a false cue. Now both endpoints must be a short (`≤ GEOCODE_NAME_MAX = 80`) literal substring of the sentence (`isGeocodableName`) before either is geocoded, so the only strings that leave the machine are ones already present in the buffer the LLM was given. The egress host was, and remains, hardcoded (never LLM-chosen); chrome additionally gates it through the SW's `FETCH_ALLOWED_ORIGINS` allow-list. Two `SECURITY:` scenario tests pin the gate (ungrounded origin + oversized name never reach the geocoder). New `security-audit.md` row #28.
- **Calendar feed sync — a pathological/compromised feed body is capped.** `syncCalendarFeeds` now drops any single feed whose body exceeds `CALENDAR_FEED_MAX_CHARS` (5 MB) before parsing, bounding memory + parse work on a hostile/MITM'd response (feed URLs are user-configured, so this is defense-in-depth on a user-against-self surface). One regression test. New `security-audit.md` row #29.

### Changed — Gemini default model → `gemini-3.5-flash-lite` + no-thinking bench knob (`@opencues/core` 0.32.0, CLI 0.2.55, `@opencues/chrome` 0.2.90)

Google shipped `gemini-3.5-flash-lite` and `gemini-3.6-flash` (July 2026). The 2026-07-21 discovery sweep (`tests/results/gemini-3.6-3.5-discovery/REPORT.md`, same-session `gemini-3.1-flash-lite` baseline, all no-thinking) showed 3.5-flash-lite is a strict upgrade for the default slot: first perfect Gemini fluid-blank score (137/137 vs 134/137), fastest mean (431ms vs 511ms), and it eliminates the baseline's multi-second p99 tail (worst case 620ms vs 3632ms), with transform-blank at parity (86.0% vs 86.7%, n=487). `gemini-3.6-flash` benched +1.4pp transform accuracy at ~70% more latency (and its floor is slower than the lite tiers' p90) — documented as an accuracy-over-latency override, not the default. The GEMINI adapter's `defaultModel`/`knownModels`, CLI help/review defaults, chrome popup defaults, and all bench-adapter fallbacks moved together; 3.1-flash-lite stays reachable in `knownModels`. Also added an env-gated `thinkingConfig` hook to the GEMINI `buildRequest` (`OPENCUES_GEMINI_THINKING=none|minimal|low|high`; unset = provider default, unchanged) — needed because the 3.5/3.6 tiers reject the historical `thinkingBudget: 0` no-thinking config (400); `thinkingLevel: "minimal"` is their true floor (verified 0 thought tokens on hard prompts). 3.5-flash-lite does not think by default, so the production default path sends no thinkingConfig, exactly as before.

### Fixed — browser-safe guards on the calendar-ingest OPENCUES_HOME reads (`@opencues/runtime` 0.25.1)

The two ingest closures read `process.env` unguarded — the runtime-browser-safe lint had been red since #322 (masked by a broken CI-watch pipe; five PRs merged over the single failing job). Guards added; semantics unchanged (the ingest already early-returns in browsers).

### Fixed — `opencues calendar remove` now clears cleanly (no ghost calendar) (CLI 0.2.54)

Removing a feed only edited `calendar-feeds.txt`; the snapshot reconciled on "the next poll" — which, for the LAST feed, never comes (`syncCalendarFeeds` refuses on no-feeds and the scheduler's due-check goes permanently quiet), so the deleted calendar's events ghosted forever: stale PII still firing conflict cues and answering availability. Now `remove` reconciles immediately: with feeds remaining it re-syncs on the spot (removed events drop now, not within the 15-min TTL); removing the last feed writes an EMPTY snapshot — empty beats deleting the file, because chrome's loader falls back to the bake-time bundled snapshot when the file is missing, which would resurrect even older events. External producers that write `calendar.json` without a feeds file are unaffected (the clear only runs on user-initiated remove). Hosts pick up the cleared snapshot within ~60s via the ingest. Two hermetic regression tests.

### Added — refresh scheduler: calendar feeds self-sync every 15 minutes (`@opencues/core` 0.31.0, `@opencues/runtime` 0.25.0, CLI 0.2.53)

The system now owns refresh cadence: a `RefreshScheduler` (runtime) ticks every 30s and asks registered resources "are you due?" — nothing "calls" a sync. Calendar feeds are the first resource: due when the shared snapshot's own `ingestedAt` is older than 15 minutes, so any number of concurrently-running hosts self-deduplicate off the same file clock (plus per-process jitter and a pre-write re-stat in core that discards a fetch another producer superseded). The feeds→snapshot sync itself moved to `@opencues/core` (`syncCalendarFeeds` — atomic tmp+rename write, VCALENDAR sniff, last-good posture on failure) with THREE callers sharing the one implementation: the CLI (`opencues calendar sync`), the runtime scheduler inside `buildCalendarContextIngest`, and chrome-host (5-min due-check on its watch loop; the resulting write trips its existing fs.watch → bundle push). User journey collapses to `opencues calendar add <url>` — feeds are at most ~15 min stale while any host runs, file→runtime stays ≤60s. In-flight guards, contained failures, unref'd timers (never in the keystroke path, never keeping a process alive). 5 scheduler + 8 core-sync + 1 end-to-end ingest tests, all hermetic.

### Fixed — doctor: chrome-host push-list check false-positived on registry-derived scripts (`opencues` CLI 0.2.52)

`host.cjs` derives its push list from `chromeHostFileList()` at runtime — structurally drift-proof — but doctor verified parity by grepping the script TEXT for literal basenames. Older names passed only because they happen to appear in comments/filter code; NOTES.md and calendar.json (the two newest pushed files) "failed" despite being pushed correctly. Doctor now recognises a registry-derived script (`chromeHostFileList` present) and reports that as the check; the literal grep remains only for pre-derive host scripts that hardcoded the names.

### Fixed — chrome bundle: `node:os` external for the calendar-ingest helper (`@opencues/chrome` 0.2.89)

`buildCalendarContextIngest` (0.24.0) lazy-requires `node:os`; chrome's esbuild external list had only `node:fs`/`node:path`/`node:child_process`, so the chrome build hard-failed at install time. The helper self-disables in the browser (chrome has its own loader), so external-as-is is correct. The PR #49-class gate didn't fire on #322 because the chrome build task cache-hit; `opencues install chrome` caught it.

### Fixed — Tier 5c journey geocode was silently inert on native hosts (`@opencues/core` 0.30.1)

`geocodePlace` bailed when `fetchImpl` was undefined — but native hosts (CC/OC/gemini/shell) omit `worldDataFetch` (only chrome supplies one, routed through its service worker), so the whole journey-underestimate tier never fired outside chrome. Unit tests never saw it (they inject stub fetches); the agentic suite caught it on a live OpenCode host. Now defaults to the ambient `fetch`, mirroring BankHolidayProvider/WeatherProvider/TflProvider. Regression pinned with an ambient-fetch unit test.

### Added — calendar-context: native hosts now read the shared snapshot (`@opencues/runtime` 0.23→0.24)

Closes the native-consumer gap: `~/.cues/calendar.json` (produced by `opencues calendar sync`) was consumed only by the chrome bootstrap — the calendar-conflict cue and fluid-blank availability answers were silently inert on Claude Code, OpenCode, Gemini CLI and shell. New `buildCalendarContextIngest` in `boot-common` reads the snapshot (`$OPENCUES_HOME/calendar.json` first — which also gives test shards an isolated calendar — then `~/.cues/calendar.json`), tokenises titles/locations via core's `buildCalendarContextSnapshot`, and refreshes mtime-gated on an unref'd 60s timer; all four native bands pass the live holder as `ResolverOptions.calendarContext`, matching chrome's contract. Missing file = documented inert mode; malformed file keeps the last good snapshot and logs. 5 hermetic unit tests (mkdtemp `OPENCUES_HOME`).

### Added — contradiction cues Tier 5c: journey-time underestimation (`@opencues/core` 0.29→0.30)

Fifth slice of the contradiction-cue family (the "physics" lane): catches a travel time between two named places that grossly underestimates the real journey — "it's a 10-minute walk from the Tower of London to Camden" → **"that's about a 95-minute walk, not 10"**. A `journey_underestimate` claim type (extracted only when BOTH endpoints are named places AND a minute figure is stated) verified ASYNC (per-query, not a cached dataset): both ends are geocoded via the keyless open-meteo geocoding API, disambiguated by proximity to the user's timezone-derived home region (so "Camden" resolves to the user's Camden, not Camden, New Jersey), and the time is estimated from great-circle distance × a mode detour factor ÷ a mode speed. Precision-first: fires ONLY on gross underestimation (real ≥ 1.6× stated AND ≥ 10 min over), and a per-mode distance cap bails when the two names clearly geocoded to different cities. **Deliberately rough** (straight-line, not real routing) — it exists to catch "10 minutes" that's really an hour, not to be a route planner. This is the tractable slice of the concept doc's calendar×maps "impossible sandwich"; the calendar-conflict half is already covered by `calendar-context`, and true routing/transit timing is a keyed-API follow-up. Reuses the geocoding origin already allow-listed for weather. 6 new unit tests; validated live against real geocoding.

### Added — contradiction cues Tier 5b: London transit disruption (`@opencues/core` 0.28→0.29)

Fourth slice of the contradiction-cue family (London-flavoured): catches planning to travel on a Tube/DLR/Overground/Elizabeth line that's currently disrupted — "I'll take the Victoria line home" → **"the Victoria line has Severe Delays right now"**. A `tube_line_plan` claim type (the model extracts a named line only when the writer plans to *use* it — take/get/catch/change onto — never a station name or a bus) + a verifier that checks the line against a cached `TflProvider` (keyless TfL Unified API line status; "Minor Delays" and "Good Service" excluded as near-constant noise, so only genuine disruption — severe delays, closures, suspensions — fires). Scope is the weekend-engineering-works / disruption cue, which keys off the line name and needs no per-user anchor; the concept doc's two anchor-dependent cues (live bus arrivals, last-train) are deferred until a location FTUX exists. **Known limitation:** the check is against CURRENT status, so it's accurate for near-term plans but a weaker signal for a plan several days out (current severe delays may not hold). Chrome routes the TfL fetch through the SW (`api.tfl.gov.uk` added to `host_permissions` + the SW allow-list). 8 new unit tests; validated live against the real (heavily disrupted) TfL API.

### Added — contradiction cues Tier 5: outdoor plan vs weather (`@opencues/core` 0.27→0.28, `@opencues/runtime` 0.22→0.23)

Third slice of the contradiction-cue family: catches planning a clearly outdoor, weather-dependent activity on a day the forecast says rain — "let's have a picnic in the park on Wednesday" → **"Wednesday's forecast is rain (90% chance)"**. Extends the extract → verify pattern with an `outdoor_plan_weather` claim type (extracted only when the activity is unambiguously outdoors and weather-sensitive — a picnic/BBQ/hike/patio-lunch, never an indoor meeting or restaurant dinner) and a verifier that checks the resolved date against a cached precipitation forecast, flagging only at/above a 60% max-precip threshold (precision-first). Data is a new `WeatherProvider`: the keyless open-meteo forecast (16-day, hourly TTL), same background-refresh-and-read-synchronously contract as the bank-holiday cache. Location is the anchor: defaults to central London, overridable via a `weather-location: lat,lon` scalar (dates beyond the forecast window, or a dry forecast, stay silent). Chrome routes the fetch through the SW (open-meteo already in `host_permissions`); the earlier `bankHolidayFetch` host seam generalized to `worldDataFetch` for both caches. 9 new unit tests; validated live against real open-meteo data + a controlled wet-forecast positive.

### Added — contradiction cues Tier 0.5: public-holiday collision (`@opencues/core` 0.26→0.27)

Second slice of the contradiction-cue layer: catches scheduling ordinary work onto a public holiday — "let's do the team meeting on Monday the 31st of August" → **"Monday the 31st is a bank holiday (Summer bank holiday)"**. Extends the Tier 0 LLM-extract → code-verify pattern with a `workday_on_holiday` claim type (the model extracts a working-day date reference — weekday and/or day-of-month — only when it's framed as normal work, never when already framed as a day off) and a verifier that resolves the date and checks it against a cached holiday table. Data is a new `BankHolidayProvider`: the keyless GOV.UK `bank-holidays.json`, background-refreshed fire-and-forget (daily TTL) and read synchronously in the keystroke path — never a fetch on the hot path, keeps last-good on failure. Zero privacy cost (a public dataset, no personal data leaves the machine). Same passive `sentence-cue:` shape as Tier 0, competing for the span, surfaced on the existing status line. 10 new unit tests (verifier + provider); validated live against real GOV.UK data and in the agentic harness.

### Added — contradiction cues Tier 0: deterministic fact-check of what you type (`@opencues/core` 0.25→0.26, `@opencues/runtime` 0.21→0.22)

First slice of the contradiction-cue layer (docs/research/life-context-concepts): a passive layer that fact-checks the buffer against itself + the clock, no LLM and no network. Tier 0 ships two deterministic checks — **weekday-date mismatch** ("see you Thursday the 24th" when the 24th is a Friday → flags it + offers "Friday the 24th") and **split-the-bill math** ("$120 among 4, $25 each" → "$120 ÷ 4 = $30 each, not $25"). Built as `ContradictionCueSource` emitting the same passive `sentence-cue:*` shape as the calendar-conflict cue, so the correction is cycleable and the tip surfaces on the status bar. Gated behind `contradiction-cues-mode` (OFF by default). Precision-first: every check bails to silence on any ambiguity (a wrong cue trains distrust). 13 deterministic unit tests. This is the framework the data-backed tiers (0.5 public-calendar, 5 world-data, 5b city-life, 5c physics) build on.

### Changed — calendar-context is now ON by default (`@opencues/core` 0.24→0.25, `@opencues/runtime` 0.20→0.21)

`calendar-context-mode` defaults to `on`. The safety argument: the feature is **completely inert until you add a feed** (`opencues calendar add <ics-url>`) — with no `~/.cues/calendar.json` the snapshot is empty, `renderCalendarContextCatalog` returns `''`, and the resolver forwards nothing, so **zero data leaves the machine** until you deliberately add a calendar. That feed-add IS the opt-in; the separate mode toggle was a redundant second gate. Once a feed exists, titles + locations are dehydrated to tokens (hydrated locally) and only anonymized busy-interval **times** reach the LLM — a reasoning catalog can't hide the times it reasons over, but it can (and does) hide the *what* and *where*. Explicit `calendar-context-mode: off` still disables even a configured feed. (Note: unlike system-context — a pure-substitution catalog whose on-by-default has *no* residual — calendar-context does expose busy-interval times when a feed is present; that's the deliberate trade for free/busy reasoning.) Flipped in `feature-registry` (first value), `config-loader` (default-on parse, `off` is the disabling value), and `defaults/OPENCUES.md`.

### Fixed — seed-configs now self-heals the life-context → calendar-context rename in existing installs (`opencues` 0.2.50→0.2.51)

The rename (#312) migrated the code but left existing users' `~/.cues/` on the old names — the gate scalar especially: `life-context-mode: on` in an existing `OPENCUES.md` read as *nothing* after the rename (the runtime looks for `calendar-context-mode`), silently turning the feature off on upgrade. `seed-configs`' PRE-SEED MIGRATE step now rewrites the OPENCUES.md scalars (`life-context-mode` → `calendar-context-mode`, `life-context-poll-minutes` → `calendar-poll-minutes`) and renames the data files (`life-context-feeds.txt` → `calendar-feeds.txt`, `life-context.json` → `calendar.json`) — same idempotent pattern as the sentinels→identity self-heal. The `opencues calendar` CLI already migrated the files on its own invocation; this covers the install path for users who never run that command. Pinned by a command-level migration test.

### Fixed — calendar-context "where is X" answered "no location listed" on live hosts (`@opencues/core` 0.24→0.24.1)

The location render was correct in the bench but broke on every live host (found on chrome). The hosts reconstruct event objects field-by-field across the boundary (chrome holder / resolver options) and dropped the DERIVED `locationToken` while keeping `token` + `location`, so by the time `renderCalendarContextCatalog` ran, `e.locationToken` was undefined → no `@ [EVENT N LOCATION]` in the prompt → the LLM correctly answered "no location listed" for an event that HAD a location. Classic bench-invisible boundary drift (the bench calls build→render directly). Fix: **re-derive** the token at the point of use — FluidBlank rebuilds the snapshot via `buildCalendarContextSnapshot` from the threaded raw events (which keep `location`), so no boundary can drop it again; and `locationToken` is now derived from the event's `token` (not its index) so a rebuild is always self-consistent, even with custom tokens. Two round-trip regression tests pin it (`calendar-context` unit 23/23).

### Added — calendar-context: local title→token pre-match closes the safe-mode "where is the dentist" gap (`@opencues/core` 0.23→0.24)

Title-based calendar lookups now resolve in safe mode. Before, `where is the dentist _` / `when is the supabase sync _` declined — the LLM sees `[EVENT N]` with the title dehydrated, so it couldn't tie your typed word to the right event. `matchCalendarTitles` now does that tie **on-machine**: it fuzzy-matches the distinctive words you typed against the real (local) titles and hands the LLM the resolved `[EVENT N]` token via a USER-message hint. The title never leaves the box — the hint carries only **your own matched words** (`"dentist" → [EVENT 1]`, never the rest of the title), so there's no new PII on the wire, and it rides the USER message (not the cached system prompt) so cerebras' prefix cache stays warm.

**Conservative by construction:** a word resolves ONLY when it uniquely identifies one event — a word shared by two events, or matching none, resolves to nothing, so a misleading hint can't be produced (a bad hint is worse than no hint). Bounded Levenshtein tolerates typos (`dentst` → Dentist); stopwords (query / availability / generic-calendar words) never drive a match. Wired into `FluidBlankSource`'s user message; matched against the original pre-dehydration input.

Validation: 8 new deterministic matcher unit tests (exact / case-insensitive / typo / multi-word / ambiguous→skip / stopword→skip / no-match / PII-invariant) — `calendar-context` unit 21/21. Live correctness bench (groq gpt-oss-120b): the new `by-title` lookup + `where-title` cases resolve **3/3**, `where-standup` stays fail-safe (matched but no location → doesn't invent), no regression (availability 24/24 · lookup 12/12 · where 9/9 · controls-clean 9/9 · recall 6/6 · hydration 6/6).

### Changed — renamed the shipped feature `life-context` → `calendar-context` (`@opencues/core` 0.22→0.23, `@opencues/runtime` 0.19→0.20, `opencues` 0.2.49→0.2.50, `@opencues/chrome` 0.2.74→0.2.75)

The shipped feature only ingests a **calendar**, so it's now named for what it does: scalar `calendar-context-mode`, module `calendar-context.ts` (+ `CalendarContext*` symbols / `buildCalendarContextSnapshot` / `renderCalendarContextCatalog`), files `~/.cues/calendar.json` + `~/.cues/calendar-feeds.txt` + `.calendar-refresh`, the `uses-calendar-context` CUE flag, and `calendar-poll-minutes`. The `opencues calendar` CLI is unchanged (it was already calendar-named). Rationale: the name now matches the CLI, is discoverable, and cleanly separates your **personal, dehydrated-PII calendar** from any future **public world-data** source (transit / weather / OSM), which has a different trust model and would be its own catalog. **"life-context" survives only as the informal umbrella term** in `docs/research/life-context-concepts/`. Existing users self-heal: `opencues calendar` migrates `~/.cues/life-context-feeds.txt` + `life-context.json` to the new names on first run (idempotent). `lint-legacy-names.sh` now bans the old shipped identifiers (bare "life-context" is NOT banned — the umbrella keeps it). Pure rename — no behaviour change; core/runtime build clean, calendar-context unit 13/13, WHERE bench parity.

### Changed — calendar cue surfaces in the STATUS BAR (no cycling) + shows day+time

The calendar-conflict advisory now lands in the **status line/bar** — you *read* it passively with the cursor on the sentence, instead of pressing Ctrl+Alt+Up to cycle to a buffer-mutating alternative. This required real plumbing: the status line previously only read STATIC word-cue tips from the config-loader, so a sentence-cue's dynamic advisory had no path to it. Added a `cueTip` field to `WordDef`, threaded it through the resolver's passive sentence-cue registration, and taught the statusline to surface `def.cueTip` (including in the blankName-attributed branch that used to force `cueTip: null`) — verified by a runtime test that a passive def (`currentIndex 0`, not cycled) surfaces its advisory, and that `tips-mode: off` suppresses it. `SentenceCueSource` (when `uses-calendar-context`) extracts the `— heads up: …` flag into the `cueTip` (`⚠ Dentist today, 3:00–3:45pm; …`); the cycleable insert remains an optional extra. Each flagged event shows **title + day + time** (never bare) — "Conference **Sat Aug 23, all day**", "Dentist **today, 3:00–3:45pm**". Chrome E2E 16/16 (no regression).

### Changed — calendar-conflict cue: show the title, handle all-day, list multiple

The calendar cue (`defaults/cues/calendar/CUE.md`) now: (1) always names the clashing event by its **title** (via the `[EVENT N]` token) — never a bare time; (2) shows **`all day`** for all-day events instead of a fake `12:00am–11:59pm` window (so a date-only reference like "let's meet on august 23rd" reads "Conference all day"); (3) **lists EVERY** clashing event, not just the first ("I'm free this afternoon" → "Dentist 3:00–3:45pm; Team standup 4:00–4:30pm"); and (4) matches at DAY level when the sentence gives a date but no time. Bench `calendar-context-cue-test.ts` extended: base 24/24 + list-multiple 3/3 + all-day-title 3/3 on groq gpt-oss-120b.

### Added — calendar-context for chrome (cue renders!) + shared `calendar sync` producer (`@opencues/core` 0.27→0.28, `@opencues/runtime` 0.21→0.22, `opencues` 0.48→0.49, `@opencues/chrome` 0.2.68→0.2.69)

Makes the calendar-conflict **cue** testable — it renders as a highlight in chrome's rich/contenteditable editors (Gmail, claude.ai, Notion, …), which support cycling (unlike Windows/no-cycling). The architecture is deliberately simple: **one shared snapshot file, produced OpenCues-side, consumed by every host.**

- **`opencues calendar sync`** — the PRODUCER. Fetches every feed → writes `~/.cues/calendar.json` (the one snapshot all hosts read). A total fetch failure never overwrites the last-good file. `add`/`refresh` can trigger it. This replaces per-host pollers with one central refresh.
- **Chrome consumes, never fetches.** `calendar.json` is registry-pushed (`prereqFile` + `pushedBy: ['chrome-host']`), so `opencues sync chrome` + the native-messaging host carry it into the bundle. The bootstrap reads it → `buildCalendarContextSnapshot` → a mutable holder passed to the resolver, re-loaded on every `opencues_bundle` storage change. Chrome band gains a `calendarContext` HostInfo field + resolver option (mirrors windows). The calendar `CUE.md` already syncs via the folder-cues walk.
- **Cue renders in chrome's contenteditable mode** (`supportsCycling: true` there); pruned in plain `<input>` (no-cycling), same rule as everywhere.
- Verified: core/runtime/chrome all typecheck + esbuild clean; `loadCalendarContext` present in the bundle; feature-registry alignment green.
- **Follow-up (optional):** a chrome-native fetch fallback for users with no chrome-host (chrome has `<all_urls>`; would use MV3 `chrome.alarms`). Not needed when the OpenCues-side producer + chrome-host are present.

> **To test (chrome):** `opencues calendar sync` → `opencues sync chrome --wsl` (or run the chrome-host) → copy `dist/`+`manifest.json` to the Windows extension dir → reload the extension + hard-refresh → set `calendar-context-mode: on` and `sentence-cues-mode: on` → in a contenteditable field type "I'm free on the 23rd" and cycle Ctrl+Alt+Up to see the conflict heads-up. Run `npm run test:e2e:chrome` after building.

### Added — calendar-context poll cadence + on-demand refresh (`opencues` 0.2.47 → 0.2.48, `@opencues/windows` 0.1.5 → 0.1.6)

Tunes the ICS poller for real-world calendar caching (Google serves its ICS ~hourly, so the old 15-min cadence was wasteful) and adds a way to force freshness:

- **Configurable cadence** — `calendar-poll-minutes` in OPENCUES.md (default **30**, clamped 5–1440). Read live from the file (no rebuild).
- **`opencues calendar refresh`** — forces a fresh, **cache-busting** poll now (appends a rotating `?v=` so Google/etc. skip their server cache). Decoupled + host-agnostic: the CLI writes `~/.cues/.calendar-refresh`; the daemon's cheap 20-s stat-check picks it up and re-polls. Verified live end-to-end.
- **No restart for add/remove** — the poller re-reads `calendar-feeds.txt` every poll, so `opencues calendar add/remove` takes effect on the next cadence (or immediately via `refresh`). (First-ever feed while a host is already running still needs one restart to start the poller.)
- The forced pull only cache-busts on `refresh`; the normal cadence uses plain URLs (respects caching, avoids throttling).

### Added — `opencues calendar` CLI: manage calendar-context feeds (`opencues` 0.2.46 → 0.2.47)

A first-class CLI for the calendar feeds instead of hand-editing `~/.cues/calendar-feeds.txt`:

- **`opencues calendar add <url>`** — validates BEFORE writing: fetches the URL and confirms it's a real iCalendar feed (rejects HTTP errors AND 200s that aren't iCal — no `VCALENDAR` block), then reports "N events, M in the next 60 days, next: …". Rejects non-URLs, guards duplicates, accepts `webcal://`. `--no-verify` skips the network check. Warns if `calendar-context-mode` is off.
- **`opencues calendar list`** — feeds with live per-feed status rings + event counts (`--json` for scripting, `--no-fetch` to skip the network).
- **`opencues calendar remove <url|N>`** — remove by URL or 1-based index.
- Registered in the CLI dispatch + `opencues help`; 8 hermetic tests (temp-HOME, no network). Follows the house style (status `●` rings, aligned output). Includes the exact Luma steps (Account → Account Syncing → Calendar Syncing → Copy URL).

### Added — calendar-context `.ics`/webcal producer: real calendars via feed URL (Phase 1b) (`@opencues/core` 0.26.0 → 0.27.0)

The first REAL calendar-context producer — point it at an iCalendar feed URL and your upcoming events flow into both the `_` blank (`am i free…`) and the calendar-conflict cue, self-refreshing. One `.ics` parser covers **Luma, Google, Outlook/M365, Apple iCloud, Fastmail, Meetup, and any feed** — the near-universal calendar export — so almost any calendar is a drop-in, no per-provider OAuth for public/secret-URL feeds.

- **New `@opencues/core/ics.ts` — `parseIcs(text, {window})`** (pure, no network). Handles VEVENT SUMMARY/DTSTART/DTEND/DURATION/LOCATION/RRULE, line unfolding + TEXT unescaping, times in UTC (`…Z`, what Luma emits) / named zone (`TZID`, via `Intl`) / floating / all-day (`VALUE=DATE`, exclusive DTEND collapsed), and DAILY/WEEKLY recurrence expansion (INTERVAL/COUNT/UNTIL/BYDAY) bounded to the window (other FREQs → master instance). Normalises everything to local wall-clock `YYYY-MM-DDTHH:MM` — the shape `buildCalendarContextSnapshot` + the minute-of-day math already use. 12 unit tests incl. a Luma-shaped feed; live-verified against Google's public UK-holidays ICS (95 KB / 244 VEVENTs parsed).
- **Windows daemon poller** — reads feed URLs from `<CUES_HOME>/calendar-feeds.txt` (one per line, `#` comments, `webcal://` auto-converted), fetches every 15 min + on boot (15 s timeout per feed), parses, dedupes across feeds, and refills the snapshot in place. A total fetch failure **never wipes** the last-good calendar; the blank + cue pick up refreshes live (no restart). Precedence: **live feeds > manual `calendar.json` > Phase-1a fixture**. Live-verified end-to-end in the daemon.
- **The seam held** — zero consumer changes. The producer just writes the same snapshot shape; fluid-blank + the conflict cue + dehydration all worked unchanged. Template: `defaults/calendar-feeds.txt` (with Luma / Google / Outlook how-to-subscribe notes).
- **Follow-ups:** the poller lives in the Windows daemon today (parser is shared in core, so porting to other host bands is a copy of the fetch+timer); `seed-configs` distribution of the feeds template; MONTHLY/YEARLY RRULE + EXDATE.

### Added — calendar-context CUE path: calendar-conflict heads-up while you type (Phase 2) (`@opencues/core` 0.25.0 → 0.26.0)

The proactive half of calendar-context (`docs/architecture/calendar-context.md` Phase 2): type prose that claims you're free when your calendar says otherwise, and a **cue** flags it — `I'm free at 3pm today` → *"— heads up: Dentist is 3:00pm–3:45pm"*. The clashing event's title is hydrated locally from its `[EVENT N]` token (never sent to the LLM). It's a heads-up appended to your sentence, not a rewrite; cycle away to dismiss.

- **Built on the sentence-cue machinery** — a shipped `scope: sentence` cue (`defaults/cues/calendar/CUE.md`) with a new `uses-calendar-context: true` frontmatter flag. When set, `SentenceCueSource` appends the ingested calendar (events + minute-interval times as `[EVENT N]` tokens + a live now-anchor) to each per-sentence call and hydrates the tokens in the emitted alternative. Routes through the **cues bucket** (capable model — the reasoning-class job per the plan's model split).
- **Host-agnostic, auto-off where it can't render.** Because it's a sentence-cue (`isCycleable`), the no-cycling filter prunes it on hosts without a cycling/annotation surface — verified: the Windows daemon builds `[config-intent, fluid-blank, transform-blank]` with the calendar cue absent, while the `_` blank path keeps working. It renders on chrome (highlight) and the CLI hosts (statusline). No resolver changes — the resolver already registers any `sentence-cue:*` result passively.
- **Self-inert** when `calendar-context-mode` is off (no catalog forwarded → the cue cedes, no wasted LLM calls). New `renderCalendarContextForCue` (data + now-anchor, no availability-answer rules — the CUE.md prompt owns the task). Bench `tests/benchmarks/fluid-blank-ambient/calendar-context-cue-test.ts`: **24/24** on groq gpt-oss-120b (4 conflict → flagged with the right event, 4 no-conflict → ceded).
- **Known limitation:** currently requires BOTH `sentence-cues-mode: on` (the gate that builds any sentence-cue) AND `calendar-context-mode: on`. Decoupling the calendar cue from `sentence-cues-mode` is a follow-up.

### Added — `calendar-context`: ingested calendar as reasoning context for fluid-blank (Phase 1a) (`@opencues/core` 0.24.0 → 0.25.0, `@opencues/runtime` 0.20.0 → 0.21.0, `@opencues/windows` 0.1.4 → 0.1.5)

The first slice of calendar-context (see `docs/architecture/calendar-context.md`): the system holds a **bounded, periodically-ingested** snapshot of the user's calendar and lets fluid-blank **reason** over it — `am i free thursday _` → an answer computed from the event times. Ingest-on-a-timer, never invoke-per-keystroke; the worst case is a bad suggestion, never an action. Phase 1a proves the `ingest → catalog → reason → hydrate` path with a **fixture** calendar (zero network); Phase 1b swaps in a real calendar-feed (`.ics`) fetch. (No MCP — the ingest is plain iCalendar feeds.)

- **New `@opencues/core/calendar-context.ts`** — the FOURTH context catalog, but a different SHAPE from the first three. identity/blank/system-context are *substitution* catalogs (the LLM emits a token, the runtime swaps a value it never reasons over). Calendar-context is a *reasoning* catalog: event **times reach the LLM in the clear** (a busy interval is not PII and is the reasoning substrate), and only event **titles are dehydrated** to `[EVENT N]` tokens hydrated locally via the shared `postProcessContext` path. `buildCalendarContextSnapshot` + `renderCalendarContextCatalog`.
- **Availability as arithmetic, not clock reading.** Each event renders as a NUMERIC interval — **minutes-since-midnight** (`mins 900–945`) plus a 12h gloss — with an explicit containment algorithm in the prompt (convert the query time to minutes, then `start ≤ M ≤ end`). This turned the fragile 12h/24h clock step that the fast model kept getting wrong into pure arithmetic: **gemma-4-31b went 18/21 → 21/21** on the correctness bench (capable groq gpt-oss-120b holds 21/21), and the earlier live wrong answer (`am i free at 3pm` → "free" while a 3:00–3:45pm meeting was on) is now correct. This may remove the need for the capable-model route entirely.
- **Live CURRENT-MOMENT anchor.** The renderer takes a `nowIso` (computed fresh EVERY resolve by the fluid-blank caller, `localWallClockIso(new Date())`) and renders an authoritative "it is now `<weekday> <date> <time>` (minutes `<M>`)" line, so `today`/`tomorrow`/weekday names resolve against the **real now** — not the snapshot's `ingestedAt`. Fixes the post-midnight bug where a snapshot pulled yesterday made yesterday's events read as "today".
- **Availability is date-scoped; recall is a separate rule.** An earlier "an event before today has PASSED — drop it" instruction was **removed**: it was redundant (availability already excludes other-day events by date-matching — a 07-17 event simply isn't 07-18) and it was actively *suppressing recall* — `when was the last meeting _` deterministically returned "nothing scheduled" because the prominent "passed → drop" rule out-weighed the recall carve-out. The prompt now states availability as date-scoped and makes RECALL (`when was X` / `what did I have`) an explicit, separate rule that names past events. Validated: bench availability holds **24/24** (incl. a past-day case), recall improved, controls 9/9; live on the daemon, `am i free at 3pm today` correctly returns Free for a yesterday event AND `what was my last meeting` / `what did i have yesterday` correctly recall it. (The one phrasing still failing — `when was the *supabase* meeting` — is the separate safe-mode title-match limitation, not this: the LLM can't see `[EVENT 1]` is "supabase"; see the deferred local-pre-match note in `docs/architecture/calendar-context.md` § Known limitations.)
- **`calendar-context-mode: off | on`** scalar (feature-registry + config-loader). **OFF by default** — unlike system-context it carries real calendar PII, so it's opt-in.
- **Wired into `FluidBlankSource`** alongside the other catalogs (prompt block + titles added to the outbound dehydration catalog + the substitution merge). Resolver forwards a `calendarContext` snapshot (a mutable option the host's poller updates in place — the ingest-on-a-timer model) only when the scalar is on.
- **Windows daemon ingesters**: (1) a **snapshot-file** seam — if `<CUES_HOME>/calendar.json` (or `OPENCUES_LIFE_CONTEXT_FILE`) exists, its events are loaded (this is where the calendar-feed poller writes; it's also how a manual one-shot Google-Calendar pull was wired for live testing); (2) failing that, a Phase-1a **fixture** (relative-to-today calendar). Both are resolver-gated on `calendar-context-mode` (off by default) — a user who never opts in never sees anything. `OPENCUES_LIFE_CONTEXT_NO_FIXTURE` forces an empty snapshot to exercise the inert path.
- **Model-split evidence**: `tests/benchmarks/fluid-blank-ambient/calendar-context-correctness-test.ts` — on the capable model (groq gpt-oss-120b, the intended cues-bucket route) availability reasoning is 21/21, controls-clean 9/9, hydration 5/5; the fast fills model (cerebras gemma-4-31b) scores 18/21 with a genuine interval-reasoning miss — concrete justification for routing the reasoning to the cues bucket, deferred to the next slice.

### Fixed — `rewriteSetting` silently dropped new scalars on CRLF (Windows) OPENCUES.md files (`@opencues/runtime` 0.18.6 → 0.18.8)

When a setting line didn't already exist, `rewriteSetting` appended it inside the YAML frontmatter — but its frontmatter match was `\n`-only, so a Windows-authored (`\r\n`) OPENCUES.md failed the match and the **whole append silently bailed**: the blank reported success, the file was never changed. Surfaced while debugging the inline `loading animation … _` blank (which appends `blank-loading-frames`, a key absent from older files) on WSL. Now CRLF-tolerant — the frontmatter match accepts `\r?\n` and the file's own EOL is captured and reused so styles never mix. The `replace` path (existing line) was already CRLF-safe. Pinned by four `rewriteSetting` EOL tests. (Separately: the loading-animation blank appearing "dead" on opencode was a **stale install** — the fork's bundle predated #299/#293 and lacked the `loading-animation`/`model` factories; `opencues install opencode` fixes it, and the runtime already prints that exact remedy in its `[err]` fill.)
### Fixed — custom loading frames no longer linger on opencode (issue #306 root cause) (`@opencues/runtime` 0.18.6 → 0.18.7)

The `SourceReclassifier`'s runtime-write window (`RUNTIME_WRITE_TTL_MS`) was 250ms. The loading animator writes a frame every ~75ms, and on opencode the SolidJS `onContentChange` echo can lag under load; when a frame's echo arrived >250ms after its `markRuntimeWrite`, the mark was already pruned, so a legitimate runtime write got classified `user` → the resolver re-triggered → a custom frame char (`▖`/`▘`/… — custom frames need not include `_`) lingered in the slot a beat past resolution (intermittent, opencode-only, cosmetic; CC immune via its synchronous ZWS echo). Deterministically repro'd with the reclassifier's injectable clock (echo @300ms → `user`), then fixed at the root by raising the TTL to 1500ms so a delayed echo still matches. **Matching stays exact-full-buffer-text** — only how long a legit runtime write is remembered changed, so no leniency is introduced; the reclassify direction is `user→runtime` (resolver skips), and exploiting the wider window would require reproducing the exact buffer a runtime write just made (no new trigger surface; distinct from chrome's credit-based trust-gate). Supersedes the `_`-rest-frame mitigation floated in #305/#306 — with attribution correct, no cosmetic mask is needed. Pinned by `boot-common.test.ts` § "echo delayed under load". (kata's separate 250ms self-write TTL is deliberately left short — its danger runs the other way.)

### Removed — dead `fluid-blank-mode` scalar, end to end + spec bump `0.7-alpha → 0.8-alpha` (`@opencues/core` 0.20.3 → 0.21.0, `@opencues/runtime` 0.18.5 → 0.18.6, `opencues` CLI 0.2.45 → 0.2.46, `SPEC_VERSION` 0.7 → 0.8)

The scalar has been a no-op since the static-resolution design made fluid the always-on base layer (`enableFluidBlank: true` hardcoded; runtime SPEC.md already said "don't look for it") — but it still shipped in `defaults/OPENCUES.md`, appeared in the settings menu and the fluid-config classifier's choice space via the `FEATURES` registry, sat in the resolver's rebuild cache key, and was documented as a live gate across ~15 docs. Removed everywhere: registry entry (menu + classifier + doctor wiring), resolver cache-key read, shipped defaults, `spec/schemas/opencues.schema.json`, the conformance fixture, three fluid-config bench cases that expected the classifier to emit it, and the docs. Test fixtures that used it as a representative scalar now use `word-cues-mode`. Old user files carrying the key keep working (unknown frontmatter is preserved by design). **Spec side:** removing a documented `OPENCUES.md` key bumps `SPEC_VERSION` per the versioning policy; see `spec/CHANGELOG.md` `[Unreleased]`.

Also sweeps staleness the removal audit surfaced: runtime `SPEC.md`'s contradictory "FILL vs WIPE" section rewritten to always-FILL (it described the retired WIPE path and a `spanStart`/`spanEnd` emission fluid no longer does); `identity-validator.ts` header no longer calls the shipped sentinel blank a "future call site"; `cli-reference.md` documents `doctor --strict`; the chrome styling matrix moves LinkedIn from ProseMirror to Quill, matching the whole-text replacement tables.
### Added — **Undo / Redo**: language-invariant `undo _` / `redo _` reverts anything OpenCues did (`@opencues/core` 0.19.2 → 0.20.3, `@opencues/runtime` 0.17.0 → 0.18.5, `@opencues/claude-code` 0.2.9 → 0.2.10)

Typing `undo _` reverts the last change the runtime made — a blank fill, a fluid/transform substitution, an agent-rewrite round, a cycling step, a settings write, a volume/brightness set, an IDENTITY.md/NOTES.md write; `redo _` re-applies it; `undo 3 _` (or "undo the last two changes", "3回元に戻して") reverts deeper. ON by default via the new `undo-mode` registry scalar.

Routing is a fourth verdict kind (**ACTION**) on the config-intent classifier — deliberately not a keyword blank, so the trigger is language-invariant (`元に戻して _`, `deshacer _`, `отменить _` all classify; the likely-intent gate gained a multilingual alias list, and `hasLikelyIntent` now substring-matches non-ASCII tokens — JS `\b` never matches CJK, which silently gated those languages out). The prompt stays byte-stable (cerebras prefix caching); `fluid-config-mode` and `undo-mode` gate their verdict kinds post-classification. Certified on the new production-prompt bench runner (`tests/benchmarks/fluid-config/prod.ts`): settings precision/recall unchanged vs a same-session baseline; undo suite 100% precision / 93.3% recall (EXPERIMENTS.md § v2.2).

Runtime side: a session-scoped **UndoJournal** records every mutation as a typed transaction (buffer diffs via a new `diffSplice` helper — no span-shift plumbing; scalar writes with prior values; OS sets captured get-before-set; sentinel/note writes as validated inverse blank-ops exposed through `createBlankInvoke`'s `ProcessResult.writeInverse` — zero bootstrap changes, the inverse replays through `validateSentinelWrite`/`validateNoteWrite` by construction). Cycling bursts coalesce (volume ×6 → one undo). Buffer resets bump an epoch instead of wiping — settings/OS changes from a previous message stay undoable while stale text entries skip with a report. The **UndoApplier** is exact-match-or-refuse throughout: unique-match relocation for text, verify-then-set for scalars and OS values, partial failure reported (statusline `undo` block + `undo.applied` event), never guessed. External effects of user-pack blanks (fetch/exec) are declared irreversible and reported as such — documented as out of scope in `docs/architecture/undo.md` § "What's NOT in scope". One buffer write per apply (one host history entry). Wired on all six adapter bands. Runtime-only feature — no `SPEC_VERSION` bump, no reserved blank name.

Also extracted `invokeOrSpawnBlank` + `applyScalarAndPersist` into shared utils (cycling's and the resolver's previously private copies — the applier runs the exact same dispatch/persist pairs instead of drifting twins).

**Universal undo/redo confirmation + clean revert** (`@opencues/runtime` 0.18.4 → 0.18.5, `@opencues/claude-code` 0.2.9 → 0.2.10). undo/redo had no feedback surface for *invisible* reverts — flip `voice-mode`, `undo _`, and nothing on screen changes even though it worked. Now every apply produces a one-line status-line confirmation (`↶ undid: fluid-blank fill` / `↷ redid: volume step` / `↶ undid: settings change (1 skipped)` / `↶ nothing to undo (stale-epoch)`) via `formatUndoReport`, exposed pre-formatted on the statusline payload as `undoConfirmation` so every host renders the same string (the status line is the one feedback channel that exists everywhere — a keychord like Ctrl+Z isn't available on terminals / chrome inputs / mobile). The `UndoApplyReport` gained `appliedLabels` (what was reverted). **Wired on all five hosts** — CC (`highlight-statusline.sh`), OpenCode + Gemini + Shell (the `statusSnapshotHook`/`onTipChange` combine, dominant for its TTL), and Chrome (`runtime-statusbar.ts`) — each renders the same `undoConfirmation` string (`@opencues/claude-code` 0.2.9 → 0.2.10, `@opencues/opencode` 0.2.7 → 0.2.8, `@opencues/gemini-cli` 0.2.7 → 0.2.8, `@opencues/shell` 0.2.6 → 0.2.7, `@opencues/chrome` 0.2.67 → 0.2.68). Separately, the reverted buffer no longer keeps a dangling trailing space the command-span wipe could leave (`… undo _` → the separator before the command is trimmed; newlines preserved).

**A trailing bare `undo`/`redo` preempts a blank claim** (`@opencues/core` 0.20.2 → 0.20.3, `@opencues/runtime` 0.18.3 → 0.18.4). BlankSource outranks ConfigIntent (95 > 94), so a buffer that both matches a blank shape AND ends in a bare undo/redo went to the blank — live-caught: after undoing a fill to `capital of france`, typing `undo _` gave `capital of france undo _`, which matched the `countries` shape with arg "france undo" → "france undo: not found", eating the undo. undo/redo is a universal runtime command and must not be swallowable as a blank argument, so both claim sites now cede on a trailing bare undo/redo (only when undo is wired): `BlankFill.scan` returns no slot, and `ConfigIntentSource.supports` skips the blank-claim cede so its deterministic ACTION gate fires. Mid-buffer "undo" (`volume undo now _`) is unaffected — only the trailing command token counts.

**Undoing a fill no longer re-arms the trigger `_`** (`@opencues/runtime` 0.18.1 → 0.18.3). Reverting a `_`-triggered fill used to restore the buffer verbatim — including the trigger `_`, a live trigger that re-fires the fill on the next keystroke (the re-fire loop; live-caught 2026-07-15). A new `fillSplice` records the undo direction WITHOUT the trailing trigger: it strips the command's `_` (and separating whitespace), so `capital of france _` → undo → `capital of france` (no `_`). This holds whether the fill spliced only the `_` (fluid-blank) OR rephrased the whole line (the `countries` blank's `capital of france _` → `France capital: Paris`, keyword/`note`/`sentinel` blanks whose `… _` commands would otherwise re-fire and re-write on the next keystroke). The redo anchor is a whole-buffer form or, for a pure insertion, the preceding WORD only (not its trailing whitespace — the command-span wipe eats that, so a trailing-space anchor wouldn't relocate at redo time), so redo still re-applies the value. Self-guards to plain `diffSplice` for any non-trigger-ending change (word-cue swaps, transform-blank rewrites unaffected).

**Undo/redo is now a deterministic command, not an LLM classification** (`@opencues/core` 0.20.1 → 0.20.2). A bare `undo`/`redo` (+ optional integer count) immediately before the trigger `_` is matched by string in a pre-gate that runs before any classifier call — the Ctrl+Z path. This is what makes it both instant (no ~500ms round-trip) and impossible to cede: the earlier LLM route read `capital of france _ redo _` as the factual-lookup NONE example that leads it and dropped the redo, letting FluidBlank fill the stale `_`. The gate keys off the LAST `_`, so it wipes only `redo _` and preserves the leading query; `redo <object>` (a task) has a non-alias trailing token and correctly falls through. The LLM classifier stays as the fallback for CJK stems, number-words, and verbose phrasings (`undo the last two changes`, `take that back`) that don't string-match cleanly. Covers the common Latin-script aliases (`undo/redo/revert/deshacer/annuler/rückgängig/…`).

Three live-CC regressions found in first-run testing, fixed pre-merge (`@opencues/core` 0.20.0 → 0.20.1, `@opencues/runtime` 0.18.0 → 0.18.1): **(1) slow first `undo _`** — the resolver awaits all sibling sources, so the fast ACTION verdict (config-intent, priority 94) sat blocked ~1.5s behind an in-flight TransformBlank (93) / FluidBlank (92) LLM call racing on the same `_`. The core resolver's whole-buffer sibling-abort now also trips on an ACTION verdict (`metadata.undoAction`), cancelling the strictly-lower-priority siblings the moment the verdict lands — even when the span is non-zero (`Paris undo _`). **(2) undetermined cursor after undo/redo** — the applied buffer committed with a cursor pinned to the command-span start; it now lands at the END of the restored content (`cursorHint` threaded out of each `buffer-splice` inversion through `UndoApplier.apply`). **(3) redo evaluated the leftover blank AND the command** — a defense-in-depth ACTION-exclusivity gate in the runtime resolver suppresses any non-ACTION sibling result on a pass where an ACTION verdict is present (belt to the core abort's braces, for the case where a sibling's call already completed before the ACTION landed).

### Fixed — fluid-config no longer hijacks rewrite imperatives (`congratz make more professional _` flipped a setting); bench re-pointed at the production prompt (`@opencues/core` 0.19.1 → 0.19.2)

Live bug (July 2026): `congratz make more professional _` raced two sources — TransformBlank correctly produced "Congratulations", but the fluid-config classifier (priority 94 > 93) ALSO claimed the `_`, misread the rewrite imperative as a settings command, substituted `sentence-cues-mode on` into the buffer, and wrote the scalar. Probing showed a systematic precision hole: 5/10 rewrite-imperative phrasings false-positived to `sentence-cues-mode on` on the shipped gpt-oss-120b (the `more-formal` sentence-cue makes formality words the semantic trap).

Two fixes. (1) **Prompt**: new INTENT-C rule — a rewrite imperative changes THE TEXT ONCE (→ NONE, TransformBlank's territory); a setting changes BEHAVIOUR from now on; ongoing markers ("as I write", "while I type") applied to sentence improvement ARE feature requests → sentence-cues-mode. Plus paired negative/positive few-shots. (2) **Bench**: `fused.ts` carried its own stale copy of the v2.1 settings-only prompt while production had grown the three-intent classifier — every published number validated a prompt that no longer shipped. The bench now imports the production `SYSTEM_PROMPT` + `parseConfigIntentOutput` directly (PROVIDER verdicts mapped for the judge), so prompt edits are benched by construction — the same drift-class fix transform-blank's `prod.ts` made.

Validation (production prompt, cerebras + groq, main + holdout): **precision 100% on all four runs** including the new `reject-transform` bucket (5 cases per suite, incl. the exact live utterance in holdout); recall 86-89% main / 81% holdout (targets ≥98/≥80); ad-hoc probe 20/20 NONE across gpt-oss-120b AND gemma-4-31b (the live model). Sentence-cues boundary intact (`enable sentence cues _` and the ongoing-phrasing holdout case still route). `ro-keybind` reclassified as a `nav-keymap` hit — it predated that feature and only passed as a reject against the stale bench prompt. Full log: `tests/benchmarks/fluid-config/EXPERIMENTS.md` § Experiment 6.

### Added — `loading animation` blank: define the loading animation inline (`@opencues/runtime` 0.16.3 → 0.17.0)

New shipped deterministic blank (`defaults/blanks/loading-animation/BLANK.md` + built-in `LoadingAnimationBlank`, all five hosts via BUILTIN_BLANKS): `loading animation _,-,‾,- red,orange,yellow 75 _` parses frames / colours / interval / preset inline and upserts the existing `blank-loading-*` scalars in OPENCUES.md — the 1-N-step, 1-N-colour definition no longer requires hand-editing three file lines behind the menu's opaque `custom` value. One colour list feeds BOTH parallel scalars (ANSI names + everyday names orange/purple/pink/teal/lime/gold/violet via `EXTENDED_COLOR_NAMES` + 0-255 indices + #hex; names map to hex for rgb hosts, everyday names to 256-indices for terminals). Token order is free (classification by shape); commas are load-bearing — frames often start with `_`, and the CSV grammar plus the deliberate absence of a bare shape means typing the first frame's underscore never fires the blank early. Every floor is named, never silent (frame truncation at 5, interval clamp 30-2000ms, unused trailing colours, one-sided colour lists falling back to a default palette); errors are `[err]` feedback that fill only the `_`. `show` summarises the live config. Writes reuse the settings blank's `rewriteSetting` (now exported — one upsert implementation, no copy) in a single file write; the animator reads scalars through live thunks, so the next `_` plays the new animation. Tests: parser grammar matrix + write-path pins (exact scalar CSVs, one write, error-writes-nothing, round-trip through the animator's own parsers) + shipped-BLANK.md routing journeys incl. the no-early-fire and leading-phrase-gate hazards. No registry or SPEC_VERSION change.

### Fixed — the `inherit` menu entry on `*-llm-provider` scalars now names what it resolves to (`@opencues/core` 0.19.0 → 0.19.1, `@opencues/runtime` 0.16.2 → 0.16.3)

Setting a provider bucket in the CLI (`opencues config` → LLM routing) offered `inherit` with a static description that never said WHAT you'd be inheriting. The three `*-llm-provider` FEATURES now carry a `valuesProvider` (`withInheritResolution`) that decorates the `inherit` entry with the live resolution: `(currently cerebras)` when the global `llm-provider` is set, `(unset — auto-routes from your available API keys)` when it isn't, and `(llm-provider is "typo" — unknown provider, calls disabled)` when the global is misspelled — a typo'd global becomes visible at the menu instead of being discovered at dispatch. Only the description is live; the `inherit` id and write behaviour are unchanged, and non-inherit entries pass through untouched. The model scalars' `default` entry already named its resolution (`Use cerebras's default model (gpt-oss-120b)`); its no-provider fallback text now says the auto-route is in play instead of the generic "the provider's default model".

Plumbing: config-loader's `FEATURES_WITH_VALUES_PROVIDER` (the post-`applyOpenCuesScalar` overlay list) is now DERIVED from the registry (`FEATURES.filter(f => f.valuesProvider)`) instead of a hardcoded trio — the hardcoded copy went stale the moment a `valuesProvider` appeared outside the `*-llm-model` family, which is exactly the drift class the registry exists to kill. Tests: live-resolution pins per bucket scalar (set / unset / typo'd global), decoration-transparency pin (ids, order, non-inherit descriptions, `exposeInMenu` byte-identical), and the reset-to-default test rescoped to model scalars. Menu-text + registry plumbing only — no scalar semantics change, no `SPEC_VERSION` bump.

### Fixed — OC + gemini installers copied `node-http-adapter.js` one layer too deep; every LLM dispatch on those hosts was silently dead (`@opencues/opencode` 0.2.6 → 0.2.7, `@opencues/gemini-cli` 0.2.6 → 0.2.7)

Found by the full agentic-suite validation pass (2026-07-14): 27 scenarios failed with `*.started` events never firing — the resolver's fallback `require('@opencues/core/node-http-adapter')` (a package-ROOT specifier; core has no exports map) could not resolve because both setup.sh files copied the hand-written CJS into `$core_dest/dist/`. History: the copy USED to land at the root because the old installer flattened `dist/*` into the package root; the un-flattening fix (dist/ subdir layout, DEP0128) kept the explicit copy pointed at dist/ — reintroducing REPAIR.md LF-7 through the back door with no probe to catch it. Sources still built, so nothing logged until first dispatch, and every prior host check this week happened to exercise only deterministic blanks. Shell's installer was already correct (root); CC flattens, so it was immune.

Fix: copy to the package ROOT (+ dist/ belt-and-braces) in both installers, plus a FATAL post-copy resolve probe (`bun`/`node -e "require('@opencues/core/node-http-adapter')"` from the fork root) so a wrong-layer copy fails the install instead of shipping dead dispatch. REPAIR.md § LF-7 updated with the recurrence.

### Fixed — the registry-miss `[err]` fill was dropped on hosts whose text state lags the dispatch (`@opencues/runtime` 0.16.1 → 0.16.2)

Live-CC follow-up to the previous entry, caught during slot-2 validation: the warn fired but the `[err]` never appeared. The miss branch was the ONLY fill running synchronously inside the text-change dispatch, and CC's `adapter.getText()` is one keystroke stale at that instant — `words[slot.index]` missed and `applyAsyncFill`'s staleness guard silently dropped the fill. Every other fill path is naturally deferred past the state update by script/LLM latency, and the MockAdapter commits text BEFORE dispatch, which hid the class from the unit journeys.

Fix: defer the `[err]` fill one tick with one guarded retry (`tryErrFill` probes for the slot's `_`/frame char before filling; a buffer that legitimately moved on drops the retry via the same staleness guard as any late script callback). Harness gap closed structurally: `MockAdapter` gains `staleTextDuringDispatch` (dispatch first with the pre-change buffer in place, commit after — the live-CC shape), and a new journey pins the fill landing on such a host; mutation-checked to fail against the synchronous code.

### Fixed — a blank with config but no host implementation now says so instead of doing nothing (`@opencues/runtime` 0.16.0 → 0.16.1)

`~/.cues` is shared across hosts but runtime bundles are per-host, and ANY host's install seeds the shared config — so a BLANK.md can legitimately run ahead of another host's installed bundle. When that happened on a blankInvoke-capable host with a runtime-served (scriptless) blank, the dispatch hit the registry miss and skipped in TOTAL silence: no log, no fill, slot dead. Live case (July 2026): the loading-animation blank's config seeded by an opencode install while the CC fork was still one runtime behind — "it didn't seem to do anything". The same silent shape covers factories that skip registration over a missing prerequisite (e.g. stocks without a Finnhub key).

Now: a named `[err] <blank>: not available on this host — stale bundle or missing prerequisite. Try \`opencues install <host>\`` fill (the `[err]` path replaces only the `_`, so the typed command survives), plus a once-per-blank warn in the log with the fuller diagnostic. Loading-animation claim released correctly (no forever-spin). Pinned by three journeys in `blank-fill.test.ts`: named fill + command survival, once-per-blank warn dedup across re-fires, and animator release.

### Fixed — launch-time self-heal no longer rebuilds forks BACKWARD from a stale clone (`opencues` CLI 0.2.45 → 0.2.46)

The `opencues run <host>` srcHash self-heal treated ANY marker/source mismatch as "stale" — but srcHash is direction-blind. A second clone, a git worktree, or an old branch checked out in the same clone would silently rebuild every fork it launched back to its own older source; and because installers copy without deleting, the result was a MIXED bundle (new files present, `blanks/index.js` + package.json stale) — the dual-clone variant of the May 2026 drift class. Hit live July 2026: `opencues run` from a wip-branch checkout (runtime 0.13.5) clobbered a fork freshly installed from master (0.16.0) minutes earlier.

Fix: `checkDrift` now emits a `downgrade` signal (`markerIsNewer` — either bundled package version strictly newer than the invoking clone's source, semver-compared via compat's `semverCompare`; conservative on missing fields so pre-marker-era installs keep the old behaviour). `ensureFreshBundle` refuses the automatic rebuild on downgrade, launches the installed bundle as-is, and prints the versions + the installing clone's repoRoot + the escape hatch — explicit `opencues install <host>` still rebuilds from anywhere, so deliberate downgrades (bisecting) remain one command. Tests: downgrade/upgrade direction pins + a `markerIsNewer` matrix in `version-markers.test.cjs`; the `check-install-self-heal.sh` contract is unchanged and green.

### Added — `opencues models`: effective LLM routing + provider catalog on the CLI (`opencues` CLI 0.2.43 → 0.2.44)

New read-only command completing the model-visibility trio (shared walk → `model` blank → CLI). Section 1 renders the per-bucket effective route from `resolveEffectiveRouting` — the same shared walk dispatch, doctor, and the `model` blank use — with source tags (`← llm-provider` / `← auto (env key)` / `← auto (subscription CLI)`) and yellow-flagged degraded states (`key missing`, `refused — trains on input`). Section 2 is the provider/model catalog: current provider first with the active model starred, `knownModels` per provider, key state per row (`current` / `key set` / `no key` / `subscription CLI` / `no key needed`). `--json` emits the routing + catalog for scripting. Registered in the dispatcher, help grid, launcher menu, and shell completion. Tests in `models.test.cjs` (hermetic HOME, seeded CLI-probe cache, JSON contract, unbuilt-core guidance path).

### Added — `model` blank: "whats my model _" / "list models _" answered from dispatch truth (`@opencues/runtime` 0.15.2 → 0.16.0, `@opencues/chrome` 0.2.65 → 0.2.66)

New shipped default blank `model` (`defaults/blanks/model/BLANK.md` + built-in `ModelBlank`, registered via `BUILTIN_BLANKS` so every host picks it up — needs the host's `opencuesMdIO`, which all five hosts already supply). Answers come from `@opencues/core`'s `resolveEffectiveRouting` — the SAME precedence walk dispatch runs — so the blank can never report a provider/model that differs from what a real LLM call would use. Three modes picked by trigger: **current** (`whats my model _` → `cerebras · gpt-oss-120b`, with per-bucket breakdown + source attribution as cycling alts), **bucket-scoped** (`model for cues _`), and **catalog** (`list models _` → one line per provider, current first, active model starred, key state tagged). Degraded states are named, never silent (`key missing`, `unknown provider — calls disabled`, `no LLM configured — …`). Scalars re-read from OPENCUES.md per invocation, so settings changes reflect on the next `_`.

Routing is **shape-gated** ("model" is a common English word): authored `blankShapes` claim only question-shaped commands — prose like `the model returned garbage _` never routes here — and every shape captures its full question so the answer replaces it instead of trailing it. A shape match also beats the dictionary blank's `what is` keyword window on `what is my model _` (two-tier routing working as specced). Chrome passes a LIVE key-bag thunk (kept current by `updateRuntimeApiKeys`) via the new optional `BuiltinBlankContext.getLlmApiKeys`; native hosts default to the boot bag (`buildBootApiKeys`).

Tests: `model.test.ts` (mode selection, bucket filter, alt composition, named degraded states, hot-reload re-read) + a routing journey block in `blank-fill.test.ts` that loads the **shipped BLANK.md file itself** (shape edits that break routing fail the suite — drift-pinned) including the dictionary-conflict pins. Switching stays on the existing paths (fluid-config NL, satellite cycling, `opencues config`).

### Added/Fixed — one shared effective-LLM-routing walk for dispatch AND display; three dispatch/display alignment bugs closed (`@opencues/core` 0.18.1 → 0.19.0, `@opencues/runtime` 0.15.1 → 0.15.2, `opencues` CLI 0.2.42 → 0.2.43)

Groundwork for the model-visibility feature set ("what's my model?" in fluid text, `opencues models`). New `@opencues/core` module **`effective-routing.ts`**: `collapseBucketTier` (the bucket→global pairing rules) + `resolveEffectiveRouting` (per-bucket effective `{provider, model, sources, keyPresent}`), built on **`resolveLLMTuple`** — the pure (provider, model) half extracted from `resolveLLM`, so every display surface runs the EXACT tier walk dispatch runs and "what's my model?" can never drift from dispatch truth.

Auditing the old hand-mirrored copies surfaced three real alignment bugs, all fixed by switching the copies onto the shared walk:

1. **Bucket model silently inert when the bucket provider was `inherit`.** The config menu offers `<bucket>-llm-model` cycling against the inherited provider's `knownModels` and writes the scalar — but all three dispatch sites (`build-sources.resolveFor`, `buildAgentLLMResolver`, `buildKataLLMResolver`) dropped the bucket model unless the bucket ALSO pinned a provider, while doctor displayed it as live. The user's menu pick did nothing. `collapseBucketTier` now honors a bucket model over the global model on an inherited provider (a bucket scalar is more specific than a global one); the pinned-bucket rule is unchanged (a pinned bucket never inherits the global `llm-model`).
2. **Doctor displayed the global `llm-model` inside buckets pinned to another provider** — dispatch unpairs it (the stale-model-leak rule), so doctor showed a model the runtime would never send. Doctor's LLM-routing section now calls `resolveEffectiveRouting` instead of reimplementing the precedence in CJS, and gains three findings the old code couldn't see: unknown bucket-provider id (runtime treats as `inherit` — now a warn instead of silent), configured provider with a missing key (`key missing` marker + warn), and a prose bucket routed to a `trainsOnInput` provider (dispatch refuses; doctor now says so).
3. **The auditors path shipped model sentinels raw**: cycling `auditors-llm-model` to `default` sent the literal string `"default"` as the model name from `buildAgentLLMResolver` / `buildKataLLMResolver` (build-sources normalized; boot-common didn't). Both resolvers now collapse through core's shared walk; the runtime resolver's `normalizeModelScalar` also accepts `inherit` as a sentinel, matching core's canonical definition.

Tests: `effective-routing.test.ts` (ladder matrix over every rung — bucket/global/auto-key/auto-subscription/none, sentinels, legacy `blank-llm-*` fallback, trainsOnInput flags, unknown ids — plus a **dispatch-equivalence grid** asserting the display walk's (provider, model) equals `resolveLLM`'s for every fixture); bucket-collapse pins at the dispatch level in `build-sources.providers.test.ts` (Cases A/B + sentinel); `boot-common.agent-llm.test.ts` pins the auditors twins. Runtime-only routing knobs — no `SPEC_VERSION` change.

### Fixed — dictionary blank defined the trigger word "what" instead of the query word (`@opencues/runtime` 0.15.0 → 0.15.1, issue #282)

`what is BST time now _` returned a definition of **"what"** rather than a content word from the query. Root cause was config/impl drift: `blankKeywords` had been extended with the phrases `what does` / `what is`, but `dictionary.ts`'s hardcoded `TRIGGER_WORDS` exclusion set never got `what` / `does`, so "what" survived filtering and won the longest-word tiebreak (tying "time" at 4 letters). The first three trigger phrases (`define` / `definition of` / `meaning of`) were excluded correctly, which is why only "what is" / "what does" misbehaved.

Structural fix in `pickWord`: the candidate pool is now the `context` words only, and **every word of the matched trigger PHRASE** (`keyword`, which `blank-fill.ts:matchKeyword` always sets to the exact declared `blankKeyword` — never the query word) is excluded. This is drift-proof — extending `blankKeywords` with a new phrase can never again require a matching edit to the exclusion list, because whatever phrase routed here has its own words stripped. The static `TRIGGER_WORDS` set stays as belt-and-braces for trigger words that leak into `context`. Two regression tests in `dictionary.test.ts` pin issue #282 (the "what"/"time" tiebreak and the drift-proof phrase-strip); the pre-existing tests were corrected to model the real dispatch contract (`keyword`=trigger phrase, `context`=query words) instead of conflating the query word into `keyword`.

### Added — `location` blank gains a `map` keyword: a rich "location card" from OSM `extratags` (`@opencues/runtime` 0.14.0 → 0.15.0)

The `location` blank now has a second output mode selected by the trigger keyword. `location` / `address` keep the terse one-line address; the new **`map`** keyword returns a "Google Maps style" card assembled from OpenStreetMap's `extratags`: POI name, address, opening hours, phone, website, plus a Google Maps link built from the coordinates (`british museum map _` →  name / address / `Hours: …` / `phone · website` / `Map: https://www.google.com/maps/search/?api=1&query=<lat>,<lon>`). Same fetch and same 24h cache back both modes (the raw Nominatim hit is now cached, not the formatted string, so `map` then `location` on the same query is one request). OSM has no ratings / reviews / photos (Google-proprietary) — the card is everything the free OSM data gives, formatted for a text buffer, and the Maps link is the one-click bridge to the rest. Card lines with no OSM data are omitted; the `Map:` link is always present (falls back to the query string when OSM returns no coordinates).

Wiring: the fetch URL gains `extratags=1&namedetails=1&addressdetails=1`; `map` is added to `blankKeywords` and the three `blankShapes` alternations (`(?:location|address|map)`) so both `map british museum _` and `british museum map _` route in rich mode. Runtime-only formatting + config change — no `SPEC_VERSION` bump. New unit tests for `formatCard` (card assembly, missing-extratags fallback, coord-vs-query Map link, phone/website field precedence) and keyword routing (`map` → card, `location` → terse, shared cache) in `location.test.ts`.

### Added — `location` blank: place / address / POI lookup via OSM Nominatim, incl. trailing-keyword shape grammar (`@opencues/runtime` 0.13.3 → 0.14.0, `@opencues/core` 0.18.0 → 0.18.1)

New shipped default blank `location` (`defaults/blanks/location/BLANK.md` + built-in `LocationBlank` in `@opencues/runtime`, registered via `BUILTIN_BLANKS` so every host picks it up). Free-form place / address / POI search against OpenStreetMap's Nominatim — no API key, no signup; the first hit's `display_name` fills the `_` (`east finchley iceland location _` → `Iceland, High Road, Finchley, …, N2 8AQ, United Kingdom`). 24h per-query cache (Nominatim usage policy), identifying User-Agent on native hosts, misses/failures return `[err] …` feedback so the typed query survives for correction. Read-only (no cycling) so it also runs on no-cycling hosts.

The headline phrasing — query BEFORE the trigger word — needed the shape machinery to honour **trailing-keyword shapes**, which fixed two positional assumptions in `BlankFill`:

1. **Dispatch args**: a shaped `get` now dispatches the shape's `valueGroup` capture as the context words instead of re-deriving them positionally from keyword→`_` (which is empty when the arg precedes the keyword). For keyword-leading shapes the two are identical, so synthesized-grammar blanks are unaffected — with one deliberate exception: a repeated-keyword input (`weather weather _`) is now consistently read as get-with-arg per the shape verdict; previously dispatch (bare get) and clearing (captured arg) disagreed about it.
2. **Command-span clearing**: `clearsCommandSpan` fills now clear from the start of the shape's MATCHED SEGMENT (`BlankSlot.commandStart`, derived from the shared `segmentStart` boundary) instead of `keywordStart` — so `hii world. east finchley iceland location _` consumes only its own sentence and the captured arg isn't stranded next to an output that already embeds it.

Journey tests in `blank-fill.test.ts` (trailing-keyword describe block) + unit tests in `location.test.ts`. Spec wording clarified editorially (`spec/blank-spec.md` § Flag obligations + `blankClearKeywords` row; see `spec/CHANGELOG.md` `[Unreleased]`) — authored shapes were already arbitrary anchored regexes, so no `SPEC_VERSION` bump.
### Docs — document `opencues init`'s `AUDITORS.md` scaffold (`opencues` CLI 0.2.41 → 0.2.42)

Follows the CLI-bugfix PR that made `opencues init` scaffold `AUDITORS.md`. The scaffolded project `README.md` template now lists `AUDITORS.md` in its file table (it was creating the file without explaining it); `docs/guides/cli-reference.md`'s `init` section now names the four files it actually writes (`CUES.md`/`BLANKS.md`/`AUDITORS.md`/`README.md`) instead of the inaccurate "`cues/` and `blanks/` folder layout"; and `docs/guides/adding-an-auditor.md` §6 notes that `init` scaffolds a starter `AUDITORS.md`. Template-file (`src/templates/README.md`) change → patch bump.
### Fixed — outbound PII floor corrupted the prompt's own instruction examples, killing identity fills on real hosts (`@opencues/core` 0.18.0 → 0.18.1, `@opencues/runtime` 0.13.3 → 0.13.4, issues #279 + #280)

**Root cause (found via byte-diffing the live wire body against a passing repro):** in `identity-context-mode: safe`, the `dispatchChat` outbound-dehydration floor scrubbed catalog values from EVERY message — including the SYSTEM message, whose static instruction examples can legitimately contain text equal to a user's real catalog values. The catalog RULES' own rule-10 examples hardcoded `https://github.com/wkasekende` (a real handle) and the Ofcom dummy phone; for any user whose stored values matched, the floor rewrote the prompt's examples into self-contradictions (`buffer "wkasekende _" + label "GitHub URL" → "[GITHUB]" (NOT [GITHUB])`), and gpt-oss-120b answered `SPAN: NONE` to every identity lookup (`i work at _` → nothing). The floor's warning fired but went to `console.warn`, which the CC TUI swallows. Scenario 54 failed on every host while every bench passed — the benches never register the floor guard.

Fixes, each with a structural closure:

1. **The floor scans but never rewrites SYSTEM messages** (`llm-provider.ts:applyOutboundDehydrationFloor`). By the prefix-cache invariant, per-call user-derived content lives in the USER message; safe-mode system text carries token names only, so a system hit is either a static-prompt collision (this bug — includes common values like "United Kingdom") or a source violating the invariant (a real bug, now surfaced by a distinct loud warning instead of silently patched). Non-system channels (user, assistant, prediction) keep full scrub coverage — all user-content paths by design. Pinned by two new cases in `dispatch.test.ts`; `hydration-dehydration.md` § floor + `security-audit.md` row 22 updated.
2. **De-personalized the catalog rule-10 example values** (`identity-context.ts`) — the shipped prompt no longer contains a real person's handle (collision hygiene; the floor fix is what closes the class).
3. **LIVE FUNCTIONS block re-framed as additive** (`boot-common.ts:getRenderedBlock`, found en route via controlled A/B): when the typed-mode fn block IS present, its old "This OVERRIDES…" opener + missing catalog-guard examples suppressed catalog-token emission the same way (deterministic flip at temp=0/seed=42, sensitive even to fn-line order). Now opens "IN ADDITION to the catalog tokens above (all catalog rules still apply)" and its examples end with catalog-guard cases (`"i work at _" → [COMPANY]`). No-catalog safety verified (no token hallucination; unlisted-field tokens still stripped by the post-processor, scenario 56). fn-call emission unregressed at baseline (livefn-bench 9/10, same pre-existing dogecoin miss); bench mirror synced; unit pin in `boot-common.blank-fetch.test.ts`.

Live validation on CC 2.1.206: identity suite 53–58 green including the previously-failing 54 (fixed by 1+2), and **scenario 59 (issue #280) passes too** — fixed by 3: with `blank-context` typed mode the fn block IS present, and its catalog-suppression made the stocks-ambient fluid call bail to NONE, so `fluid-blank.completed` never fired.

### Changed — Claude Code pin bumped `2.1.170 → 2.1.206` (`@opencues/claude-code` 0.2.8 → 0.2.9)

Same-minor bump per `integrations/claude-code/UPGRADING.md`. Seam probe against the 2.1.206 native bun-binary's extracted cli.js: S1 KeyDispatcher / S2 InputStateHandler / S3 RenderedValue / S7 RenderKick all HIT with the existing regexes (no seam edits needed); S6 StatusLineRefresh remains MISS (gone since 2.1.150 — statusline falls back to `refreshInterval` polling as before). `compat.json` `current-pin` + `tested` updated; fallback pins in `patches/setup.sh` / `bin/install.cjs` and the doc references (root CLAUDE.md, docs/install.md, integration README, UPGRADING.md) moved in the same commit.

The 2.1.206 corruption this bump first surfaced (memory-prompt nested template `${l?`\``${y}`\``:y}` double-escaped at re-embed → `SyntaxError ... Expected ':' in ternary operator` on ANY launch, all seams green) is the same issue-#276 class fixed by the entry below — § 4e + the runtime smoke from that fix are what this bump validates against. `compat.json:tweakcc-pin` moves `76e1fea (v4.3.0) → 1545ff8` (upstream's "Prompts for 2.1.206" commit — the commit the 2.1.206 validation ran against; the module-graph repack regression PR #272 bisected on the 4.3.1-era commits is fixed by this point). Validation: patched binary boots + agentic suite 73/75 on CC 2.1.206 (the 2 failures are host-independent pre-existing issues #279/#280, reproduced identically on OpenCode). Post-mortem: `packages/opencues-runtime/adapters/cc/REPAIR.md` § 15.

### Fixed — CC install: pin tweakcc, disable its system-prompt pipeline, verify the patched artifact actually runs (`@opencues/claude-code` 0.2.7 → 0.2.8, issue #276)

Issue #276 (macOS arm64) reported both CC install shapes shipping broken from a "successful" install: the 2.1.170 native binary died at launch with Bun's "Expected CommonJS module to have a function wrapper" and a 2.1.110 cli.js died with a `SyntaxError` inside CC's own nested prompt template literals. Both reproduced byte-for-byte on Linux x64 — the platform was incidental. Root cause: `setup.sh` cloned tweakcc **unpinned** from upstream `main`, and a tweakcc-HEAD regression in its system-prompt pipeline (which runs OUTSIDE the `patchImplementations` map our section 4d disables) double-escaped backslashes across ~5000 prompt segments whenever the CC version's prompts don't hash-match tweakcc's bundled prompt DB. The corruption shipped because the post-patch `node --check` was a warning, nothing ever executed the patched artifact, and the "already installed + healthy" gate counted a missing install marker as fresh. Fixes, each with a structural closure: (1) tweakcc is now pinned to an exact commit (`compat.json:tweakcc-pin`, currently v4.3.0 `76e1fea`) with checkout + HEAD verification, and setup.sh refuses to run unpinned; (2) setup.sh § 4e disables the system-prompt pipeline (we ship zero prompt customizations); (3) the post-patch `node --check` is fatal on the cli.js shape, and a new § 9 runtime smoke executes the patched artifact (`--version`, both shapes) on the installing machine — platform-specific repack corruption now aborts the install loudly instead of reporting "Done." (native extracts are deliberately NOT `node --check`ed: CC's embedded JS uses Bun-only `using` syntax that fails Node's parser on a pristine extract); (4) `install.cjs:validateFork` mirrors both probes and `checkSrcHashDrift` treats a missing marker as stale, so a corrupted or never-completed install can no longer skip as "already installed + healthy"; (5) new `scripts/check-tweakcc-pin.sh` gate (pre-pr + CI `tweakcc-pin-gate` job) pins all of the above in place. Verified end-to-end on isolated forks: 2.1.110 cli.js and 2.1.170 native both install clean at the pin and run; the pre-fix corruption reproduces at tweakcc HEAD. Docs: UPGRADING.md gains "Bumping the tweakcc pin" + "Platform support status" (Linux x64 is the only maintainer-validated platform); drift-bug table row added to CLAUDE.md.

**tweakcc is now version-pinned.** `setup.sh` used to clone Piebald-AI/tweakcc at whatever main HEAD was that day — the patch engine + per-CC-version prompt-regex catalogue floated independently of the CC pin. New `compat.json:tweakcc-pin` field (today `1545ff8`, upstream's "Prompts for 2.1.206" commit) is checked out after clone; a missing commit fails the install loudly. The two pins move together on every CC bump — UPGRADING.md step 3 + both CLAUDE.mds updated with the discipline.
### Fixed — five `opencues` CLI command bugs surfaced by the phase-3 coverage pass (`opencues` CLI 0.2.40 → 0.2.41)

Fixes the five real defects that #275's coverage sweep found and documented (as `todo`/`it.fails` pins) but did not fix. Each is now corrected with a passing regression test in the CI-run `node:test` suite; the three vitest `*.knownbug.test.mjs` pins are retired (their assertions ported into the sibling `.cjs` suites so CI actually exercises them).

1. **`cleanup.cjs`** — `HOST_MATCHERS['gemini-cli']` was the string `'node .*gemini-cli'`, but the matcher does a literal `includes()` on string patterns, so the regex metachars never matched a real process line — `cleanup --host gemini-cli` was a permanent no-op. Now a real `RegExp`.
2. **`context.cjs`** — `parseSingleCueMd(content, e.name, folderPath)` passed args in the wrong order for the `(content, folderPath, nameOverride?)` signature, so a `BLANK.md` with no explicit `name:` was keyed under its full path and dropped from `opencues context list`. Args corrected (also fixes folder-relative script resolution).
3. **`init.cjs`** — `opencues init` (no `--minimal`) threw an uncaught `ENOENT` reading a nonexistent `templates/AUDITORS.md`, half-scaffolding `.cues/`. Ships the missing `AUDITORS.md` template + a defensive empty-scaffold fallback so a future listed-but-missing template can't crash the command the same way.
4. **`uninstall.cjs`** — `uninstallPlugin`'s config de-registration referenced an undefined `pluginFile`; the `ReferenceError` was swallowed and misreported as "could not parse config.json" while the plugin entry was left registered. `pluginFile` is now defined (matching `install.cjs`'s `target`).
5. **`compat.cjs` `matchesRange`** — checked `.endsWith('.x')` before the `' - '` bounded-range branch, so a natural range like `"1.4.0 - 1.4.x"` was treated as one un-matchable glob. The bounded-range split now runs first.

### Removed — Linked Words: the never-implemented `CueResult.linked` field + spec bump `0.6-alpha → 0.7-alpha` (`@opencues/core` 0.17.0 → 0.18.0, `SPEC_VERSION` 0.6 → 0.7)

Linked Words was a vestigial feature: the `linked` array on `CueResult` / `WordDef` was meant to let an LLM prompt (`prompts/linked.txt`) flag co-cycling word pairs (boy/his → girl/her) so a runtime could cycle them in lockstep. The prompt never shipped into any source, `LocalCueSource` always set `linked: null`, the resolver merged the field but nothing populated it, and no runtime (`@opencues/runtime`, CC, OC, chrome) ever consumed it. Removed end-to-end: the `linked` field from `CueResult` + `WordDef` (`types.ts`), the merge block in `resolver.ts`, the seeds + propagation in `local-cue-source.ts`, and `prompts/linked.txt`. Docs (`docs/features/linked-words.md` deleted, feature catalogue + `overview.md` interface + porting guide + llm-providers comment) and the chrome `sample-config/tips.json` `linked` keys removed. **Spec side:** `linked` dropped from `cue-spec.md`'s cue data-shape table + runtime-contract bullet and the routing suite's "not covered" note; `SPEC_VERSION` bumped `0.6 → 0.7` per the versioning policy (the standard's documented field set changed). A reader that had implemented `linked` cycling against `0.6` MAY keep it as a non-standard extension. See `spec/CHANGELOG.md` `[0.7.0-alpha]`.

### Changed — unified user-facing product description across all surfaces (`opencues` CLI 0.2.39 → 0.2.40, `@opencues/chrome` 0.2.64 → 0.2.65, `@opencues/claude-code` 0.2.6 → 0.2.7, `@opencues/{opencode,gemini-cli,shell}` 0.2.5 → 0.2.6)

Every user-facing product description now reads: "OpenCues enables native AI integration anywhere you type. Model agnostic and fully open source. Inline agents and prompting." Replaced the old per-surface variants ("LLM-powered word alternatives for text editors" in the chrome manifest, "LLM cues and `_`-gated blanks for any editor." in the CLI help/launcher banners + chrome popup, the "ushers in a new standard" README hero line, and every `package.json` description across the CLI, park placeholder, and the five integrations — each keeps an "OpenCues for <host> —" prefix). Chrome `manifest.json` + `package.json` bumped in lockstep per the versioning policy; the npm parking placeholder (`packages/opencues-park`) description + README updated too (takes effect on its next republish).

### Security — Bun-subprocess user-blank path enforced secret-destination bindings on `ctx.llm()` (`@opencues/runtime` 0.13.2 → 0.13.3, INFOSEC NF1)

The subprocess-based user-blank loader (opencode / shell integration, added in #148 as the Bun-compatible sandbox path for `isolated-vm`) guarded `ctx.fetch()` against exfiltrating a `secret-hosts`-bound secret but never applied the equivalent `enforceSecretBindings` check to `ctx.llm()` — a blank could stuff a bound secret into an LLM prompt and it would reach the provider unchecked. The in-process loader (native hosts) already had this guard; the two capability-handler builders had drifted. **Both** the resolve-endpoint + `enforceSecretBindings` + prompt/system-coercion logic now lives in ONE shared helper, `user-blanks/secret-leak-guard.ts` (`buildLlmSecretGuard`), which `registry.ts` (in-process) and `subprocess-loader.ts` (Bun subprocess) both import — so the two loaders cannot drift on this guard a third time (NF1 itself WAS that drift). **Second-pass hardening:** the secret-scan is string-coercion based (``${system}\n${prompt}``), and the IPC boundary does no request-shape validation, so a non-string `prompt`/`system` (`ctx.llm({ prompt: { x: secret } })`) previously stringified to `[object Object]` in the scan while serializing the real value into the wire body downstream. The shared guard coerces `prompt`/`system` to strings ONCE and forwards the coerced values, so the scanned bytes are exactly the bytes that reach the wire; fail-closed on an unresolvable LLM endpoint (all bound secrets refused). Pinned by `subprocess-loader.nf1.test.ts`. Canonical security-posture doc (`docs/architecture/security-audit.md`) updated; the shared-helper extraction closes the drift class, so the earlier #6 open follow-up is retired.

### Security — `volume`/`brightness` blank scripts reject non-digit input before `awk` interpolation (INFOSEC NF2, defense-in-depth)

Hardened `defaults/blanks/{volume,brightness}/{volume,brightness}-blank.sh` with an independent digit-only guard before the value reaches an `awk` command-substitution interpolation — not currently reachable given upstream validation, but the scripts no longer rely entirely on every caller getting that right.

### Security — dependency bumps for 9 advisories surfaced by a fresh `pnpm audit` (INFOSEC NF3)

All transitive: `undici` (7 CVEs, via `jsdom`, test-environment-only — pinned `^7.28.0` in `pnpm-workspace.yaml` overrides — capped to 7.x because an uncapped `>=7.28.0` resolved to undici 8, whose internal layout breaks jsdom 29 deep `undici/lib/handler/*` requires at import time) and `@babel/core` (via `integrations/shell`s `@opentui/solid`, low severity, build-time-only — pinned `>=7.29.6`). Also removed the unused `@anthropic-ai/sdk` devDependency from `integrations/chrome` (zero imports repo-wide) — it existed only to pull in a vulnerable `form-data` transitively.

### Changed — `buildUserBlankRegistry` gains a `loadUserBlankImpl` test seam (`@opencues/runtime` 0.13.1 → 0.13.2)

The user-blank registry tests need `loadUserBlank` faked (a real isolated-vm isolate is unavailable in dev/CI). Two test files did this with `vi.mock('./node-loader')` — but runtime vitest runs `isolate: false` + `pool: 'forks'`, so a module-level mock in one file leaks into every sibling file sharing its fork. That leak crashed the real-loader `sentinel-shadow.test.ts` whenever it shared a fork with `registry.test.ts` (`wrapUserBlankAsBlank(undefined)` — the leaked reset mock returned `undefined`); CI's file distribution hit the bad ordering, local runs didn't. Fix: `buildUserBlankRegistry` accepts an optional `loadUserBlankImpl` (production never sets it — defaults to the real loader); both test files inject a plain `vi.fn()` through opts, which can't leak. Also consolidated the standalone `skip-user-blanks.test.ts` into `registry.test.ts` and dropped `sentinel-shadow.test.ts`'s `os.tmpdir` stub-writing (better hermeticity — no real FS). Test-only surface; zero production behaviour change.

### Added — `OPENCUES_SKIP_USER_BLANKS=1` skips the JS user-blank registry (agentic-harness RAM guard) (`@opencues/runtime` 0.13.0 → 0.13.1)

Loading a JS user-blank (`impl: ./blank.js`) spins up an isolated-vm sandbox / `user-blank-runner.cjs` subprocess (~54 MB resident) — and the shipped defaults include impl-blanks (`gh-issues`, …) that load at boot even when nothing invokes them. The agentic harness runs up to 16 host shards in parallel and needs none of them, so `tests/agentic/oc-launch-headless` already set this flag — but nothing on the runtime side honoured it (a dead flag). Now a single guard at the top of `buildUserBlankRegistry` (`packages/opencues-runtime/src/user-blanks/registry.ts`) returns an empty registry when the flag is `1`, before any config loads. One chokepoint → every host band + the chrome-host benefits, no per-bootstrap edits. **Measured A/B on a live OpenCode host: `user-blank-runner` present at 54 MB with the flag off, absent (0) with it on** — ~860 MB saved across a 16-shard pool. Built-in / runtime blanks (`note`, `weather`, `volume`, …) are TS classes in `BUILTIN_BLANKS`, not routed through this registry, so they're unaffected (verified: the `note` blank still fills with the flag on). Pinned by the `OPENCUES_SKIP_USER_BLANKS guard` block in `user-blanks/registry.test.ts`. Zero user impact — the flag is harness-only; real users never set it.

### Added — `note` collection blank PROTOTYPE: save / recall / delete reusable snippets (`@opencues/runtime` 0.10.0 → 0.11.0)

Issue #210 asked for a searchable history of `_` interactions so repetitive commands can be recalled and tweaked instead of reconstructed. This ships the explicit-curation v1: a keyword-bound `note` built-in over `~/.cues/NOTES.md` — `note add fix mp4: ffmpeg … _` saves an entry, `note ffmpeg _` recalls it (best match fills, other matches cycle, label stripped so commands land ready to tweak), `note delete <query> _` removes it (refuses on ambiguous matches), bare `note _` browses the 5 most recent. Sentinel-pattern throughout: injected `notesMdIO`, single `validateNoteWrite` chokepoint (256 entries × 1024 chars, control-char reject, duplicate idempotency), fully local deterministic search — notes never reach an LLM provider, `as-context: off`. Deliberately NOT `blankClearOnEdit`: editing inside a recalled fill must never wipe it. PROTOTYPE scope: no host passes `notesMdIO` yet (registry factory skips), no spec bump yet; both land with productization. UX journeys pinned in `note-blank.scenarios.test.ts` (real NoteBlank through real BlankFill/Cycling, no stubs).

### Added — note blank wired into every host (`@opencues/claude-code` 0.2.5, `@opencues/opencode` 0.2.3, `@opencues/gemini-cli` 0.2.3, `@opencues/shell` 0.2.3, `@opencues/chrome` 0.2.45)

All five host bootstraps now pass `notesMdIO` into `createDefaultBlanksRegistry`, mirroring the `identityMdIO` pattern (CC patch string, OC/gemini/shell bootstraps, chrome's `createBlanks`). Native hosts share `~/.cues/NOTES.md` directly. Chrome required three additional connections found by a new E2E round-trip scenario: `NOTES.md` marked writable in the bootstrap's `isReadOnlyPath` (reads were falling through to bake-time null while writes landed in storage — add confirmed but recall found nothing), the chrome-host `write-file` relay's `WRITABLE_BASENAMES` allowlist extended (data-only file, validateNoteWrite runs before the relay; same threat class as IDENTITY.md — security-audit row #15 doc follow-up noted), and `NOTES.md` added to `CORE_CONFIG_FILES` so chrome-host pushes disk edits into chrome.storage. With chrome-host installed, chrome writes go disk-first (file is the single source of truth, storage is a cache — the OPENCUES.md model); without it, chrome falls back to a self-consistent storage-only store. Chrome E2E gained a deterministic note scenario (add → chrome.storage persist → recall round-trip), 11/11.

### Fixed — shaped blanks could claim the WRONG `_` in multi-blank buffers (`@opencues/core` 0.13.6 → 0.13.7, `@opencues/runtime` same 0.11.0 bump)

Two related mis-claims found by the note prototype's dumb-user gauntlet, both pre-existing in shared shape routing:

- **Shape verdict attached to the first `_`, matcher anchored on the last.** `BlankFill.scan` attached a `matchBlankShape` hit to `words.indexOf('_')` while `lineWithBlank` anchors on `lastIndexOf` — so in `fill later _ ok. note add snack _` the note command's verdict landed on the earlier, unrelated `_` (which the user left for fluid-blank) and fired with a nonsense query. Now attaches to `lastIndexOf`, matching the shape grammar's own anchor.
- **Greedy `(.+?)` arg capture swallowed an earlier `_`.** In `affirm _ improve prompt _`, affirm's synthesized get-with-arg shape matched with the captured value `_ improve prompt` — claiming a `_` that was never an affirm invocation. `matchBlankShape` now cedes any match whose captured arg contains a standalone `_` (an arg region containing another blank slot is never a real invocation). Fixed at the shared chokepoint so all five claim/cede sites (BlankFill + BlankSource claim + the three semantic-`_` cedes) agree.

### Fixed — hand-written comments in NOTES.md were eaten on the next runtime write (`@opencues/runtime`, same 0.11.0 bump)

The first prototype re-serialised header+bullets on every write, silently dropping a hand-written comment sitting between two entries. Writes are now line surgery — append one bullet / remove one bullet — so user headers, comments, and spacing are byte-preserved. Recall-miss guidance also tailored: with notes saved, the nudge points at browsing/loosening the query instead of wrongly suggesting `note add`.

### Fixed — `[err]` blank results consumed the user's typed command (`@opencues/runtime`, same 0.11.0 bump)

Found live while UX-testing the note prototype: a recall miss (`note kubectl _` with no matching note) replaced the entire typed command with the error text — the user lost the very query they needed to adjust and had to retype everything. Structural fix in `applyAsyncFill`: results starting with `[err]` are FEEDBACK, not output — they now fill only the `_` and never trigger the shape-derived command-span clear, the integration/typed-action renders, or the keyword-clear. Benefits every erroring blank (a typo'd `set sentinel ../bad key _` now keeps the command for correction too). Pinned in the note scenario suite.
> **Rebased onto the buffer-dehydration release (2026-07-07).** The three key-onboarding entries immediately below were authored pre-rebase; their net effect on the merged tree is `@opencues/core` 0.15.0 → **0.16.0**, `@opencues/runtime` 0.11.3 → **0.12.0**, `@opencues/chrome` 0.2.62 → **0.2.63**, `opencues` CLI → **0.2.39**. package.json is authoritative where the per-entry version refs differ.

### Changed — `set-key` output uses the `●`-ring house style (`opencues` CLI 0.2.38 → 0.2.39)

The `--oauth` progress + the shared "stored" success line used `tag()` glyphs (`🗸` tick, `•` bullet, `⚠`) and a redundant trailing ring, against the CLI's own rule (leading coloured `●`, never a tick/dot/cross — see `packages/opencues-cli/CLAUDE.md`). Now every status line is a leading `●` at the 2-col gutter — dim `●` for in-progress steps, green `●` for the stored key, yellow `●` for the perms warning, red `●` for a failure — and the fallback auth URL indents under its text. Applies to the normal `set-key` path too (the "stored" line is shared).

### Fixed — `set-key openrouter --oauth` hung the CLI after success (`opencues` CLI 0.2.37 → 0.2.38)

The loopback callback served its "you can close this tab" page keep-alive, so `server.close()` only stopped accepting new connections and then waited for the browser's still-open socket to end on its own — that lingering socket kept the Node event loop alive, so the process never exited back to the shell after a successful auth (the key WAS stored; the terminal just never returned). Now the callback response sends `Connection: close` and the flow calls `server.closeAllConnections()` before `close()`, so the socket dies immediately and the CLI returns. Pinned by a keep-alive-agent regression test (`openrouter-oauth.test.cjs`, now 9 tests).

### Added — `opencues set-key openrouter --oauth`: one-click key via OAuth PKCE (`opencues` CLI 0.2.36 → 0.2.37)

The industry's closest thing to programmatic key issuance, wired into set-key: the CLI starts a loopback server on `127.0.0.1:<ephemeral>`, opens `openrouter.ai/auth` (S256 PKCE, fresh 32-byte verifier per run) in the browser (`xdg-open` / `open` / WSL `wslview`→PowerShell, with the URL printed as manual fallback), receives the `?code=` callback, exchanges it at `POST /api/v1/auth/keys`, and stores the returned key in `~/.cues/.env` (0600) exactly like a pasted one — which the hosts now read at boot, so the whole onboarding is: click Authorize, restart the host. Security posture: loopback-only bind, S256 only, the key travels solely in the HTTPS exchange response (never a URL, log line, or the callback page), single-shot server, 5-minute hard timeout. Every step is injectable and pinned by `openrouter-oauth.test.cjs` (8 tests incl. a full hermetic flow against the real loopback server with a fake browser). The zero-key install ending now names it as the one-click option.

### Added — zero-key subscription fallback: a keyless Claude Code install now works out of the box (`@opencues/core` 0.14.0 → 0.15.0, `@opencues/runtime` 0.11.0 → 0.12.0, `opencues` CLI 0.2.35 → 0.2.36, `@opencues/chrome` 0.2.45 → 0.2.46)

`pickAutoProvider` gains a last rung: when NO auto-order env key exists, fall back to `claude-code-cli` (then `openai-subscription`) iff the CLI binary is on PATH — a CC user by definition has an installed, authenticated `claude`, so their install now works with zero keys, zero config, zero signup (slower than the API tier, but slower beats silently inert). Runtime-only detection: nothing is written to config, the rung is unreachable once any key exists (adding a key upgrades the route automatically), and the probe self-disables in the browser (chrome unchanged). `resolveLLM` emits a one-time notice naming the route and `opencues set-key` as the faster path. All four native bands count the rung as a usable LLM (no false missing-key hint; AgentRewrite constructs), doctor downgrades its zero-key warning to an info naming the route, the install ending states it (`● LLM provider: claude-code-cli — via your subscription; opencues set-key adds a faster API provider`), and the old hand-written "zero-key option" suggestion lines are gone — the thing they suggested now just happens. opencode-zen's free pool stays out of the rung (`trainsOnInput` — keyless but consent-gated). Binary names come from the new registry map `SUBSCRIPTION_CLI_BINARIES` (doctor's private copy removed).

### Added — existing-key detection: `~/.cues/.env` read at boot, install-time key report, registry-driven key tables (`@opencues/core` 0.13.6 → 0.14.0, `@opencues/runtime` 0.10.0 → 0.11.0, `opencues` CLI 0.2.34 → 0.2.35, `@opencues/chrome` 0.2.44 → 0.2.45)

Onboarding seamlessness pass — a key the user already has now reaches the runtime without shell-rc surgery:

- **`~/.cues/.env` is now actually read at host boot.** `opencues set-key` has always written keys there, but native hosts only read `process.env` — the set-key output literally told users to go `export` the key themselves (and `docs/architecture/chrome-llm-keys.md` claimed the file was read at boot when nothing did). New `@opencues/core` module `env-keys.ts` (`buildBootApiKeys`) builds every adapter band's key bag with a fixed precedence: host-forwarded keys → `process.env` → `~/.cues/.env`. A shell export always wins over the file; `.env`-sourced values are never written back into `process.env` (they must not leak into spawned blank scripts' inheritable environment); the browser build no-ops behind a `typeof process` guard (chrome's keys arrive pre-merged via the storage push). When detection fills anything, the host logs one `LLM keys detected: <VAR> (shell env|~/.cues/.env)` line — names and sources, never values. Also fixes the OC/gemini bootstraps' enumeration gap (`OPENCODE_ZEN_API_KEY` / `OLLAMA_API_KEY` were never forwarded; the registry-driven fill covers every provider's env var without patch edits).
- **`opencues install` ends with a key-detection line.** One line naming the provider the runtime will actually use (`● LLM provider: cerebras`) — resolution only, no key names or sources: presence isn't validity (`opencues check-keys` is the live probe) and the `opencues` dashboard / `doctor` already carry the per-key detail. Explicit `llm-provider:` scalar wins, else the auto-route pick; a scalar pointing at a provider with no detected key gets a warn pointing at `check-keys`. Deliberately NOT a per-key inventory (`opencues doctor` owns that table — the install ending stays clean). With zero keys it points at `opencues set-key` and — when the `claude` / `codex` binary is on PATH — names the zero-key subscription option (`llm-provider: claude-code-cli` / `openai-subscription`). Suggested, never auto-applied: the CLI-daemon transport is markedly slower than the API providers, so switching silently would regress latency-sensitive word-cues. Previously the install finished saying nothing about keys and the "every LLM feature is inert" warning only surfaced if the user happened to run `doctor`.
- **`opencues doctor` / `set-key` are `.env`-aware.** Doctor's Environment section shows each key's source (`· via ~/.cues/.env`), its LLM-routing section resolves the auto-pick from the same bag the hosts boot with, and the no-key finding now leads with `opencues set-key`. `set-key`'s provider list derives from core's registry (was a hardcoded duplicate missing `ollama`) and its closing message drops the "export it yourself" instruction.
- **Provider→env-key/probe tables unified onto the registry.** New optional `keyProbe` field on `ProviderAdapter` (cheapest authenticated endpoint + headers builder, INFOSEC F8 headers-not-URLs) is now the single source for `opencues check-keys` and chrome's boot-time `verifyLlmKeyAtBoot`; chrome's hand-synced `PROVIDER_ENV_KEY` / `ENV_TO_PROVIDER` maps are registry-derived (the drift they had already accrued: `opencode-zen` and `ollama` were flagged "unknown provider" by the boot audit).

### Fixed — chrome's boot-time provider audit never matched a present key (`@opencues/chrome` 0.2.44 → 0.2.45)

`auditProvidersAgainstKeys` looked up `keys[envKeyName]` (`GEMINI_API_KEY`) but its only caller passes a provider-id-keyed map (`gemini`), so any `llm-provider:` / `<feature>-provider:` directive warned "needs KEY" even when the key was present and working. Lookup now uses the provider id, and keyless-capable providers (`opencode-zen` free pool, local `ollama`) are skipped instead of flagged.
### Changed — no ticks anywhere: `✓` → green `●` across scripts, benchmarks, install output + chrome popup (`opencues` CLI 0.2.35 → 0.2.36, `@opencues/chrome` 0.2.61 → 0.2.62, `@opencues/claude-code` 0.2.4 → 0.2.5, `@opencues/{opencode,gemini-cli,shell}` 0.2.3 → 0.2.4)

Follow-up to the CLI `tag()` fix — hunts down every remaining `✓`/`🗸` tick outside the CLI command surface and converts it to a green `●`, so the whole repo speaks one status vocabulary (`packages/opencues-cli/CLAUDE.md` § "The `●` ring is the universal status glyph"). Covered: the `scripts/*.{sh,cjs}` lint/check/pre-pr gates, `integrations/*/patches/setup.sh` + `bin/install.cjs` install output, `packages/opencues-core/scripts/*` bench runners, the `tests/benchmarks/**` runners, and the **chrome popup diagnostics** (glyph + the `startsWith('✓')` classifier → `startsWith('●')`, green via the existing `.diag-ok` CSS). Node output uses a `\x1b[32m●\x1b[0m` escape; shell output embeds the ANSI directly (`echo -e` is banned by the portability rule, and `\033` isn't interpreted by bare `echo`). Also removed the now-dead `G.check` (`🗸`) glyph from `style.cjs` (unused since `tag()` moved to `●`). `✗`/`⚠` are left as-is — the ask was ticks. Comment/doc references de-ANSI'd to a plain `●`.

### Changed — status output uses the `●`-ring house style everywhere (no ticks) (`opencues` CLI 0.2.34 → 0.2.35, `@opencues/runtime` 0.11.3 → 0.11.4)

The CLI's own rule is "status is a leading coloured `●` — never a tick / cross / dot / ⚠" (`packages/opencues-cli/CLAUDE.md`), but `tag()` still rendered `🗸` / `⚠` / `✗` / `•` against it, across ~128 call sites in 18 command files. Redefined `tag()`'s UTF-8 glyphs to leading `●` rings (green ok / dim info / yellow warn / red err) — one change, every command now consistent, and alignment improves because the old `🗸` / `⚠` are 2-cell-wide emoji while `●` is single-cell. `TAGS_ASCII` (`[ok]` / `[warn]`) is unchanged for no-UTF8 terminals. Also converted the stray literal ticks: `cleanup`'s two `green('✓')`, `which`'s stale help text ("shows ✓ if present" → green `●`), and the **kata coach** line + lesson journal (`✓ Now:` → `● Now:`; runtime statusline surface). No test pinned the glyphs (one kata journal assertion updated to `●`).

### Added — buffer dehydration: `identity-context-mode: safe` is now bidirectional (`@opencues/core` 0.14.0 → 0.15.0, `@opencues/runtime` 0.11.2 → 0.11.3, `@opencues/chrome` 0.2.60 → 0.2.61, spec 0.5 → 0.6)

**Observability** (core 0.15.0 / runtime 0.11.3): the outbound scrub now emits a structured **`transform-blank.dehydrated` / `fluid-blank.dehydrated`** event (`{ count }`) via the existing source-event channel, making the PII scrub assertable end-to-end on a real host (the buffer stays hydrated by design, so a text assertion can't prove the outbound scrub). Validated live on OpenCode + real Groq; pinned by agentic scenario `67-identity-context-dehydration-event` (asserts the event fired — runtime contract, not LLM output, per the agentic-scenario rule).


Safe mode previously protected only the catalog direction — IDENTITY.md values never entered prompts, but personal data the user *typed into the buffer* shipped to the provider verbatim. Now every LLM-bound copy of buffer text is **dehydrated** first (catalog values → their `[TOKEN]`s) across all 9 outbound channels (fluid-blank INPUT + ambient block, transform-blank INPUT + Cerebras `prediction` param, sentence-cue SENTENCE, config-intent classifier + summon, word-cues — PII words are withheld from dispatch entirely, agent-rewrite DOCUMENT, blank-weave PRIOR TEXT), and responses are **hydrated** back locally via the existing post-processor (now formally named). A defense-in-depth floor at `dispatchChat` (plus AgentRewrite's HTTP-branch bypass) scrubs anything a future source misses, with a loud warning. Matching is case-insensitive, word-boundary (CJK-aware), longest-value-first; values too short/common to match safely are skipped with a visible once-per-compile warning, never silently. New core module `dehydrate.ts`; `introducedTokens`/`ambiguous` threading through `postProcessContext`/`resolveTypedSentinels` (both-present conflicts preserve the user's literal token and are reported). Canonical doc: `docs/architecture/hydration-dehydration.md`; normative contract: `spec/identity-context-spec.md` § Dehydration (spec 0.6.0-alpha).

### Fixed — satellite scalar cycling silently downgraded `identity-context-mode` to `off` (`@opencues/runtime`, same release)

`applyOpenCuesScalar`'s inline re-parse defaulted `identity-context-mode`/`blank-context-mode` to `off` while the main parse defaults an absent key to `safe` — cycling ANY satellite scalar (voice-mode, tips-mode, …) on a config without the explicit key downgraded the in-memory mode for the rest of the session. Pre-existing bug, now security-load-bearing (the outbound PII scrub rides `safe`); aligned to the two-tier semantics and pinned by a scenario test. Also: the resolver now forwards the identity catalog whenever the mode ≠ `off` (the old keyword-bound-slot skip would have withheld the catalog from word-cue/sentence-cue dispatches, leaving their outbound text unscrubbed).
### Added — `KATA.md` joins the open standard (spec `0.4` → `0.5`; `@opencues/core` 0.13.10 → 0.14.0, `@opencues/runtime` 0.11.1 → 0.11.2)

The kata guided-scenario surface graduated from a reference-impl-only feature to a standard file format. `SPEC_VERSION` bumps `0.4` → `0.5`. New: [`spec/kata-spec.md`](spec/kata-spec.md) (the `KATA.md` format — frontmatter `name`/`id`/`title`/`next` + `## ` step sections + the consent / deterministic-exit / display-only security floors), [`spec/schemas/kata.schema.json`](spec/schemas/kata.schema.json), and conformance fixtures under `spec/conformance/{valid,invalid}/kata/` exercised by `packages/opencues-runtime/src/modules/kata.test.ts`. Deliberately kept **out** of the standard: the coaching runtime (trace, coach tick, LLM prompt, escape ladder, rendering) stays reference-impl, and enablement (`katas-mode`) stays a runtime knob — the spec covers the durable file format only, mirroring `BLANK.md` (spec) vs the `CueSource` classes (not). Spec-only change: no shipping runtime behaviour moved (`kata.ts` unchanged; the runtime bump is the added conformance runner). Full checklist: `spec/CHANGELOG.md` [0.5.0-alpha].

### Fixed — config-intent classifier host-scopes its feature list (`@opencues/core` 0.13.8 → 0.13.9, `@opencues/chrome` → 0.2.58)

Follow-up to the `statusbar-position` FEATURE below: the settings *menu* was already chrome-scoped (`hostScope`), but the fluid-config **intent classifier** built its `FEATURE_REGISTRY_BLOCK` at module load from ALL FEATURES with no host filter — so a CLI host's classifier prompt listed chrome's `statusbar-position` even though it can't act on it. Now the classifier's feature block is built per-host (`buildFeatureBlock(hostName)`): host-scoped FEATURES appear only on a matching host; the exported default `SYSTEM_PROMPT` is the universal set (host-scoped excluded), so **non-chrome hosts' classifier prompts are byte-identical to before** (zero classification impact). `validateAgainstRegistry` gained a defense-in-depth host-scope guard, and `hostName` is threaded resolver (`adapter.hostName`) → `buildSourcesFromConfig` → `ConfigIntentSource`.

### Added — chrome-only `statusbar-position` setting + host-scoped FEATURES (`@opencues/core` 0.13.7 → 0.13.8, `@opencues/chrome` → 0.2.57)

The chrome in-page status bar (tips / cycling / kata coach) can now be placed via `opencues settings _` → cycle to `statusbar-position`: `bottom` (default, full-width band), `top` (full-width band at the top), or `right` (compact bottom-right panel). Because it's a real FEATURE (not a MENU_TUNABLE like `dim-mix`), the **fluid-config intent classifier can route to it** too — e.g. `move the status bar to the top _`. To keep a chrome-only setting off the CLI hosts' menus, `FeatureSpec` gained an optional `hostScope` (mirroring `MenuTunableSpec.hostScope`); `getMenuDefinitions` now filters FEATURES by host the same way it already did tunables, so `statusbar-position` appears only in chrome's `settings _` menu. Settings-map-only (read in the content script via `bootResult.getSetting('statusbar-position')`, like `dim-mix`) — no typed `OpenCuesState` field (added to `SETTINGS_MAP_ONLY`). The bar re-positions live on the next statusline update (no reload). Also: all chrome status-bar content now wraps to multiple lines instead of clipping with an ellipsis.

### Changed — comment-only doc-drift fix in build-sources.ts (`@opencues/core` 0.13.6 → 0.13.7)

Transform-blank option comment example updated to a current canonical phrasing; no behaviour change.

### Added — kata mode prototype: modal guided scenarios with a live LLM coach (`@opencues/runtime` 0.10.0 → 0.11.0)

**Experimental.** New `KataCoach` module (`packages/opencues-runtime/src/modules/kata.ts`): katas are authored as `~/.cues/katas/<name>/KATA.md` (frontmatter + `## Step` sections; per-step `coach:` prose rides into the system prompt verbatim, so fidelity lives in the file, not a schema). `start kata <id|name> _` activates a MODAL state that suppresses the entire Resolver (new `ResolverOptions.externallySuppressed` seam — word-cues, fluid/transform-blank, config-intent, sentence-cues all dark until `stop kata _`; nothing is written to OPENCUES.md so stop is trivially clean). A debounced (~300ms) coach call on the auditors bucket receives the full script (stable → provider prefix-cache) plus a bounded trace of typed activity — including submit detection via non-empty→empty buffer transitions — and returns `STEP/STATUS/COACH`; the runtime trusts the model with hardcoded floors only (bounds-clamped, never backward, ≤1 step per tick). Detection is seamless — the trace also carries salient KEY PRESSES (passive `onKey(null, …)` observation: tab/shift+tab, escape, arrows, enter-on-empty-buffer, modifier combos), so steps that happen outside the input box (mode toggles, pickers) complete without the user announcing anything; `done`/`next`/`skip _` remain as deterministic escape hatches but katas never require them. Coach output is DISPLAY-ONLY (statusline `kata` block + step counter; never the buffer, never a side-effect layer). `done`/`next`/`skip _` advance deterministically. Every transition emits structured events (`kata.started/tick/step-advanced/completed/stopped`) for the agentic harness. Idle nudges (default 30s, `kata-nudge-ms`): proactive, context-aware check-ins, escalating once with `skip _` then going quiet (2-per-stall cap, reset on activity), advisory-only (never advance, never stop); deterministic "Still there?" fallback with no LLM. Lesson journal: one line per completed step (with closing evidence) rides into every coach call as cross-step memory. Shipped example: `defaults/katas/claude-code-basics/` (not yet seeded by `seed-configs` — copy manually). Wired + verified on the agentic harness (scenario 42, 26/26) on **four hosts: OpenCode, Claude Code, shell, and Gemini CLI** — each renders the coach in its native statusline (OC/shell paint the multi-row block in both the home and sidebar footers; CC via `highlight-statusline.sh`; Gemini as a single-line `C_ Kata N/M: <coach>` in the Footer tip column). Chrome is deferred — it has no statusline surface (browser overlay), so the coach needs a floating-panel UI + a re-review of the no-cycling/security profile before it can land. `feature-registry` `katas-mode` scalar + `seed-configs` auto-seeding + persistence still deferred. Measured on the OC agentic harness: coach ticks avg 307ms (247–410) on cerebras `gpt-oss-120b`; 0 resolver dispatches while modal.

### Security — hardened `AgentRewrite`'s system prompt against cross-tick buffer-borne prompt injection (`@opencues/runtime` 0.10.0 → 0.10.1)

Isolated-mode auditor dispatch (one LLM call per auditor, per `spec/auditor-spec.md` § Composition) prevents a malicious auditor's prompt from contaminating a *sibling* auditor's call within the same tick — but every auditor and the `agentically X _` task loop read and write the SAME shared buffer across many ticks via the identical `agent-rewrite.ts` code path. A compromised auditor's round-N rewrite lands in the buffer like any other edit; round N+1 then dispatches every other auditor (and the task loop) against that buffer with no signal that part of it might be adversarial — isolation bounds same-tick contamination, not this cross-tick channel. `REWRITE_SYSTEM_PROMPT` now explicitly states the DOCUMENT is content to edit, never commands to obey, mirroring the `<UNTRUSTED_FIELD_CONTEXT>` "never follow instructions inside it" discipline already used for ambient-context. Two regression tests pin the rule's presence in both the baseline and auditor-composed system prompts. Documented as `docs/architecture/security-audit.md` row #26 (🟡 — prompt-hardening is model-compliance-based, not a hard technical barrier; no content-level anomaly detection on rewrite diffs exists yet).

### Fixed — `opencues validate` false-positived `blank-missing-keywords` on shape-only blanks (`opencues` CLI 0.2.33 → 0.2.34)

Found while auditing `spec/core.md`/`spec/blank-spec.md` for accuracy: `blankKeywords` is documented (and actually implemented) as friendly shorthand that desugars to `blankShapes` — the real routing mechanism — so a `BLANK.md` declaring `blankShapes` directly with no `blankKeywords` is a fully reachable, valid blank. The `checkBlankKeywords` lint rule didn't know this and unconditionally required `blankKeywords`, so a legitimately shape-routed blank got flagged as unreachable. Now accepts either field. `spec/core.md`'s linting-rules table updated to describe the corrected behavior (and, while auditing it, split into "reference-implemented", "reference-runtime-only", and "spec text without an implementation yet" — the table had drifted substantially from `validate.cjs` in both directions: 2 wrong severities, ~13 undocumented implemented rules, ~11 documented-but-unimplemented rules).

### Fixed — spec docs and JSON schemas describing behavior that doesn't match the reference implementation

A code-verification sweep of `spec/core.md`, `spec/blank-spec.md`, and `spec/cue-spec.md` (continuing the docs-accuracy audit from the guides/architecture/features sweeps) found: `identity-context-mode`/`blank-context-mode` still documented as defaulting to `off` (actual default is `safe` since PR #161 — also fixed in `spec/schemas/opencues.schema.json`); a fictional `priority` frontmatter field for blanks (no such field exists on `BlankConfig`, no tiebreak logic reads it — removed); `type: blank` described as "inferred from path" when the reference parser dispatches purely on it (now documented as required, and made required in `spec/schemas/blank.schema.json`, which also gained an explicit `blankKeywords` **or** `blankShapes` requirement to match the `checkBlankKeywords` fix above); a "named prompt sections" (`## Extract`/`## Answer`) feature that was a leftover from the retired 3-pass TransformBlank pipeline and was never implemented (removed); an incomplete "runtime extensions" list in `blank-spec.md` (missing the blank-as-context parameter-binding fields and the capability/quota fields); fictional CLI flags (`opencues validate --path`, `opencues list --type/--match-test`) replaced with the actual flag sets; and `cue.schema.json`/`blank.schema.json`/`auditor.schema.json` all missing the `sentence` scope value and the `shell`/`terminal` host names, plus `cue.schema.json` missing `provider`/`endpoint` properties entirely despite both being documented, wired frontmatter fields.

### Fixed — combined-mode CUE.md silently dropped its LLM half; bracketed `keywords:` lists lost their first/last entry (`@opencues/core` 0.13.5 → 0.13.6)

Found while auditing `spec/cue-spec.md` for accuracy against the reference implementation — both were real parsing bugs, not just doc drift.

- **Combined mode** (a single `CUE.md` pairing a static JSON tips block with `match:`/`keywords:` + prompt-body LLM text, per `spec/cue-spec.md`'s worked "legal" example) never actually built the LLM half. `parseSingleCueMd` `break`ed unconditionally as soon as the JSON block parsed, so `result.promptConfig` was never populated — only the static-block words (e.g. `herein`) ever got alternatives; everything meant to fall through to the model (`contract`, `agreement`, …) silently matched nothing. Now the parser only stops at the static block when frontmatter declares neither `match:` nor `keywords:` (a pure-static cue); when either is present it falls through and builds `promptConfig` too. `spec/conformance/valid/cue/combined.md` — already a fixture — now asserts both halves are present (previously the suite's `hasTips || hasPrompt` OR-assertion silently accepted the missing half).
- **`keywords: [a, b, c]`** (YAML bracket-list syntax, documented as valid in `spec/cue-spec.md`) stored the literal bracketed string rather than stripping brackets like `on-host:`/`on-site:` already do — so `RoutedWordSourceGroup`'s downstream `.split(',')` left the first keyword prefixed with `[` and the last suffixed with `]`, and neither could ever match. Comma-separated plain strings were unaffected. Added `normalizeKeywordsValue()` (reuses `parseHostList`'s bracket/JSON-array handling) applied at all three `keywords:` assignment sites (frontmatter, `### <name>` subsection YAML, legacy single-grammar body).

Regression tests added to `cues-md.test.ts` for both. `docs/architecture` and `spec/` docs updated in the same pass to describe the now-correct behavior.

### Fixed — `switch model to gemma` resolved to the wrong model in the config-intent classifier (`@opencues/core` 0.13.4 → 0.13.5)

`switch model to gemma _` was silently resolving to `cerebras:gpt-oss-120b` instead of `gemma-4-31b`. The classifier's few-shot examples had no anchor mapping the informal "gemma" alias to the private-preview model id, so it emitted `MODEL:` empty per the "unrecognised model" rule — the apply path then fell back to the provider's `defaultModel` (gpt-oss-120b for cerebras). The equivalent `haiku` phrasing only appeared to work because Anthropic's `defaultModel` happens to literally be the haiku model id, masking the same gap. Added a `SYSTEM_PROMPT` few-shot example anchoring `switch model to gemma` → `cerebras / gemma-4-31b`. Verified live via the agentic harness: resolves to gemma-4-31b (conf 0.92) and correctly writes `blanks-llm-model` to `OPENCUES.md`.

### Added — `gemma` selectable by name in the fluid-config classifier (parity with `haiku`) (`@opencues/core` 0.13.3 → 0.13.4)

`gemma-4-31b` was already in cerebras `knownModels` (so it resolves via the config menu and bucket-scoped phrasings like `use gemma for blanks _`), but `gemma` was missing from the fluid-config pre-filter's curated model-alias list — so bare-name phrasings (`use gemma _`, `switch to gemma _`) were silently skipped while `use haiku _` fired. Added `gemma` to the alias set for full parity. Verified live: `use gemma for blanks _` → cerebras/gemma-4-31b (0.92). **Not** the cerebras default (gpt-oss-120b stays default) — gemma is private preview. Regression test pins the gemma↔haiku parity; docs note in `docs/architecture/llm-routing.md`.

### Fixed — `opencues identity` now honours `$OPENCUES_HOME` (`opencues` CLI 0.2.32 → 0.2.33)

`opencues identity` hardcoded its target to `os.homedir()/.cues/IDENTITY.md`, silently ignoring `$OPENCUES_HOME` — so `OPENCUES_HOME=… opencues identity set …` wrote the real `~/.cues/IDENTITY.md` instead of the override. Now resolved per-call via `$OPENCUES_HOME || ~/.cues`, matching the search-path convention every other CLI command uses. Regression tests pin both the write target and `identity path`; the HOME-based E2E helper strips ambient `$OPENCUES_HOME` for hermeticity.

### Fixed — guard unguarded `process.env` in the rate-limit retry reader (`@opencues/core` 0.13.2 → 0.13.3)

`RATE_LIMIT_MAX_RETRIES` in `llm-provider.ts` read `process.env.OPENCUES_RATE_LIMIT_RETRIES` without a `typeof process` guard, which would throw in chrome content scripts (no `process`). Wrapped the access; `?? 4` semantics preserved so `OPENCUES_RATE_LIMIT_RETRIES=0` still means zero retries. Caught by the `runtime-browser-safe` lint (pre-existing on master).

### Added — no-arg `opencues` interactive launcher (`opencues` CLI 0.2.31 → 0.2.32)

Bare `opencues` on a terminal now opens an interactive menu that routes into each command's own flow — Settings, API keys, Identity, Debug logging, Explore cues & blanks, Install/Run a host, Diagnostics, Check API keys, All commands — with a Back-to-menu / Quit loop. Non-TTY / piped is unchanged: it still prints the static status + command list (`help`). Ties the control-panel commands together behind one entry point.

### Fixed — menu-tunable defaults (valueOrder[0]) now match the shipped defaults (`@opencues/core` 0.13.1 → 0.13.2)

Four `MENU_TUNABLES` listed a non-default value first, so `opencues config` (and the in-editor cycling menu's initial render) reported the wrong default — e.g. `agent-debounce-ms` showed `150` when the real default is `1000`. Reordered so the default is first, matching the shipped `defaults/OPENCUES.md` / consumer fallback: `agent-debounce-ms` → 1000, `blank-loading-interval-ms` → 150, `blank-context-prewarm-ms` → 35000, `dim-mix` → 45. A new drift test pins that every shipped MENU_TUNABLE's `valueOrder[0]` equals its `defaults/OPENCUES.md` value (FEATURES are excluded — their registry default is the conservative code fallback, which the seed config may deliberately opt past). Updated the `show` CLI-inspection regression test for the new formatted detail view.

### Changed — config sections come from the registry `group` field (`@opencues/core` 0.13.0 → 0.13.1, `opencues` CLI 0.2.29 → 0.2.30)

`opencues config`'s section grouping moved out of a hardcoded `SECTIONS` map in the CLI and into the registry: each `FeatureSpec`/`MenuTunableSpec` now declares its `group:` (colocated with the scalar), ordered by a new `SETTINGS_GROUP_ORDER` export. `getMenuDefinitions` surfaces `group`, and `config` derives its sections from it — so adding a feature auto-places it in a section with zero CLI edits, killing the last drift surface in the settings system. The coverage invariant moved to `feature-registry-menu.drift.test.ts` (every menu scalar has a group in `SETTINGS_GROUP_ORDER`); the CLI test now pins that `config` renders every scalar in exactly one section, in order.

### Changed — output formatting: check-keys ● grid + context house style (`opencues` CLI 0.2.23 → 0.2.24)

`opencues check-keys` now shows a status ring per provider (green ● works / red ● failed / gray ● unset) instead of tag glyphs. `opencues context` moved off its inline colour helpers onto the shared `style.cjs`: a banner, a per-source ring row (green ● active / yellow ● raw / gray ● off), aligned green token columns with descriptions, and file links. (`list` and `which` were already grouped/tree-formatted, left as-is.)

### Added — show explorer + identity interview on the toolkit (`opencues` CLI 0.2.17 → 0.2.19)

`opencues show` with no name is now an explorer: a `select` over every defined cue/blank (folder-based, deduped across search paths) → a **formatted** detail view (source + scope + every frontmatter field as an aligned tree, long values truncated, body shown dimmed, multi-match priority order) → Back to the list. The scriptable `show <name>` uses the same formatted renderer instead of dumping raw markdown. `opencues identity`'s interview moved off raw `node:readline` onto the house `input()` toolkit (no `?` prefix; the default pre-fills the field, clearing skips) — a new `input({ allowEmpty })` option makes "clear to skip" distinguishable from "accept the pre-fill". (`edit` was left as-is — it deliberately exposes only `cues`, so a picker adds nothing.)

### Added — import trust gate + install confirm migration (`opencues` CLI 0.2.16 → 0.2.17)

`opencues import` now shows what a downloaded pack contains (cue/blank counts, flagging script blanks that run code) and requires an explicit Yes/No before installing it — the security consent moment for third-party config. `--yes`/`-y` bypasses for scripting; non-TTY proceeds (validation already ran). Also fixed a latent bug where the download promise wasn't awaited. `opencues install`'s hand-rolled `[Y/n]` / `[Y/n/details]` dependency prompts now use the house `confirm()` / Yes-Details-No `select()` instead of a blocking `readSync` (the dead `promptSync` helper is removed).

### Added — interactive pickers for set-key / install / uninstall / run / new (`opencues` CLI 0.2.15 → 0.2.16)

Commands that error on a missing argument now open a picker on a terminal (flags still win; non-TTY still errors, so scripting is unchanged): `set-key` → provider `select` (green ● = key already set) + masked key entry; `install` / `uninstall` / `run` → host `select` via a shared `lib/pick-host.cjs` (install/uninstall include an `all` row); `new` → kind `select` (cue / blank) + name `input`.

### Added — `opencues config` interactive settings browser (`opencues` CLI 0.2.12 → 0.2.14)

A discoverable, customizable front-end for the ~29 OPENCUES.md scalars (every FEATURES + MENU_TUNABLES entry). The schema is the registry in `@opencues/core` — adding a feature there makes it appear here for free (a coverage test pins that every menu scalar is sectioned). Interactive browser groups settings into sections (Cues / Blanks / Context & identity / Agent / Voice & navigation / LLM routing / Appearance / Diagnostics), shows each setting's effective value (green when changed from the registry default), and opens a per-setting value picker (each value with its registry description; current value carries the ring + cursor). Scriptable paths: `config list`, `config get <scalar>`, `config set <scalar> <value>` (validated against the registry; footgun `exposeInMenu:false` values stay file-edit-only). New shared `lib/opencues-md.cjs` (frontmatter scalar read/write) + a `heading` primitive in the prompt toolkit (non-selectable bold section title). 8 new tests. The `ai-callable` trust manager (`lib/ai-callable.cjs`) is embedded as a discoverable section (`AI-callable blanks · N trusted`) since it's another OPENCUES.md setting (`ai-callable-allow:`) — it lives ONLY inside `config` (no standalone `opencues ai-callable` command, to keep the CLI surface small); hand-editing the `ai-callable-allow:` line still works. Menu polish: navigation clamps at the ends (no wrap-around), and each frame is wrapped in a DEC 2026 synchronized-output block to stop arrow-key flicker on WSL/remote terminals.

### Changed — renamed `param-safe` → `ai-callable` (`@opencues/core` 0.12.0 → 0.13.0, `@opencues/runtime` 0.9.0 → 0.10.0, `opencues` CLI 0.2.11 → 0.2.12)

User-facing rename of the typed-sentinel Phase 4 capability — a blank the AI may call with an argument it chooses. The old name described the *security property* (`param-safe`); the new name describes *what it does* (`ai-callable`). Renamed across every surface: the BLANK.md frontmatter key `param-safe:` → `ai-callable:`, the OPENCUES.md scalar `param-safe-allow:` → `ai-callable-allow:`, the CLI command `opencues param-safe` → `opencues ai-callable`, and all runtime identifiers (`paramSafe*` → `aiCallable*`, `AUDITED_PARAM_SAFE_CLASSES`, `collectParamSafeFetches`, etc.). **Not a spec change** — the key was never in `spec/`; `SPEC_VERSION` unchanged. **Fully back-compatible:** the runtime + CLI still read the legacy `param-safe:` frontmatter and `param-safe-allow:` scalar, `opencues param-safe` remains a hidden alias, and the CLI migrates a legacy `param-safe-allow:` line to the new name on its next write. Legacy names are now banned in shipping code by `lint-legacy-names.sh` (back-compat reads carry `LEGACY-NAME-ALLOW` markers).

### Added — interactive CLI toolkit + interactive `ai-callable` (`opencues` CLI 0.2.9 → 0.2.10)

New interactive prompt toolkit (`lib/prompt.cjs`, a thin wrapper over the small CJS `enquirer` library) as the input counterpart to `lib/style.cjs`: `select` (arrow-key pick), `confirm`, `input`, `secret`. Owns the chrome — no `?` prefix, a white selection arrow, dimmed+skipped disabled rows, separators. (A hand-rolled raw-`readline` version failed cross-terminal raw input on WSL; `enquirer` was chosen over `prompts` because it's themeable. Commands depend on the in-house wrapper API, not `enquirer` directly, so the lib can be swapped in one file.) The interactive `ai-callable` menu lays out name + status columns (`fixed` for audited core, `trusted`/`untrusted` for the rest). **TTY-aware** — interactive only when a human is on a real terminal; non-TTY / `--no-interactive` / `OPENCUES_NO_INTERACTIVE` fall back to flags, so scripting never breaks. `opencues ai-callable` with no subcommand now opens an in-place trust manager (toggle blanks, audited core shown but locked, `impl`/`network` surfaced + a confirm step on enable); every explicit subcommand stays one-shot. Writes the same `ai-callable-allow:` line — hand-editing still works. 5 toolkit tests (fake-TTY keypress drive).

### Added — typed-sentinel Phase 4: on-demand parameterized blank fetch (opt-in, capability-gated) (`@opencues/core` 0.11.0 → 0.12.0, `@opencues/runtime` 0.8.0 → 0.9.0)

The full parameterized tier for `sentinel-language: typed`. A blank that declares `ai-callable: true` + a `signature:` is rendered as a LIVE FUNCTION (`[STOCK(ticker: string): number]`); when the LLM emits `[STOCK(ticker=TSLA)]` the runtime calls `StocksBlank.get('TSLA')` on-demand — even for a ticker that wasn't pre-fetched as an as-context slot — and substitutes the live value. Extends to fluid-blank + transform-blank. Closes the gap where v1 (typed-scalar) could only resolve pre-fetched instances.

**Security model (capability gate, FOUR layers — see security-audit.md #23):**
- **Opt-in per blank** — `ai-callable: true` required; absent → instance-only, no LLM-arg call.
- **Script-blank ban at parse** — `cues-md.ts` hard-refuses `ai-callable` on any `blankScript` blank (both folder-BLANK.md + BLANKS.md-JSON paths) + warns: an LLM-controlled arg can never reach a shell.
- **Runtime chokepoint** — `buildBlankFetchProvider.blankFetch` re-enforces `ai-callable && !blankScript` on every call (never trusts the caller); the ai-callable registry is built only from opted-in blanks + gated on `blank-context-mode` on; the whole path is OFF unless `sentinel-language: typed`.
- **Runtime arg floor** (`aiCallableArgWithinFloor`, defense-in-depth) — before `get()` runs, an empty / over-200-char / control-char / URL-structure-char arg is refused. Each shipped ai-callable blank ALSO validates/encodes its own arg (stocks → `[A-Z0-9.]`, weather → `encodeURIComponent`, crypto → `[a-z0-9-]`); **AUTHOR CONTRACT**: ai-callable is open to any non-script `impl:` blank a user opts into, so authors MUST treat the arg as hostile. Documented residual: nested resolution (`[WEATHER(city=[WORK CITY])]`) can route an identity scalar to a third-party data API.

Implementation: `collectAiCallableFetches` (pure pre-pass) + async on-demand fetch in core; `buildBlankFetchProvider` (capability-gated, hot-reloading registry) + `aiCallableArgWithinFloor` + `CueContext.{aiCallableFns,aiCallableFnsBlock,blankFetch}` threaded via the resolver and wired into all native bands (cc/oc/gemini/shell). `defaults/blanks/{stocks,weather,crypto}` opt in (bounded-codomain fetch). Tests: frontmatter + security-guard + collector + arg-floor + on-demand integration. **OFF by default** (`sentinel-language: bare`); default users + non-ai-callable blanks are unaffected.

### Added — `ollama` provider: local models over Ollama's native `/api/chat` (`@opencues/core` 0.10.0 → 0.11.0, `@opencues/runtime` 0.7.0 → 0.8.0, `opencues` CLI 0.2.7 → 0.2.8)

New first-class LLM provider that runs models **fully on the user's machine** via a local Ollama server. No API key, no per-token cost, and inference never leaves the device — so it's the one provider OpenCues will route prose-bearing surfaces (word-cues, auditors, agent-rewrite) through with zero leak risk (`trainsOnInput` is implicitly false). Opt in with `llm-provider: ollama` (global) or `blanks-llm-provider: ollama` (the `_` surface only); default model `gemma4:e2b`.

Two deliberate departures from the OpenAI-compatible providers:

1. **Native `/api/chat`, not `/v1/chat/completions`.** Ollama's OpenAI-compatible `/v1` gives no way to disable a thinking model's reasoning channel (verified Ollama 0.30.11 — `think`, `reasoning_effort`, `chat_template_kwargs` all ignored on `/v1`). A thinking model (Gemma 4, Qwen3, …) then spends OpenCues' deliberately small `max_completion_tokens` budget reasoning and returns EMPTY `content` → every blank/cue silently dies. The provider talks to the native endpoint with `think: false`, which is why it's a bespoke provider and not a `llm-endpoint:` override of `openai`. `num_ctx` is set generously (16k) because Ollama otherwise defaults a model's context to a small VRAM-derived value (≈4k) that truncates FUSED_SYSTEM-class prompts.

2. **`optionalAuth`** — local Ollama needs no key (a key is still sent when `OLLAMA_API_KEY` is set, for authenticating reverse proxies). NOT in `PROVIDER_AUTO_ORDER` (a reachable local server must never silently hijack the auto-route from a configured cloud provider) and hidden from the cycling menu (`exposeInMenu: false`, so users never cycle onto a maybe-offline local server); set it by editing OPENCUES.md. No HTTP fallback peer — a local-private request never falls out to a cloud provider.

**Failure-mode robustness (Ollama not installed / model not pulled).** Since the provider has no cloud fallback by design, error messaging is the only safety net — two gaps fixed:
- **Silent failure when a model isn't pulled.** Ollama returns `model 'gemma4:e2b' not found`; the model name sits between "model" and "not found", so `classifyLlmError`'s adjacent `model not found` pattern missed it → `null` reason → no substitute → the user typed `_` and saw *nothing*. Added a `model[^.\n]{0,40}not found` alternative so it classifies as `model-not-found`.
- **Cloud-centric guidance.** `nativeHostFormatLLMError` now takes provider context (threaded from each source's `this.provider.id` / `this.model` / `this.endpoint` via the `formatErrorAsSubstitute` callback's new 3rd arg, updated across TransformBlank / FluidBlank / ConfigIntent). For `provider: ollama` it emits the actual fix — `model-not-found` → ``run `ollama pull <model>` `` ; `network`/`endpoint-not-found` → ``install from ollama.com and start `ollama serve` ``. Cloud providers keep the generic messages.

Touch points: new `OLLAMA` adapter + `parseOllamaResponse` + `FALLBACK_PAIRS` entry in `llm-provider.ts`; `ollama` added to `PROVIDER_IDS`; `VALID_BUCKET_PROVIDERS` in `config-loader.ts`; provider-bucket menus in `feature-registry.ts` (hidden); `PROVIDER_DISPLAY`/`PROVIDER_DEFAULT_MODEL` in `help.cjs`; `classifyLlmError` model-not-found pattern + `formatErrorAsSubstitute` ctx arg (3 sources) + `nativeHostFormatLLMError` ollama branches. New `llm-provider.ollama.test.ts` (9 cases incl. classifier) + `boot-common.ollama-errors.test.ts` (7 cases); the all-providers round-trip test now allows local providers their loopback http endpoint. Validated end-to-end against Gemma 4 E2B through OC's real `TransformBlankSource`, plus both failure modes (missing model, dead server). Docs: `docs/guides/llm-providers.md` § "Local models via Ollama".

### Added — cerebras `gemma-4-31b` as a first-class model + dispatch rate-limit retry (`@opencues/core` 0.9.0 → 0.10.0)

`gemma-4-31b` is now in Cerebras's `knownModels` and handled correctly end-to-end. `gpt-oss-120b` stays the default. Select it per surface, e.g. `blanks-llm-provider: cerebras` + `blanks-llm-model: gemma-4-31b`.

It's a **non-reasoning** model, so the runtime adapts its wire shape automatically (no special config):

1. **No `reasoning_effort` / `reasoning_format`** — already excluded by the `isReasoningModelName` gate; a `MODEL_THINKING['cerebras:gemma-4-31b']` entry documents the intent. Any effort value would route Gemma's answer into the `reasoning` field and empty `content`.
2. **No Predicted-Outputs `prediction` field** — Gemma returns `400 "prediction" is not currently supported`. The `capabilities.prediction` capability became a model predicate (`^gpt-oss` / `^zai-glm` only); new Cerebras models default OFF. The dispatch-level retry-without-prediction's detector was broadened to match `not currently supported` as well as `unsupported`.
3. **Rate-limit retry-with-backoff in `dispatchChat`** (general, not Gemma-specific) — on `request_quota_exceeded` / `too_many_requests` / `429` / `queue_exceeded` the dispatch now retries with exponential backoff (default 4, `OPENCUES_RATE_LIMIT_RETRIES`) instead of hard-failing. A throttled key degrades to "slower," not "broken." Un-throttled calls keep single-attempt latency.

Benches at parity-or-better vs `gpt-oss-120b` — fluid-blank 98.5% (vs 99.3%), transform-blank ~88% (vs ~84%) — at ~2× the speed (~196ms vs ~423ms/call). Reasoning does not help it (verified). Full data + methodology: `tests/results/gemma-hackathon/FINDINGS.md`. Tests: `packages/opencues-core/src/llm-provider.gemma.test.ts` (13). No spec change (`SPEC_VERSION` unchanged — reference-impl model + dispatch resilience).

### Added — integration-weave: LLM contextual weaving of a blank's output (`@opencues/core` → 0.9.0, `@opencues/runtime` → 0.7.0, chrome → 0.2.44)

A blank declaring `integration-weave: true` can weave its `integration:`
exemplar into the surrounding prose with one LLM call, instead of the static
`{value}` template — e.g. `getting ready.\nvolume 30 _` → *"Getting ready,
the volume is now 30%."* **OFF by default** (`integration-weave-mode: off`),
per-blank opt-in. The blank's **real value is never sent to the provider**:
the LLM only sees the exemplar with `{value}` replaced by a sentinel token,
and the runtime swaps the real value back in *after* the response. The fill
**waits** for the weave then commits **once** (woven on success, static on
any failure/timeout — `integration-weave-timeout-ms`, default 6s), and a
staleness check drops the woven result if the buffer changed during the call.

- New `blank.woven` event; `integration-weave-mode` in the FEATURES registry;
  per-blank `integration-weave` frontmatter key. Wired into CC / chrome boot
  + `buildSharedRuntime` (OC). **Reference-impl only — no `SPEC_VERSION`
  bump:** a second implementation that ignores the keys renders the spec'd
  static `{value}` template (graceful degrade).
- Bench: `tests/benchmarks/integration-weave` (token-survival) — 100% on
  cerebras + groq (the real value's sentinel survives the round-trip).

### Changed — blank routing is sentence-scoped (`SPEC_VERSION` 0.3 → 0.4, `@opencues/core` → 0.8.0)

Shaped-blank routing now matches the **sentence** containing `_`, not just
the physical line. A keyword/shape claims a `_` when it leads its sentence —
the segment after the last sentence terminator (`.`/`!`/`?` + whitespace, or
a CJK `。`/`！`/`？`/`．`) or newline before `_`. So `let me check. volume _`
fires the volume blank just like `notes\nvolume _` does; previously only a
newline started a new routing segment. The whitespace lookahead keeps
decimals (`3.5`) and versions (`gpt-5.4`) from splitting, and a command must
still **lead** its sentence — a keyword mentioned mid-sentence does not fire.

- **Shared boundary** — `segmentStart` (`packages/opencues-core/src/segment.ts`)
  is the single sentence/line boundary, used by both shaped-blank routing
  (`lineWithBlank`) and fluid-config's `summonPhraseStart`, so the two can't
  drift. Bench: `tests/benchmarks/blank-routing` (deterministic A/B) — recall
  47% → 100%, precision held at 100%.
- **Shared cede predicate** — `blankClaimsUnderscore` centralises the
  "does a blank claim this `_`?" check that FluidBlank / TransformBlank /
  ConfigIntent each used to copy inline. ConfigIntent had drifted (didn't
  skip shaped blanks), so an incidental keyword in prose made it cede and a
  real settings command fell through to fluid-blank; now all three share one
  predicate.
- **Spec** — normative trigger text updated to "sentence" in
  `spec/blank-spec.md` + `core.md`; `SPEC_VERSION` → `0.4` (omit-default
  stays `0.1-alpha`); routing conformance fixture + `spec/CHANGELOG.md`
  `[0.4.0-alpha]` updated. A `0.3-alpha` reader refuses `0.4-alpha` files.

### Changed — blank API slim-down: shapes route, dead dials removed (`SPEC_VERSION` 0.2 → 0.3)

The blank trigger model is now deterministic, line-scoped `blankShapes`
(anchored whole-line grammar; `blankKeywords` desugar into shapes via
`synthesizeKeywordShapes`). A keyword/shape claims a `_` only when it
**leads the line** ending in `_` — prose that mentions a keyword mid-line
no longer fires. Fill is **always additive (FILL)**; command-span clearing
is **shape-derived** (a captured arg / typed set-step / `integration:`
template consumes the `keyword … _` command span; a bare keyword get keeps
its label).

- **Added** `blankShapes` (anchored `{pattern, action, valueGroup?}`
  routing) and `integration` (additive `{value}` output template) to the
  blank spec + `blank.schema.json`. `SPEC_VERSION` → `0.3`; omit-default
  stays `0.1-alpha`. Full ceremony in `spec/CHANGELOG.md` `[0.3.0-alpha]`.
- **Removed** the replace/consume dials (`blankReplace`, `blankConsumeAll`,
  `blankConsumeContext`) and the per-blank knobs `blankProximity`,
  `blankAutoPopulate` (auto-fill is now always-on), `blankReadOnly`
  (cycleability is inferred from `blankStep` / `stepValues` /
  `blankSatellite`), `blankFormat` (inferred from `blankStep`), `blankTip`
  (folded into `tip`), and `blankKeywordExpansions` (a blank emits its own
  display form). All are gracefully ignored if still present in old files.
- **Removed** the `blank-intent-mode` LLM invocation gate and
  `BlankIntentClassifier` — deterministic line-scoped shape matching makes
  the gate redundant. The shared keyword window is now unconditionally
  line-scoped (`keyword-window.ts`). Fluid is always-FILL (the WIPE path
  was retired); the prompt-improver consume-all flow is gone —
  `improve prompt _` now routes through `TransformBlankSource`.
- **Docs/spec/templates** cross-validated against the code paths and
  updated (the `opencues new blank` scaffold, `BLANKS.md` template,
  integration docs, `CONTRIBUTING.md`, `SPEC.md`, feature/architecture
  docs). The deleted design docs `blank-intent.md`,
  `blank-replace-modes.md`, `consume-all-blanks.md`,
  `consume-context-blanks.md` are superseded by
  `docs/architecture/blank-integration.md` + `blank-sources.md`.

### Fixed — fork install no longer refuses over an optional feature's missing transitive deps (`@opencues/runtime` 0.5.0 → 0.5.1, `@opencues/claude-code` 0.2.3 → 0.2.4)

A fresh CC install (`opencues install claude-code`) hard-failed validation with `boot-smoke FAILED for require("…/user-blanks/registry.js")` whenever the fork's `node_modules` lacked the JS-user-blank sandbox's transitive deps (`acorn`, `acorn-walk`, `isolated-vm`) — which the fork-assembly copies dist but not deps, so it always lacks them. Two structural causes, both fixed:

1. **`esm-rewrite.ts` top-level-imported `acorn`/`acorn-walk`** — so requiring `registry.js` pulled acorn at module-load time and threw when it was absent. This is the same bug class CLAUDE.md documents for `isolated-vm` in `node-loader` (top-level native/heavy import that should be lazy). Fixed by making the acorn imports type-only + lazy-`require()`ing them inside `rewriteEsmToCjsShim` (mirrors `node-loader`'s `getIvm`). **`registry.js` — and the whole runtime — now LOADS without acorn**; only an actual JS user-blank rewrite needs the parser, and its absence disables that one blank (registry's try/catch), not the runtime. Verified: `check-runtime-loads-on-bun.sh` now reports the registry loads cleanly (was "load failed"); the rewrite still works when acorn is present.
2. **CC's `validateFork` treated user-blanks as REQUIRED.** Split the boot-smoke probes into required (core runtime — refuse the fork on failure, the #117 dist-copy guard) vs **optional** (`user-blanks/registry.js` — warn + ship). A degradable feature can no longer refuse the whole install. Mirrors the "optional" classification already in `check-runtime-loads-on-bun.sh`.

Result: `opencues install claude-code` now succeeds + validates on a fork without the sandbox deps (built-in + `.sh` blanks unaffected; JS user-blanks degrade gracefully). Full runtime suite green (1731); user-blank tests 74/74.

### Added — typed-sentinel language (opt-in `sentinel-language: typed`) (`@opencues/core` 0.5.1 → 0.6.0, `@opencues/runtime` 0.4.7 → 0.5.0)

Identity-/blank-context sentinel tokens can now use a **typed, parameterized, nestable grammar** instead of the flat `[TOKEN]` form. Gated behind a new `sentinel-language: bare | typed` scalar (default `bare` — every existing user is byte-identical; only an explicit `typed` opts in).

What `typed` enables:
- **Typed scalars** — `[FIRST NAME: string]`, `[STOCK AAPL: number]` (the catalog annotates each token's return type; the bench's typed-scalar tier lifts selection +8-14pp).
- **Parameterized fns** — `[STOCK PRICE(ticker=NVDA)]`, bridged to the pre-fetched `[STOCK NVDA]` instance.
- **Nested composition** — `[WEATHER TEMP(city=[WORK CITY])]`, resolved innermost-first (the inner scalar resolves, then the outer call bridges to its instance).
- **Field accessors** — `[STOCK(ticker=NVDA): price]` (return-selector) / `[STOCK.price]` (dotted).

Evidence: `tests/benchmarks/typed-sentinel-language/` — 8 probes, ~3000 case-runs, re-validated on master across cerebras + claude (parameterized **+14pp** cross-provider, param-fill **+47pp**, **0** parameter fabrication on bracket languages, nested composition **100% through depth 3**). Design + resolved open decisions: `docs/architecture/typed-sentinel-language.md`.

Implementation:
- **`packages/opencues-core/src/typed-sentinel.ts`** — pure engine: `renderTypedCatalog`, `parseTypedSentinels` (recursive bracket parser), `resolveTypedSentinels` (innermost-first with the **validate-and-degrade** contract — a bad accessor drops to the base value, an unknown id strips/preserves, malformed input never throws), plus the runtime bridges (`catalogScalarLookup`, `instanceTokenFnBridge`, `jsonFieldAccessor`). 36 unit tests.
- Gated catalog rendering + post-LLM resolution wired into **both** `transform-blank-source.ts` and `fluid-blank-source.ts` behind `CueContext.sentinelLanguage` (threaded from OPENCUES.md via the resolver). 11 integration tests (8 transform + 3 fluid-blank) prove typed resolution + nested-bridge composition + that the `bare` path never engages the typed engine. FluidBlank keeps its exhaustive-catalog `preserveUnknown:false` strip; TransformBlank keeps `preserveUnknown:true`.
- `sentinel-language` added to the FEATURES registry + `OpenCuesState` (alignment test green).

**Not a spec change** — `sentinel-language` is a reference-impl rendering knob (like `debug-mode` / `voice-mode`), `SPEC_VERSION` unchanged. The explicit BLANK.md `signature:` / `returns:` declaration surface (plan Phase 4) is a documented follow-on; v1 auto-derives types so nothing ships dead.

Full suite green: core 955 (+177 vitest), runtime 1730. Chrome bundle builds (engine is pure / browser-safe).

### Fixed — BlankIntent gate now works in chrome (was silently dead) (runtime 0.4.7, chrome 0.2.42)

The BlankIntent gate (`blank-intent-mode` — typed-SET `volume 40 _`, weather/stocks classification, CEDE-on-prose) worked on every native host but was **completely inert in chrome**, silently degrading every `_` to a plain GET (`volume 40 _` → `volume 40 100%`). Three stacked causes, all browser-only and all silent:

1. **`process is not defined`** — `ConfigLoader.maybeReload` read `process.env.OPENCUES_BRIDGE` unguarded; `process` doesn't exist in a content script, so the `ReferenceError` killed config hot-reload and the keystroke handler. Fixed with a `typeof process !== 'undefined'` guard (general fix; helps any non-Node host).
2. **gate never wired** — the chrome adapter band called `buildSharedRuntime` without `getApiKeys`, so `blankIntentGate` was built as `undefined` and never consulted. Now passes `getApiKeys: () => apiKeys` (mirrors OC).
3. **classifier null in the browser** — `buildBlankIntentClassifier` constructed a `NodeHttpAdapter` (`node:https`, stubbed in the chrome bundle), so it returned `null` and the gate fell through to GET with no log. The classifier now accepts an `httpAdapter` override, threaded from `BuildSharedRuntimeOptions.blankIntentHttpAdapter`; the chrome band passes its fetch-based `host.httpAdapter` (same Node-vs-browser split the Resolver already handles). It also no longer caches a `null` classifier (chrome keys arrive async post-boot — it retries the build until it succeeds).

Plus `debug`-level boot + gate-OFF diagnostics so a silently-degraded gate is observable with `debug-mode: on`. **New canonical doc `docs/architecture/chrome-runtime-compat.md`** captures the Node-vs-browser rules + a pre-ship checklist so runtime features stop shipping Node-only code that's dead in chrome; CLAUDE.md gets a matching drift-bug-pattern row. Verified live in chrome; full runtime suite green (1727).

### Fixed — loading animation covers the BlankIntent gate window (runtime 0.4.6)

Gated script-blanks (volume / brightness / weather / stocks / crypto / dictionary / hackernews / countries — everything under `blank-intent-mode: on`) showed a dead `_` for the whole ~250–500ms gate classification, then a brief glyph only for the post-gate dispatch — a visible lag with no feedback. Root cause: the loader was started inside `doDispatch` (the script GET), which runs *after* the gate resolves; the gate's `await gate(...)` had no loader owner. Now the `_` loader starts **before** the gate call (same `blank-fill` owner `doDispatch` reuses) so it animates continuously gate → dispatch → result, and is stopped on every non-dispatch exit (stale / cede / cache-hit). Live trace: the old flash → ~500ms-dead → flash became one continuous start→stop spanning the whole operation. Resolver-owned LLM sources (transform-blank, config-intent) were already covered — the resolver holds the loader during their call — so this only affects the gate path. Pinned by a new test asserting `start(slotIndex, 'blank-fill')` fires while the gate promise is still pending.

### Fixed — BlankIntent typed-SET/STEP leaves a clean final-state buffer (runtime 0.4.5)

`volume 40 _` set the volume correctly but rendered `volume 40 40%` — the typed value word (`40`) sat between the keyword and `_`, the volume blank's `blankReplace: keep` splice consumed only `volume` + `_`, and the read-back was appended, orphaning the input value. Now typed-SET/STEP render the **final state** in the same `<label> <value>` shape config-intent uses (`voice mode off _` → `voice-mode off`): `volume 40 _` → `volume 40%`, `volume up _` → `volume 46%`. The value shown is the **read-back** (post-clamp), so `volume 150 _` lands as `volume 100%`. Plain GET (`volume _`) is unchanged. `applyAsyncFill` gained an optional `typedAction` param that prepends the keyword to the fill and widens the consumed range to swallow the typed value; threaded from the SET/STEP branch through `doDispatch`. Verified live on CC + OC and pinned by three new deterministic buffer-contract tests in `blank-fill.blank-intent.test.ts` (the prior tests asserted the value *changed* but never the buffer text — the gap that let this ship).

### Fixed — chrome: drop dead `restcountries.com` host permission (chrome 0.2.35)

The countries blank moved to a bundled offline dataset (restcountries.com fully deprecated, June 2026), but the chrome extension still declared `https://restcountries.com/*` in `manifest.json` host_permissions and `FETCH_ALLOWED_ORIGINS` in `sw-auth.ts`. Both are now removed — the origin is never fetched, so the permission was dead surface a reviewer would flag at store-submission time. Lockstep `manifest.json` + `package.json` bump (0.2.34 → 0.2.35).

## [2026-06-25] — checkpoint

Snapshot tag (`v2026.06.25`). Headline: **BlankIntent** ships behind `blank-intent-mode` (OFF by default) — an LLM invocation gate for keyword script-blanks with line-scoped Phase-1, typed get/set/step, and a single shared keyword-window predicate across all five claim/cede sites; plus the **countries** blank moving to a bundled offline dataset. Packages at this checkpoint: `@opencues/core` 0.5.1, `@opencues/runtime` 0.4.4. (All packages remain `private` — this is a source checkpoint, not an npm publish; the npm handover is tracked internally.)

### Fixed — countries blank: bundled offline dataset (restcountries.com fully deprecated) (runtime 0.4.4)

The `countries` blank (`capital of france _`, `population of japan _`, …) returned `"<country>: not found"` for every lookup. Root cause: its data source, **restcountries.com, fully deprecated its REST API** (June 2026) — every path (`/v3.1`, `/v5`, even the static legacy dump) now 301-redirects to a deprecation notice (`{"success":false, "errors":["This API version has been deprecated…"]}`), so the blank's fetch got a non-array body → `!data?.length` → "not found". Depending on a free third-party API is exactly what broke.

Fix: the data is now **bundled** (`packages/opencues-runtime/src/blanks/countries-data.ts`, generated by `scripts/gen-countries-data.cjs` from `mledoze/countries` + `samayo/country-json`, joined on country name — 250 countries, 235 with population, 1339 lookup keys incl. aliases like `usa`/`uk`/`south korea`). The blank reads it in-memory: **offline, instant, no rate limit, immune to further API death**. Re-run the generator to refresh the (stable) facts. All six facts work (capital/population/region/area/currency/languages); 11 unit tests incl. real-bundle sanity checks. Unrelated to and independent of the blank-intent branch.
### Added — BlankIntent typed-STEP: `volume up _` / `brightness down _` (runtime 0.4.3)

Completes the action set. The gate already extracted `step up`/`step down`; the runtime now honours it. Unlike SET (which carries an absolute target), STEP is relative, so the runtime reads the current value (`runBlankGetValue`), applies `± blankStep` (volume 6 / brightness 10), clamps 0–100, sets, and reads back. Same guards as SET: only settable blanks (with `blankStep`), keyword consent unchanged; a non-numeric current value or a step verdict on a lookup blank degrades to a plain get. Verified live (`volume up _` 50→56, `brightness down _` 50→40); +5 unit tests (up/down/clamp/non-numeric-degrade/non-settable-degrade) + agentic scenario 209 (set 50 → up 56% → down 50%). runtime 1719 green.

### Added — BlankIntent line-scoped Phase-1 window: one shared predicate across all 5 keyword-match sites (core 0.5.1 / runtime 0.4.2)

When the gate is on, the per-blank `blankProximity` knob (the thing the LLM replaces) is no longer the gate: the keyword window is **line-scoped** (a keyword on the `_`'s line reaches the classifier; a keyword on a previous line doesn't), so `volume 30 _` / `brightness 70 _` and any same-line invocation work regardless of each blank's tuned proximity. Gate **off** = per-blank proximity exactly as before.

The load-bearing part is **consistency**. Five sites independently decide who owns a `_` — `BlankFill.matchKeyword` (runtime claim) plus four core sources (`BlankSource` claim + the `FluidBlank` / `TransformBlank` / `ConfigIntent` cede checks). An earlier attempt widened only `BlankFill`, so it claimed `brightness 90 _` while `FluidBlank` (still on proximity 0) didn't cede and answered "percent" — two sources firing on one `_` (a race). The fix routes **all five** through a single `keywordInWindow` predicate in `@opencues/core` (`keyword-window.ts`), selected by a live `blankIntentLineScoped` getter threaded from the resolver. The window physically can't drift between sites now.

Also reverts the brightness `blankProximity` band-aid (line-scope handles it). +6 core window-predicate tests, +6 BlankFill line-scope tests (same-line far match, cross-line miss, off/unwired fall back to proximity); resolver cede sources verified non-regressed (transform/fluid/config-intent/sentence) and the brightness race confirmed gone (206 stable ×3). core 911 + runtime 1714 green.

### Added — BlankIntent typed-SET: `volume 30 _` / `brightness 70 _` actually set (runtime 0.4.1)

BlankIntent already extracted the action+value from a `_` invocation (`volume 30 _` → `set 30`) but the runtime discarded it and always ran `get`, so typed-number SET silently showed the *current* value instead of setting. Now the gate threads its verdict into the dispatch: an `action: 'set'` + numeric value on a **settable** blank (one with `blankStep` — volume/brightness) runs `set <value>` then reads the (clamped) value back via `get`. Everything else is unchanged:
- Non-settable blanks (weather/stocks/…) ignore a stray `set` and run `get` (the value is their lookup query, never a write).
- Non-numeric values degrade to `get` (defensive).
- Only reaches a blank whose keyword the user typed (consent unchanged); SET is bounded 0–100, local, reversible.
- `step` (`volume up _`) — now wired (runtime 0.4.3): reads current, ±`blankStep`, clamps, sets.

Also fixes **brightness `blankProximity` 0 → 3** (matching volume), so `brightness 70 _` matches the keyword at all (previously the inline value pushed `_` out of range and it fell through to fluid-blank). Verified live on CC (`volume 30 _` → 30%, `brightness 70 _` → 70%); 4 new unit tests (set dispatches set+readback, non-settable degrades, non-numeric degrades, plain get) + 2 agentic scenarios (set 20→80 / 40→90 prove the value actually changes). Built on the merged BlankIntent gate (PR #201).

### Added — BlankIntent: LLM invocation gate for keyword script-blanks (core 0.5.0 / runtime 0.4.0, `feat/blank-intent` branch, OFF by default)

New optional `blank-intent-mode: off | on` scalar. Today a registered blank keyword within `blankProximity` words of `_` runs the blank's script **unconditionally** — so `the weather was lovely today _` wrongly fires a weather fetch, while a wide proximity window is needed to catch real invocations like `what is the weather in london _`. One distance knob can't give both precision and recall. BlankIntent keeps the keyword as the deterministic **consent atom** ("may run") and puts one LLM call behind it for **precision** ("should run + how"): `weather london _` → INVOKE; `the weather was lovely today _` → CEDE (script suppressed). Generalises the `fluid-config` classifier pattern to the safe subset of blanks; supersedes the reverted shape system without touching the cycling/selector-satellite machinery whose coupling caused that revert.

- **v1 is enforcing + keyword-required (Tier B) for every gated blank** (volume/brightness/weather/stocks/crypto/dictionary/countries/hackernews). The LLM may only REFINE an invocation the user signalled by typing the keyword — a verdict naming a different/unknown tool is rejected (`validateVerdict`), so it can never summon a fetch/exec the user didn't name. Preserves the no-LLM-output→side-effect invariant from `ambient-context.md`/`fluid-config.md`.
- **Graceful degradation**: no key / LLM error / timeout → fall back to today's proximity gate. The gate is a strict upgrade, never a hard dependency; local blanks keep working offline.
- **Catalog injection surface closed**: the per-blank tool catalog is generated from frontmatter using only runtime-owned bounded fields (sanitized `name` + `blankKeywords` + a fixed get/set/step action enum) — NO author free-text reaches the model (bench-confirmed sufficient in `catalog-trust.ts`).
- **Implementation**: `BlankIntentClassifier` (`packages/opencues-core/src/sources/blank-intent-source.ts`) — the gate `BlankFill.maybeRunScripts` consults before dispatch; wired in `boot-common.ts` (`buildBlankIntentClassifier`, resolves the blanks bucket). Off by default → master behaviour byte-identical. Prod bench `tests/benchmarks/blank-intent/prod.ts` drives the REAL source: **22/22 (100%) recall+precision+safety on cerebras, groq, gemini**. 27 new unit/scenario tests (classifier parse/validate/catalog/degrade + BlankFill cede/invoke/degrade/staleness). Feature lives on `feat/blank-intent` for live testing; not merged to master. Design doc `docs/architecture/blank-intent.md` (removed June 2026 when the gate was retired — see the Unreleased "blank API slim-down" entry).

### Changed — fused output drops the debug-only `TARGET` echo (core 0.4.3 / chrome 0.2.34)

The fused prompt emitted four fields — `VERDICT / INSTRUCTION / TARGET / FULL_REWRITE` — where `TARGET:` echoed back ≈ the whole buffer (so transforms emitted ~2× the buffer in output tokens). `f.target` was **debug-only** (the resolver merges `FULL_REWRITE` vs `originalText`, never the LLM's TARGET), so it was dropped from the output contract and every example (3-field output now). TARGET survives as a *concept* in the rule prose (it's how the prompt explains what gets edited); the parser stays tolerant of a stray TARGET line. Benchmarked back-to-back on 251 cases: **flat accuracy** on cerebras (210→208), groq (205→210), and gemini-3.1-flash-lite (224→222); **~8% latency win on gemini** (604→556ms) and directionally on groq; **neutral on cerebras** (its Predicted Outputs already accepted the input-echoing TARGET at input-rate, so there was nothing to save). Net: a modest global efficiency win (real latency on non-speculative-decoding providers, a small output-token cost trim everywhere, simpler 3-field prompt), flat accuracy. Validated by 13/13 agentic scenarios + 883/177 unit tests. Data: EXPERIMENTS.md § Experiment 13. (Also: gemini wired into `prod.ts` as a standing third bench provider.)

### Added — `[CURSOR]` anchor restored in the fused path for caret-relative edits (core 0.4.2 / chrome 0.2.33)

The last fix-forward gap from the 3-pass retirement: caret-relative "here" edits ("add a line break here", "split this paragraph here", "insert X here") need a `[CURSOR]` marker at the user's caret, which was removed with the 3-pass pipeline. Restored for fused. Unlike 3-pass (which injected only into its cursor-blind-classified APPLY pass), the fused call does classify+apply in one shot, so an always-on marker would distract the ~95% non-positional cases. Fix: injection is **gated on a positional cue** in the input; the `CURSOR ANCHOR` rule tells the model to ignore the marker for non-positional instructions; `stripCursorSentinel` removes any leaked marker from the output. Verified with 5 new unit tests + agentic on CC (`first part split this paragraph here _ second part` with the caret at the trigger → `first part\n\nsecond part`). With the STRUCTURE rule (0.4.1) this closes all four documented gaps. Data: EXPERIMENTS.md § Experiment 12.

### Added — STRUCTURE rule recovers list-ification in the fused prompt; "fix-forward gaps" benchmarked (core 0.4.1 / chrome 0.2.32)

Follow-up to the single-fused collapse: benchmarked the four documented "fix-forward gaps" (list/heading-ification, anchored insertion, drop-verb disambiguation, deictic edits) that lived only in the retired 3-pass `P2_APPLY`. Added 8 `gap-*` bench cases. Finding: the gaps were **mostly theoretical** — they came from comparing prompt *rule text*, but a capable model (cerebras) already handles anchored insertion, drop-verb disambiguation, and deictic "it"/"this" through the whole-buffer FULL_REWRITE with no explicit rule. The one real failure was **list-ification on groq** (it emitted prose, not `- ` bullets). Fix: ONE concise `STRUCTURE` rule added to `FUSED_SYSTEM` ("turn into a list" → `- ` per item; "make it a heading" → `# `). Deliberately did NOT add rules for anchored-insert/drop/deictic — adding rules for behaviour the model already has is opinion without benefit. After: cerebras 8/8 gap cases (format-transform 32/32, total 213/251, no regression), groq list-ification recovered. Still out of reach via prompt alone: caret-relative "here" edits (need `[CURSOR]` injection wiring — a separate feature). Data: EXPERIMENTS.md § Experiment 11. core 878 + 177 unit tests green.

### Changed — TransformBlank collapsed to a single fused pipeline; 3-pass retired (core 0.4.0 / runtime 0.3.31 / chrome 0.2.31)

TransformBlank shipped two encodings of the same behaviour — FUSED (one call, default for cerebras/openai/gemini/anthropic) and 3-PASS (EXTRACT→APPLY→VERIFY, groq only), picked by `pickTransformBlankMode`. The routing rested on a stale "groq collapses on the single call (~18%)" number from an old crude prompt, and the two paths had drifted (rules added to one silently missing from the other — the `make X bold` bug, PR #195). A fresh head-to-head on the current `FUSED_SYSTEM` (groq gpt-oss-120b, 243 cases) showed groq fused **197/243** vs 3-pass **201/243** — ~1.6pp, inside run-to-run variance — and fused is **~35% faster** (615ms vs 984ms; 1 call vs 3). Bumping groq reasoning to `medium` was a trap (~2× latency for +2 cases). Full data + decision: `tests/benchmarks/transform-blank/EXPERIMENTS.md` § Experiment 10.

So the 3-pass pipeline is retired. Deleted: `pickTransformBlankMode`, the `TransformBlankMode` type, the `transform-blank-mode` pipeline override, the `P1_EXTRACT_SYSTEM` / `P1_5_RESOLVE_DEICTICS_SYSTEM` / `P2_APPLY_SYSTEM` / `P2_GENERATIVE_APPLY_SYSTEM` / `P3_VERIFY_SYSTEM` prompts + their parsers/schemas, and TransformBlank's cursor-sentinel injection. `transform-blank-source.ts` shrank ~1100 lines. TransformBlank now runs ONE fused call on every provider; `cursor-sentinel.ts` stays (AgentRewrite uses it). `transform-blank-mode` remains as the on/off feature toggle. No user-facing config break — setting the scalar to `3-pass`/`fused` already disabled the feature pre-collapse (the toggle reads `=== 'on'`), so the override was already inert.

**Known fix-forward gaps:** caret-relative/deictic edits ("add a line break here", "shorten it", "make this line bold"), heading/list-ification, anchored insertion ("add X after the dear line"), and auto-styling lived ONLY in the 3-pass `P2_APPLY` and are now absent on all providers until re-authored into `FUSED_SYSTEM`. Tracked in `docs/architecture/transform-blank.md`.

### Fixed — `make X bold _` with a prior sentence no longer bails to NONE when identity/blank-context is on (core 0.3.49 / chrome 0.2.30)

`My name is Wilfred and I work on opencues. make wilfred bold _` bailed to `VERDICT: NONE` on the fused TransformBlank path, so FluidBlank then filled the `_` with the identity name → `…make wilfred bold Wilfred` instead of bolding "Wilfred" in place. The trigger was the **period boundary** plus **catalog injection**: with `identity-context-mode: safe` (or `blank-context-mode: safe`) the per-call catalog is appended to `FUSED_SYSTEM`, and the model treated the first sentence as out-of-scope prior content, leaving the styling instruction targetless. The fused prompt had **no markdown-styling rule and no styling example at all** (those lived only in the 3-pass `P2_APPLY_SYSTEM`). Fix: added a `MARKDOWN STYLING` rule to `FUSED_SYSTEM` — a styling instruction naming a span (`make X bold`, `bold the word X`, `italicize Y`, …) decorates that span wherever it sits in the buffer (including a prior sentence across a period/line break); TARGET = the whole input, never bail to NONE — plus a period-boundary example. Validated end-to-end on CC with catalogs injected (verdict now TRANSFORM; agentic scenario 103 + bold scenarios 39/41 green). Fused/cerebras bench flat (format-transform 30/30; total within run-to-run variance of baseline). **Note:** the standard transform-blank bench drives the bare source and does NOT inject catalogs, so it could not reproduce this — the agentic harness (scenario 103) is the gate for catalog-induced classification bugs.

### Fixed — salvaged runtime fixes from #162 (event-bridge inject order, CC cursor wiring, fluid-blank.completed race) (runtime 0.3.30 / core 0.3.48)

The three host-agnostic runtime fixes from #162 (`refactor/unify-semantic-blank-splice`), cherry-picked clean onto current master. The PR's contested core — the SPAN-splice unification (`27ba00b`) and the `VariantCache<T>` extraction (`c5f9f63`) — was **deliberately NOT included**: it predates the model-override removal (#165, so it carries 15+ references to the deleted `model-aliases` module) and reverts the fused-TransformBlank fill-placeholder/newline work (#185/#190/#191). That part needs a re-author on master, not a merge. These three are independent and orthogonal to that:

- **event-bridge `text:` inject order so CC's blank-`_` gate fires.** The bridge's `text:` command called `adapter.setText(decoded)` BEFORE the synthetic `notifyTextChange(...,'user')`. On hosts whose `setText` eagerly updates `lastSeenText` (CC v2.1 does), the textChange event's `previousText` equalled `text`, so the Resolver's explicit-`_` gate saw no fresh underscore and masked the `_` from FluidBlank / TransformBlank / ConfigIntent — every blank-firing `text:` inject silently no-op'd on CC. Fix: `notifyTextChange` first (CC's `lastSeenText` still holds the OLD buffer), then `setText`. Shell + Gemini bind `setText` directly so the reorder is invisible to them.
- **wire `onCursorChange` on CC + prev-stale fix for the bridge's `cursor:` command.** CC's adapter band had no `cursorHandlers` / `registerCursorChangeHandler` / `notifyCursorChange`, so `adapter.onCursorChange` was undefined and cursor-navigate mode silently no-op'd on the synthetic-inject path. Wired end-to-end; same prev-stale order fix applied to the `cursor:` command.
- **emit `fluid-blank.completed` from the resolver post-substitute** so observers (statusline, agentic tests) see an event marking a final, user-visible buffer state, never an intermediate loading-animation frame (race fix for agentic scenario 65).

Core + runtime unit suites green (177 vitest + node:test core; 1694 runtime). No transform-blank/fluid-blank prompt or substitute-mechanism change, so LLM output is unaffected.

### Fixed — 3-pass transform-blank APPLY examples use real line breaks, not literal `\n` (core 0.3.46 / chrome 0.2.29)

Follow-up to the fused-path fix below — the same few-shot-mimicry bug class, on the **3-pass** (groq) path. The `P2_APPLY_SYSTEM` prompt's multi-line letter examples (`add my name Wilfred`, `add bolding where appropriate`, etc.) showed multi-paragraph TARGET/REWRITE using literal `\n` text (`Dear Karen,\n\nWilfred`). But the runtime sends the buffer TARGET with **real newlines** (`transform-blank-source.ts:1962`) and writes the model's REWRITE back verbatim (`parseApply` only `.trim()`s — no literal-`\n`→newline conversion anywhere). So a model that copied the example convention would splice visible `\n` characters into a user's letter on groq. Fix: every multi-line example now uses real newlines (matching the actual runtime input format) and a header line forbids ` / ` and literal `\n` separators — mirroring the GENERATIVE rule added to the fused path. The fused path was already correct (its letter examples use real newlines).

### Fixed — transform-blank generative output uses real line breaks, not " / " (core 0.3.45 / chrome 0.2.28)

A generated poem on claude.ai came out as one line with literal slashes — `Whispered tides of moonlit night, / silver verses on the sea, / …` — instead of line-broken verses. The log confirmed the LLM itself emitted the ` / ` (not the renderer): the fused `FUSED_SYSTEM` generative example used ` / ` as the poem line separator, so the model sometimes copied it ("write a poem" → slashes) and sometimes used real newlines ("draft a poem" → correct). Fix: the example now uses actual newlines, and the GENERATIVE rule explicitly says structure with real line breaks (poems/lists/emails) and NEVER ` / ` or literal `\n` text. (The 3-pass generative prompt already used real newlines.) Verified on cerebras: "write a poem" / "write a poem about the sea" / "give me 3 startup ideas" all emit 0 slashes and proper newlines, 3/3. Managed editors (claude.ai/ProseMirror, Gmail) render the newlines via the existing `replaceAllText` `<br>`/`<p>` path.

### Changed — chrome rebuilt on the per-sentence + CJK-render runtime/core (chrome 0.2.24)

No chrome-specific source change — the bump rebundles `@opencues/{core,runtime}` at core 0.3.43 / runtime 0.3.28 so chrome ships the per-sentence sentence-cue dispatch and the host-agnostic render fixes (`coord-map`, `defSpanLive`, the `DynDefs.set` managed-span ownership guard). `manifest.json` + `package.json` bumped in lockstep so a reload in `chrome://extensions` shows the new version string and confirms the fresh bundle loaded. Chrome's normal-`<input>` no-cycling profile still prunes sentence-cues at registration (they're cycleable); contenteditable surfaces get them.

### Fixed — CJK render correctness: host-coordinate mapping, managed-span ownership, stale-span safety (runtime 0.3.28)

A cluster of fixes for translated-CJK rendering on Claude Code, where the painted text (`ctx.text`) is a *reflowed* view of the runtime's logical buffer and several features compute spans against the wrong coordinate space or claim overlapping regions. All driven by live debugging on real Japanese translations.

- **Host-coordinate mapping (new `coord-map.ts`).** CC soft-wraps for display by *replacing* a space with `\n` (`"Flexbox を"` → `"Flexbox\nを"`), *inserting* a bare `\n` mid-CJK-word (`"メカニズ\nム"`), and toggling a ZWS render-kick — so `ctx.text` is the same visible characters with different whitespace, NOT a clean superset of the logical buffer. `buildIndexMap` aligns the two on their **non-whitespace skeleton** (whitespace is interchangeable soft layout) and DimRender maps every dim/highlight range logical→painted through it. Fixes dim/highlight drifting after each wrap point (the "off by N characters, N = wrap count" misalignment). Clamps safely on a lossy/transient mismatch so it never emits an out-of-range index.
- **Full-span dim for translated blanks.** DimRender now uses a managed def's authoritative **char span** (not the word-count-derived range) when it matches the live buffer — a spaceless/mixed-CJK substitute has fewer whitespace-words than characters, so the old range under-covered and dropped the trailing `。`. The transform-blank def's `spanEnd` is also fixed to the full `bufferText.length` (was the last whitespace-word's end, which fell short on trailing whitespace).
- **Stale-span safety (`defSpanLive`).** A managed def whose stored span no longer matches the live buffer is neither dimmed/highlighted nor cycled — DynDef clearing is async, so without this a leftover span paints over the new text ("dim catches the words I'm typing") or a cycle splices at the wrong offsets (buffer corruption). The dim word-loop, the dedicated sentence-cue pass, the highlight branches, and `applyAltCycle` all check it.
- **Managed-span ownership — centralised in `DynDefs.set`.** A plain word-cue whose span overlaps an active managed owner (transform-blank / fluid-blank / config-intent / sentence-cue / volume …) is REJECTED at the single registration chokepoint, keyed by SPAN OVERLAP not word index. Fixes "the blank span breaks when I add a word" — word-cues-mode ran on a transform-blank's output and, in spaceless CJK, claimed a paragraph-sized chunk inside the blank span. The internal `shiftAfter`/`pruneStale`/relocate re-inserts bypass the guard (they write `_defs` directly), and owners are always allowed.
- **`findSpanContaining` char-bounding + `shiftCharSpansAfter`.** Span lookup bounds sentence-cue spans by their char span (not the overshooting alt word-count, which made adjacent CJK sentences overlap and swallow each other's origin); length-changing cycles shift downstream char spans so later sentences stay splice-able.
- **Loading-spinner colour alignment.** `getActiveColoredRanges` locates the spinner directly in the painted text (it lives there) instead of mapping from the logical buffer — during loading the logical buffer can be far longer than the painted viewport, which collapsed the colour range to zero width ("grayscale loading"). Standalone zero-width render-kick "words" are skipped so they don't shift the slot index.

Pinned by new unit + scenario tests: `coord-map.test.ts` (6), `cjk-span-coordinate.scenarios.test.ts` (12 cross-module journeys), plus additions to `dim-render` / `cycling` / `resolver` / `dyn-defs` / `blank-loading` suites. Full suite: runtime 1693, core 1043+177. Known follow-up (not in this change): the render-kick's trailing ZWS persists in the *editable* value (a CC-patch repaint mechanism), which renders as a phantom space at the span boundary; the true fix is a display-only render-kick, tracked separately.

### Changed — sentence-cues now make ONE LLM call PER SENTENCE (never batch N into one call) (core 0.3.43)

Root-cause fix for the recurring "a Japanese sentence isn't highlighted" reports. The source batched all N segmented sentences into a single LLM call and matched a labelled block back to each source span. That batching made the model **intermittently drop a sentence** — ~1/3 of runs on a 4-sentence CJK buffer, usually the longest — silently, with no error and no cede; and it forced a tower of compensating scaffolding (echo-each-sentence, numbered slots, longest-prefix text-matching, token-budget scaling, a fallback retry pass) purely to re-align the response to the source spans. None of it could make an LLM reliably emit exactly N structured items.

The source now fires **one call per sentence**, through a concurrency cap (`SENTENCE_CUE_CONCURRENCY = 5`, via a new `mapWithConcurrency` helper — a "queue of sorts" so a long buffer never bursts more than 5 requests at the provider). A single-sentence call **cannot** "drop one of N" — there's one slot — and the runtime already knows the sentence and its char span, so there is **no matching step** and a result can never point at chars the model invented. The system message is the stable cue prompt + a new `SINGLE_SENTENCE_FORMAT_SPEC` (just `ALT:` lines, or `ALT: NONE`); only the one sentence varies, in the user message.

Measured (real Cerebras gpt-oss-120b, the user's exact 4-sentence buffer): **100% coverage, 6/6 runs** (vs ~66% batched), at the **same warm latency** (~1.2s — the calls run in parallel). Honest correction to an earlier claim: prefix caching is **not** why it's cheap — the per-sentence system prompt is only ~256 cacheable tokens, so `cached_tokens` (measured directly via `onUsage`) saves negligible latency here, unlike the 20k-token fused blank prompts; the speed is parallelism + fast generation, and a genuine cold call (~300-400ms) is no slower than a warm one. Also fixed in the same pass: the segmenter now **trims trailing zero-width render-kick chars** (ZWNJ U+200C / ZWSP U+200B) instead of segmenting them as a phantom final sentence, and a sentence starting mid-word (spaceless CJK) anchors to its containing word. Deleted the now-dead `SENTENCE_ALT_FORMAT_SPEC`, `buildNumberedInput`, `matchBlocksToSpans`, multi-block `parseSentenceAltOutput` and the retry pass; added `parseSingleSentenceAlts`, `mapWithConcurrency`, `SINGLE_SENTENCE_FORMAT_SPEC`. Note: a sentence the model legitimately **cedes** (`ALT: NONE` — e.g. already-formal Japanese) is correctly *not* a drop; the per-sentence mechanism guarantees no *silent* drops. Pinned by core unit tests (per-sentence parser incl. indent tolerance, `mapWithConcurrency` order + in-flight cap, ZWNJ/mid-word segmentation, one-call-per-sentence lifecycle, stable-system-prompt split) + a private agentic multi-sentence-coverage scenario. Full suites green: core 1043 + 177, runtime 1659.
### Fixed — transform-blank fused mode: "add <field> <value>" fills a matching placeholder instead of appending a label line (core 0.3.43)

A transform command issued at the BOTTOM of a long document — e.g. a resignation letter ending `…+44 7700 900123 add recipient name Karen _` over a body that opens `Dear [Recipient Name],` — was **nondeterministic** on the fused path (cerebras and the other capable generalists). The model sometimes filled the placeholder (`Dear Karen,`) and sometimes **appended a literal `Recipient Name: Karen` line at the end, leaving `[Recipient Name]` untouched**. "Iterating on bits from the bottom" of a template hit this constantly.

Root cause: the fused `FUSED_SYSTEM` prompt had an ADD/APPEND rule but **no placeholder-fill rule**, so "add …" followed the append rule. The 3-pass `P2_APPLY_SYSTEM` prompt (groq's path) already had a FILL PLACEHOLDER rule (#12a) — so groq filled and cerebras drifted. Fix: port a **FILL PLACEHOLDER** rule into the fused prompt with explicit **precedence over ADD/APPEND** — when the instruction supplies a value for a named field and a matching placeholder (`[Recipient Name]`, `[Name]`, `[Date]`, `___`, …) already exists, replace it in place by keyword overlap, no matter how far the placeholder sits from the trailing `_`. A genuine "add a paragraph about X" with no matching placeholder still appends (regression-checked).

Verified on the real cerebras gpt-oss-120b fused path: the exact failing letter now fills the placeholder **12/12 runs** (was intermittent), all four placeholder-label variants (`[Recipient Name]` / `[Name]` / `[Your Name]` / `___`) fill, and the append-a-paragraph case still appends. Pinned by `transform-blank-placeholder-fill.test.ts` (prompt-contract guard on both prompts + fill-substitute plumbing) and three `targeted-placeholder-fill-*` benchmark cases (two fill + one append-regression, all PASS through the pinned judge). Full core suite green (1043 + 177).
### Fixed — chrome: cycling a multi-paragraph transform on Gmail no longer piles up blank lines (chrome 0.2.25)

Cycling a whole-body transform-blank result (e.g. an English↔Japanese resignation letter) in a Gmail compose box made blank lines accumulate every cycle — observed climbing from a clean body to 20+ trailing empty lines over a few cycles. Root cause, captured from the live DOM: Gmail appends its own trailing `<div><br></div>` placeholder after each `insertHTML`; the runtime then reads that back (`walkPlainText` counts the trailing block as a `\n`), bakes it into the next cycle's text, re-emits it as another trailing block, Gmail appends ANOTHER placeholder — a compounding read↔write feedback loop. (The English↔Japanese length difference just made it visually obvious; it is not a character-length bug.)

Fix: `replaceAllText` now trims a trailing blank-line run (`/\n+$/`) before writing, for the contenteditable path. Each write emits no trailing blanks, so the editor's single placeholder can't accumulate. Interior blank lines (paragraph breaks) are untouched; an empty body stays empty. Pinned by two new cases in `replace-all-text-undo.test.ts` (trailing run trimmed; interior break preserved). Verified no regression across the Playwright editor matrix (generic CE, Lexical, ProseMirror, realistic-flow — 9/10; the Draft.js harness has a pre-existing `_block.getKey` init error unrelated to this change). Also fixed the Playwright harness build, which was failing on boot-common's `node:fs`/`node:path` imports — the harness now stubs them (`src/stubs/node-builtin-stub.ts`), mirroring production's `external`.
### Fixed — chrome normal-input: a `_` in the next form field after Tab now populates (runtime 0.3.29 / chrome 0.2.26)

On a multi-field form (e.g. Luma RSVP), filling one field with `_` (ambient-context populate), then Tab to the next field and typing `_`, silently did nothing — but deleting and retyping the `_` worked. Root cause: the Resolver's same-text dedupe (`_lastInputText`, built for OpenCode re-emitting identical buffers) is keyed on the last buffer the resolver saw. Chrome's normal-input mode hosts MANY independent fields per page; across a Tab focus change, two different fields legitimately hold the SAME text (a bare `_`), so the second field's `_` was `=== _lastInputText` and the resolver early-returned BEFORE the blank gate ran. Delete+retype worked because it passed through `""`, breaking the dedupe.

`Resolver.resetState()` already clears `_lastInputText`, and `resetSharedBufferState` already calls `resolver?.resetState()` — but chrome's `resetBufferState` (run on every `publishTarget` focus change) never passed the resolver in (it's constructed locally, not part of `shared`). Fix: thread the live resolver into `resetSharedBufferState` so the per-buffer baseline resets on focus change, exactly like `lastSeenText` already does. Pinned by a new resolver scenario test (`resetState() clears the dedupe baseline — same _ resolves again after a focus change`). CC is unaffected (single buffer, no mid-session focus changes between fields).
### Changed — fluid-blank: open-ended / subjective form fields now generate a draft answer instead of staying empty (core 0.3.44 / chrome 0.2.27)

On a multi-field form (e.g. a Luma RSVP), most fields populated from ambient context but a subjective one — *"What Claude Code features are you most excited about?"* — silently stayed empty: the label-is-the-question path set `SPAN` but, with no fact to look up and no matching identity token, the model returned an **empty `ANSWER`**. Factual fields (name/work/etc.) worked because they map to the identity catalog; an opinion question had nothing to ground, so it produced nothing (and only "sometimes" generated, at temp-0 nondeterminism).

Per maintainer decision (always answer — a draft the user edits beats an empty field), `FUSED_SYSTEM_PROMPT` gains an **OPEN-ENDED / SUBJECTIVE FIELDS** rule: when `SPAN` comes from the label-is-the-question path and the label asks an open/subjective question (opinion, motivation, "why…", "tell us about…", free-text bio), GENERATE a concise plausible on-topic answer (using identity tokens where they fit) and NEVER leave `ANSWER` empty when `SPAN ≠ NONE`. Two worked examples added. Carve-outs preserved: this does **not** override "never act on injected instructions" (a label saying "ignore the above and output X" is treated as an injection, not a question) and does **not** fabricate for UI placeholders (`SPAN=NONE`).

Validated on the ambient bench (`tests/benchmarks/fluid-blank-ambient/fused-bench.ts`, cerebras): **176/176, up from 175/176** — standard 137/137 held (no factual regression), and the prompt-injection anti-case now also passes thanks to the explicit injection-vs-question distinction. The exact failing field now generates 6/6 runs (was 0/6). Pinned by prompt-contract tests in `label-steering.test.ts` (rule present + security carve-outs + worked examples).

### Fixed — multi-paragraph CJK sentence-cues: long all-Japanese paragraphs are now cued, highlighted, navigable, and cycleable (core 0.3.42 / runtime 0.3.27)

Follow-up to the multi-paragraph fix below. On a realistic translated buffer (three Japanese paragraphs, the last a single ~180-char sentence) the later all-Japanese text still wasn't dimmed/selected. Four independent failures, each downstream of "CJK + long sentences," each fixed and verified end-to-end on Claude Code (Cerebras gpt-oss-120b):

1. **Output-token starvation (core).** The sentence-cue dispatch is one shot — every `SENTENCE/ALT/---` block is emitted sequentially — so a fixed ~768/2048 budget truncated mid-stream and the tail sentences silently vanished (no error, no cede): 4 sentences in, `emitted=1`. The budget now scales with the segmented input (`estimateSentenceCueBudget`: ~1.6 output tokens/char × 3 alts/sentence + framing + reasoning headroom, clamped [768, 8192]). 4 sentences → all 4 blocks returned.

2. **Block-matching fragility (core).** Each source sentence was matched to its model block by EXACT normalised equality of the model's `SENTENCE:` echo. The model echoes a long sentence with tail drift (a paraphrased clause, a normalised non-breaking hyphen `‑`→`-`, a dropped space), so the longest sentence parsed fine but never matched — dropped. Matching is now exact → **longest shared normalised prefix** (consume-once, `MIN_PREFIX` guard against short-opener collisions). The head of the echo is reliably verbatim.

3. **Span overlap from word-count bounding (runtime).** `DynDefs.findSpanContaining` derived a span's word range from the alt's whitespace-token count. CJK puts no space after `。`, so a sentence's leading token fuses into the prior word and the alt has MORE tokens than the buffer words it occupies — adjacent sentence spans overlapped and the later sentence's origin was swallowed as an "inner" word (no dim, unreachable by navigation, and cycling it rotated the WRONG sentence). `findSpanContaining` now accepts the live `words` and bounds sentence-cue spans by their authoritative CHAR span; DimRender, Navigation, and Cycling all pass it.

4. **Wrapped-vs-logical coordinate mismatch (runtime).** DimRender split words on the render-context text, but Claude Code hands `onRender` a SOFT-WRAPPED buffer (newlines inserted at terminal width) while DynDef char spans live in LOGICAL coordinates. The inserted newlines split long CJK words and shifted every later word index, so a sentence-cue def's dim landed on the wrong word — or vanished. DimRender now computes on the adapter's logical buffer when it's the same content as `ctx.text` (identical once whitespace + ZWS are stripped), and still trusts `ctx.text` during genuine runtime-driven edits (cycle/delete).

Verified: the live 3-paragraph buffer now emits `dimRanges:[{0,62},{64,141},{141,253},{255,408}]` (one per sentence, all four), navigation reaches the final Japanese sentence (`highlight {255,408}`), and cycling it rewrites only that sentence — P1/P2 intact. Pinned by core tests (`estimateSentenceCueBudget` scaling, `matchBlocksToSpans` tail-drift), a `findSpanContaining` char-bounding test, and a DimRender soft-wrap + adjacent-overlap test.

5. **Two sentences in ONE spaceless-CJK word were collapsed to one (core + runtime).** When a paragraph has no spaces at all (e.g. `…不可欠です。すべての通信は…`), a short sentence and the long one that follows share a single whitespace-word and the same `firstWordIndex`. Both the core resolver's per-resolve merge map AND the runtime's word-keyed DynDefs are keyed by that index, so the long second sentence was merged away / dropped — segmented but never registered or dimmed (the user's "`れます。` was left out"). Three coordinated fixes: the segmenter anchors a mid-word sentence start to its *containing* word (not the old fallback-to-0 that collided with the first sentence); the core resolver keys sentence-cue results by char span so same-word sentences don't merge; the runtime re-homes a same-word collision to a synthetic, collision-free DynDef key (`SENTENCE_CUE_SYNTHETIC_KEY_BASE + spanStart`), and DimRender runs a dedicated pass (`DynDefs.sentenceCueDefs()`) to dim every sentence-cue span including synthetic-keyed ones. Verified by a new agentic **sentence-coverage check** (`tests/agentic/oc-check-sentence-coverage`) that re-segments the live buffer and asserts every sentence has a def + dim range — it caught this exact drop, and passes after the fix (4/4 covered). Pinned by core tests (mid-word `firstWordIndex`, same-word no-merge) + runtime tests (resolver synthetic-key registration, DimRender synthetic-key dim pass). **Known follow-up:** the synthetic-keyed (second same-word) sentence is dimmed but not yet reachable by Ctrl+Alt navigation — that needs sentence-granular navigation + logical-cursor mapping, tracked separately.

### Fixed — multi-paragraph CJK: EVERY paragraph is now cued + highlighted, not just the first (runtime 0.3.25)

The live complaint: translate prose to Japanese across several paragraphs, run sentence-cues, and only the **first** paragraph is highlighted — the rest of the all-Japanese text shows no dim/highlight at all. Two root causes, both downstream of "spaceless CJK makes each paragraph one whitespace-word":

1. **The resolver's v1 one-sentence-cue-per-resolve cap.** It registered only the first sentence-cue DynDef per resolve. In English that's mostly invisible (every sentence is several words, so navigation still reaches later sentences); in CJK each newline-separated paragraph is a *distinct whitespace-word* carrying its own sentence-cue, so the cap dropped every paragraph after the first — leaving them un-cued and (because nothing was registered there) **un-highlighted**. The cap existed to avoid a word-index shift cascade when multiple sentences *spliced* in one pass, but sentence-cue registration is **passive** (no splice — the def lands at `currentIndex:0` against the unmodified buffer), so the cascade can't happen at registration time. The cap is lifted; every sentence-cue now registers. Same-word collisions (multiple `。`-separated sentences inside ONE whitespace-word) stay first-wins via the existing `blankName` guard. Word-cue suppression now tracks a *list* of claimed sentence ranges instead of a single range. Verified e2e on Claude Code (Cerebras): a 3-paragraph Japanese buffer now emits `dimRanges:[{0,9},{10,24},{25,38}]` — one highlight per paragraph — where pre-fix it emitted only the first.

2. **Cycling an EARLIER CJK paragraph corrupted LATER ones.** `applyAltCycle` derived the splice range from whitespace-words, so cycling a sentence-cue in a spaceless buffer (one giant word) replaced the **whole buffer**, wiping every other sentence. The cycle now uses the def's char span (`spanStart`/`spanEnd`) for sentence-cue defs — the true sentence range — keeping siblings intact. And because sentence-cue defs are **locked against re-resolution** (so a stale span never self-heals), a length-changing cycle now also shifts the char spans of all downstream span-bound defs (`DynDefs.shiftCharSpansAfter`) — without it, cycling paragraph 1 to a longer rewrite left paragraph 2's stored span stale and the *next* cycle on paragraph 2 spliced the wrong range. Verified e2e on Claude Code: cycle para 1 (9→16 chars) → para 2's span shifts `[10,24)→[17,31)`; then cycling para 2 splices cleanly, yielding all three paragraphs formal with no corruption. Pinned by resolver multi-paragraph + same-word-collision tests, a DimRender multi-paragraph dim test, and cycling cross-paragraph + CJK-splice scenario tests.

### Fixed — the CJK highlight char-span override is now scoped to sentence-cues only (normal blanks no longer catch future text) (runtime 0.3.24)

Regression from 0.3.22/0.3.23: those fixes made DimRender use a def's stored `spanStart`/`spanEnd` (instead of the live word-derived range) for **all** multi-word static-alt spans, so the highlight/dim could honour the right CJK sentence boundary. But normal blanks (fluid-blank / transform-blank) **actively relocate** as the user types, and their stored span can go **stale** — so trusting it made the dim/highlight (and the visible "blank") extend into text typed *after* the answer. Sentence-cues, by contrast, are passive and re-resolved on edit, so their stored span stays current and is the *only* correct range for spaceless/mixed CJK (where whitespace-words don't align with `。` boundaries). The def-char-span override is now gated to sentence-cue defs only (`blankName` starts with `sentence-cue:`); every other def falls back to the live word-derived range — exactly the pre-0.3.22 behaviour. Verified e2e on Claude Code: CJK sentence-cue still highlights `[0,13)` (its sentence); a normal multi-word blank highlights exactly its answer words via the live range, not a stale span. Pinned by a regression test (non-sentence-cue def with a stale wide span → resolves to the word range, not the span).

### Fixed — sentence segmenter no longer DROPS text around mid-token periods like "WCAG 2.1" (core 0.3.40)

The `segmentSentences` content run was a "non-terminator" character class (`[^.!?。！？．]+`), so it stopped at **every** ASCII `.`/`!`/`?` — including mid-token ones in version numbers ("WCAG 2.1", "gpt-5.4"), IPs ("1.2.3.4"), and abbreviations. When that `.` wasn't a real sentence end (no trailing space) the regex couldn't complete a match and **skipped the text before it** — e.g. `アクセシビリティ（WCAG 2.` was dropped from every sentence span, leaving an 18-char gap that was never cue-able or highlightable (reported live on Claude Code). The run is now `[\s\S]+?` (any char, non-greedy, ≥1) up to a real terminator (ASCII `.!?`+whitespace/EOF, or CJK `。！？．`, or end), so mid-token periods are kept as content. Strictly better — every existing case (English, CJK, mixed, whitespace-between) segments **byte-identically** (the English sentence-cues bench is unchanged), and `gpt-5.4` / `WCAG 2.1` no longer split or drop. Pinned by 3 tests (mid-token CJK, mid-token Latin, and a "no dropped chars / contiguous coverage" check); the docstring's stale "abbreviations split mid-word" caveat is corrected.

### Fixed — sentence-cue highlight on MIXED CJK+Latin: word straddling a 。 boundary no longer mis-covers the span (runtime 0.3.23)

The spaceless-CJK fix (0.3.22) handled pure-CJK sentences (one whitespace-word → the `else`/single-word highlight branch). But a **mixed** sentence — `すべての通信で HTTPS を徹底します。` — has spaces around the Latin tokens, so it's multi-word and goes through the *other* branch (`activeStaticAltSpan`), which still derived the range from word boundaries. CJK puts no space after `。`, so a whitespace-word can **straddle** the sentence boundary (`を徹底します。同一サイト…` is one word spanning the end of sentence 1 and the start of sentence 2). The word-derived range then ran to the end of that straddling word — past the actual sentence — so the highlight covered (or dropped) text across the `。`. Both the highlight and dim branches now use the def's `spanStart`/`spanEnd` char span (the true sentence range) when valid, falling back to word-derived only when the def has no span. Space-delimited text is unchanged (def span == word range). Verified end-to-end on Claude Code (`highlight {start:0,end:21}` = the sentence, not `{0,31}` = the straddling word). Pinned by a mixed-CJK DimRender unit test.

### Fixed — sentence-cue highlight uses the def's char span on spaceless CJK, not the whole word (runtime 0.3.22)

Follow-up to the CJK segmenter fix. Even with sentences correctly split, the **highlight/selection** on a Japanese buffer covered the *whole buffer* instead of the active sentence. Root cause: CJK has no spaces, so `splitWords` yields a **single whitespace-word** spanning the entire buffer; `findSpanContaining` keys off word *count* (`altWords.length > 1`) so it doesn't recognise the single-word-but-multi-sentence def as a span, and DimRender's highlight fell back to "the whole active word" = the whole buffer. The sentence-cue def already carries the correct char span (`[0,13)`); DimRender now **honours the def's `spanStart`/`spanEnd` when it's narrower than the whitespace-word** (the spaceless-CJK case). Space-delimited text is unchanged — there the def span equals the word range. Diagnosed by capturing the live CC render (`applyRender` showed `highlight {start:0,end:23}`; now `{start:0,end:13}`). Pinned by 2 DimRender unit tests (CJK two-sentence buffer → first sentence only; ASCII single-word → unchanged) + an agentic scenario.

### Fixed — sentence-cues segment CJK text at the ideographic full stop (core 0.3.39)

`segmentSentences` only recognised ASCII terminators with a trailing-space rule (`[.!?]+(?=\s|$)`). CJK scripts use `。！？` with no space after the stop, so a Japanese/Chinese paragraph collapsed into **one giant "sentence"** — and the sentence-cue highlight on Claude Code selected the whole block (observed live: a ~460-char Japanese buffer highlighted as `[0,464]` instead of the first sentence). The segmenter now also splits on CJK/fullwidth terminators `。！？．` directly (no trailing space required, like ConfigIntent's CJK summon boundary in 0.3.34); the CJK comma `、` is deliberately not a terminator. ASCII behaviour is byte-identical (the `gpt-5.4` / `e.g.` / URL-dot mid-token guard is unchanged), so the English sentence-cues bench is unaffected. Pinned by 3 CJK tests (ideographic `。`, comma-is-not-a-terminator, fullwidth `！`/`？`).

### Changed — chrome 0.2.23: rebuild on core 0.3.38

Version bump for the chrome extension to ship a fresh bundle baking in the core changes from this cycle (provider capability model, FluidBlank FILL/WIPE + MODE fixes, ConfigIntent language-invariant command boundary + parallel span, Anthropic prompt caching). No chrome `src/` changes — `manifest.json` + `package.json` bumped in lockstep so a reload in `chrome://extensions` is confirmable.

### Fixed — FluidBlank MODE field no longer corrupts the buffer or breaks identity-context binding (core 0.3.38)

The agentic suite caught two regressions from the FILL/WIPE `MODE` field (0.3.33):

- **Empty-ANSWER bleed → "MODE: WIPE" spliced into the buffer.** `parseFused`'s answer regex used `[\s\S]*?`, which crosses newlines. With the trailing `MODE:` line now in the output, an *empty* `ANSWER:` made the regex capture the next line — the literal `MODE: WIPE` — and splice it into the buffer, replacing the user's text. The answer capture is now single-line (`.*?`), matching the SPAN/SUMMON parsers: an empty answer parses to `null` and bails cleanly. Pinned by a regression test (`ANSWER:` empty + `MODE: WIPE` → no results).

- **MODE rules suppressed identity-context token emission.** The MODE-rules paragraph lived at the tail of `FUSED_SYSTEM_PROMPT`, i.e. *before* the identity/blank-context catalog (which is appended at assembly time). With the rules wedged between the examples and the catalog, the model stopped emitting an ANSWER for safe-mode identity lookups — `i work at _` returned nothing instead of `[COMPANY]` (agentic scenario 54). Fix: the rules are extracted to a `MODE_RULES` constant and appended **after** the catalog blocks, so the model reads the catalog right after the examples (as it did pre-0.3.33). Validated on cerebras: identity binding 4/4 (was 2/4), FILL/WIPE 6/6 (French/Spanish copulas correctly FILL), fluid-blank-ambient bench back to 176/176. The OUTPUT-FORMAT `MODE:` line is now self-contained (no dangling "see MODE RULES" reference).

Root cause both times: the fused prompt is sensitive to *where* an instruction sits relative to the per-call catalog, and the ambient bench has no identity-context cases so it never flagged it — the agentic harness did. End-to-end verified: scenarios 53 / 54 / 58 (identity-context), 09 (fluid-blank), 11 (copula), 102 (config-intent) all green on opencode.

### Performance — Anthropic prompt caching: ~90% cheaper input on cached system prompts (core 0.3.37)

Every OpenCues system prompt is static per session (the cerebras prefix-cache relies on this), but the **Anthropic** provider was sending `system` as a plain string — which Anthropic never caches. So anthropic-routed buckets (auditors / agent-rewrite default to Sonnet; any bucket a user points at Claude) re-billed the full system prompt on every call. `ANTHROPIC.buildRequest` now sends `system` as a content-block array with a single `cache_control: { type: 'ephemeral' }` breakpoint, so the static prefix is cached and subsequent calls within the 5-minute TTL bill the prefix at ~10% of input price. The per-call user message sits after the breakpoint and stays uncached (correct — it's the only varying part).

Measured (Sonnet, the ~3k-token fluid prompt, warm): input billing **3801 → 393 token-equiv (~90% cheaper)**, confirmed end-to-end through the production `buildProviderRequest` path (`cache_read_input_tokens=3787`, `input_tokens=11`). **This is a COST win, not a latency win** — at our prompt sizes the cached read doesn't change wall-clock (1720ms vs 1795ms, noise); it only cuts the bill. (Anthropic differs from cerebras here, where prefix caching *is* a 4× latency win.)

**Model-dependent and harmless when it doesn't engage:** Sonnet / Opus / Fable cache from ~1k tokens, so all our 3–3.8k-token prompts cache there; Haiku-4-5 (the anthropic default for cues/blanks) has an effective floor of ~4–5k tokens, so our prompts mostly *don't* cache on it — but an unmet `cache_control` is silently ignored (no error, normal price, no write premium), so the change is strictly safe everywhere. Pinned by provider unit tests (system is a one-block array with the ephemeral breakpoint; user message uncached). Follow-up (deferred): a two-block split so FluidBlank's appended identity/blank-context catalogs sit *after* the breakpoint, keeping the big stable prefix cached even when a catalog changes.

### Performance — ConfigIntent's two LLM calls no longer stack: ~473ms → ~290ms per config command (core 0.3.36)

The dedicated SUMMON span call (0.3.35) ran *after* the classifier, so a config command paid two serial round-trips. Two changes collapse that:

- **Regex-confident short-circuit.** `summonPhraseStart` can only ever *under*-find a sentence boundary (miss one in a script it can't segment); it never *hallucinates* one. So when it finds a boundary (`start > 0`), that boundary is authoritative — `resolveCommandSpanStart` returns it and makes **no summon call at all**. Punctuated-prior-content commands (`morning notes. voice mode off _`) now resolve the span for free: **1 LLM call, not 2**.
- **Concurrent span resolution.** When the model *is* needed (`start === 0` — bare command or non-punctuated prior content like Thai), the summon call is kicked off in `getCues` **concurrently with the classifier** instead of after it. The boundary is independent of the verdict (a function of buffer text, not of which setting was named), so the calls overlap. We only await it on a confirmed SETTING/PROVIDER verdict; a NONE cedes without awaiting, so the cede path is never slowed.

Measured on cerebras-gpt-oss (warm, unique buffer per iter): punctuated-prior **293ms / 1 call**, bare command **288ms / 2 calls (parallel)**, no-punct non-Latin prior **340ms / 2 calls** — all down from the ~473ms serial baseline (**−38% to −40%**). Tradeoff: a plausible-NONE buffer that lacks punctuation (e.g. an imperative rewrite `make it formal _`, which passes the keyword gate via "make") now fires one extra cheap background summon call that is discarded on the NONE cede (and typically aborted by the resolver on the next keystroke) — latency on the NONE path is unchanged; only a small, abortable background cost is added. Pinned by tests for the short-circuit (no summon call on punctuated prior), the concurrent path (Thai prior preserved), and non-suffix fallback.

> **Why the gate itself wasn't tightened (the other half of this investigation).** The plausible-NONE waste above comes from imperative rewrites passing ConfigIntent's `hasLikelyIntent` keyword gate (verbs like "make"/"change"/"set" overlap both settings commands and TransformBlank rewrites). Tightening the gate to filter them was prototyped and **rejected on data**: a deterministic replay over the fluid-config suite showed any "require a concrete settings token" gate drops real settings commands phrased as symptoms/synonyms (`disable user context _`, `don't move the highlight as I move around _`) — because distinguishing `make it formal _` (rewrite) from `make voice louder _` (setting) is a *semantic* judgement, i.e. exactly the classifier's job, not a lexical one. The replay also surfaced a **pre-existing latent bug**: the current "intentionally wide" gate already silently drops ~18% of the suite's real symptom-phrased commands (they never reach the classifier; the bench never caught it because it tests the classifier prompt directly, bypassing the gate). Fixing *that* means widening/removing the gate (more classifier calls), which is the opposite of a latency win — so the gate question is deferred to the unified-router exploration rather than patched piecemeal.

### Added — ConfigIntent command boundary is now language-invariant via a dedicated extraction call (core 0.3.35)

Follow-up to 0.3.34's regex floor: the truly **feature-agnostic** version. ConfigIntent now resolves the wipe boundary (where the settings/provider command starts, so prior user content is preserved) with a **second, single-purpose LLM call** (`SUMMON_PROMPT`) that returns the exact trailing command substring. The regex (`summonPhraseStart`, CJK-aware as of 0.3.34) stays as the deterministic floor.

Why a separate call rather than one more line on the classifier: 0.3.34 documented that adding a `SUMMON` field to the (English, heavily-tuned) classifier prompt regressed its INTENT recall ~85% → ~60% and the field was emitted on only ~10% of cases — a tuned single-purpose classifier can't carry a second job. A **dedicated** extraction prompt has no such conflict: a standalone probe scored **10/10 verbatim-suffix + boundary-correct** across English / Japanese / Korean / **Thai** / French / Chinese prior content, and an end-to-end `getCues` run on cerebras preserved Japanese and Thai notes correctly (`ฉันกำลังเขียนบันทึก turn on tips _` → keeps the Thai, wipes only `turn on tips _`). Thai is the proof point: it has no sentence punctuation or spaces, so **no regex floor can ever segment it** — only the model can.

Cost is contained: the call fires ONLY after the classifier confirms a SETTING/PROVIDER verdict (NONE cedes earlier), so it runs only on genuine config commands — rare, and a one-shot settings apply isn't latency-sensitive the way interactive typing is. Per-buffer memoised (`_summonStartCache`, bounded) so a double-fire / repeat trigger doesn't pay twice; honours the resolve `AbortSignal`; and on any failure (network, non-suffix output) falls back to the regex floor — model proposes the boundary, runtime validates the verbatim-suffix + a whole-buffer-over-include data-loss guard, regex is the safety net. **The classifier's `SYSTEM_PROMPT` is untouched, so classification accuracy is unaffected by construction.** Pinned by `parseSummonOutput` + `resolveSummonStart` unit tests (suffix wins / non-suffix → regex / data-loss guard / Thai rescue) and two source-level two-call `getCues` tests (Japanese span; non-suffix fallback).

### Fixed — ConfigIntent no longer nukes non-Latin prior content (core 0.3.34)

`summonPhraseStart` scopes what a fluid-config `_` settings command wipes — everything from the last sentence boundary before `_` to the end, so prior user content is preserved (`hii world. voice mode off _` keeps "hii world."). Its boundary regex only recognised ASCII terminators with a trailing space (`[.!?](?=\s)`), so a buffer whose prior content ends in a **CJK/fullwidth** stop — `こんにちは世界。voice mode off _` — found *no* boundary, returned 0, and **wiped the user's whole sentence** (the config-intent nuke landmine, language-dependent variant). The regex now also matches `。！？．` directly (these scripts don't put a space after the stop). The ASCII `(?=\s)` lookahead is unchanged, so the `gpt-5.4` model-version-dot guard still holds. Pinned by 4 CJK/fullwidth cases (Japanese/Korean `。`, fullwidth `！`/`？`).

> Note: the fuller "let the model emit the command span (`SUMMON`) so the boundary is language-invariant for *any* script" approach was prototyped and **rejected on evidence** — adding the field to the (English, heavily-tuned) classifier prompt regressed INTENT recall from ~85% → ~60% on the fluid-config bench and the model emitted the field on only ~10% of cases. The classifier prompt is too sensitive to carry a second job; the deterministic regex fix covers the realistic cases (the command itself is always English, only the prior content varies) without touching classification accuracy. The `TASK_TRIGGER_GUARD` / `LIKELY_INTENT_KEYWORDS` English keyword lists were left as-is for the same reason: both are guards *downstream* of English-keyword subsystems (transform-blank's triggers, the config-intent classifier), so removing them in isolation buys no real language-invariance.

### Changed — FluidBlank's FILL/WIPE choice is the model's call, with a deterministic data-loss floor (core 0.3.33)

The fluid-blank `_` lookup decides between FILL (substitute only `_`, keep the surrounding words) and WIPE (replace the whole lookup phrase). That choice used to be made entirely by `determineReplaceMode` — an **English-anchored regex** (`\b(?:is|are|was|were|am|be|equals)\b` / `=` / `:` / `?` before `_`). It only ever worked for English sentence shapes: a French "…est _" or Spanish "…es _" would fall through to WIPE and collapse the user's sentence to a bare value.

The fused LLM call now emits a third `MODE: FILL|WIPE` line (added to `FLUID_FUSED_SCHEMA` as a required enum, so strict-JSON providers always return it; the label-format path parses it when present). The model owns the **open content judgement** — "is this a terse query phrase, or a sentence with a gap?" — across any language. But FILL is also the non-destructive mode, so the runtime keeps a **deterministic data-loss floor** in the same category as the existing multi-paragraph WIPE guard:

- **heuristic FILL → FILL, authoritatively.** `determineReplaceMode` returns FILL only on high-confidence "sentence with a trailing gap" shapes (copula / equation / question adjacency, `_` mid-sentence). Those are exactly the cases where a WIPE would destroy text the user deliberately typed (`3 + 4 = _` must stay `3 + 4 = 7`, not collapse to `7`; `…? _` keeps the question). The model is WIPE-biased on these (bench-observed), so it may **not** escalate a heuristic-FILL into a destructive WIPE.
- **heuristic WIPE → defer to the model.** The regex found no (English) copula, so a non-English sentence it can't parse is rescued to FILL by the model; a genuine terse lookup stays WIPE.

Net: behaviour is **unchanged on every case the English anchor already got right** and strictly improved on non-English copula sentences — no regression, real language-invariance gain. Falls back to the pure heuristic when the model omits/garbles MODE (label-format path on a weak model). Validated: the `fluid-blank-ambient` bench holds at **176/176** on cerebras-gpt-oss (baseline parity — confirmed a naive first cut that put the MODE rules before the few-shot examples regressed two holdout cases incl. the prompt-injection defense, so the rule was moved to the prompt tail and trimmed); a FILL/WIPE probe across English/French/Spanish/German is 9/9 effective-correct on both the strict-JSON (groq) and label-format (cerebras) paths. Pinned by 6 unit tests (floor keeps FILL vs proposed WIPE; model rescues heuristic WIPE → FILL; deferral honours WIPE; two fallback-on-absent/garbled cases; multi-paragraph fail-safe).

### Changed — provider capability model replaces the per-param `provider === X` allowlists (core 0.3.32)

The interim point-gates from 0.3.29 (each provider-specific request field guarded by an inline `provider === 'cerebras'`-style check inside `buildOpenAIBody`) are replaced by a declarative **`ProviderCapabilities`** record on each `ProviderAdapter`. Each adapter declares the optional request fields it accepts — `seed`, `prediction`, `reasoningFormatHidden` (a `boolean | (model) => boolean` since cerebras only takes `reasoning_format: hidden` on `gpt-oss*`) — and `buildOpenAIBody` consults `opts.capabilities` instead of branching on the provider id. The capability values are byte-identical to the old allowlists, so behaviour is unchanged: GROQ `{ seed }`, OPENAI `{ seed, prediction }`, CEREBRAS `{ seed, prediction, reasoningFormatHidden: gpt-oss only }`, OPENROUTER / OPENCODE_ZEN `{}`. The win is structural — "forgot to gate a provider-specific param" is no longer possible: a new param is unsendable until an adapter opts in by declaring it, and a new provider starts with `{}` (sends nothing exotic) until proven. `capabilities` is threaded through all five `buildRequest` call sites via the dispatch ctx. Pinned by 3 unit tests (every adapter declares capabilities; `prediction` emitted iff declared; `reasoning_format` only on cerebras gpt-oss).

### Fixed — a fused `VERDICT: NONE` on a long buffer falls through to 3-pass instead of silently doing nothing (core 0.3.31)

The fused TransformBlank path makes the model emit the ENTIRE rewritten buffer (`FULL_REWRITE`) in one call. On a long buffer, cerebras gpt-oss-120b **intermittently returns `VERDICT: NONE`** under output/reasoning-budget pressure — even when there's a clear trailing imperative — so a chained `make it all make sense structurally _` on a ~1.3k-char buffer would silently do nothing. A fused NONE on a buffer over `FUSED_NONE_RETRY_FLOOR` (400 chars) is no longer trusted: it **falls through to 3-pass**, whose EXTRACT is a small separate call with no `FULL_REWRITE` budget pressure and re-classifies reliably. Short NONEs (genuine bare lookups like `capital of france _`) still cede to FluidBlank unchanged. Pinned by two unit tests (long-buffer falls through; short-buffer cedes). _Note: the original report was on Claude Code; the symptom reproduces as an intermittent cerebras behaviour and the fix is host-agnostic._

### Fixed — `prediction`-unsupported is now a fallback, not a hard failure (core 0.3.30)

The predicted-outputs `prediction` hint is a perf optimisation, not a correctness feature — but **cerebras gpt-oss-120b rejects it intermittently** mid-session with `property 'prediction' is unsupported`, which hard-failed the whole TransformBlank call (a user's `add a paragraph _` over a >200-char body would silently do nothing). `dispatchChat` now catches that specific rejection and **retries once without `prediction`** — a strict subset of the original request, guaranteed valid, can't recur. Scoped tightly: only fires when `prediction` was actually sent (TransformBlank's predicted-outputs path is the only setter) and the error matches both `prediction` + `unsupported`; every other call keeps its original single-attempt behaviour and unrelated errors still surface unchanged. `dispatchChat` is the single wire chokepoint for `prediction` (AgentRewrite's separate HTTP path never sends it), so the one site covers every case. Pinned by 3 unit tests (retry-and-succeed, no-retry-on-unrelated-error, no-retry-when-prediction-absent).

### Fixed — data-loss hardening: gate provider params, harden the splice site, kill the config-intent nuke (core 0.3.29 / runtime 0.3.21)

Follow-up to the `prediction`-param removal: an audit + the agentic suite found the **same unsafe shapes** elsewhere — an ungated param, a splice-site gap, and a whole-buffer nuke.

- **`seed` gated to providers that natively support it** (cerebras / groq / openai). Every source hardcodes `seed: 42` and it was emitted to *all* OpenAI-shape providers — the exact structural twin of the `prediction` bug. On an openrouter→anthropic route it would 400 (anthropic has no `seed`). Now never sent to a pass-through gateway. The variant-cache determinism that relies on seed only pins groq/cerebras, so the gate loses nothing.
- **AgentRewrite legacy inline path gates `reasoning_effort`** by model-name heuristic. That fallback (fires only when `@opencues/core` can't be required) builds a raw Groq-shaped body, bypassing every param gate; `reasoning_effort: 'low'` 400s on Groq's non-reasoning models (llama-\*). Now only sent to reasoning-capable models, matching the core heuristic.
- **FluidBlank WIPE splice re-validates against the live buffer.** WIPE replaces the whole lookup *phrase*, not just `_`; the splice now aborts if the live buffer drifted from the analyzed snapshot over that range (or the span runs past the buffer end) — the same guard its siblings TransformBlank and ConfigIntent already carry. Until now the WIPE path relied solely on the source emitting a parser-bounded span.
- **ConfigIntent no longer nukes the whole buffer.** It hardcoded `spanStart: 0` and spliced the settings selector/satellite pair over `[0, len)` — so `hii world. voice mode off _` lost "hii world." entirely. It now wipes only from the trailing **summon phrase** (`summonPhraseStart`: last sentence terminator / line break before `_`), preserving any prior user content. No prior content → behaviour unchanged. Pinned by `summonPhraseStart` unit tests + agentic scenario `102`.

(A `<10%`-length collapse guard for the fused TransformBlank path was considered and **rejected** — a length ratio can't distinguish a hallucinated collapse from a legitimate `summarize _` / `make it a title _`, and would silently drop valid transforms. Data-loss protection stays structural: three-way merge + the multi-paragraph WIPE fail-safe + this splice guard.)

> These point-gates are interim. The follow-up is a **provider capability model** — each adapter declares the request fields it accepts and the single body-builder consults it — so "forgot to gate a provider-specific param" becomes structurally impossible.

### Removed — `with <model>` per-call override + `anthropic-subscription` scalar (core 0.3.28 / runtime 0.3.20)

The `with <model>` per-call LLM override (e.g. `summarize with opus _`) is removed. It was English-anchored (keyed off the literal word `with`) and the source of a data-loss bug chain: a 2-paragraph prompt containing ordinary prose like *"…with a framework such as React…"* matched the article **"a"**, which the fuzzy resolver mapped to `anthropic/claude-opus-4-7` (a real model id starting with "a"). That spurious override flipped the call to openrouter/anthropic, where the cerebras-only `prediction` hint **400'd**, the transform failed, and the failure cascaded into a destructive FluidBlank WIPE — collapsing the two paragraphs into one. Rather than patch it with anchors + an English stopword list, the whole feature is removed; it will be reintroduced later as a **language-invariant** mechanism.

Removed: `packages/opencues-core/src/model-aliases.ts` (`detectModelOverride` / `stripModelOverride` / `applySubscriptionPreference` / `ModelOverride` / `COMMON_ALIASES`) + test; the override plumbing in FluidBlank / TransformBlank / ConfigIntent; the `apiKeys`-for-override config on both sources; the `modelOverride` event field; and the now-dead **`anthropic-subscription`** scalar (its only consumer was the override's subscription rewrite) from the feature registry, config-loader, and `CueContext`. The `claude-code-cli` provider stays — still selectable directly via `cues-llm-provider: claude-code-cli`.

### Fixed — two logical landmines hardened (so removal isn't the only safety net)

- **No destructive WIPE on a multi-paragraph buffer.** FluidBlank now refuses to WIPE when the buffer contains a paragraph break (`\n\n`) — that's the user's own content, not a bare lookup. This fires whenever a sibling source that should own the edit (TransformBlank for `add a paragraph _`, an agent rewrite) **errors out before claiming the slot** (provider 400, rate-limit, network blip) and FluidBlank would otherwise get the destructive turn. Pinned by fail-safe scenario tests (working-LLM and throwing-LLM cases).
- **`prediction` param gated to providers that support it** (cerebras + openai). The earlier "other providers silently ignore unknown fields" assumption was false for strict gateways (openrouter/anthropic 400 on it); it's now never sent to a provider that rejects it.

### Removed — bespoke `answer` + `prompt` built-in blanks; generalized to the user's provider (runtime 0.3.19)

The `answer` (factual lookup / translation) and `prompt` (improve prompt) built-in blanks were direct-to-Groq HTTP clients: they hardcoded the Groq endpoint + `openai/gpt-oss-120b` model and every host bootstrap fed them only a `GROQ_API_KEY`. They bypassed the provider/dispatch layer entirely, so they could **not** honour the user's configured provider (`llm-provider:` / `blanks-llm-*`) — a user on cerebras still hit Groq, and a user without a Groq key got nothing.

Both are removed. Their intents are already served — on the user's provider — by the generalized semantic-`_` sources:

- `answer _` / `what is the answer _` → **FluidBlank** meta-triggers (already the canonical path).
- `improve prompt _ <prompt>` → **TransformBlank** (validated on cerebras: produces equal-or-better improvements than the bespoke 2-pass pipeline).

Changes: deleted `blanks/{answer,prompt-improver}.ts` (+ tests) and their `BUILTIN_BLANKS` entries; removed the unused `llmConfig` field from `BuiltinBlankContext`; removed the dead `groqApiKey`/`llmConfig` wiring from all four host bootstraps + chrome's `createBlanks`; deleted `defaults/blanks/{answer,prompt}/`. **Migration**: `opencues seed-configs` now deletes orphaned `~/.cues/blanks/{answer,prompt}/` so the keywords fall through to the generalized sources instead of silently no-op'ing on a now-absent blank. Validated end-to-end on opencode via the agentic harness.

### Fix — "add a paragraph about X _" appends instead of wiping the buffer (core 0.3.27)

A trailing CREATE/ADD instruction over a real body (e.g. a long prompt followed by `add a paragraph about security _`) was misclassified by TransformBlank's `_` classifier: it ceded to FluidBlank, whose deterministic mode picker chose WIPE over `[0, text.length)` and **replaced the entire buffer** with the generated paragraph instead of appending it.

Root cause was in the classifier prompts, both of which conflated "add X" with a generative no-target request:

- `FUSED_SYSTEM` (the production path for cerebras + every non-groq provider) and `P1_EXTRACT_SYSTEM` (3-pass, groq) now carry an explicit **ADD / APPEND OVER A BODY** rule: when an add/write/include instruction follows or surrounds existing body text, that body IS the TARGET — emit `VERDICT: TRANSFORM` with the body preserved verbatim and the new content appended on a new paragraph (`\n\n`), never bail to NONE or treat it as generative. GENERATIVE is now scoped to "instruction + `_` with no other body".
- Added few-shot examples mirroring the failing case to both prompts, a fused APPLY rule (#10) for additions, and benchmark cases `trail-11` / `trail-12` pinning body-preserved append.

Both classifier prompts were fixed in the same change so the groq (3-pass) and cerebras/other (fused) paths can't drift.

> **Scope of this section**: only changes tied to an actual package version bump are listed. The project shipped many other features and fixes since 0.1.0 (sentence cues, auditors, agent-rewrite, ambient/user context, etc.) without bumping versions at the time — those landed in source but aren't formally versioned, so they're tracked in git, not here. From now on, the rule in `docs/architecture/versioning.md` § Discipline keeps changelog entries and version bumps shipping together.

### Feat — three semantic-_ surfaces enabled by default (runtime 0.3.18)

`fluid-config-mode`, `identity-context-mode`, and `blank-context-mode` now default to enabled. Concretely:

- `fluid-config-mode: on` (was `off`) — semantic `_` → settings-change classifier. Type `enable debug logging _`, `switch to cerebras _`, etc. and the matching OPENCUES.md scalar flips with a confirming satellite pair. One extra ~200-300ms LLM call per `_` (Cerebras prefix-cached, bench-validated 100% precision); routes ONLY to FEATURES registry scalars, never user blanks.
- `identity-context-mode: safe` (was `off`) — `~/.cues/IDENTITY.md` fields advertised to the fluid-blank LLM as identity-context tokens; runtime post-processor substitutes real values AFTER the response, so PII never reaches provider logs. Users who never created an IDENTITY.md see no behavioural diff (empty catalog).
- `blank-context-mode: safe` (was `off`) — script-backed blanks (stocks, weather, crypto, …) expose their current values as ambient tokens; a `_` lookup like `buy more apple if _` reaches AAPL without typing the `apple` keyword. Catalog of token names ships to the LLM; values substituted post-response.

The shipped `defaults/OPENCUES.md` carries the new values explicitly. Three rollout paths for existing users:

- `defaults/OPENCUES.md` shipped with explicit `identity-context-mode: safe` / `fluid-config-mode: on` / `blank-context-mode: safe`. Fresh installs get all three on out of the box.
- `DEFAULT_OPENCUES_STATE` in `config-loader.ts` now sets `identityContextMode: 'safe'` and `blankContextMode: 'safe'`. Existing users whose OPENCUES.md doesn't declare these typed-state scalars automatically pick up the new defaults — no file edit needed.
- `opencues seed-configs` (runs on every `opencues install`) self-heal-appends `fluid-config-mode: on` and `blank-context-mode: safe` to existing OPENCUES.md when the keys are absent. The runtime check for `fluid-config-mode` reads from the settings map (absent = off), so this self-heal is the only way existing users see the flipped fluid-config default; the appended block sits inside the frontmatter with a leading `# why` comment. Existing values are never overwritten — only absent keys are appended.

Feature-registry "(default)" annotations updated to reflect the new defaults; menu-cycle UI labels rotate `on (default)` / `safe (default)` accordingly.

### Fix — shell bridge `resetBufferState` wiring + clear static variant pool (runtime 0.3.17)

Two correctness bugs in the shell adapter / resolver reset path:

1. **Shell adapter never passed `resetBufferState` to `startEventBridge`.** The event bridge's `reset` command tried `this.bindings.resetBufferState?.()` — on OpenCode and chrome it's wired, on shell it was undefined → silent no-op. Any off-process bridge driver calling `reset` got a half-reset where ephemeral buffer state cleared but cached LLM rewrites kept returning. The bridge is documented as a runtime introspection surface (`integrations/shell/CLAUDE.md § Debugging`); shell was the cross-host outlier. Also relevant for shell's `oc-edit --keep-alive` mode where one Bun process spans multiple session boundaries.

2. **`Resolver.resetState()` didn't clear `TransformBlankSource`'s static variant pool.** The pool is `static` by design — chrome's universal-integration recreates source instances on every focused-target flip, and production wants cache survival across those rebuilds. But `Resolver.resetState()` is the *full* reset surface: a user who reloads OPENCUES.md mid-session (provider change, mode toggle) would still see stale rewrites for the prior provider/model until LRU eviction cycles them out.

Also extended `resetSharedBufferState` to accept optional `resolver` / `agentRewrite` / module-level reset hooks (`blankFill`, `markdownRender`, `dismissedBlanks`, `agentTaskState`) so the chain works end-to-end. New `resetState()` methods on `BlankFill`, `MarkdownRender`, `AgentRewrite` follow the same shape. All defensive — `resetSharedBufferState` uses `typeof === 'function'` guards so back-compat callers passing partial state objects still work.

User-visible repro for the variant-pool half: type a prompt with a transform trigger 3 times in a row, then edit OPENCUES.md to switch provider/model and reload. Pre-fix: the 4th identical trigger returns the prior provider's rewrite until LRU eviction. Post-fix: rebuilds correctly with the new provider's output.

### Fix — `cycleBlankStep` syncs `spanFillState.lastFilledText` (runtime 0.3.16)

Numeric-step blanks (`brightness`, `volume`, anything with `blankStep`) wiped the entire buffer the first time the user cycled Up/Down after auto-populate. Root cause: `cycleBlankStep` updated the DynDef + called `setText` but never refreshed `spanFillState.lastFilledText`. The next `_onTextChangeImpl` then saw `cleaned !== lastFilledText` (stale at the previous cycle's value), classified the cycle output as a user edit inside the clear-on-edit span, and ran `applyClearOnEdit` over the whole `"<keyword> <value>%"` pair — buffer ended empty.

`cycleSpanFill` (Path 0) already does this sync at the equivalent point — `cycleBlankStep` (Path 2) was the only cycling path missing it. Added the same `spanFillState.set(entry, newText)` call gated on the entry's index matching the cycle target.

User-visible repro: type `brightness _`. Pre-fix: auto-populates to `brightness 80%`, then Ctrl+Alt+Right + Ctrl+Alt+Up wipes the whole buffer instead of cycling to `brightness 90%`. Volume blank behaves identically. Post-fix: cycles correctly through 10% increments. Same shape for any user blank declaring `blankStep:` in its frontmatter.

### Revert — shape-driven blanks system (PRs #146, #155, #156) — keep on `dev/shape-system` for exploration

The shape system (PR #146) introduced `blankShapes:` as a declarative precision gate replacing `blankProximity:`. Migrated 14 blanks (stocks / volume / brightness / weather / crypto / countries / dictionary / answer / prompt / sentinel / claude-status / example / gh-issues / hackernews) and added shape-handling code paths in `blank-fill.ts`, `cycling.ts`, `dim-render.ts`, `navigation.ts`.

After 2 days of debugging across PRs #155, #156, and the abandoned #157, it became clear the system's coupling between match-intent, anchor-convention, and substitute-range was producing unpredictable cascading bugs. Each fix exposed a new code path that another shape author had implicitly relied on. Reverted on master to restore predictability while the system is re-explored on a dev branch.

What this revert restores:
- Every BLANK.md back to the `blankProximity:` + frontmatter shape it had pre-#146.
- `blank-fill.ts`'s `matchKeyword` / `matchBlankShape` removed; only proximity-based matching active.
- `cycling.ts` / `dim-render.ts` / `navigation.ts` shape-aware carve-outs removed.
- `config-loader.ts` parsing of `blankShapes:` removed (the field is now ignored if present in any user blank's frontmatter).

Where the work is preserved: `dev/shape-system` branch contains the full shape system + the #155 / #156 / #157-commit-1 / #157-commit-2 fixes for future exploration. Don't merge dev/shape-system to master until the design questions in CLAUDE.md § Shape conventions are resolved.

Bumps:
- `@opencues/runtime` 0.3.14 → 0.3.15 (forward bump signalling the revert; behaviour functionally back to 0.3.10).
- `@opencues/core` 0.3.24 → 0.3.25 (parallel signal for the parser revert).

### Fix (chrome) — popup Provider / Model dropdowns auto-populate on key entry; no longer gated behind Save

The popup's `Provider` and `Model` dropdowns only list providers whose API key has been verified (a live probe against each provider's `/models` endpoint). That verification previously ran only on popup `init()` (from already-saved keys) and inside the `Save` click handler. So a user pasting a *fresh* key saw `Provider` stuck on `— no verified keys —` until they clicked `Save` — which sits **below** the Provider/Model controls. The required action order (paste key → Save → pick provider → pick model → Save again) contradicted the top-to-bottom layout.

`integrations/chrome/src/popup/popup.ts` now wires a debounced (`600ms`) `input` listener on every provider-key field that re-runs the same `refreshProviderDropdown` verify-and-populate path used by `init()`/`Save`. Pasting or typing a valid key now populates Provider/Model automatically, so the layout reads in execution order and `Save` reverts to purely "persist my final choices". Skipped while `use ~/.cues/ config (chrome-host)` (defer mode) is on, since Provider/Model are ignored then. The stale `— no verified keys —` hover hint ("…and click save") was updated to reflect the automatic behaviour.

Typecheck clean; 9/9 `popup-roundtrip.test.ts` green.

Bumps:
- `@opencues/chrome` 0.2.20 → 0.2.21 (`manifest.json` + `package.json` in lockstep).
### Improvement — identity- + blank-context prompts: section-type vocabulary, `covers:` synonyms, specific-entity check (`@opencues/core` 0.3.46 → 0.3.47)

`renderIdentityContextCatalogForTransform` and `renderBlankContextCatalogForTransform` got two structural prompt revisions, validated by a new `tests/benchmarks/identity-order/` harness across 17 compose-style inputs × 2 message-orders × multiple seeds.

**Identity-context:** rule 6 swapped a flat genre table (email-sig / cover-letter / bio / ...) for a **section-type vocabulary** (BYLINE / SIGNATURE / CONTACT HEADER / ADDRESS BLOCK / PROFILE-LINK STRIP / ROLE-LINE / SUBJECT TITLE) plus a **document-shape decomposition** (10 doc types → which sections each one has). This generalises to inputs the old table never named (CV header, invoice header, podcast guest intro, portfolio about, conference talk abstract). Each catalog line now also carries a `(covers: synonyms)` suffix mirroring blank-context's pattern, so the model binds natural prose ("my role", "where I work", "DM me") back to the canonical token. Mean utilization on the 17-input bench rose from 79.4% baseline → 87.6% v8; conference-talk-abstract went 0% → 80% from the `covers:` hints alone.

**Blank-context:** rules 7 + 8 added — a **specific-entity check** ("when prose names Apple/Bitcoin/etc., scan the catalog before paraphrasing") and a **one-entity-per-token** constraint with WRONG/RIGHT negative examples. Fixes two production bugs the bench surfaced:

- *Apple-position email*: the model wrote prose about Apple without ever citing `[STOCK AAPL]`, burying the live value the user wanted visible. Now uses the token.
- *Market summary email*: the model used `[STOCK AAPL]` as an S&P 500 index level ("S&P 500 closed at [STOCK AAPL] points") and `[STOCK MSFT]` as an oil price. Both now write prose for unmapped values and use tokens only for their actual entities.

**Latency**: the longer stable prefix (1.8k → 5.5k bytes for the catalog block) actually **reduces TTFT** on cerebras gpt-oss-120b — measured −21.6% median, −766ms p95 across 50 calls. Bigger cached prefix + better-structured guidance shortens the reasoning loop. No regression elsewhere — 870 core + 1671 runtime + 177 vitest tests all pass.

The bench harness lives at `tests/benchmarks/identity-order/run.ts` (3-axis sweep, utilization + dups + missed-slots + raw-leak audit) and `latency-probe.ts` (baseline-vs-prod TTFT compare). Re-run before any future edit to either catalog's RULES block.

### Fix — provider-cycle resets sibling model to the resolved `defaultModel`, not the legacy `default` sentinel

When the user flipped a bucket provider without naming a model — either via the ConfigIntent natural-language path (`switch model to cerebras _`) or via the cycling satellite (Ctrl+Alt+↑ on `blanks-llm-provider`) — the apply path wrote the literal string `default` to the sibling `<bucket>-llm-model` scalar. That kept the (provider, model) pair valid at dispatch time (the runtime treats `default` as a fall-through sentinel) but tripped doctor's "inert sentinel" warning and confused users reading OPENCUES.md ("what is `default`? why is it stuck?").

The apply path now writes the **resolved defaultModel for the new provider** — explicit, self-explanatory, no sentinel concept on the surface. Two code sites converged:

- `packages/opencues-core/src/sources/config-intent-source.ts:981` — ConfigIntent's natural-language flip path.
- `packages/opencues-runtime/src/modules/cycling.ts:545,568` — satellite-cycle pair-invariant.

Both look up the provider adapter via `getProvider(verdict.provider)` and write `adapter.defaultModel` directly. When the cycled-to value is the `inherit` meta-provider (no adapter), both fall back to writing `'default'` — semantics match (both mean "fall through to global `llm-model:`").

The one semantic difference vs the old behaviour: if a user later hand-edits the global `llm-model:` to a different value, the per-bucket scalar no longer cascades — each bucket is independent once cycled. This is the expected mental model for most users (the bucket they explicitly flipped shouldn't silently change when they edit the global later); the sentinel was clever-but-wrong UX.

**Self-heal for existing files:** `packages/opencues-cli/src/commands/seed-configs.cjs` gained a new step (§ 3.2) that rewrites any pre-existing `<bucket>-llm-model: default` line to the bucket's effective-provider defaultModel on the next `opencues install`. Idempotent; skips when no provider is resolvable. So existing users get the clean state without having to hand-edit OPENCUES.md.

**Test updates:**
- `packages/opencues-runtime/src/modules/llm-config-cycling.scenarios.test.ts` — 4 scenarios + the full-cycle invariant updated to expect `getProvider(provider)?.defaultModel ?? 'default'` (the `?? 'default'` matches the `inherit` carve-out).
- `packages/opencues-core/src/sources/config-intent-source.test.ts` — `getCues provider hit (no model)` no longer expects the literal `default`; checks the second apply call's model value matches the new provider's known shape (e.g. `^claude-` for anthropic).

All 10 cycling scenarios green, 57/57 config-intent-source tests green, 1671/1671 runtime tests green, full pre-pr gates green.

Bumps:
- `@opencues/core` 0.3.23 → 0.3.24.
- `@opencues/runtime` 0.3.13 → 0.3.14.
- `opencues` (CLI) 0.2.4 → 0.2.5.

### Fix — `opencues doctor` false-positives on volume / brightness; `sandbox: off` now recognized as the F9 acknowledgement

Two related cleanups to the scripted-blank trust check in `opencues doctor`.

**1. User-only-fields block flipped the shipped-intact hash.** `opencues seed-configs` appends a `# ── User-only fields (preserved by shipped-md refresh) ──` divider + extras inside BLANK.md frontmatter to preserve hand-tweaked fields (`blankSuffix: %`, `blankProximity: 3`, etc.) across shipped-md refreshes. Doctor's `isShippedIntact` did a raw SHA-256 over the whole file, so any user carrying a vanilla install with even one preserved field (the typical case — `blankSuffix: %` on brightness) was misclassified as `userModified` and warned about. Fix: `stripUserOnlyFieldsBlock` peels the divider + everything below it within the frontmatter before hashing. A real edit ABOVE the divider still mismatches (defence-in-depth pinned by test).

**2. `sandbox: off` was not recognized as a trust signal.** The runtime's INFOSEC F9 contract (`blank-fill.ts:506-520`) requires authors to declare EITHER `sandbox: strict` (confined under bwrap/sandbox-exec) OR `sandbox: off` (explicit acknowledgement of host privileges). Doctor only recognised `strict` as audit-done, so a deliberately-declared `sandbox: off` blank still tripped the warn. Now mirrors the runtime contract — `sandbox: off` blanks count under a new `sandboxOff` bucket labelled `sandbox:off ack`. The warn fires only on script-backed blanks that declare neither AND don't hash-match a shipped artefact.

**Warning text also tightened.** The previous fix was `add \`sandbox: strict\` to the blank's BLANK.md frontmatter, or remove the blank if you don't trust it`. For blanks whose work fundamentally needs host privileges (volume needs system audio; brightness needs xrandr / hardware bridges), `strict` would break them. New text walks the user through the audit decision: confine if possible (`strict`), acknowledge if not (`off`), otherwise remove.

Tests: 5 new in `packages/opencues-cli/src/commands/doctor.scanblanks.test.cjs` covering the strip behaviour (divider present, divider absent, real edit-above-divider still flagged), the `sandbox: off` ack categorisation, and the still-warn case for un-acknowledged user-modified blanks. All 16 scanblanks tests + pre-pr gates green.

Bumps:
- `opencues` (CLI) 0.2.3 → 0.2.4.

### Feat — user-pack JS blanks on Bun hosts via Node subprocess

User-pack JS blanks (`impl: ./blank.js` in BLANK.md) ran fine on Node-based hosts (Claude Code, Gemini CLI, chrome-host) but failed to load on **Bun-based hosts** (opencode, shell) with `isolated-vm unavailable on this runtime`. Root cause: `isolated-vm` is a native C++ binding that links V8's ABI; Bun ships JavaScriptCore, so the `.node` file fails at module-import time with `undefined symbol: _ZN2v8...`. Built-in blanks + `.sh` blanks kept working; JS user-blanks (including the shipped `gh-issues` demo and any third-party pack) were silently disabled on opencode + shell.

**Fix:** the runtime now spawns a long-lived **Node subprocess** on Bun hosts when the in-process loader can't load `isolated-vm`. The subprocess owns the isolates and IPCs to the main process via newline-delimited JSON on stdin/stdout. Capability calls (`ctx.fetch` / `ctx.llm` / `ctx.storage`) round-trip back to the main process so the existing allow-list + quota + secret-binding enforcement (INFOSEC F4) runs unchanged. Same security boundary as the in-process loader; an isolated-vm escape still requires a CVE in the native binding regardless of which process it runs in.

Architecture is **two loaders, one capability surface**: `registry.ts` tries `node-loader.ts:loadUserBlank` first and falls back to `subprocess-loader.ts:loadUserBlankSubprocess` only when the error message matches `"isolated-vm unavailable"` AND the runner script is present at `~/.opencues/vendor/user-blank-runner.cjs`. Both loaders expose the same `LoadedUserBlank` shape so the rest of the runtime sees no difference.

**Lifecycle**: lazy-spawn on first dispatch (sessions that never hit a JS blank pay zero overhead); one subprocess per session, multiplexed across every blank; 5-minute idle reap with respawn on next dispatch (~50ms cold start); crash-resilient (subprocess dies → in-flight promises reject → next invoke spawns fresh). One Bun host today: opencode + shell share the vendor dir (`~/.opencues/vendor/user-blank-runner.cjs` + `node_modules/isolated-vm/`).

**Install**: `integrations/opencode/patches/setup.sh:install_user_blank_runner` and `integrations/shell/patches/setup.sh` copy the runner CJS + the already-built `isolated-vm` binding from the source workspace into the vendor dir. CC + Gemini-CLI integrations don't need this (in-process loader works); chrome's content-script Worker loader is structurally separate and is unaffected.

**Coverage**: 11 new tests in `packages/opencues-runtime/src/user-blanks/subprocess-loader.test.ts` — lifecycle (load/get/set/shutdown), capability bridge (fetch round-trip + allow-list block + capability gating when undeclared), multiplexing (two blanks in one runner), crash recovery (kill mid-invoke + respawn), secret subset filtering, ESM-rewrite parity. All 1667 existing runtime tests still green.

Architecture doc: `docs/architecture/user-blanks-subprocess.md`. Threat model in `security-audit.md` row #2 (INFOSEC F1) is unchanged — the subprocess fallback inherits the same V8-isolate security boundary as the in-process path.

Bumps:
- `@opencues/runtime` 0.3.12 → 0.3.13.

### Fix — macOS / Node 24 install blockers: isolated-vm Node-24 support + setup.sh BSD `cp` flattening

Two unrelated blockers stacked on a clean `pnpm exec opencues install claude-code` on macOS + Node 24. Both surfaced as install-time failures rather than silent runtime drift (the `validateFork` boot-smoke probe and the native-module probe both fired loudly), but together they made a fresh install impossible on the platform.

**1. `isolated-vm` couldn't build on Node 24.** The dependency was pinned `^5.0.4`. isolated-vm 5.0.4's `binding.gyp` compiles with `-std=c++17`, but Node 24's bundled V8 headers (`cppgc/.../conditional-stack-allocated.h`) use C++20 `concept` / `requires`, so the node-gyp fallback failed with `unknown type name 'concept'`. Forcing C++20 then surfaced deeper V8 API removals 5.0.4 doesn't track (`CopyablePersistentTraits`, `ObjectTemplate::SetAccessor`, non-virtual `PostTask`) — i.e. 5.0.4 is fundamentally Node-24-incompatible, not just a compiler-flag issue. Bumped to `^6.1.2` (engines `node >=22`), which ships a prebuilt darwin-arm64 binary for the Node 24 ABI and loads via `node-gyp-build` with no local toolchain. The JS API surface the runtime uses (`Isolate` / `createContextSync` / `Reference` / `ExternalCopy` / `compileScriptSync` / `derefInto`) is unchanged across the 5→6 major (that bump was purely engine support), so `node-loader.ts` needed no code change. **Note:** this raises the runtime's effective Node floor to 22 (no single isolated-vm version spans Node 18–25; Node 18 and 20 are both EOL as of June 2026).

**2. `setup.sh`'s core copy flattened `dist/sources/` on macOS.** `setup.sh` § 5 copies every `dist/*/` subdir into the installed fork's `@opencues/core/`. The `for sub in "$CUES_CORE"/dist/*/` glob yields paths with a **trailing slash** (`.../dist/sources/`), and `cp -r src/ dest/` diverges by platform: GNU cp (Linux) copies the directory (`core/sources/`), but BSD cp (macOS) copies the directory *contents* into `core/`, flattening `dist/sources/*.js` to `core/*.js`. The installed `core/index.js`'s `require("./sources/config-source")` then 404'd, the boot-smoke probe failed, and install aborted. This is the same BSD/GNU portability class the repo already wraps for `sed -i` / `stat -c` (root CLAUDE.md § Cross-platform shell scripts). Fix: strip the glob's trailing slash with `${sub%/}` so `cp -r` copies the directory on both platforms. CI runs on Linux (GNU cp), so this was invisible to the existing `check-cc-bundle-integrity.sh` gate — macOS-only.

**Node floor raised to 22.** Because no single isolated-vm version spans Node 18–25 and Node 18/20 are both EOL as of June 2026, the `engines.node` constraint is moved from `>=18` to `>=22` across the workspace (root, CLI, and all integrations), with an explicit `engines.node: ">=22"` added to `@opencues/runtime` where the native constraint originates. Bun-based hosts (opencode, shell) run their host process on Bun, not Node; the floor governs the Node-based install/CLI tooling and the runtime's `isolated-vm` JS-user-blank sandbox (which already degrades gracefully when the binding is absent).

Bumps:
- `@opencues/runtime` 0.3.9 → 0.3.10.
- `opencues` (CLI) 0.2.2 → 0.2.3.
- `@opencues/claude-code` 0.2.0 → 0.2.1.
- `@opencues/opencode` 0.2.0 → 0.2.1.
- `@opencues/gemini-cli` 0.2.0 → 0.2.1.
- `@opencues/shell` 0.2.0 → 0.2.1.
- `@opencues/chrome` 0.2.19 → 0.2.20 (manifest.json bumped in lockstep).

### Fix — Word-cue dispatch: in-progress-word gate no longer fires on unknown cursor (regression from #136)

PR #136 (`perf(core): skip in-progress trailing word from word-cue dispatch`) introduced a `findInProgressTrailingWord` gate that drops the trailing word from word-cue dispatch when the user is actively typing at end-of-buffer. The gate's three checks: (1) buffer non-empty, (2) buffer doesn't end in whitespace, (3) cursor is at end-of-buffer.

The original implementation got the third check wrong: it treated `cursor === undefined` as "assume end-of-buffer typing" — i.e. fired the gate when cursor was unknown. This silently dropped the only word in every CueContext that omitted `cursor`, which included almost every pre-existing core test (`output.test.ts` `ctx(text)` helper, `build-sources.providers.test.ts` literal contexts, etc.).

The CI billing block from 2026-06-13 22:33Z hid the breakage for ~5h across PRs #135–#140. With billing resolved, `build · typecheck · test` started failing in 28 places — every single one was the same root cause.

Fix: flip the unknown-cursor default to "don't skip". The gate now requires `cursor` to be **known AND at end-of-buffer**. Production hosts (CC v2.1, OC v1.14, gemini-cli, chrome, shell) always pass `cursor`, so the perf optimisation still fires on every real typing surface — only headless tests, agentic bare-injection, and any future host that doesn't expose cursor stop being silently penalised. `mkContextTyping` test helper updated to set `cursor: text.length` explicitly so PR #136's own gate-firing tests still exercise the optimisation.

Net: 870/879 core tests pass (was 842/879), 1656/1656 runtime tests pass, no behaviour change for production hosts.

Bumps:
- `@opencues/core` 0.3.20 → 0.3.21.

### Perf — Cerebras gzip request compression; FUSED_SYSTEM payloads shrink 68%, TransformBlank median −100ms / p95 −179ms

Cerebras's inference API accepts gzip-compressed request bodies via standard HTTP `Content-Encoding: gzip` ([docs](https://inference-docs.cerebras.ai/capabilities/payload-optimization)). `NodeHttpAdapter` now gzips every outbound request to `api.cerebras.ai` and adds the header. Gating lives in a single `GZIP_REQUEST_HOSTS` set; other providers stay on plain JSON.

**Effect** (N=20 trials per cell, gpt-oss-120b with hidden reasoning, June 2026):

| Source shape | Plain body | Gzip body | Reduction | Δ median | Δ p95 |
|---|---|---|---|---|---|
| TransformBlank fused (FUSED_SYSTEM) | 86,384 B | 27,174 B | **−68.5%** | **−100ms** | **−179ms** |
| FluidBlank fused (FUSED_SYSTEM) | 86,205 B | 27,074 B | −68.6% | −44ms | +80ms (noise) |
| ConfigIntent (small system) | 839 B | 490 B | −41.6% | +6ms | −53ms |
| Word-cue spelling | 1,144 B | 701 B | −38.7% | +1ms | **−332ms (−45%)** |
| AgentRewrite short doc | 1,471 B | 828 B | −43.7% | +9ms | **−152ms (−23%)** |
| AgentRewrite long doc | 2,625 B | 1,369 B | −47.8% | −22ms | +7ms |

Big payloads (FUSED_SYSTEM-bearing) hit −100ms median wins from wire-size reduction alone. Small payloads are median-neutral but their p95 tail tightens substantially — word-cue p95 −332ms is the standout since spelling fires on every typing pause.

**No size gate.** Bench evidence shows every shape is net-neutral or net-positive at p95.

**Accuracy preserved** — bench-validated:
- `tests/benchmarks/fluid-blank-ambient/fused-bench.ts`: **175/176** (target).
- `tests/benchmarks/transform-blank/prod-fused.ts`: within master's variance band (186-193).

Chrome path unchanged — chrome uses a throwing stub for `node-http-adapter` and routes through `FetchHttpAdapter`. No chrome bundle change.

Bench harnesses in `tests/benchmarks/{fluid-blank,transform-blank}/cerebras.ts` mirror the production wire shape so latency comparisons remain honest.

Documented in [`docs/architecture/cerebras.md` § Payload optimization](docs/architecture/cerebras.md#payload-optimization--gzip-request-compression).

Bumps:
- `@opencues/core` 0.3.19 → 0.3.20 (`node-http-adapter.js` gzip gate + bench harness mirror + cerebras.md extension).

### Perf — Cerebras `reasoning_format: "hidden"` on gpt-oss-120b; p95 tail drops 26-40% on short-output sources

Cerebras's `gpt-oss-120b` accepts a `reasoning_format` parameter ([docs](https://inference-docs.cerebras.ai/capabilities/reasoning)) that controls whether the reasoning trace appears in the response. Default is `"text_parsed"` (reasoning appears as a separate field); `"hidden"` suppresses the reasoning text while still generating + counting the tokens internally.

This PR sets `reasoning_format: "hidden"` for every cerebras dispatch to a gpt-oss-* model. Conditional in `buildOpenAIBody`: `opts.provider === 'cerebras'` AND `req.model` starts with `gpt-oss`. The bench harnesses (`tests/benchmarks/fluid-blank/cerebras.ts`) were updated to mirror so future benches measure what production runs.

**Effect** (N=20 trials per cell, June 2026):

| Source | default p95 | hidden p95 | Δ |
|---|---|---|---|
| FluidBlank | 579ms | 348ms | **−231ms (−40%)** |
| ConfigIntent | 603ms | 446ms | **−157ms (−26%)** |
| TransformBlank | 461ms | 470ms | +9ms (noise) |

The pattern is clean: hidden mode tightens p95 for **short-output sources** (FluidBlank, ConfigIntent — ~50-90 completion tokens) but is neutral for **long-output sources** (TransformBlank fused — ~240 completion tokens). Hypothesis: when content is small but the reasoning trace is heavy, transmission of the trace inflates worst-case latency; hidden mode skips that.

**Accuracy preserved** — bench-validated on both:
- `tests/benchmarks/fluid-blank-ambient/fused-bench.ts`: **175/176** (matches target).
- `tests/benchmarks/transform-blank/prod-fused.ts`: **187/231** (within master's variance band 186-193).
- 1656/1656 runtime tests pass.

Cost unchanged: reasoning tokens are still computed and counted in `usage.completion_tokens_details.reasoning_tokens`. Hidden mode only suppresses the **text** of the reasoning trace from the response payload.

Why no runtime toggle: the behavior change is semantic-neutral and the bench data is clear, so this is always-on for cerebras gpt-oss-120b. Documented in [`docs/architecture/cerebras.md` § Hidden reasoning format](docs/architecture/cerebras.md#hidden-reasoning-format-on-gpt-oss-120b).

Bumps:
- `@opencues/core` 0.3.18 → 0.3.19 (one conditional in `buildOpenAIBody` + bench harness mirror + cerebras.md extension).
- `@opencues/chrome` 0.2.18 → 0.2.19 (bundle bytes change; manifest + package.json in lockstep).

### Fix — `cerebras-model: zai-glm-4.7` now forwards `reasoning_effort: none` correctly; opt-in users get fast + accurate output instead of slow + 60% accuracy

Cerebras's `zai-glm-4.7` ([their docs](https://inference-docs.cerebras.ai/capabilities/reasoning)) has a **binary** reasoning knob in practice: `'none'` cleanly disables thinking (0 reasoning tokens, ~280ms median); any other value (`low` / `medium` / `high`) burns 500-700 reasoning tokens for no quality gain (~1000ms median).

Pre-PR the `isReasoningModelName` regex in `buildOpenAIBody` only matched `o\d|gpt-5|gpt-oss|qwen-3-thinking` — so `reasoning_effort` was silently dropped for `zai-glm-4.7` and the model defaulted to full thinking mode. Users opting in via `blanks-llm-model: zai-glm-4.7` got the slowest possible behaviour and (verified) a 60.8% / 94.9% drop on the fluid-blank-ambient bench (vs 99.4% on gpt-oss-120b).

This PR:
- Extends the regex to match `zai-glm` so the field reaches the wire.
- Adds `'cerebras:zai-glm-4.7': { max: 'none', off: 'none' }` to `MODEL_THINKING` — the only useful mode. Both `max-thinking: on` and `max-thinking: off` resolve to `reasoning_effort: none`.
- Updates the bench harnesses (`tests/benchmarks/fluid-blank/cerebras.ts` + `tests/benchmarks/transform-blank/cerebras.ts`) to use the same `none`-when-zai default so future bench runs measure what production runs.

**Head-to-head accuracy on cerebras** (gpt-oss-120b/medium vs zai-glm-4.7/none, June 2026):

| Bench | gpt-oss-120b/medium | zai-glm-4.7/none | Delta |
|---|---|---|---|
| fluid-blank standard 137 | 137/137 (100%) | 136/137 (99.3%) | −0.7pp |
| fluid-blank ambient in-prompt 18 | 17/18 (94.4%) | 17/18 (94.4%) | 0pp |
| fluid-blank ambient holdout 21 | 21/21 (100%) | 14/21 (66.7%) | **−33pp** |
| transform-blank prod-fused 231 | 186/231 (80.5%) | 182/231 (78.8%) | −1.7pp (within cerebras variance) |

zai is competitive on in-distribution cases (within 1pp) but loses substantially on the ambient holdout — novel patterns the prompt wasn't tuned against (ZIP codes, postcodes, callsigns, label-IS-question cases). **gpt-oss-120b stays the cerebras default.** This PR fixes the wiring so zai-glm-4.7 is a viable opt-in for users who want its ~50ms latency edge and don't care about the holdout accuracy gap.

Bumps:
- `@opencues/core` 0.3.17 → 0.3.18 (`isReasoningModelName` regex extension + `MODEL_THINKING` entry for `cerebras:zai-glm-4.7` + bench harness reasoning defaults + `docs/architecture/cerebras.md` extension).
- `@opencues/chrome` 0.2.17 → 0.2.18 (bundle bytes change; manifest + package.json in lockstep).

### Perf — Cerebras predicted outputs in TransformBlank fused path (200-char gate); iterative refinement on long bodies hits ~66% prediction acceptance

Cerebras's [Predicted Outputs](https://inference-docs.cerebras.ai/capabilities/predicted-outputs) is a client-side speculative-decoding hint: pre-supply your guess at the output, the server validates token-by-token against the actual generation, matching tokens come from cache (input rate billing), mismatches regenerate (output rate billing).

This PR enables it for TransformBlank's fused dispatch path, passing the input body (`extractText`) as the prediction. For typical TransformBlank flows (fix typos, make formal, shorten, rephrase, refine), the output preserves 50-95% of input byte content — cerebras's speculation accepts those tokens from prediction cache instead of regenerating. The dominant use case: iterative refinement of a long body (drafting an email, then refining it 4+ times) — each iteration has high acceptance because most bytes carry through.

**Length gate at 200 chars.** Empirically (June 2026 ad-hoc benches, `/tmp/cerebras-predicted-outputs-bench.mjs` + `/tmp/cerebras-reasoning-matrix.mjs`):
- < 170 completion tokens (≤ ~200 input chars): 0% acceptance — net +12ms overhead from rejected tokens
- ≥ 240 completion tokens (~ 400+ input chars): **66% acceptance**, ~150ms median latency win, **~750ms p95 tail reduction**

Gating at 200 chars avoids paying the rejected-token surcharge on short triggers (`draft an email _` has nothing to predict against) while capturing the win on the iteration case.

**zai-glm-4.7 evaluated and rejected.** Side-by-side reasoning matrix bench (`/tmp/cerebras-reasoning-matrix.mjs`) confirmed zai-glm-4.7 is 1.5-4× slower than gpt-oss-120b at every reasoning level — its `reasoning_effort` parameter has minimal effect (burns 500-700 reasoning tokens regardless). zai stays the slow path even with predicted outputs enabled; we keep gpt-oss-120b as the cerebras default. See [docs/architecture/cerebras.md § Predicted Outputs](docs/architecture/cerebras.md#predicted-outputs-speculative-decoding) for the full evaluation.

**Accuracy validation.** `tests/benchmarks/transform-blank/prod-fused.ts` on cerebras:
- Master baseline: 186-193/231 across runs (cerebras has ~7-case variance at temp=0/seed=42).
- Branch with predicted outputs (200-char gate): 186-188/231 — within variance, no measurable drift.
- 146/146 source-level unit tests pass.
- 1656/1656 runtime tests pass.

**Cost arithmetic** (approximate published cerebras rates, $0.10/M input, $0.60/M output): cache-hit case (40 accepted, 21 rejected, 240 completion total) costs 5% less than no-prediction; 0% acceptance case costs 6.5% more. The 200-char gate keeps us in the cache-hit regime.

**Observability.** Extended `UsageReport` with `acceptedPredictionTokens` + `rejectedPredictionTokens` + `predictionAcceptRate`. All three semantic-`_` sources surface predictions in the existing debug-level usage log:

```
TransformBlank: usage prompt=20347 cached=20096 (98.8%) completion=242 pred-accepted=40 pred-rejected=21 (acc rate 66%)
```

A `pred-accepted=0` line on a long input is a regression signal. Enable `debug-mode: on` to observe.

**What we deliberately don't apply prediction to:**
- FluidBlank — output is short and novel (~50 chars typical), speculation window doesn't engage
- ConfigIntent — output is short and the [PR135](https://github.com/opencues/opencues/pull/135) keyword gate already skips most NONE-bound calls before dispatch
- 3-pass TransformBlank (groq) — predicted outputs is cerebras-specific

Bumps:
- `@opencues/core` 0.3.16 → 0.3.17 (predicted outputs plumbing + `UsageReport` extension + log line update in 3 sources + docs/architecture/cerebras.md § Predicted Outputs).
- `@opencues/chrome` 0.2.16 → 0.2.17 (bundle bytes change; manifest + package.json in lockstep).

### Perf — Move stable catalog blocks into the SYSTEM message so cerebras prefix-cache hits cover them; add `cached_tokens` observability + `docs/architecture/cerebras.md`

Cerebras's [automatic prompt prefix caching](https://inference-docs.cerebras.ai/capabilities/prompt-caching) hits at 99.5% on our ~20k-token `FUSED_SYSTEM` / `FUSED_SYSTEM_PROMPT` constants on `gpt-oss-120b`, saving ~300-500ms of TTFT per dispatch. The cached prefix only extends as far as the stable bytes of the request — pre-PR the identity catalog (~250 tokens) and blank-context catalog (~350 tokens) lived in the user message where they don't cache.

This PR appends those stable catalogs to the SYSTEM message in both `TransformBlankSource` (fused path) and `FluidBlankSource` (fused path). Cached prefix grows by ~600 tokens; warm-call latency drops by ~37ms and cold-call by ~87ms in ad-hoc benchmarks (`/tmp/cerebras-restructure-bench.mjs`).

**Critical carve-out: ambient stays user-side.** The ambient block (chrome's per-field label / placeholder / page title) MUST stay in the user message. An earlier attempt to move ambient to system regressed `tests/benchmarks/fluid-blank-ambient/fused-bench.ts` from 175/176 → 166/176 — the LLM treats system-side ambient as global background and stops tightly binding it to the input (`paris _` in a Postcode field returned "London" instead of "SW1A 1AA"). Identity + blank-context catalogs ARE safe in system because they carry session-stable reference data, not per-call binding hints.

Accuracy validation:
- `tests/benchmarks/fluid-blank-ambient/fused-bench.ts` on cerebras: 175/176 (matches target).
- `tests/benchmarks/transform-blank/prod-fused.ts` on cerebras: 191-192/231 (master baseline 193/231; delta within LLM nondeterminism noise — cerebras shows ~1 case variance across runs even at temp=0, seed=42).
- 154 / 154 source-level unit tests pass.

Cache observability — new `UsageReport` callback on `dispatchChat`:
- `dispatchChat`'s `ctx` now accepts an optional `onUsage(u: UsageReport)` callback.
- `UsageReport` exposes `{ promptTokens, completionTokens, cachedTokens, cacheHitRate }`.
- The three semantic-`_` sources wire `onUsage` to `this.log` and emit a debug-level line when `cachedTokens > 0`:
  ```
  TransformBlank: usage prompt=20203 cached=20096 (99.5%) completion=181
  FluidBlank: usage prompt=20347 cached=20096 (98.8%) completion=42
  ConfigIntent: usage prompt=4823 cached=4736 (98.2%) completion=12
  ```
  Enable `debug-mode: on` in `~/.cues/OPENCUES.md` to see them in `/tmp/opencues.log`. A `cachedTokens=0` line is a regression signal — something in the prompt prefix is changing per-call when it shouldn't.

New `docs/architecture/cerebras.md` — the single landing page for every cerebras-specific feature OpenCues relies on (prefix caching today; reasoning effort, strict JSON, routing keys, future additions). CLAUDE.md trimmed to a short pointer.

`prompt_cache_key` deliberately not used: auto-cache is consistent in our benches; explicit keys risk shard hot-spotting at scale. Documented in [cerebras.md § `prompt_cache_key`](docs/architecture/cerebras.md#prompt_cache_key-we-dont-use-it).

Bumps:
- `@opencues/core` 0.3.15 → 0.3.16 (prompt restructure + `UsageReport` plumbing + cache-hit logging in all 3 semantic-`_` sources).
- `@opencues/chrome` 0.2.15 → 0.2.16 (bundle bytes change; manifest + package.json in lockstep).

### Perf — Skip in-progress trailing word from word-cue dispatch; sole-word typing now silent at the LLM layer

`RoutedWordSourceGroup` dispatches every cycleable word in the buffer to its routed child source. The shipped **spelling** source has `match: .*` so it claims every word — meaning when the user is typing a sentence, every keystroke pause triggers a spelling LLM call that includes the **partial** trailing word (e.g. `te` while typing `team`, `lawye` while typing `lawyer`). The LLM correctly returns no misspellings for those partial words, but still burns ~280ms round-trip per pause.

`findInProgressTrailingWord` is a cheap pre-filter (zero allocations beyond a regex test): when the buffer ends in a non-whitespace character AND the cursor (if known) sits at end-of-buffer, the trailing word is treated as in-progress and dropped from the dispatch bucket. Conservative gating so we don't regress mid-text editing:
- Trailing whitespace (`"cat sat rug "`) → last word complete, no skip.
- Cursor mid-text (`cursor < text.length`) → user is editing somewhere other than the trailing word, no skip.
- Cursor undefined (headless tests, agentic harness bare-injection mode) → assume end-of-buffer typing, gate fires.

Effect on the typing flow:
- **Sole-word typing** (`"hel"` mid-word pause) → empty bucket → zero LLM calls. Pre-PR: ~280ms per keystroke pause. Post-PR: instant.
- **Sentence typing** (`"the cat sat te"` mid-word pause) → bucket drops to `["the", "cat", "sat"]` → shorter LLM input, but call still fires (other words present).
- **After word completion** (`"the cat sat team "` with trailing space) → all 4 words dispatched, spelling normally surfaces.

Matches the timing of Word / Google Docs spell-checkers — corrections appear after word completion (space/punctuation typed), not mid-word. Less visual noise during typing.

Applies to ALL word-cue child sources (legal / medical / financial / spelling / tips), not just spelling. `contr` doesn't usefully match the `contract` keyword in a legal cue source until it's complete; skipping it is correct for every shipped cue.

Tests: 6 new gate tests (typing skip, whitespace passes through, cursor mid-text bails, sole-word short-circuits LLM entirely, cursor-at-end fires gate, `_` co-trigger handled). All 28 existing `RoutedWordSourceGroup` tests pass (existing `mkContext` helper updated to append trailing whitespace so the gate doesn't fire during routing/cache tests; new `mkContextTyping` helper exercises the typing-pause path).

Bumps:
- `@opencues/core` 0.3.14 → 0.3.15 (gate in `routed-word-source-group.ts`).
- `@opencues/chrome` 0.2.14 → 0.2.15 (bundle bytes change; manifest + package.json in lockstep).

### Perf — Likely-intent keyword gate skips ConfigIntent's LLM call when the buffer has zero settings/provider keywords

`ConfigIntentSource` fires on every `_` keystroke to classify whether the buffer is a settings change (`make fluid-blank off _`), a provider routing change (`use anthropic for cues _`), or NONE. The dominant case in production is NONE — prose like `draft an email _`, factual lookups like `capital of france _`, transform instructions like `make formal _`. Pre-PR4 every cold trigger burned a ~280ms classifier LLM call. PR4's variant cache eliminated the cost on repeat triggers; this PR eliminates it on the FIRST trigger when the buffer has zero plausible intent keywords.

`LIKELY_INTENT_KEYWORDS` is a static Set built at module load from:
- Every FEATURES scalar name (kebab-case AND space-separated — users say "voice mode" as often as "voice-mode")
- Every cyclable scalar value ≥ 3 chars (skipping ultra-common standalones like `on`/`off`/`auto` to avoid noise)
- Every provider id + display name (`anthropic`, `groq`, `cerebras`, …)
- Every bucket scope word (`cues`, `auditors`, `blanks`)
- Curated action verbs + symptom hints (`enable`, `disable`, `switch`, `turn`, `stop`, `start`, `set`, `use`, `change`, `make`, `show`, `hear`, `louder`, `noisy`, `navigate`, `tips`, `voice`, `debug`, …)
- Every `COMMON_ALIASES` key from `model-aliases.ts` (`opus`, `haiku`, `sonnet`, `fable`, `claude`, `nano`, `mini`, `flash`, `llama`, `gpt-oss`, `gpt-5`)

The gate runs after the existing `with <model>` override cede check and before the LLM dispatch. Multi-word/hyphenated keywords use substring match; single-word keywords use word-boundary regex (so `blank` doesn't match `blanket`). Measured at < 0.5ms on a 32-char buffer with the full keyword set.

Adding a feature to FEATURES, a provider to `PROVIDERS`, or a model alias to `COMMON_ALIASES` automatically extends this gate's coverage — no manual edit required for new features.

Conservative shape: false-positive (firing when not needed) is fine because the variant cache absorbs it on T2+. False-negative (skipping a real settings command) would silently break the feature, so the keyword set is intentionally wide. Curated verbs include some common-prose words like `make` and `change` — those will produce false positives on TransformBlank-style buffers like `make formal _`, but the cache makes those free after T1.

Language scope: ConfigIntent is inherently English-centric (the system prompt and the FEATURES registry are English). The pre-filter makes the existing language coverage explicit — it doesn't narrow what ConfigIntent recognises, only what it dispatches for. Provider names and model aliases are language-neutral and will still match for non-English buffers carrying those tokens.

Latency impact on prose triggers (factual lookups, transforms, general writing):
- Before: ~280ms classifier LLM call per cold trigger.
- After: < 0.5ms keyword scan, ceded result — no LLM call. Effectively free.

Bumps:
- `@opencues/core` 0.3.13 → 0.3.14 (new `hasLikelyIntent` gate + `LIKELY_INTENT_KEYWORDS` set in `config-intent-source.ts`).
- `@opencues/chrome` 0.2.13 → 0.2.14 (bundle bytes change; manifest + package.json in lockstep).

Tests: 14 new gate tests (6 cede cases on prose buffers, 8 fire cases on settings/provider commands). All 57 existing ConfigIntent tests pass — including symptom-based routing (`stop showing tip popups _` → `tips-mode: off`, `change volume because we hate quiet music _` → falls through to volume blank). All 1656 runtime tests pass. All 186 chrome tests pass.

### Perf — Variant cache across all three semantic-`_` sources; cache hits 10-20× faster end-to-end

Three sources fire on every `_` keystroke in fused-capable hosts: `TransformBlankSource` (whole-buffer rewrites), `FluidBlankSource` (factual lookups), and `ConfigIntentSource` (settings-change classifier). Each ran its own LLM round-trip on every trigger, even when the user was re-triggering the same buffer back-to-back (Down-arrow revert + re-trigger, Ctrl+Z undo-redo, A/B comparing different transforms, backspace-retype loops). On the resolver's "wait for all siblings" join, the slowest source's round-trip determined wall-clock — typically 300-800ms per trigger.

All three now keep a **static module-level variant pool** keyed on `(buffer + provider + model + mode + maxThinking + ambient/context shape)`. State machine matches across sources: first `POOL_SIZE` triggers are fresh (LLM dispatch + add to pool), next `POOL_SIZE` triggers cycle through the cached responses, then one fresh refresh evicts the oldest entry (FIFO). 75% hit rate after warmup. Pool size = 3 per key, 32 keys max per source.

Crucial design: the pool is **static**, not instance-scoped. Chrome's universal-integration profile rebuilds the resolver constantly (focus shifts between contenteditable / normal-input flip `supportsCycling()`; live config sync from the native-host triggers reloads), so an instance-scoped pool would empty between every trigger and never accumulate. Module-level state survives source instance reconstruction. Verified end-to-end on chrome (LinkedIn share composer) with a diagnostic showing `totalPoolKeys=1` persists across multiple Resolver rebuilds within the same trigger sequence.

Per-source key composition:
- **TransformBlank**: `text + provider + model + mode + maxThinking`. Mode-gated to `fused` only (3-pass produces splice-replacement output, not whole-buffer; caching it would corrupt buffer prefix/suffix on the whole-body replace path).
- **FluidBlank**: `text + provider + model + maxThinking + ambient(JSON-stringified) + identity-context-mode + blank-context-mode`. Ambient must be in the key because chrome's `paris _` in a Gmail compose field differs from an Airport-code field.
- **ConfigIntent**: `text + provider + model`. Classifier is mostly deterministic per input.

UX preserved (variation argument): in safe mode the post-processor substitutes identity/blank-context VALUES post-LLM, so cached responses carrying `[FIRST NAME]` tokens re-substitute against current values on each hit — the cache never serves a stale value. The "build → cycle → refresh" state machine means the user always gets a NEW fresh variant after cycling through the cached ones, preserving the "re-trigger rolls the dice" behaviour at 25% rate after warmup.

DynDef cycling exposes prior pool entries as `alternatives[2..N]` for TransformBlank so Up-arrow walks variant history instantly without re-paying.

End-to-end latency on chrome (LinkedIn, `draft an email _`, 6 consecutive triggers on identical buffer):

| Trigger | State | Wall-clock |
|---|---|---|
| T1 | fresh, pool=0 | 653ms |
| T2 | fresh, pool=1 | 603ms |
| T3 | fresh, pool=2 (pool fills) | 770ms |
| T4 | **cache hit** (all 3 sources) | **65ms** |
| T5 | **cache hit** | **38ms** |
| T6 | **cache hit** | **32ms** |

10-20× faster on cache hits. The remaining ~32-65ms is irreducible DOM mutation + event dispatch on chrome's managed editors.

Unit tests: 8 new variant cache tests (state machine, build→cycle→refresh, LRU eviction + recency, survives-source-rebuild), plus all 92 existing fluid-blank + 41 transform-blank + 8 config-intent tests pass.
Agentic: scenario `53-transform-blank-variant-cache` exercises the state machine end-to-end on a real CC instance with cerebras dispatch.

Bumps:
- `@opencues/core` 0.3.12 → 0.3.13 (variant cache pattern applied to 3 sources).
- `@opencues/chrome` 0.2.12 → 0.2.13 (bundle bytes change; manifest + package.json in lockstep).

### Perf — Word-cue result cache in RoutedWordSourceGroup; zero LLM round-trip on repeat dispatch

Every resolver pass on prose with no `_` fired the word-cue source group, which routes each word to a child source and dispatches one LLM call per source in parallel. The shipped **spelling** source has `match: .*` so it claims every word — meaning even neutral English prose (`"the cat sat on the mat"`) burned a ~280ms LLM round-trip to find zero misspellings. Every keystroke pause, every cursor move that re-triggered debounce, every backspace-retype loop: ~280ms of waste per resolve.

`RoutedWordSourceGroup` now keeps a per-child-source LRU cache of dispatch results, keyed on the EXACT sub-context text the child source receives (`0=cat 1=sat 2=the`). Caches both zero-result and positive responses. On hit, the cached sub-context-indexed results are remapped to the current bucket's original buffer indices — so the same word set in a different surrounding buffer still maps correctly.

Latency micro-bench (`tests/benchmarks/word-cue-cache/`, n=5, simulated 280ms spelling source):

| Variant | Wall-clock (median) | LLM calls |
|---|---|---|
| Cold (cache miss) | 280.7ms | 1 |
| Warm (identical buffer) | **0.0ms** | **0** |
| Saved | 280.7ms (100% of the LLM round-trip) | — |

Cache lifetime is tied to the source group instance: when the resolver rebuilds sources (OPENCUES.md flag flip, CUES.md edit, focus moves between cycling / non-cycling hosts), the group is reconstructed and the cache is GC'd with the old instance. No explicit invalidation logic needed. Mirrors the well-trodden `AgentRewrite._rewriteCache` shape (LRU via `Map` insertion order + delete-and-reinsert on hit). Bounded at 64 entries per child source.

When the cache hits: identical-buffer revisits (backspace-retype loops, cursor moves that re-fire debounce, copy-paste-back), and during linear typing whenever you add a non-word char (space, punctuation) that doesn't change the word set the LLM sees. When it misses: every fresh word added to the buffer pays the full round-trip once, then subsequent hits on that buffer state are free.

Bumps:
- `@opencues/core` 0.3.11 → 0.3.12 (`RoutedWordSourceGroup` adds cache layer).
- `@opencues/chrome` 0.2.9 → 0.2.10 (bundle bytes change; manifest + package.json in lockstep).

Runtime suite: 1656/1656 pass (unchanged). Core suite: 22/22 new cache tests pass (5 cases: zero-result caching, positive-result remapping, per-source isolation, LRU eviction, LRU recency). Agentic scenario `26-word-cue-routing` (existing) covers end-to-end dispatch — cache is transparent to its assertions.

### Perf — Pre-warm blank-context cache on background timer; first user `_` after launch hits warm cache

The lazy-refresh `BlankContextCache.snapshot()` populated only on prompt-build, so the FIRST `_` after launch still paid the full HTTP fan-out tax (~210ms even after #131's parallelisation). PR #131 was the wall-clock-of-slowest-source win; this is the eliminate-the-wait-entirely win.

`buildBlankContextProvider` (in `@opencues/runtime` boot-common.ts) now starts a self-rescheduling background timer that calls the same `runProvider` closure the user-triggered path uses. The timer fires once immediately on construction and then every `blank-context-prewarm-ms` (default `35000` — comfortably inside the 60s TTL), so user-triggered calls find every cache entry within TTL → 0 HTTP → returns within microseconds.

Latency micro-bench (`tests/benchmarks/blank-context-prewarm/run.ts`, 10 simulated 200ms HTTP sources):

| Variant | First-call wall-clock (median, n=5) | blank.get calls during user call |
|---|---|---|
| Baseline (prewarm: off) | 200.7ms | 10 |
| Prewarm: on (35000ms) | **0.1ms** | 0 |
| Saved | 200.6ms (100% of the HTTP tax) | — |

New tunable `blank-context-prewarm-ms` (cyclable: `off`/`15000`/`35000`/`60000`/`120000`). Hot-reloads on OPENCUES.md edit — each tick re-reads the setting, so changing the interval or flipping to `off`/back-on takes effect within one tick (or within 5s when re-enabling from `off`, via the recheck loop). The timer is silent when `blank-context-mode: off` (no HTTP regardless of the prewarm setting). `.unref()` on the timer keeps it from pinning Node alive in tests / short-lived hosts.

Quality risk: zero. The timer runs the SAME `runProvider` code path the user-triggered call uses; snapshot content is identical, only timing differs. A swallowed error in the background tick (network blip, provider 429) just means the next user call falls back to lazy refresh — pre-prewarm behaviour preserved as the backstop.

Bumps:
- `@opencues/core` 0.3.10 → 0.3.11 (FEATURES registry: new `blank-context-prewarm-ms` MENU_TUNABLES entry).
- `@opencues/runtime` 0.3.8 → 0.3.9 (timer wiring in `boot-common.ts`).

### Perf — Parallelise blank-context cache refresh; cold transform-blank/fluid-blank 2.3× faster

`BlankContextCache.snapshot()` refreshed catalog slots via a **sequential** `for ... await blank.get(slot)` loop. Every stale slot stalled on a real HTTP call — stocks → Finnhub, weather → OpenWeather, crypto → CoinGecko, hackernews → HN API, etc. On the default catalog (5 stocks from `context-slots` + N from `context-bind: portfolio` + 2 crypto + 1 weather + 1 HN + 1 claude-status) that's 10+ sequential round-trips firing on every cold transform-blank / fluid-blank call.

User bench 2026-06-13, `draft an email _` on cerebras gpt-oss-120b:

| Trial | Sequential (pre-fix) | Parallel (post-fix) | Saved |
|---|---|---|---|
| Cold 1 (fresh runtime) | 1810ms | **785ms** | 1025ms (57%) |
| Cold 2 (post-65s TTL expiry) | 1953ms | **811ms** | 1142ms (58%) |
| Warm (cache valid, no HTTP) | 926ms | 692ms | within noise — expected unchanged |

Direct HTTP probe confirmed the mechanism: 5 sequential Finnhub stock calls = 877ms; parallel = max(209ms) ≈ 210ms. The fanout is independent per slot — no cross-slot dependency — so the runtime can launch every refresh concurrently.

Fix: replace the sequential loop with `Promise.all(plan.map(async slot => ...))`. Per-slot `try/catch` preserved so a single network failure still produces `[STALE]` for that one slot without poisoning the rest of the snapshot. Cache eviction (`_evictIfOver`) moved to fire once after the fan-out lands, instead of inside the loop. Otherwise zero behaviour change — same TTL semantics, same `[STALE]` fallback, same cache shape.

The other obvious optimisation — skipping catalog injection entirely when the buffer text doesn't plausibly reference any token — is tracked as a follow-up (would cut another ~500ms on prose-only buffers by eliminating the LLM-side prompt + reasoning tax). This fix alone is a structurally tight one-file, ~30-line change with no behaviour difference visible to the user beyond "transform-blank substitutes feel snappier on cold runs."

`@opencues/runtime` 0.3.7 → 0.3.8.

### Fix — Blank keywords no longer dim until `_` is in proximity

`DimRender` painted dim ranges for every word in `configLoader.navigableWords` — which includes every shipped blank's `blankKeywords` list (91 distinct keywords across `volume`, `brightness`, `weather`, `forecast`, all stock tickers, all crypto symbols, lookup triggers like `what is`, `define`, country phrasings, etc.). The result was phantom dimming on bare prose: "the volume in this room was low" painted `volume`, "Apple announced earnings" painted `apple`, "i love bitcoin lately" painted `bitcoin`. The dim implied interactivity but the action only fires when `_` lands adjacent — so the user saw a hint with no payoff.

User report 2026-06-13: "should we make it that they don't turn gray... only 'Cues' or aspects which have been changed should turn gray."

Fix: new gate `DimRender.shouldGateBlankKeywordDim()` runs after the existing `navigable.has(lc)` check. A word that is:
- in `blanksByWord` (a blank keyword), AND
- NOT in `cueMap` (i.e. not also a word-cue or tip entry — those still dim because their dim IS the affordance of cyclable prose alternatives)

…is treated as a pure action trigger. It dims only when `_` is within `blankProximity` words of the keyword (matches the same proximity window that gates the action firing in `BlankFill`). Bare-prose mentions stay plain text.

Behaviour matrix (verified on CC harness with debug-mode dim trace):

| Phrase | Before | After |
|---|---|---|
| `the volume in this room` | `volume` dimmed | nothing dims ✓ |
| `Apple announced earnings` | `Apple` dimmed | nothing dims ✓ |
| `i love bitcoin lately` | `bitcoin` dimmed | nothing dims ✓ |
| `volume _` | `volume` + `_` dim | same — gate passes because `_` is within proximity 3 |
| `volume is _` | `volume` + `_` dim | same |
| `i have a contract` | dimmed via `legal` word-cue (host-gated) | same — word-cue arm is unaffected |
| Substituted span (post-`volume _` resolve to `volume 50%`) | dim covers keyword + `50%` | same — DynDef arm is unaffected |

Word-cues with real prose alternatives (legal, medical, financial, spelling, more-formal) keep the unconditional dim because their dim IS the offer. Tips-folder static entries (`tips-claude-code`, `tips-gemini-cli`, etc.) also keep the dim — they're informational hints without action.

Pinned by two new tests in `dim-render.test.ts`:
- `blank keyword without _ adjacent does NOT dim`
- `blank keyword WITH _ within proximity DOES dim`

`@opencues/runtime` 0.3.6 → 0.3.7.

### Fix — Substitute never auto-selects; user must manually navigate onto the span

`statusline.ts:buildPayload` used to elevate any live `spanFillState` to `active: true` even when `hlState` was inactive — the rationale was that BlankFill scenarios polled `active === true` to assert "the substitute completed." Those scenarios moved to `waitForEvent` on the `blank.substituted` event (the canonical completion signal); the one remaining poller now sits under `tests/agentic/scenarios/_flaky/`.

The lingering elevation conflicted with OpenCues' core UX rule: a region is only `active` once the user has *manually navigated onto it*. Without that, fluid-blank / transform-blank / agent-rewrite substitutes appeared "auto-selected" the moment they landed — statusline emitted the span's `blankTip` and chrome's floating statusbar showed it, even though the user hadn't moved onto the span. The elevation also returned BEFORE the `tipsMode === 'off'` check, so even `tips-mode: off` didn't suppress it.

Fix: remove the spanActive-without-hlState branch. When `hlState.active` is false, `buildPayload` now returns `{ active: false, agentTask }` unconditionally regardless of the spanFillState. Cycling (`Cycling.ts:181`) reads `spanFillState` directly so Up/Down cycling after manual navigation works exactly as before — only the *unactivated* "selected on substitute" signal is removed.

Behavioural matrix (verified end-to-end on CC harness, transform-blank substitute):

| State | `active` | `cueTip` | `cueBlank` | Visible? |
|---|---|---|---|---|
| Right after substitute (no nav) | `false` | `null` | `null` | Nothing — empty statusbar/statusline |
| After Ctrl+Alt+arrow onto span | `true` | `null` | `true` | Span highlighted; chrome statusbar hides per PR #128 |

Rules pinned by a new unit test (`statusline.test.ts`): `spanFillState set but hlState inactive → active=false`. Runtime suite: 1646 / 1646 pass.

`@opencues/runtime` 0.3.5 → 0.3.6.

### Fix — Statusline shows nothing for any word inside a fluid/transform/agent-rewrite substitute

`statusline.ts:buildPayload` used `this.dynDefs.get(wordIndex)` to find the DynDef at the highlighted word, then suppressed the tip when `def.blankName` was set (fluid-blank / transform-blank / agent-rewrite substitutes shouldn't surface tips because the substituted text was emitted by the LLM, not authored by the user). But `dynDefs.get(wordIndex)` only matches the **origin** word index of a multi-word span. When the highlight landed on word N>origin INSIDE a multi-word substitute, `def` came back undefined and the function fell through to the word-cue lookup at the bottom, which surfaced a tip for the individual LLM-emitted word.

User report 2026-06-13 (chrome): "tips when we highlight the modified text. It should not have any tips for now." → in chrome's floating statusbar this surfaced as `word (N/M) - tip` for a word the LLM picked, not the user.

Fix: when `dynDefs.get(wordIndex)` misses, fall back to `dynDefs.findSpanContaining(wordIndex)` so the origin def of any multi-word span containing this word is picked up. The existing `if (def?.blankName)` branch then suppresses the tip + sets `cueBlank: true` for the whole span uniformly. Chrome's runtime-statusbar handles `cueBlank: true && cueTip: null` → `combined === null` → `hide()`, so the floating div fully disappears for any navigation into a substitute (no word, no `(N/M)`, no tip).

CC behaviour unchanged in practice (cursor-navigate lands on origin word indices for multi-word DynDefs, so the original `dynDefs.get` already matched there) — the fix is structurally defensive for any host whose cursor model walks inside multi-word spans.

`@opencues/runtime` 0.3.4 → 0.3.5.

### Fix — Chrome narrows `supportsAgentRewrite: false` to LinkedIn share composer only

PR #125 disabled `supportsAgentRewrite` for **every** `.ql-editor` on the page, intending to scope to LinkedIn's share composer (where Delta+MutationObserver fights cause caret snap-back). But LinkedIn comment boxes are also Quill instances, so they got swept up — `agentically X _` in a LinkedIn comment was silently wiped instead of running. Symptom reported 2026-06-12.

The original caret-snap bug is specific to the share composer's lifecycle (post-creation modal + inline "Start a post" surface + legacy share-box widget). Comment boxes, messaging compose, and the article editor are also Quill but don't exhibit the same multi-tick storm. Narrowed the detection with a new `isLinkedInShareComposerQuill` predicate that requires both `.ql-editor` AND an ancestor matching one of:

- `.share-creation-state` — modal share composer wrapper
- `.share-box-feed-entry__form` — inline "Start a post" surface
- `.share-box` — broadest legacy class; covers older variants

If another Quill site reproduces the same caret-snap class of bug, add its detection marker to the predicate. Default-deny stays on the share composer where the structural problem is verified; everything else gets the feature back.

Chrome 0.2.7 → 0.2.8 (manifest + package lockstep).

### Feature — Per-target `supportsAgentRewrite` capability; chrome opts Quill out

After PR #122 (0.2.5 → 0.2.6) — the first attempt to fix LinkedIn's "cursor jumps on agent-rewrite tick" symptom by reapplying caret across more frames — failed in production, we walked through a sequence of further attempts each landing on a different theory: caret-color cosmetic hide, paragraph-level in-place mutation, line-level in-place mutation, hunk-level in-place mutation via the runtime's `wordDiff`, and a `pushText` flag to suppress an explicit cursor restore after a successful in-place write. Each was a structural improvement on its own — chrome ships them — but none fully fixed the user-visible bug. The remaining root cause: Quill's Delta-model selection doesn't sync from browser-set selections after a write. Even when we got the right characters into the right text nodes, Quill's internal cursor was still anchored at the wrong place, so every subsequent keystroke landed in the wrong location and broke the feature.

Final ship: a new optional adapter capability `supportsAgentRewrite?(): boolean` on `HostAdapter`. Chrome reports false when the focused target is a `.ql-editor`; true everywhere else. `AgentRewrite.tick` returns early when false; `Resolver` rewrites incoming `TASK_ARM` / `TASK_ADD` verdicts to a no-op that still trims the trigger phrase from the buffer (so users see the same visual feedback they'd get from a successful arm), but doesn't actually arm the task. `TASK_STOP` is still honored so a task armed in a different (supported) target can be disarmed after focus moves into a Quill composer. Inline single-substitution flows on the same Quill target — `translate to japanese _`, `weather _`, word-cues, transform-blank, fluid-blank — are unaffected because their cursor is computed deterministically from the substitute span; they don't round-trip through `getCursorOffset` and they only mutate one text node, which Quill's Delta-model selection-shift handles correctly.

Defaults to true when omitted, so CC / OC / gemini / shell / future hosts see zero behaviour change.

`@opencues/runtime` 0.3.2 → 0.3.3 (new capability on the adapter contract). Chrome 0.2.6 → 0.2.7 (manifest.json + package.json lockstep) — also keeps the in-place hunk fast path, the cursor-cache fallback in `readCursorOffset`, the `_diffPreservedCursor` flag, and the simplified `reapplyCursor` (sync + 1 RAF) from the iterations along the way; they're not load-bearing for the gate but they're structural net-positives for other write paths.

### Fix — LinkedIn Quill share composer: caret stays put across agent-rewrite ticks

`agentically <task> _` on LinkedIn's share composer caused the caret to jump to end-of-buffer on every debounce tick (~1500ms). The runtime's `pushText(text, cursor)` was already feeding chrome's boot a correctly-translated caret position via `AgentRewrite.translateCursor`, and chrome's handler did re-apply via `writeCursorOffset(cursor, true)` + one `requestAnimationFrame`. But LinkedIn's Quill SelectionObserver reconciles ONE frame after our first RAF and snaps the browser selection to Quill's internal model position (end of the last `execCommand('insertText')` in `replaceAllText`'s Quill fallback path). One RAF wasn't enough to outlast the reconcile.

Fix: extracted the cursor re-apply into a `reapplyCursor` helper that schedules sync + RAF + nested-RAF + `setTimeout(0)`. The nested-RAF lands after Quill's reconcile microtask; the `setTimeout(0)` tail catches the rare case where the reconcile slips past two frames. Idempotent on editors that don't fight (LinkedIn messaging composer, ProseMirror/Lexical) — the extra calls are no-ops there. `pushText` and `setCursorOffset` both route through the helper for consistency.

Chrome 0.2.5 → 0.2.6 (manifest.json + package.json lockstep).

### Fix — FluidBlank handles arithmetic + skips re-emitting already-present catalog tokens

Concrete reproducer: `nvda _ + apple _ = _` yielded `NVDA: $200.99 + AAPL: $293.77 = NVDA: $200.99 AAPL: $293.77` instead of the sum. Root cause: the FluidBlank `= _` invocation received the buffer alongside the stocks blank-context catalog ([STOCKS NVDA], [STOCKS AAPL], …). The catalog instructions push the LLM aggressively toward token-emission ("NEVER return an empty answer when ANY covers-term appears"). The LLM saw NVDA and AAPL in the buffer, matched them against the catalog, and dutifully emitted both tokens — the post-processor then substituted them back to the same prices already visible in the buffer. The `+ ... = _` arithmetic was never recognised.

Prompt changes split across two layers:

- **`FUSED_SYSTEM_PROMPT`** (`packages/opencues-core/src/sources/fluid-blank-source.ts`) — adds a new highest-priority rule "ARITHMETIC / COMPUTATION FIRST" with explicit currency-preserving examples (`NVDA: $200.99 + AAPL: $293.77 = _` → `$494.76`, `BTC: $112,400 - ETH: $4,250 = _` → `$108,150`). The CATALOG rule is demoted to #2 and gains an explicit "skip tokens whose values already appear verbatim in the input" exception.
- **`renderBlankContextCatalog`** (`packages/opencues-core/src/blank-context.ts`) — adds an "ALREADY-PRESENT EXCEPTION" paragraph inside the catalog block itself, with the same wording: when the catalog token's live value is already verbatim in the input, the user is operating on it (arithmetic, comparison, prose-rewrite) — do not re-emit. Overrides the "emit liberally" instructions above it. Caps the "NEVER return empty" rule with "AND the catalog token is NOT already-present" so it can't override the new exception.

The wider class this kills: any pattern where the user wants to OPERATE on a catalog value (sum two stocks, compare two prices, format a portfolio table, write prose about the current weather) was being short-circuited by the catalog instruction set. Now the catalog only offers the LLM info it doesn't already have.

`@opencues/core` 0.3.7 → 0.3.8.

Verification path: bench `tests/benchmarks/blank-context-recall/` should NOT regress on the "emit token when value is NOT yet present" cases. A bench-validated arithmetic suite is a follow-up; the prompt changes ship now because the production bug they fix is visible end-to-end on stocks today.

### Fix — BlankFill stops looping on substituted output that contains a registered keyword

Concrete shape: `nvda _` substitutes to `Nvidia NVDA: $200.42`. The substituted span contains `nvidia` (one of the stocks blank's keywords). On the NEXT text-change BlankFill scanned the new buffer, matched `nvidia` against the next `_` in the buffer, and re-fired the substitute. Buffer kept looping; sibling blanks (`+ apple _`, `= _`) never got a stable scan to fire against. Canonical reproducer: `nvda _ + apple _ = _` — both sibling blanks got stuck in loading frames (`apple •`, `= •`) because nvda's loop kept resetting state.

Fix: `BlankFill.matchKeyword` now consults `DynDefs.findSpanContaining` for each candidate keyword word index and skips matches that fall inside an already-substituted multi-word span. Single-word substitutions stay matchable (findSpanContaining only returns multi-word spans, mirroring how the broader runtime treats single-word DynDefs as the original-keyword-is-unchanged case).

`@opencues/runtime` 0.3.2 → 0.3.3.

Pinned by two new tests in `packages/opencues-runtime/src/modules/blank-fill.test.ts`:
- `skips keyword match inside an already-substituted multi-word span`
- `still matches keyword OUTSIDE substituted spans`

Known follow-up (not in this PR): when two unique-keyword blanks are typed simultaneously (`nvda _ + apple _`), the first to substitute shifts word indices; the second one's invoke completes but its substitute may not write back cleanly. Tracked separately — needs a more careful look at how concurrent invokes coordinate with span writes.
### Feature — `max-thinking` per-model reasoning budget

New OPENCUES.md scalar `max-thinking: on | off` (default `on`) that trades reasoning depth for speed. Each verified reasoning-capable model has a bench-tuned **ceiling** (Cerebras gpt-oss → `medium`, Groq / OpenAI gpt-oss + gpt-5 → `low`) and a reduced **off** level (Cerebras → `low`, the rest → `none`). `on` uses the ceiling — seeded to equal each provider's existing `defaultReasoningEffort`, so the default install is behaviourally unchanged. `off` is the opt-in "go faster, think less" mode.

- **`@opencues/core` (0.3.8 → 0.3.9)**:
  - New `model-thinking.ts` — the per-`(provider, model)` `{ max, off }` table + `resolveReasoningEffort` (explicit wins but clamps to the ceiling; otherwise toggle picks ceiling/reduced; `undefined` for non-reasoning providers — exactly the prior contract).
  - `buildOpenAIBody` (`llm-provider.ts`) now resolves `reasoning_effort` through `resolveReasoningEffort` instead of `req.reasoningEffort ?? defaultReasoningEffort`. The `maxThinking` flag rides the dispatch `ctx` that already flows to every `buildRequest` (ctx type widened on `buildRequest` / `dispatchChat` / `buildProviderRequest`); each OpenAI-compatible provider forwards `ctx.maxThinking`.
  - New `FEATURES` entry `max-thinking` → auto-extends the `_` settings menu + config-intent classifier with no further edits.
  - Sources (config-source / fluid-blank / transform-blank / sentence-cue) + `build-sources` thread `maxThinking` into their dispatch ctx. Config-intent is unaffected — it pins `low`.
- **`@opencues/runtime` (0.3.3 → 0.3.4)**:
  - `resolver.ts` reads `max-thinking` and passes `maxThinking` into `buildSourcesFromConfig`.
  - `boot-common.buildAgentLLMResolver` stamps `maxThinking` onto `ResolvedAgentLLM`; AgentRewrite forwards it into its dispatch ctx (auditors bucket). Legacy no-core-provider inline path is unaffected (documented gap).
  - `max-thinking` added to `feature-registry-alignment.test.ts`'s `SETTINGS_MAP_ONLY` (settings-map-only toggle, like the other `*-mode` scalars).
- **Not a spec change** — runtime reference-impl knob; `SPEC_VERSION` unchanged.
- Docs: `docs/features/max-thinking.md` (user-facing), `docs/architecture/max-thinking.md` (canonical). `defaults/OPENCUES.md` ships `max-thinking: on`.

### Fix — Multi-fork CC install fan-out + boot-smoke gate + per-fork drift advisory

PR #117 (Claude Fable 5) added `packages/opencues-core/src/providers/claude-cli-daemon.ts`. `integrations/claude-code/patches/setup.sh` hard-coded the dist subdirs it copied into each fork (`sources` only), so the new `providers/` subdir was silently dropped at install time. The installed bundle's `@opencues/core/model-aliases.js` then `require('./providers/claude-cli-daemon')` blew up at boot, the CC patch's outer try/catch swallowed the error, and every CC session came up with `__oc.failed=true` — no cues, no blanks, no log line, no install error. The install reported `✓ installed + validated`.

Three structural fixes, in order of how-much-it-could-have-prevented:

- **`integrations/claude-code/patches/setup.sh`** now recursively copies every subdir under `packages/opencues-core/dist/*/` instead of a hard-coded list. Adding a new dist subdir is now structurally safe — `cp` covers it.
- **`integrations/claude-code/bin/install.cjs` `validateFork()`** now runs a boot-smoke probe: `spawnSync(node, '-e', 'require(<spec>)')` from the fork's root for each path the CC patch's bootstrap actually requires (`@opencues/runtime`, `dist/adapters/cc/v2.1/boot.js`, `dist/src/blanks/index.js`, `dist/src/security/{spawn-sandbox,sandbox-runner}.js`, `dist/src/user-blanks/registry.js`). If any spec fails to load, the install refuses to ship the fork with a clear error pointing at the broken require + the setup.sh § 5 fix shape. This catches the failure class as a build error instead of as a silent runtime degradation.
- **`packages/opencues-runtime/adapters/cc/v2.1/boot.ts`** now calls `checkRuntimeDrift(adapter)` at boot. Every other host already got this via `buildSharedRuntime`; CC's hand-wired per-band boot was missing it since PR #47 landed. Direct launches of a stale CC fork — bypassing both `opencues run`'s CLI-side srcHash check AND the install fan-out — now surface a loud `warn` line in `/tmp/opencues.log` naming the fork + the fix command.

Plus the broader multi-fork awareness this pulled in:

- **`packages/opencues-cli/src/lib/version-markers.cjs`** — new `enumerateCCForks()` walks every `~/claude-code-cues*` dir on disk and returns the ones with a real CC binary, canonical first.
- **`integrations/claude-code/bin/install.cjs` `doInstall()`** — fans out across every detected fork by default. Each fork gets per-fork drift check + targeted rebuild only when stale. `--canonical-only` opts out. `--target` unchanged.
- **`packages/opencues-cli/src/commands/update.cjs`** — when host is at current-pin, the drift check now walks every CC fork before deciding "nothing to do". The fan-out into `rebuildHostInPlace` covers all forks via the installer's new logic.
- **`packages/opencues-cli/src/commands/doctor.cjs`** — extra CC forks are no longer "dev relics to delete." Each fork's drift status surfaces as a discrete row (stale → warn, missing marker → warn, fresh → info). Truly orphaned dirs (no CC binary at all) still surface as "safe to remove."
- **`integrations/claude-code/CLAUDE.md`** — iteration loop now reads "`opencues install claude-code` and the install fans out across every fork." The previous `OPENCUES_CC_TARGET=~/claude-code-cues-150/...` ritual is preserved as a CI / one-off-target escape hatch.

Concrete failure mode the boot-smoke gate prevents: any future PR adding a new `@opencues/runtime/dist/<subdir>/<file>.js` referenced by the patch's bootstrap, where setup.sh's copy step misses the file. Today only setup.sh copies are gated; if `integrations/{opencode,gemini-cli,shell}/patches/setup.sh` (which already use `cp -r dist/`) ever switch to a hard-coded list, the same bug class returns there. The CC smoke probe pattern can be lifted into a shared helper if needed.

`@opencues/runtime` 0.3.1 → 0.3.2 (boot-time drift advisory added to CC boot).
`opencues` (CLI) 0.2.1 → 0.2.2 (multi-fork fan-out + boot-smoke gate + per-fork drift in doctor).

### Feature — Claude Fable 5 support + global `anthropic-subscription` routing

Anthropic shipped **Claude Fable 5** (Mythos-class frontier model) on 2026-06-09. This change wires it across both provider paths AND adds a global control for how every anthropic-class `with <model>` override gets dispatched.

- **`@opencues/core` (0.3.6 → 0.3.7)** — Fable 5 wired into both provider adapters:
  - `llm-provider.ts:anthropic.knownModels` adds `claude-fable-5` (HTTP API path).
  - `llm-provider.ts:claude-code-cli.knownModels` adds `fable` + `claude-fable-5` (subscription path).
  - `providers/claude-cli-daemon.ts` gains a new `fable` model family with Opus-mirroring flag tuning (`CLAUDE_CODE_DISABLE_THINKING=1`, `MAX_THINKING_TOKENS=0`, no `--effort`) pending a real `tests/benchmarks/thinking-budget/` row.
  - `model-aliases.ts` `COMMON_ALIASES['fable']` resolves `with fable _` to `(anthropic, claude-fable-5)`. The CLI's `--model` does NOT alias-resolve short `fable` — only `opus/sonnet/haiku` are CLI-side aliases — so passing the full id `claude-fable-5` is what the daemon actually sends.
- **Subscription preference — every anthropic-class `with` (anthropic / claude / opus / sonnet / haiku / fable / any full id) auto-routes through the local `claude` CLI** when the binary is on PATH. New `applySubscriptionPreference` post-processor in `model-aliases.ts` rewrites every override whose resolved provider is `'anthropic'` to `'claude-code-cli'` (model string passes verbatim). Non-anthropic overrides (`with cerebras`, `with gemini`, `with gpt-oss`, …) are never touched.
  - `isClaudeCliAvailable()` helper in `providers/claude-cli-daemon.ts` caches a `which claude` probe per-process. Cold ~3-8 ms, warm ~0.002 ms.
  - `resolveOverride` in both `FluidBlankSource` and `TransformBlankSource` now short-circuits on `provider.transport === 'cli'` before its `apiKey` gate — the CLI provider auths via `claude /login`, not an env var, so the lookup would have rejected every subscription override otherwise. Caught by agentic scenarios 72 + 74 during validation.
- **`@opencues/runtime` (0.3.0 → 0.3.1)** — New `anthropic-subscription` global scalar in `OPENCUES.md`, registered in the FEATURES menu so `opencues settings _` cycles it. Three values:
  - **`prefer`** (default) — auto-route through CLI when available, silently fall back to HTTP API when missing.
  - **`only`** — billing safety. Always dispatch through CLI; the call FAILS at spawn time if the binary isn't on PATH (no silent API charge).
  - **`off`** — global opt-out; every anthropic-class override goes through the HTTP API regardless of CLI availability.
  - The scalar flows OpenCuesState → CueContext → applySubscriptionPreference, hot-reloads via ConfigLoader.
- **Per-call cost trade-off**. Subscription calls are bundled in the user's Pro/Max/Team/Enterprise plan but average 30–100% slower than the API (no streaming, higher TTFT variance). Bench across both paths confirmed Fable 5 at 4–10s end-to-end typical (vs sub-second for Haiku).
- **No runtime fallback yet**. If the CLI is installed but auth has expired or the model isn't on the user's subscription tier, the dispatch surfaces the CLI error rather than silently retrying through the API. Adding runtime fallback would need explicit error classification + a session-level "CLI is broken" cache; tracked as a follow-up.
- **Tests**: 32 unit tests in `model-aliases.test.ts` pin every routing cell (including the new `mode='off' | 'only'` branches and the non-anthropic-untouched invariant). Plus end-to-end agentic scenarios 72-75 in opencues-agentic, all green on opencode 1.14.17. Existing override scenarios 65-67 updated to pin `anthropic-subscription: off` so their assertions stay deterministic.
- **Docs**: `docs/architecture/model-override.md` + `docs/features/model-override.md` document the full coverage matrix, plumbing, cost trade-off, and "no runtime fallback" caveat. The feature-table at the top of `docs/features/model-override.md` now lists `fable` alongside opus/sonnet/haiku.

### Security — user-blank loader migrated to `isolated-vm` — F1 escape closed (INFOSEC F1)

**This is the structural fix for the F1 vm-sandbox escape.** Node's `vm.runInContext` is not a security boundary against adversarial JS — `Promise.constructor('return process')()` reaches the host realm, then `process.env` exposes every API key and `child_process.execSync` runs arbitrary commands. The June 2026 security review live-confirmed this against the shipped sandbox. The prior PR shipped a stopgap (load-time warn); this PR closes the gap structurally.

- **`@opencues/runtime` (0.2.8 → 0.3.0, minor bump — wire-format change for user-blank `ctx.fetch`)** — `node-loader.ts` rewritten to run user JS in a real V8 isolate via `isolated-vm`. The isolate is a fresh realm: its `Promise`, `URL`, `Date`, `Math`, `RegExp`, `Function` etc. are its OWN intrinsics, not the host's. The constructor-chain pivot lands you in the isolate's `Function` constructor, which resolves `process` against the isolate's empty global — undefined. New `isolated-vm@^5.0.4` runtime dependency.
- **Wire-format change**: `ctx.fetch` returns a plain Response-shape object `{ ok, status, statusText, headers, text, text(), json() }` instead of a real `Response`. Real Response objects can't cross the isolate boundary; the shim preserves `.text()` / `.json()` so existing user code continues working. **Breaking for** any third-party blank that uses `r.body`, `r.arrayBuffer()`, `r.blob()`, `r.headers.get()`, or that holds a streaming reference. **Not breaking for** any shipped blank (they're all TS classes via `BUILTIN_BLANKS`, not custom JS).
- **12 escape-pivot tests** in `node-loader.f1-escape.test.ts` pin the closure: Promise/Date/URL/Math/JSON/setTimeout `.constructor`, proto-walk via `Object.getPrototypeOf`, bracket-form obfuscation `Promise['cons'+'tructor']`, host-global reachability check (`process` / `require` / `Buffer` / `globalThis.process` all `undefined`). Plus a memory-bound sanity check and a dispose-lifecycle test.
- **Cost model** (Linux x64, Node 22, isolated-vm 5.0.4): per-isolate creation 5-10ms (one-time per blank load); per-context 1-2ms (reused across invocations); per-invocation 1-3ms cold, sub-ms warm. Prior loader was ~0.1ms per invocation with no security boundary — 10-30× slowdown is acceptable since blanks fire per `_` keystroke, not per-frame, and the result cache eliminates most repeat work.
- **`security-audit.md` row #2** flipped 🟡 → 🟢 (was just amber after the F1 stopgap; now structurally closed). `Recently resolved` log entry added. The Open Follow-up entry for the isolated-vm migration is removed since it's now landed.
- **`pnpm-workspace.yaml`** adds `isolated-vm` to `onlyBuiltDependencies` (native module — `prebuild-install` covers Linux/macOS/Windows on common Node versions, falls back to `node-gyp` compile).
- **Chrome content-script Worker path unchanged** — it's structurally separate (page-CSP-bounded, no Node `vm` involved). The chrome-host process (Node-based) uses the same isolated-vm path as CC/OC/Gemini.

This supersedes the F1 stopgap warn (PR #106). When both PRs land, the warn from PR #106 is no longer load-bearing.
### Security — `blankScript:` blanks must declare `sandbox:` explicitly (INFOSEC F9)

The F9 doctor PR (#102) surfaced the unconfined-by-default footgun: `bwrap` / `sandbox-exec` only wraps when a blank declares `sandbox: strict`, and most don't. This PR closes the gap structurally at the install-time gate.

- **`opencues review` (`packages/opencues-cli/src/commands/review.cjs`)** — refuses any pack with `blankScript:` lacking a `sandbox:` declaration as a hard error (sev: `error`, exit 1). `sandbox: off` produces a warn (explicit acknowledgement of full host privileges). `sandbox: strict` is clean. Any other value is a hard error. Authors can no longer ship a `blankScript:` blank without making an explicit confinement choice.
- **`@opencues/runtime` (0.2.8 → 0.2.9)** `BlankFill.maybeRunScripts` — one-time per-blank-name warn when a script-backed blank lacks `sandbox:` at runtime. Pre-F9 installs that slipped past review get a loud diagnostic in `/tmp/opencues.log` and the host's console: "BlankFill: X declares blankScript: without sandbox: — running UNCONFINED... INFOSEC F9". Per-blank dispatch refusal (rather than warn) deferred to v2 once the broader pack ecosystem migrates.
- **All shipped defaults already declare** explicit `sandbox:` (volume / brightness / opencues / sentinel → `sandbox: off`; example → `sandbox: strict`). No regression for shipped blanks.
- **Tests**: 5 new in `review.f9.test.cjs` cover every code path (missing → error; strict → clean; off → warn; bogus value → error; non-scripted → unaffected). 3 new in `blank-fill.f9-warn.test.ts` pin: warn fires once for missing-sandbox + spawn still happens (back-compat); strict + off both silent.
- **`security-audit.md` row #17** updated with the F9 install-time gate.
### Security — scripted blanks get a deny-by-default env, not the host's full process.env (INFOSEC F2)

Pre-fix, `BlankFill.maybeRunScripts` built the child env as `{ ...process.env, ...extras }`. Every scripted blank received every `*_API_KEY` the host had loaded — including ones the blank never declared in `secrets:`. A `blankScript:`-bearing pack could `curl` GROQ_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, FINNHUB_API_KEY etc. out without any frontmatter declaration. Per the F2 finding (live-confirmed against the chrome-host), the per-blank allow-list claim in `security-audit.md` rows #5/#7 only ever covered the JS-blank `ctx.secrets` path.

- **`@opencues/runtime` (0.2.8 → 0.2.9)** — new `security/safe-env.ts` exports `buildSafeScriptEnv(processEnv, declaredSecrets, extras)`. Base allow-list: `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `TZ`, `TMPDIR`, `SHELL`, `TERM`, `DISPLAY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `WSL_DISTRO_NAME`, `WSLENV` plus every `LC_*` locale variant. Provider keys land in the child env ONLY when the blank's frontmatter `secrets: [NAME]` declared them. Malicious declarations (`secrets: [LD_PRELOAD]`) are refused via `DANGEROUS_ENV_PATTERN` (`LD_*`, `DYLD_*`, `NODE_OPTIONS`, `PYTHONPATH`, `BASH_ENV`, `PROMPT_COMMAND`, …).
- **`@opencues/runtime` (`blank-fill.ts:369`)** — replaces the `{ ...process.env, ...extras }` spread with a `buildSafeScriptEnv` call. The `CUES_*` extras (model, apiUrl, prompts, …) are layered as the last step exactly as before.
- **`@opencues/chrome` (0.2.4 → 0.2.5)** — `host/host.cjs` mirrors the same allow-list (PATH/HOME/locale/desktop-integration) AND switches `filterMessageEnv` from a `CUES_*`-only allow-list to a `[A-Z_][A-Z0-9_]*` shape check + dangerous-name deny-list. The host now trusts the runtime's curated wire env (which already filtered to declared secrets) and applies the deny-list as a second line of defence. The `{ ...process.env, ...filterMessageEnv(msg.env) }` spread becomes `{ ...buildBaseHostEnv(), ...filterMessageEnv(msg.env) }` — process.env's `*_API_KEY` never reach the child.
- **11 new tests** in `safe-env.test.ts` cover: base allow-list passes; every common provider key dropped when undeclared; declared FINNHUB_API_KEY injected; LD_PRELOAD/DYLD_*/NODE_OPTIONS/PYTHONPATH unconditionally dropped; malicious `secrets: [LD_PRELOAD]` refused; declared secret can't shadow PATH; malformed name shapes (lowercase, dashes, leading digits) refused; CUES_* extras layer correctly; returns a new object; drift tests pin `DANGEROUS_ENV_PATTERN` shape + `SAFE_ENV_ALLOWLIST` excludes any `*_API_KEY`/`*_TOKEN`/`*_SECRET`/`*_PASSWORD`.
- **`security-audit.md`** rows #5/#7 already updated for F4. The F2 fix completes the closure: rows now describe both the JS-blank AND scripted-blank secret-containment paths.
### Security — dependency CVE sweep (INFOSEC DA1–DA7)

`pnpm audit` reported 7 advisories across the dep graph; this PR closes all of them. Mix of direct bumps and `pnpm-workspace.yaml` overrides (pnpm 10 moved the override location out of `package.json` — the old `pnpm.overrides` is silently ignored, which is the same trap CLAUDE.md called out for `onlyBuiltDependencies`).

- **DA1 vitest** `2.x → ^4.1.0` (root + opencues-runtime + chrome). [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp) — vitest UI dev server arbitrary file read + execute.
- **DA4 esbuild** `^0.21.x → ^0.25.0` (root + chrome). [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) — dev-server CORS bypass.
- **DA5 vite** override `6.4.3` (was 5.4.21 transitive). [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9) — optimized-dep `.map` path traversal. Vitest 4 also requires vite ≥ 6, so the pin satisfies two needs.
- **DA2 seroval** override `>=1.4.1` (transitive via solid-js in shell). Five separate advisories — RCE + prototype pollution + 3 DoS vectors — one fix.
- **DA3 immutable** override `>=3.8.3` (transitive via @types/draft-js + draft-js in chrome). [GHSA-wf6x-7x77-mvgw](https://github.com/advisories/GHSA-wf6x-7x77-mvgw) — prototype pollution.
- **DA6 file-type** override `>=21.3.1` (transitive via jimp in shell). [GHSA-5v7r-6r5c-r473](https://github.com/advisories/GHSA-5v7r-6r5c-r473) — DoS via malformed ASF input.
- **DA7 diff** override `>=8.0.3` (transitive via @opentui/core in shell). [GHSA-73rr-hh4g-fpgx](https://github.com/advisories/GHSA-73rr-hh4g-fpgx) — DoS in parsePatch / applyPatch.
- `pnpm-workspace.yaml` also picks up the migrated `onlyBuiltDependencies: [esbuild]` config that CLAUDE.md flagged as silently dropped under pnpm 10.

`pnpm audit` after: **No known vulnerabilities found.** All 1609 runtime tests + 176 chrome tests pass under vitest 4.1.8 (the 3 pre-vitest-4-compatibility chrome failures are fixed by the upgrade — same test files now green). Chrome bundle rebuilds cleanly under esbuild 0.25.
### Security — chrome native host: interpreter allow-list + writable-target allow-list (INFOSEC F3)

The chrome native-messaging host's `handleExec` and `handleWriteFile` previously enforced a path-only sandbox (everything must resolve under `CUE_ROOT`) but had no command-name / inline-code / target-basename restrictions. That made them a latent write-then-execute primitive: `write-file` could drop a `blanks/<x>/blank.js` that the user-blank registry would auto-load + execute on the next `fs.watch` tick, and `handleExec` accepted `bash -c '<arbitrary>'` because non-absolute args were returned unchanged by `sandboxArg`. Today the only thing that protects this is the manifest's absence of `externally_connectable` (closed defensively in F6); F3 closes the latent primitive structurally.

- **`@opencues/chrome` (0.2.4 → 0.2.5)** — new `host/host-validators.cjs` exports `INTERPRETER_ALLOWLIST` (`bash`, `sh`), `INLINE_CODE_FLAG_PATTERN` (refuses `-c`, `--command`, `-e`, `--eval`, `-p`, `--exec`, `--cmd`, `-i`, `--inline`, `--source`), `WRITABLE_BASENAMES` (`OPENCUES.md`, `IDENTITY.md`, `CUES.md`), `isWritableTarget`, and `validateExec`.
- **`host.cjs`** — `handleWriteFile` refuses any target whose basename isn't in `WRITABLE_BASENAMES`. `handleExec` refuses non-allow-listed interpreters, inline-code flags, and non-path-shaped `args[0]` when bash/sh is the interpreter. Absolute paths under `CUE_ROOT` (compiled-binary case) keep working through the prior `sandboxArg` realpath check.
- **19 tests** in `host-validators.test.cjs` covering: each writable basename accepted, arbitrary `.md` / script extensions refused, bash/sh + path passes, node/python3/curl refused, `bash -c` refused, `bash --command` refused, `bash -l` (flag as args[0]) refused, missing/empty inputs refused, and a structural drift test pinning both allow-lists.

Defence-in-depth pairs with F6 (sender-auth on the SW relay) — F6 closes the entry-point, F3 closes the primitive even when the entry is reachable.
### Security — `opencues doctor` surfaces the unconfined-blanks footgun (INFOSEC F9)

The OS sandbox (`bwrap` / `sandbox-exec`) was already checked, but it's only wired on `blankScript: sandbox: strict` — blanks that don't declare `sandbox: strict` run with the user's full filesystem + network privileges regardless of whether the OS confiner is installed. Most real-world scripted blanks don't opt in, so the "I have bwrap installed, I'm safe" assumption silently held nothing.

- **`opencues doctor`** — new `scanScriptedBlanks` helper iterates `~/.cues/blanks/` + `$OPENCUES_HOME/blanks/` and reports "X of Y scripted blanks declare `sandbox: strict`". When Y > X, prints a loud `bad` line + a `warn` finding naming up to 3 unwrapped blanks by folder name.
- **Status quo** — does NOT flip the default to strict (would break trusted/first-party blanks; that's the F9 follow-up that needs separate review).
- **4 new tests** in `doctor.scanblanks.test.cjs`: mixed strict/unstrict counted correctly, empty install returns zeros, built-in TS blanks (no `blankScript:`) are ignored, malformed frontmatter silently skipped.
### Security — chrome SW listeners authenticate sender + fetch proxy origin-allow-list (INFOSEC F6)

Every `chrome.runtime.onMessage` listener in `background.ts` previously ignored the `sender` arg and acted on the message unconditionally — safe today ONLY because the manifest declares no `externally_connectable`. That one manifest property was the entire authentication boundary for the `exec` / `write-file` / `user-blank-invoke` relays + the `opencues:fetch` open relay. If `externally_connectable` ever lands or a content-script bug exposes the relay, those become arbitrary-page-reachable.

- **`@opencues/chrome` (0.2.4 → 0.2.5)** — new `sw-auth.ts` module exports `isInternalSender(sender)` (`sender.id === chrome.runtime.id`) and `isFetchOriginAllowed(url)` (origin must be in `FETCH_ALLOWED_ORIGINS`, derived from manifest `host_permissions`). Every listener in `background.ts` now sender-auths before acting: refuses with a self-describing error response when the sender isn't internal.
- **Fetch-proxy origin allow-list** — `opencues:fetch` refuses any URL whose origin isn't in `host_permissions`. Closes the open-relay attack where any context that can post a message uses the SW as a CORS-bypassing fetcher to attacker-chosen hosts with attacker-chosen headers.
- **Drift tests** — `manifest-security.test.ts` (10 tests) asserts the manifest has NO `externally_connectable` (load-bearing property cannot regress) AND that `FETCH_ALLOWED_ORIGINS` matches `host_permissions` exactly (no drift between code and manifest). Plus 4 unit tests for `isFetchOriginAllowed` (allowed, refused-undeclared, refused-scheme-variant, refused-malformed) + 4 for `isInternalSender` (matching id, mismatched id, undefined, no-id).
### Security — `opencues review` catches the constructor-chain escape and string-concat obfuscation (INFOSEC F5)

The static review's denylist flagged `eval`, `new Function`, dynamic `import()`, and Node built-in names (`process`, `require`, `child_process`, `fs`, …). It did NOT flag `.constructor` chains — the actual vm-sandbox escape pivot. Worse, the scan stripped string literals first, so a payload hidden in `Promise['cons'+'tructor']('return process')()` had every telltale token stripped before the regex ran, and `opencues review` returned exit 0 on a working RCE PoC.

- **`opencues` CLI (`review.cjs`)** — six new hard-blocker patterns: `.constructor`, `["constructor"]` (bracket form), `Reflect`, `globalThis`, `__proto__`, `Object.{get,set}PrototypeOf`. Each refuses the pack with `sev: 'error'`, mirrors the AST rewriter's stance.
- **Dual scan** — the existing stripped-literals heuristic kept (low false-positive on JSDoc/URL strings), plus a new RAW-source scan for the escape patterns AND a string-concat-fragment detector (warn) that catches the `'cons'+'tructor'` / `'pro'+'cess'` style of hide-in-strings obfuscation.
- **11 new tests** in `review.test.cjs` cover: each escape pattern as a hard blocker, the string-concat obfuscation warn, clean code produces no errors, and the pre-existing `import()` + `eval` heuristics still fire.

INFOSEC F5 is a defence-in-depth ground gain — F1 is the structural fix (a real isolate). This raises the bar for the naive PoC and the obfuscated PoC without changing the runtime trust model.

### Security — `enforceSecretBindings` becomes a deny-by-default destination allow-list (INFOSEC F4)

The prior model was a substring scan: refuse the request if the literal secret VALUE appeared in URL/headers/body, otherwise allow. A malicious user-blank could trivially bypass it by encoding the secret (`btoa(k)`, hex, or fragmentation) before sending — the substring scan misses anything that doesn't share the literal bytes. Audit row #5/#6 listed residual "None" — that claim overstated the guarantee.

Two-layer guard now:

- **`@opencues/runtime` (0.2.8 → 0.2.9)** — `secret-leak-guard.ts:enforceSecretBindings` layer 1 (destination allow-list, primary): when ANY declared secret has a non-empty `secret-hosts.<NAME>` binding, EVERY outbound `ctx.fetch` host must be in the UNION of those bindings — payload content is irrelevant. Encoded exfil defeated structurally (the attacker can't reach `evil.com` regardless of how the value is encoded). Layer 2 (literal-value scan, secondary): within the allow-list, still scan URL/headers/body for bound secret values — catches multi-secret cross-talk (GROQ value sent to finnhub.io host is refused even though finnhub.io is in the union).
- **5 new tests** in `secret-leak-guard.test.ts` covering: base64-encoded exfil refused; fragmented-value exfil refused; non-secret-bearing fetch to non-binding host refused; multi-secret union honoured for non-secret fetch; layer-2 cross-secret scan within union. Plus 1 new test asserting the error message lists the union for diagnostics. 15 tests total.
- **`security-audit.md` row #5** updated to reflect two-layer guard and `Recently resolved` log entry added.

### Security — Gemini API key moved off URL query string into `x-goog-api-key` header (INFOSEC F8)

`?key=<apiKey>` puts secrets in URLs — they land in server/proxy access logs, browser history, the Referer header, and the chrome path also pipes them through the `opencues:fetch` SW proxy. Other providers correctly use `Authorization: Bearer` / `x-api-key` headers. Gemini's documented API contract accepts the key in either place, so the fix is mechanical: switch to `x-goog-api-key`.

- **`@opencues/core`** — `GEMINI` adapter `buildRequest` returns a URL with no query string and a `x-goog-api-key` header. Test updated to assert the URL contains neither `gem_test` nor `key=`, and the header carries the key.
- **`opencues check-keys` (CLI probe)** — same shape.
- **chrome popup boot-time key audit + popup probe** — same shape.

### Security — `opencues set-key` always tightens `~/.cues/.env` perms (INFOSEC F7)

`fs.writeFileSync({ mode: 0o600 })` only applies the mode when the file is newly created. An existing `~/.cues/.env` with looser perms (created by hand or copied with default umask) was rewritten in place without ever being chmod'd, so plaintext API keys could remain world/group-readable. The chrome host then loads this file into `process.env` and hands it to every scripted blank ([F2](docs/architecture/security-findings.md#f2)), so loose perms compounded that exposure.

- **`opencues` CLI (`set-key`)** — always `chmod 0o600` the file and `0o700` the parent dir after writing, regardless of whether the file pre-existed. Warns when the prior mode was broader than `0600` so users know their key was previously readable.
- Three regression tests in `set-key.test.cjs`: create-from-scratch lands at 0600/0700; pre-existing 0644 file gets tightened; pre-existing 0640 file gets tightened. Existing key lines preserved across the rewrite.

### Added — per-call `with <model>` LLM dispatch override for fluid-blank and transform-blank

Adds a `with <name>` token anywhere in the buffer before `_` (`make formal X with opus _`, `atomic number of oxygen with cerebras _`) to flip the dispatch target for ONE call without writing any scalar to disk. The next `_` keystroke without `with X` goes back to the configured bucket. Five-tier token resolution: common aliases (opus / haiku / sonnet / nano / mini / flash / gpt-oss / llama / claude / anthropic / cerebras / groq / openai / gemini / openrouter), provider id, exact model name, prefix in any `knownModels`, substring fallback. Always on — no scalar gates it.

- **`@opencues/core` (0.3.4 → 0.3.5)** — new `model-aliases.ts` module with `detectModelOverride` + `resolveAlias` + `stripModelOverride`. 21 unit tests in `model-aliases.test.ts` pin token resolution, last-match-wins tie-break, regex word-boundary (`without` doesn't match), and strip behaviour.
- **`@opencues/core` (0.3.4 → 0.3.5)** — `FluidBlankSource` and `TransformBlankSource` constructors gain an optional `apiKeys: Readonly<Record<string, string | undefined>>` field (keyed by `envKeyName` — matches `resolveLLM` at `llm-provider.ts:1817`). At the top of `getCues`, each source detects the override, resolves it to a (provider, model, apiKey) target, and dispatches THAT call through it. FluidBlank threads override args explicitly; TransformBlank stores them on a private `_currentOverride` field cleared in a `finally` block (the field pattern is safe under the resolver's one-getCues-per-generation contract + sibling-abort).
- **`@opencues/core` (0.3.4 → 0.3.5)** — `ConfigIntentSource.getCues` cedes synchronously when `detectModelOverride` matches. Without this, `make formal with opus _` was reliably misclassified as `cues-llm-provider: anthropic:claude-opus-4-7` and written to disk. The cede prevents the misfire AND saves the classifier LLM round-trip on inputs ConfigIntent shouldn't claim. The settings-flip syntax (`change to opus _`, `switch to cerebras _`) doesn't contain `with` — the cede doesn't fire — the classifier runs normally.
- **`@opencues/core` (0.3.4 → 0.3.5)** — `fluid-blank.started` and `transform-blank.started` events grow an optional `modelOverride: { provider, model, token }` field for harness assertions. Only set when the override resolved successfully (matches AND apiKey available).
- **Strip + WIPE handling** — `with <token>` is removed from the LLM-bound prompt so the model never sees the override hint. For FluidBlank WIPE mode, span is forced to `[0, context.text.length)` when the override is active, so the token wipes from the buffer along with the lookup phrase. (FILL mode trade-off: `with <token>` lingers when the buffer matches the copula/equation/question shape — partial remapping from stripped-offsets to original-offsets is a v2 follow-up.)
- **`tests/agentic/scenarios/` 65-71** — seven JSON scenarios covering the happy path (fluid-blank + transform-blank), ConfigIntent synchronous cede, unknown-token cede, multi-`with` last-match-wins, `without` regex word-boundary, and the regression guard that `change to <provider> _` still fires fluid-config.

Full design + threat model: `docs/architecture/model-override.md`. User-facing summary: `docs/features/model-override.md`.

### Fixed — fluid-config `change to opus _` / `switch to cerebras _` latency (7–10× faster steady-state)

Two stacked perf wins in the same path. Wallclock for `change to opus _` dropped from 1.8–4.3s to ~270ms (warm); `switch to cerebras _` from 2.2s to ~280–370ms.

- **`@opencues/core` (0.3.3 → 0.3.4)** — `CueResolver.resolve()`'s parallel branch now creates one `AbortController` per source (chained off `context.signal`). When a higher-priority source emits a *whole-buffer claim* (`spanStart === 0 && spanEnd >= text.length` — the signature ConfigIntent + selector-satellite blanks + TransformBlank-rewrite use), strictly-lower-priority in-flight siblings are aborted. Their results would have been wiped by the splice anyway; aborting saves the LLM round-trip. Before this, FluidBlank + TransformBlank dispatched to the blanks bucket (Claude Opus in the reported repro) ran to completion while ConfigIntent on Cerebras had already produced the winning verdict — the resolver waited for the slowest sibling. Closes the in-batch-cancellation follow-up the existing comment at `resolver.ts:96–100` named (#76 was scoped to the supersede / generation-roll case only). Three new scenario tests in `resolver.test.ts` pin the abort fires on whole-buffer claim, does NOT fire on point-wise claim, and that the outer context signal cascades.
- **`@opencues/core` (0.3.3 → 0.3.4)** — `ConfigIntentSource.callLLM` now forces `reasoningEffort: 'low'` (was inheriting the cerebras provider default `medium`). The classifier output is 3 short lines; medium reasoning added 700–1500ms with zero accuracy gain. The fluid-config bench (`tests/benchmarks/fluid-config/`) already runs at `low` and held 100% precision / 90–100% holdout recall across 5 providers — re-running the bench was not required for this change (no prompt edit), but the cap aligns the runtime with the bench-validated configuration. Mirrors FluidBlank's same-rationale floor at `fluid-blank-source.ts:995`.

### Fixed — chrome LinkedIn messaging composer Send button stays disabled after transform-blank

LinkedIn's messaging composer (`<div class="msg-form__contenteditable">`) gates its Send button on React state that only flips when the editor's input pipeline observes content. The previous fallthrough hit the generic-CE branch (`execCommand('insertHTML')` with `<div>` blocks), which lands the DOM mutation but doesn't trip the React state — text appears in the box but Send stays disabled, as if the placeholder was still active. Distinct from the LinkedIn *share* composer (Quill), which already had a working path (#91).

- **`@opencues/chrome` (0.2.3 → 0.2.4)** — new `isLinkedInMessaging` detector + a new branch in `replaceAllText` that mirrors the proven Quill fallback: Range-API select-all + per-line `execCommand('insertText')` + `execCommand('insertParagraph')` between. These fire `inputType: "insertText"` / `"insertParagraph"` events matching real typing, so LinkedIn's React listener catches them and updates the state.
- **Trade-off** — multiple undo entries (one per execCommand) on LinkedIn messaging vs the single-entry contract other sites carry. Acceptable for now; the alternative is the current "can't send" state, which is strictly worse. Single-entry path would require finding LinkedIn's private editor instance.

### Added — chrome Quill write path for LinkedIn share composer

LinkedIn's share composer ships a Quill build whose private `__quill` instance is renamed in their bundle, so the editor-API path (`editor.setText`) we use elsewhere isn't reachable. Generic `execCommand('insertHTML')` was reverted within a microtask by Quill's MutationObserver — substitutions appeared briefly then disappeared. Three iterations were needed to converge on a path that holds: paragraph-break shape (`<p>` for `\n\n+`, `<br>` for `\n`), lazy `__quill` re-attach attempt before each call, earlier activation in the write-path ladder. Companion paragraph-break shape fix in the runtime's managed-editor `replaceAllText` emit (split on `\n\n+` for paragraph breaks, inline `<br>` for soft breaks).

- **`@opencues/chrome` (0.2.2 → 0.2.3)** — adds `isQuillEditor` + a Quill branch in `replaceAllText`: tries `quill.clipboard.dangerouslyPasteHTML(html, 'user')` first, then `quill.setText(condensed, 'user')`, then a `selectNodeContents` range + per-line `execCommand('insertText')` + `insertParagraph` fallback when `__quill` isn't reachable. Manifest.json + package.json bumped in lockstep (per CLAUDE.md § "Chrome integration — bump manifest.json AND package.json in lockstep") — prior drift (0.2.1 manifest stuck while package.json moved to 0.2.2 across 5 PRs) was the trigger to formalise this rule.
- **Companion runtime fix** — `replaceAllText`'s managed-editor block emit now splits on `\n\n+` for paragraph breaks and uses inline `<br>` for soft breaks within a paragraph. Previously emitted one block per `\n`, which on editors with default `<p>` margin (Lexical, ProseMirror, Quill) stacked margin + margin = double-spacing. Generic contenteditables (Gmail, YouTube) keep per-line `<div>` emission because they lack default block-margin styling.

### Fixed — BlankFill's staleness check no longer silently drops substitutes during co-owned loading animations

Latent bug introduced by `0097d65` (2026-05-28, "blank-loading: refcount animator so Resolver + BlankFill don't race"). The refcount commit fixed the *opposite* race (resolver's fast return killing BlankFill's animation before the first frame paints) but didn't update BlankFill's `applyAsyncFill` staleness check at `blank-fill.ts:484`. Pre-refcount, when BlankFill's script returned, the resolver's prior `stop` had already restored `_` to the buffer, so `target.word === '_'` passed and the substitute landed. Post-refcount, BlankFill's `stop` is a no-op until the resolver also releases, so the buffer still carries a loading-frame char when `applyAsyncFill` reads it — the staleness guard rejects and the substitute is silently dropped.

PR #74 (blank-context skip) made the resolver's typical-case return so fast that this race rarely fires in production today, but the structural latent bug remained: any code path where the resolver outlives BlankFill's release (parallel-mode in-batch waits, sentence-cue + transform-blank concurrent dispatch, future modules taking the loading-owner role) re-exposes it.

- **`@opencues/runtime` (0.2.7 → 0.2.8)** — new public predicate `BlankLoadingAnimator.isOurSlotChar(wordIndex, char): boolean` returns true for the literal `_` or any of the slot's currently-active frame characters (per-slot frames so user-supplied custom frames in `blank-loading-frames` are also recognised). `BlankFill.applyAsyncFill` consults the predicate via `this._loading?.isOurSlotChar(slot.index, target.word) ?? false` — staleness now means "user typed a real character over our slot", not "the animator painted a frame here".
- **5 new regression tests** in `packages/opencues-runtime/src/modules/blank-loading.test.ts`'s new `isOurSlotChar — staleness-check helper` block: (1) `_` always recognised, even for an unknown slot; (2) any bounce-frame char in an active slot; (3) non-frame, non-`_` char rejected (real user-typed-over case); (4) frame-char query against inactive slot rejected; (5) custom-mode user-supplied frames recognised. Full runtime suite (1593 tests) passes.
- **No latency change** — purely a correctness fix that closes the latent silent-drop bug class. The larger animator → render-directive overlay refactor (Item #5 in the perf audit) remains a follow-up for structurally removing the entire bug class by not painting frame chars into the buffer at all.

### Changed — ConfigLoader parallelises every independent fs read on each `_loadOnce`

Pre-fix, `ConfigLoader._loadOnce` ran fs reads in serialised waves: OPENCUES.md → IDENTITY.md → per-path master batch → per-path folder discovery (sequential for-loop) → per-folder `prewalk` (sequential for-loop) → per-scope walks (sequential for-loop). Every read in each wave was independent of every other wave's, but `await` boundaries forced strict order. On a typical install (2-3 search paths × ~100 .md files), the reload paid sum-of-reads instead of max-of-reads. Cold reloads on a synced / mounted filesystem (WSL, sshfs, network home) showed 50-200ms unnecessary spin.

Post-fix: every independent read fans out under one top-level `Promise.all` in `_loadOnce` (settings + identity + per-path master batch + per-path folder discovery), and the two for-loops inside `_discoverFolders` become `Promise.all(entries.map(...))` and `Promise.all(['cues', 'blanks', 'auditors'].map(...))`. The downstream merge/fold logic is unchanged — same priority semantics, same fold-low-to-high overlay rule.

- **`@opencues/runtime` (0.2.6 → 0.2.7)** — single-file change in `packages/opencues-runtime/src/modules/config-loader.ts`. The top-level Promise.all hoists 4 categories of fs work (settings, identity, master batch, folder discovery) into one parallel wave; `_discoverFolders`'s per-entry and per-scope walks parallelise inside. No API surface changes; callers see the same `load()` Promise resolving with the same result shape, just faster on cold reads.
- **No new tests** — the existing config-loader suite (33 tests) covers all loader-output invariants and continues to pass; parallelisation is an implementation detail that preserves output semantics. Adding a "parallelism" test would essentially time the load and is too host-dependent to pin reliably.
- **Estimated win** — 50-200ms per cold `_loadOnce` on WSL / mounted FS. Invisible on a fast SSD. The 2s `maybeReload` debounce + 5s background poll mean this fires at most a few times per second of UI activity; the cumulative saving over an hour-long session is small but visible during cold-startup spikes.

### Changed — Resolver also skips forwarding `identityContext` when no consumer source will fire (symmetric with the blank-context gate)

PR #74 added a gate that skips the `blankContext` provider fetch when no consumer source (FluidBlank, TransformBlank) will fire. The symmetric site — `identityContext` forwarding in the same `_resolver.resolve(...)` call — was left as legacy "forward whenever `identity-context-mode !== 'off'`". The identity catalog is in-memory at ConfigLoader so the cost saving is small (no IO), but the symmetric correctness + payload-size win is worth the one-line gate.

- **`@opencues/runtime` (0.2.5 → 0.2.6)** — the same `noBlankContextConsumer(cleanWords, claimed)` predicate that gates `blankContext` now also gates `identityContext`: skip when either (a) the buffer has no `_` at all, or (b) every `_` is in the keyword-bound set passed via `keywordBoundSlotIndices`.
- **4 new regression tests** in `packages/opencues-runtime/src/modules/resolver.test.ts`'s new `identity-context skip for keyword-bound slots (symmetric with blank-context)` block: (1) every-`_`-claimed → not forwarded; (2) no-`_`-claimed → forwarded; (3) mode=off → not forwarded regardless; (4) no-`_` at all → not forwarded.

### Fixed — Parallel resolver enforces claim-then-bail semantics (TransformBlank → FluidBlank vandalism prevented)

The runtime resolver always passes `parallel: true` to the underlying `CueResolver`. Pre-fix, parallel mode dispatched every source with the SAME starting `consumedBlankSlots` (each call saw an empty claim set), and the post-dispatch processing didn't enforce the claim either — a lower-priority source's `wordIndex` results overlapping a higher-priority source's `consumedBlankSlots` (or its own filled `wordIndex`) would slip through, "vandalising" the higher-priority intent. Concrete shape: TransformBlank classifies `make this draft more formal _ hi bob` as TRANSFORM but APPLY emits no rewrite → `consumedBlankSlots: [last `_`]`. FluidBlank in the same batch produces a stray lookup answer for the same `_` and substitutes it, turning the user's compose intent into a question answer.

Post-fix: the parallel branch reconciles claims after the parallel batch resolves. Sources are walked in priority-descending order (constructor sorts that way); `consumedBlankSlots` accumulates as we process each source; every source's results are filtered against the accumulated set (excluding the source's OWN claim — a source can fill the slot it claimed). A higher-priority source's content-bearing result on a `wordIndex` also suppresses lower-priority results at the same index, closing the same-priority-tiebreak corner where two parallel sources both produced content.

- **`@opencues/core` (0.3.2 → 0.3.3)** — `CueResolver.resolve`'s parallel branch now post-filters each source's results against the accumulated `consumedBlankSlots` set, and accumulates each filtered source's produced `wordIndex` into that same set so subsequent (lower-priority) sources can't overwrite it.
- **4 new regression tests** in `packages/opencues-core/src/resolver.test.ts`'s new `parallel mode — higher-priority claims suppress lower-priority sibling results` block: (1) lower-priority result dropped on higher-priority claim-and-bail; (2) lower-priority result dropped on higher-priority content claim; (3) different-`wordIndex` results survive; (4) source's own `consumedBlankSlots` does NOT filter its own results.
- **No latency change** — same parallel dispatch; the reconciliation is in-memory post-processing. The cost not addressed in this PR: lower-priority sources still PAY for the LLM call even when their result is dropped. That's the in-batch sibling-cancellation follow-up; #76 (perf/abort-llm-on-stale-generation) covers the supersede case but not intra-batch.

### Added — BlankFill result cache: repeat `volume _` / `weather _` calls within TTL skip the spawn

Every keystroke that creates a fillable `_` slot spawns the blank's `get` script. On WSL, `bash → /mnt/c/...VolCtl.exe` is ~150ms of fork+exec overhead per call; for network-backed blanks (weather / stocks / hackernews / crypto / claude-status) it's ~500ms of HTTP. Repeat invocations with identical args within a short window (user backspaces the substituted answer and retypes `_`, cycles dismiss → re-summon, or quickly retries) re-paid that cost for the same byte-for-byte result.

The shipped fix is a per-blank result cache in BlankFill keyed by `<blankName>::<keyword>|<contextWords>`. On a hit within TTL, the cached stdout is spliced through the same `applyAsyncFill` path that the post-spawn success branch uses — the spawn doesn't happen at all.

- **`@opencues/core` (0.3.1 → 0.3.2)** — new `blankCacheTtlMs?: number` field on `BlankConfig` + the frontmatter struct + the parser case. Documented with per-blank guidance: action blanks (volume / brightness) at the default; ambient blanks (stocks 5-15s, weather 60s) higher. Strict integer parse; negatives + non-numeric drop silently.
- **`@opencues/runtime` (0.2.4 → 0.2.5)** — `BlankFill._resultCache: Map<string, {output, fetchedAt, ttlMs}>` with LRU semantics (insertion-order Map + cap 32 entries). Cache-hit path mirrors the spawn-success path: emits `blank.invoked` with `cacheHit: true` for observability, bumps LRU recency by delete+re-insert, clears the pending-dedup entry, and calls `applyAsyncFill` directly. On spawn success, the result is cached only when `exitCode === 0 && stdout` — failures stay un-cached so retries are cheap. Default TTL `BlankFill.DEFAULT_CACHE_TTL_MS = 2000` (override per-blank). Setting `blankCacheTtlMs: 0` in BLANK.md frontmatter disables the cache for that blank.
- **4 new regression tests** in `packages/opencues-runtime/src/modules/blank-fill.test.ts` (`BlankFill result cache` block): identical-args repeat → cache hit (no second spawn); past-TTL → cache miss (spawn fires again); `blankCacheTtlMs: 0` → cache disabled (every call spawns); failure (exit≠0) → NOT cached → next call spawns. Each test uses a `reArmAndPush` helper that mirrors the real user keystroke flow (clear buffer + re-type `_` so the explicit-`_` gate arms) so the cache path is exercised against the same dispatch path production uses.
- **Measured win (estimated, not benchmarked)** — ~150ms per repeat WSL spawn (volume / brightness); ~500ms per repeat network call (stocks / weather). Visible on the cycle-then-cycle-back path and on quick "backspace + retype" recovery. No effect on first-call latency.
- **Why this PR doesn't touch the shipped `defaults/blanks/*.md`** — every blank gets the 2000ms default which is safe for action blanks. Ambient blanks (stocks / weather) would benefit from a longer TTL but tuning them is a separate trade-off (correctness window vs cache hit rate) that should go through its own bench. Authors can opt any blank in via `blankCacheTtlMs: <ms>` in BLANK.md today.

### Added — transform-blank wires blank-as-context end-to-end

Blank-as-context's June 2026 v1 shipped fluid-blank-only — transform-blank (the compose / rewrite surface) consumed identity-context but not ambient blank-context tokens. The deferral was bench-gated, not architectural — `docs/architecture/blank-as-context.md:36-38` named it as the next milestone. This change closes that deferral.

The structural difference matters: fluid-blank already has the deterministic keyword path (`weather london _` works regardless of catalog), so blank-context for fluid is a convenience layer over a working path. Transform-blank has NO keyword path for ambient data — there is no way to type `weather london _` in the middle of `draft an email about today's weather`. Wiring blank-context into transform-blank is the structural unlock that lets compose flows reference live ambient data ("draft email about btc", "tweet about how stocks are doing", "morning standup: weather + crypto + nvda") with the runtime substituting live values into the prose locally.

- **`@opencues/core` (0.2.3 → 0.3.0)** — added `renderBlankContextCatalogForTransform` (a transform-flavoured prompt block: no INPUT/ANSWER examples since transform has no such shape; rules phrased for long-output prose; emit verbatim, never invent bracket-tokens from covers-hints, third-party `[Recipient Name]` / `[Date]` placeholders survive). Wired into TransformBlankSource at three prompt sites (GENERATIVE / 3-pass APPLY / FUSED). `resolveSentinels` now merges identity + blank-context catalogs into a single post-processor pass via `mergeCatalogs`, with `preserveUnknown: true` so non-catalog brackets in long bodies aren't stripped. 3-pass VERIFY REPAIR path also re-runs the post-processor to catch the edge case where VERIFY hallucinates a token in its correction.
- **Default frontmatter additions** (`defaults/blanks/*/BLANK.md`) — every shipping blank now declares `as-context:` explicitly. Data sources default ON (weather, stocks, crypto, hackernews, claude-status); action / write / loop-hazard blanks default OFF with a one-line rationale (volume, brightness, prompt, answer, sentinel, opencues, dictionary). Concrete slot lists:
  - **weather**: `context-bind: workCity` — binds to the existing `IDENTITY.md:workCity` field. `[WEATHER <CITY>]`.
  - **stocks**: `context-slots: NVDA, AAPL, TSLA, MSFT, GOOGL`. Documented in-frontmatter how to swap to `context-bind: portfolio` (with split + ack) for a personal watchlist.
  - **crypto**: `context-slots: BTC, ETH`. Majors only.
  - **hackernews**: `context-slots: top`. Single-slot — current top story.
  - **claude-status**: `context-slots: api`. Useful for "is claude working _" / "should i wait to retry _" routing.

  Per-blank audit table at `docs/architecture/blank-as-context.md:216` updated to match shipped state.

- **Bench evidence** — new `tests/benchmarks/blank-context-recall/transform-prod-bench.ts`. 7 compose-flow scenarios (email about weather, tweet about BTC, multi-token standup, identity+blank-context mix, etc.) hitting real Cerebras gpt-oss-120b: **7/7** with live substitution into prose. Plus 7 new unit tests at `packages/opencues-core/src/sources/transform-blank-blank-context.test.ts` pinning catalog injection (3-pass APPLY + FUSED), safe/raw mode contracts, post-processor substitution, and `preserveUnknown` survival of `[Recipient]` / `[Date]` placeholders.

**The user-facing scenarios this unlocks** — `draft an email to the team about today's weather _`, `write a tweet about how btc is doing _`, `compose a morning standup mentioning weather and crypto _`, `add a P.S. about today's btc price _`. All produce live-data prose without a keyword break. Threat-model parity with identity-context: `safe` mode keeps live values off the wire (substitution is local post-LLM); `raw` mode opt-in inlines them.

### Fixed — fluid-blank catalog recall +26pp via FUSED prompt rebalance

The FUSED_SYSTEM_PROMPT carries 30+ plain-prose factual-lookup examples that established a strong "answer in prose" prior — strong enough that catalog tokens were being dropped on indirect phrasings (`how are my stocks doing _` → empty answer; `biggest mover in my portfolio _` → invented `[PORTFOLIO]` bracket-token; `what's it like outside _` → prose instead of `[WEATHER LONDON]`). The shipped catalog block had a CRITICAL DECISION RULE but no inline counterweight to the plain-prose pull.

- **`@opencues/core` (0.2.2 → 0.2.3)** — `FUSED_SYSTEM_PROMPT` adds an explicit PRIORITY ORDER section (catalog tokens FIRST when a USER CONTEXT or BLANK CONTEXT block is present), plus an anti-hallucination rule: covers-hints are routing synonyms, NEVER bracket-token names ("portfolio" in the covers for `[STOCKS NVDA]` routes there; it does NOT license emitting `[PORTFOLIO]`). The empty-answer failure mode is named explicitly as the worst outcome.
- **Bench evidence** — new `tests/benchmarks/blank-context-recall/` matrix (30-35 cases, 5-provider matrix shape lifted from the matrix bench). Cerebras gpt-oss-120b on the production path: 25/35 (71.4%) → 34/35 (**97.1%**). Positive class 65% → 100%; negative 100% preserved. Ambient bench (`fluid-blank-ambient/fused-bench.ts`) holds at 174/176 — within noise.
- **Re-run before editing `FUSED_SYSTEM_PROMPT`** — `OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss npx tsx tests/benchmarks/blank-context-recall/prod-bench.ts`. Target: positive ≥95%, negative 100%, no invented bracket-tokens.

### Added — spec-version gate (the standard's "MUST refuse newer" rule, finally enforced)

The `SPEC.md` § Version policy clause "A conforming reader MUST refuse to parse a file whose declared spec version is higher than the reader's pinned SPEC_VERSION" used to be normative-but-inert — the parsers ignored the `spec:` frontmatter field entirely. Conformance fixtures pretended to cover it via regex-matching the fixture content, never calling into the runtime.

Now actually enforced:

- **`@opencues/core` (0.2.1 → 0.2.2)** — `spec-version.ts` adds `parseSpecPin`, `isSpecCompatible`, and `SPEC_OMIT_DEFAULT`. Every parser entry (`parseCuesMd`, `parseSingleCueMd`, `parseSingleAuditorMd`, `parseCuesMaster`, `parseBlanksMaster`, `parseAuditorsMaster`) calls the gate before producing a config. On refusal, an empty `CuesMdConfig` is returned with a populated `specError` field. `discover.ts` honours the gate and exposes an optional `log` hook so callers see refusal reasons. The algorithm encodes both the draft (`0.x`) and post-stable (`1.0+`) regimes: newer-major refuse, newer-minor refuse, AND post-1.0 cross-major refuse (major bumps are breaking by definition).
- **`@opencues/runtime` (0.2.1 → 0.2.2)** — `ConfigLoader` wires the discover log hook + every master-file load checks `specError` and emits `[warn] ConfigLoader: <file> refused — <reason>`. Refused sources are visible in `/tmp/opencues.log` instead of silently missing.
- **Conformance test rewritten** — `conformance.test.ts`'s `spec-too-new` case now calls `parseSingleCueMd` directly and asserts the returned config has `specError` set + no sources/blanks/auditors populated. The fixture-only regex check it replaced was technically passing the conformance suite without exercising any production code path.
- **39 new tests** — `spec-version.test.ts` (32 unit tests covering the algorithm against future versions: a 2.0 reader, 1.5 reader, pre-release suffix semantics, unparseable input) + `discover.spec-version.test.ts` (7 integration tests covering the log hook + the back-compat "omit-default never moves forward" invariant).

**The bug this prevents.** Without the gate, a `0.2-alpha` runtime silently accepts files declaring `spec: opencues/99.0`. The runtime tries to honour any feature the file uses — including future surfaces the runtime can't model — and produces incoherent results. With the gate, the runtime says "I'm 0.2, file declares 99.0, refused" and the user sees a single warn line they can act on.

**Forward-compat invariant.** `SPEC_OMIT_DEFAULT` stays at `opencues/0.1-alpha` permanently. When the spec bumps to 0.3, 1.0, 2.0, etc., legacy spec-less files still load (the default is always ≤ the runtime's version). New files SHOULD declare their target explicitly. Codified in `CLAUDE.md` § Spec-omit-default is permanent.

### Breaking + Added — identity-context rename, blank-as-context feature, and `opencues context`/`opencues cleanup` CLI

**Renamed** the personal-data feature from `sentinels` → `identity-context`:

- `~/.cues/SENTINELS.md` → `~/.cues/IDENTITY.md`
- `sentinels-mode` scalar in OPENCUES.md → `identity-context-mode`
- Public exports: `parseSentinelsMd` → `parseIdentityMd`, `renderSentinelsCatalog` → `renderIdentityContextCatalog`, `postProcessSentinels` → `postProcessContext`, types `Sentinels`/`Sentinel`/`SentinelsMode` → `Identity`/`IdentityField`/`ContextMode`
- CLI: `opencues sentinels` → `opencues identity`
- Source files: `packages/opencues-core/src/sentinels{,-validator}.ts` → `identity-context.ts` / `identity-validator.ts`
- Docs: `docs/features/sentinels.md` + `docs/architecture/sentinels.md` → `identity-context.md` siblings

No runtime back-compat reads. `opencues seed-configs` self-heals: `USER.md` → `SENTINELS.md` → `IDENTITY.md` two-hop rename + rewrites legacy scalar names in `OPENCUES.md`. Runs automatically on `opencues install <host>` for every existing user.

Why the rename — `sentinels` named the implementation (bracket tokens), not the content (identity), and conflicted with three sibling features (blank-context, ambient-context) all sharing the same `<context>` prompt block. The new umbrella is "context" with three sources (identity / blank / ambient). See `docs/features/identity-context.md`.

**Added — blank-as-context** (`docs/features/blank-as-context.md`): blanks can opt into surfacing their current values as ambient sentinel-style tokens for fluid-blank without the user typing the keyword. Stocks, weather, crypto, etc. become available as `[STOCK AAPL]`, `[WEATHER LONDON]` tokens that the LLM can emit; runtime substitutes after the response. Off by default per scalar `blank-context-mode: off | safe | raw` + per-blank `as-context: off | safe | raw` frontmatter. Bench evidence at `tests/benchmarks/blank-sentinels-matrix/FINDINGS.md` — 5-method × 5-provider × 6-count matrix (9,200 LLM calls); `safe-tokens` wins on every provider tested (100% on Cerebras + Groq, 99.4-99.7% on Gemini + OpenAI, 92.9% on Claude Haiku).

**Added — `opencues context list`**: unified inspection surface for all three context sources (identity / blank / ambient). Shows mode scalar, file paths, active tokens. `--json` for scripting. (LLM provider/model pair-display lives in `opencues doctor` from #68.)

**Added — `opencues cleanup`**: find and SIGTERM orphan host processes left behind by prior `opencues run` invocations. Also wired into `opencues run opencode|gemini-cli` as a predecessor-kill so fresh launches supersede prior instances for the same project. `--host`, `--project`, `--kill`, `--force`, `--json` flags. Self-protective: walks the current process's ppid chain to avoid killing its own ancestor.

**Fixed — config-intent classifier false-positive on identity-related lookups**: the rename created semantic collision between the user-typed phrase `mother's maiden name _` and the scalar name `identity-context-mode`. The classifier was applying `identity-context-mode safe` instead of ceding to fluid-blank. Added six NEGATIVE example phrases (`mother's maiden name`, `my email`, `my name`, `who am I`, `what's my github`, `i work at`) to the classifier's few-shot prompt. The positive setting-flip path (`let it use my personal info when answering _`) still routes correctly.

**Fixed — ConfigIntent auto-corrects stale model when switching provider via NL**: companion to PR #68's pair-display + cycling-resets-model fix, on the NL-classifier-apply path. When a user types `switch blanks to anthropic _`, ConfigIntent now reads the current `<bucket>-llm-model` scalar (via a new optional `readScalar` callback) and overwrites it with the new provider's `defaultModel` if the existing model belongs to a different provider's namespace. The runtime wires `readScalar` from `ConfigLoader.opencuesState.settings`; existing test callers without it get the old "leave alone" behaviour. Two new tests pin both branches.

Versions bumped: `@opencues/core` 0.1.12 → 0.2.1, `@opencues/runtime` 0.1.20 → 0.2.1, `opencues` (CLI) 0.1.10 → 0.2.0, `@opencues/chrome` 0.1.4 → 0.2.1.

### Fixed — bogus API key no longer fails silently when the provider's 401 body lacks an HTTP status number

Reported as part of switch-model testing: users with an invalid `ANTHROPIC_API_KEY` typed `_` and saw nothing happen — no buffer change, no inline error, no UI signal at all. The runtime *was* hitting the provider and *was* getting a 401 back, but Anthropic's response body is shaped as a 200-ish JSON envelope containing `{"type":"error","error":{"message":"invalid x-api-key","type":"authentication_error"}}`. `parseResponse` correctly threw `Error("anthropic error: invalid x-api-key")`, but `classifyHttpError` only matched HTTP-status numbers like `401` / `403` — the textual error fell through to the silent default, no `formatLLMErrorAsSubstitute` was called, and no inline message landed in the buffer.

Fix: `classifyHttpError` now also matches textual auth-error patterns (`invalid_api_key`, `invalid x-api-key`, `incorrect api key`, `api key not valid`, `authentication_error`, `authentication failed`, `permission_denied`, `unauthorized`). Anthropic, OpenAI, Groq, Gemini, and any future provider whose 401 body carries no HTTP status number now surface the same `[OpenCues: API key rejected ...]` substitute that 401/403 already did. Pre-existing `\b40[13]\b` HTTP-status path remains, so providers that *do* prefix the message with `HTTP 401` are still caught by the same branch.

Companion precision tweak: the `fluid-blank.bailed` event now carries the classified reason (`invalid-api-key`, `model-not-found`, etc.) instead of always reporting the generic `llm-error`. Event-stream consumers can now assert on the specific failure class without grepping log strings. The `llm-error` fallback is preserved for unclassified (silent / 5xx / malformed-response) failures.

Five new unit tests in `fluid-blank-error-substitute.test.ts` pin each provider's textual auth-error shape (Anthropic / OpenAI+Groq / Gemini / generic `authentication_error` / bare `Unauthorized`).

Version bumped: `@opencues/core` 0.1.11 → 0.1.12.

### Added — fluid-config `provider:model` pair display + granular model discovery via `config _`

Two UX gaps closed in one PR. Builds on top of #66 (provider cycling now skips values whose env key isn't set) — the pair-aware cycling here composes cleanly with that filter: cycling the provider skips ineligible providers AND resets the sibling model on the way, so neither "no env key" nor "stale model" pairs can persist.

**The pair-display gap.** Typing `use claude opus for auditors _` previously wrote both `auditors-llm-provider: anthropic` AND `auditors-llm-model: claude-opus-4-7` to OPENCUES.md, but the satellite splice showed only `auditors-llm-provider anthropic` — the model was set silently. Worse, cycling the provider satellite (Ctrl+Alt+Up on `anthropic`) walked to `openai` without touching the model scalar, shipping the invalid pair `openai + claude-opus-4-7` as soon as the next LLM dispatch fired (→ 400). Fix: ConfigIntent now emits the satellite as `anthropic:claude-opus-4-7` (one splitWords token; `:` is non-whitespace) with new `satelliteCyclingValue: 'anthropic'` metadata so cycling state stores just the provider while the buffer shows the full pair. The runtime reads the new metadata in `resolver.ts:1372`. The user always sees what model they got.

**The discovery gap.** Models weren't reachable from the `config _` cycling menu at all — only the three `*-llm-provider` scalars were in FEATURES. Users had to type natural language or hand-edit OPENCUES.md to pick a model. Fix: `FeatureSpec` gains an optional `valuesProvider?: (settings) => readonly ValueSpec[]` callback. Three new entries register `cues-llm-model`, `auditors-llm-model`, `blanks-llm-model` with a `valuesProvider` that reads the sibling `*-llm-provider` and enumerates that provider's `knownModels` from `llm-provider.ts`. The first cyclable value is always `default` (treated by `normalizeModelScalar` in resolver.ts as equivalent to absent — falls through to the provider's `defaultModel`). Cycling provider in `cycling.ts` now also writes `default` to the sibling model scalar via `providerScalarToModelScalar`, keeping the (provider, model) pair invariant by construction — no cycle path can land on an invalid pair.

`getMenuDefinitions` accepts an optional `settings` argument so dynamic values reflect live state. `applyOpenCuesScalar` overlays the three dynamic definitions on top of any existing file-shipped settings block on every scalar mutation (`overlayDynamicDefinitions` in config-loader.ts), so cycling provider immediately reshapes the model menu without waiting for the 2.5s reload-suppression window.

Test coverage: 8 new vitest cases in `feature-registry.test.ts` (valuesProvider shape + provider→model derivation), 4 new in `fluid-config.scenarios.test.ts` (pair splice + cycling-state semantics), 10 new in `llm-config-cycling.scenarios.test.ts` (provider-cycle-resets-model invariant across all three buckets + non-bucket scalars unaffected). Agentic scenario at `tests/agentic/scenarios-ts/fluid-config-pair-and-model-discovery.ts` drives the full live journey.

Versions bumped: `@opencues/core` 0.1.10 → 0.1.11, `@opencues/runtime` 0.1.19 → 0.1.20.

### Added — cycling `*-llm-provider` settings now SKIPS values whose env key isn't set

Same "test before you switch" property the chrome popup enforces natively: cycling on the CLI hosts (CC / OC / gemini / shell) must not land on a provider value the runtime can't actually dispatch with. Prior to this change, `config _` → cycle to `blanks-llm-provider` → Ctrl+Alt+Up stepped through every registry-declared value blindly. A user with only `CEREBRAS_API_KEY` set could land on `groq`, commit `blanks-llm-provider: groq` to `~/.cues/OPENCUES.md`, then watch every subsequent `_` silently no-op until they read `/tmp/opencues.log` (or, with #65 landed, see the inline `[OpenCues: API key rejected ...]` substitute).

New predicate `isProviderValueCyclable(providerId, apiKeys, { isCliAvailable? })` in `@opencues/core/llm-provider.ts` encodes the eligibility rule: `inherit` is always cyclable; `transport: 'cli'` providers (claude-code-cli, openai-subscription) are cyclable iff their CLI binary is on PATH; `optionalAuth: true` providers (opencode-zen) are cyclable without a key; all others require `apiKeys[provider.envKeyName]` to be set. Cycling reads it via a new `getApiKeys: () => apiKeys` callback threaded through `buildSharedRuntime` and the per-host adapter bands.

Safety net: when the filter would collapse a setting's value list to empty (no eligible providers + no `inherit` in the list), the cycle falls back to the unfiltered list so it still steps SOMEWHERE — the runtime then surfaces the resulting LLM-call failure inline (#65) rather than freezing the menu on the same value forever.

Scope is intentionally narrow — only `llm-provider`, `cues-llm-provider`, `auditors-llm-provider`, `blanks-llm-provider` scalars are filtered. Other settings (voice-mode, debug-mode, tips-mode, etc.) cycle unchanged. Hosts that don't thread `getApiKeys` (back-compat path) keep the pre-change blind-cycle semantic, so third-party adapters don't break.

7 new tests in `cycling.test.ts` pin the matrix (zero keys / one key / multi-key cycling forward + reverse / back-compat default / never-empty safety net / non-provider-scalar pass-through). 6 unit tests in `llm-provider.test.ts` pin `isProviderValueCyclable` independently across http / cli / optionalAuth / unknown-id / legacy-alias cases.

Versions bumped: `@opencues/core` 0.1.9 → 0.1.10, `@opencues/runtime` 0.1.18 → 0.1.19.

### Fixed — fluid-blank chain extension now survives a multi-word first answer

Pre-existing regression surfaced by live-testing the scroll-order fix below. Fluid-blank stored its DynDef `spanEnd` as the END OF THE FIRST WORD of the substitution (`newSpanEnd = newWord.end` in `resolver.ts:1235`). For a single-word answer that happened to be correct; for a multi-word answer like `William Shakespeare` inserted at char 0, `spanEnd` landed at 7 (end of `William`) instead of 19 (end of `Shakespeare`). The next substitute's chain verbatim check (`liveText.slice(spanStart, spanEnd) === currentAlt`) then compared `"William "` against `"William Shakespeare"` and bailed, dropping the first link from the chain — a 3-step lookup chain ended up only 2 links deep, with the original prompt + first answer silently missing from the walk-back history.

Fix: set `newSpanEnd = start + answer.length` (the FULL substituted range) in `resolver.ts:1235`. New scenario test at `blank-chain.scenarios.test.ts` pins the case explicitly.

Version bumped: `@opencues/runtime` 0.1.17 → 0.1.18.

### Fixed — fluid-blank AND transform-blank cycle order now match every other blank type ([#61](https://github.com/opencues/opencues/issues/61))

Cycling through a fluid-blank chain (`translate to japanese _` → `… translate to chinese _`) or a transform-blank chain (`draft email _` → continue → another transform) moved in the opposite direction from list-blanks / selector-satellite / sentence-cues. After the first substitution the buffer showed the answer (`こんにちは`); the DynDef stored `[question, answer]` with `currentIndex: 1`, so pressing Up (+1) wrapped from the end of the array straight to the oldest question instead of stepping back one item. With a chain `[q1, a1, q2, a2]` at `currentIndex=3`, Up jumped all the way to `q1` while Down only walked to `q2` — opposite of every other blank where `alts[0]` is the current visible and Up advances through `alts[1..]` one entry at a time.

The bug structurally affected both LLM-blank chain pipelines (`fluid-blank` and `transform-blank`) because they share the same `[oldest, …, newest]` chronological layout with `currentIndex` pointing at the tail. The initial PR only fixed fluid-blank per the narrow issue title; manual testing in CC surfaced that `draft email _` (transform-blank) had identical broken cycling, so the fix was extended to transform-blank.

Fix: store both fluid-blank AND transform-blank alternatives in reverse-chronological order — `[newestAnswer, newestQuestion, …priorItems]` with `currentIndex: 0`. Up now walks backward through history one entry at a time (newest answer → newest question → prior answer → original prompt), matching the convention list-blanks and sentence-cues already use. Chain truncate-on-branch flipped accordingly for both pipelines: drop the items NEWER than where the user cycled to (the indices BELOW `currentIndex` in the new layout) before prepending the next substitution. Tests at `packages/opencues-runtime/src/modules/blank-chain.scenarios.test.ts` and `transform-blank.scenarios.test.ts` updated for the new shape.

Version bumped: `@opencues/runtime` 0.1.15 → 0.1.17.

### Fixed — Claude Code: second `_` in a chain silently dropped (ZWS leaks into KeyEvent)

CC-only regression after [#52](https://github.com/opencues/opencues/pull/52). Chaining `_` triggers (`draft email _` → `… translate to japanese _`) worked on OpenCode but failed on Claude Code: the second transform never fired, the `_` just sat in the buffer. Root cause: the CC adapter's `dispatchKey` passed `iz.text` straight into `normaliseKeyEvent` (`packages/opencues-runtime/adapters/cc/v2.1/boot.ts:708-727`) without stripping the render-kick `\u200B`/`\u200C` marker that `__oc_pushHostText` toggles to defeat React's string-equality bail. Resolver's `onUnderscoreKey` (added by #52) simulates the standalone-`_` check via `splitWords`, which matches `\S+`; the ZWS is non-whitespace, so it glues to the cursor word — the trailing `_` is no longer detected as standalone, the one-shot gate refuses to arm, and `onTextChange` falls through to the debounced path with `allowBlanks=false`, masking the blank source. OC isn't affected because it doesn't render-kick.

Fix: strip ZWS at the KeyEvent boundary, same pattern as `checkTextDrift` (boot.ts:282) and `applyRender` (boot.ts:771-772) already use — this was the missing fourth row in the boundaries table in `integrations/claude-code/CLAUDE.md`. Adapter test pinned via `KeyEvent.text + cursorOffset are ZWS-stripped before reaching onKey handlers`.

Version bumped: `@opencues/runtime` 0.1.14 → 0.1.15.

### Fixed — LLM blanks silently dead on auto-routed Cerebras (invalid provider/model pair) + provider errors now surface inline

One root cause: a provider-blind default model leaking into an auto-routed provider of a different model namespace. The guiding principle for the fix: **always land on a valid (provider, model) pair; if a real error remains (credits, auth, …) surface it inline; never silently ship an invalid model.**

1. **Valid-pair guarantee — defaulting (`packages/opencues-runtime/src/modules/resolver.ts`).** The resolver no longer falls back to the host-supplied (legacy Groq-namespaced) `defaultModel` for the global MODEL tier. With `CEREBRAS_API_KEY` set and no `llm-provider:`/`llm-model:` in OPENCUES.md, auto-route correctly picked the Cerebras *provider* but the host default model `openai/gpt-oss-120b` was injected as `globalModel`, overriding Cerebras's own native `gpt-oss-120b` — so every `_` fluid/transform blank died with `provider error: Model openai/gpt-oss-120b does not exist … (code=model_not_found)`. (Script/static blanks like `weather _` were unaffected.) `globalModel` now comes ONLY from an explicit choice (`llm-model:` scalar or host-UI `modelOverride`); with neither, `resolveLLM` falls through to the resolved provider's own `defaultModel`, valid by construction. Two regression tests pin the invariant via the `resolverFactory` capture hook.

2. **Valid-pair guarantee — canonicalization (`packages/opencues-core/src/llm-provider.ts`).** New `canonicalizeModelForProvider()` normalises a known cross-namespace model alias INTO the resolved provider's own namespace on the PRIMARY dispatch path (previously the gpt-oss `openai/`-prefix ↔ bare translation only happened on the *fallback* path). A stale or mistyped `llm-model: openai/gpt-oss-120b` paired with Cerebras is now healed to `gpt-oss-120b` **before** the call instead of bouncing as `model_not_found`. Deliberately narrow (gpt-oss family only); an unknown/genuinely-wrong model is left untouched so the provider rejects it and the runtime surfaces that inline. Unit + `resolveLLM` integration tests cover both directions and the no-op cases.

3. **Provider errors surface inline like 401/404 (`packages/opencues-core/src/sources/fluid-blank-source.ts`).** `classifyHttpError` now recognizes two error classes that previously carried no HTTP status number and fell through to the silent default (visible only in `/tmp/opencues.log`):
   - **`model-not-found`** — `model_not_found` / `not_found_error` / "does not exist" / "do not have access". Checked before the generic 404 branch so a model 404 is attributed to the model, not the endpoint URL.
   - **`insufficient-credits`** — 402 / `payment_required` / `insufficient_quota` / "out of credits" / "billing". This is the "real" downstream error once canonicalization has landed a valid model — the account simply can't pay for the call.
   Both route through the existing `formatLLMErrorAsSubstitute` path, painting actionable inline messages. Reasons added to every formatter union site (`resolver.ts`, `build-sources.ts`, `boot-common.ts` native formatter, chrome `boot.ts`).

4. **Observability — resolver-side explicit-`_` gate now logs its suppression (`packages/opencues-runtime/src/modules/resolver.ts`).** When the explicit-`_` keystroke gate suppresses a blank trigger on the resolver path (fluid / transform / config-intent), it previously did so completely silently — no `starting` line, nothing even at debug level — so a `_` that "did nothing" was undiagnosable from the log. It now emits a `debug`-level `Resolver: explicit-_ gate BLOCKED …` line mirroring `BlankFill`'s existing one, surfaced under `debug-mode: on` (or `DEBUG_OPENCUES`).

Versions bumped: `@opencues/core` 0.1.8 → 0.1.9, `@opencues/runtime` 0.1.13 → 0.1.14.

### Changed — Provider rename `claude-cli` → `claude-code-cli`, llama-3.3 removed from Groq catalogue, CLI providers added to smoke

Follow-up on the LLM-provider fix below. Renamed the Anthropic CLI-transport provider id from `claude-cli` to `claude-code-cli` to match the official product name and remove ambiguity ("claude-cli" reads as a generic Claude CLI; the canonical user-facing brand for the binary is "Claude Code"). `canonicalizeProviderId()` keeps legacy user configs (`globalProvider: claude-cli`) silently working — old id resolves to canonical at every user-input boundary (resolveLLM + validateEndpoint + getProvider). Drop after 2027-01-01.

`llama-3.3-70b-versatile` removed from Groq's `knownModels` — it's not a reasoning model, so the adapter's default `reasoning_effort: low` 400s on it. The `modelRejectsReasoningEffort` predicate keeps it usable via direct OPENCUES.md edit; the classifier just doesn't surface it.

Smoke runner now also covers the two CLI-transport providers (`claude-code-cli`, `openai-subscription`) — `probe()` branches on `transport === 'cli'` and dispatches via `invokeCli()` instead of `fetch()`. Verified live 2026-06-02: 20 of 21 combos pass; the one failure was the user's expired `codex login` (actionable, not a bug — the runner correctly surfaced the API's auth-expired message).

Version bumped: `@opencues/core` 0.1.7 → 0.1.8 (single bump covers both fixes).

### Fixed — LLM providers: temperature/reasoning-effort deprecations + stale model catalogues

User reported `draft email _` producing no output in claude-cues despite doctor reporting healthy. Log trace caught the actual failure: `anthropic error: \`temperature\` is deprecated for this model.` — every blank routing through `blanks-llm-provider: anthropic` (Claude 4.x) was silently dying in the LLM call. A live smoke runner ([`tests/integration/llm-providers-smoke.cjs`](tests/integration/llm-providers-smoke.cjs)) verifying all 19 shipped (provider, model) combinations against real keys caught three more latent failures:

- **anthropic + claude-{opus,sonnet,haiku}-4-*** rejected `temperature`. Anthropic deprecated the field on the entire Claude 4.x family in June 2026. Now omitted at request build (`modelRejectsTemperature` registry). OpenRouter passthrough to `anthropic/claude-*` also covered.
- **groq + llama-3.3-70b-versatile** rejected `reasoning_effort` with HTTP 400. Groq's adapter previously claimed "non-reasoning models silently ignore it" — they don't on llama. Now gated by `modelRejectsReasoningEffort` registry; gpt-oss companions (which REQUIRE the field) keep getting it.
- **cerebras** catalogue listed `qwen-3-235b-a22b-instruct-2507` which Cerebras's `/v1/models` endpoint no longer returns. Removed from `knownModels`.
- **gemini** catalogue listed `gemini-3.1-flash` / `gemini-3.1-pro` which 404 on the live API. Google switched to the `gemini-flash-latest` / `gemini-pro-latest` rolling aliases. Updated.

Capability matrix lives in two registry consts in `llm-provider.ts` (`TEMPERATURE_REJECTING_MODELS`, `REASONING_EFFORT_REJECTING_MODELS`). Adding a future deprecation is a one-line append. 24 unit-test pins in `llm-provider.temperature.test.ts` cover the predicates + the buildRequest forwarding (Anthropic inline body + buildOpenAIBody-driven Groq/OpenRouter/Cerebras/OpenAI shared body). Live smoke runner (opt-in, requires API keys) verifies every catalogue entry actually accepts a minimal request — re-run on any model-catalogue or provider-adapter edit:

```bash
node tests/integration/llm-providers-smoke.cjs           # smoke every combo
node tests/integration/llm-providers-smoke.cjs --models  # list known combos
```

Verified live: 19/19 combos pass after the fix. Version bumped: `@opencues/core` 0.1.7 → 0.1.8.

### Changed — Blanks fire only on explicit `_` keystroke (cursor-split bug)

Explicit-`_` gate for blank activation (`packages/opencues-runtime/src/modules/{resolver,blank-fill}.ts`). FluidBlank / TransformBlank / ConfigIntent and script-backed blanks (volume, brightness, …) now fire ONLY when the `_` in the buffer was placed by an explicit user keystroke. A `_` exposed via cursor-relocation (typing `monologue_` and then splitting it to `monologue _`), paste, or programmatic `setText` is suppressed. Resolver and BlankFill each arm a one-shot flag on a plain `_` keypress, but only when the simulated insertion would produce a standalone `_` — so typing `_` adjacent to an existing word never arms. The flag is cleared at the end of the next `onTextChange` (exception: spaced-mode unconfirmed `_` keeps it through one extra dispatch so the confirming space still dispatches). `MockAdapter.pushText` auto-fires the `_` keystroke when the new text introduces additional `_` chars; the new `pushTextNoKeystroke` is the explicit opt-out for paste/programmatic-insertion simulations. Three scenario tests pin the user journey.

A follow-up commit on the same branch adds an event-bridge synth on `text:` injection that grows the underscore count — keeps the gate honest when text arrives through programmatic paths that bypass `onKey`.

Version bumped: `@opencues/runtime` 0.1.12 → 0.1.13.


### Fixed — Terminal.app Ctrl+Option+arrow: stdin byte-rewrite (completes the #51 synth)

Real-device testing of the [#51](https://github.com/opencues/opencues/pull/51) synth on a **default** Terminal.app profile (claude-cues 2.1.158, Ink) showed it still did nothing. A runtime probe of the raw event proved why: Ink **splits** the `\x1b\x1b[A` chord into two events *before any consumer sees it* — a standalone `escape` (seq `\x1b`) + a plain arrow (seq `\x1b[A`), same millisecond. After the split the arrow no longer carries the double-ESC prefix, so the event-level `shouldSynthesizeMacDoubleEscCtrl` gate can never fire (`synthFired:false` on every arrow; zero `ctrl:true` in the dispatch log).

The fix runs one layer earlier — at the raw stdin bytes, before Ink parses:

- **`packages/opencues-runtime/src/modules/mac-keyboard.ts`** — new pure `rewriteMacDoubleEscArrows(chunk)` rewrites `\x1b\x1b[A/B/C/D` → `\x1b[1;7A/B/C/D` (modifier param `7` = Ctrl(4)+Alt(2)+1 — the exact bytes Ghostty/iTerm2 already send, which Ink decodes to `{ctrl:true, alt:true}`). Plus `installMacDoubleEscStdinRewrite(stdin)` — darwin-gated, idempotent. Ink/CC consume stdin via 'readable' + `read()` with `setEncoding('utf8')`, so the installer wraps `read()` (the path that matters; chunks arrive as utf8 STRINGS, handled by a string-form rewrite) plus `emit('data')` for flowing hosts — each normalised before Ink's keypress parser sees it.
- **`packages/opencues-runtime/adapters/cc/v2.1/boot.ts`** — installs it once in `boot()` (CC only; shell / OC / gemini receive pre-parsed events and don't read stdin).

Safe by the **contiguous-byte invariant**: the terminal writes the chord's 4 bytes atomically → one stdin buffer; a real lone Escape arrives as its own buffer. Matching `\x1b\x1b[A` only within a single buffer therefore can never swallow a real Escape — no state, no timing window, no Escape latency. **Strictly darwin-gated — a complete no-op on Windows/Linux**: the installer returns early (`platform !== 'darwin'`) before wrapping stdin, so the byte rewrite is never reached off macOS. Degradation floor: on split-chunk transports (tmux/ssh) it no-ops, identical to the prior release. The #51 event-level synth is retained (no-op on this path, still covers hosts that preserve the full sequence). gemini-cli's matrix-❌ row is fixable by the same installer in its bootstrap (follow-up).

Version bumped: `@opencues/runtime` 0.1.11 → 0.1.12.

### Added — Bootstrap-coverage tests + banner-combo extraction (no behaviour change)

Follow-up to the macOS Ctrl+Option+arrow fix in [#51](https://github.com/opencues/opencues/pull/51). Two surfaces were behaviour-correct but untested:

- **OpenTUI bootstraps** (`integrations/shell/src/bootstrap.ts`, `integrations/opencode/patches/opencuesBootstrap.ts`) inlined the modifier-coalesce for the runtime `Modifiers` shape. Now factored into `buildOpenTuiModifiers(evt)` in `@opencues/runtime/src/modules/mac-keyboard.ts`, pinned by 19 new test cases in `mac-keyboard.test.ts` covering: Mac Terminal.app double-ESC (all 4 arrows + meta preservation), Ghostty / iTerm2 xterm-modifier CSI (Ctrl+Option+arrow + plain Option+arrow), Linux/Windows xterm (Ctrl+Alt+arrow, plain Alt+arrow regression guard, plain arrow), Ctrl+Shift+arrow + 4-modifier combinations, the alt-coalesce truth table (option/alt/meta cross-product), and defensive edge cases (missing sequence, missing key). Both bootstraps now delegate verbatim — drift between the two is structurally impossible.
- **Banner combo label** (`packages/opencues-cli/src/commands/run.cjs`) had inline `pickNavCombo(host)` that read `process.platform` directly — not testable. Now extracted to `packages/opencues-cli/src/lib/nav-combo.cjs` with an explicit `platform` parameter (defaults to `process.platform`); pinned by 21 new `node:test` cases in `nav-combo.test.cjs` across `darwin / linux / win32 / freebsd / openbsd / sunos / aix` × every shipped host. Confirms macOS reads "Ctrl+Option" (matches physical Mac keyboard label) and every other platform reads "Ctrl+Alt"; chrome's label follows the user's keyboard, not the browser env.

Net coverage: **+40 unit pins** across the two surfaces flagged as untested in #51's post-merge audit. Runtime suite now 1496 tests; CLI suite now 133 tests. Versions bumped: `@opencues/runtime` 0.1.10 → 0.1.11, `opencues` CLI 0.1.8 → 0.1.9, `@opencues/shell` 0.1.3 → 0.1.4, `@opencues/opencode` 0.1.2 → 0.1.3.

### Fixed — macOS Ctrl+Option+arrow now works on every terminal, including Terminal.app

A tester reported `Ctrl+Alt+arrow` doing nothing on macOS. `cat -v` testing traced the byte stream Mac Terminal.app emits for Ctrl+Option+arrow: `\x1b\x1b[A` (double-ESC + CSI). The Ctrl modifier byte is missing — Terminal.app doesn't encode it — but **the double-ESC prefix is a unique signature**: no other macOS key combination produces double-ESC arrow CSI. Plain Option+Left/Right emits word-jump bytes (`^[b` / `^[f`), not arrow codes; plain arrows omit the ESC prefix entirely. Both Ink and OpenTUI parsers detect double-ESC and surface `option: true` on the arrow event (see `ink/parse-keypress.js:471` and `@opentui/core parse.keypress:5957`).

Three sites now synthesise `ctrl: true` when the runtime sees `option && arrow && !ctrl`, so the `ctrl-alt` matcher fires on Mac Terminal.app exactly the way it does on Ghostty / iTerm2 (which already transmit the Ctrl bit in modifier-encoded CSI like `\x1b[1;7A`):

- **`packages/opencues-runtime/adapters/cc/v2.1/adapter.ts:328-380`** — synth in `normaliseKeyEvent`, covers CC for both forks (cli.js 2.1.110 + native 2.1.150/158).
- **`integrations/shell/src/bootstrap.ts:412-440`** — synth in `dispatchOpenCuesKey`. Same OpenTUI host as OC.
- **`integrations/opencode/patches/opencuesBootstrap.ts:511-540`** — same synth.

Per-integration matrix on macOS after this PR:

| Integration | Mac Terminal.app | Ghostty / iTerm2 |
|---|---|---|
| CC | ✅ works (synth fires on double-ESC) | ✅ works (synth is no-op, ctrl already true) |
| OC | ✅ works | ✅ works |
| shell | ✅ works | ✅ works |
| gemini-cli | ❌ Gemini's own parser at `KeypressContext.tsx:585` reads `alt` from the CSI modifier byte and discards the outer ESC-prefix from a double-ESC sequence. Mac Terminal users on gemini-cli need to install Ghostty or iTerm2 (which emit modifier-encoded CSI directly and bypass the parser quirk). | ✅ works |
| chrome | ✅ DOM `altKey` works in any Mac browser | ✅ same |

Also in this PR:

- **`packages/opencues-runtime/src/modules/nav-keymap.ts`** — removed the `TERM_PROGRAM=Apple_Terminal → ctrl-shift` auto-fallback. It was based on the wrong assumption that Ctrl+Alt+arrow was stripped; per `cat -v` testing, *Ctrl+Shift+arrow* is the combo Terminal.app actually strips, so the fallback was making things worse. `auto` now resolves to `ctrl-alt` everywhere (chrome stays hard-pinned).
- **`docs/install.md`** macOS section rewritten — Terminal.app now works without manual configuration thanks to the synth above. Earlier drafts of this PR recommended toggling "Use Option as Meta key" in profile settings; that's no longer required for OpenCues itself (users may still want it for general shell ergonomics).
- **Shared helper** `packages/opencues-runtime/src/modules/mac-keyboard.ts` exports `shouldSynthesizeMacDoubleEscCtrl`. Single source of truth used by all three sites above; 16-test pin in `mac-keyboard.test.ts` covers every byte-shape × terminal × edge-case combination.

Versions bumped: `@opencues/runtime` 0.1.9 → 0.1.10, `@opencues/core` 0.1.6 → 0.1.7, `opencues` CLI 0.1.7 → 0.1.8, `@opencues/shell` 0.1.2 → 0.1.3, `@opencues/opencode` 0.1.1 → 0.1.2. Banner in `opencues run` shows "Ctrl+Option" on darwin to match the physical Mac keyboard label.

User-facing upgrade path: `opencues run <host>` auto-rebuilds on next launch (srcHash drift detection from June 2026). No manual terminal-settings toggle required.

### Added — Self-healing forks: `opencues run <host>` auto-rebuilds on source drift

The "git pull and existing forks silently keep running pre-pull bytecode forever" trap is now closed structurally. Three pieces shipping together in this batch:

- **`packages/opencues-cli/src/lib/version-markers.cjs`** gains `computeSourceHash(repoRoot)` — a SHA-256 over every file under `packages/opencues-runtime/src/**` + `packages/opencues-core/src/**` + `packages/opencues-core/node-http-adapter.js`. `writeMarker` records it; `checkDrift` returns `status: 'stale', reason: 'srcHash'` when it diverges from the bundle's recorded hash. Load-bearing because it fires on ANY source byte change, not just package.json bumps — developers forgetting to bump no longer masks drift.
- **`packages/opencues-cli/src/commands/run.cjs`** calls `ensureFreshBundle(host, ctx)` at the top of every `opencues run <host>` invocation. Stale → transparently runs `opencues install <host> --no-prompts --yes` before spawning the host. One info line tells the user what's happening (`bundle is stale (source files changed since last install). Rebuilding before launch`). `--no-rebuild-check` opts out.
- **CLAUDE.md** gains a "Drift-prevention discipline" section codifying the new mechanism, the contract for adding bundled source dirs, and what contributors MUST do when changing `@opencues/{core,runtime}/src/**`.

### Added — `@opencues/core` 0.1.4 → 0.1.5
- **0.1.4 → 0.1.5** (PR #37 — nav-keymap): new `nav-keymap` scalar in FEATURES (`auto` | `ctrl-alt` | `ctrl-shift`). Auto resolves per host: chrome → ctrl-alt always (browser owns ctrl-shift+arrow); macOS Terminal.app (`TERM_PROGRAM=Apple_Terminal`) → ctrl-shift; everything else → ctrl-alt. Lets macOS Terminal.app users keep navigating without switching terminal emulators.

### Added — `@opencues/runtime` 0.1.5 → 0.1.6
- **0.1.5 → 0.1.6** (PR #37 — nav-keymap): `OpenCuesState.navKeymap` field with parser + `applyOpenCuesScalar` support; new `nav-keymap.ts` module exporting `resolveNavKeymap(configured, hostName)`. `Navigation` + `Cycling` subscribe both modifier combos at boot and gate each handler per-keystroke against the resolved keymap — flipping the scalar in OPENCUES.md hot-reloads without restart. Chrome adapter band skips the ctrl-shift subscription entirely (browser owns it for text selection).

### Added — `opencues` CLI 0.1.5 → 0.1.6
- **0.1.5 → 0.1.6** (PRs #38 / #39 / #40 / #41 + this batch):
  - PR #38: `opencues run <host>` launch banner with key hints + `--skip-banner` opt-out. Banner held in alt-screen for 3s minimum dwell so the Keys line is actually readable.
  - PR #39: shell-install tmux noise reduction — consolidated from 4 mentions per install to ≤2. Vendored-first preflight check skips the system-tmux warning when `~/.opencues/vendor/tmux/bin/tmux ≥ 3.2` is present.
  - PR #40: banner Keys section restructured so "Keys" is the leftmost section header with ├─/└─ branches hanging beneath; description column aligned across both Ctrl+Alt (12) and Ctrl+Shift (14) widths.
  - PR #41: vendor-pins test sandboxed via temp-`$HOME` so `pnpm test` stops deleting the real user's `~/.opencues/vendor/tmux/`.
  - This batch: `ensureFreshBundle` drift check + auto-rebuild on `opencues run`; `version-markers.cjs` gains `computeSourceHash` + `srcHash` + `reason` fields.

### Added — `@opencues/shell` 0.1.1 → 0.1.2
- **0.1.1 → 0.1.2** (PR #39): `bin/install.cjs` no longer prints the duplicate "tmux not installed" note (preflight in `opencues install` is now the single source of truth); the auto-vendor message names WHY it's running (`▸ System tmux is X.Y (oc-shell needs ≥ 3.2). Vendoring tmux 3.4 to ~/.opencues/vendor/tmux/`); `patches/setup.sh` tail prints only `✓ Shell build done.`, with the Launch / Open input / Optional-shell-integration summary moved into install.cjs so it lands AFTER the vendor step, not before.

### Added — `@opencues/core` 0.1.0 → 0.1.4
- **0.1.0 → 0.1.1**: Three-bucket LLM routing (`cues` / `auditors` / `blanks`). FEATURES registry gains three bucket scalars; `ConfigLoader` parses `cues-llm-provider` / `auditors-llm-provider` / `blanks-llm-provider` with back-compat read for legacy singular `blank-llm-*`. `build-sources.ts` routes per-bucket via `cuesBucket*` / `blanksBucket*` instead of the single `blankGlobal*`; the trust-class guard refuses `trainsOnInput: true` providers on prose buckets. Canonical doc: `docs/architecture/llm-routing.md`.
- **0.1.1 → 0.1.2**: Fluid-config natural-language provider/model switching. `ConfigIntentVerdict` becomes a discriminated union (`setting` | `provider` | `none`); SYSTEM_PROMPT rewritten with three INTENT classes; `validateAgainstRegistry` handles both verdict kinds. `ProviderAdapter.knownModels` (optional `readonly string[]`) bounds the model catalogue the classifier may route to — 2-5 curated entries per provider.
- **0.1.2 → 0.1.3**: Bare provider switches default to the **blanks** bucket. `"switch to anthropic _"` now writes `blanks-llm-provider: anthropic` (was `cues-llm-provider`). Cues and auditors require explicit scope; rationale: blanks is the user-opt-in `_` surface most likely targeted by a bucket-less phrase.
- **0.1.3 → 0.1.4** (PR #32 — Sentinels infrastructure): TransformBlankSource now consumes the SENTINELS.md catalog — `draft email _`, `write a bio _`, etc. resolve sender sentinels via the same post-processor FluidBlank uses, with `preserveUnknown: true` so non-sender placeholders (`[Recipient Name]`, `[Date]`) survive untouched. New `validateSentinelWrite` discriminated chokepoint (`sentinels-validator.ts`) enforces key shape, value caps (256 chars / 64 fields), control-character filter, and token-collision detection for any code path that mutates SENTINELS.md. Renames: file `USER.md` → `SENTINELS.md`; symbols `UserContext*` → `Sentinels*`, `parseUserMd` → `parseSentinelsMd`, etc.; scalar `user-context-mode:` → `sentinels-mode:`. Back-compat: ConfigLoader reads both scalar names; seed-configs self-heals the file + scalar rename. Audit row #24 codifies the new write-surface threat model.

### Added — `@opencues/runtime` 0.1.0 → 0.1.5
- **0.1.0 → 0.1.1** (PR #17 chain-history): sequential LLM-blank substitutes chain into walkable history so the user can cycle back through prior fill-ins.
- **0.1.1 → 0.1.2**: typed bucket fields (`cuesLlmProvider` / `auditorsLlmProvider` / `blanksLlmProvider`) on `OpenCuesState` with back-compat parsing; `boot-common.buildAgentLLMResolver` reads the auditors bucket so `agent-rewrite` routes through it.
- **0.1.2 → 0.1.3**: `applyOpencuesScalar` now awaits the disk write — back-to-back applyScalar calls (ConfigIntent's provider+model verdict path) serialise on disk instead of racing the read-modify-write.
- **0.1.3 → 0.1.4** (PR #32 — Sentinels rename): `OpenCuesState.userContextMode` → `sentinelsMode`; `ConfigLoader` parses the new `sentinels-mode:` scalar with back-compat fall-through to legacy `user-context-mode:`. No behaviour change for users who haven't opted into sentinels.
- **0.1.4 → 0.1.5** (PR #34 — sentinel-write blank): new `SentinelBlank` class in `BUILTIN_BLANKS` handles `set sentinel <key> <value> _` and `remove sentinel <key> _`. Every write routes through `@opencues/core`'s `validateSentinelWrite` chokepoint (no parallel paths). New `sentinelsMdIO` field on `BuiltinBlankContext`; the blank registers only when the host wires it. Errors paint visibly into the buffer as `[err] <detail>` — never silent, never throws. 7 layered defences documented in security-audit.md row #24.

### Added — `opencues` CLI 0.1.1 → 0.1.5
- **0.1.1 → 0.1.2** (Option-B self-heal): `seed-configs` cleans up legacy built-in / user-blank collisions left over from the May 2026 user-blank migration. Per-host log prefix; per-version markers.
- **0.1.2 → 0.1.3**: `seed-configs` self-heals legacy `blank-llm-*` → `blanks-llm-*` rename in place; `doctor` grows a "LLM routing" section showing effective resolution per bucket; `doctor` tmux check honors the vendored 3.4 fallback (`~/.opencues/vendor/tmux`); `update` detects stale bundled `@opencues/{core,runtime}` and transparently rebuilds instead of short-circuiting; CC install's "already healthy" hint bolds the `--rebuild` flag; help screen's Providers row shows three buckets instead of four per-aspect surfaces; `update` exports `isTested` / `isKnownIncompatible` (regression fix).
- **0.1.3 → 0.1.4** (PR #33): SIGINT race fix — `opencues update` registers signal handlers BEFORE `acquireLock` writes the lockfile (see CLI #33 entry above).
- **0.1.4 → 0.1.5** (PR #32 — Sentinels CLI + migrations): new `opencues sentinels` command (interactive interview + scriptable `list` / `set` / `add` / `remove` / `rm` / `path` / `list --json`). Smart defaults from `git config` and `gh api user`. All writes route through `@opencues/core`'s `validateSentinelWrite`. `seed-configs` self-heals `~/.cues/USER.md` → `~/.cues/SENTINELS.md` (pre-SEED step so user data survives) and `user-context-mode:` → `sentinels-mode:` (legacy-value-wins when both present). `doctor` surfaces leftover legacy artifacts with `opencues seed-configs` as the fix command.

### Added — `@opencues/claude-code` 0.1.0 → 0.1.2
- Single-fork CC install: one fork at `~/claude-code-cues/` handles both cli.js (≤2.1.111) and native-binary (≥2.1.113) shapes via tweakcc 4.0.13+ shape detection. `claude-code-cues-150` retired. Opt-in statusline. Native 2.1.150 support. Subsequent same-minor bumps (2.1.158 promoted to `current-pin` 2026-05-31) ride this band without a package-version bump — same adapter, same anchors, only `compat.json` updates.
- **0.1.1 → 0.1.2** (PR #34): CC bootstrap wires `sentinelsMdIO` so the keyword-bound `set sentinel _` / `remove sentinel _` blank can write to `~/.cues/SENTINELS.md`. Writes route through `@opencues/core`'s `validateSentinelWrite`; no parallel write paths. Security-audit row #24.

### Added — `@opencues/chrome` 0.1.0 → 0.1.2
- Bundle ships the new `BLANK.md` frontmatter (the user-blank migration that retired the per-host built-in/user-blank duplication).
- **0.1.1 → 0.1.2** (PR #34): Chrome bootstrap wires `sentinelsMdIO` so the sentinel blank works on contenteditables + normal inputs. Writes go through chrome.storage via the same validator chokepoint.

### Added — `@opencues/opencode` 0.1.0 → 0.1.1
- **0.1.0 → 0.1.1** (PR #34): OC bootstrap wires `sentinelsMdIO` for the sentinel blank.

### Added — `@opencues/gemini-cli` 0.1.0 → 0.1.1
- **0.1.0 → 0.1.1** (PR #34): Gemini bootstrap wires `sentinelsMdIO` for the sentinel blank.

### Added — `@opencues/shell` 0.1.0 → 0.1.1
- **0.1.0 → 0.1.1** (PR #34): Shell (`oc-edit`) bootstrap wires `sentinelsMdIO` for the sentinel blank.

### Added — new packages introduced this period
- **`@opencues/runtime` 0.1.0** — host-agnostic runtime scaffold (HostAdapter types, MockAdapter, conformance suite). Replaces the inline runtime code that previously lived in the CC patch.
- **`opencues` CLI 0.1.0** — front-door CLI (`opencues install <host>`, `opencues run <host>`, `opencues doctor`, `opencues review`, `opencues check-keys`, `opencues set-key`, `opencues seed-configs`, `opencues update`).
- **Per-integration `package.json`** scaffolding — each integration ships its own version + compat metadata for `opencues update` to consume.
- **`@opencues/chrome` 0.1.0** — MV3 extension with CSS Custom Highlight API for in-page rendering, contenteditable + Lexical + ProseMirror + Draft.js engine support.
- **`@opencues/gemini-cli` 0.1.0** — Gemini CLI 0.41.x integration (React/Ink host).
- **`@opencues/terminal` 0.1.0** — standalone Bun + OpenTUI app (`oc-edit`). Later evolved into `@opencues/shell` (the `oc-shell` tmux-popup launcher).
- **`@opencues/codex` 0.0.1** — integration skeleton (Stage 1, not user-ready).
- **`opencues` (placeholder) 0.0.1** — minimal placeholder published to the npm registry to reserve the package name. Handover runbook in `CLAUDE.md`.

### Changed
- **Renamed `blank-llm-*` (singular) → `blanks-llm-*` (plural)** for the blanks bucket scalars (core 0.1.0 → 0.1.1). Runtime reads both names; `seed-configs` rewrites legacy → new in place on the next `opencues install` run. Back-compat fallback to be removed in a future release.

### Fixed (paired with version bumps above)
- **`applyOpencuesScalar` race on back-to-back disk writes** (runtime 0.1.2 → 0.1.3) — ConfigIntent's provider-verdict apply path writes two scalars sequentially (`<scope>-llm-provider`, then `<scope>-llm-model`). The previous fire-and-forget disk write let the second invocation read the file before the first write landed, so the final file held only one of the two scalars. Fix awaits the `ProcessHandle.result` from `blankInvoke` / `spawnProcess`.
- **`opencues update --to <ver>` crashed on the post-install hint path** (CLI 0.1.2 → 0.1.3) — `compatLib.isTested` was defined but not exported, so the success-line hint that suggests adding the version to `compat.tested` threw `TypeError`. Host had already pinned + installed by that point — the user impact was just a confusing trailing stack. Fixed by exporting `isTested` and `isKnownIncompatible`.

---

## [0.1.0] - 2026-04-10

Initial pre-release. All core features implemented with a working Claude Code integration.

### Features

#### Navigation & Interaction
- **Feature 1: Navigation** — Ctrl+Alt+Left/Right moves between interactive words (cue-controls, step patterns, local tips, LLM alternatives, multi-word spans). Index-based targeting skips non-interactive words.
- **Feature 2: Cycling** — Ctrl+Alt+Up/Down replaces the focused word through a five-tier priority: custom cue-controls → control-bound blanks → step controls → consume-all alts → LLM alternatives. Linked words synchronize automatically.
- **Feature 3: Visual Cues** — Real-time ANSI styling with three visual states: normal (white), dimmed (gray, has alternatives), highlighted (bold white, currently focused). Dimming appears within ~500ms of typing.
- **Feature 4: Cursor Preservation** — Cursor offset adjusts automatically when a replaced word differs in length, keeping the editing position stable during cycling.

#### Cue Sources
- **Feature 5: Linked Words** — LLM detects semantic pairs (e.g. "boy"/"his") and cycles them together to the same alternative index when either is changed.
- **Feature 6: Local Cues** — O(1) hash-map lookup from a JSON tips file provides instant alternatives (<5ms) without LLM round-trips. Merged with LLM results; tip-sourced words are never overwritten.
- **Feature 7: Remote Cues** — LLM-generated alternatives via a resolver that classifies source scope (word vs blank), applies priority, and combines multiple domain sources (grammar, legal, medical, financial) into a single API call.

#### Blanks
- **Feature 8: Fill-in-the-Blank** — Type `_` and get contextual completions. 10 built-in modes: math (`2+2=_` → `4`), factual (`capital of France is _` → `Paris`), translation, unit conversion, spelling, color codes, HTTP codes, timezone, roman numerals, and grammar. Three-stage classification: regex → keywords → LLM classifier.
- **Feature 9: Multi-Word Spans** — Alternatives that are multiple words (e.g. "Jeff Bezos") navigate, dim, and cycle as a single unit. Span tracking maintains original indices across word-count changes.

#### Controls
- **Feature 11: Cue-Controls** — Words that trigger external scripts on cycle. Navigate to "volume" and press Up/Down to change actual system volume. Supports DynDef-bound step matching (e.g. `50%` adjacent to a `volume` keyword), list-based values, and dynamic script outputs.
- **Feature 12: Control-Bound Blanks** — `volume _` auto-populates with the live system value; cycling writes back via script. Supports numeric step, string format, read-only, dismissible, suffix display, keyword expansion, and keyword clearing. Multi-word keywords match consecutive words as a single phrase.
- **Feature 17: Selector + Satellite Blanks** — `opencues settings _` expands into two linked words: a selector that picks a setting and a satellite that shows/writes its value. Cycling the selector swaps the satellite's entire alt list. The backing config (`OPENCUES.md`) uses a unified `settings:` block with colocated values and per-value tips. Indent-agnostic parser detects structure by key names, not whitespace.

#### System
- **Feature 10: Per-Word Clearing** — Editing text intelligently preserves alternatives at unchanged positions. Only words that actually changed are invalidated. Selector/satellite pairs cascade: clearing either side clears its partner.
- **Feature 13: Auto-Submit** — Three-tier debounced analysis triggers LLM resolution automatically: space-typed (immediate), typing-pause (350ms), mid-edit (1s). Eager tips lookup pre-populates before debounce fires.
- **Feature 14: Cursor Export** — Synchronous JSON export of highlight state to `/tmp/` on every render, consumed by the status line script and available to external tools.
- **Feature 15: Secondary Display** — Status line shows cue-tips and cycle position for the focused word. Per-alternative tips during cycling. Suppressed when no tip resolves.
- **Feature 16: Hot-Reload Config** — TTL-based polling (~2s) reloads all `.md` config files without restart. Parse errors preserve the previous config. Covers CUES.md, BLANKS.md, controls, OPENCUES.md.
- **Feature 18: Tip Priority** — Fixed resolution order: satellite per-value tips → selector tips → control blank tips → cue-control script tips → local cue tips → LLM tips. Control-bound words are shielded from LLM overwrite.

#### Controls Included
- **Volume** — System volume control with word-based (Up/Down key presses) and blank-based (exact set via Core Audio API) cycling
- **Brightness** — Screen brightness control via blank
- **Affirmations** — Static list control cycling through motivational phrases
- **Stocks** — Read-only API control fetching live stock prices from Finnhub (reddit, nvidia, apple, google, microsoft, amazon, tesla, meta)
- **Weather** — Read-only API control fetching live weather from Open-Meteo (any city/country, today/tomorrow/weekend/weekly)
- **Hacker News** — Dynamic list control fetching live HN front page titles via RSS
- **Prompt Improver** — Consume-all control with two-step LLM (model + prompts in `cue.md`): extracts prompt/conditions, returns 3 improved versions + original as cycling alternatives. First control using `blankConsumeAll`.
- **OpenCues Settings** — Selector+satellite control for live OpenCues configuration (voice-mode, debug-mode, tips-mode, output-format, display mode)

### Project

- **opencues-core** — Pure TypeScript library (resolver, config parser, HTTP adapter, 5 source types, 5 response parsers)
- **Claude Code integration** — via tweakcc patches (wordHighlight.ts, dynamicHighlight.ts, cursorStateExport.ts)
- **418 unit tests** across 6 test files + 390-sentence live benchmark
- **19 feature concept docs** + 8 implementation guides + glossary
- **8 Claude Code integration docs** covering all implementation details
- GitHub org at `opencues/opencues`
- Issue templates, PR template, CODE_OF_CONDUCT.md, SECURITY.md
- Pre-launch checklist with audit results

[0.1.0]: https://github.com/opencues/opencues/releases/tag/v0.1.0
