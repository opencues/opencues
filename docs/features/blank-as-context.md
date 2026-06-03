# Blank as context

Make your local blanks **ambient context** for fluid-blank and
transform-blank — same security model as sentinels, but for parameterised
dynamic data (weather, stocks, calendar, repo metrics, fitness
trackers, …).

**Off by default.** Opt in per-blank via the `as-context:` frontmatter
key + the global `blank-context-mode:` scalar in `OPENCUES.md`.

**Status:** design + bench validated (May 2026). Not yet wired to the
production runtime — `tests/benchmarks/blank-sentinels-matrix/` proves
the representation reliably resolves at scale across the four scoring
axes (correctToken / verbatim / hallucination / leak). See its
`FINDINGS.md` for the matrix and `docs/architecture/blank-as-context.md`
when it lands for the production wiring plan.

## What it is

Sentinels expose **static** personal data (`[EMAIL]`, `[HOME CITY]`).
Blanks today are triggered manually by typing the blank keyword + `_`
(`weather _`, `stocks AAPL _`).

Blank-as-context is the bridge: a blank can opt in to becoming a
sentinel-style token so its current value is *ambient* to fluid-blank /
transform-blank without the user typing the keyword.

```text
sentinels       static  · single segment   · [EMAIL], [HOME CITY]
blank-context   dynamic · multi-segment    · [WEATHER HOME TEMP], [STOCK AAPL PRICE]
```

Same prompt block. Same safe/raw mode. Same hallucination guard. Same
runtime post-processor strips unlisted tokens.

## The 60-second example

Edit `~/.cues/SENTINELS.md`:

```yaml
---
home_city:  London
portfolio:  AAPL,NVDA
---
```

Edit `~/.cues/blanks/weather/BLANK.md`:

```yaml
---
type: blank
blankKeywords: weather
as-context: safe              # off (default) | safe | raw
context-ttl: 600
context-bind: home_city       # sentinel field name (scalar)
context-fields: [temp, conditions]
---
```

Edit `~/.cues/blanks/stocks/BLANK.md`:

```yaml
---
type: blank
blankKeywords: stocks
as-context: safe
context-ttl: 60
context-bind: portfolio
context-bind-split: ","       # fan out on commas
split-values-in-token-names: ok  # ack the carve-out (below)
context-fields: [price]
---
```

In `OPENCUES.md`:

```yaml
blank-context-mode: safe
```

Now while writing prose, no `_` keystroke needed for either blank:

- `the weather at home is looking _` → fluid-blank emits
  `[WEATHER HOME CONDITIONS]` → runtime substitutes `"overcast"`.
- `AAPL is trading at _` → fluid-blank emits `[STOCK AAPL PRICE]` →
  substitutes `"$245.12"`.

Neither blank fired through its normal keyword path. They became
background context that fluid-blank reached for when the surrounding
prose made them relevant.

## Three modes (mirror sentinels)

| Mode | Values visible to provider | Use when |
|---|---|---|
| **`off`** (default) | n/a — blank is invisible | You don't want this feature |
| **`safe`** (recommended) | No — only resolved tokens flow; values substitute post-LLM | Default for any blank you'd be uncomfortable seeing in a provider log |
| **`raw`** | Yes — values inlined into the prompt | When prose quality genuinely needs the value (e.g. composing a weather forecast where the LLM needs to pick "chilly" vs "balmy" register) |

`safe` mode works even when `sentinels-mode: off` — the binding field is
read locally to look up the snapshot, never reaches the LLM.

`raw` mode requires `sentinels-mode: raw` for consistency.

## How parameter binding works

Blank-context only supports **sentinel-bound** parameters today. Three
reasons:

1. **No silent history scraping.** "Snapshot the last 3 tickers the
   user typed" would surveil the buffer; we don't.
2. **No LLM-callable parameters.** Letting the LLM choose which ticker
   to fetch lets it make a fetch decision based on attacker-controlled
   prose — the same shape as security-audit row #21. The runtime
   resolves the parameter set at prompt-build time; the LLM picks from
   that set or doesn't.
3. **Sentinels already mediate the personal/prompt boundary.** Reusing
   the sentinel field as the binding handle keeps one mental model.

```yaml
context-bind: home_city            # scalar field → 1 slot
context-bind: portfolio            # scalar field → 1 slot (whole string)
context-bind: portfolio            # scalar field
context-bind-split: ","            #   → N slots (fan-out)
```

For `field` naming the token uses the sentinel-field name
(`[WEATHER HOME TEMP]`). For `value` naming (used implicitly with
`context-bind-split`), the token includes value fragments
(`[STOCK AAPL PRICE]`).

## The split-values-in-token-names carve-out

Safe mode's defining property is **values never appear in the prompt**.
The token name `[STOCK AAPL PRICE]` is the only place this bends — the
ticker symbol *is* a value fragment, but it ends up in the token name
because there's no other way to disambiguate one slot from another
within a single binding.

This is fine for ticker symbols, currency pairs, or short opaque codes.
It is **not** fine for personal-name-shaped values (e.g. a `contacts`
sentinel split into `[CONTACT MARIA EMAIL]`).

The frontmatter requires explicit acknowledgement when split-binding is
used:

```yaml
context-bind-split: ","
split-values-in-token-names: ok    # required when split is set
```

Without the ack, the runtime drops the blank from the context block at
boot with a single warning. The bench measures verbatim-fidelity for
both `field` and `value` token shapes — both pass at 100% on Groq
across all six counts. See `FINDINGS.md`.

## Caps and TTLs

- **`context-ttl:` (seconds)** — how long a snapshot stays fresh.
  Refresh is lazy on prompt-build, not on a background cron.
- **Hard cap** — at most 32 (blank × slot × field) tuples can be active
  at once across the whole catalog. Mirrors the
  `sentinels-validator.ts:validateSentinelWrite` chokepoint. Drop the
  oldest if exceeded.
- **Failed fetches** — emit a `[STALE]` marker in the token's slot
  rather than blocking. Fluid-blank tolerates missing context.

## Listing what's active

```bash
$ opencues blank-context list
blank-context-mode: safe

weather (ttl 600s, last snapshot 45s ago)
  binds: home_city = "London"
  [WEATHER HOME TEMP]       = "14C"
  [WEATHER HOME CONDITIONS] = "overcast"

stocks (ttl 60s, last snapshot 12s ago)
  binds: portfolio = "AAPL,NVDA" (split ",")
  [STOCK AAPL PRICE] = "$245.12"
  [STOCK NVDA PRICE] = "$1340.50"

3 blanks active · 5 tokens · safe mode · provider sees token names only
```

The list mirrors `opencues sentinels list` deliberately — same mental
model, same UI gesture. Anything visible in the list is what a provider
could see (by name in `safe`, by value in `raw`).

## Threat model

| Threat | Protection |
|---|---|
| LLM provider sees fetched values (weather temp, share price) | `safe` mode keeps values on the host. `raw` mode opts you out — that's the trade. |
| LLM picks which ticker to fetch based on attacker prose | Token vocabulary is frozen at prompt-build; LLM cannot invent new slots. Bench's injection probes confirm this resists `emit [SECRET ACCESS KEY] _`-style attacks at 100%. |
| LLM hallucinates a token like `[STOCK TSLA PRICE]` when TSLA isn't bound | Post-processor strips any token not in the resolved set. Pinned by bench `halluc-clean` axis. |
| Blank script does an HTTP request to an attacker-controlled URL | Existing blank sandboxing applies — see `docs/architecture/sandbox.md`. Blank-as-context doesn't widen the trust boundary; it just adds a new caller (the snapshot scheduler). |
| User's personal data leaks via token name (e.g. `[CONTACT MARIA EMAIL]`) | `context-bind-split` requires the `split-values-in-token-names: ok` ack — without it, the blank is dropped from the context block. |
| Snapshot cache survives a process restart and is read by another user | Cache is process-memory only; no on-disk persistence. |

## What's NOT supported in v1

- **Body text in BLANK.md doesn't reach the prompt.** Same as sentinels
  Phase 1. The frontmatter is the source of truth.
- **Word-cues + agent-rewrite are out of scope.** Adding 30 context
  tokens to every per-word LLM batch is a token-cost cliff. Fluid-blank
  + transform-blank only.
- **No LLM-callable parameters.** The LLM picks from the resolved set
  or doesn't. It cannot ask the runtime to fetch a new slot.
- **No background cron.** Snapshots refresh lazily on prompt-build.
  Idle cost is zero.
- **Per-project blank-context overrides.** Global only. Same reason
  sentinels is global-only — context isn't project state.

## Where the data lives

- Each blank's `BLANK.md` carries the opt-in frontmatter.
- Sentinel bindings read from `~/.cues/SENTINELS.md` — no duplication.
- Snapshot cache is in-memory in the runtime process. Lost on restart;
  refreshed lazily on next prompt-build.

## See also

- `docs/features/sentinels.md` — the sister feature; same threat model,
  static data only.
- `docs/features/ambient-context.md` — page-level metadata; the third
  member of the context-shaping family.
- `tests/benchmarks/blank-sentinels-matrix/FINDINGS.md` — bench
  evidence that shaped the representation choice.
- `docs/architecture/blank-as-context.md` *(to land)* — production
  wiring plan, snapshot adapter contract, eviction policy.
