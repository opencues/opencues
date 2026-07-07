/**
 * OPENCUES_SKIP_USER_BLANKS — the agentic-harness memory guard.
 *
 * Loading a JS user-blank (`impl: ./blank.js`) spins up an isolated-vm
 * sandbox / user-blank-runner.cjs subprocess (~54 MB resident) even for
 * shipped impl-blanks nothing invokes. The harness runs up to 16 host shards
 * in parallel and needs none of them, so it sets OPENCUES_SKIP_USER_BLANKS=1
 * to skip the whole registry build (~860 MB of dead sandbox RAM across the
 * pool). Guarded at the single chokepoint (registry.ts) so every host band +
 * the chrome-host benefits without per-bootstrap edits.
 *
 * The loader is mocked (as in registry.test.ts) so these assertions never
 * depend on a real isolated-vm / subprocess load — the point is the GUARD,
 * not the load, and mixing a real load in makes the test flaky under the
 * full suite (a sibling test's `vi.mock('./node-loader')` can otherwise leak
 * in and hand us a malformed `loaded`).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoadedUserBlank } from './node-loader';
import type { UserBlankModule } from './types';

vi.mock('./node-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./node-loader')>();
  return { ...actual, loadUserBlank: vi.fn() };
});

import { buildUserBlankRegistry, type BlankConfigLike } from './registry';
import { loadUserBlank } from './node-loader';

const mockLoad = vi.mocked(loadUserBlank);

function fakeLoaded(): LoadedUserBlank {
  return {
    module: { async get() { return 'x'; } } as UserBlankModule,
    folder: '/fake',
    capabilities: {},
    dispose: () => {},
  };
}

// impl must contain a slash (bare names are built-in lookups, skipped).
const configs: BlankConfigLike[] = [{ name: 'demo', impl: '/fake/demo-blank.js' }];

// Hermetic: restore the flag after each case (check-test-hermeticity).
const prev = process.env['OPENCUES_SKIP_USER_BLANKS'];
afterEach(() => {
  mockLoad.mockReset();
  if (prev === undefined) delete process.env['OPENCUES_SKIP_USER_BLANKS'];
  else process.env['OPENCUES_SKIP_USER_BLANKS'] = prev;
});

describe('OPENCUES_SKIP_USER_BLANKS', () => {
  it('=1 → empty registry AND the loader is never called (no sandbox spawned)', () => {
    process.env['OPENCUES_SKIP_USER_BLANKS'] = '1';
    mockLoad.mockReturnValue(fakeLoaded());
    const reg = buildUserBlankRegistry(configs, {});
    expect(reg.size).toBe(0);
    expect(mockLoad).not.toHaveBeenCalled(); // guard returns before any load
  });

  it('unset → the impl config loads (proves the flag is the discriminator)', () => {
    delete process.env['OPENCUES_SKIP_USER_BLANKS'];
    mockLoad.mockReturnValue(fakeLoaded());
    const reg = buildUserBlankRegistry(configs, {});
    expect(reg.size).toBe(1);
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });

  it('any value other than "1" does NOT skip', () => {
    process.env['OPENCUES_SKIP_USER_BLANKS'] = '0';
    mockLoad.mockReturnValue(fakeLoaded());
    expect(buildUserBlankRegistry(configs, {}).size).toBe(1);
  });
});
