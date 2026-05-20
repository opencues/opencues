# tests/

The four test homes. Per-package unit tests live under
`packages/*/src/` next to the code (vitest workspace picks them up
automatically); this directory holds cross-cutting and integration-
level harnesses that don't fit inside a single package.

## Layout

| Path | What | When you'd reach for it |
|---|---|---|
| **`benchmarks/`** | Live LLM benchmarks per pipeline (`fluid-blank/`, `transform-blank/`, `fluid-config/`, `sentence-cues/`, `agent-rewrite/`, `next-prompt-cues/`, `thinking-budget/`). Each has its own `cases.ts`, `run.ts`, judge, provider router, and `EXPERIMENTS.md` log. | Tuning a prompt; bench-validating a provider; comparing two prompts head-to-head. See [`benchmarks/CLAUDE.md`](./benchmarks/CLAUDE.md) for orientation and [`benchmarks/BENCHMARKS.md`](./benchmarks/BENCHMARKS.md) for shipped results. |
| **`results/`** | Raw output from bench runs. One folder per sweep (`matrix-v2/`, `fluid-config-matrix/`, `sentence-cues-matrix/`, `historical/`) + standalone result docs (`thinking-budget-2026-05-18.md`, `gemini-3.5-flash-2026-05-19.md`, etc.). | Citing a bench number; comparing today's run to a previous one; archiving a one-off measurement. |
| **`templates/`** | Starter templates for new cues / blanks / auditors that contributors copy and edit. Mirrored by the `opencues new` scaffolder. | Bootstrap a new contribution by hand if the CLI isn't available. |
| **`user-test.md`** | Manual sanity checklist — the bench-misses-it stuff: voice mode, statusline alignment, satellite cycling, end-to-end happy path. | After a release; before a public push. |

Plus a gitignored `agentic/` — end-to-end scenario harness extracted
to a private repo. Not part of the always-pass suite.

## How to run

```bash
# Per-package unit tests (workspace root)
pnpm test                                              # everything via turbo
pnpm --filter @opencues/core test                      # core only (~565 tests)
pnpm --filter @opencues/runtime test                   # runtime (~1252 tests)

# A specific pipeline bench
GROQ_API_KEY=... npx tsx tests/benchmarks/fluid-blank/run.ts --mode fused --parallel 6

# Swap providers via env var (same shape for every bench)
OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss \
  npx tsx tests/benchmarks/transform-blank/run.ts --mode fused

# Bump max-tokens floor (e.g. for reasoning sweeps)
OPENCUES_BENCH_MAX_TOKENS=2048 \
  npx tsx tests/benchmarks/fluid-blank/run.ts --mode fused
```

## Conventions

- **Judge is pinned** (Groq `gpt-oss-120b`) so cross-provider bench
  rows are comparable. See `tests/benchmarks/CLAUDE.md`.
- **One bench dir = one pipeline.** Adding a new bench is one new
  directory under `tests/benchmarks/<name>/` with the same shape.
- **Result docs live in `tests/results/`** — never inline a bench
  result table into the bench dir's `EXPERIMENTS.md` if you'd want
  to cite it later from outside.
- **`historical/`** is for results that pre-date the current bench
  shape; they're kept for context but not comparable to today's
  matrices.
