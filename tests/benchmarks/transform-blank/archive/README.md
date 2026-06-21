# transform-blank/archive

Frozen historical tooling. **Not maintained, not guaranteed to typecheck
or run** (some imports point at modules that have since moved). Kept for
the experiment record; the findings live in `../EXPERIMENTS.md`.

## The retired comparative harness (June 2026)

The original benchmark was a comparative harness — `run.ts` plus its OWN
copies of every prompt shape — used to discover which pipeline won during
development. Once production picked its shapes (3-pass for groq, fused for
everyone else), those bench prompt copies **drifted** from the shipped
prompts: e.g. the bench `pass2-apply.ts` was missing the FILL PLACEHOLDER
rule production's `P2_APPLY_SYSTEM` had, so a "production" bench mode
silently measured a stale prompt.

The fix was to make the bench drive the real `TransformBlankSource` from
`@opencues/core` (no bench-local prompt) — that's `../prod.ts`, now the
single canonical transform-blank benchmark (`--mode fused|3-pass`). The
comparative harness moved here:

- `run.ts` — the old `--mode <X>` comparative driver.
- `pass1-rewrite.ts`, `pass1-extract.ts`, `pass2-apply.ts`,
  `pass3-verify.ts` — the 3-pass mode prompt copies (drifted).
- `single-call.ts`, `fused-extract-apply.ts`, `fused-full.ts` — alternative
  one-shot shapes.
- `minimal-prompts.ts` — Experiment-2 minimal ablations of P1/P2/P3.
- `latency-probe.ts` — the 7-case latency-only probe.

To benchmark a production prompt today, edit it in
`packages/opencues-core/src/sources/transform-blank-source.ts` and run
`../prod.ts` — there is no second copy to keep in sync.

## One-off probes (predate the harness retirement)

Self-contained `npx tsx <file>` probes (imports may be stale post-move):

- `apply-tune.ts` — A/B benchmark for P2 APPLY prompt variants.
- `cursor-aware.ts` — Real-LLM probe for cursor-aware "here" support.
- `deictic-resolve.ts` — Real-LLM probe for the P1.5 deictic resolver.
- `json-consistency.ts` — Probe for strict-JSON mode determinism.
- `repro-astyped-contamination.ts` — Standalone repro for the asTypedText bug.
- `repro-remove-emojis.ts` — Repro for the "remove emojis" failure mode.
