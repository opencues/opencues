// Tests for FetchHttpAdapter — chrome's HttpAdapter implementation for
// @opencues/core. `post()` relays through chrome.runtime.sendMessage
// to the service worker (see comment header in fetch-http-adapter.ts
// for the CORS-preflight-avoidance rationale); `get()` uses direct
// fetch(). Mocks both surfaces.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FetchHttpAdapter } from './fetch-http-adapter';

function stubSendMessage(impl: (msg: unknown) => unknown): ReturnType<typeof vi.fn> {
  const spy = vi.fn(impl);
  (globalThis as unknown as { chrome: { runtime: { sendMessage: unknown } } }).chrome = {
    runtime: { sendMessage: spy },
  };
  return spy;
}

describe('FetchHttpAdapter.post — happy path', () => {
  it('relays a POST through chrome.runtime.sendMessage with the right envelope', async () => {
    const spy = stubSendMessage(() => Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: '{"choices":[]}' }));
    const adapter = new FetchHttpAdapter();
    const result = await adapter.post(
      'https://api.groq.com/v1/chat/completions',
      JSON.stringify({ messages: [{ content: 'hi' }] }),
      { Authorization: 'Bearer abc' },
    );

    expect(spy).toHaveBeenCalledWith({
      type: 'opencues:fetch',
      method: 'POST',
      url: 'https://api.groq.com/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer abc' },
      body: JSON.stringify({ messages: [{ content: 'hi' }] }),
    });
    expect(result).toBe('{"choices":[]}');
  });

  it('normalizes space-separated INDEX: patterns into pipe-separated form', async () => {
    const raw = '1:a,b 2:c,d';
    stubSendMessage(() => Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: JSON.stringify({ choices: [{ message: { content: raw } }] }),
    }));
    const adapter = new FetchHttpAdapter();
    const result = await adapter.post('https://api.groq.com/x', '{}', {});
    const parsed = JSON.parse(result);
    expect(parsed.choices[0].message.content).toBe('1:a,b|2:c,d');
  });
});

describe('FetchHttpAdapter.get — happy path', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('performs a direct fetch and returns response text on success', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve('plain text body'),
    });
    const adapter = new FetchHttpAdapter();
    const result = await adapter.get('https://hnrss.org/frontpage');
    expect(result).toBe('plain text body');
  });

  it('forwards custom headers to fetch()', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve('x'),
    });
    const adapter = new FetchHttpAdapter();
    await adapter.get('https://api.dictionaryapi.dev/x', { 'X-Custom': '1' });
    expect(globalThis.fetch).toHaveBeenCalledWith('https://api.dictionaryapi.dev/x', { headers: { 'X-Custom': '1' } });
  });
});

describe('FetchHttpAdapter — error responses', () => {
  it('post() throws with status + statusText when the relay reports ok:false', async () => {
    stubSendMessage(() => Promise.resolve({ ok: false, status: 401, statusText: 'Unauthorized', text: 'bad key' }));
    const adapter = new FetchHttpAdapter();
    await expect(adapter.post('https://api.groq.com/x', '{}', {})).rejects.toThrow('HTTP 401: Unauthorized');
  });

  it('post() throws a generic error when the relay response is entirely missing', async () => {
    stubSendMessage(() => Promise.resolve(undefined));
    const adapter = new FetchHttpAdapter();
    await expect(adapter.post('https://api.groq.com/x', '{}', {})).rejects.toThrow('HTTP 0');
  });

  it('get() throws with status + statusText on a non-ok fetch response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 500, statusText: 'Internal Server Error', text: () => Promise.resolve(''),
    }));
    const adapter = new FetchHttpAdapter();
    await expect(adapter.get('https://api.groq.com/x')).rejects.toThrow('HTTP 500: Internal Server Error');
  });
});

describe('FetchHttpAdapter — network failures', () => {
  it('post() propagates a rejected sendMessage (native messaging / SW crash)', async () => {
    stubSendMessage(() => Promise.reject(new Error('Could not establish connection')));
    const adapter = new FetchHttpAdapter();
    await expect(adapter.post('https://api.groq.com/x', '{}', {})).rejects.toThrow('Could not establish connection');
  });

  it('get() propagates a rejected fetch (offline / DNS failure)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Failed to fetch')));
    const adapter = new FetchHttpAdapter();
    await expect(adapter.get('https://api.groq.com/x')).rejects.toThrow('Failed to fetch');
  });

  it('post() with a pre-aborted signal rejects immediately with AbortError, without calling sendMessage', async () => {
    const spy = stubSendMessage(() => Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: '{}' }));
    const adapter = new FetchHttpAdapter();
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.post('https://api.groq.com/x', '{}', {}, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('post() rejects with AbortError if the signal fires mid-flight', async () => {
    let resolveSendMessage: (v: unknown) => void;
    stubSendMessage(() => new Promise(resolve => { resolveSendMessage = resolve; }));
    const adapter = new FetchHttpAdapter();
    const controller = new AbortController();

    const promise = adapter.post('https://api.groq.com/x', '{}', {}, { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    // Clean up the dangling sendMessage promise so it doesn't leak into another test.
    resolveSendMessage!({ ok: true, status: 200, statusText: 'OK', text: '{}' });
  });
});

describe('FetchHttpAdapter — malformed URLs / invalid input', () => {
  it('post() with a malformed URL still attempts the relay (validation is the caller\'s job)', async () => {
    const spy = stubSendMessage(() => Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: '{}' }));
    const adapter = new FetchHttpAdapter();
    await adapter.post('not-a-valid-url', '{}', {});
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ url: 'not-a-valid-url' }));
  });

  it('get() with a malformed URL propagates fetch()\'s own TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Invalid URL')));
    const adapter = new FetchHttpAdapter();
    await expect(adapter.get('not-a-valid-url')).rejects.toThrow('Invalid URL');
  });

  it('post() with a non-JSON body does not throw during the debug prompt-tail log (caught internally)', async () => {
    const spy = stubSendMessage(() => Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: 'ok' }));
    const adapter = new FetchHttpAdapter();
    await expect(adapter.post('https://api.groq.com/x', 'not json at all', {})).resolves.toBe('ok');
    expect(spy).toHaveBeenCalled();
  });

  it('post() response with non-JSON text is returned as-is (parse failure caught, no normalization applied)', async () => {
    stubSendMessage(() => Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: 'plain non-json text' }));
    const adapter = new FetchHttpAdapter();
    const result = await adapter.post('https://api.groq.com/x', '{}', {});
    expect(result).toBe('plain non-json text');
  });
});
