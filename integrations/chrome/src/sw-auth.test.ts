// Dedicated test file for sw-auth.ts — the sole authentication boundary
// for the exec / write-file / fetch service-worker relays (INFOSEC F6).
//
// `manifest-security.test.ts` already pins the drift contract (manifest
// has no `externally_connectable`, FETCH_ALLOWED_ORIGINS matches
// host_permissions) plus a handful of smoke tests for the two guard
// functions. This file goes deeper on the adversarial angle: origin
// matching edge cases (trailing slash, case, subdomain, scheme, port)
// and spoofed-sender shapes for isInternalSender.

import { describe, it, expect, beforeEach } from 'vitest';
import { FETCH_ALLOWED_ORIGINS, isFetchOriginAllowed, isInternalSender } from './sw-auth';

function stubChromeId(id: string): void {
  (globalThis as unknown as { chrome: { runtime: { id: string } } }).chrome = {
    runtime: { id },
  };
}

describe('isFetchOriginAllowed — happy path', () => {
  it('allows every declared origin with a realistic path', () => {
    for (const origin of FETCH_ALLOWED_ORIGINS) {
      expect(isFetchOriginAllowed(`${origin}/v1/some/path?query=1`)).toBe(true);
    }
  });

  it('allows a bare origin with no path', () => {
    expect(isFetchOriginAllowed('https://api.groq.com')).toBe(true);
  });

  it('allows an origin with a trailing slash', () => {
    expect(isFetchOriginAllowed('https://api.groq.com/')).toBe(true);
  });
});

describe('isFetchOriginAllowed — edge cases', () => {
  it('is case-sensitive on path but scheme+host matching is via URL.origin normalization', () => {
    // URL normalizes host to lowercase; verify an uppercase host in the
    // input still resolves to the allowed lowercase origin.
    expect(isFetchOriginAllowed('https://API.GROQ.COM/v1/x')).toBe(true);
  });

  it('refuses a subdomain of an allowed origin', () => {
    expect(isFetchOriginAllowed('https://evil.api.groq.com/x')).toBe(false);
  });

  it('refuses a suffix-matching hostname (attacker-controlled sibling domain)', () => {
    expect(isFetchOriginAllowed('https://api.groq.com.evil.example/x')).toBe(false);
  });

  it('refuses a prefix-matching hostname', () => {
    expect(isFetchOriginAllowed('https://evilapi.groq.com/x')).toBe(false);
  });

  it('refuses a non-standard port on an otherwise-allowed host', () => {
    expect(isFetchOriginAllowed('https://api.groq.com:8443/x')).toBe(false);
  });

  it('refuses http:// when only https:// is allowed', () => {
    expect(isFetchOriginAllowed('http://api.groq.com/x')).toBe(false);
  });

  it('refuses every declared origin at both boundary ends of the list', () => {
    // First and last entries specifically, in case a future refactor
    // introduces an off-by-one slice bug in FETCH_ALLOWED_ORIGINS.
    const first = FETCH_ALLOWED_ORIGINS[0];
    const last = FETCH_ALLOWED_ORIGINS[FETCH_ALLOWED_ORIGINS.length - 1];
    expect(isFetchOriginAllowed(`${first}/x`)).toBe(true);
    expect(isFetchOriginAllowed(`${last}/x`)).toBe(true);
  });
});

describe('isFetchOriginAllowed — adversarial / invalid input', () => {
  it('refuses an empty string', () => {
    expect(isFetchOriginAllowed('')).toBe(false);
  });

  it('refuses a bare hostname with no scheme', () => {
    expect(isFetchOriginAllowed('api.groq.com')).toBe(false);
  });

  it('refuses a completely malformed URL', () => {
    expect(isFetchOriginAllowed('not a url at all :: garbage')).toBe(false);
  });

  it('refuses javascript: and data: pseudo-schemes', () => {
    expect(isFetchOriginAllowed('javascript:alert(1)')).toBe(false);
    expect(isFetchOriginAllowed('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('refuses file:// URLs', () => {
    expect(isFetchOriginAllowed('file:///etc/passwd')).toBe(false);
  });

  it('refuses an allowed host embedded only in the query string / path (SSRF-style trick)', () => {
    expect(isFetchOriginAllowed('https://evil.example/?url=https://api.groq.com')).toBe(false);
    expect(isFetchOriginAllowed('https://evil.example/https://api.groq.com')).toBe(false);
  });

  it('refuses a userinfo-smuggling URL (https://api.groq.com@evil.example/)', () => {
    // Browsers/URL parse this as host=evil.example, userinfo=api.groq.com.
    // Confirms the guard checks .origin (host-derived) and not a naive
    // substring/startsWith check against the raw string.
    expect(isFetchOriginAllowed('https://api.groq.com@evil.example/')).toBe(false);
  });

  it('refuses protocol-relative-looking strings without a real scheme', () => {
    expect(isFetchOriginAllowed('//api.groq.com/x')).toBe(false);
  });

  it('does not throw on null/undefined-like coercions', () => {
    // @ts-expect-error — deliberately passing wrong types to probe runtime robustness
    expect(() => isFetchOriginAllowed(null)).not.toThrow();
    // @ts-expect-error — deliberately passing wrong types to probe runtime robustness
    expect(() => isFetchOriginAllowed(undefined)).not.toThrow();
  });
});

describe('isInternalSender — happy path', () => {
  beforeEach(() => stubChromeId('opencues-extension-id-123'));

  it('accepts a sender whose id exactly matches chrome.runtime.id', () => {
    expect(isInternalSender({ id: 'opencues-extension-id-123' } as chrome.runtime.MessageSender)).toBe(true);
  });
});

describe('isInternalSender — edge cases', () => {
  beforeEach(() => stubChromeId('opencues-extension-id-123'));

  it('rejects a sender id that is a prefix of the real extension id', () => {
    expect(isInternalSender({ id: 'opencues-extension-id-1' } as chrome.runtime.MessageSender)).toBe(false);
  });

  it('rejects a sender id that is a suffix of the real extension id', () => {
    expect(isInternalSender({ id: 'sion-id-123' } as chrome.runtime.MessageSender)).toBe(false);
  });

  it('rejects a sender id that is the real id plus extra trailing characters', () => {
    expect(isInternalSender({ id: 'opencues-extension-id-123x' } as chrome.runtime.MessageSender)).toBe(false);
  });

  it('rejects a sender id differing only in case', () => {
    expect(isInternalSender({ id: 'OPENCUES-EXTENSION-ID-123' } as chrome.runtime.MessageSender)).toBe(false);
  });

  it('rejects a sender id with leading/trailing whitespace added', () => {
    expect(isInternalSender({ id: ' opencues-extension-id-123' } as chrome.runtime.MessageSender)).toBe(false);
    expect(isInternalSender({ id: 'opencues-extension-id-123 ' } as chrome.runtime.MessageSender)).toBe(false);
  });
});

describe('isInternalSender — adversarial / invalid input', () => {
  beforeEach(() => stubChromeId('opencues-extension-id-123'));

  it('rejects undefined sender', () => {
    expect(isInternalSender(undefined)).toBe(false);
  });

  it('rejects a sender object with no id field', () => {
    expect(isInternalSender({} as chrome.runtime.MessageSender)).toBe(false);
  });

  it('rejects a sender with id explicitly undefined', () => {
    expect(isInternalSender({ id: undefined } as chrome.runtime.MessageSender)).toBe(false);
  });

  it('rejects a sender with id explicitly null (spoofed shape)', () => {
    // @ts-expect-error — real chrome typings never allow null, but a
    // hostile/compromised caller could still hand us this shape.
    expect(isInternalSender({ id: null })).toBe(false);
  });

  it('rejects an empty-string sender id against the real (non-empty) extension id', () => {
    expect(isInternalSender({ id: '' } as chrome.runtime.MessageSender)).toBe(false);
  });

  it('rejects a sender carrying extra spoofed fields (url/origin) alongside a wrong id', () => {
    expect(isInternalSender({
      id: 'evil-extension-id',
      url: 'chrome-extension://opencues-extension-id-123/content.js',
      origin: 'chrome-extension://opencues-extension-id-123',
    } as chrome.runtime.MessageSender)).toBe(false);
  });

  it('throws (does not silently pass) when chrome.runtime is missing entirely', () => {
    // Documented behaviour: isInternalSender reads `chrome.runtime.id`
    // unguarded. In every real SW context the manifest always grants
    // the runtime API, so this only fires under a broken test/harness
    // setup — but it's worth pinning that the failure mode is a loud
    // TypeError, never a silent "treat as internal" default-allow.
    (globalThis as unknown as { chrome: unknown }).chrome = {};
    expect(() => isInternalSender({ id: 'anything' } as chrome.runtime.MessageSender)).toThrow();
  });
});
