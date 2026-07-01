# tests/benchmarks — orientation

How the benchmark area is laid out, what each pipeline measures, and
how to add a new model / provider without breaking the matrix.

> If you're looking for *results*, read
> [`BENCHMARKS.md`](BENCHMARKS.md) (cross-bench landing page) or the
> per-pipeline `EXPERIMENTS.md` files. This doc is the operational
> guide for editing the harness.

## What these benchmarks DON'T catch

The benchmarks call source classes directly (`TransformBlankSource.resolve(...)`
etc.). They measure **LLM quality** — accuracy, latency, cost per case.

They do NOT exercise the **runtime dispatch layer** — the Resolver's
text-change handling, the fast-path + debounce, the host's event-emit
pattern. The May 2026 double-fire bug (resolver fired TransformBlank
TWICE for each `_` trigger on OpenCode because the Solid prompt re-emits
identical text events) was invisible to these benchmarks for 21 days
because each bench case calls the source once and grades the output —
the fact that production fires the source twice for the same user input
isn't observable from a single-shot eval call.

**The structural fix**: dispatch-count assertions live in the
**agentic scenario harness** at `tests/agentic/`, not here. Scenarios
08 (transform-blank) and 09 (fluid-blank) now ship an `expectEventCount`
step pinning "exactly one `<surface>.started` event per `_` trigger" —
caught the regression class. A future bench-level dispatch-count
restructure would require routing each bench case through a headless
runtime instead of calling the source directly; useful but a bigger
lift. Until then, the agentic harness is the canonical place for this
class of test.

---

## What lives where

```
tests/benchmarks/
├── BENCHMARKS.md           # cross-bench summary + recommended defaults
├── CLAUDE.md               # this file
├── transform-blank/        # imperative rewrite pipeline (long-output)
│   ├── EXPERIMENTS.md      # running log of experiments + findings
│   ├── prod.ts             # ★ THE benchmark — drives @opencues/core's
│   │                       #   TransformBlankSource. `--mode fused|3-pass`
│   │                       #   `--provider cerebras|groq` `--parallel N`.
│   │                       #   NO bench-local prompt: EXTRACT/APPLY/VERIFY +
│   │                       #   FUSED live ONLY in transform-blank-source.ts.
│   ├── cases.ts            # 487 cases across 19 categories (see cases-expansion.ts)
│   ├── groq.ts             # ▸ 5-provider router (env-var switch)
│   ├── groq-impl.ts        # ▸ Groq adapter (judge pin + router)
│   ├── cerebras.ts         # ▸ Cerebras adapter (router)
│   ├── gemini.ts           # ▸ Gemini adapter (router)
│   ├── claude.ts           # ▸ Claude adapter (router)
│   ├── openai.ts           # ▸ OpenAI adapter (router)
│   ├── judge.ts            # LLM-as-judge — pinned to Groq gpt-oss-120b
│   ├── budget-translate-probe.ts  # niche probe (uses the router)
│   └── archive/            # FROZEN historical harness + repros. The old
│                           #   comparative `run.ts` + its OWN copies of the
│                           #   prompts (pass1-extract / pass2-apply /
│                           #   pass3-verify / single-call / fused-extract-apply
│                           #   / fused-full / minimal-prompts / latency-probe)
│                           #   live here — they DRIFTED from production (e.g.
│                           #   bench APPLY lacked the FILL PLACEHOLDER rule),
│                           #   so prod.ts (which drives the real source)
│                           #   replaced them. Plus apply-tune, cursor-aware,
│                           #   deictic-resolve, repro-*. See archive/README.md.
│
├── fluid-blank/            # short factual lookup pipeline (short-output)
│   ├── EXPERIMENTS.md
│   ├── run.ts              # `--mode <answer|fused|classified|...> --parallel N`
│   ├── cases.ts            # 137 curated cases
│   ├── cases-{math,factual,unit,…}-bench.ts   # category-specific suites
│   ├── groq.ts + groq-impl.ts + cerebras.ts + gemini.ts + claude.ts + openai.ts
│   ├── judge-segment.ts + judge-answer.ts     # pinned-Groq judges
│   ├── pass1-segment.ts    # 2-pass P1
│   ├── pass3-answer.ts     # 2-pass P3
│   ├── classify.ts + specialized-*.ts          # legacy classified pipeline
│   ├── fused.ts             # 1-call fused prompt
│   └── archive/             # one-off probes (smoke-prod-path).
│                            # See archive/README.md.
│
├── fluid-blank-ambient/    # ambient-context bench (field-aware lookup)
│   ├── cases.ts            # 18 in-prompt cases × 3 classes
│   ├── cases-holdout.ts    # 21 held-out cases (no overlap with examples)
│   ├── prompts.ts          # 5 historical variants (A_baseline … E_minimal) — diff context only
│   ├── run.ts              # `--variant <X> --klass <Y> --holdout` (runs historical variants)
│   └── fused-bench.ts      # drives production `FUSED_SYSTEM_PROMPT` across all 176 cases
│
└── agent-rewrite/          # in-place agent-rewrite cadence (separate bench)
    └── run.ts + cases.ts + harness/
```

Raw run output lives in [`tests/results/`](../results/):

- Active sweep folders (one per experiment): `matrix-v2/`,
  `fluid-matrix-v1/`, `cerebras-vs-groq-fused/`, `cuescore-replay/`,
  `chat-latest/`, `openai-mini/`, `openai-nano-fixed/`, etc.
- Each has a `summarize.sh` script that grep-extracts the
  accuracy/latency table from the raw logs.
- `historical/` holds pre-May-2026 logs from the older `cuescore`
  harness (not comparable to today's matrix; kept for reference).

---

## How the multi-provider router works

The bench routes to one of five inference providers per run, selected
by an environment variable. The shape is identical across pipelines:

```
OPENCUES_BENCH_PROVIDER  Maps to file              Default model
─────────────────────────────────────────────────────────────────────
(unset)                  groq-impl.ts              openai/gpt-oss-120b
gemini-flash-lite        gemini.ts                 gemini-3.1-flash-lite
cerebras-gpt-oss         cerebras.ts               gpt-oss-120b
claude-haiku             claude.ts                 claude-haiku-4-5
openai-nano              openai.ts                 gpt-5.4-mini
```

`groq.ts` is the router — it imports all 5 adapters and re-exports
`chat` / `sysUser` / `MODEL` from whichever was selected at module-load
time. Every other file imports from `./groq` so they don't need to know
which adapter they ended up with.

**Override the model within a provider** with `OPENCUES_<PROVIDER>_MODEL`:

```bash
OPENCUES_BENCH_PROVIDER=openai-nano OPENCUES_OPENAI_MODEL=chat-latest \
  npx tsx tests/benchmarks/fluid-blank/run.ts --mode fused
```

> Note: the `OPENCUES_BENCH_PROVIDER` router drives the comparative
> harnesses (fluid-blank's `run.ts`, and transform-blank's now-archived
> `run.ts`). **transform-blank's live bench is `prod.ts`**, which selects
> its provider with `--provider cerebras|groq` and reads keys directly —
> it doesn't go through this router.

OpenAI also has `OPENCUES_OPENAI_REASONING={none|low|medium|high|xhigh}`
for `reasoning_effort`. Gemini has `OPENCUES_GEMINI_THINKING={none|low|high}`
for its thinking budget (default `none` — see Experiment 5).

---

## How the judge works

`judge.ts` (transform-blank) and `judge-{segment,answer}.ts` (fluid-blank)
**import directly from `./groq-impl`**, NOT through the router. This
keeps the LLM-as-judge on a single fixed model (Groq gpt-oss-120b)
regardless of which provider we're benchmarking. Otherwise each row
self-judges with its own inference model and inflates by ~5pp; see
transform-blank `EXPERIMENTS.md § Experiment 6`.

`judge-answer.ts` also short-circuits on exact-string match before any
LLM call — saves a round-trip on the common case and survives
transient judge rate-limit during parallel sweeps.

---

## Pipelines and what they measure

| Pipeline | Task | Suite | Modes |
|---|---|---|---|
| **transform-blank** | Imperative rewrite (`change boy to girl _ the boy ran`) | 487 cases, 19 categories | `extract-apply-verify` (3-pass, default), `extract-apply` (2-pass), `single-call`, `fused`, `fused-verify`, plus minimal-* variants |
| **fluid-blank** | Short factual lookup (`capital of france _`) | 137 cases + bench suites (math, factual, unit, color, http, roman, translation, spelling) | `answer` (2-pass), `classified` (3-call hybrid, legacy), `fused` (1-call), `specialized-*` |
| **agent-rewrite** | Continuous in-place rewrite cadence | Separate suite | Custom — see `agent-rewrite/CONTINUE.md` |
| **fluid-blank-ambient** | Field-aware fluid-blank — does the single FUSED LLM call use the field's label/placeholder/page-title to shape the answer? | 137 standard + 18 in-prompt + 21 held-out (3 ambient classes: helps / neutral / anti) | `fused-bench.ts` drives the production `FUSED_SYSTEM_PROMPT` across all three suites |

Each pipeline has its own concept of "best mode" — picking the right
mode for each provider is in BENCHMARKS.md and in
`packages/opencues-core/src/sources/transform-blank-source.ts:pickTransformBlankMode`.

---

## The three axes we benchmark

Every cell in the matrix is **{accuracy, latency, cost}**:

1. **Accuracy** — % of cases where the LLM-judge said PASS. The judge
   is pinned (see above) so cross-provider comparisons are honest.
2. **Latency** — per-case wall-clock model time (judge excluded). With
   `--parallel N` the wall-clock total is amortized; the per-case
   number is what an interactive user sees.
3. **Cost** — `$/1K cases` is estimated from prompt-length × per-token
   prices (May 2026 rates in BENCHMARKS.md). Not measured from API
   `usage` blocks yet — track the open follow-up.

The interesting derived metric is **$/correct answer** (cost ÷
accuracy). A cheap model that's 30% accurate costs MORE per usable
output than a moderately priced model at 90%. The matrix in
BENCHMARKS.md shows both.

---

## How to add a new model

Three places to touch — adapter, router, sometimes a tier-specific
quirk.

### 1. Add the adapter (if it's a new provider)

Copy one of the existing 5 adapters (`groq-impl.ts` is the simplest
OpenAI-compat one; `claude.ts` is the Messages-API shape; `gemini.ts`
shows a different URL/body layout):

```ts
// tests/benchmarks/transform-blank/<NEW>.ts
import * as https from 'https';

const ENDPOINT = 'https://api.<NEW>.example/v1/chat/completions';
export const MODEL = process.env.OPENCUES_<NEW>_MODEL ?? '<DEFAULT_MODEL>';

const API_KEY = process.env.<NEW>_API_KEY;
if (!API_KEY) { console.error('Set <NEW>_API_KEY'); process.exit(1); }

const agent = new https.Agent({ keepAlive: true, maxSockets: 32 });

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface ChatResult { text: string; latencyMs: number; }

export async function chat(messages, opts = {}) {
  // …per-provider request/response munging…
  return { text, latencyMs };
}

export const sysUser = (system, user) => [
  { role: 'system', content: system },
  { role: 'user', content: user },
];
```

### 2. Wire it into the router

In `transform-blank/groq.ts` (and the mirror in `fluid-blank/groq.ts`):

```ts
import * as <new>Impl from './<NEW>';

function pickImpl() {
  switch (process.env.OPENCUES_BENCH_PROVIDER) {
    case 'gemini-flash-lite': return geminiImpl;
    // …existing cases…
    case '<NEW>-id':          return <new>Impl;   // ← new line
    default:                  return groqImpl;
  }
}
```

### 3. Mirror to `@opencues/core` if you want the production runtime
to use it

Production routing lives in
`packages/opencues-core/src/llm-provider.ts`. Add an entry to
`PROVIDERS`, give it a `ProviderId`, slot it into `PROVIDER_AUTO_ORDER`
(the chain `cerebras > groq > gemini > anthropic > openai`), and add
fallback logic if it pairs with another provider for transient-error
recovery (`AUTOFALLBACK_PAIR` map).

For **benchmark-only exploration** you can skip step 3 — the bench
will work without touching the runtime. Step 3 is what makes the
provider available to real opencues users.

### 4. Run it

```bash
# Router-driven comparative harness (fluid-blank; transform-blank's lives in archive/):
OPENCUES_BENCH_PROVIDER=<NEW>-id <NEW>_API_KEY=... \
  npx tsx tests/benchmarks/fluid-blank/run.ts --mode fused --parallel 8
```

For **transform-blank**, the live bench drives the production source, so a
new provider only needs step 3 (the `@opencues/core` PROVIDERS entry) plus
a one-line addition to the `PROVIDERS` map in `prod.ts`, then:

```bash
<NEW>_API_KEY=... GROQ_API_KEY=... \
  npx tsx tests/benchmarks/transform-blank/prod.ts --provider <NEW>-id --mode fused --parallel 8
```

Then update [`BENCHMARKS.md`](BENCHMARKS.md) with the row.

---

## How to add a new pipeline (rather than a model)

Heavier — create a new folder under `tests/benchmarks/<name>/` with:

- `cases.ts` — typed test cases
- `run.ts` — main harness (mirror `fluid-blank/run.ts` shape; or, to
  measure the production source directly without a bench-local prompt,
  mirror `transform-blank/prod.ts`)
- `judge*.ts` — judge prompt + parser, **importing `chat` from
  `./groq-impl` directly** (not the router — keep judge pinned)
- `groq.ts` — the provider router (paste from transform-blank)
- Per-provider adapter copies (`groq-impl.ts`, `cerebras.ts`, etc.)
- One or more mode prompts (`fused.ts`, etc.)
- An `EXPERIMENTS.md` log file

Then add a row in BENCHMARKS.md.

---

## How the fluid-blank-ambient bench guards regressions

The ambient-context feature lives in the single `FUSED_SYSTEM_PROMPT`
in `@opencues/core/src/sources/fluid-blank-source.ts`. Any edit to
that prompt should re-run `fused-bench.ts` *before* committing.

Three things the bench measures in one run:

1. **No regression on the standard 137-case suite.** The bench
   imports the production prompt directly and runs every standard
   fluid-blank case through it — currently 136/137 (99.3%) on
   cerebras-gpt-oss. The single fail (`r-stomach-ph`) is a known
   judge flake.
2. **Ambient HELPS the right cases** (`klass: 'ambient-helps'`) —
   `paris _` + Airport-code label → `CDG`; the answer changed
   *because* of the field. 18 in-prompt + 21 held-out — all should
   pass.
3. **Ambient is IGNORED when it would hurt** (`klass:
   'ambient-anti'`) — misleading page title, prompt injection in
   the label, empty fields. The answer should NOT change.

Plus a NEUTRAL class (`ambient-neutral`) — unambiguous lookups
where ambient shouldn't matter either way. Useful to catch
"the prompt now over-weights ambient" regressions.

The 18 in-prompt cases are the variants the prompt's few-shot
examples were tuned against; the 21 held-out cases use entirely
different patterns (ZIP codes, postcodes, callsigns, currency
symbols, "label IS the question" cases like `_` + "What is your
LinkedIn profile?") to verify generalization.

`prompts.ts` keeps five historical variants (`A_baseline` …
`E_minimal`) and `run.ts` runs them — kept as diff context for
future prompt edits, NOT connected to production. The winning
shape (`E_minimal` + 3-field ambient block) was promoted into
production's `FUSED_SYSTEM_PROMPT`.

Standard re-run after any prompt edit:

```bash
OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss \
  npx tsx tests/benchmarks/fluid-blank-ambient/fused-bench.ts
```

Target: 175/176 or better. Drops below that → investigate before
shipping.

The 3-field block (label + placeholder + page-title) sent to
the LLM is also pinned by the design — adding fields to
`renderAmbientBlock` (production) requires a bench re-run that
shows ≥1-2pp gain with no latency cost. See
[`docs/features/ambient-context.md`](../../docs/features/ambient-context.md)
and [`docs/architecture/ambient-context.md`](../../docs/architecture/ambient-context.md).

---

## Things you'll trip on

1. **Strict-mode JSON.** Groq's `openai/gpt-oss-*` models support
   `response_format: { strict: true, schema }` for constrained
   decoding. `useStrictJson(providerId, model)` in
   `@opencues/core/src/llm-provider.ts` is the single source of truth.
   When swapping a provider that doesn't support strict mode, the
   pipeline parser must accept label-format output too — see the
   dual-path parsers in `transform-blank-source.ts`.

2. **OpenAI's `max_completion_tokens` vs `max_tokens`.** gpt-5/o-series
   use the new name; gpt-4o-* keep the old one. The adapter
   auto-detects by model name. If you add a new OpenAI-shaped provider
   serving gpt-5-class models, mirror this in your adapter.

3. **OpenAI reasoning models have a per-model effort floor.**
   `chat-latest` (gpt-5.5 Instant) refuses `reasoning_effort: 'none'`
   and `'low'` — minimum is `'medium'`. `gpt-5.4-nano`/`mini` accept
   `'low'` (the level we use). The probe scripts will surface this
   as `400 Unsupported value` if you pick the wrong combo.

4. **Rate limits during parallel sweeps.** Running 5 providers ×
   parallel=8 against the same Groq endpoint (which is also the
   judge!) blows past Groq's 250k TPM. The runtime tolerates this
   via `groq-impl.ts`'s soft-fail on rate-limit errors AND the
   exact-match short-circuit in `judge-answer.ts`. If you re-introduce
   a parallel sweep and see "0% / fast / no judge rationale" rows,
   it's rate-limited judging — re-run sequentially per provider.

5. **Cerebras + transform-blank's `fused-verify` is catastrophic.**
   −33pp from `fused` alone (76.2% → 47.6%). The verify prompt was
   tuned to gpt-oss-on-Groq failure modes and "corrects" valid
   Cerebras drafts into wrong output. Don't ship `fused-verify` on
   any provider except groq.

6. **`gemini-2.5-flash` is deprecated.** All tests + defaults are on
   `gemini-3.1-flash-lite`. Don't reintroduce the old name in test
   placeholders — it'll confuse future readers.

---

## State of the bench right now

(Update this section when meaningful changes land.)

- **5 providers wired**: groq, gemini, cerebras, claude, openai
  (incl. chat-latest alias).
- **Two main pipelines**: transform-blank (487 cases), fluid-blank
  (137 cases) plus 7 category-specific fluid bench suites.
- **Recommended defaults** (see BENCHMARKS.md):
  - transform-blank → groq gpt-oss · 3-pass (accuracy ceiling)
  - fluid-blank → cerebras gpt-oss · fused (tied for top acc, fastest)
- **Default OpenAI model = `gpt-5.4-mini` + `reasoning_effort: 'low'`**;
  `chat-latest` documented as a subscription-economic override.
- **Production fused mode** is wired into
  `@opencues/core/src/sources/transform-blank-source.ts` via
  `pickTransformBlankMode(providerId, configMode)`; groq → 3-pass,
  everyone else → fused. Mode dispatch tests in
  `packages/opencues-core/src/sources/transform-blank-mode.test.ts`.

---

## Open follow-ups

1. **Real token accounting.** Capture `response.usage.{prompt_tokens,
   completion_tokens}` from each provider's API response, log per
   case, replace the estimated `$/1K cases` in BENCHMARKS.md with
   measured numbers. Particularly OpenAI reasoning models are
   2-4× undercount today.
2. **Per-pipeline provider override config.** Today CUES.md's
   `transform-blank-provider:` works; `fluid-blank-provider:` works.
   But the auto-route picks the same provider for both pipelines.
   Letting it pick cerebras for fluid-blank and groq for
   transform-blank without an explicit override would be a real UX
   improvement.
3. **fluid-blank `single-call` mode.** Would drop segmentation entirely
   on capable models (the 1-call analog to fused). Probably worth
   ~50ms latency on the easier suite.
4. **Multi-model accuracy tier for chat-latest.** Documented as an
   override but not yet wired into the auto-router. Decision pending:
   is it worth a `transform-blank-mode: premium` toggle that picks
   chat-latest when an OpenAI key is set and the user has explicitly
   opted in?

---

*Last updated: 2026-05-16.*
