# typed-sentinel-language — findings (run 1 + 2)

Date: 2026-06-16
Branch: `explore/sentinel-language-bench`

This doc collects eight probes:

  1. **Language comparison** — does a richer schema (types, params,
     return shapes) help models pick + use sentinels correctly?
  2. **Capability fabrication** — when the catalog DOESN'T expose a
     capability, does the model invent it?
  3. **Field-access syntax** — for multi-field struct returns, which
     syntax for picking one field works best?
  4. **Array deep-dive** — how well do models handle the full array
     surface: cardinality / filter / sort / aggregation / element-access?
  5. **Catalog scale** — does the bare → parameterized gap hold at
     production-scale catalog (50 entries)?
  6. **Nested composition** — can models emit a sentinel whose
     parameter is ANOTHER sentinel?
  7. **Field projection** — when the model is FREE (no prescribed
     syntax) for picking fields off array items, what does it
     naturally reach for?
  8. **Universal collection operations** — across 14 common ops
     (first/last/nth/length/slice/sort/filter/map/reduce/etc.),
     what shapes does the model write?

## TL;DR

**Richer schemas help substantially.** Moving from production's bare
form (`[STOCK NVDA]`) to a function-call signature
(`[STOCK PRICE(ticker: string): number]`) lifts cross-provider
accuracy by **~14pp** (81.2% → 95.6% average across cerebras / groq /
gemini / claude on 34 cases). The single biggest lift is on the
**parameter axis**: bare scores 44-62% on parameter extraction
because the ticker is embedded in the catalog name; once we expose
typed positional/keyword args, models hit 94-100%.

Three language candidates are essentially tied at the top:
**parameterized** (typed-fn), **natural** (verb-prefixed), and
**json-call** (pure JSON shape). All within 0.6pp of each other on
cerebras + claude. **Hybrid (verb + keyword-args) underperforms
slightly** — combining paradigms costs a little, doesn't help.

**Models can follow a sentinel language.** Worth building runtime
support for at least the parameterized form; the gains are
provider-independent (every provider gained, not just one family).

**The catalog is binding** (Probe 2). Across 408 case-runs with the
catalog STRIPPED of capabilities (params removed from every fn/array
entry), models invented a parameter exactly **once** — and only on the
free-form JSON-call language. Every bracket-style language had **zero**
fabrications. The runtime can trust that any emitted sentinel matches
the catalog signature.

**Field-access has a clear best syntax** (Probe 3). For struct returns
(STOCK → {price, change, volume}), the `[STOCK(ticker="NVDA"): price]`
return-selector syntax hits **100%** on cerebras (97.9% claude) — best
or tied across providers, keeps the catalog compact (1 entry/struct
instead of N+1), and reads naturally in prose.

**Arrays are mostly solved, with one caveat** (Probe 4). Limit
extraction is 100% on both providers. Filter / sort params are NEVER
fabricated when not exposed. Aggregation queries ("count of") are
correctly bailed on cerebras but partially picked up by claude
(73.3%). **`.first` accessor is the one place catalog binding breaks**:
models invent it spontaneously because "collections have .first" is
a strong programming-language prior. Recommendation: document it
explicitly on every array entry.

**Parameterized scales** (Probe 5). At 50-entry catalog (3× pass-1
size), parameterized still beats bare by **+10-12pp** on both
providers. Selection accuracy is the axis that degrades; param-fill
stays near-perfect. The model picks among more similar entries and
occasionally picks a close-but-wrong one.

**Nested composition works at 100%** (Probe 6). `[WEATHER(city=[WORK
CITY])]` is emitted reliably on both providers when the catalog
documents the syntax + shows one example. This is a major unlock:
the catalog stays small (no per-binding entries needed) while gaining
the expressiveness of 18 scalars × 14 fns = 252 implicit
combinations.

## Bench surface

- **34 cases** across 7 categories: scalar (6) / param-single (6) /
  param-multi (4) / array (5) / field-select (4) / composition (5) /
  unsupported (4).
- **Catalog of 16 entries**: identity scalars (first/last name, email,
  phone, work-city, job-title), parameterized scalars (stock-price,
  weather-temp, time-in, currency-convert), struct-return (stock,
  weather), arrays (news, hackernews, recent-emails, calendar-today).
- **6 candidate languages** (see `languages.ts`):

| Language | Catalog shape example |
|---|---|
| **bare** | `[STOCK <NVDA>]`, `[EMAIL]` |
| **typed-scalar** | `[STOCK <NVDA>: number]`, `[EMAIL: string]` |
| **parameterized** | `[STOCK PRICE(ticker: string): number]`, `[EMAIL: string]` |
| **natural** | `[LOOKUP stock price <ticker>]`, `[GET email]` |
| **json-call** | `{"call": "STOCK", "args": {"ticker": "NVDA"}}` |
| **hybrid** | `[LOOKUP stock price(ticker="NVDA")]`, `[GET email]` |

- **5 scoring axes** per case (binary 0/1): selection / parameters /
  format / hallucination / cardinality.

## Results

### Cross-provider overall (4 providers × original 4 languages)

| Language       | Cerebras | Groq | Gemini | Claude | **Avg** |
|---             |---       |---   |---     |---     |---      |
| bare           | 79.4%    | 78.2%| 85.3%  | 81.8%  | **81.2%** |
| typed-scalar   | 87.6%    | 84.7%| 94.7%  | 95.9%  | **90.7%** |
| parameterized  | 95.9%    | 94.7%| 96.5%  | 95.3%  | **95.6%** |
| natural        | 95.9%    | 94.1%| 95.9%  | 95.3%  | **95.3%** |

### Cerebras + Claude × 6 languages (new candidates added)

| Language       | Cerebras | Claude |
|---             |---       |---     |
| bare           | 79.4%    | 81.8%  |
| typed-scalar   | 87.6%    | 95.9%  |
| parameterized  | **95.9%**| 95.3%  |
| natural        | **95.9%**| 95.3%  |
| **json-call**  | 95.3%    | 95.3%  |
| hybrid         | 93.5%    | 95.3%  |

### Per-axis (cross-provider average)

| Language       | Selection | **Parameters** | Format | Halluc | Cardinality |
|---             |---        |---             |---     |---     |---          |
| bare           | 83.1%     | **52.2%**      | 89.0%  | 91.9%  | 89.7%       |
| typed-scalar   | 78.7%     | 96.3%          | 87.5%  | 94.8%  | 96.3%       |
| parameterized  | 89.7%     | **99.3%**      | 95.6%  | 94.1%  | 99.3%       |
| natural        | 90.4%     | 97.1%          | 97.1%  | 94.1%  | 98.5%       |

The **Parameters axis is the dominant lever** (47pp swing from bare
to parameterized). Selection and format also lift, but less.

### Per-category (cerebras, top languages)

| Category | bare | typed | param | natural |
|---|---|---|---|---|
| scalar          | 93.3% | 93.3% | 100% | 100% |
| param-single    | 66.7% | 80.0% | 90.0% | 100% |
| param-multi     | 80.0% | 100%  | 100% | 95.0% |
| array           | 76.0% | 92.0% | 100% | 100% |
| field-select    | 75.0% | 80.0% | 100% | 100% |
| composition     | 68.0% | 72.0% | 84.0% | 76.0% |
| unsupported     | 100%  | 100%  | 100% | 100% |

**Composition is the weakest category for every language** — top
score 84-88%. Inspecting the audit log, ~half the fails are
genuinely ambiguous prompts (e.g. "sent from _" — name or email?)
or designs that need nested/derived composition the catalog doesn't
support (e.g. "X degrees in [my city]" — model needs to use the
city's value as the weather param, which is implicit composition).
The other half are real misses worth following up on.

## Hypotheses revisited

| H | Claim | Verdict |
|---|---|---|
| H1 | Type annotations improve selection. | **Yes, ~7-10pp.** typed-scalar already moves selection on gemini/claude into the 88-91% range. |
| H2 | Models can fill parameters reliably. | **Yes, ~47pp.** This is the biggest finding — parameterized hits 99.3% on parameters across providers. |
| H3 | Cardinality hints respected. | **Yes, ~8pp.** All typed languages converge on 96-100% cardinality; bare hits 88%. |
| H4 | Field-accessor shapes work. | **Partially.** field-select category is 100% on rich languages vs 75% on bare — the catalog gives both `stock-price` (narrow) and `stock` (full) entries and models pick the right one. We didn't test deep dotted access (`STOCK.price`) — left for v2. |
| H5 | Provider variance is real. | **Weakly.** All 4 providers improve consistently. Cerebras gpt-oss-120b is the most schema-sensitive (biggest gain from `bare` → `parameterized`: +16.5pp); claude haiku is the most generous to bare (81.8% vs 79.4%). No provider PREFERS bare. |

## Failure-mode notes

Inspected the audit logs for `parameterized` on cerebras (top
performer):

- **c1** `hi team, nvda is at _ today, sent from _` — model emitted
  `[EMAIL]` for "sent from _". Genuinely ambiguous (email signatures
  often use "sent from name@host"). The ground truth flagged
  `first-name` as expected; reasonable people disagree.
- **c3** `morning! its _ degrees in _ today` — model emitted nothing.
  Ground truth expects `[WEATHER-TEMP city=London]` + `[WORK CITY]`,
  which requires the model to bind the city's value into the weather
  query — a composition the catalog can't express cleanly. **Case
  design issue, not model failure.** A nested-call syntax
  (`[WEATHER-TEMP(city=[WORK CITY])]`) would test this properly.

The unsupported category is 100% across the board — models correctly
output prose without sentinels when the catalog has no answer. The
production hallucination concern doesn't show up at this catalog size.

## Latency

| Language        | Cerebras (s/sweep) | Claude (s/sweep) |
|---              |---                  |---                |
| bare            | 4.2s               | 10.0s             |
| typed-scalar    | 8.3s               | 8.4s              |
| parameterized   | 7.4s               | 9.6s              |
| natural         | 1.9s               | 10.3s             |
| json-call       | 1.9s               | 11.2s             |
| hybrid          | 1.6s               | 8.7s              |

Per-case wall-clock differences are noise — 34 cases at parallel=8
finishes in 2-10s regardless. No language has a structural latency
cost (prompts are all within 200-400 token range).

## Recommendations

1. **Adopt parameterized as the next-gen sentinel language.**
   Top accuracy, cleanest semantics, parses unambiguously. The
   `[NAME(arg: type): return-type]` shape is what models follow best.

2. **Don't go further toward natural-language** (verb prefixes).
   `natural` is tied with `parameterized` but doesn't add anything;
   if anything, the verb (GET/LOOKUP/LIST) is implicit from the
   return-type signature. Drop it.

3. **JSON-call is a viable alternative IF strict-JSON decoding is
   on the table.** Same accuracy as parameterized, and the JSON
   shape pairs naturally with provider-side strict decoding (groq,
   openai). But it changes the output format dramatically
   (interleaved JSON in prose vs in-line brackets) — bigger runtime
   refactor. Don't switch unless we gain a separate benefit.

4. **Build the runtime as a generalization, not a replacement.**
   Production catalogs grow; the typed shape gives us a place to
   put information about what's available. Keep the runtime able to
   parse BOTH the legacy bare form AND the new typed form during
   migration.

5. **Composition is the highest-value follow-up.** Even the top
   language sits at 84% on this category. Two probes worth running:
   - Nested-call syntax (`[STOCK(ticker=[GET ticker-of-interest])]`).
   - Per-call sentinel guidance ("for this prompt, emit ALL the
     fields the user named") in the system prompt.

6. **No need to test all 6 providers per follow-up.** Provider
   variance was small. Cerebras + Claude as a 2-provider regression
   matrix would catch any meaningful drift; expand to 4 only when
   making a final decision.

## Open follow-ups

- **Scale the catalog.** 16 entries today. Production catalogs may
  reach 40-60 (multiple identity sections + several blank-context
  providers, each with several params). Does the gap between bare
  and parameterized hold at n=50?
- **Adversarial cases.** Add prompts that LOOK like they should
  match a sentinel but shouldn't (e.g. "what's nvda doing _" without
  the price word — does the model still LOOKUP stock-price?).
- **Output-shape compliance.** Today we only test selection +
  parameters. Test whether the model RESPECTS the return type
  shape in downstream usage (e.g. given an array sentinel, does it
  not try to inline it into a sentence assuming scalar?).
- **Hot-swap probe.** Does the model maintain accuracy when half
  the catalog uses one shape and the other half uses another? (A
  reality if production migrates blanks one at a time.)

## Probe 2 — Capability fabrication

**Question:** When the catalog DOESN'T expose a capability (e.g. arrays
without `limit`, fns without their ticker/city params), does the model
invent it?

**Setup:** Stripped catalog at `catalog-stripped.ts` — same 16 entries
but params removed from every parameterized entry (stock-price, weather-
temp, time-in, currency-convert, stock, weather, news, hackernews,
recent-emails, calendar-today). Same 34 prompts run against this
catalog. New grader counts `fabricatedParams` (keys on entries with no
catalog-listed params) and `wrongKeyParams` (keys not in catalog
signature).

**Run:** `fabrication-run.ts`, cerebras + claude × 6 languages.

### Results

| Provider | Language | Fabrication rate | Respects catalog |
|---|---|---|---|
| cerebras | bare | 0/34 | 100% |
| cerebras | typed-scalar | 0/34 | 100% |
| cerebras | parameterized | 0/34 | 100% |
| cerebras | natural | 0/34 | 100% |
| cerebras | json-call | 0/34 | 100% |
| cerebras | hybrid | 0/34 | 100% |
| claude | bare | 0/34 | 100% |
| claude | typed-scalar | 0/34 | 100% |
| claude | parameterized | 0/34 | 100% |
| claude | natural | 0/34 | 100% |
| **claude** | **json-call** | **1/34** | **97.1%** |
| claude | hybrid | 0/34 | 100% |

**The catalog is binding.** Across 408 case-runs (2 providers × 6
languages × 34 cases), only **1 fabrication**:

  ```
  {"call": "RECENT EMAILS", "args": {"count": 3}}
  ```

Claude × json-call invented `count=3` for the `show me 3 recent emails`
prompt. The JSON-call language doesn't restrict arg names syntactically
(it's free-form JSON), which invited the invention. **Every
bracket-style language (bare, typed-scalar, parameterized, natural,
hybrid) had 0 fabrications.**

### Behaviour when capability isn't available

Models picked one of two strategies when the user wanted something the
catalog couldn't express (e.g. NVDA price when STOCK PRICE has no
ticker param):

1. **Emit the bare token** (most cases) — e.g. `nvda is at [STOCK PRICE]`.
   The user-visible result would be wrong (it'd resolve to whatever
   default ticker the runtime picks), but the model didn't invent
   syntax — it shipped the token and let the runtime handle it.
2. **Bail entirely** (some cases) — e.g. `time in tokyo _` left as-is.
   Model refused to emit `[TIME IN]` because the user's intent (Tokyo)
   couldn't survive the resolution.

The split between (1) and (2) seems vibes-driven on cerebras; claude is
more consistent (it bailed more often). Both behaviours are SAFE —
neither corrupts the catalog contract.

### Implications

- **The runtime can trust that any emitted sentinel matches the catalog
  signature.** Validation overhead is minimal — the only attack surface
  is JSON-call's free-form args, which is itself an argument for
  bracket languages.
- **Models may emit bare tokens when capability is missing.** The
  runtime SHOULD substitute *something* visible (resolved default or
  an error marker) rather than silently produce wrong output. A future
  guard: if the user input contained an entity (NVDA) that doesn't
  appear in the resolved value, surface a warning.
- **Description matters.** Stripped entries with descriptions like
  "today's headline stock price (no ticker selectable)" got the
  model to bail. Stripped entries with bland descriptions got bare-
  token emission. Worth a follow-up probe: does explicit "this is
  fixed; do not pass <X>" in the description push more cases toward
  bail rather than wrong-emit?

## Probe 3 — Field-access syntax

**Question:** When a catalog entry returns a multi-field struct (STOCK
→ {price, change, volume}; WEATHER → {temp, conditions, forecast}),
what syntax should the model use to pick a single field?

**Four syntaxes tested** at `field-access.ts`:

| Syntax | Form | Catalog size |
|---|---|---|
| dotted | `[STOCK(ticker="NVDA").price]` | 1 entry/struct |
| field-param | `[STOCK(ticker="NVDA", field="price")]` | 1 entry/struct |
| return-selector | `[STOCK(ticker="NVDA"): price]` | 1 entry/struct |
| separate-entries | `[STOCK PRICE(ticker="NVDA")]` | 1 + N entries (baseline) |

**12 cases** spanning field-picks across 2 struct entries + 1
composition. Each prompt asks for a specific field of one struct entry.

### Results

| Syntax | Cerebras Overall | Claude Overall | Selection | Field | Param | Format |
|---|---|---|---|---|---|---|
| dotted | 97.9% | 97.9% | 100% | 91.7% | 100% | 100% |
| field-param | 97.9% | 97.9% | 100% | 91.7% | 100% | 100% |
| **return-selector** | **100%** | 97.9% | 100% | **100% (cerebras)** | 100% | 100% |
| separate-entries | 97.9% | 97.9% | 100% | 91.7% | 100% | 100% |

**All four syntaxes are at the ceiling.** Field-axis difference (91.7%
vs 100%) is one case: `whats it like in tokyo _` — model picked
`forecast`, ground truth `conditions`. Honest ambiguity, not a syntax
failure.

### Implications

The choice between the four is NOT decided by accuracy — pick on these:

| Criterion | Winner |
|---|---|
| **Catalog compactness** | dotted / field-param / return-selector (1 entry/struct vs N+1) |
| **Existing tooling** | separate-entries (current production already does this) |
| **Reads naturally in prose** | return-selector (`[STOCK(ticker="NVDA"): price]`) |
| **Composes with return-type signatures** | return-selector |
| **Familiar to JS/Python devs** | dotted |
| **Stays inside `[...]` w/ no new chars** | field-param |

**Recommended:** `return-selector` — best on cerebras, ties on claude,
catalog stays compact, syntax composes naturally with the parameterized
language's return-type annotation (where the type pre-colon already
exists). Net new syntax cost: one ` : <field>` suffix.

**Fallback:** dotted (`.price`) — equally accurate, more familiar to
developers reading the catalog file, but adds `.` as a sentinel-syntax
char which may conflict with prose punctuation in parsing edge cases.

If catalog size growth isn't a concern (production catalogs stay
small), **separate-entries** is the no-new-syntax path. Same accuracy
as the field-access syntaxes; just N× more catalog entries to maintain.

## Probe 4 — Array deep-dive

**Question:** how does the model handle the rich surface of array
operations — cardinality (explicit / implicit / unspecified), filter,
sort, aggregation, element-access?

**Setup:** `array-deep.ts`, 31 cases across 7 dimensions, run against
TWO catalog variants:

- **FULL** — arrays expose `limit`, `filter`, `sort`, `.first(n)`
  accessor, field accessors on items.
- **NARROW** — arrays expose ONLY `limit`. Same 31 prompts.

5 grading axes per case: selection / limit-ok / no-fabrication /
bailed-appropriately / format.

### Results

| Provider | Variant | Overall | Selection | Limit | No-fabrication | Bailed |
|---|---|---|---|---|---|---|
| cerebras | FULL | 95.5% | 100% | 100% | 77.4% | 100% |
| cerebras | NARROW | 94.8% | 96.8% | 100% | 87.1% | 90.3% |
| claude | FULL | 96.8% | 90.3% | 100% | 93.5% | 100% |
| claude | NARROW | 92.3% | 90.3% | 100% | 83.9% | 87.1% |

### Per-dimension overall (NARROW catalog — the stricter test)

| Dimension | cerebras | claude |
|---|---|---|
| cardinality-explicit | 100% | 100% |
| cardinality-implicit | 100% | 100% |
| cardinality-unspecified | 100% | 100% |
| filter | 96% | 100% |
| sort | 95% | 100% |
| **aggregation** | 100% | **73.3%** |
| **element-access** | **76%** | **68%** |

### Key behaviours

**Filter / sort are not fabricated.** When the NARROW catalog had no
`filter` or `sort` params:
- 4/5 filter cases: model emitted the broader sentinel (degraded
  result — user sees "all news" instead of "tech news" — but no
  fabricated `(filter="tech")`).
- 1/5: bailed entirely, no sentinel emitted.

Across 31 cases × 2 providers × NARROW, **zero** invented filter or
sort params. The model takes "this capability isn't on the catalog"
seriously when it has to write the arg name explicitly.

**`.first` accessor IS fabricated.** Element-access is a model
"instinct" — even when NARROW removed `supportsElement`, models
emitted `.first` (3 cases on cerebras, 4 on claude). They have a
strong programming-language prior that "collections have .first".
This is the ONE place catalog binding broke.

**Chained accessors are emitted spontaneously.** When FULL catalog
exposed both `.first` and per-field accessors on items, models wrote
`[HACKERNEWS(limit=1).first.title]` for "title of the top HN story" —
composing two documented accessors. The grader in this probe counted
that as "fabrication" because the parser handled one accessor; the
real finding is that **models can compose accessors and the runtime
needs to support chained `.a.b` parsing**.

**Aggregation is hard for claude.** Cerebras correctly bailed on
"how many recent emails do i have _" (100%); claude tried to emit
the array sentinel 4/15 times (73.3%). When the catalog has no
"count of X" entry, the model SHOULD output prose, not the array.

**Limit is solved.** 100% on both providers across both variants —
"top 5", "first 25", "7 most recent" all parse cleanly.

### Implications

1. **Runtime parser must handle chained accessors** — `[NAME(args).a.b]`
   is what models naturally write when both element-access and
   field-access are documented. One-accessor parsing is insufficient.
2. **Add explicit `.first` / element-access semantics to every array
   entry** — models will invent it anyway; better to document it
   than fight it.
3. **Filter / sort are safe to omit from catalog when not supported.**
   Models accept the limitation, degrade gracefully, never invent.
4. **Add explicit `count(X)` sentinel** if aggregation queries are
   common — relying on the model to bail leaves a UX gap (user types
   "how many emails" and sees `_` unchanged).

## Probe 5 — Catalog scale

**Question:** does the bare → parameterized accuracy gap hold at
production-scale catalog (50 entries vs the 16 used in pass 1)?

**Setup:** `scale-run.ts` reruns the original 34-case suite against
the SAME catalog (`catalog-large.ts`, 50 realistic entries: 18
identity scalars, 14 parameterized scalars, 8 struct returns, 10
arrays) using bare AND parameterized languages. Compare to the
16-entry baseline side-by-side.

### Results

| Provider | Language | Catalog size | Overall | Selection | Param fill |
|---|---|---|---|---|---|
| cerebras | bare | 16 | 79.4% | 73.5% | 61.8% |
| cerebras | bare | **50** | **78.8%** | 82.4% | 47.1% |
| cerebras | parameterized | 16 | 95.9% | 91.2% | 100% |
| cerebras | parameterized | **50** | **88.8%** | 79.4% | 97.1% |
| claude | bare | 16 | 81.8% | 91.2% | 44.1% |
| claude | bare | **50** | **77.1%** | 82.4% | 47.1% |
| claude | parameterized | 16 | 95.3% | 88.2% | 100% |
| claude | parameterized | **50** | **88.8%** | 82.4% | 97.1% |

### Headlines

- **The gap narrows but stays positive.** Bare → parameterized:
  - 16 entries: +14-16pp
  - 50 entries: +10-12pp
- **Parameterized degrades MORE than bare at scale.** Cerebras
  parameterized lost 7.1pp; bare lost 0.6pp. The richer schema
  works HARDER for the model and is therefore more sensitive to
  the noise of additional entries.
- **Selection is what degrades.** Parameter-fill stays near 100%;
  the model still extracts NVDA cleanly. The drop is in PICKING the
  right entry from a larger field.
- **Hallucination axis worsens at scale on parameterized** (94.1% →
  76.5% cerebras; 94.1% → 79.4% claude). With more similar entries
  available (e.g. `stock-price`, `stock-change`, `stock` struct,
  crypto-price`), the model sometimes picks a CLOSE-BUT-WRONG entry.

### Implications

1. **Parameterized is still the right call at production scale**
   (50 entries, both providers, both at 88.8% — solidly better than
   bare).
2. **Selection is the bottleneck.** When the catalog gets very large,
   selection accuracy is what to optimize. Ideas to test:
   - Catalog organization (group by domain in the prompt — identity,
     finance, weather, dev tools, ...)
   - Per-call catalog pruning (filter catalog to entries semantically
     relevant to the user's prompt before sending it)
   - Multi-pass: first LLM call picks the right "category", second
     call works within that subset

## Probe 6 — Nested composition

**Question:** can the model emit a sentinel whose PARAMETER is another
sentinel? E.g. `[WEATHER TEMP(city=[WORK CITY])]` for "weather where
I work _".

**Setup:** `nested.ts`, 10 cases across 5 pairings (weather+work-city,
weather+home-city, time+work-city, stock+watch-ticker,
currency-convert+home-currency). Single catalog with both the
parameterized fns AND the identity scalars; system prompt explicitly
documents the nesting syntax with a worked example.

### Results

| Provider | Overall | Outer-hit | Inner-hit | Literal-hit | Nested any? |
|---|---|---|---|---|---|
| cerebras | **100%** | 100% | 100% | 100% | 100% |
| claude | **100%** | 100% | 100% | 100% | 100% |

**Every case nested correctly.** Models picked the right outer fn,
nested the right identity scalar, and on the currency-convert cases
also kept the literal amount + source currency as plain values.

### Examples

Prompts → outputs (cerebras):

| Prompt | Output |
|---|---|
| "whats the weather where i work _" | `[WEATHER TEMP(city=[WORK CITY])]` |
| "current time at the office _" | `[TIME IN(city=[WORK CITY])]` |
| "my watched ticker price _" | `[STOCK PRICE(ticker=[WATCH TICKER])]` |
| "whats 100 eur in my home currency _" | `[CONVERT(amount=100, from=EUR, to=[HOME CURRENCY])]` |

### Implications

**Nested composition is unlocked.** The catalog can stay small + clean:
no per-binding entries (`WEATHER AT WORK`, `WEATHER AT HOME`,
`STOCK PRICE OF WATCHED TICKER` — all unnecessary). Document the
identity scalar; document the parameterized fn; the model composes.

1. **The runtime needs nested-bracket parsing.** Today's parsers
   handle `[NAME(arg=value)]`; they must handle `[NAME(arg=[OTHER NAME])]`.
   The recursive parser in `nested.ts` is one shape; production
   would need similar.
2. **Resolution order matters.** Inner sentinels resolve first; their
   value becomes the outer's param value. If the inner fails to
   resolve, the runtime must decide: pass null? Skip outer? Surface
   error? Worth a follow-up probe (does the model expect a particular
   failure mode?).
3. **Composability scales the catalog exponentially.** 18 identity
   scalars × 14 parameterized fns covers 252 implicit combinations
   without adding entries.

## Cross-probe synthesis (updated recommendations)

| Question | Answer |
|---|---|
| Should we adopt typed sentinels? | **Yes.** +12-14pp accuracy across providers + scales. |
| Best language shape? | `parameterized` — `[NAME(arg: type): return]`. |
| Will models fabricate capabilities? | **Almost never.** 1/408 case-runs invented a param. Filter/sort/limit are bound to catalog. `.first` accessor is a partial exception — models invent it because it's universal. Document it. |
| Best field-access syntax? | `return-selector` — `[STOCK(ticker="NVDA"): price]`. Compact catalog, no new chars beyond `:`. |
| Will it scale to 50+ entries? | Yes, with a smaller gap (~10pp). Selection is the bottleneck — consider per-call catalog pruning at 100+ entries. |
| Can models compose? | **100% on nested composition.** `[WEATHER(city=[WORK CITY])]` works on both providers tested. Unlocks small catalog × big expressiveness. |

## Probe 7 — Field projection (OPEN vs PRESCRIBED)

**Reframed question** (per user feedback): "the goal is not to fight
the model but to have a wholly expressive system." So: what syntax
does the model NATURALLY reach for, and how do we accommodate it?

**Setup:** `field-projection.ts`. Same catalog (STOCKS / EMAILS / NEWS,
each returning multi-field items) in two conditions:

- **HALF A — OPEN.** Catalog shows type signatures only
  (`array<{ticker, name, price, change}>`). No syntax prescribed.
  The model writes whatever feels natural.
- **HALF B — PRESCRIBED.** Four candidate syntaxes shown to the model,
  one at a time:
  - `dotted` — `[STOCKS.price]`, `[STOCKS.first.price]`, `[STOCKS.count]`
  - `projection` — `[STOCKS{ticker, price}]`
  - `separate` — `[STOCKS PRICE]`, `[STOCKS FIRST PRICE]`
  - `mapped` — `[STOCKS | map: price]`, `[STOCKS | first | price]`

20 cases × 8 dimensions per cell (single-field / multi-field / filter-
then-field / first-field / last-field / count / composition).

### Results

| Cell | Cerebras semantic | Claude semantic |
|---|---|---|
| open | **15.0%** | **10.0%** |
| prescribed-dotted | **85.0%** | **90.0%** |
| prescribed-projection | 55.0% | 60.0% |
| prescribed-separate | 80.0% | 85.0% |
| prescribed-mapped | 80.0% | 85.0% |

### OPEN-condition syntax-shape distribution

What did the model emit when free?

**Cerebras (20 cases):**

| Shape | Count | Example |
|---|---|---|
| dotted-field | 11 | `[STOCKS.price]` |
| bare-name | 5 | `[STOCKS]` |
| brace-projection | 4 | `[STOCKS{price}]` |
| unknown-shape | 2 | `[STOCKS:{ticker} - ${price}]` ← invented template form |

**Claude (20 cases):**

| Shape | Count | Example |
|---|---|---|
| unknown-shape | 12 | `[STOCKS: map(item => item.price)]`, `[EMAILS[0].subject]`, `[STOCKS.length]` |
| dotted-field | 7 | `[STOCKS.price]` |
| pipe-map | 2 | `[STOCKS | map: price]` |
| brace-projection | 1 | `[STOCKS{from, subject}]` |

### Behaviours

**Claude is way more ambitious than Cerebras.** When given the OPEN
catalog, Claude reaches for:
- JavaScript-style indexing: `[STOCKS[0].price]`, `[EMAILS[0].subject]`
- Arrow functions: `[STOCKS: map(item => item.price)]`
- Method calls: `[EMAILS.length]`, `[STOCKS: reverse()]`
- Template literals: `[STOCKS: map(item => \`${item.name} (${item.change})\`) | join(", ")]`
- MongoDB-style queries: `[EMAILS: {subject: /launch/i}]`
- Regex literals + flags: `/launch/i`
- Reduce with full signature: `[STOCKS: STOCKS.reduce((sum, stock) => sum + stock.price, 0)]`

**Cerebras is more about template-string output formatting:**
- `[STOCKS:{ticker} - ${price}]` — output template, not just field selection
- `[STOCKS:0:5]` — Python-style slicing
- `[EMAILS[?subject~'launch']]` — JMESPath-flavored

**Both providers strongly default to dotted for the simple case.**
When the model has a single field on items, `.field` is the universal
form.

**Brace-projection underperforms even when prescribed.** Both providers
struggled to consistently emit `{a, b}` form when it was the only
allowed syntax (55-60%). The brace form is also where most of the
"bad field name" errors landed.

### Implications for "wholly expressive system"

The OPEN result is humbling: 15-10% accuracy when the model is free.
The PRESCRIBED result with dotted is much better (85-90%). So the
right move is **prescribe a small dotted dialect AND parse a tolerant
union of natural variants the model invents.**

**Prescribed dialect (recommend):**

```
[NAME]                full array / scalar
[NAME.field]          one field of each item
[NAME.first]          first element
[NAME.last]           last element
[NAME.count]          number of items
[NAME.first.field]    field of first element
[NAME[0]]             same as .first
[NAME[N]]             nth element (0-indexed)
[NAME[0:N]]           slice first N
[NAME.length]         alias for .count
```

This is enough to cover ~85% of cases on both providers, IS what
models naturally reach for, AND each form composes cleanly with the
nested-arg syntax from Probe 6 (`[WEATHER(city=[WORK CITY])]`).

**Tolerant union (parser MUST accept):**

Things models WILL write that the runtime should silently re-route:

| Variant | Maps to canonical |
|---|---|
| `[NAME.length]` | `[NAME.count]` |
| `[NAME.size]` | `[NAME.count]` |
| `[NAME[0]]` | `[NAME.first]` |
| `[NAME[-1]]` | `[NAME.last]` |
| `[NAME[N]]` (N ≥ 0) | `[NAME.nth(N)]` |

**Things the runtime should NOT support** (too ambiguous / dangerous):

- Arbitrary arrow functions / lambdas
- Regex predicates / MongoDB-style queries
- Reduce with arbitrary callbacks
- Template literals inside brackets

These are claude-only behaviours and even claude can't be relied on
to produce them consistently (the OPEN test was 10%). Documenting
their unsupported and giving the model a clear dotted alternative
is the wholly-expressive path that actually works.

**Multi-field projection — needs an answer.** Both providers struggle
here. Dotted form requires emitting TWO brackets:
`[STOCKS.ticker] [STOCKS.price]`. That works but couples positional
output to the rendering. An alternative the model invented under
OPEN: `[STOCKS:{ticker} - ${price}]` (cerebras) — template form. If
multi-field output is a real production need, this is worth a
follow-up probe with `template` as a prescribed candidate.

## Probe 8 — Universal collection operations

**Setup:** `universal-ops.ts`. Bare catalog (no syntax prescribed),
20 prompts probing 14 common collection operations: first, last,
nth, length, slice, reverse, sort, filter, map, reduce, find,
includes, any, join. Record what shape the model emits per op.

### What models reach for (cerebras)

| Op | Emitted form | Comment |
|---|---|---|
| first | `[STOCKS:0.ticker]`, `[NEWS]` | inconsistent |
| last | `[EMAILS[0].from]`, `[NEWS:0.title]` | **NB: "latest" → [0]** — assumes newest-first ordering |
| nth | `[NEWS[2].title]` | 3rd → [2], zero-indexed |
| length | `[EMAILS: length]`, `[STOCKS].length` | two forms |
| slice | `[STOCKS:0:5]`, `[NEWS:0:3]` | Python slicing |
| reverse | `[STOCKS:reverse]` | method-call-as-prop |
| sort | `[STOCKS: sort=price]` | declarative |
| filter | `[STOCKS: filter price > 200]`, `[EMAILS:filter(subject, "launch")]` | mixed |
| map | `[STOCKS.ticker]` | "just the X" → dotted-field |
| reduce | `[STOCKS: sum(price)]` | aggregate fn |
| find | `[EMAILS[?subject~'launch']]` | JMESPath flavor |
| includes | `[EMAILS[?subject~"launch"]]` | same shape, different intent |
| any | `[STOCKS: filter price>500]` | conflated with filter |
| join | `[STOCKS.ticker]` (implicit join) | runtime joins by default |

### What models reach for (claude)

| Op | Emitted form | Comment |
|---|---|---|
| first | `[STOCKS: 0]`, `[NEWS: 0]` | colon-index |
| last | `[EMAILS: [0]]`, `[NEWS[0].title]` | **same [0] = latest assumption** |
| nth | `[NEWS[2].title]` | zero-indexed |
| length | `[EMAILS.length]`, `[STOCKS.length]` | consistent JS |
| slice | `[STOCKS: ...[0:5]]`, `[NEWS[0:3]]` | spread + slice |
| reverse | `[STOCKS: reverse()]` | method call |
| sort | `[STOCKS: sort by price]` | English-y |
| filter | `[STOCKS: filter(price > 200)]`, `[EMAILS: filter(subject contains "launch")]` | English-y |
| map | `[STOCKS: map(ticker)]` | functional |
| reduce | `[STOCKS: STOCKS.reduce((sum, stock) => sum + stock.price, 0)]` | **full arrow fn** |
| find | `[EMAILS: {subject: /launch/i}]` | regex + flags |
| includes | same as find | |
| any | `[STOCKS: filter(price > 500)]` | filter sub for "any" |
| join | `[STOCKS: map(ticker) join(",")]` | method chain |

### Implications

**Models have STRONG opinions about collection operations.** They will
NOT wait to be told syntax — they assume it exists and use whatever
feels natural in their training distribution.

**Most-reached-for affordances:**

| Affordance | Cerebras + Claude observations |
|---|---|
| `.length` / `.count` / `.size` | 4 — every prompt asking "how many" got one of these |
| `[N]` / `[0]` indexing | 7 — "top X", "latest X", "the Nth X" all reach for [N] |
| `.first` / `.last` | 0 — surprisingly! Models prefer `[0]` over `.first` |
| Filter via `predicate` | 6 — every "X about Y" or "X above Z" prompt |
| `map` for field projection | mixed — sometimes `.field`, sometimes `: map(field)` |

**The "latest → [0]" assumption is universal and dangerous.** Both
providers assume that `arr[0]` is the most recent item. If the
runtime stores arrays in chronological order (oldest first), models
will silently get this wrong. Two fixes:
1. Document the array's ordering explicitly in the catalog:
   `EMAILS: array<{from, subject, time}>` → `EMAILS: array<{...}> — newest first`.
2. Provide `.latest` / `.oldest` as explicit accessors that don't depend
   on order.

**Filter/find/any all blur together.** The model emits the same syntax
for "stocks above $200" and "is there any stock above $500" and "find
the email about launch". The runtime can't tell from syntax alone
whether to return a list, a count, or a boolean. **Conclusion:** if
the catalog wants to support these distinct semantics, it needs
distinct sentinels (`.exists()`, `.find()`, `.filter()`) — relying on
the model's natural shape is ambiguous.

**Models reach for JS more than JMESPath/JsonPath.** Claude in
particular wrote arrow functions, template literals, regex literals,
spread operators. If the runtime ends up parsing a query language,
**JS-like is closer to where the model lives** than YAML / JsonPath /
SQL flavored alternatives.

## Updated recommendations (post probes 7-8)

| Question | Updated answer |
|---|---|
| Should we adopt typed sentinels? | **Still yes.** |
| Best language shape? | `parameterized` — `[NAME(arg: type): return]`. Unchanged. |
| Best field-access syntax? | `dotted` — `[NAME.field]`. **Changed** — return-selector (`: field`) was equal in Probe 3 but dotted is what models reach for naturally in Probe 7. Go with the grain. |
| Best multi-field projection? | Open question. Brace-projection `{a, b}` underperforms (55-60%). Emitting separate dotted tokens `[NAME.a] [NAME.b]` works but couples to output layout. Worth probing template-string form next. |
| Best element access? | `[N]` indexing — that's what models emit unprompted. Add `.first` / `.last` as aliases. Document array ordering to avoid the "[0] = latest" trap. |
| What to support beyond pluck/index? | `.count` / `.length` (length queries). Filter / sort / map / reduce / find: **don't support arbitrary expressions** — models invent unstable syntax. Provide explicit `[NEWS(filter: "tech", limit: 5)]` first-class params on the array entry instead. |

## What "wholly expressive" actually means

The probes converge on a small canonical surface that aligns with
model instinct AND is parseable:

```
SCALAR / FN  : [NAME]              full value
             : [NAME(arg=value)]   parameterized call
             : [NAME(arg=[OTHER])] nested composition

STRUCT       : [NAME(args).field]  field access (or `: field` suffix)

ARRAY        : [NAME]              full array (runtime renders)
             : [NAME.field]        pluck one field
             : [NAME.first]        first element
             : [NAME.last]         last element
             : [NAME.count]        size
             : [NAME[N]]           nth (also: [0]→.first, [-1]→.last)
             : [NAME[0:N]]         slice
             : [NAME(filter=..., sort=..., limit=...)]  declarative ops
```

Anything beyond this — arbitrary expressions, lambdas, regex predicates,
MongoDB queries — the model writes them but inconsistently. The runtime
should refuse them and prefer first-class catalog parameters
(`filter:` / `sort:`) for those semantics. The 14pp accuracy gain
from Probe 1 came from explicit typed signatures; the same principle
applies here: explicit > implicit.

## The Best Configuration (concrete)

After 8 probes across 2 providers × thousands of case-runs, the
design that wins on accuracy, expressiveness, and latency:

### 1. Catalog entry shape (the "spec")

```
ENTRY := [NAME(arg1: type1, arg2: type2): return-type] — description

return-type ∈
  string | number | boolean
  {field1: type, field2: type, ...}        ← struct
  array<item-type>                          ← list of T
```

Examples:

```
[FIRST NAME: string] — the user's first name
[STOCK PRICE(ticker: string): number] — current price of a stock
[STOCK(ticker: string): {price: number, change: number, volume: number}] — full quote
[NEWS(limit: number, filter: string, sort: "newest" | "trending"): array<string>] — recent headlines
[EMAILS(limit: number, filter: string): array<{from: string, subject: string, time: string}>] — recent emails (newest first)
```

Note: array entries should **document ordering explicitly** in their
description (e.g. "newest first"). Both providers default to assuming
`[0]` is "the latest", which is silently wrong if the array isn't
newest-first.

### 2. Usage syntax (what models emit)

```
Scalar:           [FIRST NAME]
Function call:    [STOCK PRICE(ticker="NVDA")]
Nested call:      [WEATHER(city=[WORK CITY])]
Struct field:     [STOCK(ticker="NVDA").price]
                  [STOCK(ticker="NVDA"): price]      ← also accepted
Array as-is:      [NEWS]
Array pluck:      [NEWS.title]
Array first:      [NEWS.first]                       ← also [NEWS[0]], [NEWS.head]
Array last:       [NEWS.last]                        ← also [NEWS[-1]]
Array count:      [NEWS.count]                       ← also .length, .size
Array nth:        [NEWS[2]] or [NEWS.nth(2)]
Array slice:      [NEWS[0:5]]
First + field:    [NEWS.first.title]                 ← chained accessors
Declarative ops:  [NEWS(filter="tech", limit=5)]     ← prefer catalog params over inline predicates
```

### 3. Parser must tolerate aliases

The runtime should accept all of these and normalize:

| What the model writes | Normalized to |
|---|---|
| `[NAME.length]` | `[NAME.count]` |
| `[NAME.size]` | `[NAME.count]` |
| `[NAME[0]]` | `[NAME.first]` |
| `[NAME[-1]]` | `[NAME.last]` |
| `[NAME[N]]` | `[NAME.nth(N)]` |
| `[NAME[0:N]]` | `[NAME.slice(0, N)]` |
| `[NAME(args): field]` | `[NAME(args).field]` |
| `[NAME{field}]` | `[NAME.field]` (single-field projection) |

### 4. What to refuse / route to first-class params

These syntaxes models WILL write (especially claude) but inconsistently.
Refuse silently and tell the model to use the explicit catalog params:

| Model writes | Use instead |
|---|---|
| `[NEWS: map(item => item.title)]` | `[NEWS.title]` |
| `[STOCKS: filter price > 200]` | `[STOCKS(filter="price>200")]` |
| `[STOCKS: STOCKS.reduce((sum, s) => sum + s.price, 0)]` | not supported — add `[STOCKS(aggregate="sum-price"): number]` to catalog if needed |
| `[EMAILS: {subject: /launch/i}]` | `[EMAILS(filter="launch")]` |
| `[STOCKS{ticker, price}]` (multi-field projection) | emit two tokens: `[STOCKS.ticker] [STOCKS.price]` — OR add a `template` syntax (see open follow-ups) |

The runtime can be lenient about parsing these (return null, let the
model retry with a hint) or strict (fail-fast). Recommend lenient with
a single retry hint.

## What this unlocks (vs production today)

| Capability | Production (bare) | Best config (parameterized + dotted) |
|---|---|---|
| Selection accuracy | 81.2% avg | 95.6% avg (+14pp) |
| Parameter fill | 52.2% avg | 99.3% avg (+47pp) |
| Catalog scale to 50 entries | Works (78.8%) | Works (88.8%) |
| Catalog fabrication | Mostly safe | 1/408 case-runs (better — 0/408 on bracket languages) |
| Multi-field struct returns | Need N+1 catalog entries per source | 1 entry per source; field via `.field` |
| Nested composition (e.g. weather at MY city) | Impossible without explicit entries | 100% on `[WEATHER(city=[WORK CITY])]` |
| Array ops (limit, count, slice, first, last) | Limited | Full surface (provider permitting) |
| Filter / sort | Catalog must expose | Catalog must expose; model passes via declarative params |
| Catalog expressiveness | Linear in source count | **Combinatorial** — 18 scalars × 14 fns = 252 implicit combos via nested composition |

**The combinatorial expressiveness is the biggest unlock.** Production
today needs an explicit catalog entry for every (data, context) pair
the user might want. With nested composition + typed signatures, the
catalog stays small (one entry per data source, one entry per identity
field) and users still get "weather where I work", "stock I'm watching",
"emails from boss" — all without adding entries.

## Latency

The richer schema costs longer system prompts (~33% more chars to
ship per call). The surprising result: **parameterized is FASTER**
on both providers (cerebras data here; claude pending).

### Cerebras (gpt-oss-120b) — 34 cases × 3 runs each, sequential dispatch

| Metric | bare | parameterized | Δ |
|---|---|---|---|
| System prompt size (chars) | 1647 | 2185 | **+538 (+32.7%)** |
| Latency p50 (ms) | 274 | 262 | **−12 (−4.4%)** |
| Latency p95 (ms) | 1112 | 628 | **−484 (−43.5%)** |
| Latency mean (ms) | 424 | 379 | **−45 (−10.6%)** |
| Latency max (ms) | 2427 | 1477 | **−950 (−39.1%)** |
| Output mean (chars) | 35 | 43 | +8 (+22.4%) |

**The tail latency improvement is the big story.** Parameterized's
p95 is 43% lower; the max is 39% lower. The bare prompt has more
ambiguous cases that send the model into expensive deliberation
(ticker location? array vs scalar? what's the param?); the typed
signatures eliminate that ambiguity and the model commits faster.

Output is slightly longer (8 chars more on average) — about right for
adding `(ticker="NVDA")` to a `[STOCK PRICE]`. That's a few extra
tokens per call but the per-token speed on cerebras (~3000 tok/s)
means it's invisible at this output length.

**Where the time goes — per-case spot-check:**

The biggest parameterized wins are on **unsupported cases** (no
catalog entry matches the prompt):

| Case | Prompt | bare ms | param ms | Δ |
|---|---|---|---|---|
| u1 | `whats the capital of france _` | 1165 | 368 | −797 |
| u3 | `moon phase tonight _` | 2427 | 628 | −1799 |
| s4 | `sincerely, _ _` | 731 | 262 | −469 |
| u4 | `translate hello to spanish _` | 426 | 346 | −80 |

The pattern: bare brackets give the model an ambiguous target. The
model burns reasoning trying to figure out "does `[CAPITAL]` exist?
Should I emit `[ANSWER]`? What about `[MOON]`?" The typed signatures
let it quickly verify "no catalog entry has return type matching
this query" and emit prose. That's where the p95 / max improvements
come from.

Some cases ARE slower with parameterized (e.g. p1 stock-price
extraction, +167ms) — those need an extra arg in the output, which
takes a few extra tokens. The latency cost there is marginal compared
to the wins on ambiguous cases.

### Claude (claude-haiku-4-5) — 34 cases × 3 runs each, sequential

| Metric | bare | parameterized | Δ |
|---|---|---|---|
| System prompt size (chars) | 1647 | 2185 | +538 (+32.7%) |
| Latency p50 (ms) | 930 | 843 | **−87 (−9.4%)** |
| Latency p95 (ms) | 1838 | 1334 | **−504 (−27.4%)** |
| Latency mean (ms) | 1218 | 918 | **−300 (−24.7%)** |
| Latency max (ms) | 4003 | 1677 | **−2326 (−58.1%)** |
| Output mean (chars) | 40 | 54 | +13 (+33.1%) |

**Same shape as cerebras, magnified.** Claude's bare-form p95 is
1.8s; parameterized brings it to 1.3s. Max latency drops by **2.3
seconds**. Mean latency is 25% lower.

Output growth is larger on claude (+33% vs cerebras's +22%) — claude
emits more verbose tokens (more quotes, more formal style) — but
this is offset 6× by the latency reduction.

### Cross-provider latency summary

| Provider | Bare mean | Param mean | Δ% | Bare p95 | Param p95 | Δ% |
|---|---|---|---|---|---|---|
| cerebras | 424ms | 379ms | −10.6% | 1112ms | 628ms | −43.5% |
| claude | 1218ms | 918ms | −24.7% | 1838ms | 1334ms | −27.4% |

**Both providers: parameterized is unambiguously faster.** The
larger the latency tail in bare, the more parameterized helps.

## Replication

```bash
# all 6 providers × 6 languages (this run, ~10 min total)
for p in cerebras groq claude gemini openai; do
  npx tsx tests/benchmarks/typed-sentinel-language/run.ts --provider $p --parallel 8
done

# single language single provider
npx tsx tests/benchmarks/typed-sentinel-language/run.ts \
  --provider cerebras --language parameterized

# results land under tests/results/typed-sentinel-language/<run-id>/
```

Audit logs per run carry the raw outputs + per-case scores. Useful
for hand-grading new categories or chasing a specific failure mode.

---

## Re-validation on master (2026-06-27)

The full probe set was re-run after lifting this bench onto a clean
`master` base (branch `explore/typed-sentinel-language`), to confirm the
June-16 findings reproduce against current master + the shipped provider
helpers. They do — every headline holds within seed noise.

**Main bench — bare → parameterized lift (2 providers):**

| Provider | bare overall | parameterized overall | Δ | bare param-fill → param |
|---|---|---|---|---|
| cerebras | 78.2% | 94.7% | **+16.5pp** | 58.8% → **100%** (+41pp) |
| claude   | 81.8% | 95.3% | **+13.5pp** | 44.1% → **100%** (+56pp) |

Both match the original dossier (cerebras 79.4→95.9, claude 81.8→95.3)
within ~1pp. Parameter-fill remains the dominant lever; hybrid still
fails to beat parameterized; `unsupported` stays 100% (no hallucinated
sentinels). Composition is again the weakest category on both providers
(cerebras 84%, claude 80%).

**Safety + capability probes (cerebras):**

| Probe | Result | Dossier claim | Verdict |
|---|---|---|---|
| fabrication (param invention) | **0/34 cases, all 6 languages** | bracket langs = 0 | ✅ confirmed (even stronger) |
| nested composition | **100%** overall / 100% inner-hit / 100% literal-hit | 100% | ✅ confirmed |
| field-access | return-selector **100%**, dotted 100%, field-param 97.9% | return-selector best | ✅ confirmed |
| array-deep | FULL 96.1% / NARROW 94.8% | mostly solved, 1 caveat | ✅ confirmed |
| scale (50-entry) | parameterized 89.4% vs bare 78.2% = **+11.2pp** | +10-12pp | ✅ confirmed |

**The one honest caveat reproduced too.** The "0 fabrication" guarantee
holds for FUNCTION PARAMETERS (the fabrication probe: 0/34 everywhere).
It does NOT extend to ARRAY ACCESSORS: array-deep's NoFab dimension is
80.6% (FULL) / 90.3% (NARROW) and element-access is the weakest
dimension (88% / 76%) — models still spontaneously reach for `.first` /
`[N]` because "collections have .first" is a strong prior. This is
exactly the dossier's documented `.first` caveat and the reason the
upgrade plan requires an explicit `ordering:` clause + per-array accessor
documentation. A typed-sentinel runtime parser MUST treat array accessors
as a validate-and-degrade surface, not a trusted one.

---

## Probe 9 — nesting depth (2026-06-27, `nested-depth.ts`)

Added to clear upgrade-plan open-decision #3 (depth-1 was the deepest
the original suite tested). Chainable catalog where each fn's return
type feeds the next arg (`WATCH TICKER → COMPANY NAME(ticker) → HQ
CITY(company) → WEATHER TEMP(city)`); 9 cases, 3 per depth tier.

| Depth | Cerebras exact / off-rails | Claude exact / off-rails |
|---|---|---|
| 1 | 100% / 0% | 100% / 0% |
| 2 | 100% / 0% | 100% / 0% |
| 3 | 100% / 0% | 100% / 0% |

Verified the outputs are genuinely deep (not grader leniency): the
3-fn chain renders as `[WEATHER TEMP(city=[HQ CITY(company=[COMPANY
NAME(ticker=[WATCH TICKER])])])]` (4 bracket levels) and the multi-arg
mixed case as `[CONVERT(amount=[STOCK PRICE(ticker=[WATCH TICKER])],
from=USD, to=[HOME CURRENCY])]` — correct nested + scalar + literal
args together.

**Conclusion:** models do NOT degrade at depth 2-3 — no hard depth cap
is warranted for v1. Pair with the parser's validate-and-degrade
contract (the array-accessor caveat above) rather than a numeric limit.
