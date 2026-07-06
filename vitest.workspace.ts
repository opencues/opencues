import { defineWorkspace } from 'vitest/config';

// Repo-root vitest workspace. Each entry points at a package whose
// own vitest.config.ts owns its environment + include glob:
//
//   - integrations/chrome uses jsdom (DOM tests)
//   - integrations/claude-code/tweakcc uses node + globals: true
//   - packages/opencues-runtime uses node
//   - packages/opencues-core's config explicitly lists the vitest-
//     style tests so the package's node:test files don't get loaded
//     by vitest (they run via `npm test` → `node --test dist/...`)
//
// With this workspace, `npx vitest run` from the repo root runs every
// vitest suite with the right env per package — no environment
// mismatches, no .claude/worktrees/ noise (workspace doesn't recurse
// into anything outside this list), no node:test loader errors.
//
// `pnpm test` / `turbo run test` still works exactly as before
// (each package's own `test` script), so this is purely additive —
// it just makes the root vitest run work too.
export default defineWorkspace([
  'packages/opencues-core',
  'packages/opencues-runtime',
  'integrations/apple-notes',
  'integrations/chrome',
  'integrations/claude-code/tweakcc',
]);
