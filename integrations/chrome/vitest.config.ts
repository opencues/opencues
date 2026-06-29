import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts'],
    // Never discover into git worktrees (`.claude/worktrees/`).
    exclude: [...configDefaults.exclude, '**/.claude/**', '**/worktrees/**'],
    globals: false,
  },
  // No resolve aliases needed — pnpm symlinks @opencues/core and
  // @opencues/runtime into node_modules via the workspace deps declared
  // in package.json. Both vitest and esbuild resolve them naturally.
});
