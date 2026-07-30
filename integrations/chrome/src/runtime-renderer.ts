// CE.2 + CE.3 — translate runtime RenderDirectives into CSS Custom
// Highlight API ranges. Replaces the engine-walk in
// src/ui/highlight-renderer.ts.
//
// Inputs:
//   - target: the contenteditable the runtime is bound to.
//   - directives: array of { dimRanges?, highlight? } from
//     bootResult.collectRenderDirectives().
//
// Output: updates CSS.highlights for 'oc-base' / 'oc-dim' / 'oc-active'.
// All ranges are computed against the target's textContent in plain
// text (to match the runtime's offset coordinate system) and mapped
// back to DOM Range objects via a TreeWalker.

import type { RenderDirectives } from '@opencues/runtime/dist/src/adapter';
import { inlineNoteDisplayText } from '@opencues/runtime/dist/src/render-directives';
import { walkPlainText } from './dom-walk';

const hasHighlightAPI = typeof CSS !== 'undefined' && 'highlights' in CSS;

interface PlainRange { start: number; end: number; }

/** Build [start,end) DOM Ranges from plain-text [start,end) offsets.
 *  Uses walkPlainText so the offsets agree with the runtime's view of
 *  text — including \n at BR / block boundaries that have no Text
 *  node behind them. Highlights for a range that lands on a virtual
 *  \n are silently skipped (no Text node to anchor onto). */
function plainOffsetsToDomRanges(target: HTMLElement, offsets: PlainRange[]): Range[] {
  if (offsets.length === 0) return [];
  const { segments } = walkPlainText(target);
  const out: Range[] = [];
  for (const seg of segments) {
    // Skip IMG-emoji segments (`<img alt="👋">` on Gmail/Slack/etc.) —
    // dom-walk emits them so plain-text math agrees with the visible
    // string, but they're not real Text nodes (no `.data`) and a
    // browser Range can't anchor on the IMG character. Same policy
    // the doc-comment above already applies to virtual `\n` segments:
    // silently skip; the highlight just doesn't render on that glyph.
    if (seg.node.nodeType !== Node.TEXT_NODE) continue;
    for (const o of offsets) {
      if (o.end <= seg.plainStart || o.start >= seg.plainEnd) continue;
      const rangeStart = Math.max(o.start - seg.plainStart, 0);
      const rangeEnd = Math.min(o.end - seg.plainStart, seg.node.data.length);
      try {
        const range = new Range();
        range.setStart(seg.node, rangeStart);
        range.setEnd(seg.node, rangeEnd);
        out.push(range);
      } catch { /* skip — DOM mutated mid-walk */ }
    }
  }
  return out;
}

/**
 * Apply a batch of RenderDirectives to the target's CSS Highlights.
 * Idempotent — call on every render. The runtime delivers exactly
 * what should be on screen now. NO dedup: every call re-walks the
 * DOM and rebuilds Ranges. Reason: in tiptap/PM-managed
 * contenteditables, the editor's MutationObserver reconciles after
 * our writeText and replaces the Text nodes our Ranges point at;
 * dedup would let the post-cycle render short-circuit and leave
 * stale Ranges in place. Re-walking is cheap (single TreeWalker pass
 * over a typical chat-input subtree), so always-rebuild is the right
 * trade.
 */
export function applyDirectives(target: HTMLElement, directives: RenderDirectives[], pushMode: PushMode = 'none'): void {
  if (!hasHighlightAPI) return;

  const dimOffsets: PlainRange[] = [];
  const highlightOffsets: PlainRange[] = [];
  // Per-colour buckets — coloredRanges from BlankLoadingAnimator carry
  // an `rgb` field (chrome opts into 'render-rgb-color' capability so
  // boot-common picks the rgb path). Group by colour so we register one
  // Highlight per unique colour with all matching ranges.
  const coloredByHex = new Map<string, PlainRange[]>();
  for (const d of directives) {
    if (d.dimRanges) for (const r of d.dimRanges) dimOffsets.push({ start: r.start, end: r.end });
    if (d.highlight) highlightOffsets.push({ start: d.highlight.start, end: d.highlight.end });
    if (d.coloredRanges) {
      for (const cr of d.coloredRanges) {
        if (!cr.rgb) continue;
        const hex = cr.rgb.toLowerCase();
        let bucket = coloredByHex.get(hex);
        if (!bucket) { bucket = []; coloredByHex.set(hex, bucket); }
        bucket.push({ start: cr.start, end: cr.end });
      }
    }
  }

  // Walk DOM once, distributing matches into the right buckets.
  const dimRanges = plainOffsetsToDomRanges(target, dimOffsets);
  const activeRanges = plainOffsetsToDomRanges(target, highlightOffsets);

  // The default mid-tone colour comes from the .oc-attached CSS class
  // on the contenteditable itself (see content.css), NOT from an
  // oc-base highlight — that path used to cause "all white" flashes
  // when reconciliation invalidated the base Range mid-cycle.
  const Highlight = (window as { Highlight?: typeof globalThis.Highlight }).Highlight;
  const highlights = (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
  if (!Highlight) return;
  highlights.set('oc-dim', new Highlight(...dimRanges));
  highlights.set('oc-active', new Highlight(...activeRanges));

  // Inline cue note — the terminal splices a gray line under the span; CSS
  // Highlight can't inject text, so chrome paints the SAME note text as a
  // span-anchored overlay pinned just below the flagged span. Reuses the
  // runtime's inlineNote directive + inlineNoteDisplayText so the text +
  // cursor-gating are identical to the terminal.
  let note: RenderDirectives['inlineNote'] | undefined;
  for (const d of directives) { if (d.inlineNote) { note = d.inlineNote; break; } }
  if (note && note.text) renderInlineNote(target, note, pushMode);
  else clearInlineNote();

  // Per-colour loading highlights. Each unique colour gets a Highlight
  // named `oc-load-RRGGBB` (the hex without `#`). The CSS rule for
  // that name is injected on demand via ensureLoadingColorStyle so the
  // CSS Custom Highlight engine has a `color:` to paint with.
  // Cache the set of colours we've seen so we can DROP stale ones when
  // an animator stops — otherwise old colours linger in the highlights
  // map and the stylesheet grows monotonically.
  for (const seen of _knownLoadingHexes) {
    if (!coloredByHex.has(seen)) {
      highlights.delete(`oc-load-${seen.slice(1)}`);
    }
  }
  _knownLoadingHexes.clear();
  for (const [hex, ranges] of coloredByHex) {
    _knownLoadingHexes.add(hex);
    ensureLoadingColorStyle(hex);
    const domRanges = plainOffsetsToDomRanges(target, ranges);
    highlights.set(`oc-load-${hex.slice(1)}`, new Highlight(...domRanges));
  }
}

// Tracks every `#hex` we've registered a Highlight for in the current
// render cycle. The applyDirectives next-cycle path uses it to GC any
// colours that fell out of the active set (animator stopped) so the
// CSS Custom Highlight map stays small.
const _knownLoadingHexes = new Set<string>();

const LOADING_STYLE_ID = 'oc-loading-color-styles';

/** Inject (idempotently) a `::highlight(oc-load-RRGGBB)` rule for the
 *  given hex so the CSS engine has a colour to paint matching ranges. */
function ensureLoadingColorStyle(hex: string): void {
  const name = `oc-load-${hex.slice(1)}`;
  let sheet = document.getElementById(LOADING_STYLE_ID) as HTMLStyleElement | null;
  if (!sheet) {
    sheet = document.createElement('style');
    sheet.id = LOADING_STYLE_ID;
    document.head.appendChild(sheet);
  }
  const rule = `::highlight(${name}) { color: ${hex} !important; }`;
  // Cheap dedup — search the existing text for the rule.
  if ((sheet.textContent ?? '').includes(rule)) return;
  sheet.appendChild(document.createTextNode(rule + '\n'));
}

// ─── Inline cue note overlay ─────────────────────────────────────────────
// A single reused, absolutely-positioned gray element pinned just below the
// flagged span. Anchored to the span's DOM range (getBoundingClientRect) and
// repositioned on scroll/resize, so it reads as text under the span rather
// than a floating card. pointer-events:none so it never blocks the editor.
// contenteditable only — normal inputs skip render entirely.
const NOTE_EL_ID = 'oc-inline-note';
let _noteEl: HTMLDivElement | null = null;
let _noteRange: Range | null = null;
let _repositionHooked = false;

function repositionNote(): void {
  if (!_noteEl || _noteEl.style.display === 'none' || !_noteRange) return;
  try {
    const rect = _noteRange.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) { _noteEl.style.display = 'none'; return; }
    _noteEl.style.left = `${Math.round(rect.left)}px`;
    _noteEl.style.top = `${Math.round(rect.bottom)}px`;
  } catch { /* range detached by a DOM mutation — leave last position */ }
}

function ensureNoteEl(): HTMLDivElement {
  if (_noteEl && _noteEl.isConnected) return _noteEl;
  const el = document.createElement('div');
  el.id = NOTE_EL_ID;
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = [
    'position:fixed', 'z-index:2147483646', 'pointer-events:none',
    // pre-wrap (not pre): a long note WRAPS within its max-width and grows
    // into extra rows instead of running off the right edge. overflow-wrap
    // breaks a single over-long token so it can't overflow either. The
    // per-render max-width (set in renderInlineNote) is what actually bounds
    // the wrap; without it pre-wrap alone still lays out on one line.
    'white-space:pre-wrap', 'overflow-wrap:anywhere',
    'background:transparent', 'margin:0', 'padding:0',
    'color:#6b7280', 'opacity:0.7',
  ].join(';');
  (document.body || document.documentElement).appendChild(el);
  _noteEl = el;
  if (!_repositionHooked) {
    _repositionHooked = true;
    window.addEventListener('scroll', repositionNote, true);
    window.addEventListener('resize', repositionNote, true);
  }
  return el;
}

// ── Push-down (make room for the note so it doesn't occlude line 2) ───────
// Two mechanisms, picked by the caller's push mode:
//
//  'node'   — PLAIN contenteditables (Gmail / YouTube). Insert an EMPTY,
//             non-editable block right after the span's line so content below
//             moves DOWN by a row. The spacer carries no text, so it never
//             reaches the submitted buffer; walkPlainText skips it by its data
//             attribute so it can't shift offsets.
//
//  'margin' — MANAGED editors (ProseMirror/Lexical/Quill — claude.ai, etc.).
//             A node inserted into these gets REVERTED by their MutationObserver,
//             AND — critically — we don't own their send button, so a real
//             inserted line would SHIP in the user's message. So we open the row
//             with CSS layout only (never document content — can't ship, no undo
//             entry). Two levers, both chosen to survive the editor's reconciler:
//               • mid-buffer (caret line has a following sibling to push): a
//                 STYLESHEET RULE targeting that paragraph by position. PM's
//                 MutationObserver reverts inline styles on child nodes it owns,
//                 but it can't see (or revert) an external stylesheet — so the
//                 margin holds. (Inline child margin was tried first and PM
//                 reverted it — see git history.)
//               • last/only line (margin on a last child is swallowed anyway):
//                 grow the editor ROOT via inline `padding-bottom`. PM doesn't
//                 reconcile its own root element's style, so this holds.
//             Either way, if a specific editor still reverts it the row just
//             doesn't open and the note floats — never unsafe.
//
//  'none'   — textareas / normal inputs (render is skipped entirely upstream).
export type PushMode = 'node' | 'margin' | 'none';

const NOTE_SPACER_ATTR = 'data-oc-note-spacer';
const EDITOR_MARK_ATTR = 'data-oc-editor';
const PUSH_STYLE_ID = 'oc-push-style';
let _noteSpacer: HTMLElement | null = null;
// Inline-nudge bookkeeping (root-padding path): the element, WHICH style
// property, and its prior inline value — so clear restores it EXACTLY.
let _nudgedBlock: HTMLElement | null = null;
let _nudgedProp: 'marginBottom' | 'paddingBottom' | null = null;
let _nudgedPrevValue = '';
// Stylesheet-rule bookkeeping (mid-buffer path): the <style> element carrying
// the margin rule + the editor we marked, so clear empties the rule + unmarks.
let _pushStyleEl: HTMLStyleElement | null = null;
let _markedEditor: HTMLElement | null = null;

function ensurePushStyleEl(): HTMLStyleElement {
  if (_pushStyleEl && _pushStyleEl.isConnected) return _pushStyleEl;
  let el = document.getElementById(PUSH_STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = PUSH_STYLE_ID;
    (document.head || document.documentElement).appendChild(el);
  }
  _pushStyleEl = el;
  return el;
}

/** Undo any push-down currently in effect (node spacer, root-padding inline
 *  nudge, OR the mid-buffer stylesheet rule). */
function clearPushDown(): void {
  if (_noteSpacer) { try { _noteSpacer.remove(); } catch { /* detached */ } }
  _noteSpacer = null;
  if (_nudgedBlock && _nudgedProp) {
    try { _nudgedBlock.style[_nudgedProp] = _nudgedPrevValue; } catch { /* detached */ }
  }
  _nudgedBlock = null;
  _nudgedProp = null;
  _nudgedPrevValue = '';
  if (_pushStyleEl) { try { _pushStyleEl.textContent = ''; } catch { /* detached */ } }
  if (_markedEditor) { try { _markedEditor.removeAttribute(EDITOR_MARK_ATTR); } catch { /* detached */ } }
  _markedEditor = null;
}

function isBlockEl(el: HTMLElement): boolean {
  if (el.tagName === 'DIV' || el.tagName === 'P' || el.tagName === 'LI') return true;
  try {
    const disp = getComputedStyle(el).display;
    return disp === 'block' || disp === 'flex' || disp === 'list-item';
  } catch { return false; }
}

/** Nearest block-level ancestor of `node` within `root` (the line's block). */
function blockAncestorWithin(node: Node, root: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
  while (el && el !== root) {
    if (isBlockEl(el)) return el;
    el = el.parentElement;
  }
  return null;
}

/** The block to nudge so the NEXT visual line moves down: walking UP from the
 *  caret (within `root`), the FIRST block ancestor that has a following element
 *  sibling (ignoring our own spacer). Editors nest the caret's line under
 *  wrappers — Draft.js in particular makes the NEAREST block an only-child
 *  content div (no sibling), while the real line block (with the next line as
 *  its sibling) is one level up; ProseMirror's `<p>` has its sibling directly.
 *  Null → no block ancestor has a sibling → the caret is on the last line. */
function lineBlockWithSibling(node: Node, root: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
  while (el && el !== root) {
    if (isBlockEl(el)) {
      const sib = el.nextElementSibling as HTMLElement | null;
      if (sib && !sib.hasAttribute(NOTE_SPACER_ATTR)) return el;
    }
    el = el.parentElement;
  }
  return null;
}

/** The first `<br>` or block-level element in document order strictly AFTER
 *  `node`, within `root`. This is the boundary that terminates the span's
 *  visual line when the line is direct text in the contenteditable root
 *  (Gmail / YouTube leave the FIRST line unwrapped and only wrap later lines
 *  in `<div>`s). querySelectorAll returns document order, so the first
 *  candidate that FOLLOWS `node` is the nearest line boundary below the span.
 *  Ancestors are excluded (they CONTAIN, not FOLLOW). Null → the span is on
 *  the last line with nothing below it, so there's nothing to occlude. */
function firstLineBreakAfter(node: Node, root: HTMLElement): HTMLElement | null {
  const candidates = root.querySelectorAll('br, div, p, li');
  for (const c of candidates) {
    if (node.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) {
      return c as HTMLElement;
    }
  }
  return null;
}

function makeSpacer(heightPx: number): HTMLElement {
  const spacer = document.createElement('div');
  spacer.setAttribute(NOTE_SPACER_ATTR, '1');
  spacer.setAttribute('contenteditable', 'false');
  spacer.setAttribute('aria-hidden', 'true');
  spacer.style.cssText =
    `display:block;height:${Math.max(1, Math.round(heightPx))}px;margin:0;padding:0;border:0;` +
    'user-select:none;pointer-events:none;background:transparent;';
  return spacer;
}

function insertNoteSpacer(target: HTMLElement, range: Range, heightPx: number): boolean {
  clearPushDown();
  const spacer = makeSpacer(heightPx);
  // Shape B — the span's line IS a per-line block element (Gmail's wrapped
  // lines, YouTube-with-blocks): insert the blank row right after it.
  const block = blockAncestorWithin(range.endContainer, target);
  if (block && block !== target && block.parentNode) {
    try { block.after(spacer); _noteSpacer = spacer; return true; } catch { return false; }
  }
  // Shape A — the span's line is direct text in the contenteditable root
  // (Gmail / YouTube first line). There's no wrapping block to insert after,
  // so anchor to the line's terminating <br> (insert after it) or the next
  // block (insert before it). Either way a blank block row lands directly
  // below the span's line and pushes the rest down by one line.
  const boundary = firstLineBreakAfter(range.endContainer, target);
  if (!boundary || !boundary.parentNode) return false; // last line — nothing below
  try {
    if (boundary.tagName === 'BR') boundary.after(spacer);
    else boundary.before(spacer);
    _noteSpacer = spacer;
    return true;
  } catch { return false; }
}

/** Managed-editor push-down: open a row below the caret's line via inline STYLE
 *  only — no document content (can't ship, walkPlainText ignores styles) and no
 *  editor transaction (no undo entry). If the editor reverts the style it just
 *  doesn't hold and the note floats — never unsafe.
 *
 *  Two paths: (1) when the caret's line has its OWN block ancestor inside the
 *  editor, nudge THAT block's `margin-bottom` so everything after it moves down
 *  (correct mid-buffer). (2) When the line has no sub-block — text sits directly
 *  in the editor root, or the block IS the root (common on single-paragraph
 *  ProseMirror) — grow the EDITOR itself via `padding-bottom` so a row opens
 *  below the (single / last) line. Nudging the root's own style is also less
 *  likely to be reverted than a child node's. */
function insertMarginPush(target: HTMLElement, range: Range, heightPx: number): boolean {
  clearPushDown();
  const px = Math.max(1, Math.round(heightPx));
  // Mid-buffer: find the LINE block whose next sibling is the line below, then
  // nudge its margin-bottom to push that sibling down. Apply via a STYLESHEET
  // RULE targeting the block by position among ITS OWN parent's children —
  // editors nest lines to varying depths (Draft.js wraps each line several
  // divs deep), so we anchor the nth-child to the block's real parent, not the
  // editor root. A stylesheet (not an inline style) because PM/Lexical/Quill
  // revert inline styles on child nodes they own but can't see a stylesheet.
  const lineBlock = lineBlockWithSibling(range.endContainer, target);
  const container = lineBlock ? lineBlock.parentElement : null;
  if (lineBlock && container) {
    const idx = Array.prototype.indexOf.call(container.children, lineBlock) + 1; // 1-based nth-child
    if (idx >= 1) {
      try {
        if (_markedEditor && _markedEditor !== container) _markedEditor.removeAttribute(EDITOR_MARK_ATTR);
        container.setAttribute(EDITOR_MARK_ATTR, '1');
        _markedEditor = container;
        const sheet = ensurePushStyleEl();
        // Scope to the marked container; !important so the editor's own margin
        // (if any) doesn't out-specify us.
        sheet.textContent =
          `[${EDITOR_MARK_ATTR}] > :nth-child(${idx}) { margin-bottom: ${px}px !important; }`;
        return true;
      } catch { /* fall through to root-padding */ }
    }
  }
  // No block with a following sibling. Look at what's below the caret:
  const lineBelow = firstLineBreakAfter(range.endContainer, target); // <br>/block after the caret
  //  (a) A line BELOW the caret with no block to margin (soft `<br>` break —
  //      LinkedIn comments). Verified live: CSS can't give a `<br>` a box, a
  //      spacer/`<br>` node is reconciled away by Quill (resets the caret), and
  //      Quill's instance/API is unreachable (no __quill, no global Quill). So
  //      there is no way to open a real gap here. Return false → the caller
  //      renders the note as an OPAQUE COVER over the line below instead of a
  //      transparent overlay that mangles it.
  if (lineBelow) return false;
  //  (c) The caret is on the LAST visual line — grow the editor ROOT via inline
  //      padding-bottom so a row opens below it (PM doesn't reconcile its root).
  //      ADDITIVE: keep the editor's existing bottom padding (its normal
  //      breathing room — ChatGPT's ProseMirror has ~16px) and add ONE line on
  //      top, otherwise we'd replace its padding and grow by less than a line
  //      (ChatGPT opened only ~10px of a 26px line). clearPushDown() at the top
  //      of this fn restored the base inline padding first, so getComputedStyle
  //      reads the editor's OWN padding, not our previous nudge (no compounding).
  let basePB = 0;
  try { const v = parseFloat(getComputedStyle(target).paddingBottom); if (Number.isFinite(v)) basePB = v; } catch { /* 0 */ }
  _nudgedBlock = target;
  _nudgedProp = 'paddingBottom';
  _nudgedPrevValue = target.style.paddingBottom;
  try { target.style.paddingBottom = `${Math.round(basePB + px)}px`; return true; }
  catch { _nudgedBlock = null; _nudgedProp = null; return false; }
}

function renderInlineNote(
  target: HTMLElement,
  note: { spanStart: number; spanEnd: number; text: string },
  pushMode: PushMode,
): void {
  const ranges = plainOffsetsToDomRanges(target, [{ start: note.spanStart, end: note.spanEnd }]);
  if (ranges.length === 0) { clearInlineNote(); return; }
  const range = ranges[0];
  let rect: DOMRect;
  try { rect = range.getBoundingClientRect(); } catch { clearInlineNote(); return; }
  if (rect.width === 0 && rect.height === 0) { clearInlineNote(); return; }
  const el = ensureNoteEl();
  el.textContent = inlineNoteDisplayText(note.text);
  el.style.display = 'block'; // ensure it's laid out so we can measure it below
  // Inherit the field's typography so the note reads as part of the text line.
  let lineHeightPx = rect.height;
  try {
    const cs = getComputedStyle(target);
    el.style.fontFamily = cs.fontFamily;
    el.style.fontSize = cs.fontSize;
    el.style.lineHeight = cs.lineHeight;
    const lh = parseFloat(cs.lineHeight);
    if (!Number.isNaN(lh) && lh > 0) lineHeightPx = lh;
  } catch { /* computed style unavailable — keep defaults */ }
  // The gap must fit the NOTE — which is now however many rows the note wraps
  // to within its max-width (set below), not a fixed single line. Measure the
  // note's OWN rendered height rather than trusting the field's line-height:
  // robust to `line-height: normal` (parseFloat → NaN) and to any note/field
  // metric mismatch, and it naturally captures the multi-line height once the
  // note wraps. Fall back to the field line-height / span height when layout
  // is unavailable (jsdom returns 0 → a one-line estimate).
  // Reset to the note's NATURAL size before measuring — a previous render may
  // have set an explicit height/width (cover mode), and measuring that back
  // would compound (the cover grew taller every tick — the "2x" bug).
  el.style.height = 'auto';
  el.style.width = 'auto';
  el.style.paddingLeft = '0';
  el.style.boxSizing = 'content-box';
  // Bound the wrap to the field's text column: from the span's left edge to
  // the field's right edge. A long note then wraps DOWNWARD into extra rows
  // rather than running off the right of the viewport. Floored so a span near
  // the right edge still gets a usable width (it may extend a little past the
  // field edge, but never off-screen). Set BEFORE measuring so noteH already
  // reflects the wrapped, multi-line height — the push-down keys off it, so the
  // gap auto-grows to fit however many rows the note needs.
  let maxNoteW = 0;
  try {
    const fr = target.getBoundingClientRect();
    maxNoteW = Math.max(160, Math.round(fr.right - rect.left - 2));
  } catch { /* no field rect — leave uncapped */ }
  el.style.maxWidth = maxNoteW > 0 ? `${maxNoteW}px` : 'none';
  let pushPx = lineHeightPx;
  try {
    const noteH = el.getBoundingClientRect().height;
    if (noteH > 0) pushPx = noteH;
  } catch { /* keep lineHeightPx */ }
  // Reserve a real row so content moves down, then re-read the span rect
  // (layout shifted) and drop the note in the freed gap. 'node' for plain
  // contenteditables, 'margin' for managed editors; either falls back to a
  // floating note when it can't take effect.
  const pushed =
    pushMode === 'node' ? insertNoteSpacer(target, range, pushPx)
    : pushMode === 'margin' ? insertMarginPush(target, range, pushPx)
    : false;
  if (pushed) {
    // A real row opened below the span — drop the note into it as a plain,
    // transparent, content-width note.
    try { rect = range.getBoundingClientRect(); } catch { /* keep prior rect */ }
    el.style.backgroundColor = 'transparent';
    el.style.opacity = '0.7';
    el.style.width = 'auto';
    el.style.height = 'auto';
    el.style.paddingLeft = '0';
    el.style.left = `${Math.round(rect.left)}px`;
  } else {
    clearPushDown();
    const hasLineBelow = !!firstLineBreakAfter(range.endContainer, target);
    if (hasLineBelow) {
      // Couldn't open a gap but there IS a line right below (soft `<br>` in a
      // managed editor with a hidden instance — verified no safe way to push).
      // Render the note as an OPAQUE COVER over that line: same background colour
      // as the field, one line tall, wide enough to hide line 2 — so it reads as
      // the note replacing that line while the caret is in the span, not a
      // garbled overlap. Cursor-gated, so line 2 reappears when the caret leaves.
      let fieldRect: DOMRect | null = null;
      try { fieldRect = target.getBoundingClientRect(); } catch { /* keep null */ }
      // A few px of extra coverage on the LEFT and BOTTOM so glyphs of the line
      // below (descenders, left-edge antialiasing) don't bleed out of the box.
      // padding-left keeps the note TEXT at the span column while the box extends
      // left; box-sizing:border-box folds it into the width/height.
      const COVER_PAD = 3;
      el.style.boxSizing = 'border-box';
      el.style.backgroundColor = effectiveBackgroundColor(target);
      el.style.opacity = '1';
      el.style.paddingLeft = `${COVER_PAD}px`;
      el.style.height = `${Math.round(pushPx + COVER_PAD)}px`;
      el.style.left = `${Math.round(rect.left - COVER_PAD)}px`;
      // Extend to the field's right edge (+ the left pad) so the whole line below is covered.
      el.style.width = (fieldRect && fieldRect.right > rect.left)
        ? `${Math.round(fieldRect.right - rect.left + COVER_PAD)}px` : 'auto';
    } else {
      // Nothing below the span — no occlusion to fix; float transparently.
      el.style.backgroundColor = 'transparent';
      el.style.opacity = '0.7';
      el.style.width = 'auto';
      el.style.height = 'auto';
      el.style.paddingLeft = '0';
      el.style.left = `${Math.round(rect.left)}px`;
    }
  }
  el.style.top = `${Math.round(rect.bottom)}px`;
  el.style.display = 'block';
  _noteRange = range;
}

/** The nearest non-transparent background colour up the ancestor chain from
 *  `el` — used to make the inline note OPAQUE so it can cleanly cover the line
 *  below on surfaces where a real push-down isn't possible. White fallback. */
function effectiveBackgroundColor(el: HTMLElement): string {
  let cur: HTMLElement | null = el;
  while (cur) {
    try {
      const bg = getComputedStyle(cur).backgroundColor;
      if (bg && bg !== 'transparent' && !bg.endsWith(', 0)')) return bg;
    } catch { /* ignore */ }
    cur = cur.parentElement;
  }
  return '#ffffff';
}

/** Hide the inline note overlay (no flagged span under the caret, focus moved
 *  to a non-paintable field, or detach). Exported for the bootstrap's
 *  normal-input render short-circuit. */
export function clearInlineNote(): void {
  if (_noteEl) _noteEl.style.display = 'none';
  _noteRange = null;
  clearPushDown();
}

/** Tear down the runtime's highlights — called on detach/dispose. */
export function clearDirectives(): void {
  clearInlineNote();
  if (!hasHighlightAPI) return;
  const highlights = (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
  highlights.delete('oc-dim');
  highlights.delete('oc-active');
}
