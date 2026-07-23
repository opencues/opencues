// Shadow-DOM focus piercing.
//
// Sites built on web components (Reddit's <shreddit-composer>, many Lit
// apps) wrap their editor in a shadow root with `delegatesFocus: true`.
// Native effect: at document scope, `focusin.target` and
// `document.activeElement` both retarget to the shadow HOST, not the
// contenteditable inside. Our isTextInput() check then fails on the
// custom-element host and we silently never attach.
//
// `composedPath()` crosses shadow boundaries so its [0] is the real leaf
// for events that originated below a delegatesFocus root. For state
// reads (document.activeElement), we walk shadowRoot.activeElement down
// while the candidate is still an unfocusable host. Closed shadow roots
// return null — the walk terminates and we fall back to the host (which
// will fail isTextInput, same as today).
//
// `isLeaf` is a callback so callers can inject their own focusable
// predicate without this module taking a dependency on chrome-host
// concerns (isNormalInput, sensitive-field gates, etc.).

export type LeafPredicate = (el: HTMLElement) => boolean;

/** Walk down through shadow roots until we hit a node that satisfies
 *  isLeaf, OR can't walk further (closed root / non-host element).
 *  Bounded to 8 hops to defend against any future cycle in synthetic DOM. */
export function deepestFocused(el: HTMLElement, isLeaf: LeafPredicate): HTMLElement {
  let cur: HTMLElement = el;
  for (let i = 0; i < 8; i++) {
    if (isLeaf(cur)) return cur;
    const inner = cur.shadowRoot?.activeElement;
    if (!(inner instanceof HTMLElement) || inner === cur) return cur;
    cur = inner;
  }
  return cur;
}

/** Resolve the real focused leaf from a focus-class event. Returns null
 *  if the event has no usable target. */
export function resolveFocusedFromEvent(e: Event, isLeaf: LeafPredicate): HTMLElement | null {
  const path = e.composedPath();
  const leaf = path.length > 0 ? path[0] : e.target;
  if (!(leaf instanceof HTMLElement)) return null;
  return deepestFocused(leaf, isLeaf);
}

/** Resolve the real focused leaf from a state read (document.activeElement,
 *  FocusEvent.relatedTarget). Returns null on null / non-Element input. */
export function resolveFocusedElement(start: Element | null, isLeaf: LeafPredicate): HTMLElement | null {
  if (!(start instanceof HTMLElement)) return null;
  return deepestFocused(start, isLeaf);
}
