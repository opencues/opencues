# OpenCode Zen free-pool — fluid-blank sweep (2026-05-23)

30-case slice of the canonical 137-case fluid-blank suite (`--limit 30`),
`--mode fused`, `--parallel 1`, `OPENCUES_OPENCODE_ZEN_DELAY_MS=1500`,
anonymous (no `OPENCODE_ZEN_API_KEY`). Judge pinned to Groq
`gpt-oss-120b` per the standard bench convention.

## Results

| Model | Accuracy | Per-case latency | Wall-clock | Status |
|---|---|---|---|---|
| `nemotron-3-super-free`  | **86.7%** (26/30) | 14002ms | 420.8s | live |
| `deepseek-v4-flash-free` | 46.7% (14/30)     | 4990ms  | 153.2s | live |
| `big-pickle`             | 40.0% (12/30)     | 5064ms  | 155.0s | live |
| `qwen3.6-plus-free`      | —                 | —       | —      | **retired** → paid OpenCode Go |
| `minimax-m2.5-free`      | —                 | —       | —      | **retired** → paid OpenCode Go |

The two retired models returned `HTTP 402` with body
`"Free promotion has ended for <X>. You can continue using the model by
subscribing to OpenCode Go - https://opencode.ai/go"`. The runtime's
`withFreePool` wrapper bubbles these as quota errors via
`ProviderHealth` (sticky); the bench harness logs `FATAL` and exits
non-zero, but the sweep driver continues to the next model.

## How to reproduce

```bash
mkdir -p tests/results/opencode-zen-free
for M in nemotron-3-super-free deepseek-v4-flash-free big-pickle; do
  OPENCUES_BENCH_PROVIDER=opencode-zen \
    OPENCUES_OPENCODE_ZEN_MODEL=$M \
    OPENCUES_OPENCODE_ZEN_DELAY_MS=1500 \
    npx tsx tests/benchmarks/fluid-blank/run.ts --mode fused --parallel 1 --limit 30 \
    > tests/results/opencode-zen-free/$M.log 2>&1
done
./tests/results/opencode-zen-free/summarize.sh
```

`*.log` is gitignored — re-run to populate. `summarize.sh` is the
committed survival path.

## Pool ordering (consequence)

`OPENCODE_ZEN_FREE_POOL` in `packages/opencues-core/src/llm-provider.ts`
is ordered accuracy-desc:

```ts
export const OPENCODE_ZEN_FREE_POOL: readonly string[] = [
  'nemotron-3-super-free',
  'deepseek-v4-flash-free',
  'big-pickle',
];
```

The retired entries are dropped — the runtime's 30s health cache would
have skipped them on the next call anyway, but ordering the list off
real data avoids burning a request on a dead model first.

## Caveats

- **30-case slice, not full 137.** Directional signal only — re-run
  with `--limit 137` (or drop the flag) for strict parity with the
  paid matrix in `BENCHMARKS.md`. ~30 min for nemotron alone at the
  current throttle.
- **Anonymous shared rate-limit.** 1500ms throttle was a guess —
  worked across this sweep with zero rate-limit errors, but the
  actual limit isn't documented. Lower the delay cautiously.
- **Same `/v1/models` set may change.** Two of five free models
  retired between the docs being written (early May 2026) and this
  bench (2026-05-23). Re-check live list via
  `curl https://opencode.ai/zen/v1/models` before relying on a
  specific entry.
