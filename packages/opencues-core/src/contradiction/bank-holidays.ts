/**
 * BankHolidayProvider (Tier 0.5) — a background-refreshed cache of UK public
 * holidays from the keyless GOV.UK JSON (https://www.gov.uk/bank-holidays.json).
 *
 * The concept doc's core rule: world-data is a background-refreshed cache the
 * passive cue layer reads with ZERO added latency — never a synchronous fetch in
 * the keystroke path. `refresh()` runs fire-and-forget on a TTL cadence and
 * `current()` returns the last-good map synchronously. A failed refresh keeps the
 * previous data (staleness of days is fine for a holiday table that changes
 * ~yearly). Keys are ISO dates (`YYYY-MM-DD`, GOV.UK's own format); values are
 * the holiday title (e.g. "Christmas Day").
 */

export type BankHolidayRegion = 'england-and-wales' | 'scotland' | 'northern-ireland';

type FetchLike = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export interface BankHolidayProviderOptions {
  readonly region?: BankHolidayRegion;
  /** Injectable fetch (tests pass a stub; production uses global fetch). */
  readonly fetchImpl?: FetchLike;
  /** Refresh interval — the holiday table changes ~yearly, so daily is ample. */
  readonly ttlMs?: number;
  readonly log?: (msg: string) => void;
}

export class BankHolidayProvider {
  private map: ReadonlyMap<string, string> = new Map();
  private lastFetch = 0;
  private inflight: Promise<void> | null = null;
  private readonly region: BankHolidayRegion;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly ttlMs: number;
  private readonly log: (msg: string) => void;

  constructor(opts: BankHolidayProviderOptions = {}) {
    this.region = opts.region ?? 'england-and-wales';
    this.fetchImpl = opts.fetchImpl ?? (typeof fetch !== 'undefined' ? (fetch as unknown as FetchLike) : undefined);
    this.ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000;
    this.log = opts.log ?? (() => {});
  }

  /** Last-good holiday map (ISO date → title), read synchronously in the
   *  keystroke path. Empty until the first refresh lands. */
  current(): ReadonlyMap<string, string> {
    return this.map;
  }

  /** Background refresh, coalesced + TTL-gated. Never throws; keeps last-good. */
  async refresh(nowMs: number = Date.now()): Promise<void> {
    if (this.map.size > 0 && nowMs - this.lastFetch < this.ttlMs) return;
    if (this.inflight) return this.inflight;
    if (!this.fetchImpl) return;
    this.inflight = (async () => {
      try {
        const res = await this.fetchImpl!('https://www.gov.uk/bank-holidays.json');
        if (!res.ok) return;
        const json = (await res.json()) as Record<string, { events?: Array<{ date?: string; title?: string }> }>;
        const events = json?.[this.region]?.events ?? [];
        const next = new Map<string, string>();
        for (const e of events) if (e?.date && e?.title) next.set(e.date, e.title);
        if (next.size > 0) {
          this.map = next;
          this.lastFetch = nowMs;
          this.log(`BankHolidayProvider: ${next.size} ${this.region} holidays cached`);
        }
      } catch (e) {
        this.log(`BankHolidayProvider: refresh failed (keeping last-good) — ${(e as Error).message}`);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}
