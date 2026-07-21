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

/** Lookup word the blank fetched (encoded as the URL's last path segment). */
function fetchedWord(fetchFn: unknown): string {
  const url = String((fetchFn as { mock: { calls: unknown[][] } }).mock.calls[0][0]);
  return decodeURIComponent(url.split('/').pop() ?? '');
}

describe('DictionaryBlank', () => {
  // Production contract (blank-fill.ts matchKeyword): `keyword` is the
  // matched trigger PHRASE, `context` is the words between it and the `_`.
  it('returns empty string when no content word can be picked', async () => {
    const ctl = new DictionaryBlank({ fetchFn: fetchOk(STUB_DEF('x')) });
    expect(await ctl.get('', [])).toBe('');
    expect(await ctl.get('define', ['the'])).toBe(''); // only a filler word
  });

  it('extracts the longest content word from context', async () => {
    const fetchFn = vi.fn(fetchOk(STUB_DEF('lasting briefly')));
    const ctl = new DictionaryBlank({ fetchFn: fetchFn as unknown as typeof fetch });
    await ctl.get('define', ['ephemeral']);
    expect(fetchedWord(fetchFn)).toBe('ephemeral'); // not the "define" trigger
  });

  it('truncates the definition body to ~100 chars (word prefix excluded)', async () => {
    const long = 'a'.repeat(200);
    const ctl = new DictionaryBlank({ fetchFn: fetchOk(STUB_DEF(long)) });
    const result = await ctl.get('define', ['foo']);
    // Output is "foo: <definition...>" — strip the "foo: " prefix
    // before checking the truncation cap.
    expect(result.startsWith('foo: ')).toBe(true);
    const body = result.slice('foo: '.length);
    expect(body.length).toBeLessThanOrEqual(100);
    expect(body.endsWith('...')).toBe(true);
  });

  it('returns "<word>: not found" for HTTP 404', async () => {
    const ctl = new DictionaryBlank({ fetchFn: fetchOk({}, 404) });
    expect(await ctl.get('define', ['xyzzyx'])).toBe('xyzzyx: not found');
  });

  it('caches within TTL — second call same word does not re-fetch', async () => {
    const fetchFn = vi.fn(fetchOk(STUB_DEF('def')));
    const ctl = new DictionaryBlank({
      fetchFn: fetchFn as unknown as typeof fetch,
      cacheTtlMs: 60_000,
    });
    await ctl.get('define', ['foo']);
    await ctl.get('define', ['foo']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('returns "<word>: error" on fetch throw', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('net'); }) as unknown as typeof fetch;
    const ctl = new DictionaryBlank({ fetchFn });
    expect(await ctl.get('define', ['foo'])).toBe('foo: error');
  });

  it('skips trigger words (define / meaning / definition) when picking the lookup target', async () => {
    const fetchFn = vi.fn(fetchOk(STUB_DEF('def')));
    const ctl = new DictionaryBlank({ fetchFn: fetchFn as unknown as typeof fetch });
    await ctl.get('meaning of', ['catalyst', 'the']);
    expect(fetchedWord(fetchFn)).toBe('catalyst'); // not "meaning" / "of" / "the"
  });

  // Regression: issue #282 — the "what is" / "what does" trigger phrases
  // were added to blankKeywords but "what"/"does" were never added to the
  // word-exclusion list, so "what" could win the longest-word tiebreak and
  // get defined instead of the actual query word. The fix strips every word
  // of the matched trigger PHRASE (drift-proof) plus a static guard set.
  it('never defines the trigger word for a "what is" phrase (issue #282)', async () => {
    const fetchFn = vi.fn(fetchOk(STUB_DEF('a time zone')));
    const ctl = new DictionaryBlank({ fetchFn: fetchFn as unknown as typeof fetch });
    // "what" ties with "time" at 4 letters — must NOT be picked.
    await ctl.get('what is', ['bst', 'time', 'now']);
    const word = fetchedWord(fetchFn);
    expect(word).not.toBe('what');
    expect(['bst', 'time', 'now']).toContain(word);
  });

  it('strips the whole trigger phrase, whatever routed here (drift-proof)', async () => {
    const fetchFn = vi.fn(fetchOk(STUB_DEF('a chemical')));
    const ctl = new DictionaryBlank({ fetchFn: fetchFn as unknown as typeof fetch });
    await ctl.get('what does', ['entropy', 'mean']); // "what"/"does" excluded
    expect(fetchedWord(fetchFn)).toBe('entropy');
  });
});
