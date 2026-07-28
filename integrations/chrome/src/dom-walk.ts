// Plain-text view of a contenteditable that the runtime can reason about.
//
// The DOM doesn't include newlines for block boundaries — `textContent`
// returns "FirstSecond" for `<p>First</p><p>Second</p>`, fusing the
// last word of one block into the first word of the next. Runtime
// modules tokenise text on whitespace / punctuation, so without
// explicit \n at block boundaries adjacent words from different
// paragraphs collapse into one "word" and dim/active spans bleed
// across the BR / paragraph break.
//
// walkPlainText emits text + \n for BR and block-display elements,
// AND returns segment metadata so the renderer can map runtime offsets
// (which include the \n) back to DOM Ranges over actual text nodes.
//
// Used by:
//   - getText (opencues-bootstrap)
//   - readCursorOffset / writeCursorOffset (opencues-bootstrap)
//   - applyTextDiff (opencues-bootstrap) — for the "current" snapshot
//   - plainOffsetsToDomRanges (runtime-renderer)

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'LI', 'UL', 'OL', 'DL', 'DT', 'DD',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'PRE', 'HR',
  'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'MAIN',
  'TABLE', 'TR', 'TD', 'TH', 'THEAD', 'TBODY', 'TFOOT',
  'FIGURE', 'FIGCAPTION', 'ADDRESS', 'FIELDSET',
]);

export function isBlockElement(el: Element): boolean {
  if (BLOCK_TAGS.has(el.tagName)) return true;
  // Fallback to computed display for custom elements / styled spans.
  try {
    const d = getComputedStyle(el).display;
    return d === 'block' || d === 'list-item' || d === 'flex' ||
           d === 'grid' || d === 'flow-root' || d.startsWith('table');
  } catch {
    return false;
  }
}

export interface TextSegment {
  /** The Text node this segment refers to. */
  node: Text;
  /** Starting offset of this node's first character in the plain-text
   *  view (i.e. the value the runtime sees). */
  plainStart: number;
  /** Length of the node's data — equal to plainStart + node.data.length
   *  giving an exclusive end offset. Cached because callers iterate
   *  it many times per render. */
  plainEnd: number;
}

export interface WalkResult {
  /** Plain-text view with \n for BR and block boundaries. */
  text: string;
  /** Offset map — each Text node and its slice of the plain-text view. */
  segments: TextSegment[];
}

export function walkPlainText(root: HTMLElement): WalkResult {
  let text = '';
  const segments: TextSegment[] = [];
  let depth = 0;

  // Add a \n before content of a block element (if we're not at the
  // very start and the previous emit wasn't already a \n).
  const maybeAddBoundary = (): void => {
    if (text.length > 0 && !text.endsWith('\n')) text += '\n';
  };

  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node as Text;
      const data = t.data;
      if (data.length > 0) {
        const start = text.length;
        text += data;
        segments.push({ node: t, plainStart: start, plainEnd: start + data.length });
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    // OpenCues' inline-note spacer (a non-editable, empty push-down row we
    // insert on plain contenteditables) must be INVISIBLE to the plain-text
    // view — otherwise its block boundary would inject a spurious `\n` and
    // shift every offset after it. It carries no text, so skipping it whole
    // is safe and correct.
    if (el.hasAttribute('data-oc-note-spacer')) return;
    if (el.tagName === 'BR') {
      text += '\n';
      return;
    }
    // <img> rendered as emoji: many sites (Gmail, Slack, Twitter, Reddit)
    // convert pasted unicode emojis into <img class="emoji" alt="😊">
    // elements during paste handling. Without reading the alt, the
    // walker returns text WITHOUT emojis but WITH the surrounding
    // spaces — symptom: `Tu 😊 es` post-paste reads back as `Tu  es`,
    // every emoji wiped. We emit the alt content as a synthetic text
    // segment so the runtime sees what the user actually sees.
    if (el.tagName === 'IMG') {
      const alt = (el as HTMLImageElement).alt;
      if (alt && alt.length > 0) {
        const start = text.length;
        text += alt;
        // Pointer is the IMG element itself; downstream splice code
        // treats this as a special segment (no .data to mutate) and
        // routes to replaceAllText.
        segments.push({ node: el as unknown as Text, plainStart: start, plainEnd: start + alt.length });
      }
      return;
    }
    const isBlock = depth > 0 && isBlockElement(el);
    if (isBlock) maybeAddBoundary();
    depth++;
    for (const child of Array.from(node.childNodes)) visit(child);
    depth--;
  };

  // depth 0 = the contenteditable itself; we don't want a leading \n,
  // and we don't treat the root as a block boundary either.
  depth++;
  for (const child of Array.from(root.childNodes)) visit(child);
  depth--;

  return { text, segments };
}

/** Inverse of plainOffsetOfPosition. Given a plain-text offset (in the
 *  coordinate system walkPlainText produces), return the DOM position
 *  (container + offset) that maps to it. Handles all three cases:
 *
 *   1. Offset INSIDE a text node → returns {node: textNode, offset: relativeIdx}
 *   2. Offset at a virtual `\n` boundary (BR or block boundary) →
 *      returns {node: parentElement, offset: indexJustAfterTheBoundary}
 *   3. Offset PAST the entire plain-text length → returns end of root
 *
 *  The third case is the load-bearing one for trailing empty block
 *  elements (e.g. <div><br></div><div><br></div> tail of a Gmail
 *  contenteditable). walkPlainText counts each as a `\n` but they
 *  have no text node — Range.setStart(textNode, offset) can't reach
 *  them. We anchor the selection at the end of the root element
 *  instead, which the browser collapses to the last visible position.
 */
export function domPositionOfPlainOffset(
  root: HTMLElement,
  targetOffset: number,
): { node: Node; offset: number } {
  let plain = 0;
  let depth = 0;
  let result: { node: Node; offset: number } | null = null;
  // Mirror walkPlainText: BR emits `\n` unconditionally; block
  // boundaries emit only when last wasn't a newline.
  let lastWasNewline = false;

  const visit = (node: Node): void => {
    if (result) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node as Text;
      const len = t.data.length;
      if (len === 0) return;
      if (targetOffset >= plain && targetOffset <= plain + len) {
        result = { node: t, offset: targetOffset - plain };
        return;
      }
      plain += len;
      lastWasNewline = false;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (el.tagName === 'BR') {
      if (!result && targetOffset === plain && el.parentNode) {
        const siblings = Array.from(el.parentNode.childNodes);
        result = { node: el.parentNode, offset: siblings.indexOf(el) + 1 };
      }
      plain += 1;
      lastWasNewline = true;
      return;
    }
    const isBlock = depth > 0 && isBlockElement(el);
    if (isBlock && plain > 0 && !lastWasNewline && el.parentNode) {
      if (!result && targetOffset === plain) {
        const parent = el.parentNode as Element;
        const siblings = Array.from(parent.childNodes);
        result = { node: parent, offset: siblings.indexOf(el) };
      }
      plain += 1;
      lastWasNewline = true;
    }
    depth++;
    for (const child of Array.from(node.childNodes)) {
      if (result) break;
      visit(child);
    }
    depth--;
  };

  depth++;
  for (const child of Array.from(root.childNodes)) {
    if (result) break;
    visit(child);
  }
  depth--;

  if (result) return result;
  // Past the entire plain-text length — anchor at end of root. Range.
  // selectNodeContents + collapse(false) is the canonical "place caret
  // at very end of contenteditable" pattern; works for trailing empty
  // <div><br></div>, <p><br></p>, plain text, etc.
  return { node: root, offset: root.childNodes.length };
}

/** Compute the plain-text offset of a DOM position (container + offset),
 *  matching the coordinate system that walkPlainText produces. */
export function plainOffsetOfPosition(
  root: HTMLElement,
  container: Node,
  offset: number,
): number {
  let plain = 0;
  let reached = false;
  let depth = 0;
  // Mirror walkPlainText's rules exactly: BR emits `\n` UNCONDITIONALLY;
  // block boundaries emit `\n` only when plain text doesn't already
  // end with `\n` (collapses consecutive boundaries to one `\n`). Both
  // halves of plainOffsetOfPosition + walkPlainText must agree so
  // `plainOffsetOfPosition(root, root, root.childNodes.length)` returns
  // the same value as `walkPlainText(root).text.length`.
  let lastWasNewline = false;

  const visit = (node: Node): void => {
    if (reached) return;

    // Stop conditions.
    if (node === container) {
      if (node.nodeType === Node.TEXT_NODE) {
        plain += offset;
      } else {
        // Element container: offset counts CHILDREN to include.
        const children = Array.from(node.childNodes);
        for (let i = 0; i < Math.min(offset, children.length); i++) {
          if (reached) break;
          visit(children[i]);
        }
      }
      reached = true;
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node as Text).data.length;
      plain += len;
      if (len > 0) lastWasNewline = false;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (el.tagName === 'BR') {
      // BR always emits — matches walkPlainText.
      plain += 1;
      lastWasNewline = true;
      return;
    }
    if (el.tagName === 'IMG') {
      // Emoji-as-img: walkPlainText emits alt content; mirror here so
      // offsets stay in sync. See walkPlainText's IMG branch.
      const alt = (el as HTMLImageElement).alt;
      if (alt && alt.length > 0) {
        plain += alt.length;
        lastWasNewline = false;
      }
      return;
    }
    const isBlock = depth > 0 && isBlockElement(el);
    if (isBlock && plain > 0 && !lastWasNewline) {
      plain += 1;
      lastWasNewline = true;
    }
    depth++;
    for (const child of Array.from(node.childNodes)) {
      if (reached) break;
      visit(child);
    }
    depth--;
  };

  depth++;
  for (const child of Array.from(root.childNodes)) {
    if (reached) break;
    visit(child);
  }
  depth--;

  return plain;
}
