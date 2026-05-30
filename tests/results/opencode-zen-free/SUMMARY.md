# OpenCode Zen free-pool — fluid-blank sweep

Re-runs of the canonical 30-case fluid-blank slice against the live
free pool, plus the contemporaneous live `/v1/models` listing each
run was taken against.

## Latest run — 2026-05-31

30-case slice of the canonical 137-case fluid-blank suite (`--limit 30`),
`--mode fused`, `--parallel 1`, `OPENCUES_OPENCODE_ZEN_DELAY_MS=2000`,
anonymous (no `OPENCODE_ZEN_API_KEY`). Judge pinned to Groq
`gpt-oss-120b` per the standard bench convention.

| Model | Accuracy | Per-case latency | Wall-clock | Status |
|---|---|---|---|---|
| `nemotron-3-super-free`  | **90.0%** (27/30) | 12146ms | 365.2s | live (winner) |
| `deepseek-v4-flash-free` | 43.3%  (13/30)    | 5953ms  | 182.3s | live |
| `big-pickle`             | 36.7%  (11/30)    | 6300ms  | 195.2s | live |
| `mimo-v2.5-free`         | 23.3%  (7/30)     | 5887ms  | 182.0s | live (NEW, last) |
| `qwen3.6-plus-free`      | —                 | —       | —      | **listed-but-401** (subscription-gated) |
| `minimax-m2.5-free`      | —                 | —       | —      | **listed-but-401** (subscription-gated) |

Headline shifts from the 2026-05-23 baseline:

- **`nemotron-3-super-free` extended its accuracy lead** (86.7% → 90.0%).
  Latency dropped (14002ms → 12146ms p50).
- **`mimo-v2.5-free` is a new pool entry** (appeared in `/v1/models`
  since May 23) but is the *worst* working model at 23.3%. **Do not
  promote it into `OPENCODE_ZEN_FREE_POOL`** — see Pool ordering below.
- **`qwen3.6-plus-free` and `minimax-m2.5-free` still show up in the
  live model listing** but now return HTTP 401 (was 402 in May —
  same effect: unusable for anonymous traffic).
- **`big-pickle` and `deepseek-v4-flash-free` slightly down** on the
  same battery (40% → 36.7%, 46.7% → 43.3%), within sample-noise on
  30 cases.

## How to reproduce

```bash
mkdir -p tests/results/opencode-zen-free
for M in nemotron-3-super-free deepseek-v4-flash-free big-pickle mimo-v2.5-free; do
  OPENCUES_BENCH_PROVIDER=opencode-zen \
    OPENCUES_OPENCODE_ZEN_MODEL=$M \
    OPENCUES_OPENCODE_ZEN_DELAY_MS=2000 \
    npx tsx tests/benchmarks/fluid-blank/run.ts --mode fused --parallel 1 --limit 30 \
    > tests/results/opencode-zen-free/$M.log 2>&1
done
./tests/results/opencode-zen-free/summarize.sh
```

`*.log` is gitignored — re-run to populate. `summarize.sh` is the
committed survival path.

Run the models sequentially (not parallel) — anonymous traffic
appears to share a single rate-limit bucket. The May 2026 attempt
to parallelise the sweep crashed both processes at ~16/30 cases with
silent provider errors.

## Pool ordering (consequence)

`OPENCODE_ZEN_FREE_POOL` in `packages/opencues-core/src/llm-provider.ts`
stays ordered accuracy-desc and **remains unchanged** from May 23:

```ts
export const OPENCODE_ZEN_FREE_POOL: readonly string[] = [
  'nemotron-3-super-free',
  'deepseek-v4-flash-free',
  'big-pickle',
];
```

The 23.3% accuracy of `mimo-v2.5-free` is well below `big-pickle`'s
36.7%, with no latency upside (both ~6s p50). Adding it would burn a
pool slot on a model worse than what's already at the bottom. **Not
added.**

If `nemotron-3-super-free` fails (transient pool removal or 4xx) the
runtime walks to `deepseek-v4-flash-free` next. Below that the
accuracy floor drops below 40% and the system's user-visible
behaviour starts to feel unreliable — at which point a hard
"OpenCode Zen pool exhausted" surface in the resolver is the right
UX, not silently falling through to `mimo` or another sub-40% model.

## The latency vs accuracy trade

`nemotron-3-super-free` is 2× the latency of the other working models
(12s vs 6s p50). For blanks this is the right trade:

- The user typed `_` — explicit consent, loading spinner is expected
- A 6s **wrong** answer is strictly worse than a 12s **right** answer
  (they have to re-prompt or accept garbage)
- The runtime emits a `BlankLoading` animator from t=0; the wait is
  paced visually

If a future user case demands speed-over-accuracy on the free pool, a
separate `blank-llm-model: opencode-zen/fast` scalar could pin to
`deepseek-v4-flash-free` directly — but that's a feature design call,
not a pool reordering.

## Caveats

- **30-case slice, not full 137.** Directional signal only — re-run
  with `--limit 137` (or drop the flag) for strict parity with the
  paid matrix in `BENCHMARKS.md`. ~6 min for nemotron alone at the
  current throttle.
- **Anonymous shared rate-limit.** 2000ms throttle (bumped from
  1500ms on 2026-05-31 after the parallel-sweep failure) — actual
  limit isn't documented. Lower the delay cautiously.
- **`/v1/models` and "actually free" diverge.** Two entries in the
  live listing (`qwen3.6-plus-free`, `minimax-m2.5-free`) return 401
  to anonymous requests. The pool walker auto-skips on 4xx via the
  30s health cache, so users never see these failures — but they're
  why a fresh `curl https://opencode.ai/zen/v1/models` listing
  isn't a one-to-one feed for the pool config.
- **Single-trial accuracy numbers.** Cell variance ~3-7pp between
  the two runs at one month apart. Treat the rankings as solid
  ordinal data, the percentages as rounded indicators.

## Prior runs

- 2026-05-23 — `nemotron 86.7% / deepseek 46.7% / big-pickle 40.0%`,
  qwen + minimax retired with HTTP 402 ("Free promotion has ended").
  Pool ordering set to current shape.
