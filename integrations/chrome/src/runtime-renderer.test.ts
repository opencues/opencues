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

  it('the note wraps (pre-wrap + a bounded max-width) so a long note grows into extra rows, not off-screen', () => {
    const target = document.createElement('div');
    target.setAttribute('contenteditable', 'true');
    target.innerHTML = '<div>line one</div><div>line two</div>';
    document.body.appendChild(target);

    const LONG = { text: 'a rather wordy setting description that would run off the right edge on one line', spanStart: 0, spanEnd: 8 };
    applyDirectives(target, [{ inlineNote: LONG }], 'node');

    const note = document.getElementById('oc-inline-note') as HTMLElement;
    expect(note).not.toBeNull();
    // pre-wrap enables wrapping; a max-width bounds it (floored to 160px when
    // the field rect is unavailable, as in jsdom). Together they make a long
    // note wrap DOWNWARD instead of overflowing horizontally.
    expect(note.style.whiteSpace).toBe('pre-wrap');
    expect(note.style.maxWidth).toMatch(/px$/);
    expect(parseFloat(note.style.maxWidth)).toBeGreaterThanOrEqual(160);
  });

  // ── Margin push-down (managed editors — claude.ai/ProseMirror) ───────────
  // A node inserted into a managed editor gets reverted, and (crucially) we
  // don't own its send button so a real inserted line would ship in the
  // message. Mid-buffer we open the row with a STYLESHEET RULE (PM can't revert
  // what it can't observe) rather than an inline child style (which it reverts).
  it('Margin mode mid-buffer — opens the row via a stylesheet rule (NOT inline child style, NOT a node)', () => {
    const target = document.createElement('div');
    target.className = 'ProseMirror';
    target.setAttribute('contenteditable', 'true');
    target.innerHTML = '<p>line one</p><p>line two</p>';
    document.body.appendChild(target);

    applyDirectives(target, [{ inlineNote: NOTE }], 'margin');

    // No spacer node (would be reverted / could ship).
    expect(document.querySelector('[data-oc-note-spacer]')).toBeNull();
    // No inline margin on the child (PM would revert that).
    const p1 = target.children[0] as HTMLElement;
    expect(p1.style.marginBottom).toBe('');
    // The editor is marked and a scoped stylesheet rule targets line one (nth-child 1).
    expect(target.getAttribute('data-oc-editor')).toBe('1');
    const sheet = document.getElementById('oc-push-style') as HTMLStyleElement;
    expect(sheet).not.toBeNull();
    expect(sheet.textContent).toContain(':nth-child(1)');
    expect(sheet.textContent).toContain('margin-bottom');
  });

  it('Margin mode — single <p> with NO following sibling (claude.ai one-line shape): grows the EDITOR via padding, not the swallowed last-child margin', () => {
    const target = document.createElement('div');
    target.className = 'ProseMirror';
    target.setAttribute('contenteditable', 'true');
    target.innerHTML = '<p>thanks a bunch buddy</p>'; // sole paragraph, no sibling
    document.body.appendChild(target);

    applyDirectives(target, [{ inlineNote: NOTE }], 'margin');

    const p = target.firstElementChild as HTMLElement;
    // A bottom margin on the last child is swallowed → don't use it.
    expect(p.style.marginBottom).toBe('');
    // Editor root grew instead.
    expect(target.style.paddingBottom).not.toBe('');
  });

  it('Margin mode — no per-line sub-block (single paragraph = text in root): grows the EDITOR via padding-bottom', () => {
    // ProseMirror single-paragraph shape where the caret line has no block
    // ancestor distinct from the editor root — grow the root itself so a row
    // opens below the (only / last) line.
    const target = document.createElement('div');
    target.className = 'ProseMirror';
    target.setAttribute('contenteditable', 'true');
    target.appendChild(document.createTextNode('thanks a bunch buddy')); // direct text, no <p>
    document.body.appendChild(target);

    applyDirectives(target, [{ inlineNote: NOTE }], 'margin');

    expect(document.querySelector('[data-oc-note-spacer]')).toBeNull();
    expect(target.style.paddingBottom).not.toBe(''); // editor grew
    // Clearing restores it.
    applyDirectives(target, [{}], 'margin');
    expect(target.style.paddingBottom).toBe('');
  });

  it('Margin mode mid-buffer NESTED (Draft.js shape) — nudges the line block whose sibling is the next line, anchored to its real parent', () => {
    // Draft.js nests each line: content > div[data-block] > div > span > text.
    // The NEAREST block to the caret is an only-child inner div (no sibling);
    // the real line block (sibling = next line) is one level up. The rule must
    // anchor nth-child to the line block's actual parent (the contents wrapper),
    // NOT the editor root.
    const target = document.createElement('div');
    target.className = 'public-DraftEditor-content';
    target.setAttribute('contenteditable', 'true');
    const contents = document.createElement('div');
    contents.setAttribute('data-contents', 'true');
    target.appendChild(contents);
    const mkLine = (txt: string): HTMLElement => {
      const block = document.createElement('div'); block.setAttribute('data-block', 'true');
      const inner = document.createElement('div');
      const span = document.createElement('span');
      span.appendChild(document.createTextNode(txt));
      inner.appendChild(span); block.appendChild(inner);
      return block;
    };
    contents.appendChild(mkLine('line one'));
    contents.appendChild(mkLine('line two'));
    document.body.appendChild(target);

    applyDirectives(target, [{ inlineNote: NOTE }], 'margin');

    expect(document.querySelector('[data-oc-note-spacer]')).toBeNull();
    // The CONTENTS wrapper (line block's real parent) is marked — NOT the editor root.
    expect(contents.getAttribute('data-oc-editor')).toBe('1');
    expect(target.hasAttribute('data-oc-editor')).toBe(false);
    // Root padding was NOT used (that's the bug this pins).
    expect(target.style.paddingBottom).toBe('');
    const sheet = document.getElementById('oc-push-style') as HTMLStyleElement;
    expect(sheet.textContent).toContain(':nth-child(1)'); // line one is the 1st data-block
    expect(sheet.textContent).toContain('margin-bottom');
  });

  it('Margin mode — soft <br> line below (LinkedIn comments): no push, note becomes an OPAQUE cover (no spacer, no fighting Quill)', () => {
    // Line 1 and line 2 are <br>-separated in one block. Verified live: CSS can't
    // give a <br> a box, a node is reconciled away by Quill (resets the caret),
    // and Quill's instance is unreachable. So DON'T mutate the DOM — render the
    // note opaque so it cleanly covers line 2 instead.
    const target = document.createElement('div');
    target.className = 'ProseMirror';
    target.setAttribute('contenteditable', 'true');
    target.innerHTML = '<p>line one<br>hii</p>';
    document.body.appendChild(target);

    applyDirectives(target, [{ inlineNote: NOTE }], 'margin');

    // No DOM mutation of the editor at all.
    expect(document.querySelector('[data-oc-note-spacer]')).toBeNull();
    expect(target.style.paddingBottom).toBe('');
    expect(document.getElementById('oc-push-style')?.textContent ?? '').toBe('');
    // The note went to OPAQUE cover mode.
    const noteEl = document.getElementById('oc-inline-note') as HTMLElement;
    expect(noteEl).not.toBeNull();
    expect(noteEl.style.opacity).toBe('1');
    expect(noteEl.style.backgroundColor).not.toBe('');
    expect(noteEl.style.backgroundColor).not.toBe('transparent');
  });

  it('Margin mode — when a row DID open (last line, root-padding), the note stays TRANSPARENT (not a cover)', () => {
    const target = document.createElement('div');
    target.className = 'ProseMirror';
    target.setAttribute('contenteditable', 'true');
    target.innerHTML = '<p>only line</p>'; // last line → root-padding pushes
    document.body.appendChild(target);

    applyDirectives(target, [{ inlineNote: NOTE }], 'margin');

    expect(target.style.paddingBottom).not.toBe(''); // pushed
    const noteEl = document.getElementById('oc-inline-note') as HTMLElement;
    expect(noteEl.style.opacity).toBe('0.7');
    expect(noteEl.style.backgroundColor).toBe('transparent');
  });

  it('Margin mode mid-buffer — clearing empties the stylesheet rule AND unmarks the editor', () => {
    const target = document.createElement('div');
    target.className = 'ProseMirror';
    target.setAttribute('contenteditable', 'true');
    target.innerHTML = '<p>line one</p><p>line two</p>';
    document.body.appendChild(target);

    applyDirectives(target, [{ inlineNote: NOTE }], 'margin');
    const sheet = document.getElementById('oc-push-style') as HTMLStyleElement;
    expect(sheet.textContent).toContain('margin-bottom');
    expect(target.hasAttribute('data-oc-editor')).toBe(true);

    // Note gone (no directive) → rule emptied, editor unmarked.
    applyDirectives(target, [{}], 'margin');
    expect(sheet.textContent).toBe('');
    expect(target.hasAttribute('data-oc-editor')).toBe(false);
  });

  it('Margin mode — clearing the root-padding path restores the editor style exactly', () => {
    const target = document.createElement('div');
    target.className = 'ProseMirror';
    target.setAttribute('contenteditable', 'true');
    target.style.paddingBottom = '4px';
    target.innerHTML = '<p>only line</p>'; // no sibling → root-padding path
    document.body.appendChild(target);
    expect(target.style.paddingBottom).toBe('4px');

    applyDirectives(target, [{ inlineNote: NOTE }], 'margin');
    expect(target.style.paddingBottom).not.toBe('4px'); // grew

    applyDirectives(target, [{}], 'margin');
    expect(target.style.paddingBottom).toBe('4px'); // restored verbatim
  });
});
