// ClaudeStatusBlank — Anthropic / Claude service status via the public
// Statuspage.io API. Read-only. 30s cache (status pivots quickly during
// incidents — weather's 5min would be too stale). One fetch returns
// the full payload; from it we synthesize FOUR cycling alts so the user
// can press Up to surface progressively more detail.
//
// Trigger phrases (one blank, multiple keywords) — see BLANK.md:
//   "is claude down _" / "claude status _" / "claude api status _"
//
// The endpoint:
//   https://status.claude.com/api/v2/summary.json
// (status.anthropic.com 302-redirects here; we go straight to the
// final URL to skip the redirect round-trip.)

import type { Blank } from './types';

const ENDPOINT = 'https://status.claude.com/api/v2/summary.json';
const INCIDENTS_ENDPOINT = 'https://status.claude.com/api/v2/incidents.json';
const CACHE_TTL_MS = 30_000;

type Indicator = 'none' | 'minor' | 'major' | 'critical' | 'maintenance';
type ComponentStatus =
  | 'operational' | 'degraded_performance' | 'partial_outage'
  | 'major_outage' | 'under_maintenance';

interface SummaryPayload {
  status: { indicator: Indicator; description: string };
  components: { name: string; status: ComponentStatus }[];
  incidents: {
    name: string;
    status: string;
    impact: Indicator;
    started_at: string;
    resolved_at: string | null;
  }[];
}

interface IncidentsPayload {
  incidents: {
    name: string;
    started_at: string;
    resolved_at: string | null;
  }[];
}

export interface ClaudeStatusBlankOptions {
  readonly fetchFn?: typeof fetch;
}

export class ClaudeStatusBlank implements Blank {
  readonly name = 'claude-status';
  readonly readOnly = true;
  private readonly _fetch: typeof fetch;
  private _cache: { result: string; ts: number } | null = null;

  constructor(opts: ClaudeStatusBlankOptions = {}) {
    this._fetch = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async get(): Promise<string> {
    if (this._cache && Date.now() - this._cache.ts < CACHE_TTL_MS) {
      return this._cache.result;
    }
    try {
      const summary = await this.fetchJson<SummaryPayload>(ENDPOINT);
      // Last-incident lookup is best-effort — if it fails we just omit
      // that alt rather than failing the whole blank.
      let lastIncident: IncidentsPayload['incidents'][0] | undefined;
      try {
        const incs = await this.fetchJson<IncidentsPayload>(INCIDENTS_ENDPOINT);
        lastIncident = incs.incidents?.[0];
      } catch { /* swallow — alt 4 falls back below */ }

      const alts = this.formatAlts(summary, lastIncident);
      const result = alts.join('\n');
      this._cache = { result, ts: Date.now() };
      return result;
    } catch {
      return 'Yes — status check failed';
    }
  }

  private formatAlts(
    s: SummaryPayload,
    lastIncident: IncidentsPayload['incidents'][0] | undefined,
  ): string[] {
    const indicator = s.status.indicator;
    const isUp = indicator === 'none';

    const unhealthy = s.components.filter(c => c.status !== 'operational');
    const total = s.components.length;

    // Alt 1 — yes/no + reason. The default; answers the question literally.
    const reason = isUp
      ? 'all systems operational'
      : `${indicator}: ${unhealthy.map(c => c.name).join(', ') || s.status.description}`;
    const yesNo = `${isUp ? 'No' : 'Yes'} — ${reason}`;

    // Alt 2 — one-word verdict (the indicator itself).
    const oneWord = indicator;

    // Alt 3 — component breakdown.
    const breakdown = unhealthy.length === 0
      ? `all ${total} components operational`
      : unhealthy.map(c => `${c.name}: ${c.status}`).join(', ');

    // Alt 4 — incident context (active or most recent).
    let incident = '(no recent incidents)';
    const active = s.incidents?.find(i => !i.resolved_at);
    if (active) {
      incident = `active: ${active.name}`;
    } else if (lastIncident) {
      const ago = formatAgo(lastIncident.resolved_at ?? lastIncident.started_at);
      incident = `last incident ${ago}: ${lastIncident.name}`;
    }

    return [yesNo, oneWord, breakdown, incident];
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const resp = await this._fetch(url);
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    return (await resp.json()) as T;
  }
}

function formatAgo(iso: string | null): string {
  if (!iso) return 'recently';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  return `${days}d ago`;
}
