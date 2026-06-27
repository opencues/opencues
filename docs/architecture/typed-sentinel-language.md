# Typed-Sentinel Upgrade Plan

Branch: `explore/sentinel-language-bench`
Status: planning doc
Last updated: 2026-06-16

## What this plan covers

Migrating OpenCues from the current bare-bracket sentinel format
(`[FIRST NAME]`, `[STOCK NVDA]`) to the typed signature winner from
the bench:

```
[FIRST NAME: string]
[STOCK PRICE(ticker: string): number]
[NEWS(limit: number): array<{title: string, url: string}>]
[WEATHER(city: string): {temp: number, conditions: string}]
```

The bench (`tests/benchmarks/typed-sentinel-language/`) showed this
nets +14pp selection accuracy, +47pp parameter fill, and is FASTER
across providers (mean −10% cerebras, −25% claude; tail p95 −27%
to −43%).

The plan is **phased + back-compat** so we don't ship a flag day. The
runtime accepts both shapes while authors migrate.

## Where types come from — the discovery question

Three discovery modes the runtime supports. Each blank picks the mode
best for its source-of-truth:

| Mode | Type lives in | Used by |
|---|---|---|
| **declared** | BLANK.md frontmatter (`returns:` field) | All built-ins + most user blanks |
| **embedded** | A comment header in the implementation file (`# returns: ...` in scripts) | Script blanks where authors edit the script directly |
| **inferred** | Runtime introspects first response, caches type | HTTP blanks where shape is fluid; fallback only |

**Precedence:** declared → embedded → inferred. If the BLANK.md says
`returns: array<string>` and the script's embedded comment disagrees,
the frontmatter wins (it's the public API contract).

## The new BLANK.md fields

Adding 3 new fields. All optional during migration; required after
the migration window closes.

### `signature` — the parameterized call shape

For blanks that take args. Mirrors the bench's parameterized syntax:

```yaml
signature: (ticker: string)
```

For blanks with no args (identity scalars, calendar-today): omit.

### `returns` — the return-type annotation

```yaml
returns: number                              # scalar
returns: string
returns: array<string>                       # array of scalars
returns: {temp: number, conditions: string}  # struct
returns: array<{title: string, url: string}> # array of structs
```

This is the **single most important field** — it's what the catalog
renderer ships to the LLM and what the runtime parser uses to know
what `.field` accesses are valid.

### `accessors` — optional surface for non-standard ops

Default array entries support `.first / .last / .count / [N] / [N:N]`
automatically per the bench findings. Most blanks won't need this
field. Use it to ADD beyond the defaults or to RESTRICT:

```yaml
# Add custom accessors:
accessors: { aggregate: "sum-price" }   # exposed as [NAME.aggregate('sum-price')]

# Restrict (remove unsupported semantics):
accessors: { first: false, last: false }   # array is unordered; no first/last
```

## Migration mapping — existing blanks → typed

### Identity scalars (`IDENTITY.md`)

**Current:**
```yaml
firstName: Wilfred
lastName: Kasekende
portfolio: AAPL,NVDA,GOOG
```

**After:**
```yaml
firstName:
  value: Wilfred
  type: string

# Or — type inferred from value shape, no annotation needed:
lastName: Kasekende      # → [LAST NAME: string]
portfolio: AAPL,NVDA,GOOG  # → [PORTFOLIO: string] (raw); or:

portfolio:
  value: [AAPL, NVDA, GOOG]
  type: array<string>      # → [PORTFOLIO: array<string>]
```

**Inference rules:**

| Value shape | Inferred type |
|---|---|
| `"Wilfred"` | `string` |
| `42` | `number` |
| `true` / `false` | `boolean` |
| `[a, b, c]` (YAML list) | `array<string>` (inferred from first element) |
| `{k: v}` (YAML object) | `{k: string}` (inferred shape) |

Lossless migration: every existing `IDENTITY.md` keeps working with
its types auto-inferred. Authors can add explicit `type:` only when
they want a richer signature (e.g. typing `portfolio` as
`array<{ticker: string, name: string}>` instead of `array<string>`).

### Built-in blanks (TypeScript impl)

**Current — `defaults/blanks/stocks/BLANK.md`:**
```yaml
blankKeywords: nvidia, nvda, apple, aapl, ...
blankFormat: string
as-context: safe
context-slots: NVDA, AAPL, TSLA, MSFT, GOOGL
```

**After:**
```yaml
blankKeywords: nvidia, nvda, apple, aapl, ...
signature: (ticker: string)
returns: number       # ← single-value stock price
description: current trading price of a stock

# blank-context layer (also new):
as-context: safe
context-slots: NVDA, AAPL, TSLA, MSFT, GOOGL
```

The runtime renders this as:

```
[STOCKS(ticker: string): number] — current trading price of a stock
```

For richer returns (full quote):

```yaml
signature: (ticker: string)
returns: {price: number, change: number, volume: number}
description: full stock quote
```

Rendered as:

```
[STOCKS(ticker: string): {price: number, change: number, volume: number}]
```

The model can then emit `[STOCKS(ticker="NVDA").price]` per Probe 3.

### Built-in arrays (news, hackernews, emails, calendar)

**Current — `defaults/blanks/hackernews/BLANK.md`** (limited info):
```yaml
blankKeywords: hn, hackernews, hacker news
blankFormat: string
```

**After:**
```yaml
blankKeywords: hn, hackernews, hacker news
signature: (limit: number)
returns: array<{title: string, url: string, points: number}>
description: top stories from Hacker News right now (ordered: highest points first)
# 'ordered' clause important — bench found both providers assume [0] = latest.
# Documenting the actual ordering avoids the silent bug.
```

Rendered as:

```
[HACKERNEWS(limit: number): array<{title: string, url: string, points: number}>] — top stories ordered by points
```

The model spontaneously composes:
- `[HACKERNEWS(limit=5)]` — top 5
- `[HACKERNEWS.first.title]` — title of top story
- `[HACKERNEWS.count]` — how many available

### Script blanks (`defaults/blanks/volume/`, `brightness/`)

**Current — `defaults/blanks/volume/BLANK.md`:**
```yaml
blankKeywords: volume, vol
blankFormat: number
```

**After:**
```yaml
blankKeywords: volume, vol
signature: (level: number)   # action=set takes a level; get takes none
returns: number              # current volume 0-100
description: system audio volume (0-100)
```

Plus optional embedded type in the script:

```bash
#!/usr/bin/env bash
# returns: number
# signature: (level: number)
# Volume blank — gets/sets system volume...
```

The embedded comment is for authors who edit the script standalone
and want type info colocated with the impl. The runtime reads the
frontmatter; if the BLANK.md is missing, falls back to the embedded
comment; if both missing, falls back to inference.

### HTTP blanks (a future kind)

**New shape** (when we add them):

```yaml
type: blank
kind: http
endpoint: https://api.example.com/v1/something
# Option A — declared:
returns: array<{id: number, name: string}>
# Option B — inferred from first response:
# returns: infer    # runtime probes endpoint on first use, caches
```

`returns: infer` is the only place inference is normative. For all
other blank kinds it's a fallback when frontmatter + embedded are
absent.

## Catalog rendering — new shape

The `renderBlankContextCatalog()` function (current location:
`packages/opencues-core/src/blank-context.ts`) becomes:

**Before (production):**
```
AVAILABLE CONTEXT TOKENS:
- [STOCKS NVDA] — current price of NVDA stock
- [STOCKS AAPL] — current price of AAPL stock
- [WEATHER LONDON] — temp in London
- [FIRST NAME] — user's first name
```

**After:**
```
AVAILABLE FUNCTIONS — typed catalog with parameter signatures.

USE PATTERN:
  Scalar:          [NAME]
  Function call:   [NAME(arg=value)]
  Nested call:     [NAME(arg=[OTHER NAME])]
  Struct field:    [NAME(args).field]
  Array first:     [NAME.first], also [NAME[0]]
  Array count:     [NAME.count], also [NAME.length]

- [FIRST NAME: string] — user's first name
- [WORK CITY: string] — city the user works in
- [STOCK PRICE(ticker: string): number] — current trading price
- [STOCK(ticker: string): {price, change, volume}] — full quote
- [WEATHER(city: string): {temp, conditions, forecast}] — weather report
- [HACKERNEWS(limit: number): array<{title, url, points}>] — top HN stories (ordered: highest points first)
```

Same structure for `renderIdentityContextCatalog()` (which today
sits at `packages/opencues-core/src/identity-context.ts`).

## Runtime parser

The current bracket parser handles `[NAME]` and `[NAME ARG]`. New
parser must handle:

1. **Function calls** — `[NAME(arg=value, arg2=value2)]`
2. **Nested brackets** — `[NAME(arg=[OTHER])]` — recursive
3. **Field access** — `[NAME(args).field]` and `[NAME(args).first.field]`
4. **Element access aliases** — `[NAME[0]]` → `.first`, `[NAME[-1]]` → `.last`, `[NAME[N]]` → `.nth(N)`
5. **Length aliases** — `[NAME.length]` / `.size` → `.count`
6. **Slice** — `[NAME[0:5]]` → `.slice(0, 5)`
7. **Type annotation suffix** — `[NAME: type]` — model sometimes echoes the type from catalog; parser strips it
8. **Back-compat for bare** — `[STOCKS NVDA]` still resolves; the runtime translates to `[STOCKS(ticker="NVDA")]` internally during the migration window

Location: extracted as `packages/opencues-core/src/sentinel-parser.ts`
(new file). Today's bracket-extraction logic in `post-process.ts` and
`integration-pass.ts` calls into it; both stay back-compat-readable.

## Resolver — substitution side

For each parsed `(id, args, field, element, slice)`:

1. Look up the blank by `id`.
2. If the blank has a `signature`, validate args against it. Unknown
   keys → drop silently OR emit a warning (per `strict-mode` setting).
3. If `args` contains a nested `[OTHER]` token, resolve it FIRST and
   substitute the value.
4. Invoke the blank's get handler with the resolved args.
5. If `field` set: project (`result.field`).
6. If `element` set: apply (`first` / `last` / `nth` / `slice` / `count`).
7. Substitute the resolved value into the buffer.

Cycle-of-resolution: nested first, then outer. Loop guard: max depth
3 (a `[X(arg=[Y(arg=[Z(arg=[A])])])]` chain is unusual but bounded).

## Migration — phased rollout

### Phase 1 — Parser + back-compat (no user-visible change)

- Write the new sentinel parser (`sentinel-parser.ts`)
- Wire into resolver's substitution path, BEHIND a `sentinel-language: typed | bare | both` OPENCUES.md scalar
- Default: `both` — parser accepts old + new shape, renderer emits old shape
- Net effect for users: nothing visible; behaviour unchanged

**Files touched:**
- `packages/opencues-core/src/sentinel-parser.ts` (new)
- `packages/opencues-core/src/identity-context.ts` (parser plumbing)
- `packages/opencues-core/src/blank-context.ts` (parser plumbing)
- `packages/opencues-core/src/integration-pass.ts` (parser plumbing)
- `packages/opencues-core/src/feature-registry.ts` (new scalar)

### Phase 2 — Catalog rendering switch

- Add `signature:` / `returns:` field reading to `BlankConfig`
- Render typed catalog when `sentinel-language: typed`
- Keep bare catalog when `sentinel-language: bare`
- `both` renders typed AND adds a back-compat alias section
  (`Legacy aliases — emit the typed form preferentially`)
- Inference for blanks missing `returns:` — default to `string`

**Files touched:**
- `packages/opencues-core/src/cues-md.ts` (BlankConfig parser)
- `packages/opencues-core/src/identity-context.ts` (renderer)
- `packages/opencues-core/src/blank-context.ts` (renderer)
- `packages/opencues-core/src/blanks/*.ts` (built-ins emit signature + returns)
- `defaults/blanks/*/BLANK.md` (frontmatter additions)

### Phase 3 — IDENTITY.md type inference + opt-in explicit types

- ConfigLoader infers types from value shape (string / number / array)
- Authors opt into explicit `value:` + `type:` form when they want
  richer signatures
- Renderer ships inferred OR explicit type
- Existing IDENTITY.md files keep working

**Files touched:**
- `packages/opencues-runtime/src/modules/config-loader.ts`
- Defaults: a migration helper (`opencues identity migrate-types`) that
  walks IDENTITY.md and adds explicit types where inference is lossy

### Phase 4 — Built-in blank updates

- Each shipped blank (stocks, weather, news, hackernews, etc.)
  gains `signature:` + `returns:` in its BLANK.md
- The TypeScript impl class also gains a `signature()` + `returns()`
  method returning the same — drift detected via an alignment test
- New scalar `array-ordering:` on array blanks documents whether `[0]`
  is newest/oldest/highest/etc. — surfaces as a "ordered: ..." clause
  in the rendered catalog (per Probe 8 finding about [0]=latest assumption)

**Files touched:**
- `packages/opencues-runtime/src/blanks/{stocks,weather,news,hackernews,emails,calendar}.ts`
- Each defaults `BLANK.md` for those
- `tests/runtime/blank-signature-alignment.test.ts` (new)

### Phase 5 — Default flip + deprecation

- Flip default from `sentinel-language: both` to `typed`
- Renderer ships typed shape by default
- Bare brackets still parseable for one release cycle (back-compat for
  user-typed prose like "the [NAME] field" in markdown)
- After one release, deprecate bare parsing; warn on parse

### Phase 6 — Drop `sentinel-language` scalar

- Remove the back-compat path entirely
- Bare brackets emit a warning (now reserved for typed)
- One LoC change + a CHANGELOG note + a `seed-configs` self-heal that
  strips the scalar from old `OPENCUES.md` files

## What "wholly expressive" looks like at the end

After Phase 5, the system supports:

- **Single source of truth per data source** — one `STOCKS` blank,
  one `WEATHER` blank, one `NEWS` blank. No more per-ticker / per-city
  catalog explosions.
- **Combinatorial expressiveness** — `[WEATHER(city=[WORK CITY])]`,
  `[STOCK(ticker=[WATCH TICKER]).price]`, etc. Identity scalars
  multiply parameterized fns without adding catalog entries.
- **Field projection** — `[NEWS.title]`, `[STOCK(ticker="NVDA").change]`,
  `[EMAILS.first.subject]` — the model emits these naturally; the
  runtime resolves them.
- **Array semantics** — `.first / .last / .count / [N] / [0:N]` work
  out of the box on every array blank.
- **Type-bound parsing** — every parsed sentinel is verified against
  the catalog's signature. Unknown args / fields silently drop OR
  surface a warning. No fabricated capabilities (per Probe 2 — 0/408
  on bracket languages).

## Open questions

These need decisions before Phase 1:

1. **Strict mode vs lenient mode** — when the model emits a bad field
   accessor (`[STOCK(ticker="NVDA").ymca]`), should the runtime:
   - (a) Resolve everything BUT the bad accessor (leaves `.ymca` as
     literal text in the buffer)
   - (b) Surface an error to the user
   - (c) Silently drop the sentinel entirely
   
   **Recommendation:** (a) with a debug-log line. Matches the bench's
   "graceful degradation" behaviour and doesn't break the user flow.

2. **Multi-field projection syntax** — Probe 7 left this open.
   Default is to emit two tokens (`[STOCKS.ticker] [STOCKS.price]`).
   A template form (`[STOCKS:{ticker} - {price}]`) might also be
   worth supporting. Pick one before Phase 4 ships array-heavy blanks.
   
   **Recommendation:** start with two-tokens (works at scale), reserve
   template syntax for a Phase 7 if real usage demands it.

3. **Nested call depth limit** — max 3 levels feels safe but bench
   only tested 1 level. Run a deeper-nesting probe before Phase 1 to
   confirm models don't go off the rails at depth 2+.

4. **`array-ordering` clause format** — free-text in description or
   a structured `ordering:` field?
   
   **Recommendation:** structured `ordering: 'newest-first' | 'oldest-first' |
   'highest-first' | 'unordered'` — lets the runtime warn the model
   when it emits `[NAME[0]]` against an `unordered` array.

## Risk register

| Risk | Mitigation |
|---|---|
| Existing IDENTITY.md breaks | Phase 3 inference is lossless for current shape |
| User-written `[X]` brackets in prose get interpreted | Already a problem today; new parser keeps the same scope (only resolves brackets that match a catalog id) |
| Catalog rendering blows up token spend | Probe data: prompt grows 33% but latency drops 10-25%. Net win. |
| Per-blank impl drift (TS class signature ≠ BLANK.md frontmatter) | Phase 4 alignment test catches it pre-merge |
| Chrome integration's baked bundle goes stale | `srcHash` drift detection (already in place — `version-markers.cjs`) catches this automatically |

## Estimated effort

| Phase | Scope | Effort |
|---|---|---|
| 1 — Parser + back-compat | 1 new file, 4 file edits | 2 days |
| 2 — Catalog rendering | 6 file edits + a dozen BLANK.md updates | 2 days |
| 3 — IDENTITY type inference | 1 file edit + CLI helper | 1 day |
| 4 — Built-in blank updates | ~10 blanks × signature + alignment test | 3 days |
| 5 — Default flip + deprecation | 1 LoC + tests + changelog | 0.5 day |
| 6 — Drop legacy | 1 file edit + seed-configs self-heal | 0.5 day |
| **Total** | | **~9 days** |

Phases 1-3 can ship in one PR; Phases 4-6 release-cycle by release-cycle.

## Next step

Discuss + decide the three open questions above. Once those land, I
can start writing Phase 1 on a sibling branch
(`feat/typed-sentinel-parser` from this `explore/sentinel-language-bench`)
so the plan, the bench evidence, and the impl all live together.
