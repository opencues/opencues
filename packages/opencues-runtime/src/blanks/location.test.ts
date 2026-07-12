import { describe, it, expect, vi } from 'vitest';
import { LocationBlank, buildQuery } from './location';

const HIT = (displayName: string) => [{ display_name: displayName }];

function fetchOk(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response)) as unknown as typeof fetch;
}

const ICELAND =
  'Iceland, High Road, Finchley, London Borough of Barnet, Greater London, England, N2 8AQ, United Kingdom';

describe('buildQuery', () => {
  it('joins context words and drops the underscore', () => {
    expect(buildQuery(['east', 'finchley', 'iceland', '_'])).toBe('east finchley iceland');
  });

  it('strips leading filler ("address of X" arg → "X")', () => {
    expect(buildQuery(['of', 'buckingham', 'palace'])).toBe('buckingham palace');
    expect(buildQuery(['the', 'eiffel', 'tower'])).toBe('eiffel tower');
  });

  it('keeps filler words inside the place name', () => {
    expect(buildQuery(['isle', 'of', 'wight'])).toBe('isle of wight');
  });

  it('returns empty for no context / only filler', () => {
    expect(buildQuery(undefined)).toBe('');
    expect(buildQuery([])).toBe('');
    expect(buildQuery(['the', '_'])).toBe('');
  });
});

describe('LocationBlank', () => {
  it('returns the first hit display_name for a POI query', async () => {
    const fetchFn = fetchOk(HIT(ICELAND));
    const blk = new LocationBlank({ fetchFn });
    expect(await blk.get('location', ['east', 'finchley', 'iceland'])).toBe(ICELAND);
    const url = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain('nominatim.openstreetmap.org/search');
    expect(url).toContain(encodeURIComponent('east finchley iceland'));
    expect(url).toContain('limit=1');
  });

  it('sends an identifying User-Agent header (Nominatim usage policy)', async () => {
    const fetchFn = fetchOk(HIT(ICELAND));
    const blk = new LocationBlank({ fetchFn });
    await blk.get('location', ['iceland']);
    const init = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['User-Agent']).toContain('OpenCues');
  });

  it('returns [err] usage hint when the query is empty (bare "location _")', async () => {
    const fetchFn = fetchOk(HIT(ICELAND));
    const blk = new LocationBlank({ fetchFn });
    const out = await blk.get('location', []);
    expect(out.startsWith('[err]')).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns [err] no-match on empty results so the command is not consumed', async () => {
    const blk = new LocationBlank({ fetchFn: fetchOk([]) });
    const out = await blk.get('location', ['xyzzy', 'nowhere']);
    expect(out).toBe('[err] location: no match for "xyzzy nowhere"');
  });

  it('returns [err] on HTTP failure and on thrown fetch', async () => {
    const blk = new LocationBlank({ fetchFn: fetchOk([], 503) });
    expect(await blk.get('location', ['paris'])).toBe('[err] location: HTTP 503');

    const throwing = vi.fn(async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    const blk2 = new LocationBlank({ fetchFn: throwing });
    expect(await blk2.get('location', ['paris'])).toBe('[err] location: lookup failed');
  });

  it('caches per query (case-insensitive) and truncates long display names', async () => {
    const long = 'X'.repeat(200);
    const fetchFn = fetchOk(HIT(long));
    const blk = new LocationBlank({ fetchFn });
    const first = await blk.get('location', ['somewhere']);
    expect(first.length).toBe(140);
    expect(first.endsWith('...')).toBe(true);
    await blk.get('location', ['SOMEWHERE']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('does not cache error results', async () => {
    const fetchFn = fetchOk([]);
    const blk = new LocationBlank({ fetchFn });
    await blk.get('location', ['nowhere']);
    await blk.get('location', ['nowhere']);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
