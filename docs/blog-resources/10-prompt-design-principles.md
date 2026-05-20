# 10 — Prompt Design Principles

Cross-cutting LLM-engineering lessons learned from the OpenCues codebase.
Useful for any blog post that touches LLM reliability, including #5
(Inline Agents), #11 (HAII), and #18 (Principles of HCI).

Source: `docs/prompt-design-learnings.md` (top-level principles) +
`docs/architecture/transform-blank.md` § "Lessons learned" + benchmark
experiment logs.

## Core principle: narrow jobs > wide jobs

This is the headline. From `docs/architecture/transform-blank.md`:

> The 3-pass split outperforms single-call by ~70 percentage points. Even
> with the same model and total token budget, splitting "is this a transform
> / what's the instruction / apply it / check it" into separate prompts
> gets dramatically better results than asking one prompt to do all four.

The 3-pass transform-blank pipeline is the strongest example. Empirical
data:

| Architecture | Accuracy | Latency |
|---|---|---|
| Single-call (everything in one prompt) | 19% | 0.5s |
| 1-pass rewrite | 46% | 0.6s |
| 2-pass extract → apply | 83% | 1.1s |
| **3-pass extract → apply → verify** | **86-90%** | **1.4-1.7s** |

The same insight applies *inside* a single phase too — see "Sequential
composition" below.

## Sequential composition: one transform at a time

From transform-blank: when the user writes "make past tense AND remove
pronouns", asking ONE APPLY call to do both at once dropped accuracy to
47%. Splitting into two sequential APPLY calls (output of N feeds target
of N+1) jumped it to 73%.

> The model handles ONE transform at a time much better than two — same
> "narrow jobs" insight at one level deeper.

## Output tokens dominate latency

From `docs/prompt-design-learnings.md`:

> Input prompt size has minimal impact on latency. A 320-line prompt runs
> at similar speed to a 60-line prompt if they produce similar output
> lengths.
>
> **Why:** LLMs process input tokens in parallel but generate output tokens
> sequentially. A long prompt with short output is faster than a short
> prompt with long output.
>
> **Implication:** Don't over-optimize input size. Focus on output
> efficiency.

This was concretely re-validated in agent-task: the EDITS format (only
emit edits) beat DECISIONS (one verdict per candidate, KEEP or edit) on
every dimension. EDITS won 97-100% vs 93-97% pass rate, ran 30% faster,
and was 5× faster on 200-word docs.

> Why DECISIONS lost: at high candidate counts the model spent its output
> budget reciting `<idx> | <word> | KEEP` lines and ran out of tokens
> before reaching real edits.

## Minimal prompts win at classification, verbose at execution

The most non-obvious lesson, from the transform-blank Experiment 2:

> EXTRACT got 7 percentage points better when stripped to one semantic
> question. APPLY got 2 percentage points worse and 200ms slower when
> stripped. The difference: classification benefits from openness;
> execution benefits from explicit rules.

EXTRACT's job is "is this a transform? what's the instruction? what's the
target?" — three open questions. The first version had 200 lines of rules
and 18 examples. The model treated this as an exclusionary filter, bailing
to NONE on borderline cases that didn't match a listed shape. The minimal
prompt asks ONE semantic question and the model answers it more accurately.

APPLY's job is "rewrite this text per this instruction." That benefits
from explicit rules (CONCEPT-SWAP PROPAGATION, ROLE PRESERVATION,
COMPOSED INSTRUCTIONS, PRESERVE STRUCTURE, CONDITIONAL INSTRUCTIONS).
~25 worked examples. Stripping them HURT accuracy and INCREASED latency
(model thinks harder without explicit guidance).

## Verifier role: defect catcher, not stylist

The single most important sentence in the VERIFY prompt:

> "DEFAULT TO OK. Only output REPAIR when you can name a SPECIFIC,
> IDENTIFIABLE defect. If the draft looks fine — even if you could rephrase
> it more elegantly — output OK and pass it through. Stylistic improvement
> is NOT your job. You are a defect catcher, not a writer."

Without this rule, VERIFY was over-editing valid drafts. APPLY would
produce a clean rewrite, VERIFY would decide it could rephrase more
elegantly, and the "improved" rewrite was often wrong (added prose, mangled
structure mid-paragraph).

Plus a code-level safety net: when verdict is OK, **pass through the
draft, NOT verify's echo**:

```ts
finalRewrite = ver.verdict === 'OK' ? draft : ver.rewrite;
```

VERIFY occasionally emits a slightly different rewrite even when verdict
is OK (model adds a period, swaps "the" for "a"). The runtime ignores it.

## Reserve reasoning headroom in max_tokens

From transform-blank lesson #4:

> When using `reasoning_effort: 'low'`, a too-tight max_tokens truncates
> the model mid-output (it ran out of budget partway through emitting).
> FLOOR=768 is the safe minimum for short outputs, even if the actual
> output is 50 tokens.

A previous version used FLOOR=128 — long-text cases truncated mid-output
and accuracy dropped 85% → 50%.

Formula:
```
budget = max(FLOOR=768, ceil(input_chars / 3) + REASONING_HEADROOM=400)
```

## Skip-rules need semantic gates, not structural ones

From transform-blank lesson #6:

> A rule like "skip VERIFY when output length is ±15% of input" misses the
> point — even short single-line outputs can have agreement bugs. The
> right axis is "is the instruction MECHANICALLY unambiguous" (literal
> swap, deterministic spelling change).

Concrete: the deployed `skip-conservative` rule skips VERIFY when ALL hold:
- draft length within ±15% of target
- no `\n\n` in target/draft
- single instruction (no `|`)
- instruction matches one of:
  - **literal swap**: `change|replace|swap|rename A to|with|for B`
  - **BrE↔AmE**: `make it (british|american) english`

Adding case changes or simple tense to this list (the previous deployment)
HURT accuracy by 2.3pp.

## Always-claim + LLM classifier > heuristic gating

From transform-blank lesson #8:

> We tried a regex/keyword heuristic in `supports()` to avoid extra LLM
> calls. It was brittle (missed "full caps", "fullcaps", `make me a
> website` was wrongly classified). Always claiming + letting EXTRACT
> decide via NONE bail is cleaner — the cost is one extra ~400ms call per
> non-transform `_`.

The cleanliness gain outweighs the latency cost. Heuristic gating
*always* drifts from intent.

## Soft-fail rate limits and parse errors

From transform-blank lesson #9:

> One bad response shouldn't kill a batch run or a user session. Catch in
> the client, return empty, let the caller's parser treat it as a bail.

Concrete: Groq sometimes returns
`{"error": {"message": "Parsing failed..."}}`. Swallow it in the client.
Return empty text. Caller's parser sees empty and bails. The next text-
change debounce is the implicit retry.

In agent-task, this is wired as **no retry loop inside `runOnce`** — just
return empty edits + log. Compounding rate-limit failures inside a single
trigger would make a bad situation worse.

## Test variance, not just averages

From `docs/prompt-design-learnings.md`:

> A minimal prompt may average well in benchmarks but have high variance
> between runs. A slightly larger prompt with explicit guidance can produce
> more consistent results.

For UX, consistency matters more than peak performance. A prompt that
works 100% on benchmarks but 50% in production is worse than one that
works 80% in both.

## Single-line field parsers: `[ \t]*` not `\s*`

From transform-blank lesson #5:

> `\s*` matches newlines, which lets a lazy `.*?` accidentally capture
> the next field's label as the current field's value. Use horizontal-
> whitespace-only.

Concrete bug: model emits

```
VERDICT: NONE
INSTRUCTION:
TARGET:
```

The `\s*` matched the newline AND "TARGET:". The lazy `.*?` extended
across lines, captured `TARGET:` as the instruction value. Fixed with
`[ \t]*`.

This is a parser pitfall worth quoting in a "war stories" section.

## Document each design decision with the experiment that justifies it

Lesson #10 from transform-blank:

> When the next person (or future-you) asks "why didn't we just do X?",
> the answer should be `tests/benchmarks/transform-blank/EXPERIMENTS.md,
> Experiment N`.

The presence of an EXPERIMENTS.md file alongside each LLM pipeline is
itself an HCI choice — for the *developers* of the system. It keeps
"why" knowable across maintenance.

## Apply-side defence in depth

From `docs/architecture/agent-task.md`:

> The model occasionally proposes edits OUTSIDE the candidate list (cache-
> hit indices, owned indices, cursor-adjacent). The apply loop re-checks
> `candidateSet.has(edit.wordIndex)` AND re-fetches live text to verify
> `liveWord.word === edit.originalWord`.

LLMs hallucinate edits to indices they weren't asked about. The runtime
doesn't trust the model's word indices — it re-validates them at apply
time.

## The HCI angle (when used in a blog)

These are *engineering* lessons but they have HCI consequences:

1. **Latency is felt by the user.** Output-tokens-dominate-latency means
   prompt design directly shapes UX. Long outputs feel slow.
2. **Variance is felt by the user too.** The user remembers the one time
   the system gave a weird answer; consistency matters.
3. **Pipeline visibility (debug logs, EXPERIMENTS.md) is for the developer's
   flow state.** When you're tuning, you need to see which phase failed.
4. **Soft-fail keeps trust.** A user session that crashes on rate limit
   feels broken. One that quietly skips a debounce cycle and tries again
   feels alive.

## Where this material lives

- `docs/prompt-design-learnings.md` — the canonical 3-principle file
- `docs/architecture/transform-blank.md` § "Lessons learned" — 10 ranked
  insights
- `docs/architecture/agent-task.md` § "Implementation outcomes" — the
  EDITS format + defensive parse + apply-side validation
- `tests/benchmarks/transform-blank/EXPERIMENTS.md` — empirical foundation
- `tests/benchmarks/agent-task/EXPERIMENTS.md` — same for agent-task

## Quotable lines

- "Narrow jobs are easier than wide jobs."
- "Output tokens dominate latency."
- "Minimal prompts win at classification; verbose prompts win at execution."
- "Defect catcher, not writer."
- "Always-claim + LLM classifier beats heuristic gating."
- "Test variance, not just averages."
- "One bad response shouldn't kill a session."
