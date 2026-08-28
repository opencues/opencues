# Benchmarks — provider, pipeline, and cost landscape

Cross-bench landing page for everything OpenCues measures. Each
pipeline has its own running experiment log; this doc consolidates
"given my task and constraints, which provider × mode should I pick?"

---

## Landing map — what every bench measures

| Pipeline | What it tests | Cases | Status | Source |
|---|---|---|---|---|
| **transform-blank** | Imperative rewrite (`change boy to girl _ the boy ran`) | 231 across 18 categories | shipped, ⭐ 5×4 matrix | [`transform-blank/EXPERIMENTS.md`](transform-blank/EXPERIMENTS.md) |
| **fluid-blank** | Short factual lookup (`capital of france _`) | 137 + 7 category bench suites (math, factual, unit, color, http, roman, translation, spelling) | shipped, ⭐ 5×3 matrix | [`fluid-blank/EXPERIMENTS.md`](fluid-blank/EXPERIMENTS.md) |
| **fluid-blank-ambient** | Field-aware lookup (label/placeholder/page-title disambiguates `paris _` → `CDG` on Airport-code field) | 137 standard + 18 in-prompt + 21 held-out | shipped, chrome-only feature | [`fluid-blank-ambient/`](fluid-blank-ambient/) |
| **agent-rewrite** | Continuous in-place cadence-driven rewrite (`agentically X _`) | live-typing scenarios + unit-level merge cases | shipped, integration-level | [`agent-rewrite/CONTINUE.md`](agent-rewrite/CONTINUE.md) |
| **user-context** | Sentinel-token PII handling — model emits `[FIRST NAME]`, post-processor substitutes | 32 standard + 10 multi-sentinel (up to 16 tokens/answer) × 5 providers | shipped | [`user-context/FINDINGS.md`](user-context/FINDINGS.md) |
| **fluid-config** | Semantic `_` → settings change classifier (`stop showing tips _` → tips-mode=off) | 61 in-prompt + 34 holdout × 5 providers | shipped May 2026 | [`fluid-config/EXPERIMENTS.md`](fluid-config/EXPERIMENTS.md) |
| **sentence-cues** | Sentence-scope rewrites (`scope: sentence` cue declaration) — first cue: more-formal | 30 cases × 6 buckets × 5 providers | shipped May 2026 | [`sentence-cues/EXPERIMENTS.md`](sentence-cues/EXPERIMENTS.md) |
| **thinking-budget** | Per-provider × per-reasoning-level latency budget (which provider can afford which reasoning effort on which pipeline?) | 40-case fluid-blank stride sample × 4 providers × 4 reasoning levels | shipped May 18 2026 | [`../results/thinking-budget-2026-05-18.md`](../results/thinking-budget-2026-05-18.md) |

Raw result matrices under [`tests/results/`](../results/) per bench
(`matrix-v2/` for transform-blank, `fluid-matrix-v1/` for fluid-blank,
`fluid-config-matrix/`, `sentence-cues-matrix/`, `user-context-*/`,
`cerebras-vs-groq-fused/` for the 5-rep head-to-head, etc.).

---

## Methodology — what makes a number trustworthy here

1. **Judge pinned to Groq gpt-oss-120b.** Self-judging (when judge
   and inference share a provider) inflates accuracy ~5pp. Every
   bench's `judge*.ts` imports from `./groq-impl` directly,
   ignoring `OPENCUES_BENCH_PROVIDER`.
2. **Same suite per bench every run.** Cases are versioned in
   `cases.ts` / `cases-holdout.ts`; reruns produce comparable numbers.
3. **`temperature: 0`, `seed: 42`** on every provider that exposes
   them. Gemini's `thinkingBudget: 0` by default.
4. **`parallel: 8`** worker pool by default (6 for OpenAI nano to
   stay under TPM). Wall-clock numbers reflect this.
5. **Exact-match short-circuit in fluid-blank judge** — answers
   matching expected/alternates case-insensitively skip the LLM
   judge entirely.
6. **Deterministic judge for fluid-config + sentence-cues** — verdict
   is a bounded enum (setting+value or sentence-cede), so the judge
   is string-equality + registry-validation, not LLM-driven. No
   judge-rate-limit failure mode.
7. **Soft-fail on rate-limit & parse errors** — `groq-impl.ts`
   returns empty text rather than throwing.

**Known limitations:**
- Cost numbers estimated from prompt-length × per-token prices, NOT
  API `usage` blocks. OpenAI reasoning-token spend understated 2-4×.
- Run-to-run variance only formally measured for cerebras-vs-groq
  `fused` heads. Treat ±3pp accuracy and ±15% latency as practical
  noise floor on single-trial cells.
- Pricing snapshot: 2026-05-16. Re-fetch before quoting externally.

---

## Provider × pipeline matrix — at a glance

**Transform-blank (231 cases) — accuracy / per-case ms / $-per-correct:**

```
                          3-pass                 single-call            fused                  fused+verify
────────────────────────────────────────────────────────────────────────────────────────────────────────────────
groq    gpt-oss-120b      91.8% / 1459 / $0.84    17.7% /  532 / $1.02    80.5% /  727 / $0.32 ★   83.1% /  925 / $0.51
gemini  flash-lite        90.0% / 2263 / $1.52    89.2% /  729 / $0.37    89.2% /  772 / $0.54     90.5% / 1213 / $0.86
gemini  3.5-flash ‡       —                       —                       85.7% /  892 / —          —
cerebras gpt-oss-120b     78.8% /  933 / $2.13    29.4% /  330 / $1.36    76.2% /  331 / $0.74     47.6% /  363 / $1.89
claude  haiku-4.5         87.9% / 3048 / $6.03    82.3% /  912 / $1.56    88.7% / 1125 / $2.06     84.4% / 1497 / $3.64
openai  gpt-5.4-nano †    20.8% /  806 / $5.34    76.6% / 1431 / $0.35    48.9% / 1101 / $0.80     31.2% /  600 / $2.12
openai  gpt-5.4-mini  †   23.4% /  964 / $4.75    81.4% / 1251 / $0.79    85.3% / 1332 / $2.14     58.4% / 1129 / $3.92
openai  chat-latest   †   90.0% / 2766 / $30.44   86.1% /  970 / $7.72    86.6% / 1056 / $11.03    81.4% / 1382 / $12.53
```
† OpenAI rows: nano @ $0.20/$1.25, mini @ $0.75/$4.50, chat-latest @ $5/$30 per M tokens.
‡ `gemini-3.5-flash` 2026-05-19 spot-bench (fused only, thinking off) — regression vs `flash-lite` (−3.5pp acc, +15% latency). See [`../results/gemini-3.5-flash-2026-05-19.md`](../results/gemini-3.5-flash-2026-05-19.md).

**Local (Ollama) — `gemma4:e2b`, fused, 2026-06-29 (251-case suite):**

```
                          fused (acc / per-case ms)   notes
─────────────────────────────────────────────────────────────────────────────────────────
cerebras gpt-oss-120b     81.7% /  607               same-session baseline (251 cases)
ollama   gemma4:e2b       59.8% / ~2000              local/private/free; RTX 2070 Max-Q, ~2s warm
```

Same-session, same pinned-Groq judge, both fused. Run with
`npx tsx tests/benchmarks/transform-blank/prod.ts --provider ollama` (an
Ollama server must be running; `OPENCUES_OLLAMA_MODEL` overrides the model).
The ~22pp gap is **concentrated** — `gemma4:e2b` is within ≤10pp on the
mechanical edits people fire `_` for most (literal / math / format / simple
rewrites) and falls off a cliff (−30 to −50pp) on reasoning-heavy +
generative work (conditional, code, creative / tone, multilingual,
context-referring). Usable as a private default for the common case; not the
model for complex transforms.

**Fluid-blank (137 cases) — accuracy / per-case ms / $-per-correct:**

```
                          answer (2-pass)         classified (3-call)    fused (1-call)
─────────────────────────────────────────────────────────────────────────────────────────
groq    gpt-oss-120b     100.0% / 1216 / $0.37    97.1% / 1674 / $0.49    99.3% /  686 / $0.17 ★
gemini  flash-lite        98.5% / 1025 / $0.65    97.8% / 1629 / $0.87    98.5% /  613 / $0.30
gemini  3.5-flash ‡       —                       —                       98.5% /  727 / —
cerebras gpt-oss-120b     99.3% /  530 / $0.83    95.6% /  722 / $1.11   100.0% /  262 / $0.38   ← fastest
claude  haiku-4.5         99.3% / 1676 / $2.52    94.9% / 2479 / $3.48    99.3% /  837 / $1.18
openai  gpt-5.4-nano      27.0% /  964 / $1.93     3.6% /  261 / $18.89   40.9% /  425 / $0.59
openai  gpt-5.4-mini       9.5% /  480 / $5.47    13.1% /  603 / $5.19    80.3% / 1062 / $1.46
openai  chat-latest      100.0% / 1529 / $12.80   98.5% / 2249 / $17.26   99.3% /  855 / $6.04
```
‡ `gemini-3.5-flash` 2026-05-19 spot-bench (fused only, thinking off) — same accuracy as `flash-lite`, +19% slower. Not a strict upgrade.

★ = best cost-per-correct in the bench.

### DeepSeek V4 Flash — seven-surface sweep (2026-08-07)

Added after the tables above, so it isn't in them. Every row was run in
**one session against a same-session `cerebras gpt-oss-120b` baseline**
— the only honest way to compare, since the tables above were recorded
at different times and on a 231-case transform-blank suite (the bench
now runs 487).

| Surface | Bucket | deepseek-v4-flash | cerebras gpt-oss-120b | Latency (DS / Cb) |
|---|---|---|---|---|
| fluid-blank (137) | blanks | 98.5% | **99.3%** | 1364ms / 479ms |
| transform-blank (487) | blanks | **85.8%** | 84.8% | 957ms / 613ms |
| fluid-blank-ambient (176) | blanks | 99.4% | 99.4% | ~960ms / ~370ms |
| sentence-cues (34) | cues | **100%** | 97.1% | 1122ms / 277ms |
| next-prompt-cues (15) | cues | 100% | 100% | — |
| agent-rewrite (18) | auditors | 83.3% | 83.3% | 848ms / 243ms |
| fluid-config (91) | settings | P96.9 / R81.8 · undo 26/26 | **P100** / R84.8 · undo 23/26 | — |

**Read:** accuracy is a wash (2 wins, 2 ties, 2 losses, 1 split);
latency is not — DeepSeek is 1.6×–4× slower on every surface, a ratio
consistent enough to look structural rather than noisy. Not viable for
word-cues (~500ms budget).

Cost, measured from live `usage` blocks rather than estimated from
prompt length: **≈$0.021 per 1K correct fluid-blank answers**, ~8×
cheaper than the best row in the table above, on a measured 91%
prefix-cache hit rate (1024 of 1123 prompt tokens).

Two category-level inversions worth knowing before picking it per
surface:

- **transform-blank**: DeepSeek is far stronger on `long-text` (88.3%
  vs 71.7%), `multi-paragraph` (75% vs 50%) and `linked-concepts` (50%
  vs 35%); weaker on `creative-rewrite` (65% vs 80%) and `adversarial`
  (80% vs 95%). Good at mechanical, structure-preserving rewrites;
  worse at open-ended generation.
- **fluid-config**: perfect on `undo` but produces a settings
  false-positive cerebras doesn't. For a classifier that mutates user
  settings, false-positive is the expensive direction.

Reasoning is pinned off (`MODEL_THINKING['deepseek:deepseek-v4-flash']`).
Thinking-on was measured at 97.1% @2839ms on fluid-blank and 88.5%
@5155ms on transform-blank — i.e. worse on short lookups, +2.7pp on
long rewrites for 5.4× the latency.

Re-run: `DEEPSEEK_API_KEY=… GROQ_API_KEY=… npx tsx
tests/benchmarks/transform-blank/prod.ts --provider deepseek --parallel 8`,
and `OPENCUES_BENCH_PROVIDER=deepseek-flash` for the router-driven suites.

**Free pool — OpenCode Zen (`blank-llm-provider: free`) — 30-case fluid-blank fused, anonymous, 1500ms throttle:**

| Model | Accuracy | Per-case ms | Cost | Notes |
|---|---|---|---|---|
| `nemotron-3-super-free`      | **86.7%** (26/30) | 14002 | **$0** | NVIDIA terms; "trial use only — not for production / sensitive data". Slow but accurate. |
| `deepseek-v4-flash-free`     | 46.7% (14/30)     | 4990  | $0     | Fast but mediocre; ToS says inputs may be used to train the model. **Not representative of DeepSeek's own API** — the same model name via `deepseek` direct scored 98.5% (see the provider matrix above). The Zen free tier evidently serves something degraded; don't read this row as evidence about the `deepseek` provider. |
| `big-pickle`                 | 40.0% (12/30)     | 5064  | $0     | A stealth deepseek-v4-flash variant; same speed, worse accuracy. Same data-use clause as deepseek. |
| ~~`qwen3.6-plus-free`~~      | —                 | —     | —      | Promotion ended May 2026; now requires paid OpenCode Go subscription. |
| ~~`minimax-m2.5-free`~~      | —                 | —     | —      | Promotion ended May 2026; now requires paid OpenCode Go subscription. |

**Source:** [`tests/results/opencode-zen-free/`](../results/opencode-zen-free/). 30-case slice of the canonical 137-case fluid-blank suite (`--limit 30`), `--parallel 1`, `OPENCUES_OPENCODE_ZEN_DELAY_MS=1500`. Free models are **blank-only**: the runtime refuses `llm-provider: free` at startup because cues + auditors run on prose automatically and the free-tier ToS allows training on inputs. Pool ordering in `OPENCODE_ZEN_FREE_POOL` (`packages/opencues-core/src/llm-provider.ts`) is accuracy-desc; the runtime walks it on transient failure and 30s-cools-down failing models. Re-bench when the live `/v1/models` set changes.

### Qwen 3.8 27B on Groq — spot-check (2026-08-28)

> ⚠️ **NOT MERGE-READY AS A COMPARISON.** transform-blank ran a 38-case
> subset, not the full 487 every other row in the matrix above ran. **Run
> the full suite (`bash tests/benchmarks/transform-blank/run-qwen38.sh`
> against the full `CASES`, not `--only-file`) before treating this
> model's accuracy as comparable to the other rows, before citing it
> externally, or before using it to justify any production routing
> change.** The 89.5% here is directionally useful, not a verified
> number — see "Not yet done" below for the full list of what's
> outstanding.

`qwen/qwen3.8-27b` is a new Groq **preview**-tier model (not yet in
`llm-provider.ts`'s `PROVIDERS`/auto-route — bench-only today via
`tests/benchmarks/{fluid-blank,transform-blank}/groq-qwen38.ts` +
`OPENCUES_GROQ_MODEL` / `OPENCUES_BENCH_PROVIDER=groq-qwen38`). Not yet
compared apples-to-apples against the matrix above: transform-blank ran a
**38-case representative subset** (2 cases × 19 categories), not the full
487, and both runs went serially (`--parallel 1`).

| Pipeline | Cases | Accuracy | Notes |
|---|---|---|---|
| fluid-blank (answer, 2-pass) | 137/137 | **91.2%** (125/137) | Fails were mostly the judge marking "no answer" on ambiguous cases (Richter-scale max, largest desert), not garbled output. |
| transform-blank (fused) | 38-case subset | **89.5%** (34/38) | Fails were judgment calls, not garbage: wrong verb on a linked-concept swap ("raised his staff" vs "drew his wand"), an under-applied tone shift, and different-but-plausible emoji picks. |

**Why parallel=1 and a subset, not the standard `--parallel 8` / full 487:**
this preview tier enforces an org-wide **8000 TPM** cap (confirmed live —
`Rate limit reached... Limit 8000`), a tiny fraction of the other providers'
quotas in this doc. transform-blank's `FUSED_SYSTEM` alone is ~3.6k tokens,
so a single call there can consume nearly half the per-minute budget; at the
standard concurrency the first burst exhausts the quota and every
subsequent call reads as "no answer" — which is exactly what a first
`--parallel 4` attempt showed (nearly 0% pass) before this was diagnosed as
quota exhaustion, not a model-quality problem. Per-case latency in this
sweep (16–65s, occasionally) is almost entirely quota backoff, **not** real
inference speed — Groq's own listing puts this model at ~450 tok/s.
`groq-qwen38.ts` parses Groq's `"try again in Xs"` hint and sleeps exactly
that instead of guessing a blind exponential backoff, which is what made
the fluid-blank run tractable serially.

**Clean transform-blank latency** (`speed-probe-qwen38.ts` — same production
`TransformBlankSource`, 4 representative cases, 65s gap before every call so
the quota is always fresh and zero backoff contaminates the timing):

```
Case          maxThinking=on   maxThinking=off   delta
literal-1     1085ms           1159ms            +74ms
long-A1       1523ms            910ms            -613ms
tone-1        1155ms            525ms            -630ms
format-1       890ms            728ms             -162ms
Avg:            1163ms            831ms
```

So the real speed is **fast** — sub-1.5s, competitive with the matrix's
faster rows (cerebras 331–727ms, groq gpt-oss-120b 727ms, claude-haiku
1125ms) — not the ~9s the two zero-wait samples in the contaminated
`--parallel 1` run suggested (that was too small an n to trust, and it
wasn't). `maxThinking: off` (`reasoning_effort: 'none'` for this
Groq-unlisted model, vs production's default `'low'`) is **~29% faster on
average** (831ms vs 1163ms) with no observed output difference on 3/4
cases and the same imperfect answer on the 4th (`tone-1` under- or
over-shoots the confident rewrite either way) — worth trying
`max-thinking: off` in `OPENCUES.md` if this model ships to production.
Re-run `bash tests/benchmarks/transform-blank/run-speed-probe.sh`
(`--gap-ms N` to adjust spacing) to extend this to more cases.

**Not yet done:** the full 487-case transform-blank suite (would take
hours at this quota), a 5-provider-style multi-mode matrix, and measured
(non-estimated) cost. Re-run `bash
tests/benchmarks/transform-blank/run-qwen38.sh` /
`tests/benchmarks/fluid-blank/run-qwen38.sh` once Groq raises this model
out of preview tier (or grants a higher-TPM key) to get the full picture.

---

## Thinking-budget grid — which reasoning level fits which pipeline

**Source:** [`tests/results/thinking-budget-2026-05-18-maxtokens-2048.md`](../results/thinking-budget-2026-05-18-maxtokens-2048.md)
(MAX_TOKENS=2048 run; replaces the initial 512-token run which showed
a `gpt-oss · high` accuracy collapse since proven to be pure budget
starvation).

40-case fluid-blank stride sample, single trial per cell, p50 latency.

Cell colour:
- 🟢 = on-target latency AND ≥ 90 % accuracy
- 🟡 = on-target latency BUT accuracy < 90 % (inaccurate-but-fast)
- 🔴 = OVER latency (any amount; accuracy is irrelevant once we miss the deadline)
- ⚪ = provider rejected / produced empty output

Latency targets: word-cue ≤ 500 ms · fluid-blank ≤ 1500 ms · transform ≤ 1000 ms.

```
                       p50    word-cue   fluid-blank  transform
                              (≤500ms)   (≤1500ms)    (≤1000ms)
                       ───    ────────   ─────────    ─────────
groq      · none         0    ⚪          ⚪           ⚪         (gpt-oss rejects 'none')
groq      · low        834    🔴          🟢           🟢
groq      · medium    1668    🔴          🔴           🔴
groq      · high      3685    🔴          🔴           🔴         ← acc 95% but 3.7× over transform target

cerebras  · none       187    ⚪          ⚪           ⚪         (returns empty)
cerebras  · low        244    🟢          🟢           🟢         ★
cerebras  · medium     329    🟢          🟢           🟢         ★ wins every pipeline
cerebras  · high       529    🔴          🟢           🟢         ← over word-cue target by 29ms

gemini    · none       502    🔴          🟢           🟢         (over word-cue by 2ms — knife edge)
gemini    · low        787    🔴          🟢           🟢
gemini    · medium     795    🔴          🟢           🟢         (API maps medium→low)
gemini    · high      1557    🔴          🔴           🔴

openai    · none       742    🔴          🟢           🟢         (maps to 'minimal')
openai    · low       1040    🔴          🟢           🔴         (over transform by 40ms)
openai    · medium    1953    🔴          🔴           🔴
openai    · high      1928    🔴          🔴           🔴         (p95 12.7s)
```

**Note: no 🟡 cells in this run** — the accuracy floor is 93 % across
every reasoning level after the MAX_TOKENS=2048 fix, so latency is
always the disqualifier when a cell fails. 🟡 stays in the legend as
the slot for future cells that come in fast-but-inaccurate (e.g. if
we re-add small-model variants like gpt-5.4-nano).

**Reading the grid:**

- **Reds dominate the word-cue column.** Only Cerebras (low / medium)
  hits 🟢 there. Everyone else — including Cerebras at `high` (529ms,
  29ms over) — misses the 500ms bar by some margin. The word-cue
  surface is the strictest budget and the most selective.
- **Cerebras at low / medium is the ONLY provider × reasoning combo
  with all three cells green.** Every other row gives up at least
  one pipeline. The cerebras-high row stays green on fluid + transform
  (529ms fits both 1500ms and 1000ms targets) but goes red on
  word-cue.
- **The 1000ms transform target makes Cerebras structural, not
  preferred.** At the old 3000ms target, every provider had at least
  one viable transform configuration. At 1000ms:
  - groq: only `low` fits (834ms) — every other level red
  - gemini: low / medium fit (787-795ms) — high red
  - openai: only `none` fits (742ms) — every reasoning level red, low misses by 40ms
  - cerebras: every level except `none` fits — including `high` at 529ms ★
- **Per-provider knee** — max reasoning where the provider hits 🟢 on every pipeline:

  | Provider | Word-cue | Fluid-blank | Transform |
  |---|---|---|---|
  | **cerebras** | medium | high | **high** ★ |
  | groq | — (no level fits) | low | low |
  | gemini | — | medium | medium |
  | openai | — | low | none only (low misses transform by 40ms) |

- **Gemini-none at 502ms is the closest near-miss.** 2ms over the
  word-cue target. Re-running with `parallel=4` (less queue contention)
  would likely tip it green; could be worth a follow-up bench.

---

## Optional-feature benches — headline numbers

These features each ship with their own bench under
`tests/benchmarks/<feature>/`. All are off-by-default opt-ins;
all were validated across 5 providers before shipping.

### Fluid-config (semantic `_` → settings change)

**Bench:** 61 in-prompt cases + 34 holdout cases × 5 providers ×
2 suites = **210 reject decisions and 165 hit decisions**.

| Provider | In-prompt | Holdout (recall) | Holdout (precision) | Latency (HO) |
|---|---|---|---|---|
| gemini-flash-lite | 100% | **100%** | 100% | 491 ms |
| groq gpt-oss-120b | 100% | 95% | 100% | **251 ms** |
| cerebras gpt-oss-120b | 100% | 95% | 100% | 248 ms |
| openai-nano | 100% | 95% | 100% | 845 ms |
| claude-haiku-4-5 | 100% | 90% | 100% | 848 ms |

**Trust-boundary metric:** precision (reject → NONE) is **100% across
all 210 reject decisions**. Zero false positives means routing
"capital of france _" or "make it louder _" never mis-flips a
setting. Recall ≥ 80% target met by every provider; 90-100% range.
Full table: [`fluid-config/EXPERIMENTS.md`](fluid-config/EXPERIMENTS.md).

### Sentence-cues (sentence-scope alternatives)

**Bench:** 30 cases × 6 buckets (clean-informal, fuzzy-informal,
already-formal, multi-sentence, edge-short, edge-technical) ×
5 providers. Default cue: `more-formal`.

| Provider | Precision (CEDE) | Recall (MORE_FORMAL) | Avg latency |
|---|---|---|---|
| groq gpt-oss-120b | 100% | **100%** | 387 ms |
| cerebras gpt-oss-120b | 100% | 95.7% | **247 ms** |
| gemini-flash-lite | 100% | 95.7% | 628 ms |
| claude-haiku-4-5 | 100% | 91.3% | 1107 ms |
| openai-nano | 100% | 91.3% | 1347 ms |

Same trust property as fluid-config: 100% precision across all
30 reject decisions × 5 providers (150 total, zero false positives).
Full table: [`sentence-cues/EXPERIMENTS.md`](sentence-cues/EXPERIMENTS.md).

### User-context (sentinel-token PII handling)

**Bench:** 32 standard + 10 multi-sentinel (up to 16 tokens per
answer) × 5 providers.

| Provider | Raw pass (standard) | Buffer-safe after PP | Multi (10 cases × 64 slots) | Avg latency |
|---|---|---|---|---|
| cerebras gpt-oss-120b | 32/32 (100%) | **32/32** | 10/10 + 64/64 slots | **276 ms** |
| groq gpt-oss-120b | 32/32 | 32/32 | 10/10 + 64/64 | 407 ms |
| openai gpt-5.4-nano | 32/32 | 32/32 | 10/10 + 64/64 | 1267 ms |
| gemini-flash-lite | 31/32 | **32/32** (PP fixed 1) | 10/10 + 64/64 | 569 ms |
| claude-haiku-4-5 | 30/32 | **32/32** (PP stripped 2 hallucinations) | 10/10 + 64/64 | 781 ms |

**Headline:** the 90-line post-processor turns every model's output
into 100% buffer-safe text. Zero PII leaks across the entire suite.
Full doc: [`user-context/FINDINGS.md`](user-context/FINDINGS.md).

### Fluid-blank-ambient (field-aware lookup)

**Bench:** 137 standard + 18 in-prompt + 21 held-out across three
classes (`ambient-helps`, `ambient-neutral`, `ambient-anti`).

Drives the production `FUSED_SYSTEM_PROMPT` from
`@opencues/core/src/sources/fluid-blank-source.ts` to validate
that the field's label/placeholder/page-title disambiguates
`paris _` → `CDG` on an Airport-code field WITHOUT degrading
the unambiguous baseline (`paris _` on a generic field still →
`Paris`).

**Target:** 175/176 or better on cerebras-gpt-oss. Re-run after any
edit to `FUSED_SYSTEM_PROMPT` or `renderAmbientBlock`. Full bench:
[`fluid-blank-ambient/`](fluid-blank-ambient/).

### Agent-rewrite (continuous cadence-driven rewrite)

Not a numeric-acc bench — covers the cadence-driven rewrite +
three-way merge that lets the agent run while the user types.
27 word-diff unit tests + 13 live-typing scenarios + 33
end-to-end integration tests. Full state:
[`agent-rewrite/CONTINUE.md`](agent-rewrite/CONTINUE.md).

---

## When to pick which

### Production defaults (today)

| Pipeline | Provider × mode | Acc | Latency | $/correct |
|---|---|---|---|---|
| transform-blank | groq gpt-oss · 3-pass | 91.8% | 1.5s | $0.84 |
| fluid-blank | **cerebras gpt-oss · fused** | **100%** | **0.3s** | **$0.38** |
| fluid-config | auto (groq/cerebras chain) · single-call | 95-100% | ~250 ms | n/a (rejects cheap) |
| sentence-cues | auto (groq/cerebras chain) · fused | 91-100% | ~250-400 ms | n/a |
| user-context | inherits global · fused | 100% buffer-safe | ~276-1267 ms | n/a |

### Reasoning level — stay on `low` everywhere by default

`reasoning-effort: 'low'` is the global default — the thinking-budget
bench shows accuracy saturates at `low` for short-output pipelines.
Two exceptions: cerebras can afford `medium` if you want the
accuracy headroom (and is still <500ms on word-cue), and openai
gpt-5.4-mini scales to `high` cleanly on transform-blank (95% acc).

### Mode toggles to expose

| Toggle | Pipeline | Provider × mode | Use case |
|---|---|---|---|
| `transform-blank-mode: cheap` | transform-blank | groq · fused | Batch / agentic / cost-sensitive — 80.5% acc at $0.32/correct |
| `transform-blank-mode: fast` | transform-blank | gemini · single-call | Interactive UX — 89.2% acc at 729ms |

### Don't ship

| Config | Why |
|---|---|
| Claude haiku (any mode, either main bench) | 3–10× more expensive than groq/gemini for marginal accuracy gain |
| Cerebras gpt-oss on transform-blank | Word-choice quality drift — 13pp behind Groq's gpt-oss-120b on the rewrite task |
| OpenAI gpt-5.4-nano (any mode, either main bench) | Reasoning model wastes budget on every short-output task; max 76.6% acc |
| `reasoning: high` on gpt-oss with default `max_tokens` (512) | Acc collapses to 20% — reasoning tokens consume the budget. Fix: pair with `max_tokens ≥ 1024`. Already done in commit `132fd3d`. See thinking-budget 2048-token re-run for the recovery (20% → 95-98%). |
| `reasoning: medium` on fluid-blank with `low` available | Word-cue / inline UX takes the latency hit for no acc gain |
| Fused-verify (any provider except groq) | Verify prompt tuned to gpt-oss failure modes; net-hurts every other model |
| classified (fluid-blank, any provider) | Strictly dominated by `fused` on every axis |

---

## Cerebras vs Groq head-to-head on `fused` (5 reps each)

```
Bench       Provider    Acc %          Per-case ms      Wall s        Reps
─────────────────────────────────────────────────────────────────────────
transform   groq        84.30 ±1.29    595 ±32          20.18 ±1.11   5
transform   cerebras    80.80 ±0.27    335 ±6           13.12 ±0.28   5
fluid       groq        99.12 ±0.63    762 ±37          14.28 ±0.75   5
fluid       cerebras    99.72 ±0.38    265 ±17          4.98  ±0.41   5
```

- **Cerebras `fused` is 1.8–3× faster than Groq `fused`** on both
  benches. Per-case latency intervals (mean ± 2σ) do not overlap on
  either bench — the gap is statistically overwhelming, not noise.
- **Cerebras has 2-5× tighter latency variance** (±6ms vs ±32ms on
  transform; ±17ms vs ±37ms on fluid). Predictability matters for
  interactive UX where p99 latency drives perceived snappiness.
- **Fluid-blank: pure win.** Cerebras matches accuracy (99.7 vs 99.1)
  AND is 2.9× faster. No tradeoff.
- **Transform-blank: speed-vs-accuracy trade.** 1.8× faster but 3.5pp
  less accurate. Defensible for fast-mode toggle, not as default.

---

## Cross-bench findings

1. **"Fewer-but-fatter calls beat more calls" is real but
   task-coupled.**
   - On fluid-blank (easy short-output task): fused wins on every
     provider that can produce usable output.
   - On transform-blank (hard rewrite task): fused wins on Gemini /
     Claude, loses to 3-pass on Groq gpt-oss.
   - On fluid-config + sentence-cues (medium-output, bounded codomain):
     single fused call hits 100% precision across all 5 providers.
   - **Rule of thumb:** the smaller the model and harder the task,
     the more scaffolding helps. The larger the model and easier the
     task, the more scaffolding hurts.

2. **"Same model name" doesn't mean "same output quality" across
   providers.** Cerebras's gpt-oss-120b is 13pp behind Groq's on the
   rewrite task but ties Groq on fluid-blank. Quantization / sampler
   defaults / inference-stack drift leak into output quality and only
   show up on tasks that tax word-choice precision.

3. **Pipeline shape is model-class-coded, not universal.** A pipeline
   tuned to one model embeds that model's failure modes.
   - Multi-pass scaffolding suits gpt-oss-class models.
   - Single-call suits general capable models (Gemini / Claude).
   - Reasoning models (gpt-5.4-nano) want one big budget per call —
     multi-pass starves them.

4. **Layered verify nets out negative across providers.** The VERIFY
   pass was tuned to gpt-oss's failure modes; on every other provider
   it "corrects" valid drafts into worse outputs. Cerebras fused-verify
   was the worst (76.2 → 47.6%, −28.6pp).

5. **Cost-per-correct is the right pick metric, not $/1K.** A cheap
   model that's only 30% accurate costs more per usable output than a
   moderately-priced model at 90%. Always compute `$/1K ÷ accuracy`
   before picking from a price-per-token leaderboard.

6. **Self-judging inflates accuracy ~5pp.** Both numeric pipelines
   pin the LLM judge to Groq gpt-oss-120b regardless of inference
   provider. Cross-provider A/Bs must use one fixed judge or the
   comparison is meaningless.

7. **(NEW)** **Bounded-codomain tasks are precision-trivial across
   providers.** Both fluid-config (classify to FEATURES registry
   scalar+value) and sentence-cues (cede vs rewrite) hit 100%
   precision on every provider — the LLM's job is constrained
   enough that even small models don't hallucinate the schema. The
   load-bearing design choice is keeping the codomain bounded
   (validators reject hallucinated outputs at the runtime layer too).

8. **(NEW)** **`reasoning: high` on small models needs paired
   `max_tokens`.** The initial 512-token thinking-budget run showed
   a catastrophic 98% → 20% accuracy collapse on gpt-oss-120b at high
   reasoning. Re-running with 2048 tokens recovered to 95-98% — the
   collapse was 100% budget starvation (reasoning tokens consumed the
   entire output budget), not model failure. The right pattern is
   pairing reasoning-effort changes with proportional `max_tokens`
   headroom, which commit `132fd3d` codifies per-provider in
   production. Standalone "high is broken" is wrong; "high without
   matched budget is broken" is right.

9. **(NEW)** **Cerebras's per-token throughput buys reasoning
   headroom no other provider has.** Cerebras at `medium` reasoning
   still fits inside the 500 ms word-cue budget — the only provider
   that does. The structural argument for routing OpenCues's
   reasoning-friendly surfaces to Cerebras isn't "Cerebras is
   smarter", it's "Cerebras is fast enough to use reasoning where
   nobody else is".

---

## Open follow-ups (cross-bench)

1. **Real token accounting.** Instrument `chat()` to capture
   `response.usage.{prompt_tokens, completion_tokens}` and write to
   each per-case log line. Replaces all $/1K estimates with
   measurements. Especially fixes OpenAI's 2-4× reasoning-token
   undercount.
2. **Variance bands.** ≥5 repetitions per row to compute mean/stddev
   of accuracy and latency. Done for cerebras-vs-groq `fused` on
   both main benches (see `tests/results/cerebras-vs-groq-fused/`);
   extend to the new features.
3. **Per-pipeline provider routing in runtime.** Today's runtime
   supports per-feature overrides
   (`fluid-blank-provider`, `transform-blank-provider`,
   `fluid-config-provider`, `sentence-cues-provider`,
   `agent-provider`) but the auto-route picks the same provider for
   everything. Letting it pick Cerebras for fluid-blank and Groq for
   transform-blank automatically would be a real UX win.
4. **Auto-pick.** Given a user's network speed and budget, the
   runtime could pick mode + reasoning level automatically. The
   thinking-budget grid + the existing per-feature bench gates give
   the signal. Out of scope for now but worth a sketch.
5. **Re-tune VERIFY per provider** (or per model class). The current
   prompt is gpt-oss-shaped. If we want a verify step in a generalist-
   model pipeline, it needs different instructions.
6. **(NEW)** **Sentence-cues holdout suite.** Today's 30-case bench
   is in-prompt only. Mirror fluid-config's `cases-holdout.ts`
   pattern to validate generalisation honestly.
7. **(NEW)** **Multi-sentence-cue handling.** v1 caps at one
   sentence-cue per resolve to avoid word-index shift cascading.
   v2 plan: reverse-span-order application or single-batched splice.
   Currently logged in `docs/architecture/sentence-cues.md` § v1
   limitations.

### Resolved this session

- ✅ **Re-run thinking-budget with `maxTokens: 2048`** — confirmed the
  gpt-oss `high` accuracy collapse was 100% budget starvation. Recovery:
  20% → 95-98% across both gpt-oss providers. Full numbers in
  [`tests/results/thinking-budget-2026-05-18-maxtokens-2048.md`](../results/thinking-budget-2026-05-18-maxtokens-2048.md).
  Production already paired per-provider reasoning defaults with
  max_tokens bumps in commit `132fd3d`.

---

## Historical context — Cuescore replay (Feb 2026 → May 2026)

An older "cuescore" benchmark from Feb 18, 2026 (raw logs in
`tests/results/cerebras-120b-20260218-173230.txt` etc.) ran math +
factual + grammar cases through gpt-oss-120b via Groq and Cerebras.
The original harness depended on a now-deleted external script;
the cases themselves were ported into
`tests/benchmarks/fluid-blank/cases-{math,factual}-bench.ts`.

Replaying the math + factual portion on May 16, 2026:

```
                    Feb 2026 acc   May 2026 acc   Δ          Feb→May latency
─────────────────────────────────────────────────────────────────────────────
groq    gpt-oss     73.5%          99.2%         +25.7pp    489ms → 1148ms
cerebras gpt-oss    64.0%          99.2%         +35.2pp    1687ms →  526ms (3.2× faster)
```

**The Feb and May benchmarks are NOT directly comparable.** Settings
deltas explain most of the gap (temperature 0.3 → 0.0, reasoning
default → 'low', sequential → parallel=8, free-form prompts →
structured-output prompts, etc.). The opencues-side changes account
for most of the accuracy delta; Cerebras's 3.2× latency drop IS
real provider improvement (pipeline changes can only add latency).
Full caveats: see commit `e96c4b2`'s log + `tests/results/cuescore-replay/`.

---

*Last updated: 2026-05-18.*
