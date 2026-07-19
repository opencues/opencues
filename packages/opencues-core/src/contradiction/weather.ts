/**
 * WeatherProvider (Tier 5) — a background-refreshed cache of the daily max
 * precipitation probability for the user's location, from the keyless open-meteo
 * API (https://open-meteo.com — no key, generous free tier).
 *
 * LOCATION IS AUTO-DETECTED, no setup required: the host timezone
 * (`Intl…timeZone`, e.g. "Europe/London" → "London") is geocoded to coordinates
 * via open-meteo's geocoding API. Zero permission, zero hot-path cost — the
 * geocode + forecast both run fire-and-forget in `refresh()`; `current()` reads
 * the last-good precip map (ISO date → max precip %) synchronously. Precedence:
 * explicit lat/lon > explicit city name (`locationName`) > timezone city >
 * London fallback. open-meteo's forecast reaches ~16 days; dates beyond that
 * aren't in the map, so the verifier stays silent for them.
 */

export type FetchLike = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export interface WeatherProviderOptions {
  /** Explicit coordinates — highest precedence (skips geocoding). */
  readonly latitude?: number;
  readonly longitude?: number;
  /** Explicit city name to geocode (the `weather-location` override). */
  readonly locationName?: string;
  /** IANA timezone the auto-detect derives a city from. Default: the host's
   *  own `Intl.DateTimeFormat().resolvedOptions().timeZone`. */
  readonly timeZone?: string;
  readonly fetchImpl?: FetchLike;
  /** Refresh interval — weather moves, so hourly by default. */
  readonly ttlMs?: number;
  readonly log?: (msg: string) => void;
}

/** Derive a geocodable city name from an IANA timezone id. "Europe/London" →
 *  "London"; "America/Argentina/Buenos_Aires" → "Buenos Aires". Returns null for
 *  the non-place zones (UTC, Etc/*) so the caller falls back. */
export function cityFromTimeZone(tz: string | undefined): string | null {
  if (!tz || tz === 'UTC' || tz.startsWith('Etc/')) return null;
  const last = tz.split('/').pop();
  if (!last) return null;
  return last.replace(/_/g, ' ');
}

function hostTimeZone(): string | undefined {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; }
}

const LONDON = { lat: 51.51, lon: -0.13 };

export class WeatherProvider {
  private precip: ReadonlyMap<string, number> = new Map();
  private coords: { lat: number; lon: number } | null = null;
  private lastFetch = 0;
  private inflight: Promise<void> | null = null;
  private readonly opts: WeatherProviderOptions;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly ttlMs: number;
  private readonly log: (msg: string) => void;

  constructor(opts: WeatherProviderOptions = {}) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? (typeof fetch !== 'undefined' ? (fetch as unknown as FetchLike) : undefined);
    this.ttlMs = opts.ttlMs ?? 60 * 60 * 1000;
    this.log = opts.log ?? (() => {});
  }

  /** ISO date → max precipitation probability (%) for that day. Read
   *  synchronously in the keystroke path; empty until the first refresh. */
  current(): ReadonlyMap<string, number> {
    return this.precip;
  }

  /** Resolve the location once (cached): explicit coords > geocoded city name >
   *  geocoded timezone city > London. Geocoding is a keyless open-meteo call. */
  private async resolveCoords(): Promise<{ lat: number; lon: number }> {
    if (this.coords) return this.coords;
    if (typeof this.opts.latitude === 'number' && typeof this.opts.longitude === 'number') {
      this.coords = { lat: this.opts.latitude, lon: this.opts.longitude };
      return this.coords;
    }
    const city = this.opts.locationName || cityFromTimeZone(this.opts.timeZone ?? hostTimeZone());
    if (city && this.fetchImpl) {
      try {
        const res = await this.fetchImpl(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`);
        if (res.ok) {
          const json = (await res.json()) as { results?: Array<{ latitude?: number; longitude?: number; name?: string; country?: string }> };
          const hit = json?.results?.[0];
          if (hit && typeof hit.latitude === 'number' && typeof hit.longitude === 'number') {
            this.coords = { lat: hit.latitude, lon: hit.longitude };
            this.log(`WeatherProvider: location "${city}" → ${hit.name}${hit.country ? ', ' + hit.country : ''} (${this.coords.lat},${this.coords.lon})`);
            return this.coords;
          }
        }
        this.log(`WeatherProvider: geocode of "${city}" found nothing — falling back to London`);
      } catch (e) {
        this.log(`WeatherProvider: geocode failed (${(e as Error).message}) — falling back to London`);
      }
    }
    this.coords = { ...LONDON };
    return this.coords;
  }

  async refresh(nowMs: number = Date.now()): Promise<void> {
    if (this.precip.size > 0 && nowMs - this.lastFetch < this.ttlMs) return;
    if (this.inflight) return this.inflight;
    if (!this.fetchImpl) return;
    this.inflight = (async () => {
      try {
        const { lat, lon } = await this.resolveCoords();
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=precipitation_probability_max&forecast_days=16&timezone=auto`;
        const res = await this.fetchImpl!(url);
        if (!res.ok) return;
        const json = (await res.json()) as { daily?: { time?: string[]; precipitation_probability_max?: (number | null)[] } };
        const time = json?.daily?.time ?? [];
        const vals = json?.daily?.precipitation_probability_max ?? [];
        const next = new Map<string, number>();
        for (let i = 0; i < time.length; i++) { const v = vals[i]; if (typeof v === 'number') next.set(time[i], v); }
        if (next.size > 0) {
          this.precip = next;
          this.lastFetch = nowMs;
          this.log(`WeatherProvider: ${next.size}-day precip forecast cached (${lat},${lon})`);
        }
      } catch (e) {
        this.log(`WeatherProvider: refresh failed (keeping last-good) — ${(e as Error).message}`);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}
