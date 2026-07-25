# Contradiction cues — architecture

Canonical reference for the `contradiction-cues-mode` feature. Read this
before touching `packages/opencues-core/src/contradiction/`. User-facing
summary: `docs/features/contradiction-cues.md`.

## The shape: parse (LLM) → verify (deterministic)

`ContradictionLlmSource`
(`packages/opencues-core/src/contradiction/contradiction-llm-source.ts`)
is the engine. The load-bearing split:

1. **Parse** — one cues-bucket LLM call turns each segmented sentence
   into zero-or-more **typed claims** (`weekday_date`, `bill_split`,
   `public_holiday`, `outdoor_plan_weather`, `journey_underestimate`, …).
   The model emits only structure (`{type, weekday, day, quote, …}`),
   never a correction.
2. **Verify** — the runtime checks each claim **deterministically** in
   `contradiction/checks.ts`: compute the real weekday
   (`weekdayOf`, UTC-stable), do the arithmetic, read a world-data
   cache, geocode + distance. A claim that survives verification with a
   real mismatch becomes a `VerifiedContradiction` with the corrected
   value + the one-line tip.

**Why the split matters:** the correction is DATA, so a cue can never
hallucinate a false contradiction — the model's only power is to *route*
a sentence to a verifier; the verifier's math is what fires (or doesn't).
This is the same "model classifies, runtime computes" discipline the rest
of the system uses.

## The tiers — one scalar, data-gated activation

`contradiction-cues-mode: on` (off by default) enables the source. The
tiers are **not** separate scalars; they activate by cache availability:

| Tier | Verifier | Cache (host-wired) | Egress host |
|---|---|---|---|
| 0 | `verifyWeekdayDate`, `verifyBillSplit` | none — buffer + clock | none |
| 0.5 | public-holiday collision | `bankHolidays` cache | GOV.UK |
| 5 | `outdoor_plan_weather` | `weather` (precip) cache | open-meteo |
| 5b | transit disruption | `tfl` line-status cache | TfL |
| 5c | `verifyJourneyClaim` | geocode (on demand) | photon/komoot |

Each cache is a `{ refresh(): Promise<void>; current(): ReadonlyMap<…> }`
passed into `ContradictionLlmSourceConfig`. `refresh()` is kicked
fire-and-forget; `current()` is a synchronous read at verify time. A
cache that's **absent** makes its verifier a no-op — the tier "stays
silent." Tier 0 needs no cache, so it always works when the mode is on.

The host provides the caches through `worldDataFetch`
(`resolver.ts` `enableContradictionCues` gate + the `resolveWorldDataFetch`
option); native hosts wire them at boot and refresh them on background
TTLs. `world-data providers persist across source rebuilds` (a source
rebuild must not drop the warm caches — pinned by a regression after the
Tier-5 ship).

## Rendering — a sentence-cue at priority 87

A verified contradiction is emitted as a **passive sentence-cue**
(`scope: sentence` shape): `alternatives: [originalSentence, corrected]`,
a char-range span, priority **87** (above `more-formal` 85, below
`BlankSource` 95 / `TransformBlank` 93). The resolver registers a passive
DynDef at `currentIndex: 0` — the buffer keeps the original; `Ctrl+Alt+↑`
inside the sentence swaps in the correction via the word-cue
`applyAltCycle` path. **Never auto-splices** (the May 2026 auto-rewrite
prototype was retired after the chrome agentic verification showed prose
being rewritten without consent — same lesson as sentence-cues).

The calendar-conflict cue (`defaults/cues/calendar/CUE.md`, priority 90)
is a sibling on the same passive-sentence-cue rail but reasons over the
calendar snapshot instead of world data — see `calendar-context.md`.

## Security / grounding invariants

The verify step is the one place LLM-adjacent output shapes an outbound
request, so it's guarded (security-audit.md rows #28–#29):

- **Egress hosts are hardcoded** (GOV.UK / open-meteo / TfL / komoot) —
  never LLM-chosen. An injection in prose can't redirect the request.
- **Grounded inputs.** `verifyJourneyClaim` geocodes `origin`/`destination`
  only when each is a short (`≤ GEOCODE_NAME_MAX`) literal substring of
  the sentence (`isGeocodableName`) — a hallucinated/injected place never
  reaches the geocoder, and a hallucinated place can't fire a false cue.
- **Bounded computation.** `MODE_MAX_KM` caps the journey distance
  (bails rather than emitting a nonsense "90000-minute walk");
  `safeEvalArithmetic` is a shunting-yard evaluator, never `eval`.
- **No side-effect channel.** A contradiction cue's output is a
  user-visible tip, not an action — worst-case injection is manipulated
  tip *text* the user sees before acting.

## Where to touch

- `contradiction/checks.ts` — the deterministic verifiers + the claim
  types. Adding a Tier-0-class check is a new `verify*` function + a
  claim type in the parse prompt.
- `contradiction/contradiction-llm-source.ts` — the parse prompt +
  cache plumbing. Adding a networked tier is a new cache field on
  `ContradictionLlmSourceConfig` + its verifier + the host wiring.
- `contradiction/journey.ts` (geocode/distance), `tfl.ts`, `weather.ts` —
  per-provider fetch + parse. Fixed URLs or `encodeURIComponent`;
  defensive parsing; TTL-gated.
- `resolver.ts` `enableContradictionCues` — the mode gate + `worldDataFetch`
  wiring.

## Tests

- `contradiction/checks.test.ts` — verifier units incl. the two
  `SECURITY:` journey-grounding cases.
- Agentic suite 112–117 (private harness) — the tiers end-to-end via
  `run-contradiction-suite` (seeds a fake calendar + pins the cues bucket
  to a validation model; 117 is the negative control — a *correct* claim
  must stay silent).
