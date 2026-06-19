# Blank Replacement Modes — `blankReplace`

Every keyword-bound blank declares how it wants the buffer to look
*after* the blank fires. Four modes, one frontmatter field:

```yaml
blankReplace: keep | wipe | wipe-all | auto
```

Default when unset: legacy behaviour driven by `blankClearKeywords` /
`blankConsumeContext` / `blankConsumeAll`. Existing blanks keep
working unchanged. New blanks should set `blankReplace` explicitly
and let the runtime resolve the right shape.

## The four modes

| Mode | Behaviour | Use when |
|---|---|---|
| `keep` | Only `_` becomes the answer. Keyword + surrounding context stay in the buffer. | The answer alone is ambiguous without the keyword (`70%` vs `volume 70%`). Volume, brightness, system labels. |
| `wipe` | The full **keyword + context phrase + `_`** becomes the answer. Surrounding text outside the keyword span stays. | Lookups where the answer is self-contained: "weather in london _" → "London: 13°C Overcast". |
| `wipe-all` | The **entire input buffer** becomes the answer. | Imperative blanks that transform the whole draft: `improve prompt _` becomes the improved prompt. |
| `auto` | Run a deterministic heuristic on the buffer; pick `keep` or `wipe`. | Most blanks. The heuristic matches how users naturally phrase. |

## The `auto` heuristic

`auto` reads the buffer text and decides between `keep` and `wipe`
based on whether what the user typed looks like a **question/equation**
(answer fills in place) or a **bare lookup phrase** (replace whole
expression).

The rule is purely deterministic — no LLM call, no model dependency.
Implementation: `determineReplaceMode` in
`packages/opencues-core/src/sources/fluid-blank-source.ts`.

```
auto → keep, IF the buffer ends with one of these tokens
        immediately before the `_`:

   is | are | was | were | am | be | equals    (copulas)
   =                                            (equation)
   :                                            (label)
   ?                                            (question)

auto → wipe, otherwise.
```

Example resolutions:

| Input | Heuristic match | Mode |
|---|---|---|
| `weather london _` | bare phrase | `wipe` |
| `what is the weather in london _` | bare phrase (`london _`) | `wipe` |
| `the weather is _` | copula `is _` | `keep` |
| `nvda _` | bare phrase | `wipe` |
| `today's affirmation is _` | copula `is _` | `keep` |
| `my affirmations are _` | copula `are _` | `keep` |
| `4 + 4 = _` | equation `= _` | `keep` |
| `answer: _` | label `: _` | `keep` |
| `what is x ? _` | question `? _` | `keep` |
| `Water boils at _ degrees Celsius` | `_` mid-sentence | `keep` |

The heuristic is **adjacency-sensitive**. The copula must sit
immediately before `_`:

| Input | Heuristic match | Mode |
|---|---|---|
| `the answer is _` | `is _` adjacent | `keep` |
| `this is the answer _` | `is` present but not adjacent | `wipe` |
| `today the affirmations are top _` | `are` present but not adjacent | `wipe` |

This matches how speech and writing actually work: `"X is _"` invites
a fill-in; `"X is something _"` is a complete statement that the
blank should replace with its answer.

### Keyword `auto` blanks vs fluid-blank — two consumers, one heuristic

`determineReplaceMode` has two callers, and they treat it differently:

- **Keyword-bound `auto` blanks** (weather / stocks / dictionary / …)
  resolve their mode through `resolveReplaceMode`, which runs the
  heuristic **as the sole decider**. Everything in this doc above
  describes that path. It stays a pure deterministic function — no LLM,
  no model dependency — because a keyword blank already knows its
  keyword span and the question is only "keep the keyword or wipe it".

- **Fluid-blank** (`FluidBlankSource.getCues`, the free-form `_` lookup)
  no longer lets the heuristic decide. The fused LLM call emits a
  `MODE: FILL|WIPE` line and the **model owns the open judgement**
  ("is this a terse query phrase, or a sentence with a gap?") — which
  is what makes it work across languages the English-anchored regex
  can't parse (`la racine cubique de 27 est _` → FILL, not a collapsing
  WIPE). The heuristic is kept only as a **deterministic data-loss
  floor**:

  | `determineReplaceMode(buffer)` | What the runtime does |
  |---|---|
  | `FILL` (a.k.a. `keep`) | Force FILL, **authoritatively** — the model may not escalate it to a destructive WIPE. These are the copula/equation/question shapes where a WIPE would collapse text the user typed (`3 + 4 = _` must stay `3 + 4 = 7`). |
  | `WIPE` | Defer to the model's `MODE` — rescues non-English sentences to FILL; a genuine terse lookup stays WIPE. Falls back to WIPE when the model omits/garbles MODE. |

  This is the same "model proposes, runtime validates a safety
  invariant" split the multi-paragraph WIPE guard uses. See
  `core 0.3.33` in the root CHANGELOG and the MODE RULES block in
  `FUSED_SYSTEM_PROMPT`. The `MODE` field is a required enum in
  `FLUID_FUSED_SCHEMA`, so strict-JSON providers always return it.
  Any edit to that prompt block must re-run
  `tests/benchmarks/fluid-blank-ambient/fused-bench.ts` (target 176/176).

## What `wipe` actually wipes

`wipe` drops three contiguous regions in the word stream:

1. The **keyword** (one or more words declared in `blankKeywords:`).
2. Any **context words** between the keyword and `_` (within
   `blankProximity`).
3. The `_` itself.

Text **before** the keyword stays put. Examples (auto in wipe mode):

| Buffer | After fill |
|---|---|
| `weather london _` | `London: 13°C Overcast` |
| `hello world weather london _` | `hello world London: 13°C Overcast` |
| `weather london _ then some text` | `London: 13°C Overcast then some text` |

The "context" terminates at the keyword's first word; anything
upstream of the keyword is the user's surrounding draft and is
preserved.

`wipe-all`, by contrast, drops the whole buffer including
pre-keyword text. Reserved for blanks that act on the entire draft
(e.g. a summariser). The shipped prompt-improver blank that once
used this mode was retired June 2026 — its intent moved to the
whole-buffer `TransformBlankSource` — but the mode remains available
to custom blanks.

## Embedding context in `wipe`-style answers

When a blank fires under `wipe` (or `auto` → `wipe`), the keyword +
context phrase is gone. If the user typed information that should
survive (location, ticker, query), the **blank's `get()` is
responsible for embedding it in the answer**.

Convention — `Subject: value` format:

```js
// weather/blank.js
return `${prettyLocation}: ${temp} ${desc}`;  // "London: 13°C Overcast"

// stocks/blank.js
return `${ticker}: $${price}`;                 // "NVDA: $198.47"

// gh-issues/blank.js
return `${repo}: ${count} open`;               // "opencues/opencues: 42 open"

// countries/blank.js
return `${prettyCountry} ${fact}: ${value}`;   // "France population: 67.8M"

// dictionary/blank.js
return `${word}: ${definition}`;               // "ephemeral: lasting for..."
```

Under `keep` mode the user's keyword stays in the buffer too, so the
output reads as slightly redundant (`"nvda is NVDA: $198.47"`) — a
fair price for self-contained `wipe` output. Users typing copula
phrasings are usually building a sentence and the redundant prefix is
swallowed by context.

## Precedence

When multiple flags are set, the resolver picks one effective mode:

```
explicit blankReplace      wins outright (keep | wipe | wipe-all)
explicit blankReplace=auto → run heuristic (keep | wipe)
blankReplace unset         → legacy flag path:
                             blankConsumeAll true  → wipe-all
                             blankConsumeContext true → wipe
                             blankClearKeywords true  → drop keyword
                                                        span only (niche)
                             nothing set              → keep (legacy default)
```

`blankReplace` always wins over the legacy flags. Authors migrating
from the old fields should set `blankReplace:` and delete the
legacy flag in the same edit.

## Migration cheat-sheet for the built-in blanks

What the May 2026 migration shipped — useful as a sanity reference
when designing a new blank:

| Blank | Mode | Answer shape |
|---|---|---|
| volume | `keep` | `70%` |
| brightness | `keep` | `70%` |
| claude-status | `keep` | `No — operational` |
| affirmations | `auto` | `I am strong` |
| weather | `auto` | `London: 14°C Partly cloudy` |
| stocks | `auto` | `NVDA: $198.47` |
| crypto | `auto` | `BTC: $68,432.50` |
| countries | `auto` | `France population: 67.8M` |
| dictionary | `auto` | `ephemeral: lasting for...` |
| gh-issues | `auto` | `opencues/opencues: 42 open` |
| hackernews | `auto` | `<top story title>` |
| opencues | (selector/satellite — separate UX) | `voice-mode active` |

(The retired `answer` / `prompt` blanks — June 2026 — used `wipe` and
`wipe-all` respectively; their intents now route through `FluidBlankSource`
and `TransformBlankSource`, which manage their own span scoping rather than a
`blankReplace` mode.)

Authors writing new keyword-bound blanks should default to `auto`
and only override when the answer alone is ambiguous (volume,
brightness) or the blank rewrites the whole draft (a summariser, say).

## When to update this doc

- Whenever a new mode is added.
- Whenever the heuristic regex changes (especially adding/removing a
  copula). Note the heuristic is now only a **floor** for fluid-blank
  (the model's `MODE` decides above it) but still the **sole** decider
  for keyword `auto` blanks — see "Keyword `auto` blanks vs fluid-blank".
- Whenever the fluid-blank MODE prompt block or the FILL/WIPE floor
  logic in `getCues` changes.
- Whenever the migration cheat-sheet drifts from the actual built-in
  blanks (i.e. a built-in's `blankReplace` changes).

Tests that pin both the resolver (`fluid-blank-source.test.ts`) and
the runtime dispatcher (`blank-fill.test.ts` § "blankReplace mode")
must stay green when this doc is updated.
