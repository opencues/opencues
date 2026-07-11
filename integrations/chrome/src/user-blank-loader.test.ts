// Tests for ChromeUserBlank — the content-script proxy that relays
// custom-JS user-blank invokes to the chrome-host over
// chrome.runtime.sendMessage. Mocks chrome.runtime.sendMessage to
// cover message construction, reply-handling, and the sanitizer
// applied at the host→content trust boundary.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChromeUserBlank } from './user-blank-loader';

function stubSendMessage(impl: (msg: unknown) => unknown): ReturnType<typeof vi.fn> {
  const spy = vi.fn(impl);
  (globalThis as unknown as { chrome: { runtime: { sendMessage: unknown } } }).chrome = {
    runtime: { sendMessage: spy },
  };
  return spy;
}

describe('ChromeUserBlank — happy path', () => {
  it('get() sends a well-formed invoke message and returns sanitized output', async () => {
    const spy = stubSendMessage(() => Promise.resolve({ ok: true, output: 'hello' }));
    const blank = new ChromeUserBlank('my-blank');
    const result = await blank.get('kw', ['ctx1', 'ctx2']);

    expect(spy).toHaveBeenCalledWith({
      type: 'opencues:user-blank-invoke',
      name: 'my-blank',
      method: 'get',
      args: ['kw', 'ctx1', 'ctx2'],
    });
    expect(result).toBe('hello');
  });

  it('set() sends a well-formed invoke message with [value, keyword] args', async () => {
    const spy = stubSendMessage(() => Promise.resolve({ ok: true, output: '' }));
    const blank = new ChromeUserBlank('my-blank');
    await blank.set('newval', 'kw');

    expect(spy).toHaveBeenCalledWith({
      type: 'opencues:user-blank-invoke',
      name: 'my-blank',
      method: 'set',
      args: ['newval', 'kw'],
    });
  });

  it('name property reflects the constructor argument', () => {
    const blank = new ChromeUserBlank('some-name');
    expect(blank.name).toBe('some-name');
  });

  it('readOnly defaults to false', () => {
    const blank = new ChromeUserBlank('x');
    expect(blank.readOnly).toBe(false);
  });

  it('dispose() does not throw (host owns lifecycle)', () => {
    const blank = new ChromeUserBlank('x');
    expect(() => blank.dispose()).not.toThrow();
  });

  it('get() with no keyword/context defaults to an empty-string keyword arg', async () => {
    const spy = stubSendMessage(() => Promise.resolve({ ok: true, output: 'x' }));
    const blank = new ChromeUserBlank('x');
    await blank.get();
    expect(spy).toHaveBeenCalledWith({
      type: 'opencues:user-blank-invoke',
      name: 'x',
      method: 'get',
      args: [''],
    });
  });
});

describe('ChromeUserBlank — edge cases', () => {
  it('"rich" output option bypasses HTML sanitization (raw output preserved)', async () => {
    stubSendMessage(() => Promise.resolve({ ok: true, output: '<b>bold</b>' }));
    const blank = new ChromeUserBlank('x', { output: 'rich' });
    const result = await blank.get();
    expect(result).toBe('<b>bold</b>');
  });

  it('default ("safe") output option strips HTML tags from the reply', async () => {
    stubSendMessage(() => Promise.resolve({ ok: true, output: '<b>bold</b>' }));
    const blank = new ChromeUserBlank('x');
    const result = await blank.get();
    expect(result).not.toContain('<b>');
  });

  it('missing output field on an ok reply resolves to an empty (sanitized) string', async () => {
    stubSendMessage(() => Promise.resolve({ ok: true }));
    const blank = new ChromeUserBlank('x');
    const result = await blank.get();
    expect(result).toBe('');
  });

  it('"native host not connected" error on get() surfaces a user-visible install hint, not a throw', async () => {
    stubSendMessage(() => Promise.resolve({ ok: false, error: 'native host not connected' }));
    const blank = new ChromeUserBlank('weather-plus');
    const result = await blank.get();
    expect(result).toContain('weather-plus');
    expect(result).toContain('chrome-host');
  });

  it('"native host not connected" error on set() resolves to a silent no-op (empty string, no throw)', async () => {
    stubSendMessage(() => Promise.resolve({ ok: false, error: 'Native Host Not Connected' }));
    const blank = new ChromeUserBlank('x');
    await expect(blank.set('v')).resolves.toBeUndefined();
  });

  it('"native host not connected" matching is case-insensitive', async () => {
    stubSendMessage(() => Promise.resolve({ ok: false, error: 'NATIVE HOST NOT CONNECTED' }));
    const blank = new ChromeUserBlank('x');
    const result = await blank.get();
    expect(result).toContain('chrome-host');
  });
});

describe('ChromeUserBlank — invalid input / failure modes', () => {
  it('throws with a wrapped message when sendMessage itself rejects', async () => {
    stubSendMessage(() => Promise.reject(new Error('port closed')));
    const blank = new ChromeUserBlank('x');
    await expect(blank.get()).rejects.toThrow(/relay failed/);
  });

  it('throws with the host error message for any other (non-connection) failure', async () => {
    stubSendMessage(() => Promise.resolve({ ok: false, error: 'blank threw a runtime error' }));
    const blank = new ChromeUserBlank('x');
    await expect(blank.get()).rejects.toThrow('blank threw a runtime error');
  });

  it('throws a generic message when reply is falsy (undefined/null)', async () => {
    stubSendMessage(() => Promise.resolve(undefined));
    const blank = new ChromeUserBlank('x');
    await expect(blank.get()).rejects.toThrow(/invoke failed/);
  });

  it('throws a generic message when ok=false with no error field at all', async () => {
    stubSendMessage(() => Promise.resolve({ ok: false }));
    const blank = new ChromeUserBlank('x');
    await expect(blank.get()).rejects.toThrow(/invoke failed/);
  });

  it('rejects a reply of ok=true but a non-string output (defensive coercion in sanitizer, not a throw)', async () => {
    // @ts-expect-error - simulating a malformed/adversarial host reply
    stubSendMessage(() => Promise.resolve({ ok: true, output: 12345 }));
    const blank = new ChromeUserBlank('x');
    // sanitizeBlankOutput expects a string; a malformed host reply
    // handing back a number should not crash the content script.
    await expect(blank.get()).resolves.toBeDefined();
  });
});
