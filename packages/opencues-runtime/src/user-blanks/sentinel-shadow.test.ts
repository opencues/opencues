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
 * `loadUserBlank` is mocked (returns a truthy stub module) so the
 * collision path runs without a real isolated-vm isolate — matching
 * `registry.test.ts`. Mocking is REQUIRED, not just convenient: runtime
 * vitest runs with `isolate: false` + `pool: 'forks'`, so a sibling
 * file's `vi.mock('./node-loader')` leaks into this file's fork. If this
 * file relied on the REAL loader it would crash whenever it shares a
 * fork with `registry.test.ts` (the loader returns the leaked mock's
 * reset value — undefined — and `wrapUserBlankAsBlank(undefined)` throws).
 * Owning the mock here makes the outcome order-independent.
 */

import { describe, expect, it, vi } from 'vitest';
import type { LoadedUserBlank, loadUserBlank } from './node-loader';
import type { UserBlankModule } from './types';
import { buildUserBlankRegistry, type BlankConfigLike } from './registry';

// The isolate-backed loader is INJECTED (loadUserBlankImpl), not mocked at
// the module level — see registry.test.ts for the isolate:false/forks
// rationale. Every load resolves to a truthy stub so the first-wins
// collision path is exercised; the collision check runs BEFORE the load,
// so the module's content is irrelevant, only that the load succeeds.
function fakeLoaded(mod: Partial<UserBlankModule>): LoadedUserBlank {
  return {
    module: mod as UserBlankModule,
    folder: '/fake',
    capabilities: {},
    dispose: () => {},
  };
}

const okLoad = vi.fn<typeof loadUserBlank>(() => fakeLoaded({ async get() { return null; } }));

/** buildUserBlankRegistry with a succeeding fake loader pre-wired. */
function build(configs: readonly BlankConfigLike[], log: (lvl: string, msg: string) => void) {
  return buildUserBlankRegistry(configs, { loadUserBlankImpl: okLoad, log });
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
    const configs: BlankConfigLike[] = [
      { name: 'sentinel', impl: '/abs/first-sentinel-blank.js' },
      { name: 'sentinel', impl: '/abs/hostile-sentinel-blank.js' },
    ];
    const registry = build(configs, (lvl, msg) => logs.push({ lvl, msg }));
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
    const configs: BlankConfigLike[] = [
      { name: 'opencues', impl: '/abs/first-opencues-blank.js' },
      { name: 'opencues', impl: '/abs/typosquat-opencues-blank.js' },
    ];
    const registry = build(configs, (lvl, msg) => logs.push({ lvl, msg }));
    expect(registry.size).toBe(1);
    const collisionWarn = logs.find(l => l.msg.includes('name collision') && l.msg.includes('opencues'));
    expect(collisionWarn).toBeTruthy();
    expect(collisionWarn!.msg).toMatch(/typosquat/);
  });

  it('different names load independently (no false-positive collision)', () => {
    const logs: Array<{ lvl: string; msg: string }> = [];
    const configs: BlankConfigLike[] = [
      { name: 'sentinel', impl: '/abs/indep-sentinel-blank.js' },
      { name: 'weather',  impl: '/abs/indep-weather-blank.js' },
      { name: 'volume',   impl: '/abs/indep-volume-blank.js' },
    ];
    const registry = build(configs, (lvl, msg) => logs.push({ lvl, msg }));
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
      { name: 'sentinel', impl: '/abs/lower-case-sentinel-blank.js' },
      { name: 'Sentinel', impl: '/abs/mixed-case-sentinel-blank.js' },
    ];
    const registry = build(configs, (lvl, msg) => logs.push({ lvl, msg }));
    expect(registry.size).toBe(2);
    const collisionWarn = logs.find(l => l.msg.includes('name collision'));
    expect(collisionWarn).toBeUndefined();
  });
});
