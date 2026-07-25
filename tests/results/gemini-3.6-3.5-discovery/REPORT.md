# gemini-3.6-flash + gemini-3.5-flash-lite discovery bench — 2026-07-21

Two new models appeared on the Gemini API: `gemini-3.6-flash` and
`gemini-3.5-flash-lite` (exact IDs verified against
`/v1beta/models`). Benched both against a same-session
`gemini-3.1-flash-lite` baseline (the current provider default) on the
two main pipelines, all runs `--parallel 4`, judge pinned to groq
gpt-oss-120b as usual.

## Thinking configuration — the API changed

**All runs are no-thinking**, but the knob moved on the new tiers:

- `thinkingBudget: 0` (our historical no-thinking config) is **rejected
  with 400** by both 3.5-flash-lite and 3.6-flash.
- `thinkingLevel: "minimal"` is the new no-thinking idiom — verified
  `thoughtsTokenCount: 0` even on hard reasoning prompts (where `low`
  spends ~470 thought tokens). `thinkingLevel: "none"` is rejected by
  the enum; `thinkingBudget: 1` also yields 0 thoughts but is the
  messier spelling.
- 3.5-flash-lite does not think by default (thoughts=0 with no
  thinkingConfig at all), so the production adapter — which sends no
  thinkingConfig — is unaffected. 3.6-flash DOES think by default
  (dynamic), so production use of 3.6-flash would need an explicit
  `thinkingLevel: minimal` to match these numbers.

Runs used `OPENCUES_GEMINI_THINKING=none` (baseline, → budget 0) /
`=minimal` (new tiers). The transform runs required a temporary
env-gated `thinkingConfig` hook in `llm-provider.ts`'s GEMINI
`buildRequest` (uncommitted worktree edit at the time of this bench).

## Results

### fluid-blank (137 cases, fused, no thinking)

| model | acc | mean | min | p50 | p90 | p99 | max |
|---|---|---|---|---|---|---|---|
| 3.1-flash-lite (baseline) | 97.8% (134/137) | 511 | 340 | 413 | 499 | 3615 | 3632 |
| **3.5-flash-lite** | **100% (137/137)** | **431** | 348 | 419 | 494 | 614 | 620 |
| 3.6-flash | 98.5% (135/137) | 817 | 611 | 799 | 959 | 1119 | 1303 |

### transform-blank (487 cases, fused, no thinking)

| model | acc | mean | min | p50 | p90 | p99 | max |
|---|---|---|---|---|---|---|---|
| 3.1-flash-lite (baseline) | 86.7% (422/487) | 551 | 395 | 548 | 659 | 788 | 851 |
| 3.5-flash-lite | 86.0% (419/487) | 558 | 386 | 527 | 644 | 933 | 3753 |
| 3.6-flash | 88.1% (429/487) | 934 | 652 | 907 | 1087 | 1320 | 3156 |

Per-category transform notes: `linked-concepts` is weak across the
whole tier (8/6/10 of 20); 3.6-flash sweeps `trailing-instruction`
24/24 and `format-transform` 52/52; `creative-rewrite` is noisy
(9/15/11 of 20). The same-session baseline (86.7%) reads ~2.5pp below
the May BENCHMARKS.md fused row (89.2%) — judge-session drift; compare
within-session deltas only.

## Read

- **3.5-flash-lite is a strict upgrade over 3.1-flash-lite for
  fluid-blank**: first 100% Gemini score on the suite, fastest mean,
  and it kills the baseline's 3.6-second p99 tail (worst case 620ms).
  Transform parity (−0.7pp, noise). Candidate to become the gemini
  provider `defaultModel`.
- **3.6-flash buys +1.4pp transform accuracy for ~70% more latency**,
  and its floor (min 652ms) is slower than the lite tiers' p90 even
  with thinking hard-off. Not attractive for interactive surfaces;
  could suit an accuracy-over-latency override.

Raw logs alongside this file (`fluid-*.log`, `transform-*.log`).
