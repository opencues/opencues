# Universal Integration — the no-cycling profile

A class of OpenCues attach mode for surfaces that **can't paint colour
on text** and **can't intercept keyboard cycling shortcuts**
(Ctrl+Alt+arrows). The runtime detects this profile, infers which
cues/blanks need cycling to be useful, and prunes the rest at
registration time.

Hosts running in this profile today: chrome's normal `<input>`
/ `<textarea>` attach mode, and the **apple-notes** integration (a
polled JXA channel with no key, cursor, or render surface at all —
`adapters/universal/v1/` (the shared band — each daemon declares its
`hostName`) advertises `supportsCycling(): false`
statically). The design extends to future read-only contexts, embedded
inline widgets, accessibility-driven attach modes, and anywhere else
the user can produce text but not navigate alternatives.

Read this before touching:

- `packages/opencues-core/src/sources/build-sources.ts:buildSourcesFromConfig` — the source-level filter.
- `packages/opencues-core/src/sources/blank-source.ts:isBlankConfigCycleable` — the per-`BlankConfig` inference helper.
- `packages/opencues-runtime/src/modules/blank-fill.ts:matchKeyword` — the BlankFill-side filter (parallel detection path).
- `packages/opencues-runtime/src/adapter.ts:HostAdapter.supportsCycling` — the adapter capability.
- `packages/opencues-runtime/src/modules/resolver.ts:computeBuildKey` — reactive rebuild on focus change.
- `integrations/chrome/src/opencues-bootstrap.ts:isNormalInput` + `isSensitiveField` — chrome's per-target classification.

## The rule

**A source/blank is universal-compatible iff it's not cycleable.**

"Cycleable" means: the user picks between alternatives via cycling
controls. That collapses two requirements into one:

1. The host can intercept Ctrl+Alt+Up/Down/Left/Right.
2. The host can paint visual feedback (highlight band, dim,
   selector overlay) so the user sees what they're cycling.

Where one's absent, the other is useless — you can't navigate
invisible alternatives, and visible alternatives without
navigation are just a static display. So a single boolean
captures the gate.

## The inference

Every `CueSource` exposes `isCycleable: boolean`. The value comes
from the source class + its definition shape — no frontmatter
edits needed.

| Source type | `isCycleable` | Inferred from |
|---|---|---|
| `ConfigSource` (word-cues) | `true` (constant) | Class identity — cues by definition surface alternatives |
| `RoutedWordSourceGroup` | `true` (constant) | Wraps word-cue ConfigSources |
| `LocalCueSource` (tips files) | `true` (constant) | Class identity — tips include alternatives |
| `SentenceCueSource` (`scope: sentence`) | `true` (constant) | Ctrl+Alt+Up cycles between sentence rewrites — pruned in no-cycling profiles (chrome normal-`<input>`) |
| `FluidBlankSource` | `false` (constant) | Single LLM answer per `_` |
| `TransformBlankSource` | `false` (constant) | Single LLM rewrite of the buffer |
| `BlankSource` | `false` (post-prune) | The defs map is pre-filtered before construction; the source itself never claims cycleable cues |
| Individual `BlankConfig` (via `isBlankConfigCycleable`) | derived | See below |

`isBlankConfigCycleable(blk)` reads each `BlankConfig`'s shape and
returns true iff the blank declares **how** to cycle:

1. `blankSatellite: true` → **true** (selector/satellite shape — `opencues settings _`)
2. `stepValues.length > 1` → **true** (list cycling — `affirmation _`)
3. `blankStep` numeric → **true** (numeric step — `volume _`, `brightness _`)
4. otherwise → **false** (fetch blanks, plain scripts, single-shot impl blanks like weather/stocks — read-only by default)

A blank is **read-only by default**: cyclers self-declare via
`blankSatellite` / `stepValues` / `blankStep`. A plain `blankScript:`
(weather/stocks/dictionary) is one-shot and survives universal hosts
without any opt-out flag. (A fetch blank whose script returns MULTIPLE
lines still rotates its results via the SpanFillState alternatives path —
that's independent of this inference, which only governs the get/set/step
cycle affordance + the no-cycling-host prune.)

## The adapter contract

`HostAdapter.supportsCycling?(): boolean` — **dynamic** (called per
build), **defaults true** when omitted.

Chrome implements it via the bootstrap's `supportsCycling: () =>
!isNormalInput(currentTarget)` binding. On every resolver rebuild
(triggered by config edits or focus changes), chrome reports the
answer for the currently focused element.

Terminal hosts (CC / OC / gemini-cli) don't implement the method
— they have one universal cycling mode. The adapter defaults to
`true` and they keep behaving as before.

## The filters — two parallel code paths

OpenCues has TWO independent paths that bind cycleable cues/blanks
to user input. Both must filter at registration time, or the
guarantee leaks.

**Path 1 — resolver sources** (`buildSourcesFromConfig`):

```
Resolver.rebuildResolver()
  → buildSourcesFromConfig({ ..., supportsCycling: adapter.supportsCycling() })
  → if !supportsCycling:
      - skip every word-cue source (cycleable by class)
      - prune cycleable BlankConfig entries from the blanks map
        BEFORE constructing BlankSource
      - FluidBlank + TransformBlank + non-cycleable BlankSource
        survive
```

**Path 2 — BlankFill keyword detection** (`matchKeyword`):

```
BlankFill.onUnderscoreKey / on-text-change
  → matchKeyword(words, blankIdx)
  → for each entry in configLoader.blanks:
      - if !adapter.supportsCycling() && isBlankConfigCycleable(blank): skip
  → first match wins → slot dispatched
```

`BlankFill` works directly off `configLoader.blanks`, NOT off the
filtered output of `buildSourcesFromConfig`. The first version of
the universal-mode filter only patched path 1, and `volume _` in a
normal input still populated because BlankFill claimed it via path
2.

Both paths now import the same `isBlankConfigCycleable` predicate
from `@opencues/core` (verified at `build-sources.ts:25` and
`blank-fill.ts:12`). Since they call the identical function, they
cannot drift on cycleability semantics — adding a new "cycleable"
condition automatically propagates to both. The remaining
correctness obligation is that each filter site actually CALLS the
predicate; a third path that bound cycleable defs to user input
without consulting it would re-introduce the bug. Tests
(`build-sources.test.ts`, the chrome end-to-end suite) pin both
sites' filter calls.

When either filter trips, an info log fires:

```
buildSources: skipping cycleable blank 'volume' — host has no cycling surface
```

Gated behind `debug-mode: on`. Loud enough to investigate, quiet
enough not to spam the page console on every keystroke.

## Reactivity — focus change

In chrome, the user can focus a contenteditable in one moment and
a plain `<input>` in the next. The set of registered sources must
follow.

`Resolver.computeBuildKey` includes the answer to
`adapter.supportsCycling?()` in its fingerprint. Each text-change
recomputes the key; mismatch with the stored value triggers
`rebuildResolver()`, which re-runs `buildSourcesFromConfig` with
the fresh capability answer.

Net effect: when chrome focus moves CE → normal-input, the next
keystroke rebuilds with cycleable sources pruned. Move back to a
CE, the next keystroke rebuilds with them restored. No reload, no
manual recapture — the resolver self-heals on the focus boundary.

### Per-buffer state must reset on focus change

A subtler concern this profile introduces: chrome's normal-input
mode means a SINGLE page can attach to MANY independent buffers
(every `<input>` / `<textarea>` on the page). The runtime's
per-buffer state objects are keyed by word-index in the current
buffer. Leftover entries from a prior field silently corrupt the
new one.

The canonical bug (caught May 2026): user types `_` on a LinkedIn
URL field, gets substituted. A `DynDef` is registered at wordIndex
0 with `blankName: 'fluid-blank'`. User tabs to a GitHub URL field
on the same page, types `_`. The Resolver's "don't clobber
blank-bound entries" guard (`if (existing.blankName) continue;`)
silently refuses the new substitution because dynDefs[0] is still
the LinkedIn-relevant entry. Symptom: bare `_` returns nothing,
`answer _` works (because `answer _` has `_` at wordIndex 1, not
0). No log line, no error — completely silent.

Fix: `BootResult.resetBufferState()` clears per-buffer state on
focus change. The chrome bootstrap's `publishTarget(el)` calls it
when `el !== currentTarget`. The contract:

| State | Cleared on focus change? | Why |
|---|---|---|
| `DynDefs` | yes | word-position keyed; the canonical bug |
| `HighlightState` | yes | stale highlight = wrong word marked "current" in new buffer |
| `SpanFillState` | yes | in-flight span-fill from A would land in B at same char range |
| `SelectorSatelliteState` | yes | user mid-cycle on settings in A would resume on B (wrong-buffer writes) |
| `AgentTaskState` | **NO** | armed `agentically X _` task is session-scoped — user expects continuity if they leave + return to a contenteditable |
| `dismissedBlanks` | **NO** | dismissing `weather _` should carry across fields within the page session |

### Implications for future hosts in this profile

Any new host adapter advertising `supportsCycling: false` AND
exposing multiple focusable buffers within one runtime instance
MUST call `BootResult.resetBufferState()` on the focus-change
event. The native hosts (CC, OC, gemini-cli) work on ONE buffer
per runtime instance — this call is a no-op there, safe to omit.

If you're adding a host where the user can focus multiple
independent text fields (a VS Code extension with form views, a
browser extension for a different browser, a desktop UI with
multiple inputs) — the per-buffer state reset is a real
correctness concern, not a chrome quirk.

### When to call `resetBufferState()` — the full trigger list

`supportsCycling: false` + multi-buffer is one trigger. Any host
where the SAME runtime instance sees the buffer content swapped /
discarded / replaced needs to fire `resetBufferState()` at the
boundary. There are FOUR distinct triggers — a host needs to fire
on whichever apply:

| Trigger | Examples | Why |
|---|---|---|
| **Focus moved to a different field** | chrome tabbing between `<input>`s | per-buffer state keyed by word-index in the OLD buffer; corrupts the new one (the canonical bug above) |
| **Same field, buffer replaced externally** | paste, undo, redo, IME commit, programmatic `.value =` from the page | offsets the runtime tracks point at chars that no longer exist; next cycle splices at stale positions |
| **Session boundary in a keep-alive process** | shell's `oc-edit --keep-alive` between Alt+Shift+↑ opens, a hypothetical VS Code panel that re-opens, any "submit then re-open" lifecycle in one host process | state from session N leaks into session N+1; a transform-blank from N's DynDef blocks N+1's first blank silently via `existing.blankName` guard |
| **Buffer fully cleared by host UI** | shell's Ctrl+C wipe, a "new session" button, slash command like `/clear` (when the implementation doesn't go through `pushText`) | analogous to undo — the visible buffer no longer matches the offsets the runtime tracks |

Hosts that hit ONE of these reliably need ONE call site. Hosts
that hit multiple need multiple. Examples in the tree:

| Host | Triggers handled | Call sites |
|---|---|---|
| chrome | focus change + buffer-replaced (paste/undo/redo/IME) | `publishTarget(el)`, `notifyBufferReplacedExternally()` |
| shell (oc-edit) | session boundary (submit/cancel close the pane in keep-alive) | `app.tsx:finish()` → `resetOpenCuesBufferState()` |
| claude-code / opencode / gemini-cli | none (single buffer per process; runtime restarts on session end) | n/a |

### Symptom catalogue — when you've missed a reset

When `resetBufferState()` should have fired but didn't, the
failure mode is **silent**. No error log, no crash. The runtime
just silently does the wrong thing. The two most common symptoms:

| Symptom | Likely missing reset |
|---|---|
| Bare `_` returns nothing; `answer _` (or any `<keyword> _`) works fine | DynDef with `blankName` set still occupies wordIndex 0 from a prior session/buffer. Resolver's `if (existing && existing.blankName) continue` guard fires. **Add a reset on session boundary or focus change.** |
| Cycling Ctrl+Alt+↑/↓ swaps in stale text from a previous cue | HighlightState or SelectorSatelliteState still pointing at the prior buffer's word indices |
| Dim ranges paint over the wrong words | DynDefs from prior buffer with `spanStart/spanEnd` referring to old offsets |

If you see any of these in a new integration, audit your reset
call sites against the trigger table above. The runtime exposes
exactly one primitive (`resetBufferState()`) — the integration is
responsible for calling it at the right moments.

### Checklist for any new integration

Walk this before shipping:

1. Does the runtime instance ever see more than one logical
   buffer? (Multiple focusable fields, OR multiple sessions in one
   process, OR an explicit "clear" UI that doesn't go through
   `pushText`.)
2. If yes — identify the boundary event(s). Wire each one to
   `BootResult.resetBufferState()`.
3. For each boundary type, write a scenario test that:
   - Substitutes a blank in session A (registers a DynDef with
     `blankName` set)
   - Crosses the boundary
   - Asserts that the SAME blank trigger in session B substitutes
     correctly (i.e. the stale DynDef doesn't block it)
4. Document in the integration's CLAUDE.md which boundary events
   call reset — future maintainers should be able to grep for
   "resetBufferState" or "reset state" and find them.

The bug class this prevents is silent and only surfaces after the
user has already used the integration for a real workflow. Cheap
to wire up front, expensive to debug after.

## Chrome — what's NOT eligible for normal-input mode

Even within the universal profile, chrome refuses to attach to
inputs that look like credentials, payment, or sensitive PII. The
runtime would otherwise read + write through the LLM pipeline,
which is a no.

The detector is `isSensitiveField()` in `opencues-bootstrap.ts`.
Triggers when ANY of these are true:

**Formal autocomplete signal** (page conforms to web standards):

- `autocomplete="current-password"` / `"new-password"` — password fields
- `autocomplete="one-time-code"` — OTP / 2FA codes
- `autocomplete="cc-number"`, `"cc-exp"`, `"cc-exp-month"`, `"cc-exp-year"`, `"cc-csc"`, `"cc-name"`, `"cc-given-name"`, `"cc-family-name"` — payment fields
- `autocomplete="off"` only when nearby field/form metadata also matches `SENSITIVE_AUTOCOMPLETE_OFF_CONTEXT_PATTERN`; ordinary search boxes often use `off` and remain attachable

**Name/id heuristic** (fallback for pages that don't bother with autocomplete):

Case-insensitive word-boundary match on the field's `name` or
`id` against `SENSITIVE_FIELD_NAME_PATTERN` (exported from
`integrations/chrome/src/opencues-bootstrap.ts`). See
`docs/architecture/chrome-security.md` § Sensitive-field gate for
the current token enumeration.

**Input type allowlist** (every check above runs only after this):

Allowed: `<textarea>`, `<input type="text|email|search|url">`.
Everything else (`number`, `date`, `tel`, `color`, `hidden`,
`password`, etc.) is excluded before the sensitive check even
runs — semantic inputs would have surprising fill behaviour, and
`type=password` is the formal mechanism to declare "this is a
secret" regardless of attribute heuristics.

False positives (a legitimate search box named `search-token`)
silently lose OpenCues. Acceptable — the alternative is feeding
the user's credentials through an LLM, which is not.

## Future hosts in this profile

The cycleability filter is the contract; chrome's normal-input
mode is just one implementation. Future integrations that fit:

- **Read-only attach** — surfaces where the user reads text but
  can't edit it. Word-cue alts can't apply (no edit); blanks make
  no sense (no `_` to fill). All universal-incompatible by
  definition.
- **Inline form-filler widget** — a floating panel that types into
  the host page's inputs without intercepting their key events.
  Single-answer blanks (weather/stocks/transform) make sense;
  cycling blanks don't.
- **API client / pipe mode** — `opencues < input.txt > output.txt`
  shell pipe. Single answer per `_` is natural; cycling has no
  meaning in a one-shot pipeline.

For any of these, the host advertises `supportsCycling: false`
once at adapter construction (or per-call when the answer is
dynamic, like chrome). The filter takes care of the rest.

## Tests

- `packages/opencues-core/src/sources/build-sources.test.ts` — 12 scenarios pinning the inference + filter (every shape of `BlankConfig`, the filter behaviour at `buildSourcesFromConfig`, the word-cue drop, empty-survivor handling).
- `packages/opencues-runtime/src/modules/blank-fill.test.ts` — when added, should pin that `matchKeyword` skips cycleable defs on no-cycle adapters (today's gap; flagged for future work — currently relies on the chrome integration's end-to-end test).
- `integrations/chrome/src/...` — focus a CE, `volume _` cycles. Focus a normal input, `volume _` silently doesn't populate. Focus an `<input autocomplete="current-password">`, OpenCues doesn't attach at all (no `[OpenCues] Attaching to` log).
