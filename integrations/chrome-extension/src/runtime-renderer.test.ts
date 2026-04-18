// Pins the dedup behaviour of applyDirectives — calling it twice with
// the same (text, dimRanges, highlightRanges) tuple should NOT recreate
// the CSS Highlight objects. Without this, every keystroke flickered
// because we tore down + rebuilt three Highlights from scratch.
//
// Runs in jsdom; we shim the CSS Highlight API with a counting Map so
// the test can assert how many .set calls actually fired.

import { describe, it, expect, beforeEach } from 'vitest';
import { applyDirectives, clearDirectives } from './runtime-renderer';
import type { RenderDirectives } from 'opencues-runtime/dist/src/adapter';

interface CountingHighlights extends Map<string, unknown> {
  setCalls: number;
}

function installHighlightShim(): CountingHighlights {
  // jsdom doesn't ship the CSS Highlight API. Stub the lot:
  // - globalThis.Highlight constructor (ranges in, ignored)
  // - globalThis.CSS object with a writable `highlights` Map
  // The runtime-renderer's `hasHighlightAPI` check looks for
  // `'highlights' in CSS`, so the shim must satisfy that BEFORE the
  // module under test is loaded. Vitest's beforeEach runs after import,
  // so we set up the shim once per test and re-import is unnecessary
  // because applyDirectives reads CSS.highlights at call time.
  (globalThis as unknown as { Highlight: unknown }).Highlight =
    class { constructor(..._r: unknown[]) { /* no-op */ } };
  if (!(globalThis as unknown as { CSS?: unknown }).CSS) {
    (globalThis as unknown as { CSS: unknown }).CSS = {};
  }
  const map = new Map<string, unknown>() as CountingHighlights;
  map.setCalls = 0;
  const origSet = map.set.bind(map);
  map.set = (k: string, v: unknown) => {
    map.setCalls += 1;
    return origSet(k, v);
  };
  (globalThis as unknown as { CSS: { highlights: Map<string, unknown> } }).CSS.highlights = map;
  return map;
}

function makeTarget(text: string): HTMLElement {
  const el = document.createElement('div');
  el.textContent = text;
  document.body.appendChild(el);
  return el;
}

describe('runtime-renderer applyDirectives dedup', () => {
  let highlights: CountingHighlights;

  beforeEach(() => {
    document.body.innerHTML = '';
    highlights = installHighlightShim();
    clearDirectives();
  });

  it('first call sets all three highlight buckets', () => {
    const target = makeTarget('hello world');
    const dir: RenderDirectives = {
      dimRanges: [{ start: 0, end: 5 }],
      highlight: { start: 6, end: 11 },
    };
    applyDirectives(target, [dir]);
    // 3 set calls: oc-base, oc-dim, oc-active.
    expect(highlights.setCalls).toBe(3);
  });

  it('second call with identical input is a no-op', () => {
    const target = makeTarget('hello world');
    const dir: RenderDirectives = {
      dimRanges: [{ start: 0, end: 5 }],
      highlight: { start: 6, end: 11 },
    };
    applyDirectives(target, [dir]);
    expect(highlights.setCalls).toBe(3);
    applyDirectives(target, [dir]);
    // No additional set calls — dedup hit.
    expect(highlights.setCalls).toBe(3);
  });

  it('different dim range invalidates the cache', () => {
    const target = makeTarget('hello world');
    applyDirectives(target, [{ dimRanges: [{ start: 0, end: 5 }] }]);
    applyDirectives(target, [{ dimRanges: [{ start: 6, end: 11 }] }]);
    // Two distinct paint passes.
    expect(highlights.setCalls).toBe(6);
  });

  it('different text content invalidates the cache', () => {
    const target = makeTarget('hello');
    applyDirectives(target, [{ dimRanges: [{ start: 0, end: 5 }] }]);
    target.textContent = 'goodbye';
    applyDirectives(target, [{ dimRanges: [{ start: 0, end: 5 }] }]);
    expect(highlights.setCalls).toBe(6);
  });

  it('different highlight range invalidates the cache', () => {
    const target = makeTarget('alpha bravo');
    applyDirectives(target, [{ highlight: { start: 0, end: 5 } }]);
    applyDirectives(target, [{ highlight: { start: 6, end: 11 } }]);
    expect(highlights.setCalls).toBe(6);
  });

  it('switching target invalidates the cache', () => {
    const a = makeTarget('alpha');
    const b = makeTarget('alpha');
    applyDirectives(a, [{ dimRanges: [{ start: 0, end: 5 }] }]);
    applyDirectives(b, [{ dimRanges: [{ start: 0, end: 5 }] }]);
    // Even with identical content/ranges, target identity counts.
    expect(highlights.setCalls).toBe(6);
  });

  it('clearDirectives resets the cache so the next paint runs', () => {
    const target = makeTarget('hello');
    const dir: RenderDirectives = { dimRanges: [{ start: 0, end: 5 }] };
    applyDirectives(target, [dir]);
    expect(highlights.setCalls).toBe(3);
    clearDirectives();
    // Re-install shim — clearDirectives also calls .delete on the
    // highlights map; shim doesn't track deletes, but next applyDirectives
    // should re-set all three.
    highlights = installHighlightShim();
    applyDirectives(target, [dir]);
    expect(highlights.setCalls).toBe(3);
  });
});
