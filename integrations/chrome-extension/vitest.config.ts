import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts'],
    globals: false,
  },
  resolve: {
    alias: {
      'cues-core': new URL('../../packages/cues-core/dist/index.js', import.meta.url).pathname,
      'opencues-runtime/dist/adapters/chrome/v1/boot': new URL(
        '../../packages/opencues-runtime/dist/adapters/chrome/v1/boot.js',
        import.meta.url,
      ).pathname,
      'opencues-runtime/dist/src/adapter': new URL(
        '../../packages/opencues-runtime/dist/src/adapter.js',
        import.meta.url,
      ).pathname,
    },
  },
});
