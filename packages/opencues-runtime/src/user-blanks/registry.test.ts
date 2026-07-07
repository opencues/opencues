/**
 * Registry logic tests that do NOT require a working `isolated-vm`
 * isolate. `loadUserBlank` is mocked so `buildUserBlankRegistry`'s
 * collision handling, required-secret-binding refusal, and ctx wiring
 * run against a fake `LoadedUserBlank`, exactly like production would
 * see it after a successful load — just without paying for a real
 * V8 isolate (unavailable in this dev environment; see CLAUDE.md).
 *
 * `wrapUserBlankAsBlank` is also exercised directly (no mocking
 * needed — it takes an already-loaded module).
 *
 * NOTE: `ctx.llm`'s secret-destination-binding guard (the `caps.llm`
 * branch of `buildContextFromCaps`) is explicitly OUT OF SCOPE here —
 * it's under active development in PR #246 (INFOSEC NF1).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoadedUserBlank, loadUserBlank } from './node-loader';
import type { BlankContext, UserBlankModule } from './types';
import {
  buildUserBlankRegistry,
  wrapUserBlankAsBlank,
  type BlankConfigLike,
  type UserBlankRegistryOptions,
} from './registry';

// The isolate-backed loader is injected via `loadUserBlankImpl` rather
// than mocked at the module level. runtime vitest runs `isolate: false`
// + `pool: 'forks'`, so a `vi.mock('./node-loader')` here would leak into
// every sibling test file sharing this fork (it did — it crashed the
// real-loader `sentinel-shadow.test.ts`). A plain `vi.fn()` threaded
// through opts can't leak.
const mockLoadUserBlank = vi.fn<typeof loadUserBlank>();

/** buildUserBlankRegistry with the fake loader pre-wired. */
function build(configs: readonly BlankConfigLike[], opts: UserBlankRegistryOptions = {}) {
  return buildUserBlankRegistry(configs, { loadUserBlankImpl: mockLoadUserBlank, ...opts });
}

function fakeLoaded(mod: Partial<UserBlankModule>): LoadedUserBlank {
  return {
    module: mod as UserBlankModule,
    folder: '/fake',
    capabilities: {},
    dispose: () => {},
  };
}

function fakeCtx(): BlankContext {
  return { now: () => 0, log: () => {} };
}

afterEach(() => {
  mockLoadUserBlank.mockReset();
});

// ─── wrapUserBlankAsBlank — readOnly inference ──────────────────────────

describe('wrapUserBlankAsBlank — readOnly inference', () => {
  it('a module with only `get` is inferred read-only', () => {
    const blank = wrapUserBlankAsBlank(fakeLoaded({ async get() { return 'x'; } }), 'n', fakeCtx());
    expect(blank.readOnly).toBe(true);
    expect(blank.set).toBeUndefined();
    expect(blank.up).toBeUndefined();
    expect(blank.down).toBeUndefined();
  });

  it('a module with `get` + `set` is inferred NOT read-only', () => {
    const blank = wrapUserBlankAsBlank(
      fakeLoaded({ async get() { return 'x'; }, async set() {} }),
      'n', fakeCtx(),
    );
    expect(blank.readOnly).toBe(false);
    expect(blank.set).toBeDefined();
  });

  it('a module with `get` + `up` (no set/down) is inferred NOT read-only', () => {
    const blank = wrapUserBlankAsBlank(
      fakeLoaded({ async get() { return 'x'; }, async up() { return 'y'; } }),
      'n', fakeCtx(),
    );
    expect(blank.readOnly).toBe(false);
    expect(blank.up).toBeDefined();
    expect(blank.set).toBeUndefined();
  });

  it('a module with `get` + `down` (no set/up) is inferred NOT read-only', () => {
    const blank = wrapUserBlankAsBlank(
      fakeLoaded({ async get() { return 'x'; }, async down() { return 'y'; } }),
      'n', fakeCtx(),
    );
    expect(blank.readOnly).toBe(false);
    expect(blank.down).toBeDefined();
    expect(blank.set).toBeUndefined();
  });

  it('an explicit `readOnly: true` short-circuits even when set/up/down are present', () => {
    const blank = wrapUserBlankAsBlank(
      fakeLoaded({
        async get() { return 'x'; },
        async set() {},
        async up() { return 'y'; },
        readOnly: true,
      }),
      'n', fakeCtx(),
    );
    expect(blank.readOnly).toBe(true);
    // The wrapper still exposes set/up as callables — readOnly is
    // advisory metadata for the caller, not an enforcement gate here.
    expect(blank.set).toBeDefined();
  });

  it('an explicit `readOnly: false` with no mutators still computes readOnly=true (formula is OR, not the explicit flag alone)', () => {
    // Documents current behaviour: `!!mod.readOnly || (no set/up/down)`.
    // Setting readOnly:false explicitly does NOT force a "false"
    // result if the module has no mutator methods at all — the second
    // disjunct still fires. Not a bug: a module with no set/up/down is
    // read-only regardless of the flag's stated intent.
    const blank = wrapUserBlankAsBlank(
      fakeLoaded({ async get() { return 'x'; }, readOnly: false }),
      'n', fakeCtx(),
    );
    expect(blank.readOnly).toBe(true);
  });
});

// ─── wrapUserBlankAsBlank — output-sanitization mode wiring ─────────────

describe('wrapUserBlankAsBlank — output-sanitization mode wiring', () => {
  const ADVERSARIAL = '<script>alert(1)</script>hel​lo'; // tag + ZWSP

  it('"safe" (default) mode strips tags and zero-width characters from get()', async () => {
    const blank = wrapUserBlankAsBlank(
      fakeLoaded({ async get() { return ADVERSARIAL; } }),
      'n', fakeCtx(),
      // outputMode omitted -> defaults to 'safe'
    );
    const out = await blank.get!();
    expect(out).toBe('alert(1)hello');
  });

  it('"safe" mode also strips output from up()/down()', async () => {
    const blank = wrapUserBlankAsBlank(
      fakeLoaded({
        async get() { return ''; },
        async up() { return ADVERSARIAL; },
        async down() { return ADVERSARIAL; },
      }),
      'n', fakeCtx(), 'safe',
    );
    expect(await blank.up!()).toBe('alert(1)hello');
    expect(await blank.down!()).toBe('alert(1)hello');
  });

  it('"rich" mode bypasses tag/zero-width stripping entirely', async () => {
    const blank = wrapUserBlankAsBlank(
      fakeLoaded({ async get() { return ADVERSARIAL; } }),
      'n', fakeCtx(), 'rich',
    );
    const out = await blank.get!();
    expect(out).toBe(ADVERSARIAL);
  });

  it('"rich" mode still applies the 8KB length cap (sanitize.ts caps regardless of allowRich)', async () => {
    const huge = 'a'.repeat(20_000);
    const blank = wrapUserBlankAsBlank(
      fakeLoaded({ async get() { return huge; } }),
      'n', fakeCtx(), 'rich',
    );
    const out = await blank.get!();
    expect(out.length).toBe(8192);
  });

  it('set() output is never sanitized (set does not return user-visible text)', async () => {
    let received: string | undefined;
    const blank = wrapUserBlankAsBlank(
      fakeLoaded({
        async get() { return ''; },
        async set(_ctx, value) { received = value; },
      }),
      'n', fakeCtx(), 'safe',
    );
    await blank.set!(ADVERSARIAL);
    expect(received).toBe(ADVERSARIAL);
  });
});

// ─── buildUserBlankRegistry — required secret-binding check ─────────────

describe('buildUserBlankRegistry — required secret-binding refusal', () => {
  it('refuses to register when a declared secret has NO binding entry at all', () => {
    mockLoadUserBlank.mockReturnValue(fakeLoaded({ async get() { return 'x'; } }));
    const logs: Array<{ lvl: string; msg: string }> = [];
    const configs: BlankConfigLike[] = [
      { name: 'leaky', impl: '/abs/leaky-blank.js', userBlankSecrets: ['API_KEY'] },
    ];
    const registry = build(configs, { log: (lvl, msg) => logs.push({ lvl, msg }) });
    expect(registry.has('leaky')).toBe(false);
    expect(mockLoadUserBlank).not.toHaveBeenCalled();
    const warn = logs.find(l => l.msg.includes('leaky'));
    expect(warn?.lvl).toBe('warn');
    expect(warn?.msg).toMatch(/secrets \[API_KEY\] declared without/);
    expect(warn?.msg).toMatch(/refusing to load/);
  });

  it('refuses to register when the binding entry exists but is an EMPTY array (treated as unbound)', () => {
    mockLoadUserBlank.mockReturnValue(fakeLoaded({ async get() { return 'x'; } }));
    const logs: Array<{ lvl: string; msg: string }> = [];
    const configs: BlankConfigLike[] = [
      {
        name: 'leaky2', impl: '/abs/leaky2-blank.js',
        userBlankSecrets: ['API_KEY'],
        userBlankSecretBindings: { API_KEY: [] },
      },
    ];
    const registry = build(configs, { log: (lvl, msg) => logs.push({ lvl, msg }) });
    expect(registry.has('leaky2')).toBe(false);
    expect(mockLoadUserBlank).not.toHaveBeenCalled();
  });

  it('refuses registration entirely when only SOME of multiple declared secrets are bound', () => {
    mockLoadUserBlank.mockReturnValue(fakeLoaded({ async get() { return 'x'; } }));
    const logs: Array<{ lvl: string; msg: string }> = [];
    const configs: BlankConfigLike[] = [
      {
        name: 'partial', impl: '/abs/partial-blank.js',
        userBlankSecrets: ['BOUND_KEY', 'UNBOUND_KEY'],
        userBlankSecretBindings: { BOUND_KEY: ['api.example.com'] },
      },
    ];
    const registry = build(configs, { log: (lvl, msg) => logs.push({ lvl, msg }) });
    expect(registry.has('partial')).toBe(false);
    const warn = logs.find(l => l.msg.includes('partial'));
    // Only the unbound one is named in the diagnostic's bracketed list.
    expect(warn?.msg).toMatch(/\[UNBOUND_KEY\]/);
    expect(warn?.msg).not.toMatch(/\[BOUND_KEY[,\]]/); // BOUND_KEY never starts the bracketed list
  });

  it('registers successfully when every declared secret has a non-empty binding', () => {
    mockLoadUserBlank.mockReturnValue(fakeLoaded({ async get() { return 'x'; } }));
    const logs: Array<{ lvl: string; msg: string }> = [];
    const configs: BlankConfigLike[] = [
      {
        name: 'bound-ok', impl: '/abs/bound-ok-blank.js',
        userBlankSecrets: ['API_KEY'],
        userBlankSecretBindings: { API_KEY: ['api.example.com'] },
      },
    ];
    const registry = build(configs, { log: (lvl, msg) => logs.push({ lvl, msg }) });
    expect(registry.has('bound-ok')).toBe(true);
    expect(mockLoadUserBlank).toHaveBeenCalledTimes(1);
    expect(logs.some(l => l.msg.includes('registered user blank "bound-ok"'))).toBe(true);
  });

  it('a blank declaring NO secrets at all is unaffected by the binding check', () => {
    mockLoadUserBlank.mockReturnValue(fakeLoaded({ async get() { return 'x'; } }));
    const configs: BlankConfigLike[] = [{ name: 'plain', impl: '/abs/plain-blank.js' }];
    const registry = build(configs);
    expect(registry.has('plain')).toBe(true);
  });
});

// ─── buildUserBlankRegistry — first-wins collision handling ─────────────

describe('buildUserBlankRegistry — first-wins collision handling', () => {
  it('three configs with the same name: only the FIRST registers, loadUserBlank is called exactly once', () => {
    mockLoadUserBlank.mockReturnValue(fakeLoaded({ async get() { return 'x'; } }));
    const logs: Array<{ lvl: string; msg: string }> = [];
    const configs: BlankConfigLike[] = [
      { name: 'dup', impl: '/abs/dup-a.js' },
      { name: 'dup', impl: '/abs/dup-b.js' },
      { name: 'dup', impl: '/abs/dup-c.js' },
    ];
    const registry = build(configs, { log: (lvl, msg) => logs.push({ lvl, msg }) });
    expect(registry.size).toBe(1);
    // Collision check happens BEFORE loadUserBlank is invoked, so the
    // 2nd/3rd entries never even attempt to load.
    expect(mockLoadUserBlank).toHaveBeenCalledTimes(1);
    expect(mockLoadUserBlank).toHaveBeenCalledWith('/abs/dup-a.js', expect.anything());
    const collisionWarnings = logs.filter(l => l.msg.includes('name collision'));
    expect(collisionWarnings).toHaveLength(2);
    expect(collisionWarnings[0].msg).toMatch(/dup-b\.js/);
    expect(collisionWarnings[1].msg).toMatch(/dup-c\.js/);
  });

  it('collision check is CASE-SENSITIVE: "Dup" and "dup" register independently', () => {
    mockLoadUserBlank.mockReturnValue(fakeLoaded({ async get() { return 'x'; } }));
    const logs: Array<{ lvl: string; msg: string }> = [];
    const configs: BlankConfigLike[] = [
      { name: 'dup', impl: '/abs/lower.js' },
      { name: 'Dup', impl: '/abs/mixed.js' },
      { name: 'DUP', impl: '/abs/upper.js' },
    ];
    const registry = build(configs, { log: (lvl, msg) => logs.push({ lvl, msg }) });
    expect(registry.size).toBe(3);
    expect(mockLoadUserBlank).toHaveBeenCalledTimes(3);
    expect(logs.some(l => l.msg.includes('name collision'))).toBe(false);
  });

  it('a later blank with a DIFFERENT name after a collision still registers normally', () => {
    mockLoadUserBlank.mockReturnValue(fakeLoaded({ async get() { return 'x'; } }));
    const configs: BlankConfigLike[] = [
      { name: 'dup', impl: '/abs/dup-a.js' },
      { name: 'dup', impl: '/abs/dup-b.js' },
      { name: 'unique', impl: '/abs/unique.js' },
    ];
    const registry = build(configs);
    expect(registry.size).toBe(2);
    expect(registry.has('dup')).toBe(true);
    expect(registry.has('unique')).toBe(true);
  });
});

// ─── buildUserBlankRegistry — misc config filtering (light coverage) ────

describe('buildUserBlankRegistry — config filtering', () => {
  it('skips entries with no impl:', () => {
    const configs: BlankConfigLike[] = [{ name: 'noimpl' }];
    const registry = build(configs);
    expect(registry.size).toBe(0);
    expect(mockLoadUserBlank).not.toHaveBeenCalled();
  });

  it('skips a bare-name impl (built-in registry lookup, not a user-blank path)', () => {
    const configs: BlankConfigLike[] = [{ name: 'builtin-ish', impl: 'weather' }];
    const registry = build(configs);
    expect(registry.size).toBe(0);
    expect(mockLoadUserBlank).not.toHaveBeenCalled();
  });

  it('logs a warning and skips the entry (without throwing) when loadUserBlank throws a non-ivm error', () => {
    mockLoadUserBlank.mockImplementation(() => { throw new Error('syntax error in blank.js'); });
    const logs: Array<{ lvl: string; msg: string }> = [];
    const configs: BlankConfigLike[] = [{ name: 'broken', impl: '/abs/broken.js' }];
    const registry = build(configs, { log: (lvl, msg) => logs.push({ lvl, msg }) });
    expect(registry.size).toBe(0);
    expect(logs.some(l => l.lvl === 'warn' && l.msg.includes('syntax error in blank.js'))).toBe(true);
  });
});

// ─── OPENCUES_SKIP_USER_BLANKS — agentic-harness memory guard ───────────

/**
 * Loading a JS user-blank (`impl: ./blank.js`) spins up an isolated-vm
 * sandbox / user-blank-runner.cjs subprocess (~54 MB resident) even for
 * shipped impl-blanks nothing invokes. The harness runs up to 16 host shards
 * in parallel and needs none of them, so it sets OPENCUES_SKIP_USER_BLANKS=1
 * to skip the whole registry build. Guarded at the single chokepoint
 * (registry.ts) so every host band + the chrome-host benefits without
 * per-bootstrap edits.
 *
 * Lives in THIS file (not a standalone one) because runtime's vitest runs
 * with `isolate: false` — two files both `vi.mock('./node-loader')` would
 * fight over the shared mock. One file owns the loader mock.
 */
describe('buildUserBlankRegistry — OPENCUES_SKIP_USER_BLANKS guard', () => {
  const prev = process.env['OPENCUES_SKIP_USER_BLANKS'];
  afterEach(() => {
    if (prev === undefined) delete process.env['OPENCUES_SKIP_USER_BLANKS'];
    else process.env['OPENCUES_SKIP_USER_BLANKS'] = prev;
  });

  const implConfigs: BlankConfigLike[] = [
    { name: 'demo-a', impl: '/abs/demo-a-blank.js' },
    { name: 'demo-b', impl: '/abs/demo-b-blank.js' },
  ];

  it('=1 → empty registry AND the loader is never reached (no sandbox spawned)', () => {
    mockLoadUserBlank.mockReturnValue(fakeLoaded({ async get() { return 'x'; } }));
    process.env['OPENCUES_SKIP_USER_BLANKS'] = '1';
    const registry = build(implConfigs);
    expect(registry.size).toBe(0);
    // The discriminator: empty because the GUARD returned before the load
    // loop, not because the configs failed — proven by loadUserBlank never
    // being called even though it's stubbed to succeed.
    expect(mockLoadUserBlank).not.toHaveBeenCalled();
  });

  it('unset → the guard does NOT fire: the loader IS reached and impl blanks register', () => {
    mockLoadUserBlank.mockReturnValue(fakeLoaded({ async get() { return 'x'; } }));
    delete process.env['OPENCUES_SKIP_USER_BLANKS'];
    const registry = build(implConfigs);
    expect(registry.size).toBe(2);
    expect(mockLoadUserBlank).toHaveBeenCalledTimes(2);
  });
});
