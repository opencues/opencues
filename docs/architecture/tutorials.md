# Tutorials — modal guided scenarios with a live LLM coach

**Status: experimental prototype (OpenCode + Shell bands). Read this before
touching `packages/opencues-runtime/src/modules/tutorial.ts`, the
`externallySuppressed` seam in `resolver.ts`, or the `tutorial` block in
`statusline.ts`.**

User-facing summary: [docs/features/tutorials.md](../features/tutorials.md).

## The idea in one paragraph

A tutorial is an ordered script (`tutorials/<name>/TUTORIAL.md` under
the standard `.cues/` search paths) the user works through in their
real editor. The runtime enters a **modal** state, observes the user's
activity as an event trace (typed snapshots, submits, salient key
presses), and runs one debounced LLM call per pause — the **coach** —
which judges progress on the current step and emits one line of
guidance. The model owns judgement; the runtime owns safety floors and
every deterministic path (control phrases, escape hatch, degraded
mode). Fidelity lives in the tutorial file: step bodies + `coach:`
notes ride into the system prompt verbatim, so keystroke-level
choreography, strict ordering, and hint-mode pedagogy are authoring
choices, not code.

## Module map

Everything lives in `packages/opencues-runtime/src/modules/tutorial.ts`:

| Piece | What it does |
|---|---|
| `parseTutorialMd` | frontmatter (`name`/`id`/`title`) + `## ` step sections. Steps are `{title, body}` — the body is NOT schema'd; it goes to the model verbatim. |
| `matchControlPhrase` | sentence-leading, `_`-gated triggers (same trigger model as blank shapes): `start tutorial [<id|name>] _`, `stop tutorial _`, `done|next|skip _` (active only). |
| `TutorialCoach` | the module: text/key observation, trace ring, control handling, coach tick, statusline feed, events. |
| `parseCoachResponse` | tolerant `STEP:/STATUS:/COACH:` + optional `CONTROL: STOP` line parser. |

Wiring (OC band, `adapters/oc/v1.14/boot.ts`):

- Constructed after `buildSharedRuntime` (needs ConfigLoader); key
  observation is registered BEFORE it — see the wiring contract below.
- `resolveLLM: () => buildAgentLLMResolver(...)` — the coach reads the
  **auditors bucket** (background prose-reading trust class, refuses
  `trainsOnInput` providers, same as agent-rewrite).
- `Statusline` gets `tutorialStatus: () => tutorialCoach.status()`.
- `Resolver` gets `externallySuppressed: (text) =>
  tutorialCoach.shouldSuppressResolve(text)`.

## HOST WIRING CONTRACT — observeKey must be the FIRST key subscriber

Key dispatch is emit-until-consumed. Navigation consumes
Ctrl+Alt+arrows, hosts consume Escape/Tab — a late subscriber never
sees exactly the presses cycling tutorials teach. The OC boot registers
a passive forwarder on the raw key emitter BEFORE `buildSharedRuntime`
subscribes anything, with a late-bound ref:

```ts
let tutorialCoachRef: TutorialCoach | null = null;
keyEvents.subscribe(e => { tutorialCoachRef?.observeKey(e); return false; });
// ... buildSharedRuntime(...) ... new TutorialCoach(...) ...
tutorialCoachRef = tutorialCoach;
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
- `submitted: "<text>"` — buffer transitioned non-empty → empty; the
  submitted text is the previous buffer. This is how Enter is inferred.
- `pressed: <label> (×N)` — salient keys only: tab/escape/arrows
  always, enter only on an EMPTY buffer (a non-empty submit is already
  a `submitted` entry), anything with ctrl/alt/meta. Plain typing is
  deliberately excluded (it's the `typed` entries). Consecutive repeats
  coalesce into a count.

Runtime-source text events and echoes of the module's own
consume-writes are excluded. Self-write matching is **TTL-based
(250ms, mirrors boot-common's `RUNTIME_WRITE_TTL_MS`)** — a
consume-on-match-forever stash swallowed the user's next buffer-clear
(i.e. killed submit detection) on any host that doesn't echo
`pushText`. Pinned in `tutorial.scenarios.test.ts`.

## The coach tick

Debounced (default 300ms; `tutorial-debounce-ms` hot-reloads) on text
changes and salient key presses; single in-flight call; stale results
dropped (tutorial stopped / step moved / buffer changed while in
flight → discard, re-ask).

Prompt split follows the cerebras prefix-cache rules
(`docs/architecture/cerebras.md`): the SYSTEM message (coach
instructions + the ENTIRE tutorial script) is byte-stable per tutorial
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
  the last step auto-stops and emits `tutorial.completed`.
- Coach errors / unparseable output → verdict discarded, buffer and
  progress untouched, `tutorial.tick {error|parseError}` emitted.

### Prompt-owned behaviour (model judgement, tune in the prompt)

Detection semantics (trust completion claims on unobservable steps;
later-step evidence completes the current step UNLESS the step's coach
notes demand strict order); meta-question handling ("help" is
IN_PROGRESS, not OFF_TRACK); responding in the user's language;
surfacing `stop tutorial _` / `skip _` on quit-intent and stuck-loops;
hint-mode discipline; recap-from-journal phrasing. These were all hardened by an adversarial
"dumb user" probe suite — when touching the system prompt, re-run that
class of probe (quit attempts, bare "done" claims, wrong-order inputs,
gibberish, French) on the harness before shipping.

## Idle nudge + lesson journal

`armIdleTimer()` re-arms on every user activity (text, salient keys,
Escape presses), on step advance, and at activation; window from
`tutorial-nudge-ms` (default 30s, `0` disables, thunk hot-reloads).
`fireNudge()`: max 2 per stall (counter resets on any activity — the
cap stops NAGGING, not re-nudging a returned user); nudge 2 appends a
deterministic `· stuck? skip _ skips this step`; in-flight coach call →
re-arm and yield. LLM path sends the normal context + a `NUDGE
CHECK-IN` block; the verdict is ADVISORY — only COACH is taken (no
step advance: no new evidence arrived; CONTROL: STOP ignored: the user
said nothing). No-LLM path emits a deterministic "Still there?" line.
Events: `tutorial.nudge {step, nudgeNumber, idleMs, latencyMs, coach |
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
(pending debounce cancelled too). It returns true while a tutorial is
active OR while the text matches a control phrase (so
`start tutorial 1 _` never races fluid-blank's `_` fast-path even
before activation). Verified: 0 `resolver.started` events across
entire tutorial sessions.

Deliberately NOT suppressed: Navigation, Cycling, DimRender, BlankFill
(keyword blanks), AgentRewrite (only fires when armed). This is what
lets tutorials teach OpenCues itself (`opencues-basics` cycles a tip
and fills `capital of france _` mid-tutorial). Stop is trivially clean
because nothing is written to OPENCUES.md — the mode is one in-memory
predicate.

## Escape ladder (weakest assumption first)

1. **Esc ×3** — deterministic, in `observeKey` BEFORE any trace/LLM
   logic; zero `resolveLLM` calls (test-pinned). 3 presses within a
   2.5s chain; countdown line per press ("Esc ×2 more to exit the
   tutorial"); counter resets on window expiry or any other key. Three
   not two so CC's double-Esc clear-input can't exit by accident.
   Escape presses still land in the trace (tutorials teach Esc —
   `claude-code-power` step 4) but never schedule a tick (the countdown
   must not race an LLM verdict).
2. `stop tutorial _` — deterministic phrase.
3. `CONTROL: STOP` — coach-honoured explicit quit request, any
   language. See Security.
4. `skip _` / `done _` / `next _` — per-step relief.

## Degraded mode (no LLM)

`resolveLLM() === null` → the first activity tick sets a deterministic
coach line: `Step k/N: <title> — coach offline (no LLM key); type
next _ when done · Esc ×3 exits`. Network-dead-with-key → same after
**2 consecutive** failed calls (`_consecutiveErrors`, reset on any
success so recovery resumes live coaching). Everything deterministic
keeps working; the tutorial is a labelled self-guided checklist.
Degrading LOUDLY is the point — the silent version had users typing
into a void.

## Observability

Structured events (agentic-harness first-class):
`tutorial.started {name,id,title,stepCount}` ·
`tutorial.tick {step,claimedStep,status,coach,latencyMs,model,provider |
error | parseError | stale}` ·
`tutorial.step-advanced {fromStep,toStep,reason: user|coach}` ·
`tutorial.completed {name,stepCount,reason}` ·
`tutorial.stopped {name,reason: user|coach-user-request|escape-key}` ·
`tutorial.not-found {arg,available}`.

Statusline: `StatuslinePayload.tutorial`
`{name,title,step,stepCount,stepTitle,coach,offTrack}` — merged in
`maybeWrite` (orthogonal to highlight state, like `providerError`).
`step: 0, stepCount: 0` is a transient notice (not-found catalogue,
exit confirmation), fed by the module's `_notice`.

## Security posture

Coach output is display-only — statusline + clamped step counter; no
buffer writes, no exec, no side-effect channel (same structural
invariant as ambient-context, security-audit row #21). **One deliberate
exception**: `CONTROL: STOP` lets the model end tutorial mode on the
user's explicit request. Chosen because stopping RELEASES the modal
override (fail-open) — a spurious stop costs a restart, never content
or settings — and the parser accepts only `STOP` (any other CONTROL
value is ignored). The deterministic paths (phrase, Esc ×3) remain
regardless of model behaviour. A malicious TUTORIAL.md can at worst
display wrong text, mis-advance its own step counter, or stop itself.
**Do not** add CONTROL verbs that acquire anything (start, advance
beyond the clamp, buffer writes) without re-reviewing this posture —
and add the security-audit row when this ships.

## Testing

- `tutorial.test.ts` — pure functions (parser, control phrases, coach
  response incl. CONTROL).
- `tutorial.scenarios.test.ts` — 11 multi-step journeys (mock adapter,
  fake timers) pinning every deterministic contract: activation/
  consumption, done-chain, Esc ×3 (countdown, resets, zero-LLM),
  escape-in-trace, attempt-preserving coalescing, submit detection +
  self-write TTL, suppression state machine, not-found notice, no-LLM
  journey, 2-failure escalation.
- Harness `scenarios/42-tutorial-mode.json` — live contracts,
  LLM-decoupled per the agentic-scenario rules (not-found, start,
  tick-fired, deterministic advance, stop phrase, Esc ×3).
- LLM-quality (coaching goodness, claim trust, hint discipline,
  order enforcement) is deliberately NOT unit/scenario-asserted —
  probe it on the harness; a `tests/benchmarks/tutorial-coach/` bench
  (replayed traces × providers) is the planned home.

## Deferred / known gaps

- CC / gemini / chrome band wiring (each needs the module mount + the
  first-subscriber observeKey contract + a coach-line surface; chrome
  has no statusline — use the `onSnapshot` hook). The shell port took
  ~20 mechanical lines following this contract and passed scenario 42
  unmodified — the pattern generalizes.
- `tutorials-mode` FeatureSpec in the registry (today it's a raw
  settings-map read, default on) + `seed-configs` copying
  `defaults/tutorials/` + a CC statusline script extractor for the
  `tutorial` block.
- Progress persistence across restarts (session-only today).
- Deterministic hint-withholding gate (hint mode can leak early — model
  judgement only) and a deterministic stuck-escalation backstop.
- Not a spec change yet: TUTORIAL.md joins the open standard (with
  conformance fixtures + schema + SPEC_VERSION bump) only if the
  experiment graduates.
