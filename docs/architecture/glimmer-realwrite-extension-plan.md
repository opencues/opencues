> **SUPERSEDED (2026-08-29).** Real-write mode is retired and its
> machinery deleted from `glimmer-render.ts`: chrome moved to a
> host-owned CSS Highlight engine after the Gmail freeze, and
> OpenCode/shell moved to overlay-painted render-only frames — see
> `glimmer-opentui-overlay-plan.md`. Kept as the design record of
> why real-write existed and what it cost.

# Glimmer real-write extension — plan + per-host side effects

⚠️ **POSTMORTEM (August 2026): chrome is now DISABLED, not just
unverified.** This doc's own guidance below — "Don't treat chrome as
done until the e2e suite AND a manual multi-site check both pass" —
was only half-followed: the e2e suite (synthetic contenteditable
fixture) passed, and that got treated as enough to leave the feature
wired. The manual multi-site check against a real managed editor never
happened before shipping. Real-write mode on Gmail caused the whole
tab to freeze — glimmer's ~13 execCommand writes/second on a real
editor's heavy DOM reconciliation is nothing like the synthetic
fixture page's near-instant echo, and the reclassifier's timing
assumptions broke under that load. `glimmerRealWrite` is now forced
`undefined` for chrome (`adapters/chrome/v1/boot.ts`), unconditionally.
Full incident writeup: `CHANGELOG.md` § "glimmer's real-write mode
froze Gmail tabs". **Lesson for next time: an e2e suite against a
synthetic page cannot stand in for the manual multi-site check this
doc already told us we needed — treat that line as a hard gate, not
optional follow-up.**

✅ **IMPLEMENTED and LIVE-VERIFIED for OpenCode and shell; wired but
UNVERIFIED for chrome.** `GlimmerRender` now supports both modes
(`GlimmerRenderOptions.realWrite`) — render-only (Claude Code, Gemini
CLI, unchanged) and real-write, which does exactly what this doc
originally proposed: real per-tick `setText` calls marked through the
host's source-reclassifier. Both OpenCode and shell are confirmed via
the agentic test harness: real scramble frames observed in OpenCode's
setText trace, and `glimmer: start` firing (with correctly
hot-reloaded parameters) in a live shell session. Shell's own build was
blocked at first by an unrelated, pre-existing monorepo-wide Babel
version conflict (root `package.json`'s `pnpm.overrides` for
`@babel/core` had an unbounded upper range that picked up the new
Babel 8 major release) — fixed alongside this work since it blocked
verification entirely. Chrome is wired (the plumbing below is correct)
but **genuinely unverified**: its write path is documented as
empirically fragile in `integrations/chrome/CLAUDE.md` § "The biggest
issue: writing into managed contenteditables", and this pass had no
live Chrome browser to test against. Don't treat chrome as done until
the e2e suite (`npm run build && npm run test:e2e:chrome`) and a manual
multi-site check (the Verified-Working-Sites matrix in that doc) both
pass with glimmer active.
This doc's original framing (below, unedited) traces the mechanism —
real per-tick `setText` writes, protected by the source reclassifier —
and the per-host side effects each one inherits. Still worth reading
before touching `glimmer-render.ts` or any host's animation-tick write
path; it's no longer a *plan*, it's *how it works*.

---

## Correcting the mental model: it's not a flag on a span

The intuitive guess — "assign each pass of the span a flag that prevents
re-analysis" — is close in spirit but not how it actually works, and the
real mechanism is worth knowing precisely because its *shape* determines
what does and doesn't get protected.

**`createSourceReclassifier`** (`packages/opencues-runtime/src/boot-common.ts`)
is a small stateful helper with two calls:

```ts
markRuntimeWrite(text: string): void
reclassify(text: string, proposedSource: 'user' | 'runtime'): 'user' | 'runtime'
```

- `markRuntimeWrite(text)` stashes the **exact resulting full-buffer text**
  the runtime just wrote, timestamped.
- `reclassify(text, proposed)` checks whether the **incoming** text-change
  event's full text exactly matches any stashed entry younger than
  `RUNTIME_WRITE_TTL_MS` (1500ms). If it matches, the event's source is
  flipped to `'runtime'` regardless of what the host guessed; otherwise the
  proposed source passes through unchanged.
- The match is **non-consuming** — one write can seed multiple matches. This
  matters because DOM-reconciliation pipelines (Lexical, ProseMirror, Gmail
  compose, SolidJS) fire 2-4+ echo events per programmatic write, and an
  early one-shot version of this helper caused a real runaway loop (a
  TransformBlank substitute's first echo was reclassified correctly, but
  later echoes arrived after a naive single-match state was already
  consumed, got tagged `'user'`, and re-triggered the whole pipeline).
- Stale entries prune themselves; nothing is span-scoped, word-scoped, or
  keyed by any kind of "pass" — it is **pure exact-string matching against a
  short rolling window**, host-agnostic, defined once and imported by every
  bootstrap.

So there's no per-span flag anywhere. There's a rolling stash of "text the
runtime itself just produced" and a TTL-bounded exact-match check that any
`onTextChange` consumer *can* choose to honor.

## What the reclassifier actually protects — and what it doesn't

This is the part worth being precise about, because it's not universal —
each `onTextChange` subscriber decides independently whether to check
`e.source`:

| Module | Subscribes to `onTextChange` | Checks `e.source` | Effect of a marked-runtime write |
|---|---|---|---|
| **BlankFill** (`blank-fill.ts:1069`) | yes | **yes** — `if (e.source !== 'user') return;` at the top of the handler | Entire handler short-circuits: no `_`-slot scanning, no blank triggering, no selector/satellite invalidation. This is the mechanism that stops a runtime write from re-firing FluidBlank/TransformBlank/ConfigIntent. |
| **AgentRewrite** (`agent-rewrite.ts:281`) | yes — `onTextChange(() => this.scheduleTick())` | **no** | Every text-change event, marked or not, resets AgentRewrite's debounce timer. |
| **ConfigLoader** (`config-loader.ts:919`) | yes — `onTextChange(() => { void this.maybeReload(); })` | **no** | Every text-change event calls `maybeReload()`. Cheap in practice (self-debounced/mtime-gated internally), but still invoked unconditionally. |

Glimmer's own header comment names all three ("poison the resolver
dispatch, BlankFill's span invalidation, AgentRewrite's debounce reset,
ConfigLoader.maybeReload") as reasons it stayed render-only. Tracing the
actual code shows the reclassifier only structurally protects **one** of
those three (BlankFill). AgentRewrite's debounce reset is **real and
currently unprotected** — it's just tolerated today because the only
existing real-write animation (blank-loading) runs *before* a blank result
exists, when delaying a pending AgentRewrite tick is arguably the right
behavior anyway (you don't want a rewrite landing mid-fill). Glimmer's use
case is different: it animates *after* a real, final answer has already
landed, when the user may resume typing (and want AgentRewrite ticking)
within the ~900ms glimmer window. Repeatedly resetting AgentRewrite's
debounce for up to ~900ms on every landed substitution is a genuine new
side effect a real-write glimmer would introduce — not something the
reclassifier already covers. This needs an explicit decision (see
"Open risks" below), not an assumption that "marking the write" makes it free.

## The proven precedent: blank-loading

`packages/opencues-runtime/src/modules/blank-loading.ts` already does real
per-tick writes, successfully, on all five hosts. It's the working template
to scale from:

- **One fixed-position character.** The animated glyph occupies the exact
  same buffer column as the `_` it replaces (`bounce`: `_ → - → ‾ → -`,
  4-frame palindrome). Buffer *length* never changes.
- **Real `adapter.setText`/`pushText` calls**, one shared `setInterval`
  across all active slots, every ~150ms (`blank-loading-interval-ms`,
  clamped `[30, 2000]`).
- **Every write calls `sourceReclassifier.markRuntimeWrite(text)` first.**
  This is what stops each tick from re-triggering BlankFill's own
  `_`-scanning on its own frame character.
- **A known, already-fixed failure mode**: issue #348
  (`integrations/chrome/tests/e2e/reclassifier-poison.e2e.test.ts`). On an
  empty field, the bounce animation's frame *is* the literal string `"_"`
  — the same shape as a bare `_` trigger. `markRuntimeWrite('_')` seeded the
  reclassifier's stash with `"_"`, and within the 1.5s TTL a **user's next
  real bare-`_` fill** exactly matched that stale entry, got reclassified
  `'runtime'`, and BlankFill silently skipped it — the second `_` did
  nothing until the TTL expired or the user retyped. The fix was **not** a
  smarter match — it was recognizing that this particular write path's DOM
  echo is `isTrusted=false` and always dropped anyway, so it had no reason
  to call `markRuntimeWrite` in the first place. **Lesson for glimmer**:
  the exact-match reclassifier is a blunt instrument — a `markRuntimeWrite`
  call is a real (if narrow) footgun whenever the marked text is short or
  generic enough to plausibly recur as real user input within 1.5s.
  Glimmer's scrambled multi-character frames (confusable-glyph churn over
  a whole word/phrase) are astronomically less likely to coincidentally
  equal a future real buffer state than a bare `_`, but the risk class is
  real and should be named, not assumed away.

## Per-host side effects

Every host wires the *same* `createSourceReclassifier` instance/pattern,
but each has its own extra bookkeeping a per-frame write must also survive.
Verified against each bootstrap's actual write path (not the shared
`adapters/<host>/vX/` band files alone — the real wiring lives in each
integration's bootstrap file):

### Claude Code (`packages/opencues-runtime/adapters/cc/v2.1/boot.ts`)

- `sourceReclassifier` created directly in `boot.ts` (CC predates
  `buildSharedRuntime` and hand-wires its own modules — see the
  `boot-bands-wiring.test.ts` note elsewhere in this repo).
- `setText`/`pushText` call `markRuntimeWrite(visible(text))` — note the
  `visible()` wrapper: CC's ZWS-toggle rendering trick means the *marked*
  text must be the ZWS-stripped visible form, matching what the terminal's
  echo will actually contain, or the exact-match check silently never
  fires.
- No extmark/decoration side effect to manage — CC's highlight state is
  ANSI-escape based and recomputed from scratch on every render tick
  anyway, so it isn't "wiped" by a write the way OpenTUI's extmarks are.
- **Side effect a real-write glimmer inherits for free**: none beyond the
  shared AgentRewrite/ConfigLoader exposure above — CC's render path is
  already the simplest of the five.

### Gemini CLI (`integrations/gemini-cli/patches/opencuesBootstrap.ts`)

- **Pull-model, not push-model.** The runtime queues pending
  `setText`/`forceRender` as flags; Gemini's own render path calls
  `consumePendingOpenCues()` each render to *pull* the new state and write
  it back via `buffer.setText()` **directly** — bypassing the normally
  wrapped `setText` that marks runtime writes automatically.
- Consequence: `markRuntimeWrite` has to be called **manually, at the pull
  site**, not inside a generic `setText` wrapper. Skipping this was a real
  bug: the next `notifyOpenCuesTextChange` fired with `source='user'`,
  which `Navigation` read as the user typing and deactivated the active
  highlight — the "flash and release" symptom on every Ctrl+Alt+arrow
  press.
- **Implication for a real-write glimmer on Gemini**: every animation tick
  would need to go through this same pull-then-mark path (Gemini's
  `InputPrompt` React `useEffect` on `buffer.text` is what actually
  triggers the repaint), not a naive direct `setText` call — the render
  loop itself is the write trigger here, inverted from every other host.

### OpenCode (`integrations/opencode/patches/opencuesBootstrap.ts`)

- `setText`/`pushText` call `markRuntimeWrite(text)` before writing to
  `promptAccess`, same shape as CC.
- **OpenTUI's `editBuffer.setText` clears every extmark as a side effect.**
  The bootstrap explicitly zeroes its own `ocOwnedExtmarks` map after every
  write and rebuilds it on the next render. Any active dim/highlight
  decoration is invisible for one frame after every write.
- **Implication for glimmer**: at glimmer's ~70ms cadence (vs
  blank-loading's ~150ms), this extmark wipe-and-rebuild would happen
  roughly twice as often during the animation window. If any *other*
  decoration (a selector/satellite highlight, a dim range) is active on
  the same buffer at the same time, it would flicker at glimmer's frame
  rate unless the rebuild is proven cheap enough to be imperceptible —
  worth a scenario test, not an assumption.

### Shell (`integrations/shell/src/bootstrap.ts`)

- Near-identical to OpenCode (documented elsewhere as a structural
  near-clone on the same OpenTUI primitives): `markRuntimeWrite` before
  write, same extmark-clearing side effect (`ownedExtmarks = new Map()`).
- **One extra layer OpenCode doesn't have**: shell injects a note-line
  (e.g. cue dismissal hints) into the textarea that must stay invisible to
  the runtime. `getText`/`getCursor` strip it (`stripInjection`/
  `stripCursor`) before the runtime ever sees the buffer, and `setText`
  writes the **clean** (uninjected) buffer, relying on the next render to
  re-add the injection if still needed.
- **Implication for glimmer**: every animation-tick write must go through
  the same strip/re-inject round-trip, or a glimmer frame could clobber an
  active injected note-line (or vice versa — an injected note reappearing
  mid-scramble could visually collide with the churn).

### Chrome (`integrations/chrome/src/opencues-bootstrap.ts` + `content.ts`)

By far the most complex host, and where the original multi-shot
reclassifier bug was first observed:

- Uses the same `sourceReclassifier` (imported from `boot-common`), wired
  at `integrations/chrome/src/opencues-bootstrap.ts` — **not** in the thin
  `packages/opencues-runtime/adapters/chrome/v1/` band files, which only
  proxy `onRender`/`onTextChange` through to `bindings`. The real write
  logic lives in the integration package.
- **Rich-text editors (Lexical, Quill, ProseMirror, Gmail compose) run
  their own `MutationObserver` that actively REVERTS direct DOM text-node
  mutations** that don't go through their own model (Quill's Delta model,
  Lexical's node tree, etc.). A naive per-frame `textContent =` write would
  get fought and reverted by the editor itself, not just risk a stray echo.
  Chrome's write path already has editor-specific strategies for this
  (`EXTERNAL_REPLACE_WINDOW_MS`, multi-tick `replaceAllText`, differing
  strategies per detected editor) — none of which blank-loading's
  single-character write currently has to invoke as aggressively, since a
  1-char change is far less likely to trip an editor's reconciler than a
  multi-character span rewrite.
- On a **plain, non-cycling `<input>`/`<textarea>`**, there is deliberately
  **no** `markRuntimeWrite` call on some write paths — the code comment
  notes "there is no runtime-write DOM echo to reclassify — marking here
  could only ever seed the reclassifier's `recent` list" with text a real
  user could later coincidentally type, which is precisely the issue #348
  bug class. This is a **per-write-path judgment call already made once**
  and is the strongest concrete precedent for "when should a glimmer tick
  actually call `markRuntimeWrite`."
- **Regression coverage already exists**: `reclassifier-poison.e2e.test.ts`
  is a mutation-verified Playwright test pinning exactly this failure
  mode. Any real-write glimmer work on Chrome should extend this file with
  a glimmer-specific case (a scramble frame's text should never coincide
  with a real user `_`-trigger within the TTL — trivially true today since
  frames are scrambled multi-char text, but worth pinning explicitly
  rather than relying on "it's obviously fine").

## Open risks — need a decision, not an assumption

1. **AgentRewrite debounce reset.** Confirmed above: `scheduleTick()` has
   no source gate. A real-write glimmer firing every 70ms for up to 900ms
   would repeatedly push back any pending AgentRewrite tick during that
   window on every host. Options: (a) accept it — 900ms of delay on an
   already-debounced background rewriter is probably imperceptible; (b)
   give `scheduleTick()` a source check mirroring BlankFill's, gated behind
   a flag so it doesn't change AgentRewrite's existing behavior around
   blank-loading; (c) leave glimmer render-only (status quo) and only
   extend the *render-only* path to hosts whose renderer can be taught to
   consume `textOverride` some other way. This doc doesn't pick one — that
   should be a deliberate call, made with the actual UX tradeoff in front
   of whoever ships it.
2. **Multi-character length-preservation under write, not just render.**
   `scrambleText` is already 1:1 length-preserving (a hard requirement
   glimmer's render-only path already leans on), so that constraint
   carries over for free. What's new is that a REAL write of a multi-word
   span, repeated ~13 times over 900ms, is a much bigger blast radius for
   an editor's reconciler (Chrome) or extmark rebuild (OC/shell) than
   blank-loading's single fixed character — see the per-host sections
   above.
3. **Cursor preservation.** Blank-loading's frame occupies the exact column
   the `_` occupied, so cursor drift is a non-issue by construction. A
   landed answer's glimmer span can be anywhere in the buffer, including
   before the user's current cursor — every write needs to explicitly
   preserve cursor position (all the adapters' `setText` variants used
   above already take a cursor argument or expose `setCursorOffset`
   separately; this is mechanical, not novel, but must not be skipped).
4. **Reclassifier-poison risk, scaled.** Named above under Chrome, but
   applies everywhere: mark-then-match is safe as long as marked text is
   unlikely to coincidentally equal a *different, real* future buffer
   state within 1.5s. Scrambled multi-char frames make this vanishingly
   unlikely versus blank-loading's bare `_`, but "vanishingly unlikely" is
   exactly what the issue #348 postmortem also assumed before it happened.
   Worth a mutation-style test per host, not just a confidence argument.

## Rollout status

Correction to the original plan below: Claude Code and Gemini CLI were
never real-write targets — they already animate correctly via
render-only mode, and converting them would be a pointless regression
(render-only has zero buffer-touch risk; there's no reason to trade
that away). The real-write mode is opt-in per host via
`BuildSharedRuntimeOptions.glimmerRealWrite` specifically so CC/Gemini
never set it.

1. ✅ **OpenCode** — done, live-verified. `GlimmerRenderOptions.realWrite`
   implemented in `glimmer-render.ts` (28 unit tests, including the
   settle-restore, fast-re-summon, and self-cancel-on-edit cases the
   render-only path never had to handle). Wired via
   `adapters/oc/v1.14/boot.ts` → `BuildSharedRuntimeOptions.glimmerRealWrite`
   → `integrations/opencode/patches/opencuesBootstrap.ts`'s
   `markRuntimeWrite` field. Confirmed live via the agentic harness: real
   `setText` trace showing blink → scramble → settle, e.g. `"capital of
   france _"` → `"                     "` → `"^/cnc3 c?pit6l: ParIs"` →
   `"France capital: Paris"`. The extmark wipe-and-rebuild at 70ms
   cadence (the one open question from the original plan) did not
   produce any observable flicker in this pass.
2. ✅ **shell** — wired identically to OpenCode (`adapters/shell/v1/boot.ts`
   + `integrations/shell/src/bootstrap.ts`'s `markRuntimeWrite`), same
   unit test coverage. **Live-verified.** The blocking Babel conflict
   (root cause: `pnpm.overrides` in the root `package.json` pinned
   `"@babel/core": ">=7.29.6"` — an unbounded range that silently picked
   up the new Babel 8.0.1 major release and broke `babel-preset-solid`,
   which only supports Babel 7; fixed to `">=7.29.6 <8.0.0"`) was fixed
   and `bun run bundle` now succeeds. `glimmer: start (len=…, ms=…)`
   confirmed firing in a live headless session, including picking up a
   hot-reloaded `glimmer-transition-ms` change mid-session (300 → 900,
   reflected in the very next `glimmer: start` log line). Could not
   capture an intermediate scrambled frame the way OpenCode's session
   did — `CursorStateExport`'s 100ms debounce is slower than glimmer's
   70ms frame cadence, so that diagnostic file structurally only ever
   shows the pre- and post-animation state, never a mid-flight frame,
   regardless of whether the mechanism is working. Not a gap in glimmer;
   a gap in that one diagnostic tool. Confidence in shell is otherwise
   as high as OpenCode's: same class, same config, same confirmed
   `.start()` firing, same 28/28 unit tests.
3. ⚠️ **Chrome** — wired (`adapters/chrome/v1/boot.ts` +
   `integrations/chrome/src/opencues-bootstrap.ts`'s `markRuntimeWrite`,
   reusing the same `diffWriteText` single-segment splice path every
   other chrome write already goes through), but **UNVERIFIED**. This is
   the one that actually needs the full treatment the original plan
   called out: chrome's write path is documented as empirically fragile
   (`integrations/chrome/CLAUDE.md` § "The biggest issue"), and glimmer's
   70ms cadence hammers it far more than any existing caller (cycling is
   per-keystroke, transform-blank is once-per-substitution). Before this
   can be called done:
   - Run `npm run build && npm run test:e2e:chrome`.
   - Manually re-verify the Verified-Working-Sites matrix (Gmail, Reddit/
     Lexical, Twitter/Draft.js, LinkedIn/Quill, ChatGPT+claude.ai+Luma/
     ProseMirror) with glimmer active — specifically watching for
     MutationObserver reverts on Quill/Lexical/PM, since those engines
     fight external DOM mutations and glimmer writes far more frequently
     than the existing single-shot substitution paths that were tuned
     against.
   - Extend `reclassifier-poison.e2e.test.ts` with a glimmer-specific
     case per this doc's "Open risks" #4.

Each stage should also get a `cycling.scenarios.test.ts`-style
multi-step journey test (the project's testing convention — the
SCENARIO that would catch a regression, not just a unit-level call into
`_writeFrame()`) before being considered fully done — the unit tests in
`glimmer-render.test.ts` cover the module in isolation, not a live
multi-module journey.
