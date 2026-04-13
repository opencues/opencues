import type { BrowserControl } from './types';

/**
 * Weather control using Open-Meteo API (free, no key required).
 * Read-only: fetches current weather for a location.
 *
 * Supports context-driven location detection from surrounding text.
 * CORS-safe: Open-Meteo allows browser requests.
 */

const WMO_CODES: Record<number, string> = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Foggy', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
  80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
  95: 'Thunderstorm', 96: 'Hail thunderstorm', 99: 'Heavy hail',
};

const cache = new Map<string, { result: string; ts: number }>();
const CACHE_TTL = 300_000; // 5 minutes

export class WeatherControl implements BrowserControl {
  readonly name = 'weather';
  readonly readOnly = true;

  async get(keyword?: string, context?: string[]): Promise<string> {
    // Extract location from keyword or context
    const location = keyword || this.extractLocation(context) || 'London';
    const cacheKey = location.toLowerCase();

    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.result;

    try {
      // Step 1: Geocode location name
      const geoResp = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`
      );
      const geoData = await geoResp.json();
      if (!geoData.results?.length) return `Unknown location: ${location}`;

      const { latitude, longitude, name, country } = geoData.results[0];

      // Step 2: Fetch current weather
      const wxResp = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto`
      );
      const wxData = await wxResp.json();
      const current = wxData.current;

      const temp = `${Math.round(current.temperature_2m)}°C`;
      const desc = WMO_CODES[current.weather_code] || 'Unknown';
      const wind = `${Math.round(current.wind_speed_10m)}km/h`;
      const display = `${name}, ${country}: ${temp} ${desc} (${wind})`;

      cache.set(cacheKey, { result: display, ts: Date.now() });
      return display;
    } catch {
      return `Weather: error for ${location}`;
    }
  }

  /** Try to extract a city name from surrounding context words */
  private extractLocation(context?: string[]): string | null {
    if (!context?.length) return null;
    // Filter out common non-location words and the blank placeholder
    const skip = new Set(['weather', 'forecast', 'current', 'today', 'tomorrow', '_', 'in', 'for', 'the']);
    const candidates = context.filter(w => !skip.has(w.toLowerCase()) && w.length > 2);
    // Take the first capitalized word or longest candidate
    const capitalized = candidates.find(w => /^[A-Z]/.test(w));
    return capitalized || candidates[0] || null;
  }
}
