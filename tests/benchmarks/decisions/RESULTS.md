# Decision-layer compare bench — results log

One row per arm per leg, from `node tests/benchmarks/decisions/compare.mjs <leg>`, pasted
verbatim with the date and the pinned model. Same host, same session for both arms.
Accuracy is the shipped bench's own metric for the leg; $/call comes from core's price
table via the usage meter (Cerebras cached tokens at the full input rate).

## smoke — step 0 (seam only)

2026-09-16 · jev-1.13.0 · WSL2 host, ~160 ms RTT · n = 20 per arm, keep-alive

```
typesafe               accuracy 20/20
typesafe               n=20  p50 220 ms  p90 248 ms  $0.000017/call  401 in / 79 out
chat-fallback/cerebras accuracy 20/20
chat-fallback/cerebras n=20  p50 413 ms  p90 743 ms  $0.000412/call  298 in / 410 out
```

Reading: three questions (noul + choice-3 + score-3) on a one-line state. The Jev row is
the floor for a warm connection from this host (server ~95 ms + one RTT). The fallback's
410 output tokens are gpt-oss-120b's hidden reasoning at `reasoning_effort: low`; that is
what makes it 24× the price and twice the latency for the same three answers, and why the
fallback is the emergency path, not a peer.
