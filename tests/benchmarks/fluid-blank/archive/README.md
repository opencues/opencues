# fluid-blank/archive

One-off probes that aren't part of the main bench harness (`run.ts`).
Kept in tree because the underlying questions can recur and the
scaffolding is non-trivial to rebuild.

- `smoke-prod-path.ts` — End-to-end smoke that drives the production
  FluidBlankSource (rather than the bench's own P1/P3 prompts).
  Useful when verifying that benchmark conclusions actually carry over
  to what users hit at runtime.
