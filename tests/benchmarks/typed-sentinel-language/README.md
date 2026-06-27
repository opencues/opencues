# typed-sentinel-language

Bench probing whether LLMs can follow a typed "sentinel language" —
catalog tokens with type annotations, parameter signatures, and
return-type shapes — more reliably than the bare bracket form
production ships today.

## Why

Production uses `[STOCK NVDA]` / `[EMAIL]` / `[NEWS]` (the bench's
`bare` language). It works, but parameter extraction is shaky on
some providers (model has to guess from context that `NVDA` in the
catalog name = ticker arg), array cardinality has no syntax, and
structured outputs (multi-field returns) require multiple catalog
entries instead of one with field accessors.

This bench tests four richer alternatives plus two alternative
paradigms (JSON-call, hybrid) and quantifies the accuracy gain.

## Results

See [`FINDINGS.md`](FINDINGS.md) for the full writeup. Headline:

- Bare (production): **81.2%** average across 4 providers
- Typed-scalar:      **90.7%**
- Parameterized:     **95.6%** ← recommended
- Natural:           **95.3%**

The single biggest lever is the **parameter axis** (47pp swing
bare → parameterized). Types and signatures matter; verb prefixes
don't add anything; JSON-call is a viable alternative if strict
decoding is on the table.

## Layout

```
catalog.ts    — universal 16-entry catalog (scalar, fn, array kinds)
languages.ts  — 6 renderers + parsers for each candidate language
cases.ts      — 34 test cases across 7 categories
score.ts      — 5-axis grader (selection / parameters / format /
                hallucination / cardinality)
prompt.ts     — shared system + user prompt builders
providers.ts  — multi-provider router (cerebras / groq / claude /
                gemini / openai)
run.ts        — runner: --provider, --language, --parallel, --only
FINDINGS.md   — results + recommendations
```

Audit logs land under `tests/results/typed-sentinel-language/<run-id>/`.

## Running

```bash
# all languages × one provider
npx tsx tests/benchmarks/typed-sentinel-language/run.ts \
  --provider cerebras --parallel 8

# one language × one provider
npx tsx tests/benchmarks/typed-sentinel-language/run.ts \
  --provider claude --language parameterized

# one category (smoke check)
npx tsx tests/benchmarks/typed-sentinel-language/run.ts \
  --provider cerebras --language parameterized --only composition
```

Requires the same provider API-key env vars as the rest of the bench
suite (`CEREBRAS_API_KEY`, `GROQ_API_KEY`, `ANTHROPIC_API_KEY`,
`GEMINI_API_KEY`, `OPENAI_API_KEY`).

## Open follow-ups

See `FINDINGS.md § Open follow-ups`. Most pressing:

- Scale catalog to 40-60 entries — does the gap hold?
- Nested-call syntax probe for true composition.
- Adversarial cases (prompts that look-like-sentinels but shouldn't trigger).
