# Token-integration stage — plan

**Status**: planned, not started. Read top-to-bottom; everything you need to start is here.

This doc covers a single feature: replace today's hardcoded WIPE/FILL regex + post-hoc polish step with one **LLM-owned post-token-resolution stage** that decides what part of the buffer to replace AND what to replace it with, in a single language-invariant call.

The change applies **only when a catalog token (`[TOKEN]`) was resolved** in the FUSED FluidBlank answer. Bare factual answers (no token) skip this stage entirely — the source LLM's response lands verbatim. BlankFill's polish path migrates to the same stage in a follow-up once validation is solid.

---

## Why this exists

Today's flow has two decisions that can disagree:

1. **FUSED LLM** identifies a `SPAN` (lookup-phrase substring) and emits an `ANSWER` that may contain `[TOKEN]` placeholders.
2. **`determineReplaceMode` regex** at `fluid-blank-source.ts:438` decides FILL vs WIPE based on whether the chars before `_` match `\b(?:is|are|was|were|am|be|equals)\b|=|:|\?`.

That regex is anglocentric, brittle, and runs AFTER the LLM has already understood intent. It rejects `nvda is at _` as WIPE (because `at` isn't `is`), strips the user's question, and lands `NVDA: $212.45` where the user expected `nvda is at $212.45`.

The polish pass added in June 2026 tried to compensate (drop labels, match precision) but inherited the same mode confusion. Polish in WIPE mode either ran with wrong context or got skipped, depending on which fix was current.

The structural fix: **let the LLM decide what to replace and what to replace it with**, in one call, with full visibility of (a) the user's buffer and (b) the post-processed substitute. No regex. No second-guessing.

---

## Design

### Pipeline

```
User types:  "whats nvida stock price _"
              │
              ▼
  FUSED FluidBlank call (UNCHANGED — same prompt, same schema, same bench)
              │   returns SPAN + ANSWER containing `[STOCK NVDA]`
              ▼
  Post-processor resolves catalog tokens → real values
              │   produces SUBSTITUTE = "NVDA: $212.45"
              ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  NEW: Token-integration stage                                    │
  │                                                                  │
  │  Inputs:                                                         │
  │    BUFFER: "whats nvida stock price _"                           │
  │    SUBSTITUTE: "NVDA: $212.45"                                   │
  │  Outputs:                                                        │
  │    REPLACE: "whats nvida stock price _"                          │
  │    WITH:    "$212.45"                                            │
  └──────────────────────────────────────────────────────────────────┘
              │
              ▼
  Runtime: buffer = buffer.replace(REPLACE, WITH)
              │
              ▼
  Final: "$212.45"
```

### Schema — substring-based, not char-index

The integration LLM emits two strings:

```
REPLACE: <verbatim substring of BUFFER that must include `_`>
WITH:    <text to splice in REPLACE's place>
```

Substring chosen over `[startIdx, endIdx]` because:
- LLMs are far more reliable at producing verbatim substrings than char offsets
- Validation is one `String.indexOf` — cheap and unambiguous
- Diff-safe: if BUFFER and REPLACE disagree on whitespace/punctuation, validation catches it before the splice

### Validation + fallback

Runtime validates the LLM output:

1. `BUFFER.indexOf(REPLACE) >= 0` — REPLACE must appear verbatim in BUFFER.
2. `REPLACE.includes('_')` — REPLACE must contain the user's `_`.

If either fails → **fallback**: replace just `_` with the raw `SUBSTITUTE`, ignoring the integration LLM's output. Telemetry logs the failure mode (with REPLACE truncated) so we can see how often the LLM goes wrong.

This is the same shape as TransformBlank's "if LLM output looks corrupted, splice the raw" backstop. Pattern proven over a year of shipping.

### When the stage fires

Gate (mirrors today's polish gate):

- A runner is wired (boot-common attached one), AND
- The post-processor resolved at least one catalog sentinel (`resolvedSentinelCount > 0`).

Bare factual lookups (`capital of france _`, `population of france _`, `atomic number of oxygen _`) — no `[TOKEN]` resolved — skip the stage entirely. The FUSED LLM's answer lands as-is, with whatever shape it picked.

### Prompt design (sketch)

```
SYSTEM:
You decide how a tool-resolved value should be integrated into a user's buffer. You receive:
  BUFFER: the user's text containing an underscore (`_`)
  SUBSTITUTE: the data the runtime resolved from a catalog token in a prior LLM call

Decide:
  REPLACE: which substring of BUFFER should be replaced (must include `_`)
  WITH:    the text that goes in its place

Think about the buffer's intent:
- Sentence with a slot ("NVDA is at _", "the price is _") → REPLACE = "_", WITH = just the value
- Lookup question ("whats X price _", "capital of france _") → REPLACE = the whole question, WITH = just the answer
- Conversational continuation ("Tell me about NVDA — _") → REPLACE = "_", WITH might be a longer phrase

Then fit SUBSTITUTE naturally into the WITH:
- If BUFFER already names the entity (label "NVDA:" when the prose says "NVDA is at"), drop the redundant label
- Match precision to surrounding prose (truncate cents if prose uses whole dollars)
- Trim metadata that adds no value in the surrounding context

OUTPUT — exactly two labelled lines:
REPLACE: <verbatim substring of BUFFER including `_`>
WITH: <text to splice in>
```

Worked examples included in the prompt (3-5, covering FILL / WIPE / conversational / labelled prose cases) so the model has anchors.

---

## Implementation

### Module location

New: `packages/opencues-core/src/token-integration.ts`

Mirrors `integration-pass.ts`'s shape:
- Exports `runTokenIntegration(req, dispatch, cache) → TokenIntegrationResult`
- Same LRU cache shape
- Pure module — no provider coupling

```ts
export interface TokenIntegrationRequest {
  buffer: string;       // The user's full buffer with `_`
  substitute: string;   // The post-processed substitute (token already resolved)
  hint?: string;        // Optional per-source nudge
}

export interface TokenIntegrationResult {
  replace: string;      // Substring of buffer; falls back to "_" on validation failure
  with_: string;        // Replacement text
  reason:
    | 'cache-hit'
    | 'integrated'                // LLM ran + validated
    | 'fallback-not-substring'    // LLM REPLACE not in buffer
    | 'fallback-no-underscore'    // LLM REPLACE doesn't contain _
    | 'fallback-empty'            // LLM returned empty
    | 'fallback-dispatch-error';  // LLM call failed
  llmCalled: boolean;
}
```

### Runtime integration

`fluid-blank-source.ts` change is minimal:

```ts
// AFTER post-processor resolves tokens (existing code unchanged).
// NEW: call token-integration runner if wired + tokens were resolved.
if (this.runTokenIntegration && resolvedSentinelCount > 0) {
  const result = await this.runTokenIntegration({
    buffer: context.text,
    substitute: finalAnswer,
    hint: '...optional per-source nudge...',
  });
  // Build the CueResult using REPLACE + WITH semantics.
  // SpanStart/spanEnd come from REPLACE's position in the buffer.
  // Alternatives become ['_', WITH].
  // ...
}
```

The OLD path (`determineReplaceMode` + post-hoc polish) stays gated behind a feature flag (see § Migration) until validation confirms the new path is reliable.

### Boot wiring

`buildBlankIntegrationRunner` (in `boot-common.ts`) already builds a runner from the blanks-bucket. Add a sibling `buildTokenIntegrationRunner` that returns the new `TokenIntegrationRunner` shape. Same dispatch shim, same cache, different prompt.

Per-source plumbing (`build-sources.ts` → `FluidBlankSourceConfig`) adds `runTokenIntegration?` alongside the existing `runIntegration?`.

---

## Migration plan

### Feature flag

OPENCUES.md scalar: `fluid-blank-token-integration: smart | legacy`. Default `smart`.

- `smart` — new token-integration stage runs when tokens resolve; `determineReplaceMode` + post-hoc polish is bypassed.
- `legacy` — today's behaviour (regex + polish) preserved as the safety net.

The flag is per-installation; a user hitting a regression can flip to `legacy` in ~5 seconds without a downgrade.

### Sunset

After 2 weeks of `smart` shipping without regressions and the bench staying green:
- Remove `legacy` mode + `determineReplaceMode`.
- Polish module (`integration-pass.ts`) becomes BlankFill-only.
- Refactor merges polish + token-integration into one module if shapes align.

### Out of scope for v1

- BlankFill migration — its per-blank `integrate: true` opt-in continues to use today's polish path. Once token-integration ships clean on FluidBlank, BlankFill migrates in a follow-up using the same module + a `runTokenIntegration` injection through its own boot path.
- TransformBlank / AgentRewrite — those already do whole-buffer rewrites; they don't have the WIPE/FILL ambiguity.

---

## Bench plan

### Bench file

New: `tests/benchmarks/token-integration/run.ts` (mirrors `tests/benchmarks/identity-order/run.ts` shape).

Sweeps the same shape across:
- ~40 hand-written `(BUFFER, SUBSTITUTE)` cases covering: sentence-with-slot, lookup question, conversational continuation, labelled prose, multi-currency, no-prose-context, edge cases (substitute longer than buffer, label-only prose, etc.).
- 3 providers (cerebras, groq, claude) — the dispatch shim picks the bucket the host is configured with, so the bench follows the same routing as production.

### Metrics

Per case:
- **Validation pass rate** — did `REPLACE` appear in `BUFFER` and contain `_`? (Backstop measure.)
- **Behavioural correctness** — did the final buffer match an expected shape (regex)?
- **Style fitness** — does the polished value match prose precision / label conventions? (Qualitative; rubric in the bench README.)
- **Latency** — median + p95.
- **Cache hit rate** on repeat sweeps.

### Pre-merge gates

The bench must hit ≥ 95% validation pass + ≥ 90% behavioural correctness on cerebras gpt-oss-120b before `smart` becomes default. Below those thresholds → `smart` stays opt-in; we tune the prompt + re-bench.

---

## Agentic scenarios

Add three to `tests/agentic/scenarios/` (covers the live runtime path):

1. **88-token-integration-fill-mode.json** — type `nvda is at _`, assert final buffer is `nvda is at $...` (REPLACE = `_`).
2. **89-token-integration-lookup-mode.json** — type `whats nvda price _`, assert final buffer is `$...` (REPLACE = whole input).
3. **90-token-integration-fallback.json** — synthetic test that injects a deliberate fault in the runner (returns a non-substring REPLACE) and asserts the fallback path lands the raw substitute at `_`.

Run before/after the feature flag flip.

---

## Risks

1. **LLM picks a wrong REPLACE range** — e.g. swallows surrounding prose it shouldn't. Mitigation: substring + must-include-`_` validation catches the obvious cases; bench measures real-world rates; `legacy` flag is the user's escape hatch.

2. **Latency regression** — token-integration is a second LLM call per `[TOKEN]`-resolved substitution. Same shape as today's polish (which we'd be replacing), so net should be neutral. But if the new prompt is bigger, cache hits matter more. Cerebras prefix-cache should still hit 99% on the system prompt.

3. **Prompt drift** — the LLM's REPLACE choice could degrade across model versions. Mitigation: agentic scenarios pin behaviour; bench runs in CI weekly.

4. **Bigger output tokens** — emits `REPLACE` + `WITH` rather than a single polished string. ~50 extra output tokens per call. Cerebras output-token cost ~$0.85/M → ~$0.00004 per call. Negligible.

5. **User confusion during migration** — `smart` and `legacy` produce different buffers for the same input. Doc the difference in CHANGELOG + the OPENCUES.md scalar block.

---

## Suggested PR sequence

**PR1 — Plumbing + module + tests, no runtime change.** Create `packages/opencues-core/src/token-integration.ts` with the module, unit tests, and `buildTokenIntegrationRunner` in `boot-common.ts`. No fluid-blank integration yet. Tests: validate substring + must-include-`_` rules, LRU cache behaviour, fallback paths. ~300 LoC; standalone PR.

**PR2 — Fluid-blank integration behind feature flag.** Wire `runTokenIntegration` into `FluidBlankSource`, gate behind `fluid-blank-token-integration: smart | legacy` scalar (default `legacy` initially so the PR can land without behaviour change). Tests: unit tests for the source-side gate; agentic scenarios 88/89/90.

**PR3 — Bench + tune.** Write `tests/benchmarks/token-integration/run.ts`, gather data on cerebras / groq / claude. Tune the system prompt + integrate-hint based on bench results. Land prompt updates. ≥ 95% validation pass + ≥ 90% behavioural correctness on cerebras before progressing.

**PR4 — Flip default to `smart`.** OPENCUES.md scalar default changes from `legacy` to `smart`. CHANGELOG documents the behaviour change. `legacy` still available as a fallback for one release cycle.

**PR5 — Sunset `legacy`.** Remove `determineReplaceMode`, `EffectiveReplaceMode` for FluidBlank, and the post-hoc polish path. `fluid-blank-token-integration` scalar retired (`smart` is the only behaviour). Two weeks after PR4.

**PR6 — BlankFill migration.** BlankFill's per-blank `integrate: true` path migrates to the same token-integration runner. Same prompt, same module, just a different `SUBSTITUTE` source (script output instead of post-processed sentinel). The polish module (`integration-pass.ts`) becomes the single source of fitting truth.

Each PR is independently shippable. PR1 lands without any behavioural risk. PR2 lands behind a flag so it can stay dark until ready. PR3-4 are the real shipping moment.

---

## Upgrade path

For PR2 (flag-gated):
1. `opencues install <host>` rebuilds the bundle.
2. No user action needed — default is `legacy`, behaviour unchanged.
3. Users who want the new path early: `fluid-blank-token-integration: smart` in OPENCUES.md.

For PR4 (default flip):
1. Same auto-update.
2. Users who saw any regression: `fluid-blank-token-integration: legacy` reverts.

For PR5 (sunset):
1. Same auto-update.
2. `legacy` mode silently maps to `smart`; the scalar is no-op.

No user action required at any step. The flag gives the safety net during the transition.

---

## Open follow-ups (not for v1)

- TransformBlank's polish path could adopt the same module if a token-shaped sub-stage emerges. Today it does whole-buffer rewrites so this isn't a fit, but if `[TOKEN]` resolution gets added there, the same approach plugs in.
- AgentRewrite could use the same module on each tick's output for cadence-driven prose polish. Out of scope until the integration model is stable.
- Per-source prompt overrides: today the system prompt is one-size-fits-all. If specific blanks need very different REPLACE behaviour (e.g. a "structured-form" blank where the buffer is a labelled spreadsheet), the per-blank `integrate-hint:` is the v1 lever; a full per-source prompt override is a v2 follow-up.

---

*Last updated: 2026-06-16*
