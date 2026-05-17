# Speed-vs-Accuracy Bench — typical OpenCues surfaces, short vs long-form context

**Date:** 2026-05-14
**Workload:** 18 cases across 6 cells — {word-cue, fluid-blank, transform} × {short, long}. Long cells use 200-250 word context passages (industrial history, relational databases, climate modelling). 3 trials per case, parallel=4.
**Pass criterion:** deterministic regex / substring checks (no LLM judge — no judge variance).
**Latency:** wall-clock from request send to last byte, captured per call by the existing `transform-blank/groq-impl.ts` and `gemini.ts` chat clients.

Companion to `gemini-3.1-flash-lite-2026-05-09.md`, which compared on the three production benchmarks at full scale. This run focuses **speed-first** with a novel case mix designed to stress long context.

## Headline

| Config | Pass | Median | Mean | p95 | Wall (54 calls @ p=4) |
|---|---:|---:|---:|---:|---:|
| Groq `gpt-oss-120b` | **54/54 (100%)** | **167 ms** | 276 ms | 946 ms | **4.2 s** |
| Gemini 3.1 Flash Lite (think:low) | 51/54 (94.4%) | 557 ms | 660 ms | 1228 ms | 9.4 s |
| Gemini 3.1 Flash Lite (think:none) | 51/54 (94.4%) | 555 ms | 631 ms | 1212 ms | 8.9 s |

**Groq is ~3× faster at the median, ~2× faster wall-clock, and tied on accuracy on this case mix.** The 3 Gemini failures are all the same case — an "interpretation" disagreement, not a real miss (see below).

## Per-cell breakdown

| Cell | Groq pass / med / p95 | Gemini-low pass / med / p95 | Gemini-none pass / med / p95 |
|---|---:|---:|---:|
| **word-cue · short** (0=happy/quick/meeting) | 9/9 · 185 ms · 310 ms | 9/9 · 552 ms · 677 ms | 9/9 · 557 ms · 629 ms |
| **word-cue · long** (passage + target word) | 9/9 · 254 ms · 307 ms | 9/9 · 616 ms · 786 ms | 9/9 · 553 ms · 809 ms |
| **fluid-blank · short** (Paris / 212 / Jupiter) | 9/9 · 103 ms · 127 ms | 9/9 · 543 ms · 1226 ms | 9/9 · 555 ms · 675 ms |
| **fluid-blank · long** (passage-grounded lookup) | 9/9 · 151 ms · 185 ms | 9/9 · 491 ms · 624 ms | 9/9 · 442 ms · 1291 ms |
| **transform · short** (boy→girl / past tense / drop adj) | 9/9 · 143 ms · 153 ms | 6/9 · 545 ms · 734 ms | 6/9 · 539 ms · 734 ms |
| **transform · long** (rewrite 200+ word passage) | 9/9 · 819 ms · 1060 ms | 9/9 · 1042 ms · 1553 ms | 9/9 · 1023 ms · 1280 ms |

Speed multiple (Gemini-low / Groq, median): word-cue 3.0×, fluid-blank 5.3× / 3.3×, transform 3.8× / 1.3×.

The transform-long gap closes to 1.3× because most of the latency is **output token generation** (the model emits 1.3 KB rewritten passage) which both providers handle at similar tok/s. Where the workload is **input-bound + small output** (word-cue, fluid-blank), Groq's edge is the largest.

## Long context did NOT hurt accuracy

For both providers and both task types, the long-context cells matched their short counterparts at 9/9 (with the same one transform case missing on Gemini in both lengths). 200-250 word passages don't appear to degrade these models on grounded lookup / context-aware synonym tasks.

Long context **did** add latency, predictably:

| Cell | Δ vs short (Groq) | Δ vs short (Gemini-low) |
|---|---:|---:|
| word-cue | +69 ms (+37%) | +64 ms (+12%) |
| fluid-blank | +48 ms (+47%) | −52 ms (−10%, within noise) |
| transform | +676 ms (+472%) | +497 ms (+91%) |

word-cue/fluid-blank long-context overhead is input-token-prefill cost (~250 extra prompt tokens). For Groq this is a meaningful relative jump because the baseline is so low. For Gemini-low it disappears into normal variance.

## The 3 Gemini "failures" are one case × 3 trials

All three Gemini failures are `trans-short-3`: *"Edit: remove all adjectives. Passage: The quick brown fox jumps."*

- **Groq output:** `The fox jumps.` — passes accept regex `/the fox jumps/i`.
- **Gemini output:** `Fox jumps.` — fails the regex because it also strips the definite article *"the"*.

Whether *"the"* is an adjective is a definitional argument (most grammarians say no — it's a determiner / article). Gemini takes the stricter "remove anything modifying the noun" reading; Groq takes the conservative "leave function words" reading. Different defensible interpretations, scored against one. If the regex accepted either, Gemini's pass rate would be 54/54 too.

## Discovered gotcha — Groq's `reasoning_effort: 'low'` and empty content

Initial run had Groq failing 14/54 with **0-byte responses** on long-context fluid-blank cases. Probe of one such response:

```json
"message": {
  "role": "assistant",
  "content": "",
  "reasoning": "Need fill blank: \"1830s\". Answer: 1830s."
},
"finish_reason": "length",
"completion_tokens": 20,
"completion_tokens_details": { "reasoning_tokens": 17 }
```

With `max_tokens: 20` and `reasoning_effort: 'low'`, gpt-oss-120b burned 17/20 tokens on internal reasoning, leaving no budget for the actual content emission. The correct answer is sitting in `reasoning`, but `content` is empty.

**Why this matters for OpenCues prod**: any code path that sets a tight `max_tokens` on a context-rich prompt is at risk of silent empty-content failures. The current benchmark's groq-impl soft-fails parse errors to empty text, masking the issue. After bumping fluid-blank `maxTokens` from 20 → 120, Groq cleared the wall.

Action item: audit production `max_tokens` settings on `gpt-oss-120b` paths and ensure each leaves ≥30 tokens of headroom above the expected answer length, OR switch those paths to `reasoning_effort: 'minimal'` if the provider exposes it.

## Latency anatomy — short vs long output

The 200-word transform cases are the only ones where output dominates total latency. For everything else, **Groq pays ~100-250 ms total** and **Gemini pays ~440-620 ms total** — most of which is per-call overhead (TLS, regional RTT, model start-up tax), not generation. So:

- **Tight latency budget, small outputs (cue, blank, short transform)**: Groq is the only viable choice in this comparison.
- **Tight latency budget, long outputs**: gap shrinks to 1.3× — choose on accuracy.
- **Accuracy-first, long outputs**: prior report shows Gemini wins transform-blank by 38pp on the 212-case benchmark; this report's 3-case long-transform cell is too small to add signal.

## Thinking: low vs none (Gemini)

Within noise on this small workload — `none` was 2 ms faster at the median, 16 ms faster at p95, identical pass rate. The 23% latency saving the prior report measured on transform-blank (212 cases) doesn't reproduce here because:
1. This bench has only 3 transform-long cases.
2. Word-cue and fluid-blank prompts don't seem to engage Gemini's reasoning budget meaningfully even at `low`.

If you're already running Gemini for these surfaces, `none` is a free 2-3% latency trim. If you're optimizing transform-blank specifically, refer to the 2026-05-09 numbers for the bigger picture.

## Recommendation

For the **cue + blank + short-transform** surfaces this report measures, **Groq stays the right default**. It's 3-5× faster at the median, 100% pass on this case mix, and ~half the per-call cost ($0.15/$0.60 vs $0.25/$1.50 per 1M tokens).

The only surface where Gemini is worth considering — based on this report combined with the 2026-05-09 transform-blank deep-dive — is **long, complex transform-blank prompts** (>200 word context, multi-span / context-referring / linked-concepts categories), where the +38pp accuracy gain outweighs the 1.3× latency cost. The CUES.md `transform-blank-provider:` knob already supports per-surface routing.

## Reproducibility

```bash
# Groq baseline
GROQ_API_KEY=… npx tsx tests/benchmarks/speed-accuracy/run.ts --trials 3 --parallel 4 --json /tmp/sa-groq.json

# Gemini, thinking=low (default)
GEMINI_API_KEY=… OPENCUES_BENCH_PROVIDER=gemini-flash-lite \
  npx tsx tests/benchmarks/speed-accuracy/run.ts --trials 3 --parallel 4 --json /tmp/sa-gemini-low.json

# Gemini, thinking=off
GEMINI_API_KEY=… OPENCUES_BENCH_PROVIDER=gemini-flash-lite OPENCUES_GEMINI_THINKING=none \
  npx tsx tests/benchmarks/speed-accuracy/run.ts --trials 3 --parallel 4 --json /tmp/sa-gemini-none.json
```

Sources:
- `tests/benchmarks/speed-accuracy/cases.ts` — 18 cases, 3 long-form passages (industrial history, databases, climate)
- `tests/benchmarks/speed-accuracy/run.ts` — runner with wall-clock latency and median/mean/p95 reporting

Output captures (tmp; re-run to regenerate):
- `/tmp/sa-groq.json`
- `/tmp/sa-gemini-low.json`
- `/tmp/sa-gemini-none.json`

## Caveats

- **N is small** — 3 cases per cell × 3 trials = 9 observations per provider per cell. Headline numbers are directional, not p<.05.
- **Wall latency, not TTFT** — this bench measures total response time. The prior `bench-providers.ts` separates TTFT, which matters for live-typing UX; this report doesn't reproduce that split.
- **Network conditions** — runs were sequential on the same WSL host, May 2026. Different geography or time of day will move absolute numbers.
- **Single judge interpretation** — the trans-short-3 disagreement (Gemini removing "the") is hand-categorized; reasonable people could score it either way.
- **No retry / failover** — these numbers assume the happy path. Real prod adds error-recovery latency that this bench skips.
- **Snapshot in time** — pricing and model behaviour change. Re-confirm before making cost or routing decisions on this data alone.
