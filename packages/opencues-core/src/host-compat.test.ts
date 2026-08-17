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
  inferFieldCompat,
  fieldKindOf,
  structuralAmbientOnly,
  unknownHostNames,
  formatHostList,
  HOSTS,
  NATIVE_HOSTS,
  BROWSER_HOSTS,
  isBrowserHost,
  resolveHost,
} from './host-compat';

const SORTED_HOSTS = [...HOSTS].sort();
const SORTED_NATIVE = [...NATIVE_HOSTS].sort();

describe('inferHostCompat: defaults', () => {
  it('no frontmatter → all hosts', () => {
    const r = inferHostCompat({});
    assert.deepStrictEqual(r.hosts, SORTED_HOSTS);
    assert.strictEqual(r.all, true);
    assert.strictEqual(r.source, 'auto');
  });

  it('script/blankScript fields are IGNORED (no auto-exclusion)', () => {
    // Historical note: `.sh` etc. used to auto-exclude chrome on the
    // assumption it couldn't spawn subprocesses. With chrome-host
    // (May 2026) chrome CAN run scripts via the native-messaging bridge,
    // so the heuristic was actively wrong and got removed. Authors who
    // genuinely want to exclude chrome use `not-on-host: [chrome]`.
    // Cast through `unknown` — the type no longer admits a `script` field,
    // but a future caller that forgets to drop the property mustn't see
    // their entry vanish from chrome.
    const r = inferHostCompat({ script: './foo.sh' } as unknown as Parameters<typeof inferHostCompat>[0]);
    assert.deepStrictEqual(r.hosts, SORTED_HOSTS);
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
    // Deliberately "every host except chrome" rather than SORTED_NATIVE.
    // Those were the same list only while chrome was the sole non-native
    // host, and this assertion is about the DENY working — spelling it as
    // the native list made it a hidden pin on "chrome is the only browser",
    // which broke the day a second browser host (dsh) was added.
    assert.deepStrictEqual(r.hosts, SORTED_HOSTS.filter(h => h !== 'chrome'));
    assert.strictEqual(r.source, 'not-on-host');
  });

  it('not-on-host stacks with on-host', () => {
    const r = inferHostCompat({
      'on-host': ['claude-code', 'opencode', 'gemini-cli'],
      'not-on-host': ['opencode'],
    });
    assert.deepStrictEqual(r.hosts, ['claude-code', 'gemini-cli']);
    assert.strictEqual(r.source, 'on-host');
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
    assert.strictEqual(formatHostList(SORTED_NATIVE), 'claude-code, gemini-cli, opencode, shell, windows');
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

describe('inferFieldCompat: field-kind scoping (on-field / not-on-field)', () => {
  it('fieldKindOf maps the ambient singleLine declaration', () => {
    assert.strictEqual(fieldKindOf({ singleLine: true }), 'single-line');
    assert.strictEqual(fieldKindOf({ singleLine: false }), 'multi-line');
    assert.strictEqual(fieldKindOf({}), null);          // host declared nothing
    assert.strictEqual(fieldKindOf(undefined), null);
  });

  it('no on-field/not-on-field → always available', () => {
    assert.strictEqual(inferFieldCompat({}, { singleLine: true }), true);
    assert.strictEqual(inferFieldCompat({}, undefined), true);
  });

  it('not-on-field: single-line → dropped in a single-line field, kept elsewhere', () => {
    const cue = { notOnField: ['single-line'] };
    assert.strictEqual(inferFieldCompat(cue, { singleLine: true }), false);   // omnibox: dropped
    assert.strictEqual(inferFieldCompat(cue, { singleLine: false }), true);   // prose editor: kept
    assert.strictEqual(inferFieldCompat(cue, undefined), true);              // unknown kind: kept (can't prove)
    assert.strictEqual(inferFieldCompat(cue, {}), true);                     // host reports nothing: kept
  });

  it('on-field: single-line → available ONLY in a known single-line field', () => {
    const cue = { onField: ['single-line'] };
    assert.strictEqual(inferFieldCompat(cue, { singleLine: true }), true);
    assert.strictEqual(inferFieldCompat(cue, { singleLine: false }), false);
    assert.strictEqual(inferFieldCompat(cue, undefined), false);            // unknown: allow-list opt-in doesn't match
  });

  it('deny wins over allow', () => {
    const cue = { onField: ['single-line'], notOnField: ['single-line'] };
    assert.strictEqual(inferFieldCompat(cue, { singleLine: true }), false);
  });

  it('case + whitespace tolerant', () => {
    assert.strictEqual(inferFieldCompat({ notOnField: [' Single-Line '] }, { singleLine: true }), false);
  });
});

describe('structuralAmbientOnly: whitelist redaction', () => {
  it('strips text metadata, keeps shape booleans', () => {
    const full = {
      label: 'Search', placeholder: 'type here', pageTitle: 'Google',
      pageUrl: 'https://google.com', app: 'chrome.exe',
      singleLine: true, disposable: true,
    };
    assert.deepStrictEqual(structuralAmbientOnly(full), { singleLine: true, disposable: true });
  });

  it('keeps singleLine:false (a known multi-line kind is a real signal)', () => {
    assert.deepStrictEqual(structuralAmbientOnly({ singleLine: false, label: 'Body' }), { singleLine: false });
  });

  it('undefined in → undefined out', () => {
    assert.strictEqual(structuralAmbientOnly(undefined), undefined);
  });

  it('metadata-only ambient (no shape declared) → undefined (kind unknown)', () => {
    assert.strictEqual(structuralAmbientOnly({ label: 'X', app: 'chrome' }), undefined);
  });

  it('the whitelisted output still cedes a not-on-field cue (end-to-end shape)', () => {
    // The whole point: a redacted (mode-off) ambient must still drive on-field.
    const redacted = structuralAmbientOnly({ label: 'Search', singleLine: true });
    assert.strictEqual(inferFieldCompat({ notOnField: ['single-line'] }, redacted), false);
  });
});

/**
 * Browser hosts.
 *
 * Several behaviours are browser-motivated and were written as
 * `hostName === 'chrome'` while chrome was the only browser host — the
 * ctrl-alt keymap (ctrl-shift+arrow is the browser's own extend-selection)
 * and `dim-mix` (the dim colour mixes toward a *page* background). A second
 * browser host has to inherit those by construction, not by being spelled
 * `chrome`.
 */
describe('BROWSER_HOSTS / isBrowserHost', () => {
  it('every host is either native or browser, never both, never neither', () => {
    // The real invariant. Catches a new host added to HOSTS and to neither
    // list, which would silently get terminal keybindings in a browser (or
    // the reverse) with nothing failing.
    for (const h of HOSTS) {
      const native = NATIVE_HOSTS.includes(h);
      const browser = BROWSER_HOSTS.includes(h);
      assert.ok(native !== browser, `${h} must be exactly one of NATIVE_HOSTS / BROWSER_HOSTS (native=${native}, browser=${browser})`);
    }
  });

  it('recognises the browser hosts and rejects the rest', () => {
    assert.strictEqual(isBrowserHost('chrome'), true);
    assert.strictEqual(isBrowserHost('dsh'), true);
    assert.strictEqual(isBrowserHost('claude-code'), false);
    assert.strictEqual(isBrowserHost('shell'), false);
  });

  it('is false for an unknown name rather than throwing', () => {
    // Callers pass `adapter.hostName`, a free-form string a host supplies.
    assert.strictEqual(isBrowserHost('not-a-host'), false);
    assert.strictEqual(isBrowserHost(''), false);
  });
});

describe('dsh host registration', () => {
  it('is a known host, so on-host: [dsh] resolves', () => {
    const r = inferHostCompat({ 'on-host': ['dsh'] });
    assert.deepStrictEqual(r.hosts, ['dsh']);
    assert.strictEqual(r.source, 'on-host');
  });

  it('is not native — it has no subprocess or filesystem of its own', () => {
    assert.ok(!NATIVE_HOSTS.includes('dsh'));
  });

  it('resolves its aliases', () => {
    assert.strictEqual(resolveHost('deepseek'), 'dsh');
    assert.strictEqual(resolveHost('deepseek-harness'), 'dsh');
    assert.strictEqual(resolveHost('dsh'), 'dsh');
  });
});
