import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    include: ['src/**/*.test.ts', 'testing/**/*.test.ts', 'adapters/**/*.test.ts'],
    // `--no-isolate` equivalent: don't reset modules between test files.
    // ~30% faster locally (14s → 10s on the 1671-test suite), ~25s off
    // CI's test step. Trade-off: tests that rely on a hot module's
    // state being freshly imported won't see that — currently all tests
    // pass without isolation, but future tests should NOT assume each
    // file starts with a clean module cache. Re-enable via CLI override
    // (`pnpm test -- --isolate`) when debugging suspected leaks.
    isolate: false,
    // `pool: 'forks'` is the SAFE default. `'threads'` is ~4x faster on
    // this suite but isolated-vm (the user-blank sandbox in
    // `node-loader.ts`) is a native C++ binding that's not thread-safe —
    // tests crash with `Assertion 'environment != nullptr' failed`.
    // `cli-inspection.test.ts` also depends on child_process semantics
    // that thread workers don't reproduce. Until both are addressed
    // (e.g. a `projects` config splitting pools per test glob, or the
    // ivm tests get a fork-only opt-out), keep this on forks.
    pool: 'forks',
  },
});
