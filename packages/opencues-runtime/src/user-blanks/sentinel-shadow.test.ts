/**
 * Pack-name shadowing tests — specifically the threat model that a
 * malicious pack might ship a `BLANK.md` with `name: sentinel` (the
 * same name as a future built-in sentinel-management blank).
 *
 * The defence already exists generically in `registry.ts:145` — first-
 * wins on duplicate names with a loud warn — but the sentinel surface
 * is sensitive enough to warrant a dedicated regression pin. If the
 * sentinel blank ships and these tests later regress, the audit table
 * row #24 ("Sentinel-write via in-editor blank") is invalidated.
 *
 * Vitest harness (matches the rest of `runtime`'s test setup).
 */

import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildUserBlankRegistry, type BlankConfigLike } from './registry';

// The collision check at registry.ts:145 fires only when a PRIOR
// entry already landed in the out map — which requires the first
// entry's `impl:` file to actually load. To exercise the collision
// path realistically (matching production where real BLANK.md files
// reference real on-disk modules) we write valid blank stubs to a
// tmpdir and tear them down once the suite finishes.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-shadow-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const BLANK_STUB = `
module.exports = {
  default: {
    capabilities: {},
    async get() { return null; },
  },
};
`;

function writeStub(name) {
  const file = path.join(TMP, `${name}-blank.js`);
  fs.writeFileSync(file, BLANK_STUB, 'utf8');
  return file;
}

describe('User-blank registry — pack-shadow protection for sensitive names', () => {
  it('refuses a SECOND user blank with the same `name:` field (first-wins)', () => {
    // Simulate two `BLANK.md` files (one shipped, one user-installed)
    // that both declare name: sentinel. The first wins; the second is
    // silently ignored after a warn.
    //
    // In production, BUILTIN_BLANKS registers `sentinel` BEFORE
    // buildUserBlankRegistry runs, so a user pack with the same name
    // never gets a chance to bind. This test exercises the same
    // first-wins gate within the user-blank registry itself, which
    // is the second layer of defence.
    const logs: Array<{ lvl: string; msg: string }> = [];
    const firstImpl = writeStub('first-sentinel');
    const hostileImpl = writeStub('hostile-sentinel');
    const configs: BlankConfigLike[] = [
      { name: 'sentinel', impl: firstImpl },
      { name: 'sentinel', impl: hostileImpl },
    ];
    const registry = buildUserBlankRegistry(configs, {
      log: (lvl, msg) => logs.push({ lvl, msg }),
    });
    // Only the FIRST registration survived.
    expect(registry.size).toBe(1);
    // Loud warn surfaced for the second.
    const collisionWarn = logs.find(l => l.msg.includes('name collision') && l.msg.includes('sentinel'));
    expect(collisionWarn).toBeTruthy();
    expect(collisionWarn!.lvl).toBe('warn');
    expect(collisionWarn!.msg).toMatch(/already registered/);
    expect(collisionWarn!.msg).toMatch(/hostile-sentinel/);
  });

  it('a user pack cannot shadow `opencues` (the settings blank built-in name)', () => {
    // Same defence — pinned here for the existing built-in to ensure
    // we don't regress the precedent the sentinel test relies on.
    const logs: Array<{ lvl: string; msg: string }> = [];
    const firstImpl = writeStub('first-opencues');
    const typosquatImpl = writeStub('typosquat-opencues');
    const configs: BlankConfigLike[] = [
      { name: 'opencues', impl: firstImpl },
      { name: 'opencues', impl: typosquatImpl },
    ];
    const registry = buildUserBlankRegistry(configs, {
      log: (lvl, msg) => logs.push({ lvl, msg }),
    });
    expect(registry.size).toBe(1);
    const collisionWarn = logs.find(l => l.msg.includes('name collision') && l.msg.includes('opencues'));
    expect(collisionWarn).toBeTruthy();
    expect(collisionWarn!.msg).toMatch(/typosquat/);
  });

  it('different names load independently (no false-positive collision)', () => {
    const logs: Array<{ lvl: string; msg: string }> = [];
    const configs: BlankConfigLike[] = [
      { name: 'sentinel', impl: writeStub('indep-sentinel') },
      { name: 'weather',  impl: writeStub('indep-weather') },
      { name: 'volume',   impl: writeStub('indep-volume') },
    ];
    const registry = buildUserBlankRegistry(configs, {
      log: (lvl, msg) => logs.push({ lvl, msg }),
    });
    expect(registry.size).toBe(3);
    const collisionWarn = logs.find(l => l.msg.includes('name collision'));
    expect(collisionWarn).toBeUndefined();
  });

  it('shadowing detection is case-sensitive — Sentinel vs sentinel are different names', () => {
    // Documents current behaviour: the name match is exact-string. A
    // pack with name: Sentinel does NOT collide with built-in
    // sentinel. The implication: if we want case-insensitive
    // protection, that's a separate defence we'd have to add. For
    // now, the system relies on built-in names being canonicalised
    // (lowercase) and pack authors being audited via `opencues review`
    // before install.
    const logs: Array<{ lvl: string; msg: string }> = [];
    const configs: BlankConfigLike[] = [
      { name: 'sentinel', impl: writeStub('lower-case-sentinel') },
      { name: 'Sentinel', impl: writeStub('mixed-case-sentinel') },
    ];
    const registry = buildUserBlankRegistry(configs, {
      log: (lvl, msg) => logs.push({ lvl, msg }),
    });
    expect(registry.size).toBe(2);
    const collisionWarn = logs.find(l => l.msg.includes('name collision'));
    expect(collisionWarn).toBeUndefined();
  });
});
