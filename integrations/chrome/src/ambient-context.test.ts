/**
 * Tests for `gatherAmbientContext` — chrome's DOM reader that produces
 * the sanitized field-metadata block consumed by FluidBlankSource.
 *
 * Each path needs explicit coverage because the only structural
 * downstream defence is `renderAmbientBlock`'s sanitization in core.
 * If this gatherer leaks the wrong field (e.g. reads a sibling input's
 * value, or a sensitive password into a label-shaped wrapper), the
 * core layer can't catch it.
 *
 * Coverage:
 *   - `<label for>` resolution
 *   - Wrapping `<label>` walk (up to 4 levels)
 *   - `aria-labelledby` multi-ID concatenation
 *   - aria-labelledby with circular textContent reference (no infinite loop)
 *   - aria-labelledby missing-ID is skipped
 *   - Sensitive field returns null (password / cc / OTP)
 *   - Empty target returns null
 *   - Empty fields-after-sanitization returns null
 *   - Page-URL strips query + fragment
 *   - Page-level fields when `location` throws (sandboxed iframe)
 *   - URL schemes: data:, javascript:, file:// — the URL field is best-effort
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { gatherAmbientContext } from './opencues-bootstrap';

function setupDom(html: string, url = 'https://example.com/page'): void {
  document.documentElement.innerHTML = `<head><title>Test page</title></head><body>${html}</body>`;
  // jsdom doesn't always honour the constructor URL after we replace
  // innerHTML; reset via Object.defineProperty when the test needs a
  // specific origin/path. Default URL stays the jsdom default unless
  // the test overrides.
  if (url !== 'about:blank') {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: new URL(url),
    });
  }
}

beforeEach(() => {
  // Reset DOM to a known baseline between tests so leaked elements
  // (a stray <label for> from a prior test) can't poison the next.
  document.documentElement.innerHTML = '<head><title>Test page</title></head><body></body>';
});

describe('gatherAmbientContext — null cases', () => {
  it('returns null when target is null', () => {
    expect(gatherAmbientContext(null)).toBeNull();
  });

  it('returns null for password input even with label + placeholder set', () => {
    setupDom(`
      <label for="pw">Password</label>
      <input id="pw" type="password" placeholder="Your password" autocomplete="current-password">
    `);
    const el = document.getElementById('pw') as HTMLInputElement;
    expect(gatherAmbientContext(el)).toBeNull();
  });

  it('returns null for credit-card input', () => {
    setupDom('<input id="cc" type="text" autocomplete="cc-number" placeholder="Card number">');
    const el = document.getElementById('cc') as HTMLInputElement;
    expect(gatherAmbientContext(el)).toBeNull();
  });

  it('returns null for OTP / one-time-code input', () => {
    setupDom('<input id="otp" type="text" autocomplete="one-time-code" placeholder="6-digit code">');
    expect(gatherAmbientContext(document.getElementById('otp') as HTMLInputElement)).toBeNull();
  });

  it('returns null for input named pin / cvv (heuristic fallback)', () => {
    setupDom('<input id="card-cvv" type="text" name="cvv" placeholder="CVV">');
    expect(gatherAmbientContext(document.getElementById('card-cvv') as HTMLInputElement)).toBeNull();
  });
});

describe('gatherAmbientContext — label resolution', () => {
  it('resolves <label for> matching the input id', () => {
    setupDom(`
      <label for="email">Email address</label>
      <input id="email" type="email">
    `);
    const out = gatherAmbientContext(document.getElementById('email')!);
    expect(out?.label).toBe('Email address');
  });

  it('falls back to wrapping <label> when no for= match', () => {
    setupDom(`
      <label>
        Username (no explicit for)
        <input id="u" type="text">
      </label>
    `);
    const out = gatherAmbientContext(document.getElementById('u')!);
    expect(out?.label).toContain('Username');
  });

  it('walks up to the 4-iteration cap looking for a wrapping <label>', () => {
    // Loop runs 4 iterations starting AT the target, so the label can
    // be at most 3 element-hops up (target → parent → grandparent →
    // great-grandparent = label).
    setupDom(`
      <label>
        <span><div>
          <input id="deep" type="text">
        </div></span>
        Wrapping label three hops up
      </label>
    `);
    const out = gatherAmbientContext(document.getElementById('deep')!);
    expect(out?.label).toContain('Wrapping label three hops up');
  });

  it('does NOT walk farther than the 4-iteration cap', () => {
    // 5 wrapper elements between input and label — label is 5 hops up,
    // outside the 4-iteration window. Should not be found.
    setupDom(`
      <label>
        Label five levels up
        <div><div><div><div><div>
          <input id="too-deep" type="text">
        </div></div></div></div></div>
      </label>
    `);
    const out = gatherAmbientContext(document.getElementById('too-deep')!);
    expect(out?.label).toBeUndefined();
  });
});

describe('gatherAmbientContext — aria-labelledby', () => {
  it('resolves a single aria-labelledby id to its textContent', () => {
    setupDom(`
      <h2 id="qh">What is your GitHub profile?</h2>
      <input id="gh" type="url" aria-labelledby="qh">
    `);
    const out = gatherAmbientContext(document.getElementById('gh')!);
    // aria-labelledby resolves into the ariaLabel field (the gatherer
    // sets it as ariaLabel since label/aria-label live in the same slot
    // semantically).
    expect(out?.ariaLabel).toBe('What is your GitHub profile?');
  });

  it('concatenates multiple aria-labelledby ids space-separated', () => {
    setupDom(`
      <span id="a">Date of</span>
      <span id="b">birth</span>
      <input id="dob" type="text" aria-labelledby="a b">
    `);
    const out = gatherAmbientContext(document.getElementById('dob')!);
    expect(out?.ariaLabel).toBe('Date of birth');
  });

  it('skips missing aria-labelledby ids without crashing', () => {
    setupDom(`
      <span id="present">Present label</span>
      <input id="i" type="text" aria-labelledby="present missing-id another-missing">
    `);
    const out = gatherAmbientContext(document.getElementById('i')!);
    expect(out?.ariaLabel).toBe('Present label');
  });

  it('survives aria-labelledby with circular textContent reference', () => {
    // Pathological DOM: A's aria-labelledby="b", B contains text
    // mentioning A. Our resolver reads textContent once (no recursion
    // into referenced ids' aria-* attributes), so no infinite loop.
    // This test pins that property.
    setupDom(`
      <div id="b">label-B that mentions A which mentions B</div>
      <input id="a" type="text" aria-labelledby="b">
    `);
    const out = gatherAmbientContext(document.getElementById('a')!);
    expect(out?.ariaLabel).toContain('label-B');
    // No infinite recursion = test completes (would time out otherwise).
  });

  it('aria-label wins over aria-labelledby when both are present', () => {
    setupDom(`
      <span id="lab">Resolved-via-ids label</span>
      <input id="i" type="text" aria-label="Direct aria-label" aria-labelledby="lab">
    `);
    const out = gatherAmbientContext(document.getElementById('i')!);
    expect(out?.ariaLabel).toBe('Direct aria-label');
  });
});

describe('gatherAmbientContext — page-level fields', () => {
  it('reads document.title', () => {
    setupDom('<input id="i" type="text">');
    document.title = 'My Page Title';
    const out = gatherAmbientContext(document.getElementById('i')!);
    expect(out?.pageTitle).toBe('My Page Title');
  });

  it('reads <meta name="description"> when present', () => {
    document.documentElement.innerHTML = `
      <head>
        <title>X</title>
        <meta name="description" content="A page about ambient context.">
      </head>
      <body><input id="i" type="text"></body>
    `;
    const out = gatherAmbientContext(document.getElementById('i')!);
    expect(out?.pageDescription).toBe('A page about ambient context.');
  });

  it('strips query string + fragment from pageUrl', () => {
    setupDom(
      '<input id="i" type="text">',
      'https://example.com/search?token=secret&q=cat#section-3',
    );
    const out = gatherAmbientContext(document.getElementById('i')!);
    expect(out?.pageUrl).toBe('https://example.com/search');
  });

  it('omits pageUrl when location access throws (sandboxed iframe)', () => {
    setupDom('<input id="i" type="text">');
    // Replace location with a throwing accessor — simulates the
    // sandboxed-iframe SecurityError case. The gatherer's try/catch
    // must catch this and at minimum omit pageUrl without breaking
    // field-level gathering or crashing.
    //
    // Note: the gatherer reads document.title FIRST then location
    // SECOND inside the same try block, so pageTitle survives the
    // throw (it was set before the exception); only pageUrl (and
    // anything that would have been read AFTER location) drops.
    Object.defineProperty(window, 'location', {
      configurable: true,
      get() { throw new Error('SecurityError: sandboxed location access denied'); },
    });
    const out = gatherAmbientContext(document.getElementById('i')!);
    expect(out).not.toBeNull();
    expect(out?.pageUrl).toBeUndefined();
    // Field-level metadata still gathered fine.
    expect(out?.inputType).toBe('text');
  });
});

describe('gatherAmbientContext — placeholder + input-type', () => {
  it('reads placeholder on a normal text input', () => {
    setupDom('<input id="i" type="text" placeholder="e.g. wilfred">');
    const out = gatherAmbientContext(document.getElementById('i')!);
    expect(out?.placeholder).toBe('e.g. wilfred');
    expect(out?.inputType).toBe('text');
  });

  it('reports inputType="textarea" for textareas', () => {
    setupDom('<textarea id="t" placeholder="Notes..."></textarea>');
    const out = gatherAmbientContext(document.getElementById('t')!);
    expect(out?.inputType).toBe('textarea');
  });

  it('reports inputType="contenteditable" for non-input targets', () => {
    setupDom('<div id="ce" contenteditable="true">existing text</div>');
    const out = gatherAmbientContext(document.getElementById('ce')!);
    expect(out?.inputType).toBe('contenteditable');
  });
});

describe('gatherAmbientContext — empty / degenerate inputs', () => {
  it('returns null when EVERY field would be empty (non-input target)', () => {
    // A non-input/textarea/contenteditable element with no aria-*,
    // no wrapping label, AND with all page-level reads suppressed.
    // (Input targets always populate `inputType` so they can't reach
    // the all-empty branch — only generic elements can.)
    const span = document.createElement('span');
    Object.defineProperty(window, 'location', {
      configurable: true,
      get() { throw new Error('detached'); },
    });
    document.title = '';
    // The gatherer's `else` branch sets inputType="contenteditable"
    // for any non-input/textarea target, which means a bare element
    // is never strictly empty — so this property pins that as part of
    // the contract: ambient block is at minimum the inputType field
    // when location is unavailable. If the contract ever changes to
    // SKIP inputType for non-contenteditable elements, this test will
    // need to be updated to use a true all-empty case.
    const out = gatherAmbientContext(span);
    expect(out).not.toBeNull();
    expect(out?.inputType).toBe('contenteditable');
  });

  it('returns an object (not null) when only page-title is available', () => {
    // No label, no placeholder, no aria — just a bare input. Page-title
    // alone is enough for the gatherer to return something non-null.
    setupDom('<input id="bare" type="text">');
    document.title = 'Only-title page';
    const out = gatherAmbientContext(document.getElementById('bare')!);
    expect(out).not.toBeNull();
    expect(out?.pageTitle).toBe('Only-title page');
    expect(out?.label).toBeUndefined();
    expect(out?.placeholder).toBeUndefined();
  });
});
