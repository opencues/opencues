// Drift tests for the manifest's load-bearing security properties (INFOSEC F6).
//
//  1. manifest declares no `externally_connectable` — that single property
//     is the entire authentication boundary for the exec / write-file /
//     fetch SW relays. Adding `externally_connectable` opens the F3 RCE
//     primitives to arbitrary pages. Refuse silently — make it a CI gate.
//
//  2. `FETCH_ALLOWED_ORIGINS` (in background.ts) matches the manifest's
//     `host_permissions` exactly. Drift would either over-restrict (legit
//     fetches refused) or under-restrict (open relay to a host we never
//     intended to permit).

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FETCH_ALLOWED_ORIGINS, isFetchOriginAllowed, isInternalSender } from './sw-auth';

const manifestPath = path.join(__dirname, '..', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

describe('manifest — load-bearing security properties (F6)', () => {
  it('does NOT declare externally_connectable (load-bearing for F3/F6)', () => {
    expect(manifest.externally_connectable).toBeUndefined();
  });

  it('FETCH_ALLOWED_ORIGINS matches host_permissions exactly (no drift)', () => {
    const fromManifest = (manifest.host_permissions as string[])
      .map(h => new URL(h.replace(/\/\*$/, '')).origin)
      .sort();
    const fromCode = [...FETCH_ALLOWED_ORIGINS].sort();
    expect(fromCode).toEqual(fromManifest);
  });
});

describe('isFetchOriginAllowed (F6)', () => {
  it('allows declared origins', () => {
    expect(isFetchOriginAllowed('https://api.groq.com/openai/v1/chat/completions')).toBe(true);
    expect(isFetchOriginAllowed('https://api.anthropic.com/v1/messages')).toBe(true);
  });

  it('refuses undeclared origins (the open-relay attack)', () => {
    expect(isFetchOriginAllowed('https://evil.example/exfil')).toBe(false);
    expect(isFetchOriginAllowed('https://api.openai.com.evil.com/')).toBe(false);
  });

  it('refuses scheme variants (http vs https)', () => {
    expect(isFetchOriginAllowed('http://api.groq.com/x')).toBe(false);
  });

  it('refuses bare paths / malformed URLs', () => {
    expect(isFetchOriginAllowed('not-a-url')).toBe(false);
    expect(isFetchOriginAllowed('')).toBe(false);
  });
});

describe('isInternalSender (F6)', () => {
  it('accepts a sender whose id matches chrome.runtime.id', () => {
    const fakeChrome = { runtime: { id: 'abc123' } };
    // The function reads chrome.runtime.id at call time — stub globally.
    (globalThis as unknown as { chrome: typeof fakeChrome }).chrome = fakeChrome;
    expect(isInternalSender({ id: 'abc123' } as chrome.runtime.MessageSender)).toBe(true);
  });

  it('rejects a sender with a different id', () => {
    const fakeChrome = { runtime: { id: 'abc123' } };
    (globalThis as unknown as { chrome: typeof fakeChrome }).chrome = fakeChrome;
    expect(isInternalSender({ id: 'evil-extension' } as chrome.runtime.MessageSender)).toBe(false);
  });

  it('rejects undefined sender', () => {
    const fakeChrome = { runtime: { id: 'abc123' } };
    (globalThis as unknown as { chrome: typeof fakeChrome }).chrome = fakeChrome;
    expect(isInternalSender(undefined)).toBe(false);
  });

  it('rejects a sender with no id field', () => {
    const fakeChrome = { runtime: { id: 'abc123' } };
    (globalThis as unknown as { chrome: typeof fakeChrome }).chrome = fakeChrome;
    expect(isInternalSender({} as chrome.runtime.MessageSender)).toBe(false);
  });
});
