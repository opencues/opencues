# blank-sentinels-matrix

Empirical bench to decide the representation method for the
**blank-as-context** feature (extending local blanks to be ambient
sentinel-style tokens for fluid-blank / transform-blank).

Status: design-phase exploration. **Not wired to the runtime.** This
bench only probes prompt shapes against the LLM API — its purpose is
to surface which representation is reliable BEFORE we ship adapter
contracts, frontmatter fields, or runtime substitution code.

## What this bench measures

A matrix of (method × catalog-count × catalog-kind):

|              | n=4 | n=8 | n=16 | n=32 | n=64 |
|---           |---  |---  |---   |---   |---   |
| pure-sentinels | … | … | … | … | … |
| pure-blank     | … | … | … | … | … |
| mixed          | … | … | … | … | … |

…repeated per **method**:

| method               | values visible to provider? | token-shape | verbatim-ity expected |
|---                   |---                          |---          |---                    |
| `safe-tokens`        | no                          | `[FIRST NAME]` | strict |
| `safe-tokens-snake`  | no                          | `[FIRST_NAME]` | strict |
| `raw-inline`         | yes                         | `[FIRST NAME]` + value | strict |
| `facts-only`         | yes                         | none (inline prose) | none |
| `xml-tags`           | yes                         | `<first_name/>` | strict |

The four scoring axes per case:

1. **`correctToken`** — did each expected token (or value, for
   `facts-only`) actually land in the output?
2. **`verbatim`** — was the token's *shape* preserved (no case-drift,
   no underscore vs space swap)? Mangled tokens silently miss the
   substitution pass in production.
3. **`hallucination`** — did the LLM emit a bracket/tag-shaped token
   that's NOT in the catalog? Hallucinated tokens fall through as
   literal text and look broken to users.
4. **`rawLeak`** — in safe-mode methods only: did a catalog VALUE
   appear verbatim in the output? Indicates the model bypassed the
   token system.

## What the matrix should resolve

The open design questions that empirical data can answer:

- **Does verbatim fidelity scale with catalog size?** Production
  blank-as-context could reasonably grow to 32-64 tokens (16 sentinels +
  several blank sources × params × fields). If reliability craters at
  n=32 for some methods, that caps the feature.

- **Are multi-segment tokens (`[WEATHER HOME TEMP]`) reliably emitted?**
  The blank kind uses 3-segment names by design. If the LLM mangles
  these significantly more than 1-segment sentinels (`[EMAIL]`), the
  field-coded naming scheme we converged on is at risk.

- **Does the value-coded carve-out (`[STOCK AAPL PRICE]`) work?** This is
  the only spot where the safe-mode invariant bends — the bench
  measures whether value-fragment slots are reliably handled vs
  field-fragment slots.

- **Is the verbatim-token requirement worth it?** The `facts-only` row
  is the "no tokens at all" baseline. If it dominates the others by a
  wide margin even with no privacy guarantee, the feature might be
  better served by an unstructured prose-context block (the
  ambient-context pattern, scaled up).

- **Does `xml-tags` help on Anthropic specifically?** Documented best
  practice — worth a row.

## Sweep cost

- 5 methods × 5 counts × 3 kinds = 75 cells.
- Each cell materializes 5-20 cases from `cases.ts` (depends on which
  required tokens the catalog contains).
- Conservative estimate: ~500-800 LLM calls per provider per full
  sweep.
- Graders are pure-string — no judge cost, no rate-limit interaction.

A full sweep on Groq at parallel=8 should land in ~3-5 minutes; same
on Claude/OpenAI will take longer due to per-provider rate limits.

## Usage

```bash
# full sweep on default provider (Groq)
npx tsx tests/benchmarks/blank-sentinels-matrix/run.ts

# print the matrix without calling the LLM (cheap structural check)
npx tsx tests/benchmarks/blank-sentinels-matrix/run.ts --dry-run

# restrict to one cell for fast iteration
npx tsx tests/benchmarks/blank-sentinels-matrix/run.ts \
  --method safe-tokens --count 16 --kind pure-sentinels

# cross-provider sweep — same env-var switch as sibling benches
OPENCUES_BENCH_PROVIDER=claude-haiku \
  npx tsx tests/benchmarks/blank-sentinels-matrix/run.ts --parallel 4
```

`--json-out path/to/file.json` dumps full per-case detail for later
diff-vs-diff analysis.

## File layout

- `tokens.ts` — generators for pure-sentinel, blank-derived, and mixed
  catalogs, scaling up to 64.
- `methods.ts` — five representation methods + system-prompt builders.
- `cases.ts` — case TEMPLATES that materialize against the current
  cell's catalog.
- `grade.ts` — pure-string graders for the four scoring axes.
- `run.ts` — sweep harness.

See `FINDINGS.md` for the cross-method × cross-count × cross-kind
matrix on Groq gpt-oss-120b and the recommended production
representation. Re-run this bench before any prompt edit lands.

## What this bench does NOT do

- **Doesn't touch the runtime.** No changes to `@opencues/core`,
  `@opencues/runtime`, any integration, or the production
  fluid-blank-source prompt.
- **Doesn't measure dispatch.** Each case is a single LLM call —
  multi-call pipelines (`TransformBlank`'s 3-pass etc.) aren't in
  scope. Once a method wins on this bench, prompt-engineering it into
  the production pipelines is a separate exercise.
- **Doesn't decide the binding model.** Whether parameter binding
  comes from frontmatter lists, sentinels, or LLM-callable shapes is
  upstream of which token format the model handles best. The bench
  uses field-coded naming (the b-path we'd ship) and value-coded
  naming (the carve-out for split-bindings) as fixed shapes.

## Open follow-ups

- Re-run on each new provider before adding it to the production
  `PROVIDER_AUTO_ORDER`.
- Add a latency-only column once a method+count is shortlisted —
  per-call latency at n=64 is what an interactive user actually feels.
- Consider a follow-up bench where the LLM is told to FETCH a single
  token's value from a much larger catalog (haystack shape) — the
  current bench tells the model "use a relevant token if any matches"
  but doesn't measure recall under heavy distractor pressure.
