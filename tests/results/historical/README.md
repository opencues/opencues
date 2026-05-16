# tests/results/historical

Pre-May-2026 benchmark logs from earlier OpenCues code paths
(cuescore harness, hints experiment, kimi-k2 probe). Kept for
historical reference — these did NOT use the current `tests/benchmarks/
{transform,fluid}-blank/` harness and the numbers are NOT directly
comparable to today's matrix.

See `tests/benchmarks/BENCHMARKS.md § Historical context` for the
methodology delta between the Feb 2026 cuescore baseline and the
current sweep.

Active results directories (sister folders to this one):

- `matrix-v2/` — 5-provider × 4-mode transform-blank matrix (May 2026)
- `fluid-matrix-v1/` — 5-provider × 3-mode fluid-blank matrix
- `cerebras-vs-groq-fused/` — 5-rep head-to-head on `fused` mode
- `cuescore-replay/` — Feb cuescore cases replayed on current harness
- `chat-latest/` — gpt-5.5 Instant runs
- `openai-mini/`, `openai-nano-fixed/` — gpt-5.4 mini/nano variants
- `gemini-vs-gptoss/`, `provider-matrix/` — early matrix iterations
