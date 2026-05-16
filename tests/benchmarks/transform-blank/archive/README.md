# transform-blank/archive

One-off probes and tuning scripts that aren't part of the main bench
harness (`run.ts`). Kept in tree because the underlying questions can
recur and the scaffolding is non-trivial to rebuild.

Each script is self-contained — `npx tsx <file>` runs it against the
configured provider via the same `./groq` router as the main harness.

- `apply-tune.ts` — A/B benchmark for P2 APPLY prompt variants.
- `cursor-aware.ts` — Real-LLM probe for cursor-aware "here" support.
- `deictic-resolve.ts` — Real-LLM probe for the P1.5 deictic resolver.
- `json-consistency.ts` — Probe for strict-JSON mode determinism.
- `repro-astyped-contamination.ts` — Standalone repro for the asTypedText bug.
- `repro-remove-emojis.ts` — Repro for the "remove emojis" failure mode.
