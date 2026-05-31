# fluid-config switch-provider bench

End-to-end scenario coverage for the fluid-config classifier's
**provider routing** intent (`use anthropic for cues _` etc.) +
regression coverage for the setting and reject paths.

The bench imports the **live** `SYSTEM_PROMPT` + `parseConfigIntentOutput`
+ `validateAgainstRegistry` from
`packages/opencues-core/src/sources/config-intent-source.ts` — drift
between bench prompt and shipped prompt is structurally impossible.

## Run

```bash
# Default (Groq)
GROQ_API_KEY=xxx tsx tests/benchmarks/fluid-config-switch-provider/run.ts --parallel 6

# Cerebras (fastest)
OPENCUES_BENCH_PROVIDER=cerebras CEREBRAS_API_KEY=xxx \
  tsx tests/benchmarks/fluid-config-switch-provider/run.ts --parallel 6

# Anthropic / OpenAI / Gemini also accepted as OPENCUES_BENCH_PROVIDER
```

Filters:

```bash
tsx ... --case po-cues-anthropic            # single case
tsx ... --category hit-provider-and-model   # one category
tsx ... --verbose                           # show raw LLM output per case
```

## What's tested

| Category | What it pins |
|---|---|
| `hit-provider-only` | Clean provider switch, no model named. Scope-routing across cues / auditors / blanks; "everything" defaults to cues. |
| `hit-provider-and-model` | Provider + specific model from `knownModels`. |
| `hit-model-implies-provider` | Model name only — classifier should infer the provider from the registry. |
| `reject-trains-on-input` | opencode-zen routed to cues / auditors is structurally refused (trust-class guard). |
| `reject-unknown` | Hallucinated providers/models → NONE. |
| `regression-setting` | Setting changes (`enable debug logging _`) still route to INTENT A. |
| `regression-none` | Lookups + provider mentions that aren't switches still classify as NONE. |

## Targets

- **Precision** ≥ 95% — reject cases classified as NONE. FP on a
  reject mis-routes a settings/provider write and is the security-
  critical metric.
- **Recall** ≥ 80% — hit cases routed to the right scope/provider
  (and model when specified).
- **FP count** = 0 in steady state. The `--category reject-*`
  filter runs only the security-relevant subset.

## What it doesn't test

- The runtime apply path — covered by the vitest scenarios in
  `packages/opencues-core/src/sources/config-intent-source.test.ts`.
- Cycling after a switch — covered by the runtime's selector-satellite
  scenario tests.
- Cross-provider latency budgets — covered by the `fluid-blank` +
  `transform-blank` benches under `tests/benchmarks/`.

## Adding cases

Append to `cases.ts`. Reuse an existing `category` or add one + extend
the judge's verdict taxonomy if the new shape doesn't map. Keep the
suite under ~60 cases — beyond that the per-provider sweep cost
makes contributors run it less.
