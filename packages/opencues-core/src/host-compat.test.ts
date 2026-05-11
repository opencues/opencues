/**
 * Tests for host-compat.ts — auto-detection + explicit overrides for
 * which OpenCues integrations a cue or blank runs on.
 *
 * Run with: node --test dist/host-compat.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  inferHostCompat,
  inferSiteCompat,
  unknownHostNames,
  formatHostList,
  HOSTS,
  NATIVE_HOSTS,
} from './host-compat';

const SORTED_HOSTS = [...HOSTS].sort();
const SORTED_NATIVE = [...NATIVE_HOSTS].sort();

describe('inferHostCompat: auto-detection', () => {
  it('no script field → all hosts', () => {
    const r = inferHostCompat({});
    assert.deepStrictEqual(r.hosts, SORTED_HOSTS);
    assert.strictEqual(r.all, true);
    assert.strictEqual(r.source, 'auto');
  });

  it('runtime-class blank (no script) → all hosts', () => {
    // e.g. blanks/stocks.md with `name: stocks` resolves
    // by name in the runtime's blanksRegistry; no script = chrome OK.
    const r = inferHostCompat({});
    assert.strictEqual(r.all, true);
  });

  for (const ext of ['.sh', '.bash', '.ps1', '.bat', '.cmd', '.exe', '.py', '.rb', '.pl']) {
    it(`script ending in ${ext} → not chrome (subprocess)`, () => {
      const r = inferHostCompat({ script: `./helper${ext}` });
      assert.deepStrictEqual(r.hosts, SORTED_NATIVE);
      assert.strictEqual(r.all, false);
      assert.strictEqual(r.source, 'auto');
      assert.ok(!r.hosts.includes('chrome'));
    });
  }

  it('blankScript with .sh → not chrome (treated same as script)', () => {
    const r = inferHostCompat({ blankScript: './volume-blank.sh' });
    assert.deepStrictEqual(r.hosts, SORTED_NATIVE);
  });

  it('script extension is case-insensitive', () => {
    assert.strictEqual(inferHostCompat({ script: './FOO.SH' }).all, false);
    assert.deepStrictEqual(inferHostCompat({ script: './Foo.Bash' }).hosts, SORTED_NATIVE);
  });

  it('script with no recognised extension → all hosts (assume runtime-resolvable)', () => {
    // e.g. script: 'volume' in monolithic ## Blanks JSON refers to a
    // runtime registry name, not a file path.
    const r = inferHostCompat({ script: 'volume' });
    assert.strictEqual(r.all, true);
  });
});

describe('inferHostCompat: explicit on-host (allow-list)', () => {
  it('on-host: [chrome] → only chrome', () => {
    const r = inferHostCompat({ 'on-host': ['chrome'] });
    assert.deepStrictEqual(r.hosts, ['chrome']);
    assert.strictEqual(r.source, 'on-host');
  });

  it('on-host narrows even when auto would include more', () => {
    const r = inferHostCompat({ 'on-host': ['claude-code', 'opencode'] });
    assert.deepStrictEqual(r.hosts, ['claude-code', 'opencode']);
  });

  it('on-host: [chrome] BEATS subprocess auto-detect (author opt-in)', () => {
    const r = inferHostCompat({ script: './foo.sh', 'on-host': ['chrome'] });
    assert.deepStrictEqual(r.hosts, ['chrome']);
  });

  it('on-host accepts a comma-separated string', () => {
    const r = inferHostCompat({ 'on-host': 'chrome, opencode' });
    assert.deepStrictEqual(r.hosts, ['chrome', 'opencode']);
  });

  it('on-host accepts a single string', () => {
    const r = inferHostCompat({ 'on-host': 'chrome' });
    assert.deepStrictEqual(r.hosts, ['chrome']);
  });

  it('on-host with unknown host names drops them (validator surfaces)', () => {
    const r = inferHostCompat({ 'on-host': ['chrome', 'mythical-host'] });
    assert.deepStrictEqual(r.hosts, ['chrome']);
  });

  it('camelCase onHost is accepted', () => {
    const r = inferHostCompat({ onHost: ['chrome'] });
    assert.deepStrictEqual(r.hosts, ['chrome']);
  });
});

describe('inferHostCompat: explicit not-on-host (deny)', () => {
  it('not-on-host: [chrome] removes chrome from default-all', () => {
    const r = inferHostCompat({ 'not-on-host': ['chrome'] });
    assert.deepStrictEqual(r.hosts, SORTED_NATIVE);
    assert.strictEqual(r.source, 'auto+not-on-host');
  });

  it('not-on-host stacks with auto-detected subprocess restriction', () => {
    const r = inferHostCompat({ script: './volume.sh', 'not-on-host': ['opencode'] });
    assert.deepStrictEqual(r.hosts, ['claude-code', 'gemini-cli']);
    assert.strictEqual(r.source, 'auto+not-on-host');
  });

  it('not-on-host vs on-host: deny wins on overlap', () => {
    const r = inferHostCompat({
      'on-host': ['chrome', 'opencode'],
      'not-on-host': ['chrome'],
    });
    assert.deepStrictEqual(r.hosts, ['opencode']);
    assert.strictEqual(r.source, 'on-host');
  });

  it('not-on-host with all hosts → empty set (intentional disable)', () => {
    const r = inferHostCompat({ 'not-on-host': [...HOSTS] });
    assert.deepStrictEqual(r.hosts, []);
  });

  it('camelCase notOnHost is accepted', () => {
    const r = inferHostCompat({ notOnHost: ['chrome'] });
    assert.ok(!r.hosts.includes('chrome'));
  });
});

describe('unknownHostNames', () => {
  it('returns empty for valid hosts', () => {
    assert.deepStrictEqual(unknownHostNames(['chrome', 'claude-code']), []);
  });

  it('returns the bad names', () => {
    assert.deepStrictEqual(unknownHostNames(['chrome', 'fake-host', 'mythical-host']), ['fake-host', 'mythical-host']);
  });

  it('handles undefined / null input', () => {
    assert.deepStrictEqual(unknownHostNames(undefined), []);
  });

  it('accepts comma-separated string form', () => {
    assert.deepStrictEqual(unknownHostNames('chrome, mythical'), ['mythical']);
  });

  it('lowercases before comparison', () => {
    assert.deepStrictEqual(unknownHostNames(['Chrome', 'CLAUDE-CODE']), []);
  });
});

describe('formatHostList', () => {
  it('all hosts → "all"', () => {
    assert.strictEqual(formatHostList(SORTED_HOSTS), 'all');
  });

  it('native hosts → comma-separated alphabetical', () => {
    assert.strictEqual(formatHostList(SORTED_NATIVE), 'claude-code, gemini-cli, opencode');
  });

  it('single host → just the name', () => {
    assert.strictEqual(formatHostList(['chrome']), 'chrome');
  });

  it('empty list → empty string', () => {
    assert.strictEqual(formatHostList([]), '');
  });
});

describe('inferSiteCompat', () => {
  const chromeOnReddit = { hostName: 'chrome' as const, hostname: 'reddit.com', path: '/r/foo' };
  const chromeOnWwwReddit = { hostName: 'chrome' as const, hostname: 'www.reddit.com', path: '/r/foo' };
  const chromeOnClaudeAi = { hostName: 'chrome' as const, hostname: 'claude.ai', path: '/chat/x' };
  const onClaudeCode = { hostName: 'claude-code' as const, hostname: null, path: null };

  it('no constraints → always true', () => {
    assert.strictEqual(inferSiteCompat({}, chromeOnReddit), true);
    assert.strictEqual(inferSiteCompat({}, onClaudeCode), true);
  });

  it('platform name on-site matches running host', () => {
    assert.strictEqual(inferSiteCompat({ onSite: ['chrome'] }, chromeOnReddit), true);
    assert.strictEqual(inferSiteCompat({ onSite: ['chrome'] }, onClaudeCode), false);
  });

  it('platform aliases resolve (cc → claude-code, oc → opencode, gemini → gemini-cli)', () => {
    assert.strictEqual(inferSiteCompat({ onSite: ['cc'] }, onClaudeCode), true);
    assert.strictEqual(inferSiteCompat({ onSite: ['claude'] }, onClaudeCode), true);
  });

  it('hostname is exact match (no implicit wildcard)', () => {
    assert.strictEqual(inferSiteCompat({ onSite: ['reddit.com'] }, chromeOnReddit), true);
    assert.strictEqual(inferSiteCompat({ onSite: ['reddit.com'] }, chromeOnWwwReddit), false);
  });

  it('wildcard *.host matches subdomains AND the bare domain', () => {
    assert.strictEqual(inferSiteCompat({ onSite: ['*.reddit.com'] }, chromeOnReddit), true);
    assert.strictEqual(inferSiteCompat({ onSite: ['*.reddit.com'] }, chromeOnWwwReddit), true);
    assert.strictEqual(inferSiteCompat({ onSite: ['*.reddit.com'] },
      { hostName: 'chrome', hostname: 'evil-reddit.com', path: '/' }), false);
  });

  it('hostname/path-prefix entries scope to a path', () => {
    assert.strictEqual(inferSiteCompat({ onSite: ['reddit.com/r/foo'] }, chromeOnReddit), true);
    assert.strictEqual(inferSiteCompat({ onSite: ['reddit.com/r/other'] }, chromeOnReddit), false);
  });

  it('not-on-site denies overriding any matching allow', () => {
    assert.strictEqual(
      inferSiteCompat({ onSite: ['chrome'], notOnSite: ['claude.ai'] }, chromeOnClaudeAi),
      false,
    );
  });

  it('hostname-based entries do not match on native hosts', () => {
    assert.strictEqual(inferSiteCompat({ onSite: ['reddit.com'] }, onClaudeCode), false);
  });

  it('mixed lists: platform OR hostname both accepted', () => {
    assert.strictEqual(
      inferSiteCompat({ onSite: ['chrome', 'claude-code'] }, onClaudeCode),
      true,
    );
    assert.strictEqual(
      inferSiteCompat({ onSite: ['reddit.com', 'claude-code'] }, chromeOnClaudeAi),
      false,
    );
  });
});
