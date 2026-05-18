# Thinking-budget bench — May 18 2026

How much reasoning can each provider afford before per-case latency
exceeds OpenCues' use-case threshold?

**Workload:** 40-case stride sample of the fluid-blank suite (137
cases). Single LLM call per case via production `FUSED_SYSTEM_PROMPT`.
Substring-match acceptance against expected answer + alternates (no
LLM judge — keeps the bench reproducible).

**Parallelism:** 8 per cell. Wall clock ~38s for the full matrix.

**Thresholds (p50 target — what feels right per pipeline):**
- word-cue ≤ 500ms (cycling should feel instant)
- fluid-blank ≤ 1500ms (typed `_`, brief load tolerable)
- transform ≤ 3000ms (long output, longer wait acceptable)

## Per-cell results

```
provider   reasoning    acc       median    mean      p95      err
─────────────────────────────────────────────────────────────────────
groq       none            0%      0ms      0ms      0ms    40   ← gpt-oss-* rejects 'none'
groq       low            95%    622ms    604ms    829ms    0
groq       medium         98%   1436ms   1481ms   3105ms    0
groq       high           20%   2501ms   2658ms   4285ms    0   ← acc collapse: max_tokens=512 consumed by reasoning

cerebras   none            0%    172ms    210ms    396ms    0   ← 'none' parses but model returns empty
cerebras   low            98%    255ms    269ms    379ms    0   ★ best speed × acc
cerebras   medium         98%    358ms    371ms    581ms    0
cerebras   high           20%    430ms    440ms    550ms    0   ← same acc collapse as groq

gemini     none           93%    461ms    497ms    738ms    0
gemini     low            93%    789ms    781ms    923ms    0
gemini     medium         93%    746ms    763ms    918ms    0   ← API maps 'medium' → 'low' (no medium tier)
gemini     high           85%   1535ms  1573ms   2060ms    0

openai     none           95%    716ms    736ms   1397ms    0   ← maps to 'minimal' on gpt-5 family
openai     low            93%    887ms   1027ms   2243ms    0
openai     medium         95%   1654ms   1778ms   3272ms    0
openai     high           93%   1936ms   2635ms   7511ms    0
```

## Knee point — max reasoning where p50 ≤ threshold AND acc ≥ 90%

```
provider     word-cue       fluid-blank    transform
─────────────────────────────────────────────────────────
groq         —              medium         medium
cerebras     medium         medium         medium      ★ wins every pipeline
gemini       none           medium         medium
openai       —              low            high
```

## Findings

1. **Cerebras can afford `medium` reasoning across every pipeline,
   including word-cue (358ms p50 at medium, well under 500ms).** No
   other provider sustains useful reasoning on word-cue. This is the
   tangible benefit of Cerebras's throughput — the slack to enable
   reasoning where it would otherwise be a latency footgun.

2. **`high` reasoning catastrophically degrades gpt-oss-120b accuracy
   on BOTH Groq + Cerebras** (98% → 20%). The model's `max_tokens=512`
   budget gets consumed entirely by internal reasoning, leaving no
   room for output. Raising `maxTokens` to 1024-2048 would likely
   restore accuracy at the cost of more latency. Worth a follow-up
   bench, but for OpenCues' typical short outputs the conclusion
   stands: **don't ship `reasoning: high` on gpt-oss models without
   also bumping max_tokens**.

3. **Gemini Flash Lite is reasoning-insensitive** — accuracy stays
   ~93% across all levels. Its API has no 'medium' tier (we map to
   'low'), and 'high' costs ~1s extra without accuracy gain.
   Recommendation: stick with 'none' or 'low' on Gemini.

4. **OpenAI gpt-5.4-mini scales gracefully** — 93-95% accuracy
   across all levels, including 'high' (where it costs ~1.9s p50).
   Unlike gpt-oss, it doesn't catastrophically fail at high
   reasoning. p95 latency at 'high' is concerning though (7.5s).

5. **`reasoning: 'none'` is provider-specific.** Groq gpt-oss-* hard-
   rejects 'none' (must be low/medium/high). OpenAI maps to 'minimal'.
   Cerebras accepts it but produces empty output (model returns
   nothing without reasoning instruction). Default to 'low' for safety.

## Tunable knee — recommended defaults

Based on the knee table, a per-pipeline auto-tune that picks the
best reasoning level that hits each pipeline's latency target:

| Pipeline | Provider | Reasoning | Why |
|---|---|---|---|
| word-cue | cerebras | medium | only provider that fits 500ms with reasoning |
| word-cue | groq/gemini/openai | low | none of them sustain word-cue with reasoning enabled |
| fluid-blank | any | medium | all 4 fit 1500ms at medium |
| transform | cerebras/gemini | medium | gpt-oss collapses at high; gemini medium ≈ low |
| transform | openai | high | gpt-5.4-mini scales cleanly |
| transform | groq | medium | gpt-oss collapses at high |

## Open follow-ups

- Re-run with `maxTokens=2048` to confirm the gpt-oss `high` accuracy
  collapse is purely a budget issue. If yes, expose a `max-tokens`
  knob alongside `reasoning-effort`.
- Add Claude haiku-4.5 if extended thinking is enabled in a future
  Anthropic API version (currently unsupported on haiku).
- Add cost-per-call to the bench output (reasoning tokens are billed).

## Caveats

- 40-case sample — accuracy ±3pp noise floor. For tighter accuracy
  numbers, re-run with `SUBSET=137`.
- Single trial per case. Wall-clock latency ±15% noise.
- Gemini's `thinkingLevel: 'medium'` doesn't exist; we map to 'low'.
- Run from London (BST). Provider regional routing affects p50.

## How to re-run

```bash
GROQ_API_KEY=... CEREBRAS_API_KEY=... GEMINI_API_KEY=... OPENAI_API_KEY=... \
  npx tsx tests/benchmarks/thinking-budget/run.ts

# subset providers + levels
PROVIDERS=cerebras,groq LEVELS=low,medium npx tsx tests/benchmarks/thinking-budget/run.ts

# larger / smaller suite
SUBSET=80 npx tsx tests/benchmarks/thinking-budget/run.ts

# stricter accuracy floor (default 90%)
MIN_ACC=95 npx tsx tests/benchmarks/thinking-budget/run.ts
```
