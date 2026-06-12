import { defineConfig } from 'vitest/config';

// @opencues/core has TWO test runners. Most test files in this
// package were written for Node's built-in `node:test` runner
// (`import { describe, it } from 'node:test'`) — they run via
// `npm test` which is `find dist -name '*.test.js' | xargs node --test`.
// Vitest can't load those (they don't import from 'vitest'), so they
// can't be in the include glob — they'd error at the loader.
//
// A small subset is vitest-style: the registry / drift tests added
// during the May 2026 feature-registry refactor. List them
// explicitly here so `npx vitest run` from anywhere only loads the
// vitest-loadable files.
//
// To add a new vitest-style test in this package: import from
// 'vitest' AND add the file to the include glob below.
export default defineConfig({
  test: {
    globals: false,
    include: [
      'src/feature-registry.test.ts',
      'src/feature-registry-menu.drift.test.ts',
      'src/llm-provider.drift.test.ts',
      'src/llm-provider.temperature.test.ts',
      'src/llm-provider.max-thinking.test.ts',
      'src/model-thinking.test.ts',
      'src/conformance.test.ts',
      'src/sources/fluid-blank-error-substitute.test.ts',
    ],
  },
});
