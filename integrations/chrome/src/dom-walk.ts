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
    if (el.tagName === 'BR') {
      text += '\n';
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

  const maybeAddBoundary = (): void => {
    if (plain > 0) plain += 1;
  };

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
      plain += (node as Text).data.length;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (el.tagName === 'BR') {
      plain += 1;
      return;
    }
    const isBlock = depth > 0 && isBlockElement(el);
    if (isBlock) maybeAddBoundary();
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
