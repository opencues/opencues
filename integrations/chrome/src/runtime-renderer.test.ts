// Pins applyDirectives behaviour:
//   1. Each call writes oc-dim + oc-active (no oc-base — that's the
//      .oc-attached CSS class on the element).
//   2. NO dedup: every call re-walks the DOM and re-sets both
//      highlights, even when inputs match the previous call. Reason:
//      tiptap/PM editors reconcile the DOM on a microtask after our
//      writeText, replacing the Text nodes our previously-built Ranges
//      pointed at. Dedup would let the post-cycle render short-circuit
//      and leave stale Ranges in place. We pay one DOM walk per render
//      and stay correct.
//
// Runs in jsdom; we shim the CSS Highlight API with a counting Map so
// the test can assert how many .set calls actually fired.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyDirectives, clearDirectives } from './runtime-renderer';
import type { RenderDirectives } from '@opencues/runtime/dist/src/adapter';

interface CountingHighlights extends Map<string, unknown> {
  setCalls: number;
}

function installHighlightShim(): CountingHighlights {
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

describe('runtime-renderer applyDirectives', () => {
  let highlights: CountingHighlights;

  beforeEach(() => {
    document.body.innerHTML = '';
    highlights = installHighlightShim();
    clearDirectives();
  });

  it('first call sets oc-dim + oc-active (no oc-base — handled by .oc-attached CSS)', () => {
    const target = makeTarget('hello world');
    applyDirectives(target, [{
      dimRanges: [{ start: 0, end: 5 }],
      highlight: { start: 6, end: 11 },
    }]);
    expect(highlights.setCalls).toBe(2);
    expect(highlights.has('oc-base')).toBe(false);
    expect(highlights.has('oc-dim')).toBe(true);
    expect(highlights.has('oc-active')).toBe(true);
  });

  it('identical second call ALSO writes — no dedup (post-reconcile re-walk must always run)', () => {
    const target = makeTarget('hello world');
    const dir: RenderDirectives = {
      dimRanges: [{ start: 0, end: 5 }],
      highlight: { start: 6, end: 11 },
    };
    applyDirectives(target, [dir]);
    expect(highlights.setCalls).toBe(2);
    applyDirectives(target, [dir]);
    // Pinned: every call re-sets both highlights so post-reconcile
    // re-walks always rebuild Ranges against the current Text nodes.
    expect(highlights.setCalls).toBe(4);
  });

  it('different dim range — re-walk + re-set (2 buckets per call)', () => {
    const target = makeTarget('hello world');
    applyDirectives(target, [{ dimRanges: [{ start: 0, end: 5 }] }]);
    applyDirectives(target, [{ dimRanges: [{ start: 6, end: 11 }] }]);
    expect(highlights.setCalls).toBe(4);
  });

  it('SAME-LENGTH text change with SAME ranges still re-walks (regression: 8.5f → 9.0f)', () => {
    // Cycling 8.5f → 9.0f keeps text length at 22 chars and offsets
    // identical, but DOM Text nodes get replaced by tiptap's
    // reconciliation. With dedup off, every call re-walks, so the new
    // Ranges land on the new Text nodes.
    const target = makeTarget('voice-mode active 8.5f');
    const dir: RenderDirectives = {
      dimRanges: [{ start: 0, end: 10 }, { start: 11, end: 17 }, { start: 18, end: 22 }],
      highlight: { start: 18, end: 22 },
    };
    applyDirectives(target, [dir]);
    expect(highlights.setCalls).toBe(2);
    target.textContent = 'voice-mode active 9.0f';
    applyDirectives(target, [dir]);
    expect(highlights.setCalls).toBe(4);
  });

  it('skips IMG-emoji segments without crashing (regression: forceRender failed on Gmail)', () => {
    // dom-walk emits one synthetic Text-shaped segment per <img alt="...">
    // so plain-text math agrees with the visible string on Gmail / Slack /
    // Twitter / Reddit / YouTube (they convert pasted emojis to <img>).
    // The renderer used to crash with "Cannot read properties of undefined
    // (reading 'length')" because IMG elements have no `.data` field —
    // visible as `forceRender failed {}` in /tmp/opencues.log after every
    // emoji-bearing TransformBlank rewrite. The diagnostic was useless
    // until serialiseLogData stopped JSON-stringifying Errors (which clears
    // their non-enumerable message/stack fields into "{}"). The fix here:
    // skip segments whose node isn't a real Text node, mirroring the
    // existing "virtual \n boundaries are silently skipped" policy in
    // plainOffsetsToDomRanges' doc-comment.
    const target = document.createElement('div');
    document.body.appendChild(target);
    target.appendChild(document.createTextNode('Hi '));
    const img = document.createElement('img');
    img.setAttribute('alt', '👋');
    target.appendChild(img);
    target.appendChild(document.createTextNode(' there'));
    // Highlight a range that straddles the IMG-segment — exactly the
    // pattern markdown-styling produced when bolding `Hi 👋 there`.
    expect(() => applyDirectives(target, [{
      highlight: { start: 0, end: 9 },
    }])).not.toThrow();
    // Highlight should still register; just no Range on the IMG glyph.
    expect(highlights.has('oc-active')).toBe(true);
  });

  it('clearDirectives drops oc-dim + oc-active from the map', () => {
    const target = makeTarget('hello');
    applyDirectives(target, [{ dimRanges: [{ start: 0, end: 5 }] }]);
    expect(highlights.has('oc-dim')).toBe(true);
    expect(highlights.has('oc-active')).toBe(true);
    clearDirectives();
    expect(highlights.has('oc-dim')).toBe(false);
    expect(highlights.has('oc-active')).toBe(false);
  });
});

// ── Inline-note push-down spacer ─────────────────────────────────────────
// The spacer is an empty contenteditable=false block inserted directly BELOW
// the flagged span's line so real content moves down (no occlusion, CC-style)
// on plain contenteditables. The Gmail/YouTube trap: the FIRST line is a
// direct text node in the contenteditable root, only LATER lines get wrapped
// in <div>s — so blockAncestorWithin finds no per-line block for the span and
// the spacer used to bail, leaving the note overlapping the line below. These
// pin both DOM shapes + the last-line (nothing-below) skip.
describe('runtime-renderer inline-note push-down spacer', () => {
  let origRangeRect: () => DOMRect;

  beforeEach(() => {
    document.body.innerHTML = '';
    installHighlightShim();
    clearDirectives();
    // jsdom's Range.getBoundingClientRect returns an all-zero rect, which the
    // note renderer treats as "off-screen" and bails before the spacer runs.
    // Shim a real rect so the push-down path executes.
    origRangeRect = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20, x: 0, y: 0, toJSON() { return this; } }) as DOMRect;
  });

  afterEach(() => {
    Range.prototype.getBoundingClientRect = origRangeRect;
    clearDirectives();
  });

  const NOTE = { text: 'more-formal', spanStart: 0, spanEnd: 8 };

  it('Shape B — span line is a per-line <div>: spacer lands right after it', () => {
    const target = document.createElement('div');
    target.setAttribute('contenteditable', 'true');
    target.innerHTML = '<div>line one</div><div>line two</div>';
    document.body.appendChild(target);

    applyDirectives(target, [{ inlineNote: NOTE }], 'node');

    const spacer = document.querySelector('[data-oc-note-spacer]');
    expect(spacer).not.toBeNull();
    // Sits between the two line blocks.
    expect((spacer!.previousElementSibling as HTMLElement)?.textContent).toBe('line one');
    expect((spacer!.nextElementSibling as HTMLElement)?.textContent).toBe('line two');
  });

  it('Shape A — span line is DIRECT text in the root (Gmail/YouTube first line): spacer lands before the next block', () => {
    const target = document.createElement('div');
    target.setAttribute('contenteditable', 'true');
    // First line unwrapped (direct text), second line wrapped — Gmail's shape.
    target.appendChild(document.createTextNode('line one'));
    const l2 = document.createElement('div');
    l2.textContent = 'line two';
    target.appendChild(l2);
    document.body.appendChild(target);

    applyDirectives(target, [{ inlineNote: NOTE }], 'node');

    const spacer = document.querySelector('[data-oc-note-spacer]');
    expect(spacer).not.toBeNull();
    // Inserted immediately before line two's block, after the direct text.
    expect(spacer!.nextElementSibling).toBe(l2);
  });

  it('Shape A with a <br> boundary: spacer lands after the <br>', () => {
    const target = document.createElement('div');
    target.setAttribute('contenteditable', 'true');
    target.appendChild(document.createTextNode('line one'));
    const br = document.createElement('br');
    target.appendChild(br);
    target.appendChild(document.createTextNode('line two'));
    document.body.appendChild(target);

    applyDirectives(target, [{ inlineNote: NOTE }], 'node');

    const spacer = document.querySelector('[data-oc-note-spacer]');
    expect(spacer).not.toBeNull();
    expect(spacer!.previousElementSibling).toBe(br);
  });

  it('last line (nothing below the span) inserts NO spacer — no occlusion to fix', () => {
    const target = document.createElement('div');
    target.setAttribute('contenteditable', 'true');
    target.textContent = 'line one';
    document.body.appendChild(target);

    applyDirectives(target, [{ inlineNote: NOTE }], 'node');

    expect(document.querySelector('[data-oc-note-spacer]')).toBeNull();
  });

  it("pushMode 'none' inserts NO spacer and no margin — note floats", () => {
    const target = document.createElement('div');
    target.setAttribute('contenteditable', 'true');
    target.innerHTML = '<div>line one</div><div>line two</div>';
    document.body.appendChild(target);

    applyDirectives(target, [{ inlineNote: NOTE }], 'none');

    expect(document.querySelector('[data-oc-note-spacer]')).toBeNull();
    const l1 = target.firstElementChild as HTMLElement;
    expect(l1.style.marginBottom).toBe(''); // no nudge
  });

  // ── Margin push-down (managed editors — claude.ai/ProseMirror) ───────────
  // A node inserted into a managed editor gets reverted, and (crucially) we
  // don't own its send button so a real inserted line would ship in the
  // message. Instead we nudge the containing block's bottom margin via inline
  // style: layout only, never document content, never an undo entry.
  it("Margin mode — nudges the span's containing block's margin-bottom, inserts NO node", () => {
    const target = document.createElement('div');
    target.className = 'ProseMirror';
    target.setAttribute('contenteditable', 'true');
    target.innerHTML = '<p>line one</p><p>line two</p>';
    document.body.appendChild(target);

    applyDirectives(target, [{ inlineNote: NOTE }], 'margin');

    // No spacer node (would be reverted / could ship).
    expect(document.querySelector('[data-oc-note-spacer]')).toBeNull();
    // Line one's <p> got a bottom-margin nudge; line two's did not.
    const p1 = target.children[0] as HTMLElement;
    const p2 = target.children[1] as HTMLElement;
    expect(p1.style.marginBottom).not.toBe('');
    expect(p2.style.marginBottom).toBe('');
  });

  it('Margin mode — clearing the note restores the block\'s prior margin exactly', () => {
    const target = document.createElement('div');
    target.className = 'ProseMirror';
    target.setAttribute('contenteditable', 'true');
    target.innerHTML = '<p style="margin-bottom: 4px">line one</p><p>line two</p>';
    document.body.appendChild(target);
    const p1 = target.children[0] as HTMLElement;
    expect(p1.style.marginBottom).toBe('4px');

    applyDirectives(target, [{ inlineNote: NOTE }], 'margin');
    expect(p1.style.marginBottom).not.toBe('4px'); // nudged

    // Note gone (no directive) → prior margin restored verbatim.
    applyDirectives(target, [{}], 'margin');
    expect(p1.style.marginBottom).toBe('4px');
  });
});
