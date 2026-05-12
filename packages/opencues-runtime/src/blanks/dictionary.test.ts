import { describe, it, expect, vi } from 'vitest';
import { DictionaryBlank } from './dictionary';

function fetchOk(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response)) as unknown as typeof fetch;
}

const STUB_DEF = (def: string) => [{
  word: 'x',
  meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: def }] }],
}];

describe('DictionaryBlank', () => {
  it('returns empty string when no word can be picked from keyword/context', async () => {
    const ctl = new DictionaryBlank({ fetchFn: fetchOk(STUB_DEF('x')) });
    expect(await ctl.get('', [])).toBe('');
    expect(await ctl.get('define', ['the'])).toBe(''); // all skip-words
  });

  it('extracts the longest content word from keyword + context', async () => {
    const fetchFn = vi.fn(fetchOk(STUB_DEF('lasting briefly')));
    const ctl = new DictionaryBlank({ fetchFn: fetchFn as unknown as typeof fetch });
    await ctl.get('define ephemeral', []);
    // Confirm fetch was called with "ephemeral" (the long content word),
    // not "define" (which is a trigger word).
    const url = String((fetchFn as { mock: { calls: unknown[][] } }).mock.calls[0][0]);
    expect(url).toContain('/ephemeral');
  });

  it('truncates the definition body to ~100 chars (word prefix excluded)', async () => {
    const long = 'a'.repeat(200);
    const ctl = new DictionaryBlank({ fetchFn: fetchOk(STUB_DEF(long)) });
    const result = await ctl.get('foo');
    // Output is "foo: <definition...>" — strip the "foo: " prefix
    // before checking the truncation cap.
    expect(result.startsWith('foo: ')).toBe(true);
    const body = result.slice('foo: '.length);
    expect(body.length).toBeLessThanOrEqual(100);
    expect(body.endsWith('...')).toBe(true);
  });

  it('returns "<word>: not found" for HTTP 404', async () => {
    const ctl = new DictionaryBlank({ fetchFn: fetchOk({}, 404) });
    expect(await ctl.get('xyzzyx')).toBe('xyzzyx: not found');
  });

  it('caches within TTL — second call same word does not re-fetch', async () => {
    const fetchFn = vi.fn(fetchOk(STUB_DEF('def')));
    const ctl = new DictionaryBlank({
      fetchFn: fetchFn as unknown as typeof fetch,
      cacheTtlMs: 60_000,
    });
    await ctl.get('foo');
    await ctl.get('foo');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('returns "<word>: error" on fetch throw', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('net'); }) as unknown as typeof fetch;
    const ctl = new DictionaryBlank({ fetchFn });
    expect(await ctl.get('foo')).toBe('foo: error');
  });

  it('skips trigger words (define / meaning / definition) when picking the lookup target', async () => {
    const fetchFn = vi.fn(fetchOk(STUB_DEF('def')));
    const ctl = new DictionaryBlank({ fetchFn: fetchFn as unknown as typeof fetch });
    await ctl.get('meaning of catalyst', ['the']);
    const url = String((fetchFn as { mock: { calls: unknown[][] } }).mock.calls[0][0]);
    expect(url).toContain('/catalyst');
    expect(url).not.toContain('/meaning');
    expect(url).not.toContain('/of');
    expect(url).not.toContain('/the');
  });
});
