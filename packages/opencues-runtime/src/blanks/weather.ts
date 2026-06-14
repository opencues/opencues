// WeatherBlank — current weather for a city via Open-Meteo (free, no
// API key). Read-only. 5-minute cache per city. Two-step fetch:
// geocode the location name → pull current temperature + WMO weather
// code at the resolved lat/lon. Output: "<temp>°C <description>"
// (e.g. "13°C Partly cloudy").
//
// Location detection: keyword is the trigger ("weather"); the city is
// extracted from the surrounding context words (everything except a
// short skip-list of trigger / time / determiner words). Mirrors the
// behaviour of the legacy weather-blank.sh.

import type { Blank } from './types';

const WMO_CODES: Record<number, string> = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Foggy', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
  80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
  95: 'Thunderstorm', 96: 'Hail thunderstorm', 99: 'Heavy hail',
};

const SKIP_WORDS: ReadonlySet<string> = new Set([
  'weather', 'forecast', 'temp', 'temperature',
  'current', 'today', 'tonight', 'tomorrow', 'weekend',
  'weekly', '7day', '7days', 'week', 'day', 'days', 'next', 'now', '_',
  // Common filler near the trigger that isn't a location.
  'the', 'a', 'an', 'is', 'what', "what's", 'how',
]);

// Prepositions that anchor a location phrase. `weather in New York`,
// `forecast for cape town`, `temp at heathrow`, `weather around tokyo`.
// Detecting one of these gives us the most reliable signal for where
// the location starts AND lets us pick up multi-word names without
// stopping at the first non-skip token.
const LOCATION_PREPOSITIONS: ReadonlySet<string> = new Set([
  'in', 'for', 'at', 'around', 'near', 'of',
]);

const CACHE_TTL_MS = 300_000;
const DEFAULT_LOCATION = 'London';

export interface WeatherBlankOptions {
  /** Override fetch — defaults to globalThis.fetch.bind(globalThis). */
  readonly fetchFn?: typeof fetch;
  /** Default city to use when no location can be extracted from context. */
  readonly defaultLocation?: string;
}

export class WeatherBlank implements Blank {
  readonly name = 'weather';
  readonly readOnly = true;
  private readonly _fetch: typeof fetch;
  private readonly _defaultLocation: string;
  private readonly _cache = new Map<string, { result: string; ts: number }>();

  constructor(opts: WeatherBlankOptions = {}) {
    this._fetch = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    this._defaultLocation = opts.defaultLocation ?? DEFAULT_LOCATION;
  }

  async get(_keyword?: string, context?: string[]): Promise<string> {
    const location = this.extractLocation(context) ?? this._defaultLocation;
    const cacheKey = location.toLowerCase();

    const cached = this._cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.result;

    try {
      const geoResp = await this._fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`,
      );
      const geoData = (await geoResp.json()) as { results?: { latitude: number; longitude: number }[] };
      if (!geoData.results?.length) return `Unknown location: ${location}`;
      const { latitude, longitude } = geoData.results[0];

      const wxResp = await this._fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto`,
      );
      const wxData = (await wxResp.json()) as { current?: { temperature_2m: number; weather_code: number } };
      const current = wxData.current;
      if (!current) return `Weather: error for ${location}`;

      const temp = `${Math.round(current.temperature_2m)}°C`;
      const desc = WMO_CODES[current.weather_code] ?? '';
      const prettyLocation = location
        .split(/\s+/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      // Shape-driven read-only emission (June 2026). No tab — weather
      // has no cycle vocab (no blankStep, no stepValues), so the
      // selector-satellite split has no semantic purpose. The runtime
      // splices the whole string as one wipeable gray span via the
      // regular consumeContext path. See docs/architecture/shape-
      // driven-blanks.md § Emission shapes by cycle-vocab presence.
      const display = `weather ${prettyLocation} ${temp} ${desc}`.trim();

      this._cache.set(cacheKey, { result: display, ts: Date.now() });
      return display;
    } catch {
      return `Weather: error for ${location}`;
    }
  }

  /**
   * Best-effort location extraction from surrounding context words.
   *
   * Two strategies, tried in order:
   *
   *   1. **Preposition-anchored.** If a token in
   *      LOCATION_PREPOSITIONS appears, everything after it (minus
   *      skip-words and minus the trigger token if it survives the
   *      window) is the location. Catches `weather in New York`,
   *      `forecast for cape town`, `what's the temp in San Francisco`.
   *
   *   2. **Trailing run.** Walk from the end collecting consecutive
   *      non-skip tokens. Stop at the first skip-word that interrupts
   *      a started collection. Catches `London weather`, `weather
   *      Paris`, `Paris weather today`.
   *
   * Multi-word names ("New York", "Cape Town", "San Francisco") are
   * preserved as space-joined strings — Open-Meteo's geocoder handles
   * them better than a single-word slice.
   */
  private extractLocation(context?: string[]): string | null {
    return extractLocationFromContext(context);
  }
}

// Exported for direct testing — kept outside the class so the test file
// can exercise the heuristic without instantiating WeatherBlank.
export function extractLocationFromContext(context?: string[]): string | null {
  if (!context?.length) return null;
  const lower = context.map(w => w.toLowerCase());

  // Strategy 1 — preposition-anchored.
  for (let i = 0; i < context.length; i++) {
    if (!LOCATION_PREPOSITIONS.has(lower[i])) continue;
    if (i === context.length - 1) continue; // preposition with nothing after
    const tail = context.slice(i + 1).filter(w => !SKIP_WORDS.has(w.toLowerCase()));
    if (tail.length) return tail.join(' ');
  }

  // Strategy 2 — trailing run of non-skip tokens.
  const trail: string[] = [];
  for (let i = context.length - 1; i >= 0; i -= 1) {
    const isSkip = SKIP_WORDS.has(lower[i]);
    if (isSkip) {
      if (trail.length > 0) break; // skip-word interrupting a started run → stop
      continue; // skip-words BEFORE the trail starts → ignore
    }
    trail.unshift(context[i]);
  }
  return trail.length ? trail.join(' ') : null;
}
