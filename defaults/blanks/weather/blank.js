/// <reference path="../../user-blank.d.ts" />
/**
 * @type {import('../../user-blank').UserBlankModule}
 *
 * weather — current weather via Open-Meteo (no API key).
 * Two-step fetch: geocode location → forecast at the resolved
 * lat/lon. 5-min cache per city.
 *
 * Migrated from packages/opencues-runtime/src/blanks/weather.ts
 * (May 2026).
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_LOCATION = 'London';

const WMO_CODES = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Foggy', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
  80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
  95: 'Thunderstorm', 96: 'Hail thunderstorm', 99: 'Heavy hail',
};

const SKIP_WORDS = new Set([
  'weather', 'forecast', 'temp', 'temperature',
  'current', 'today', 'tonight', 'tomorrow', 'weekend',
  'weekly', '7day', '7days', 'week', 'day', 'days', 'next', 'now', '_',
]);

function extractLocation(context) {
  if (!context || !context.length) return null;
  for (let i = context.length - 1; i >= 0; i--) {
    if (!SKIP_WORDS.has(context[i].toLowerCase())) return context[i];
  }
  return null;
}

export default {
  async get(ctx, args) {
    const context = args.slice(1);
    const location = extractLocation(context) || DEFAULT_LOCATION;
    const cacheKey = 'wx:' + location.toLowerCase();
    const tsKey = 'ts:' + location.toLowerCase();

    const cached = await ctx.storage.get(cacheKey);
    const cacheTsStr = await ctx.storage.get(tsKey);
    const cacheTs = cacheTsStr ? parseInt(cacheTsStr, 10) : 0;
    if (cached && ctx.now() - cacheTs < CACHE_TTL_MS) return cached;

    try {
      const geoResp = await ctx.fetch(
        'https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(location) + '&count=1',
      );
      const geoData = await geoResp.json();
      if (!geoData.results || !geoData.results.length) return 'Unknown location: ' + location;
      const { latitude, longitude } = geoData.results[0];

      const wxResp = await ctx.fetch(
        'https://api.open-meteo.com/v1/forecast?latitude=' + latitude +
        '&longitude=' + longitude +
        '&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto',
      );
      const wxData = await wxResp.json();
      const current = wxData.current;
      if (!current) return 'Weather: error for ' + location;

      const temp = Math.round(current.temperature_2m) + '°C';
      const desc = WMO_CODES[current.weather_code] || '';
      const display = (temp + ' ' + desc).trim();

      await ctx.storage.set(cacheKey, display);
      await ctx.storage.set(tsKey, String(ctx.now()));
      return display;
    } catch (e) {
      return 'Weather: error for ' + location;
    }
  },
};
