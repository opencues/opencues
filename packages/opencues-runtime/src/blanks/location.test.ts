import { describe, it, expect, vi } from 'vitest';
import { LocationBlank, buildQuery, formatCard } from './location';

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

const MUSEUM = {
  display_name:
    'British Museum, Great Russell Street, Bloomsbury, London, WC1B 3DG, United Kingdom',
  lat: '51.5194',
  lon: '-0.1270',
  category: 'tourism',
  type: 'museum',
  namedetails: { name: 'British Museum' },
  extratags: {
    opening_hours: 'Mo-Su 10:00-17:00',
    'contact:phone': '+44 20 7323 8299',
    website: 'https://www.britishmuseum.org',
  },
};

describe('formatCard', () => {
  it('builds a multi-line card: name / address / hours / contact / map link', () => {
    const card = formatCard(MUSEUM, 'british museum');
    const lines = card.split('\n');
    expect(lines[0]).toBe('British Museum');
    // address body has the leading name prefix stripped (no repeat)
    expect(lines[1]).toBe(
      'Great Russell Street, Bloomsbury, London, WC1B 3DG, United Kingdom',
    );
    expect(card).toContain('Hours: Mo-Su 10:00-17:00');
    expect(card).toContain('+44 20 7323 8299 · https://www.britishmuseum.org');
    // Map link is built from coordinates
    expect(card).toContain(
      'Map: https://www.google.com/maps/search/?api=1&query=51.5194,-0.1270',
    );
  });

  it('omits data lines OSM did not provide but always keeps the Map link', () => {
    const bare = {
      display_name: '10, Downing Street, Westminster, London, SW1A 2AA, United Kingdom',
      lat: '51.5034',
      lon: '-0.1276',
    };
    const card = formatCard(bare, '10 downing street');
    expect(card).not.toContain('Hours:');
    expect(card).not.toContain('·');
    expect(card.split('\n')[0]).toBe(bare.display_name);
    expect(card).toContain(
      'Map: https://www.google.com/maps/search/?api=1&query=51.5034,-0.1276',
    );
  });

  it('falls back to the query in the Map link when OSM gives no coordinates', () => {
    const card = formatCard({ display_name: 'Somewhere' }, 'east finchley iceland');
    expect(card).toContain(
      'Map: https://www.google.com/maps/search/?api=1&query=east%20finchley%20iceland',
    );
  });

  it('prefers contact:phone but falls back to plain phone / contact:website', () => {
    const card = formatCard(
      {
        display_name: 'Shop, High Road',
        namedetails: { name: 'Shop' },
        extratags: { phone: '+44 111', 'contact:website': 'https://shop.example' },
      },
      'shop',
    );
    expect(card).toContain('+44 111 · https://shop.example');
  });
});

describe('LocationBlank map mode', () => {
  it('routes the "map" keyword to the rich card, "location" to terse', async () => {
    const fetchFn = fetchOk([MUSEUM]);
    const blk = new LocationBlank({ fetchFn });

    const card = await blk.get('map', ['british', 'museum']);
    expect(card.split('\n')[0]).toBe('British Museum');
    expect(card).toContain('Hours: Mo-Su 10:00-17:00');
    expect(card).toContain('Map: https://www.google.com/maps/search/?api=1&query=');

    // Same query in terse mode reuses the cached hit (one fetch) and
    // returns only the display_name.
    const terse = await blk.get('location', ['british', 'museum']);
    expect(terse).toBe(MUSEUM.display_name);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('requests extratags / namedetails so the card has data', async () => {
    const fetchFn = fetchOk([MUSEUM]);
    const blk = new LocationBlank({ fetchFn });
    await blk.get('map', ['british', 'museum']);
    const url = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain('extratags=1');
    expect(url).toContain('namedetails=1');
  });

  it('returns a map-specific usage hint for a bare "map _"', async () => {
    const fetchFn = fetchOk([MUSEUM]);
    const blk = new LocationBlank({ fetchFn });
    const out = await blk.get('map', []);
    expect(out.startsWith('[err] map:')).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
