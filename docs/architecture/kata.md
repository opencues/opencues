# Katas — modal guided scenarios with a live LLM coach

**Status: experimental prototype, wired on all five host bands (OpenCode,
Claude Code, Gemini CLI, Shell, Chrome). Read this before touching
`packages/opencues-runtime/src/modules/kata.ts`, the
`externallySuppressed` seam in `resolver.ts`, or the `kata` block in
`statusline.ts`.**

User-facing summary: [docs/features/kata.md](../features/kata.md).

## The idea in one paragraph

A kata is an ordered script (`katas/<name>/KATA.md` under
the standard `.cues/` search paths) the user works through in their
real editor. The runtime enters a **modal** state, observes the user's
activity as an event trace (typed snapshots, submits, salient key
presses), and runs one debounced LLM call per pause — the **coach** —
which judges progress on the current step and emits one line of
guidance. The model owns judgement; the runtime owns safety floors and
every deterministic path (control phrases, escape hatch, degraded
mode). Fidelity lives in the kata file: step bodies + `coach:`
notes ride into the system prompt verbatim, so keystroke-level
choreography, strict ordering, and hint-mode pedagogy are authoring
choices, not code.

## Module map

Everything lives in `packages/opencues-runtime/src/modules/kata.ts`:

| Piece | What it does |
|---|---|
| `parseKataMd` | frontmatter (`name`/`id`/`title`) + `## ` step sections. Steps are `{title, body}` — the body is NOT schema'd; it goes to the model verbatim. |
| `matchControlPhrase` | sentence-leading, `_`-gated triggers (same trigger model as blank shapes): `start kata [<id|name>] _`, `stop kata _`, `done|next|skip _` (active only). |
| `KataCoach` | the module: text/key observation, trace ring, control handling, coach tick, statusline feed, events. |
| `parseCoachResponse` | tolerant `STEP:/STATUS:/COACH:` + optional `CONTROL: STOP` line parser. |

Wiring (OC band, `adapters/oc/v1.14/boot.ts`):

- Constructed after `buildSharedRuntime` (needs ConfigLoader); key
  observation is registered BEFORE it — see the wiring contract below.
- `resolveLLM: () => buildKataLLMResolver(...)` — per-feature
  `kata-llm-provider/-model/-endpoint` scalars win, then the
  **auditors bucket** (background prose-reading trust class, refuses
  `trainsOnInput` providers, same as agent-rewrite).
- `Statusline` gets `kataStatus: () => kataCoach.status()`.
- `Resolver` gets `externallySuppressed: (text) =>
  kataCoach.shouldSuppressResolve(text)`.

## HOST WIRING CONTRACT — observeKey must be the FIRST key subscriber

Key dispatch is emit-until-consumed. Navigation consumes
Ctrl+Alt+arrows, hosts consume Escape/Tab — a late subscriber never
sees exactly the presses cycling katas teach. The OC boot registers
a passive forwarder on the raw key emitter BEFORE `buildSharedRuntime`
subscribes anything, with a late-bound ref:

```ts
let kataCoachRef: KataCoach | null = null;
keyEvents.subscribe(e => { kataCoachRef?.observeKey(e); return false; });
// ... buildSharedRuntime(...) ... new KataCoach(...) ...
kataCoachRef = kataCoach;
```

Any future band (CC/gemini/shell/chrome) MUST replicate this ordering.
Symptom of getting it wrong: the coach coaches "press Ctrl+Alt+Right"
forever while cycling visibly works (this happened; the fix is this
contract).

## The trace — what the coach sees

Bounded ring (10 entries) of the user's activity, wiped on
start/stop:

- `typed: "<text>"` — buffer snapshot. Coalescing is
  **attempt-preserving**: continued typing (new text extends/trims the
  last snapshot) replaces the entry; a change of direction pushes a new
  one. Full-replacement coalescing collapsed `/memory` → `/setup` →
  `/start` into one morphing entry, making reveal-after-N-failures and
  stuck-escalation uncountable. Don't reintroduce it.
- `submitted: "<text>"` — a submit. Inferred two ways so it fires
  regardless of what the host does with Enter: (1) the buffer
  transitioning non-empty → empty (CLI inputs clear on submit); (2) an
  Enter keypress on a non-empty buffer (newline hosts — Chrome
  contenteditable, Gmail, Shell — insert a newline instead of clearing,
  so the buffer-clear signal never fires). The two paths dedup against
  each other via a 1s window on the last Enter body (`_lastEnterAt` /
  `_lastEnterBody` in `observeKey` + the `onTextChange` clear guard), so
  a host that BOTH fires Enter AND clears doesn't double-count. Without
  path (2), katas-in-the-browser could never observe a Gmail send — the
  reported "Enter key doesn't work" bug.
- `pressed: <label> (×N)` — salient keys only: tab/escape/arrows
  always, enter only on an EMPTY buffer (a non-empty Enter is already a
  `submitted` entry, above), anything with ctrl/alt/meta. Plain typing
  is deliberately excluded (it's the `typed` entries). Consecutive
  repeats coalesce into a count.

Runtime-source text events and echoes of the module's own
consume-writes are excluded. Self-write matching is **TTL-based
(250ms, mirrors boot-common's `RUNTIME_WRITE_TTL_MS`)** — a
consume-on-match-forever stash swallowed the user's next buffer-clear
(i.e. killed submit detection) on any host that doesn't echo
`pushText`. Pinned in `kata.scenarios.test.ts`.

## The coach tick

Debounced (default 300ms; `kata-debounce-ms` hot-reloads) on text
changes and salient key presses; single in-flight call; stale results
dropped (kata stopped / step moved / buffer changed while in
flight → discard, re-ask).

Prompt split follows the cerebras prefix-cache rules
(`docs/architecture/cerebras.md`): the SYSTEM message (coach
instructions + the ENTIRE kata script) is byte-stable per kata
per session; the user message carries only `CURRENT STEP` + the trace +
the buffer. Measured ticks: ~250–550ms avg on cerebras gpt-oss-120b.

Response contract (tolerant parse):

```
STEP: <n>
STATUS: IN_PROGRESS | STEP_DONE | OFF_TRACK
COACH: <one line>
CONTROL: STOP        ← optional, see Security
```

### Safety floors (runtime-owned, non-negotiable)

- Step index clamped to bounds; **never moves backward**; advances **at
  most one step per tick**. A hallucinated `STEP: 7` walks forward one
  clamped step per tick (auto-walk re-asks immediately when the claim
  is further ahead).
- Advance on `STATUS: STEP_DONE` or a later-step claim; completion of
  the last step auto-stops and emits `kata.completed`.
- Coach errors / unparseable output → verdict discarded, buffer and
  progress untouched, `kata.tick {error|parseError}` emitted.

### Prompt-owned behaviour (model judgement, tune in the prompt)

Detection semantics (trust completion claims on unobservable steps;
later-step evidence completes the current step UNLESS the step's coach
notes demand strict order); meta-question handling ("help" is
IN_PROGRESS, not OFF_TRACK); responding in the user's language;
surfacing `stop kata _` / `skip _` on quit-intent and stuck-loops;
hint-mode discipline; recap-from-journal phrasing. These were all hardened by an adversarial
"dumb user" probe suite — when touching the system prompt, re-run that
class of probe (quit attempts, bare "done" claims, wrong-order inputs,
gibberish, French) on the harness before shipping.

## Idle nudge + lesson journal

`armIdleTimer()` re-arms on every user activity (text, salient keys,
Escape presses), on step advance, and at activation; window from
`kata-nudge-ms` (default 30s, `0` disables, thunk hot-reloads).
`fireNudge()`: max 2 per stall (counter resets on any activity — the
cap stops NAGGING, not re-nudging a returned user); nudge 2 appends a
deterministic `· stuck? skip _ skips this step`; in-flight coach call →
re-arm and yield. LLM path sends the normal context + a `NUDGE
CHECK-IN` block; the verdict is ADVISORY — only COACH is taken (no
step advance: no new evidence arrived; CONTROL: STOP ignored: the user
said nothing). No-LLM path emits a deterministic "Still there?" line.
Events: `kata.nudge {step, nudgeNumber, idleMs, latencyMs, coach |
deterministic | error | parseError}`.

The **lesson journal** (`_journal`) records one line per COMPLETED step
with the evidence that closed it (`Step 2 (…) ✓ — submitted: "write a
plan…"`), bounded by stepCount, wiped on start/stop, rendered as
`LESSON SO FAR:` in every coach/nudge user message. This is the
cross-step memory — the trace ring alone is 10 entries and forgets
early steps. Known limit: cerebras gpt-oss under-uses it for explicit
recap questions (answers with the next action instead); the journal is
in context, tune in the coach-quality bench.

## Modal suppression

`ResolverOptions.externallySuppressed(text)` is the whole override: one
predicate checked at the top of the Resolver's text-change entry
(pending debounce cancelled too). It returns true while a kata is
active OR while the text matches a control phrase (so
`start kata 1 _` never races fluid-blank's `_` fast-path even
before activation). Verified: 0 `resolver.started` events across
entire kata sessions.

Deliberately NOT suppressed: Navigation, Cycling, DimRender, BlankFill
(keyword blanks), AgentRewrite (only fires when armed). This is what
lets katas teach OpenCues itself (`opencues-basics` cycles a tip
and fills `capital of france _` mid-kata). Stop is trivially clean
because nothing is written to OPENCUES.md — the mode is one in-memory
predicate.

## Escape ladder (weakest assumption first)

1. **Esc ×3** — deterministic, in `observeKey` BEFORE any trace/LLM
   logic; zero `resolveLLM` calls (test-pinned). 3 presses within a
   2.5s chain; countdown line per press ("Esc ×2 more to exit the
   kata"); counter resets on window expiry or any other key. Three
   not two so CC's double-Esc clear-input can't exit by accident.
   Escape presses still land in the trace (katas teach Esc —
   `claude-code-power` step 4) but never schedule a tick (the countdown
   must not race an LLM verdict).
2. `stop kata _` — deterministic phrase.
3. `CONTROL: STOP` — coach-honoured explicit quit request, any
   language. See Security.
4. `skip _` / `done _` / `next _` — per-step relief.

## Degraded mode (no LLM)

`resolveLLM() === null` → the first activity tick sets a deterministic
coach line: `Step k/N: <title> — coach offline (no LLM key); type
next _ when done · Esc ×3 exits`. Network-dead-with-key → same after
**2 consecutive** failed calls (`_consecutiveErrors`, reset on any
success so recovery resumes live coaching). Everything deterministic
keeps working; the kata is a labelled self-guided checklist.
Degrading LOUDLY is the point — the silent version had users typing
into a void.

## Persistence, curriculum, voice, time-on-step

- `progressFile` option (boot-wired to `~/.cues/kata-progress.json`)
  — `{[name]: {step, journal, completed, updatedAt}}`. Saved on
  advance/stop/completion (journal SNAPSHOTTED synchronously — the
  async write races deactivate()'s wipe, live-caught bug). `start`
  resumes an uncompleted record (step + journal restored, "Welcome
  back" line); completed records start fresh. Omit the option to
  disable (chrome).
- `next:` frontmatter → KataDoc.next; completion recap notice (20s)
  is journal-derived + offers `start kata <next> _` as a command
  span. kata.completed event carries `next`.
- `speak` option + `kata-voice` scalar (default off) — speaks step
  advances, nudges, completion via host TTS (same spawn shape as the
  TTS module). NEVER per-tick.
- `TIME ON CURRENT STEP: ~Ns` rides the coach/nudge user message.

## Observability

Structured events (agentic-harness first-class):
`kata.started {name,id,title,stepCount}` ·
`kata.tick {step,claimedStep,status,coach,latencyMs,model,provider |
error | parseError | stale}` ·
`kata.step-advanced {fromStep,toStep,reason: user|coach}` ·
`kata.completed {name,stepCount,reason}` ·
`kata.stopped {name,reason: user|coach-user-request|escape-key}` ·
`kata.not-found {arg,available}`.

Statusline: `StatuslinePayload.kata`
`{name,title,step,stepCount,stepTitle,coach,coachSegments,offTrack}` — merged in
`maybeWrite` (orthogonal to highlight state, like `providerError`).
`step: 0, stepCount: 0` is a transient notice (not-found catalogue,
exit confirmation), fed by the module's `_notice`.

Command markup: coach lines use backticks around literal type/press
text (`parseCoachMarkup` → `coachSegments`; `coach` is the stripped
plain string). Deterministic lines are authored with the markup; the
system prompt instructs the model to backtick commands in COACH. The
OC footer (patch_footer_tsx + the bootstrap's `opencuesKata`
signal) renders command spans success-coloured + bold and the step
head error-coloured while offTrack — the reference rendering for
other hosts.

## Security posture

Coach output is display-only — statusline + clamped step counter; no
buffer writes, no exec, no side-effect channel (same structural
invariant as ambient-context, security-audit row #21). **One deliberate
exception**: `CONTROL: STOP` lets the model end kata mode on the
user's explicit request. Chosen because stopping RELEASES the modal
override (fail-open) — a spurious stop costs a restart, never content
or settings — and the parser accepts only `STOP` (any other CONTROL
value is ignored). The deterministic paths (phrase, Esc ×3) remain
regardless of model behaviour. A malicious KATA.md can at worst
display wrong text, mis-advance its own step counter, or stop itself.
**Do not** add CONTROL verbs that acquire anything (start, advance
beyond the clamp, buffer writes) without re-reviewing this posture.
Full attack-class analysis: **`docs/architecture/security-audit.md`
row #27** (🟢) — consent gates, display-only output, fail-open
`CONTROL: STOP`, egress trust class, bounded key observation. Now that
the coach renders into the **live web page** on chrome, row #27 also
pins the rendering-safety invariant: the in-page bar paints coach +
KATA.md text via `textContent` / `createTextNode` only (never
`innerHTML`), and katas load only from compile-time / extension-only
sources (never web-page-writable). If you touch `showKata` in
`integrations/chrome/src/runtime-statusbar.ts`, keep it `textContent`
— an `innerHTML` there would turn any untrusted KATA.md/coach line into
DOM XSS in the content script.

## Testing

- `kata.test.ts` — pure functions (parser, control phrases, coach
  response incl. CONTROL).
- `kata.scenarios.test.ts` — 20 multi-step journeys (mock adapter,
  fake timers) pinning every deterministic contract: activation/
  consumption, done-chain, Esc ×3 (countdown, resets, zero-LLM),
  escape-in-trace, attempt-preserving coalescing, submit detection +
  self-write TTL, the Enter-as-submit paths (Enter-with-content →
  `submitted`, Enter-on-empty → keypress, and the clear/Enter dedup),
  suppression state machine, not-found notice, no-LLM journey,
  2-failure escalation.
- Harness `scenarios/42-kata-mode.json` — live contracts,
  LLM-decoupled per the agentic-scenario rules (not-found, start,
  tick-fired, deterministic advance, stop phrase, Esc ×3).
- LLM-quality (coaching goodness, claim trust, hint discipline,
  order enforcement) is deliberately NOT unit/scenario-asserted —
  probe it on the harness; a `tests/benchmarks/kata-coach/` bench
  (replayed traces × providers) is the planned home.

## Deferred / known gaps

- **All five bands now mount the module** (CC / OC / gemini / shell /
  chrome), each following the first-subscriber observeKey contract + a
  coach-line surface. Chrome — which has no statusline — renders the
  coach into the in-page status bar
  (`integrations/chrome/src/runtime-statusbar.ts`, `showKata`), whose
  position is user-configurable via the chrome-only `statusbar-position`
  setting (right / bottom / top); its kata head reuses the popup's
  `.brand-badge` C_ text mark — the extension has NO svg logo asset;
  manifest icons are PNGs (`integrations/chrome/icons/`) and the brand
  is a CSS-styled text badge, same wordmark the OC footer renders. The
  shell port took ~20 mechanical lines following this contract and
  passed scenario 42 unmodified — the pattern generalized to every host.
- `katas-mode` FeatureSpec in the registry (today it's a raw
  settings-map read, default on) + `seed-configs` copying
  `defaults/katas/` + a CC statusline script extractor for the
  `kata` block. (Promoting `katas-mode` into FEATURES is a prerequisite
  for the spec cut below — a spec-mandated scalar must be registry-owned.)
- Deterministic hint-withholding gate (hint mode can leak early — model
  judgement only) and a deterministic stuck-escalation backstop.
- **Not a spec change yet — candidate for the open standard now that the
  experiment runs on all hosts.** Only the KATA.md *file format*
  (frontmatter `name`/`id`/`title`/`next` + `## Step` sections + the
  `coach:` notes convention + `.cues/katas/` search-path) is spec
  material — parallel to how `IDENTITY.md` joined in 0.2. The coaching
  *runtime* (trace model, coach tick, safety floors, escape ladder,
  degraded mode, statusline block) stays reference-impl, per the spec's
  "does NOT cover LLM prompt internals / host-side runtime surface"
  boundary — same split as BLANK.md (spec) vs the `CueSource` classes
  (not). Cutting it = a new `spec/kata-spec.md` + `spec/schemas/
  kata.schema.json` + conformance fixtures + a `core.md` spec-mandated
  `katas-mode` scalar + a `SPEC_VERSION` bump (the full 9-step checklist
  in the root CLAUDE.md). Tracked as a follow-up PR.
