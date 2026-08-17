/**
 * Tests for page-ownership.ts — which OpenCues host owns a document.
 *
 * Run with: node --test dist/page-ownership.test.js
 *
 * The bug this exists to prevent, verified live on DeepSeek Harness with the
 * chrome extension also installed: both hosts drove the same composer, and
 * the extension (keyless on a fresh profile) won the race and wrote
 * `[OpenCues: no API key — open the extension popup]` over the plugin's
 * answer. An error about a credential that host does not need.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { PAGE_HOST_ATTR, claimPage, pageClaimedBy, pageClaimedByOther } from './page-ownership';

// Minimal documentElement stand-in. Deliberately not jsdom: the module's
// whole surface is three attribute operations, and the no-DOM path below has
// to be exercised with `document` genuinely absent.
function installFakeDocument(): void {
  const attrs = new Map<string, string>();
  (globalThis as Record<string, unknown>).document = {
    documentElement: {
      setAttribute: (k: string, v: string) => { attrs.set(k, v); },
      getAttribute: (k: string) => (attrs.has(k) ? attrs.get(k)! : null),
      removeAttribute: (k: string) => { attrs.delete(k); },
    },
  };
}

describe('page ownership', () => {
  beforeEach(installFakeDocument);
  afterEach(() => { delete (globalThis as Record<string, unknown>).document; });

  it('an unclaimed page is owned by nobody, and nobody defers', () => {
    // The ordinary case — a normal web page with only the extension present.
    // Getting this wrong would disable the extension everywhere.
    assert.strictEqual(pageClaimedBy(), null);
    assert.strictEqual(pageClaimedByOther('chrome'), false);
  });

  it('a claim is visible to a different host', () => {
    claimPage('dsh');
    assert.strictEqual(pageClaimedBy(), 'dsh');
    assert.strictEqual(pageClaimedByOther('chrome'), true);
  });

  it('a host never defers to itself', () => {
    // Otherwise re-entrancy (a remount re-claiming) would make a host stand
    // down against its own marker and go inert.
    claimPage('dsh');
    assert.strictEqual(pageClaimedByOther('dsh'), false);
  });

  it('claiming is idempotent', () => {
    claimPage('dsh');
    claimPage('dsh');
    assert.strictEqual(pageClaimedBy(), 'dsh');
  });

  it('the disposer retracts our own claim', () => {
    const release = claimPage('dsh');
    release();
    assert.strictEqual(pageClaimedBy(), null);
    assert.strictEqual(pageClaimedByOther('chrome'), false);
  });

  it('the disposer does NOT retract a claim another host has since made', () => {
    // Handing the page to nobody would silently re-enable the very
    // double-driving this module prevents.
    const release = claimPage('dsh');
    claimPage('some-other-host');
    release();
    assert.strictEqual(pageClaimedBy(), 'some-other-host');
  });

  it('uses an attribute, not a global — the two hosts are in different worlds', () => {
    // Load-bearing: a chrome content script has its own `window`, so any
    // global handshake is invisible across the boundary. Only the shared
    // document can carry this.
    claimPage('dsh');
    const el = (globalThis as unknown as { document: { documentElement: { getAttribute(k: string): string | null } } })
      .document.documentElement;
    assert.strictEqual(el.getAttribute(PAGE_HOST_ATTR), 'dsh');
  });

  it('an empty or whitespace attribute reads as unclaimed', () => {
    claimPage('   ');
    assert.strictEqual(pageClaimedBy(), null);
    assert.strictEqual(pageClaimedByOther('chrome'), false);
  });
});

describe('page ownership — no DOM', () => {
  // Core is imported by Node hosts (CC, OpenCode, gemini-cli, shell) where
  // `document` does not exist. These must no-op rather than throw, so a
  // shared boot path can call them without branching on the host.
  it('claimPage no-ops and returns a callable disposer', () => {
    assert.strictEqual(typeof globalThis.document, 'undefined');
    const release = claimPage('claude-code');
    assert.strictEqual(typeof release, 'function');
    release();
  });

  it('nobody owns a page that does not exist, and nobody defers', () => {
    assert.strictEqual(pageClaimedBy(), null);
    assert.strictEqual(pageClaimedByOther('claude-code'), false);
  });
});
