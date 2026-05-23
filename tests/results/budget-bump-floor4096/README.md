# Budget bump — FUSED_FLOOR 2048→4096, FUSED_CEILING 4096→8192

**Date**: 2026-05-23

## Why

Chrome session ran `translate to japanese _` on a 700-char letter with
rich-text markdown markers (prior bold transforms had populated
MarkdownRender's cache). LLM verbatim-echoed the TARGET section
(~720 output tokens) BEFORE emitting FULL_REWRITE; combined with the
Japanese output (~1050 tokens) + reasoning_effort='medium' overhead
(~700 tokens) the cumulative output exceeded the 2048-token budget,
truncating mid-Japanese. Three-way merge then preserved the English
tail of the live buffer — visible as a Frankenstein bilingual buffer.

Probe (`budget-translate-probe.ts`) measured latency + cost as FLAT
across budgets 2048-8192. The 2048 cap had no measurable upside —
just truncation risk.

## Results

| Metric | FLOOR=2048 (commit 8d58260) | FLOOR=4096 (this raise) |
|---|---|---|
| cerebras fused accuracy (231 cases) | 80.1% | **81.4%** (+1.3pp) |
| Avg per-case latency | ~450ms | ~453ms (noise) |
| Wall-clock total (parallel=8) | ~16s | 15.8s |
| Cost per case | unchanged (billed on emitted tokens, not cap) |

The bump improved accuracy slightly (some prior truncation cases now
complete) and did not regress any category.

## Files

- `cerebras_fused_floor4096.log` — full bench output
- `../../benchmarks/transform-blank/budget-translate-probe.ts` — the probe that motivated the raise

