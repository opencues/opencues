/**
 * Journey estimation (Tier 5c) — the "you cannot get there that fast" physics
 * cue. Unlike the cached-dataset tiers, a journey is PER-QUERY (it depends on
 * the two places in this sentence), so it can't be background-cached; the
 * contradiction source resolves it ASYNC after the LLM extracts the claim (the
 * source's getCues is already async for the LLM call, so this rides the same
 * off-hot-path budget). Both endpoints are geocoded via the keyless open-meteo
 * geocoding API; the estimate is a great-circle distance × a mode detour factor
 * ÷ a mode speed — deliberately rough, because the cue only fires on GROSS
 * underestimation (real ≥ stated × 1.6 and ≥ 10 min over), never a tight call.
 * A short LRU avoids re-geocoding the same place within a session.
 */

export type FetchLike = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export type JourneyMode = 'walk' | 'cycle' | 'drive';

/** km/h + straight-line→road detour factor per mode (urban averages). */
const MODE: Record<JourneyMode, { kmh: number; detour: number }> = {
  walk: { kmh: 4.7, detour: 1.25 },
  cycle: { kmh: 14, detour: 1.3 },
  drive: { kmh: 24, detour: 1.4 },
};

/** Great-circle distance in km (haversine). */
export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Rough journey minutes for a mode over a great-circle distance. */
export function estimateJourneyMinutes(km: number, mode: JourneyMode): number {
  const m = MODE[mode];
  return Math.round((km * m.detour) / m.kmh * 60);
}

const _geoCache = new Map<string, { lat: number; lon: number } | null>();

/** Geocode a place name → coords via Photon (Komoot's keyless OSM geocoder —
 *  POI + station + street + landmark coverage, unlike a towns-only DB), cached
 *  per session. `near` biases the search (Photon `lat`/`lon`) AND picks the
 *  candidate nearest it — so "Waterloo" / "Camden" resolve to the user's region,
 *  not Waterloo, Iowa. null when nothing is found. */
export async function geocodePlace(
  name: string,
  fetchImpl: FetchLike | undefined,
  near?: { lat: number; lon: number } | null,
): Promise<{ lat: number; lon: number } | null> {
  const key = `${name.trim().toLowerCase()}@${near ? `${near.lat.toFixed(1)},${near.lon.toFixed(1)}` : ''}`;
  if (_geoCache.has(key)) return _geoCache.get(key)!;
  // Default to the ambient fetch when the host supplies no worldDataFetch —
  // native hosts omit it (chrome routes through its SW). Mirrors
  // BankHolidayProvider/WeatherProvider/TflProvider; without this default the
  // whole Tier 5c was silently inert on CC/OC/gemini/shell (unit tests never
  // saw it — they all inject stubs; the agentic suite caught it).
  const f = fetchImpl ?? (typeof fetch !== 'undefined' ? (fetch as unknown as FetchLike) : undefined);
  if (!f || !name.trim()) return null;
  try {
    const bias = near ? `&lat=${near.lat}&lon=${near.lon}` : '';
    const res = await f(`https://photon.komoot.io/api/?q=${encodeURIComponent(name)}&limit=10${bias}`);
    if (res.ok) {
      const json = (await res.json()) as { features?: Array<{ geometry?: { coordinates?: [number, number] } }> };
      // Photon returns GeoJSON: coordinates are [lon, lat].
      const cands = (json?.features ?? [])
        .map(f => f.geometry?.coordinates)
        .filter((c): c is [number, number] => Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number')
        .map(([lon, lat]) => ({ lat, lon }));
      if (cands.length > 0) {
        const pick = near ? cands.slice().sort((a, b) => haversineKm(a, near) - haversineKm(b, near))[0] : cands[0];
        _geoCache.set(key, pick);
        return pick;
      }
    }
  } catch { /* fall through */ }
  _geoCache.set(key, null);
  return null;
}

/** Test hook — clear the session geocode cache. */
export function _resetGeoCacheForTesting(): void {
  _geoCache.clear();
}
