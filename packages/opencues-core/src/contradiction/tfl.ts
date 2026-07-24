/**
 * TflProvider (Tier 5b) — background-refreshed London transit line status from
 * the keyless TfL Unified API (https://api.tfl.gov.uk — an app key raises rate
 * limits but isn't required).
 *
 * Scope: the WEEKEND-ENGINEERING-WORKS / line-disruption cue, which keys off the
 * line NAME in the sentence and needs NO per-user anchor. The concept doc's two
 * anchor-dependent cues (live bus arrivals → a configured stop; last-train → a
 * timetable anchor) are deliberately out of scope until a location FTUX exists.
 *
 * Same contract as the other providers: `refresh()` fire-and-forget off the hot
 * path (TTL-gated), `current()` returns the last-good disruption map
 * (normalized line name → human status, e.g. "victoria" → "Severe Delays")
 * synchronously. Only lines NOT in Good Service are in the map.
 */

export type FetchLike = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export interface TflProviderOptions {
  /** TfL modes to poll for line status. */
  readonly modes?: string;
  readonly fetchImpl?: FetchLike;
  /** Refresh interval — line status moves through the day; 5 min default. */
  readonly ttlMs?: number;
  readonly log?: (msg: string) => void;
}

/** Normalize a line name for matching: lowercase, drop a trailing "line",
 *  collapse whitespace. "Victoria" / "the Victoria line" → "victoria". */
export function normalizeLine(name: string): string {
  return name.toLowerCase()
    .replace(/\bline\b/g, '')
    .replace(/[^a-z0-9& ]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^the\s+/, '')   // "the victoria" → "victoria"
    .trim();
}

interface TflLineStatus {
  name?: string;
  lineStatuses?: Array<{ statusSeverity?: number; statusSeverityDescription?: string }>;
}

export class TflProvider {
  private disrupted: ReadonlyMap<string, string> = new Map();
  private lastFetch = 0;
  private inflight: Promise<void> | null = null;
  private readonly modes: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly ttlMs: number;
  private readonly log: (msg: string) => void;

  constructor(opts: TflProviderOptions = {}) {
    this.modes = opts.modes ?? 'tube,dlr,overground,elizabeth-line';
    this.fetchImpl = opts.fetchImpl ?? (typeof fetch !== 'undefined' ? (fetch as unknown as FetchLike) : undefined);
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
    this.log = opts.log ?? (() => {});
  }

  /** Normalized line name → status description, for lines NOT in Good Service.
   *  Read synchronously in the keystroke path; empty until the first refresh. */
  current(): ReadonlyMap<string, string> {
    return this.disrupted;
  }

  async refresh(nowMs: number = Date.now()): Promise<void> {
    if (this.disrupted.size > 0 && nowMs - this.lastFetch < this.ttlMs) return;
    if (this.inflight) return this.inflight;
    if (!this.fetchImpl) return;
    this.inflight = (async () => {
      try {
        const res = await this.fetchImpl!(`https://api.tfl.gov.uk/Line/Mode/${this.modes}/Status`);
        if (!res.ok) return;
        const lines = (await res.json()) as TflLineStatus[];
        if (!Array.isArray(lines)) return;
        const next = new Map<string, string>();
        for (const l of lines) {
          if (!l?.name) continue;
          const statuses = l.lineStatuses ?? [];
          // Flag only GENUINE disruption. "Good Service" (fine) and "Minor
          // Delays" (near-constant background noise on the tube — flagging it
          // would train distrust) are excluded; severe delays, closures, and
          // suspensions are kept. Precision-first.
          const IGNORE = new Set(['Good Service', 'Minor Delays']);
          const bad = statuses.filter(s => s.statusSeverityDescription && !IGNORE.has(s.statusSeverityDescription));
          if (bad.length === 0) continue;
          const desc = [...new Set(bad.map(s => s.statusSeverityDescription).filter(Boolean))].join(', ');
          next.set(normalizeLine(l.name), desc || 'disrupted');
        }
        // Always publish (even empty — a line may have recovered to Good Service).
        this.disrupted = next;
        this.lastFetch = nowMs;
        this.log(`TflProvider: ${next.size} line(s) disrupted${next.size ? ' — ' + [...next.keys()].join(', ') : ''}`);
      } catch (e) {
        this.log(`TflProvider: refresh failed (keeping last-good) — ${(e as Error).message}`);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}
