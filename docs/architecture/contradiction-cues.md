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

> **Date resolution is year-aware** (July 2026). `resolveDate` future-rolls a
> bare day/month to its NEXT occurrence ("see you Friday the 24th" means the
> coming 24th) — but a stated 4-digit year **pins the date verbatim**. Without
> that, "Friday, 24 July 2026" (correct) resolved to 2027-07-24 (a Saturday)
> once `now` passed the 24th, and the cue flagged a true statement — a
> date-dependent false positive that only appears *after* the written date.
> The year is read **deterministically from grounded text** (the claim's
> verbatim quote on the LLM path; the token after the date phrase in the
> Tier-0 word-walk — which also parses day-first UK order, "24 July 2026"),
> never from a new model-emitted field. Pinned in `checks.test.ts` +
> agentic scenario 117 (negative control).

## The tiers — one scalar, data-gated activation

`contradiction-cues-mode` gates the source. **ON by default** — the
resolver gate is `!== 'off'`, so only an explicit `contradiction-cues-mode:
off` disables it (a contradiction cue is passive + advisory, so it belongs
on out of the box; same polarity as `sentence-cues-mode`). The tiers are
**not** separate scalars; they activate by cache availability:

| Tier | Verifier | Cache (host-wired) | Egress host |
|---|---|---|---|
| 0 | `verifyWeekdayDate`, `verifyBillSplit` | none — buffer + clock | none |
| 0.5 | public-holiday collision | `bankHolidays` cache | GOV.UK |
| 5 | `outdoor_plan_weather` | `weather` (precip) cache | open-meteo |
| 5b | transit disruption | `tfl` line-status cache | TfL |
| 5c | `verifyJourneyClaim` | geocode (on demand) | photon/komoot |
| 5d | `verifyCommunityRuleClaim` | `communityRules` (subreddit rules, page-scoped) | reddit (same-origin) |

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
(`scope: sentence` shape): a char-range span, priority **87** (above
`more-formal` 85, below `BlankSource` 95 / `TransformBlank` 93). The resolver
registers a passive DynDef at `currentIndex: 0` — the buffer keeps the original;
`Ctrl+Alt+↑` (or a bare `_` in the painted note) swaps in the correction via the
word-cue `applyAltCycle` path. **Never auto-splices** (the May 2026 auto-rewrite
prototype was retired after the chrome agentic verification showed prose
being rewritten without consent — same lesson as sentence-cues).

### Cycleable (a correction) vs passive (a verdict-only advisory)

The `alternatives` array shape decides how the inline note reads (see
`inline-cues.md` § The note vocabulary):

- A verifier that computes a **correction** emits
  `alternatives: [originalSentence, corrected]` (length 2) — a **cycleable**
  notification, `⚠ N | <correction>`. Tier 0's weekday-date and bill-split
  checks are this shape (the runtime knows the right weekday / the right
  per-head amount, so there's something to cycle to).
- A verifier that can only render a **verdict** — nothing computable to splice
  in — emits `alternatives: [originalSentence]` (length 1), a **passive**
  advisory: `⚠ <message>`, no countdown, no `_`-cycle. The weather / journey /
  transit tiers and the Tier-5d subreddit-rule flag are verdict-only ("it will
  rain then", "that walk is longer than 5 minutes", "may conflict with rule 3")
  — the tip is the whole point, there's no single corrected sentence to offer.

The emoji is always `⚠` today: every wired verifier produces a computable fact,
so the `🧢` (LLM-judged lie) glyph in the note vocabulary stays dormant on this
path.

The calendar-conflict cue (`defaults/cues/calendar/CUE.md`, priority 90)
is a sibling on the same passive-sentence-cue rail but reasons over the
calendar snapshot instead of world data — see `calendar-context.md`.

## Tier 5d — community rules (subreddit rules), the one LLM-judged tier

Tier 5d flags a draft sentence that conflicts with the **posted rules of
the community the user is writing in** — today: subreddit rules on
reddit pages. It departs from the tiers above in one declared way and
holds the line everywhere else:

- **The conflict judgement is the model's** (there is no arithmetic that
  decides "is this relevant to r/ClaudeAI"). This is a deliberate,
  reviewed departure from "the correction is DATA" — accepted because
  the cue's *content* is still data: the tip is built by
  `verifyCommunityRuleClaim` from the **cached** rule (community label +
  rule number + sanitized rule name), never from model output. The
  judge's only powers are picking a rule NUMBER (dropped unless it
  resolves against the cache) and quoting a verbatim phrase (dropped
  unless grounded in the live sentence). There is no correction
  alternative — nothing to splice, only the ⚠ tip.
- **A dedicated judge call, never folded into extract.** The
  extract prompt keeps its benched claim types untouched; the judge runs
  as its own per-sentence call (`COMMUNITY_RULE_JUDGE_SYSTEM`) only when
  the current page has cached rules. (The SUMMON-in-classifier lesson:
  overloading one prompt with a second job measurably regresses the
  first; the same job in its own call works.) The static system prompt
  stays prefix-cacheable; the per-page RULES block + sentence ride the
  USER message.
- **Data path.** `RedditRulesProvider` (`contradiction/reddit-rules.ts`)
  is keyed off a live `pageLocation` getter the host supplies
  (chrome passes `location`; native hosts have no page → tier silent).
  It fetches `<reddit origin>/r/<sub>/about/rules.json` with the
  **content-script global fetch** — same-origin on reddit (rides the
  page session, allowed by reddit's `connect-src 'self'` CSP), so
  deliberately NOT the SW-routed `worldDataFetch`. TTL 6 h per
  subreddit, 10 min negative cache on failure. **Bind `fetch` to
  `globalThis`** when falling back to the global (`fetch.bind(globalThis)`):
  an unbound `fetch` reference throws `TypeError: Illegal invocation` in
  chrome because the browser's `fetch` requires its `this` to be the window /
  global — the July 2026 chrome-only Tier-5d bug. Native hosts pass a real
  adapter and never hit the fallback.
- **Untrusted text.** Rule text is community-controlled. It is
  sanitized + length-capped at provider parse time, is presented to the
  judge as DATA with an explicit never-follow-instructions rule, and can
  only ever reach user-visible tip text — no side-effect channel.
  Egress stays hardcoded-template: allowlisted reddit origin (exact
  hostname match — lookalike domains refused) + regex-validated
  subreddit parsed from the URL path, never model-chosen.

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
- `contradiction/journey.ts` (geocode/distance), `tfl.ts`, `weather.ts`,
  `reddit-rules.ts` — per-provider fetch + parse. Fixed URLs or
  `encodeURIComponent`; defensive parsing; TTL-gated.
- `resolver.ts` `enableContradictionCues` — the mode gate + `worldDataFetch`
  + `pageLocation` wiring.

## Tests

- `contradiction/checks.test.ts` — verifier units incl. the two
  `SECURITY:` journey-grounding cases.
- Agentic suite 112–117 (private harness) — the tiers end-to-end via
  `run-contradiction-suite` (seeds a fake calendar + pins the cues bucket
  to a validation model; 117 is the negative control — a *correct* claim
  must stay silent).
