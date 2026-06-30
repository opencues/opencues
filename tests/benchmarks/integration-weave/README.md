# integration-weave bench

Weaving-quality bench for the `integration-weave` feature (LLM contextual
weaving of a blank's `integration:` exemplar — see
`docs/architecture/blank-integration.md`).

## What it measures

The **load-bearing contract is token survival**: the LLM must return the
sentinel token (`WEAVE_VALUE_TOKEN`) exactly once and never reformat,
translate, quote, or drop it — because the runtime swaps the real value in for
the token *after* the response (the value never reaches the provider). If the
token is mangled, the runtime falls back to the static template, so a low
survival rate degrades the feature to "static only," it never corrupts output.

The bench drives the **real** prompt (`FUSED_WEAVE_SYSTEM` imported from
`@opencues/runtime` — no bench-local copy to drift, same principle as
`blank-intent/prod.ts`). It prints each woven phrase (token rendered as
`«value»`) so register/fluff quality can be eyeballed alongside the survival
rate.

## Run

```bash
CEREBRAS_API_KEY=xxx npx tsx tests/benchmarks/integration-weave/prod.ts --provider cerebras [--parallel 4]
GROQ_API_KEY=xxx     npx tsx tests/benchmarks/integration-weave/prod.ts --provider groq
GEMINI_API_KEY=xxx   npx tsx tests/benchmarks/integration-weave/prod.ts --provider gemini
```

Exit 0 iff every case preserved the token exactly once.

## Baseline (June 2026)

| Provider | Model | Token-survival |
|---|---|---|
| cerebras | gpt-oss-120b | 12/12 (100%) |
| groq | openai/gpt-oss-120b | 12/12 (100%) |

Register read naturally on both (e.g. a mid-thought prior "I cranked the
speakers earlier but now" → "the volume is now «value»"). Re-run before editing
`FUSED_WEAVE_SYSTEM` in `packages/opencues-runtime/src/modules/blank-weave.ts`.
