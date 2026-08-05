# Contradiction cues

Contradiction cues catch a claim you typed that's **wrong or stale** —
a weekday that doesn't match its date, arithmetic that doesn't add up, a
meeting booked on a bank holiday, an outdoor plan the forecast is about
to rain on. They surface as a passive cue tip on the sentence, exactly
like the other `scope: sentence` cues; the buffer is **never rewritten
without your keystroke**.

The correction is always **data, never generation**: an LLM only
*parses* your prose into a typed claim ("this sentence asserts Friday 24
July 2026"); the runtime then *verifies* that claim deterministically
(compute the real weekday, do the sum, read a cached fact). The model
never invents the fix, so a cue can't hallucinate a false contradiction
from thin air — it can only flag a claim the arithmetic/clock/cache
actually disproves.

**OFF by default.** Enable with `contradiction-cues-mode: on`.

## The tiers

All tiers ride the **one** `contradiction-cues-mode` scalar. What
differs is the data each needs: Tier 0 works on the buffer + clock alone
(no network, always available when the mode is on); the higher tiers
light up only when their world-data cache is present, and stay silent
otherwise — so turning the mode on never *requires* a network call.

| Tier | Catches | Data source | Example that flags |
|---|---|---|---|
| **0** | weekday ≠ date; split-the-bill math | buffer + system clock (no network) | "see you Thursday, 24 July 2026" (it's a Friday); "£120 between 4 of us, £30 each" (it's £30… "£25 each" flags) |
| **0.5** | a work/office day that's a public holiday | GOV.UK bank-holiday feed | "in the office Monday 31 August 2026" (UK bank holiday) |
| **5** | an outdoor, weather-dependent plan vs the forecast | open-meteo precipitation cache | "picnic in the park on Saturday" when rain is forecast |
| **5b** | a London transit plan vs live disruption | TfL line-status | "let's take the Jubilee line tomorrow" during a Jubilee suspension |
| **5c** | a wildly-underestimated journey time | photon geocode + distance | "5 minute walk from East Finchley to Muswell Hill" |
| **5d** | a draft that conflicts with the subreddit's posted rules (chrome, on reddit) | the subreddit's own `about/rules.json`, fetched same-origin | drafting an off-topic post on r/ClaudeAI ("Be relevant") |

Tier 0 is pure date/number arithmetic — instant, private, no network.
The higher tiers each make one live call through a **hardcoded** egress
host (GOV.UK / open-meteo / TfL / komoot), never an LLM-chosen one, and
the value sent outward is grounded in what you actually typed (see
Privacy).

## Turn it on

In `~/.cues/OPENCUES.md`:

```yaml
contradiction-cues-mode: on
```

or cycle it in-editor via `opencues settings _`. It hot-reloads within
~2 seconds — no restart.

The higher tiers additionally need their world-data caches wired by the
host (the native hosts wire them automatically when the mode is on;
they refresh in the background on their own TTLs). With no cache for a
tier, that tier simply never fires — Tier 0 keeps working regardless.

## How it renders

A contradiction cue is a **sentence-cue** (priority 87 — it sits just
above `more-formal` at 85, so a contradiction on a sentence wins over a
formality rewrite of the same span). It's **passive**: the flagged
sentence gets a cue tip on the status line describing the mismatch and,
where meaningful, offering the corrected value as an alternative. With your
caret on the flagged sentence, swap it in with a bare **`_`** (the primary,
discoverable gesture) or `Ctrl+Alt+↑` (the power path). Nothing is spliced into
your buffer until you press the key. A correct sentence produces **no** cue — silence is the
precision rule; a wrong cue is worse than no cue.

## Privacy — what reaches the LLM, what leaves the machine

- The **parse** step sends your sentence to the cues-bucket LLM (the same
  trust class as every other cue). It refuses `trainsOnInput` providers.
- The **verify** step's outbound calls (Tiers 0.5/5/5b/5c) go to
  **fixed, hardcoded** hosts — an injection in your prose can't redirect
  them. Their inputs are **grounded**: e.g. the journey cue only
  geocodes an origin/destination that is a short literal substring of
  your sentence (`isGeocodableName`), so a hallucinated or injected place
  name never reaches the third-party geocoder. See
  `docs/architecture/security-audit.md` rows #28.
- Tier 0 does **no** network and **no** LLM verification — it's local
  arithmetic on text you already typed.

## Notes & limits

- **Cues, not agents.** Like every `scope: sentence` cue, a
  contradiction never edits the buffer on its own — the May 2026
  auto-splice prototype was retired precisely so background prose
  rewriting can't happen without consent.
- **Precision over recall.** The tiers are tuned to stay silent unless
  the claim is unambiguous (an unmistakably outdoor plan, a literal
  weekday-date pair). A borderline sentence is left alone.
- **Region.** Tier 0.5 (GOV.UK) and Tier 5b (TfL) are UK/London-specific
  today; Tier 0 and Tier 5 are location-agnostic (weather keys off your
  system-timezone city).
- **Tier 5d is the one LLM-judged tier.** "Does this draft fit the
  subreddit's rules" has no arithmetic to compute, so the conflict call
  is the model's — a declared exception to "data, never generation".
  The tip text itself is still data (the cached rule's number + name,
  fetched from the subreddit's own rules endpoint), a hallucinated rule
  number is dropped, and the tip is phrased as "may conflict with…".
  Chrome-only (it needs a page to know the community); native hosts
  never fire it.
- The `docs/architecture/contradiction-cues.md` companion covers the
  source class, the parse→verify split, the tier caches, and the
  grounding invariants — read it before touching
  `packages/opencues-core/src/contradiction/`.

## See also

- `docs/architecture/contradiction-cues.md` — the engine + tier wiring
- `docs/features/sentence-cues.md` — the passive sentence-cue mechanism
  these ride on
- `docs/features/calendar-context.md` — the calendar-conflict cue is a
  sibling (schedule contradiction, `scope: sentence`, priority 90)
