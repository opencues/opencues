# Decision seam — calibrated decisions behind one interface

Canonical reference for `packages/opencues-core/src/decisions/`: the seam a
DECISION model plugs into, what the sources ask of it, and how a decision
package is loaded. Read before adding a leg, touching the dispatch, or
writing a package.

## What a decision model is

A decision model answers typed questions about a `state` object with
calibrated probabilities. It never generates text. Three primitives:

| primitive | asks | answers |
|---|---|---|
| `noul` | a yes/no about the state | a probability 0..1 |
| `choice` | which of N named options (≤ 255) | one option id, a probability per option, a confidence |
| `score` | which rung of an ordered scale | a level, a probability per rung |

That makes it a different seam from the LLM providers: it is never in
`PROVIDERS`, never a fourth bucket, and its output is never text the buffer
could receive. What it is good for is SELECTION: which registered thing,
which sentence, which candidate, whether to spend a generation call at all.
What it cannot do is anything that needs new text, a fact it cannot see, or
reasoning (dates, arithmetic, letter-level facts, truth).

## The seam (`packages/opencues-core/src/decisions/`)

- **`types.ts`** — the primitives, `DecisionRequest` / `DecisionResult`,
  `DecisionProvider` (one method, `ask`), `DecisionError` with a `kind`
  (`auth` / `budget` / `overloaded` / `transport` / `shape`), `DECISION_LIMITS`.
- **`dispatch.ts`** — `dispatchDecision`, the ONE chokepoint every request
  goes through: `validateDecisionRequest` (rejects array-index path
  references, over-limit option counts, unknown types) → the PII floor
  (`applyDecisionDehydrationFloor` dehydrates every string in the state; a
  hit inside question text is counted and warned, never rewritten) → `ask`
  → the usage meter → one `[decision][<leg>]` log line. A failure is logged
  and rethrown as a `DecisionError`; nothing is swallowed.
- **`breaker.ts`** — `DecisionBreaker`: a failed request marks the package
  down for a window (30 s; 10 min on auth) so an outage costs one failed
  request per window, not one per leg per pause. Shared shape between the
  session rail and the `_` router.
- **`chat-fallback.ts`** — `ChatFallbackDecisionProvider`: the same
  `DecisionProvider` contract served by a chat model (strict JSON,
  temperature 0). Its probabilities are self-reported, not calibrated;
  it exists so the seam never depends on one vendor.
- **`typesafe.ts`** — `TypeSafeDecisionProvider`: the vendor HTTP adapter (endpoint,
  bearer key, body shape, error classification, one retry on overload, the
  model pin). No template in it; a package supplies the legs over it.
- **`candidates.ts`** — what a leg OFFERS the model, cut in code: the `_`
  window (`underscoreRouteDraft`), a word's edit-1 neighbourhood (`edits1`,
  `spellingEligible`), the replace targets and commands (`replaceCandidates`).
  Product policy, not question wording.
- **`bridge.ts`** — the legs over a message channel (browser hosts, below).
- **`legs.ts`** — `DecisionLegs`: what a decision PACKAGE gives the sources.
- **`load.ts`** — `loadDecisionLegs`: the package, loaded by name.

## Legs, not questions

The sources never see a question. Each hands a leg the thing to judge and
gets back a VERDICT over inputs the runtime supplied: ids, probabilities,
spans. How the question is asked (primitive, option text, candidate cutting,
thresholds inside the leg) is the package's. The interface:

| leg | the source hands in | gets back | consumer |
|---|---|---|---|
| `pause(input)` | the draft + words, the tips catalogue as `{id, when, tip, command}`, the watchlist as `{id, statement}` + the runtime-cut sentence units, the ask flag, the spelling flag | a `PauseVerdict`: a tips id + probability, a contradiction `{choice, confidence, unit?}`, the ask probability, a spelling `{wordIndex, fix}` | `SessionCueSource.getCuesFused` — ONE request per pause |
| `tipsMatch` / `contradictionGate` / `askGate` | the same inputs, one leg at a time | the same verdicts | the per-leg path (`decisions-fanout: off`) |
| `sentenceGate(gate, sentences)` | the cue's `gate:` line and every sentence of the pass | `[gate, prose]` probabilities per sentence | `SentenceCueSource`: a sentence under either threshold cedes with no rewrite call |
| `route(text)` | the draft around the `_` | an `UnderscoreRouting`: the chat source to restrict to, or null for the fan-out | the runtime resolver's `only` filter |
| `replace(input)` | the outbound transform input | a `ReplaceVerdict` `{target, command}` cut from the input, or null | `TransformBlankSource`: the value is read off the fused rewrite's diff (`deriveReplaceValue`) and the splice passes `verifyReplaceDetect` |

Every leg goes through `dispatchDecision` inside the package, so the
chokepoint is the same whoever asks. A leg THROWS on a failed request; the
caller owns the breaker and the fall-through. Every consumer has a chat path
and takes it when the leg is absent, unhealthy, or fails:

- a failed pause request → the same pause runs every leg on chat, the breaker
  trips, the next pauses skip the request;
- a failed sentence gate → every sentence is sent (the gate can save a call,
  never lose a rewrite);
- a failed or slow route (past `UNDERSCORE_ROUTE_BUDGET_MS`, 1 s) → the full
  fan-out; a budget miss does not trip the breaker, a failure does;
- a failed replace request → the fused merge path, unaffected;
- a contradiction gate hit under `CONTRADICTION_FIRE_THRESHOLD` (0.5), or
  with no unit → the chat matcher.

Confidence rides the results as data (`CueResult.confidence`,
`metadata.gate` / `unit` / `spelling`); no renderer reads it. No visual
change at any leg.

## What the sources do with a verdict

- **Tips**: the id is the option key so a cited entry exists by
  construction; the solution is the entry's own command; the note is the
  pack's `say:` line; the span is the caret's sentence. Threshold 0.5 with
  hysteresis (an entry that fired holds to 0.4 on a continuation of the same
  draft for 60 s).
- **Contradiction**: on a verdict that names a rule and a unit, the cue is
  built from data with no chat call: the span is the runtime-cut sentence,
  the note is the rule's own statement, and the reconciled rewrite is
  fetched only when the caret lands on the span (`WordDef.deferredRewrite`,
  `DynDefs.resolveDeferred`, prefetch on `HighlightState.onChange`).
- **Spelling**: with a package present the shipped `spelling` word-cue is
  not built; a correction from the pause verdict lands as the same word-cue
  (`source: 'spelling'`, priority 10, same ✍️ note and hint).
- **Sentence gate**: `gate:` in a sentence-scope cue file (runtime-only key)
  turns the gate on; `more-formal` ships one, `calendar` does not.
- **Router**: a routed source that cedes is followed by the fan-out over the
  rest, so routing costs a round trip at most, never an answer.
- **Replace**: `metadata.pipelineMode: 'replace-splice-decision'`.

## Loading a package

`decisions-provider: <name>` (default `off`) names a provider the installed
decision package knows. `loadDecisionLegs` requires
`OPENCUES_DECISIONS_PATH` (a directory or entry file), then
`@opencues/decisions`, then `~/opencues-decisions` (the checkout the installers
copy from; `opencues doctor` also looks in every CC fork's `node_modules`); the
package exports:

```ts
export const providers: string[];            // the names it accepts
export const envKey: string;                 // the key it reads from the key bag
export const pinnedModel: string;            // for doctor
export function createDecisionLegs(o: { which; apiKey; httpAdapter; log }): DecisionLegs | null;
```

Nothing installed, an unknown name, or no key → one log line at boot
(`buildSources: decisions-provider … → decision legs stay on chat`) and
every leg on its chat path. `opencues doctor` shows the same resolution.

**Browser hosts bridge to a native process** (`decisions/bridge.ts`). A page
has no package and no key, so chrome's content script builds
`createBridgedDecisionLegs(send)`, a `DecisionLegs` whose every leg is one
message out (`opencues:decision` → the service worker → the native-messaging
host as `decision`) and one verdict back, and hands it to the runtime as
`ResolverOptions.decisionLegs`; `loadDecisionLegs` uses host-built legs as-is
when the scalar is on. The host runs `serveDecisionLeg` over the legs it
loaded (`host.cjs`, once per provider, key from its own environment /
`~/.cues/.env`, never sent to the page). What crosses is data only: leg name,
arguments, verdict. The page runs the PII floor over every string in the
arguments before they leave it, since the host has no identity catalog. A host
failure comes back typed (`{ ok: false, error: { kind } }`) and is rethrown as
a `DecisionError` of that kind, so the breaker behaves as on a native host; no
host at all is a transport failure → chat for the window. dsh's client half
can take the same bridge over its node half.

The reference package is private (`opencues/decisions`); it carries the
provider, the question templates, the thresholds, the benches and the
numbers. The seam above is what a second package targets.

## Rules for a leg

1. It is a selection over things the runtime already holds (a registry, a
   catalogue, the draft's own words, candidates cut in code). If the answer
   is a new string, it is a chat leg, possibly gated by a decision leg.
2. The state is keyed by NAME (`rules.r4`), never an array index;
   `validateDecisionRequest` rejects the latter.
3. Spans come from the runtime (sentence units, candidate substrings), never
   from the model; a verdict names one of them by id.
4. The consumer keeps its chat path and the fall-through rules above; a
   decision leg can save a call, never lose a cue.
5. Thresholds that decide a consumer's behaviour live in code next to the
   consumer (`CONTRADICTION_FIRE_THRESHOLD`, `SENTENCE_GATE_THRESHOLD_DEFAULT`,
   `TIPS_DECISION_THRESHOLD_DEFAULT`, `ASK_GATE_THRESHOLD_DEFAULT`); a
   package may apply its own inside a leg.
6. A leg ships only at accuracy parity with the chat path it replaces, with
   the cost or the latency column lower, measured in one session with both
   arms. The package's benches own those rows.

## Security

`dispatchDecision`'s PII floor is defence in depth for the decision channel,
the way `dispatchChat`'s floor is for chat (`hydration-dehydration.md`
row 11). On a browser host the same floor runs on the PAGE side of the
bridge (`bridge.ts`), before the leg arguments leave the page; the native
host holds the key and never forwards it. The router dehydrates the draft window before it ships in identity
`safe` mode. Selection over registered BLANKS by a decision leg (a device or
data tool named by the `_` request) is ruled in `security-audit.md` row #32
and is not wired in this version.

## Related

- `docs/architecture/semantic-tips.md` § The decision path
- `docs/architecture/session-contradiction.md` § The pre-gate / Detection on the decision layer
- `docs/architecture/sentence-cues.md` § The gate
- `docs/architecture/transform-blank.md` § Replace-parse on the decision layer
- `docs/architecture/blank-sources.md` § The `_` router
- `docs/architecture/spans-and-cycling.md` § Deferred alternatives
