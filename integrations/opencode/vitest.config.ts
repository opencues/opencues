import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['plugin/**/*.test.ts', 'patches/**/*.test.ts'],
    // Never discover into git worktrees (`.claude/worktrees/`).
    exclude: [...configDefaults.exclude, '**/.claude/**', '**/worktrees/**'],
    globals: false,
  },
});
