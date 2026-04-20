# Template instruction tests

These scripts verify that the instructions in the scaffolded `.opencues/`
templates (`cues.md`, `blanks.md`, `controls.md`, `opencues.md`, plus the
per-kind `new/*.md` files) actually work when followed. Each test walks
through the user journey documented in the template comments and asserts
the behaviour matches.

## What's tested

| Script | Scope |
|---|---|
| `test-init-flow.sh` | `opencues init` → `opencues new cue/blank/control` → `opencues validate` → 0 errors |
| `test-cues-examples.sh` | Uncomments the `### synonym` + `### formal` examples in cues.md; verifies match regex hits the documented example words and the `## Tips` JSON keys look up to their declared alternatives |
| `test-blanks-cascade.sh` | For each blanks.md example (MATH / FACTUAL / GRAMMAR), verifies the match/keywords fast-path routes the documented example inputs to the correct mode — deterministic, no LLM |
| `test-controls-shapes.sh` | Scaffolds each of the four `new control` shapes (word / blank / step / list) in turn, uncomments the relevant shape, validates, and checks the declared fields parse |
| `llm-smoke.sh` | **Optional** (requires `GROQ_API_KEY`). Runs a handful of end-to-end LLM queries: synonym of "happy", compute of "4 * 12", factual "capital of France". Asserts shape of response, not exact words. |

## Run all

```bash
tests/templates/run.sh
```

Each script writes verbose output to stderr; final pass/fail summary on
stdout. Non-zero exit on any failure.

## Non-goals

- These are NOT LLM-quality benchmarks (use `tests/benchmarks/` for that).
- They do NOT exercise the integrations (CC, OC, Chrome, Codex) — just
  the template + CLI + config-loader contract.
- They do NOT assert deterministic LLM output content — only shape.
