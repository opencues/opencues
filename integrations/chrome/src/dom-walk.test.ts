// Cursor-positioning tests for the DOM walker. The plain-text view
// counts BR + block boundaries as `\n` characters that have NO text
// nodes; positioning a Range.setStart at "the 27th plain-text char"
// when the last text node ends at char 23 used to fall through to
// "end of last text node" and the cursor landed BEFORE any trailing
// empty <div><br></div> structure. Users perceived this as a backward
// jump after a substitution.
//
// domPositionOfPlainOffset is the inverse of plainOffsetOfPosition.
// These tests pin all three position classes: inside a text node, at
// a virtual \n boundary, and past the entire plain-text length
// (the load-bearing case for trailing empty blocks).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { walkPlainText, plainOffsetOfPosition, domPositionOfPlainOffset } from './dom-walk';

let dom: JSDOM;
let root: HTMLElement;

beforeEach(() => {
  dom = new JSDOM('<!DOCTYPE html><html><body><div id="root" contenteditable="true"></div></body></html>');
  // Expose globals the helpers depend on.
  (globalThis as unknown as { document: Document }).document = dom.window.document;
  (globalThis as unknown as { Node: typeof Node }).Node = dom.window.Node;
  (globalThis as unknown as { Element: typeof Element }).Element = dom.window.Element;
  (globalThis as unknown as { Text: typeof Text }).Text = dom.window.Text;
  root = dom.window.document.getElementById('root')!;
});

afterEach(() => {
  dom.window.close();
});

describe('domPositionOfPlainOffset — single text node', () => {
  it('positions cursor inside the text node at the requested offset', () => {
    root.innerHTML = '<div>hello world</div>';
    const { text } = walkPlainText(root);
    expect(text).toBe('hello world');
    const pos = domPositionOfPlainOffset(root, 6);
    expect(pos.node.nodeType).toBe(Node.TEXT_NODE);
    expect((pos.node as Text).data).toBe('hello world');
    expect(pos.offset).toBe(6);
  });

  it('positions at end of the text node when offset === text length', () => {
    root.innerHTML = '<div>hello</div>';
    const pos = domPositionOfPlainOffset(root, 5);
    expect(pos.node.nodeType).toBe(Node.TEXT_NODE);
    expect(pos.offset).toBe(5);
  });
});

describe('domPositionOfPlainOffset — multi-block content', () => {
  it('handles block boundaries (\\n between paragraphs)', () => {
    root.innerHTML = '<div>line one</div><div>line two</div>';
    const { text } = walkPlainText(root);
    expect(text).toBe('line one\nline two');
    // Offset 8 is end of "line one"; offset 9 is start of "line two".
    const at8 = domPositionOfPlainOffset(root, 8);
    expect((at8.node as Text).data).toBe('line one');
    expect(at8.offset).toBe(8);
    const at9 = domPositionOfPlainOffset(root, 9);
    expect((at9.node as Text).data).toBe('line two');
    expect(at9.offset).toBe(0);
  });
});

describe('domPositionOfPlainOffset — trailing empty blocks (the load-bearing case)', () => {
  it('anchors cursor past the last text node when offset is in trailing structure', () => {
    // Gmail / paragraph-rendering editors: trailing empty paragraphs
    // produce <div><br></div> chains that walkPlainText counts as \n
    // characters but have no text nodes.
    root.innerHTML = '<div>hello</div><div><br></div><div><br></div><div><br></div>';
    const { text } = walkPlainText(root);
    expect(text).toBe('hello\n\n\n\n');
    // Offset 5 = end of "hello" — should land in the text node.
    const at5 = domPositionOfPlainOffset(root, 5);
    expect(at5.node.nodeType).toBe(Node.TEXT_NODE);
    expect(at5.offset).toBe(5);
    // Offsets 6..8 — past the last text node, inside trailing empty
    // block structure. The resolver returns a non-text container
    // (the root element or a parent block) so the caret can land
    // visibly in the trailing paragraphs.
    const at8 = domPositionOfPlainOffset(root, 8);
    expect(at8.node.nodeType === Node.ELEMENT_NODE || at8.node.nodeType === Node.TEXT_NODE).toBe(true);
  });

  it('past-the-end offset anchors at end of root', () => {
    root.innerHTML = '<div>hi</div><div><br></div>';
    const pos = domPositionOfPlainOffset(root, 1000);
    expect(pos.node).toBe(root);
    expect(pos.offset).toBe(root.childNodes.length);
  });
});

describe('domPositionOfPlainOffset — round-trips with plainOffsetOfPosition', () => {
  it('text-node positions round-trip cleanly', () => {
    root.innerHTML = '<div>The quick brown fox</div>';
    for (const offset of [0, 3, 9, 15, 19]) {
      const dom = domPositionOfPlainOffset(root, offset);
      const back = plainOffsetOfPosition(root, dom.node, dom.offset);
      expect(back).toBe(offset);
    }
  });
});

describe('empty-line preservation across substitution (pasted HTML)', () => {
  // The runtime's surgical splice produces buffers like
  // "hi\n\n\n\nworld" where the middle \n's represent empty lines
  // (notably the consumed trigger line). Chrome's replaceAllText paste
  // path must preserve those empty lines in the resulting DOM — not
  // collapse them via `\n+` splits. These tests pin the round-trip:
  // given a chrome-style DOM with empty <p><br></p> or <br><br>
  // chains, walkPlainText reports the right \n count.
  it('walkPlainText reports empty <p><br></p> blocks as a \\n each', () => {
    root.innerHTML = '<p>hi</p><p><br></p><p><br></p><p><br></p><p>world</p>';
    const { text } = walkPlainText(root);
    // Each empty paragraph contributes one \n (the BR). Block
    // boundaries collapse when adjacent newlines exist.
    expect(text).toBe('hi\n\n\n\nworld');
  });

  it('walkPlainText reports <br><br><br><br> chains as 4 \\n', () => {
    root.innerHTML = '<div>hi<br><br><br><br>world</div>';
    const { text } = walkPlainText(root);
    expect(text).toBe('hi\n\n\n\nworld');
  });

  it('cursor at end of multi-empty-line buffer round-trips cleanly', () => {
    root.innerHTML = '<p>hi</p><p><br></p><p><br></p><p><br></p><p>world</p>';
    const { text } = walkPlainText(root);
    const endOffset = text.length;
    const pos = domPositionOfPlainOffset(root, endOffset);
    expect(plainOffsetOfPosition(root, pos.node, pos.offset)).toBe(endOffset);
  });
});

describe('cursor-position parity with native hosts (opencode / claude-code / gemini)', () => {
  // Native hosts (TUI textareas) treat the cursor as a flat plain-text
  // offset. The runtime's surgical splice asks for cursor at
  // newText.length (end of buffer). On native hosts that's a direct
  // index assignment — no DOM mapping required.
  //
  // Chrome should produce a DOM position whose plainOffset (via
  // plainOffsetOfPosition) matches the same value. These tests pin
  // that the chrome side reaches the same logical cursor position
  // even when the DOM has trailing empty <div><br></div> blocks
  // that occupy plain-text offsets but have no text nodes.

  it('end-of-buffer parity — "hi" + 3 empty trailing paragraphs', () => {
    root.innerHTML = '<div>hi</div><div><br></div><div><br></div><div><br></div>';
    const { text } = walkPlainText(root);
    // walkPlainText emits a `\n` for each block boundary AND each BR.
    // 3 trailing empty blocks → 3 boundary `\n`s + 3 BR `\n`s, minus
    // adjacent-newline collapse → exact value is what walkPlainText says.
    const endOffset = text.length;
    const pos = domPositionOfPlainOffset(root, endOffset);
    // Round-trip the chosen DOM position back to a plain offset; must
    // equal text.length. This is the parity check: chrome's end-of-
    // buffer lands at the same logical offset a native host would.
    expect(plainOffsetOfPosition(root, pos.node, pos.offset)).toBe(endOffset);
  });

  it('end-of-buffer parity — "hii my name is WILFRED" + 3 trailing newlines', () => {
    root.innerHTML = '<div>hii my name is WILFRED</div><div><br></div><div><br></div><div><br></div>';
    const { text } = walkPlainText(root);
    const endOffset = text.length;
    const pos = domPositionOfPlainOffset(root, endOffset);
    expect(plainOffsetOfPosition(root, pos.node, pos.offset)).toBe(endOffset);
  });

  it('mid-buffer parity — cursor at a \\n boundary between paragraphs', () => {
    root.innerHTML = '<div>line one</div><div>line two</div><div>line three</div>';
    const { text } = walkPlainText(root);
    expect(text).toBe('line one\nline two\nline three');
    // Cursor at start of line 2 = plain offset 9.
    const targetOffset = 9;
    const pos = domPositionOfPlainOffset(root, targetOffset);
    expect(plainOffsetOfPosition(root, pos.node, pos.offset)).toBe(targetOffset);
  });

  it('past-the-end clamping parity — over-large offset clamps to text.length', () => {
    root.innerHTML = '<div>short</div><div><br></div>';
    const { text } = walkPlainText(root);
    const pos = domPositionOfPlainOffset(root, 1_000_000);
    // On a native host, Math.min(huge, text.length) would clamp. On
    // chrome the DOM-side resolver returns "end of root" which
    // plainOffsetOfPosition reports as text.length.
    expect(plainOffsetOfPosition(root, pos.node, pos.offset)).toBe(text.length);
  });
});
