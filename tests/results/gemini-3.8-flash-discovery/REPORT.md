# gemini-3.8-flash discovery bench — 2026-09-03

`gemini-3.8-flash` went GA on the API 2026-09-02 (exact ID verified
against `/v1beta/models`; a `gemini-3.7-flash` also exists on the API
and has never been benched here). Benched 3.8-flash against a
same-session `gemini-3.5-flash-lite` baseline (the current gemini
provider `defaultModel`) on the two main pipelines, all runs
`--parallel 4`, judge pinned to groq gpt-oss-120b as usual.

Announcement framing: "most intelligent Flash model", 1M context, 64k
max output, tunable thinking levels low/medium/high. Intro pricing
$0.75/1M input, $3.75/1M output until Dec 31.

## Thinking configuration — the knob moved AGAIN

**3.8-flash cannot be made fully non-thinking:**

- `thinkingLevel: "minimal"` (the 3.5/3.6 no-thinking idiom) is
  **rejected with 400** ("Thinking level MINIMAL is not supported for
  this model").
- `thinkingBudget: 0` (the pre-3.5 idiom, rejected by 3.5/3.6) is
  **accepted but acts as a soft floor**: on a hard reasoning probe it
  still spent ~500-620 thought tokens (vs ~980 with no thinkingConfig
  at all, ~730 at `low`). On trivial lookups it spends 0 — thinking
  scales with case difficulty and cannot be turned off.
- Thought tokens **count against `maxOutputTokens`**: a 64-token cap on
  the hard probe returned `finishReason: MAX_TOKENS` with the answer
  truncated mid-word. Any production use needs a generous cap or none.

Runs used `OPENCUES_GEMINI_THINKING=minimal` (baseline) / `=none`
(→ `thinkingBudget: 0`, 3.8-flash's floor). Fluid runs used
`OPENCUES_BENCH_MAX_TOKENS=1024` (both models) to keep the thinking
floor from truncating output; transform's source sends no cap.

## Results

### fluid-blank (137 cases, fused)

| model | acc | mean | min | p50 | p90 | p99 | max |
|---|---|---|---|---|---|---|---|
| 3.5-flash-lite (baseline) | 99.3% (136/137) | 580 | 448 | 549 | 721 | 1094 | 1127 |
| **3.8-flash** | **100% (137/137)** | 1527 | 635 | 1183 | 2815 | 5903 | 10997 |

Baseline's single fail is `r-q-richter-max` (answered `None`), a
recurring flake-class case. 3.8-flash's perfect score matches
3.5-flash-lite's July run — the suite is saturated at this tier;
accuracy is not the differentiator, latency is: 2.6× mean, and a tail
(p99 5.9s, max 11s) that would be felt on every hard `_` lookup.

### transform-blank (487 cases, fused)

| model | acc | mean | min | p50 | p90 | p99 | max |
|---|---|---|---|---|---|---|---|
| 3.5-flash-lite (baseline) | 85.0% (414/487) | 791 | 497 | 647 | 1123 | 3032 | 3884 |
| **3.8-flash** | **88.1% (429/487)** | 1537 | 682 | 1004 | 2969 | 7729 | 11709 |

Per-category: 3.8-flash's +3.1pp comes almost entirely from the
reasoning-ish categories — `conditional` 20/20 (vs 15/20),
`context-referring` 18/20 (vs 14/20), `negative` 19/20 (vs 17/20),
`multi-span` 20/20, `tone-shift` 16/20 (vs 14/20). It *loses* on
`creative-rewrite` 10/20 (vs 13/20; noisy category) and
`multi-paragraph` 13/20 (vs 14/20). `linked-concepts` stays broken
across the whole family (10/20 vs 9/20). Same-session baseline (85.0%)
reads ~1pp below the July run of the same model (86.0%) — judge-session
drift; compare within-session deltas only.

## Read

- **Not a default candidate.** The +3.1pp transform gain costs ~2×
  mean latency with an unbounded thinking tail (p99 7.7s), and the
  latency floor cannot be configured away — 3.8-flash rejects every
  no-thinking spelling. For interactive keystroke surfaces that's the
  wrong trade; 3.5-flash-lite stays the right `defaultModel`.
- Same verdict shape as 3.6-flash in July (accuracy up, latency way
  up), but more extreme on both axes: 3.8 is +3.1pp (3.6 was +1.4pp)
  and its tail is seconds, not hundreds of ms.
- **Where it fits**: an accuracy-over-latency per-feature override
  (`transform-blank-model: gemini-3.8-flash`) for users who want the
  conditional/context-referring wins — the same slot 3.6-flash was
  documented into. Comparing within-session deltas over the shared
  3.5-flash-lite reference, 3.8 is the stronger override (+3.1pp vs
  3.6's +2.1pp in July). Not worth adding to `knownModels` unless
  someone asks.
- If it ever does become a candidate for any default path: the
  `maxOutputTokens`-includes-thoughts behaviour means fluid-blank's
  512-token bench cap (and any production cap) must be revisited
  first, or hard cases silently truncate.

Raw logs alongside this file (`fluid-*.log`, `transform-*.log`).
Runs: 2026-09-03, GEMINI_API_KEY dev key, judge groq gpt-oss-120b.
