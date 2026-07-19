/**
 * WeatherProvider (Tier 5) — a background-refreshed cache of the daily max
 * precipitation probability for an anchored location, from the keyless
 * open-meteo API (https://open-meteo.com — no key, generous free tier).
 *
 * Same contract as BankHolidayProvider: `refresh()` runs fire-and-forget off the
 * hot path, `current()` returns the last-good map (ISO date → max precip % for
 * that day) synchronously. Weather is more volatile than holidays, so the
 * default TTL is hourly. Needs a location "anchor" (lat/lon); until a location
 * FTUX exists it's configured (defaults to central London so the UK demo works
 * out of the box). open-meteo's forecast reaches ~16 days; dates beyond that
 * aren't in the map, so the verifier stays silent for them.
 */

export type FetchLike = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export interface WeatherProviderOptions {
  /** Anchor location. Default: central London (51.51, -0.13). */
  readonly latitude?: number;
  readonly longitude?: number;
  readonly fetchImpl?: FetchLike;
  /** Refresh interval — weather moves, so hourly by default. */
  readonly ttlMs?: number;
  readonly log?: (msg: string) => void;
}

export class WeatherProvider {
  private precip: ReadonlyMap<string, number> = new Map();
  private lastFetch = 0;
  private inflight: Promise<void> | null = null;
  private readonly lat: number;
  private readonly lon: number;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly ttlMs: number;
  private readonly log: (msg: string) => void;

  constructor(opts: WeatherProviderOptions = {}) {
    this.lat = opts.latitude ?? 51.51;
    this.lon = opts.longitude ?? -0.13;
    this.fetchImpl = opts.fetchImpl ?? (typeof fetch !== 'undefined' ? (fetch as unknown as FetchLike) : undefined);
    this.ttlMs = opts.ttlMs ?? 60 * 60 * 1000;
    this.log = opts.log ?? (() => {});
  }

  /** ISO date → max precipitation probability (%) for that day. Read
   *  synchronously in the keystroke path; empty until the first refresh. */
  current(): ReadonlyMap<string, number> {
    return this.precip;
  }

  async refresh(nowMs: number = Date.now()): Promise<void> {
    if (this.precip.size > 0 && nowMs - this.lastFetch < this.ttlMs) return;
    if (this.inflight) return this.inflight;
    if (!this.fetchImpl) return;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${this.lat}&longitude=${this.lon}&daily=precipitation_probability_max&forecast_days=16&timezone=auto`;
    this.inflight = (async () => {
      try {
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
          this.log(`WeatherProvider: ${next.size}-day precip forecast cached (${this.lat},${this.lon})`);
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
