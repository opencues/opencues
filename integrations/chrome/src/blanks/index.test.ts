// Tests for createBlanks() — chrome's thin wrapper over
// @opencues/runtime's createDefaultBlanksRegistry. Covers which
// built-ins register under which option combinations, and the
// collision-guard invariant documented in integrations/chrome/CLAUDE.md
// ("Built-in TS classes are the single implementation") — a user-blank
// must never be able to shadow a name already present in the Map this
// factory returns.
//
// The actual guard that enforces this at runtime lives in
// opencues-bootstrap.ts's registerUserBlanksFromBundle (out of scope
// for this pass — a parallel agent owns that file). Its logic is a
// simple `if (blanksRegistry.has(blankName)) { skip }` check against
// the very Map this factory builds, so we exercise that same
// invariant directly against createBlanks()'s output without
// importing the bootstrap module.

import { describe, it, expect } from 'vitest';
import { createBlanks } from './index';

describe('createBlanks — happy path / defaults', () => {
  it('registers the always-on built-ins with no options supplied', () => {
    const blanks = createBlanks();
    expect(blanks.has('hackernews')).toBe(true);
    expect(blanks.has('weather')).toBe(true);
    expect(blanks.has('claude-status')).toBe(true);
    expect(blanks.has('dictionary')).toBe(true);
    expect(blanks.has('crypto')).toBe(true);
    expect(blanks.has('countries')).toBe(true);
  });

  it('does NOT register "volume" — intentionally unregistered per CLAUDE.md so it falls through to spawnProcess', () => {
    const blanks = createBlanks();
    expect(blanks.has('volume')).toBe(false);
  });

  it('does not register "stocks" without a finnhubApiKey', () => {
    const blanks = createBlanks();
    expect(blanks.has('stocks')).toBe(false);
  });

  it('registers "stocks" when a finnhubApiKey is supplied', () => {
    const blanks = createBlanks({ finnhubApiKey: 'fake-key' });
    expect(blanks.has('stocks')).toBe(true);
  });

  it('does not register "opencues" settings blank without OPENCUES.md IO', () => {
    const blanks = createBlanks();
    expect(blanks.has('opencues')).toBe(false);
  });

  it('registers "opencues" settings blank when full read+write IO is supplied', () => {
    const blanks = createBlanks({
      opencuesMdReadFile: async () => 'debug-mode: off',
      opencuesMdWriteFile: async () => {},
    });
    expect(blanks.has('opencues')).toBe(true);
  });

  it('does not register "sentinel" without IDENTITY.md IO', () => {
    const blanks = createBlanks();
    expect(blanks.has('sentinel')).toBe(false);
  });

  it('registers "sentinel" when full IDENTITY.md IO is supplied', () => {
    const blanks = createBlanks({
      identityMdReadFile: async () => null,
      identityMdWriteFile: async () => {},
    });
    expect(blanks.has('sentinel')).toBe(true);
  });

  it('does not register "note" without NOTES.md IO', () => {
    const blanks = createBlanks();
    expect(blanks.has('note')).toBe(false);
  });

  it('registers "note" when full NOTES.md IO is supplied', () => {
    const blanks = createBlanks({
      notesMdReadFile: async () => null,
      notesMdWriteFile: async () => {},
    });
    expect(blanks.has('note')).toBe(true);
  });
});

describe('createBlanks — edge cases (partial IO)', () => {
  it('a read-only accessor with no matching writer does NOT register the opencues blank', () => {
    const blanks = createBlanks({
      opencuesMdReadFile: async () => 'debug-mode: off',
      // no opencuesMdWriteFile
    });
    expect(blanks.has('opencues')).toBe(false);
  });

  it('a write-only accessor with no matching reader does NOT register the sentinel blank', () => {
    const blanks = createBlanks({
      identityMdWriteFile: async () => {},
      // no identityMdReadFile
    });
    expect(blanks.has('sentinel')).toBe(false);
  });

  it('an empty finnhubApiKey string is treated as "no key" (falsy) — stocks stays unregistered', () => {
    const blanks = createBlanks({ finnhubApiKey: '' });
    expect(blanks.has('stocks')).toBe(false);
  });

  it('customTickers alone (no finnhubApiKey) does not register stocks', () => {
    const blanks = createBlanks({ customTickers: { TSLA: 'TSLA' } });
    expect(blanks.has('stocks')).toBe(false);
  });

  it('every optional-IO blank can be registered simultaneously', () => {
    const blanks = createBlanks({
      finnhubApiKey: 'key',
      opencuesMdReadFile: async () => null,
      opencuesMdWriteFile: async () => {},
      identityMdReadFile: async () => null,
      identityMdWriteFile: async () => {},
      notesMdReadFile: async () => null,
      notesMdWriteFile: async () => {},
    });
    for (const name of ['stocks', 'opencues', 'sentinel', 'note']) {
      expect(blanks.has(name)).toBe(true);
    }
  });
});

describe('createBlanks — collision-guard invariant', () => {
  it('returns a Map, so `.has(name)` is authoritative for the guard opencues-bootstrap.ts relies on', () => {
    const blanks = createBlanks();
    expect(blanks).toBeInstanceOf(Map);
  });

  it('every BUILTIN_BLANKS name that registers is NOT overridable by a same-named user-blank — the has() check would correctly refuse it', () => {
    const blanks = createBlanks({ finnhubApiKey: 'k' });
    // Mirrors the exact guard in opencues-bootstrap.ts's
    // registerUserBlanksFromBundle: `if (blanksRegistry.has(blankName)) skip`.
    const wouldBeShadowed = (name: string): boolean => blanks.has(name);

    for (const name of ['hackernews', 'weather', 'claude-status', 'dictionary', 'crypto', 'countries', 'stocks']) {
      expect(wouldBeShadowed(name)).toBe(true);
    }
  });

  it('a name NOT in the built-in set is free for a user-blank to claim (guard does not over-block)', () => {
    const blanks = createBlanks();
    expect(blanks.has('my-custom-user-blank')).toBe(false);
  });

  it('"volume" — despite having a TS class in the codebase — is currently free for a user/keyword since createBlanks() does not register it', () => {
    // Documents the intentional gap called out in blanks/index.ts's
    // top-of-file comment: VolumeBlank exists but isn't wired into the
    // registry, so a same-named user-blank (or the spawnProcess
    // fallback) is NOT shadowed by a built-in today.
    const blanks = createBlanks();
    expect(blanks.has('volume')).toBe(false);
  });
});
