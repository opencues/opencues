/**
 * OPENCUES_SKIP_USER_BLANKS — the agentic-harness memory guard.
 *
 * Loading a JS user-blank (`impl: ./blank.js`) spins up an isolated-vm
 * sandbox / subprocess-runner (~48 MB resident) even for shipped impl-blanks
 * nothing invokes. The harness runs up to 16 host shards in parallel and
 * needs none of them, so it sets OPENCUES_SKIP_USER_BLANKS=1 to skip the
 * whole registry build (~768 MB of dead sandbox RAM across the pool).
 *
 * This pins the guard at the single chokepoint (registry.ts) so every host
 * band + the chrome-host benefits without per-bootstrap edits.
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildUserBlankRegistry, type BlankConfigLike } from './registry';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skip-ub-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

// A real on-disk impl so the non-skip path actually loads (the sandbox is
// what the flag avoids) — mirrors sentinel-shadow.test.ts.
const stub = path.join(TMP, 'demo-blank.js');
fs.writeFileSync(stub, `module.exports = { default: { capabilities: {}, async get() { return 'x'; } } };`, 'utf8');
const configs: BlankConfigLike[] = [{ name: 'demo', impl: stub }];

// Hermetic: restore the flag after each case (check-test-hermeticity).
const prev = process.env['OPENCUES_SKIP_USER_BLANKS'];
afterEach(() => {
  if (prev === undefined) delete process.env['OPENCUES_SKIP_USER_BLANKS'];
  else process.env['OPENCUES_SKIP_USER_BLANKS'] = prev;
});

describe('OPENCUES_SKIP_USER_BLANKS', () => {
  it('=1 → empty registry, no impl loaded (no sandbox/subprocess spawned)', () => {
    process.env['OPENCUES_SKIP_USER_BLANKS'] = '1';
    const reg = buildUserBlankRegistry(configs, { storageRoot: TMP });
    expect(reg.size).toBe(0);
  });

  it('unset → the same impl config loads (proves the flag is the discriminator)', () => {
    delete process.env['OPENCUES_SKIP_USER_BLANKS'];
    const reg = buildUserBlankRegistry(configs, { storageRoot: TMP });
    expect(reg.size).toBe(1);
  });

  it('any value other than "1" does NOT skip', () => {
    process.env['OPENCUES_SKIP_USER_BLANKS'] = '0';
    expect(buildUserBlankRegistry(configs, { storageRoot: TMP }).size).toBe(1);
  });
});
