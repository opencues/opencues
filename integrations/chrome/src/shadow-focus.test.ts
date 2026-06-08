// Pin shadow-DOM focus piercing across the patterns chrome attaches over.
//
// Canonical regression: Reddit's <shreddit-composer> nests its
// contenteditable inside a Lit shadow root with delegatesFocus. Browser
// retargets document.activeElement + focusin.target to the host. Our
// isTextInput check fails on the custom-element wrapper and we never
// attach — silent break for cues AND blanks.

import { describe, expect, it, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  deepestFocused,
  resolveFocusedFromEvent,
  resolveFocusedElement,
} from './shadow-focus';

let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  // Expose globals the helpers depend on.
  (globalThis as unknown as { document: Document }).document = dom.window.document;
  (globalThis as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement = dom.window.HTMLElement;
  (globalThis as unknown as { Element: typeof Element }).Element = dom.window.Element;
});

const isCE = (el: HTMLElement) => el.isContentEditable;
const isInputLike = (el: HTMLElement) =>
  el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;

describe('deepestFocused', () => {
  it('returns the element itself when it already satisfies the leaf predicate', () => {
    const doc = dom.window.document;
    const div = doc.createElement('div');
    div.setAttribute('contenteditable', 'true');
    doc.body.appendChild(div);
    expect(deepestFocused(div, isCE)).toBe(div);
  });

  it('returns the original element when it has no shadow root and is not a leaf', () => {
    const doc = dom.window.document;
    const span = doc.createElement('span');
    doc.body.appendChild(span);
    // Non-contenteditable span: walk has nowhere to go, fall back to host.
    expect(deepestFocused(span, isCE)).toBe(span);
  });

  it('walks open shadow roots to find the focused contenteditable', () => {
    const doc = dom.window.document;
    // Mimic <shreddit-composer> structure: custom-element host with
    // open shadow root containing a focused contenteditable.
    const host = doc.createElement('shreddit-composer');
    doc.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const ce = doc.createElement('div');
    ce.setAttribute('contenteditable', 'true');
    ce.tabIndex = 0;
    shadow.appendChild(ce);
    ce.focus();
    // After focus(), shadow.activeElement === ce, but document.activeElement
    // reports the host (the natural delegatesFocus retargeting that this
    // module exists to undo).
    expect(deepestFocused(host, isCE)).toBe(ce);
  });

  it('pierces nested shadow roots (host → host → contenteditable)', () => {
    const doc = dom.window.document;
    const outer = doc.createElement('shreddit-composer');
    doc.body.appendChild(outer);
    const outerShadow = outer.attachShadow({ mode: 'open' });
    const inner = doc.createElement('reddit-rte');
    outerShadow.appendChild(inner);
    const innerShadow = inner.attachShadow({ mode: 'open' });
    const ce = doc.createElement('div');
    ce.setAttribute('contenteditable', 'true');
    ce.tabIndex = 0;
    innerShadow.appendChild(ce);
    ce.focus();
    expect(deepestFocused(outer, isCE)).toBe(ce);
  });

  it('terminates at closed shadow roots (returns the host)', () => {
    const doc = dom.window.document;
    const host = doc.createElement('locked-widget');
    doc.body.appendChild(host);
    // closed: shadow root is created but el.shadowRoot returns null
    host.attachShadow({ mode: 'closed' });
    // Closed: same as no shadow — we get back the host the caller passed.
    expect(deepestFocused(host, isCE)).toBe(host);
  });

  it('terminates when the inner active element is the same node (no infinite loop)', () => {
    const doc = dom.window.document;
    const host = doc.createElement('weird-host');
    doc.body.appendChild(host);
    // No shadow attached — shadowRoot is null. Single iteration, return host.
    expect(deepestFocused(host, isInputLike)).toBe(host);
  });

  it('is bounded — degrades gracefully under pathological shadow chains', () => {
    const doc = dom.window.document;
    // Build a 10-deep chain of nested shadow hosts where each inner
    // host is the active element of the outer shadow root. The helper
    // caps at 8 hops; the final node should be reachable from the root.
    const root = doc.createElement('chain-0');
    doc.body.appendChild(root);
    let cur: HTMLElement = root;
    for (let i = 1; i <= 10; i++) {
      const shadow = cur.attachShadow({ mode: 'open' });
      const next = doc.createElement(`chain-${i}`);
      next.tabIndex = 0;
      shadow.appendChild(next);
      next.focus();
      cur = next;
    }
    // 8-hop cap means we don't reach the deepest, but the function
    // returns a valid node and doesn't loop forever.
    const result = deepestFocused(root, isCE);
    expect(result).toBeInstanceOf(dom.window.HTMLElement);
  });
});

describe('resolveFocusedFromEvent', () => {
  it('returns composedPath()[0] when path crosses a shadow boundary', () => {
    const doc = dom.window.document;
    const host = doc.createElement('shreddit-composer');
    doc.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const ce = doc.createElement('div');
    ce.setAttribute('contenteditable', 'true');
    ce.tabIndex = 0;
    shadow.appendChild(ce);
    // Fake a focusin event with retargeted target. composedPath()[0]
    // is the real leaf; .target is the host.
    const fakeEvent = {
      target: host,
      composedPath: () => [ce, shadow, host, doc.body, doc],
    } as unknown as Event;
    expect(resolveFocusedFromEvent(fakeEvent, isCE)).toBe(ce);
  });

  it('falls back to event.target when composedPath is empty', () => {
    const doc = dom.window.document;
    const div = doc.createElement('div');
    div.setAttribute('contenteditable', 'true');
    doc.body.appendChild(div);
    const fakeEvent = {
      target: div,
      composedPath: () => [],
    } as unknown as Event;
    expect(resolveFocusedFromEvent(fakeEvent, isCE)).toBe(div);
  });

  it('returns null when neither path[0] nor target is an HTMLElement', () => {
    const fakeEvent = {
      target: null,
      composedPath: () => [],
    } as unknown as Event;
    expect(resolveFocusedFromEvent(fakeEvent, isCE)).toBeNull();
  });
});

describe('resolveFocusedElement (state read)', () => {
  it('walks into the shadow root when given a delegatesFocus host', () => {
    const doc = dom.window.document;
    const host = doc.createElement('shreddit-composer');
    doc.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const ce = doc.createElement('div');
    ce.setAttribute('contenteditable', 'true');
    ce.tabIndex = 0;
    shadow.appendChild(ce);
    ce.focus();
    // Simulates document.activeElement === host (jsdom won't actually
    // retarget, but the caller's signal is "we got the host as
    // activeElement"; the helper walks inward).
    expect(resolveFocusedElement(host, isCE)).toBe(ce);
  });

  it('returns null on null input', () => {
    expect(resolveFocusedElement(null, isCE)).toBeNull();
  });

  it('returns null when given a non-Element node', () => {
    expect(resolveFocusedElement({} as unknown as Element, isCE)).toBeNull();
  });
});

describe('back-compat — light-DOM-only paths are unchanged', () => {
  it('contenteditable directly in light DOM resolves to itself from event', () => {
    const doc = dom.window.document;
    const div = doc.createElement('div');
    div.setAttribute('contenteditable', 'true');
    doc.body.appendChild(div);
    const fakeEvent = {
      target: div,
      composedPath: () => [div, doc.body, doc],
    } as unknown as Event;
    expect(resolveFocusedFromEvent(fakeEvent, isCE)).toBe(div);
  });

  it('plain <input> resolves to itself, not walked further', () => {
    const doc = dom.window.document;
    const input = doc.createElement('input');
    input.type = 'text';
    doc.body.appendChild(input);
    expect(resolveFocusedElement(input, isInputLike)).toBe(input);
  });

  it('non-text-input elements are returned without walking', () => {
    const doc = dom.window.document;
    const button = doc.createElement('button');
    doc.body.appendChild(button);
    // No shadow root. Helper returns button; caller's isTextInput rejects.
    expect(resolveFocusedElement(button, isCE)).toBe(button);
  });
});
