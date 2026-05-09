import { describe, it, expect, vi } from 'vitest';
import { ClaudeStatusBlank } from './claude-status';

interface FetchPlan {
  summary?: unknown;
  incidents?: unknown;
  summaryFails?: boolean;
  incidentsFails?: boolean;
}

function makeFetch(plan: FetchPlan): typeof fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('summary.json')) {
      if (plan.summaryFails) throw new Error('summary down');
      return { ok: true, json: async () => plan.summary } as Response;
    }
    if (u.includes('incidents.json')) {
      if (plan.incidentsFails) throw new Error('incidents down');
      return { ok: true, json: async () => plan.incidents ?? { incidents: [] } } as Response;
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
}

const HEALTHY = {
  status: { indicator: 'none', description: 'All Systems Operational' },
  components: [
    { name: 'claude.ai', status: 'operational' },
    { name: 'Claude API (api.anthropic.com)', status: 'operational' },
    { name: 'Claude Code', status: 'operational' },
  ],
  incidents: [],
};

const DEGRADED = {
  status: { indicator: 'minor', description: 'Service Disruption' },
  components: [
    { name: 'claude.ai', status: 'operational' },
    { name: 'Claude API (api.anthropic.com)', status: 'partial_outage' },
    { name: 'Claude Code', status: 'degraded_performance' },
  ],
  incidents: [{
    name: 'Elevated errors',
    status: 'investigating',
    impact: 'minor',
    started_at: new Date(Date.now() - 23 * 60_000).toISOString(),
    resolved_at: null,
  }],
};

describe('ClaudeStatusBlank', () => {
  it('returns 4 newline-separated alts when healthy (yes-no, one-word, breakdown, incident)', async () => {
    const blk = new ClaudeStatusBlank({ fetchFn: makeFetch({ summary: HEALTHY }) });
    const result = await blk.get();
    const alts = result.split('\n');
    expect(alts).toHaveLength(4);
    expect(alts[0]).toBe('No — all systems operational');
    expect(alts[1]).toBe('none');
    expect(alts[2]).toBe('all 3 components operational');
    expect(alts[3]).toBe('(no recent incidents)');
  });

  it('answers "Yes" with indicator + unhealthy components when degraded', async () => {
    const blk = new ClaudeStatusBlank({ fetchFn: makeFetch({ summary: DEGRADED }) });
    const result = await blk.get();
    const [yesNo, oneWord, breakdown, incident] = result.split('\n');
    expect(yesNo).toBe('Yes — minor: Claude API (api.anthropic.com), Claude Code');
    expect(oneWord).toBe('minor');
    expect(breakdown).toBe('Claude API (api.anthropic.com): partial_outage, Claude Code: degraded_performance');
    expect(incident).toBe('active: Elevated errors');
  });

  it('shows "last incident <ago>: <name>" when no active incident but recent ones exist', async () => {
    const recent = {
      ...HEALTHY,
      incidents: [], // none active
    };
    const incidents = {
      incidents: [{
        name: 'Past blip',
        started_at: new Date(Date.now() - 4 * 60 * 60_000).toISOString(),
        resolved_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
      }],
    };
    const blk = new ClaudeStatusBlank({ fetchFn: makeFetch({ summary: recent, incidents }) });
    const alts = (await blk.get()).split('\n');
    expect(alts[3]).toMatch(/^last incident \dh ago: Past blip$/);
  });

  it('caches the result for 30s — second call does not re-fetch', async () => {
    const fetchFn = makeFetch({ summary: HEALTHY });
    const blk = new ClaudeStatusBlank({ fetchFn });
    await blk.get();
    await blk.get();
    const calls = (fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls;
    // Two endpoints (summary + incidents) called exactly once each.
    expect(calls).toHaveLength(2);
  });

  it('returns a graceful "Yes — status check failed" string on summary fetch error', async () => {
    const blk = new ClaudeStatusBlank({ fetchFn: makeFetch({ summaryFails: true }) });
    expect(await blk.get()).toBe('Yes — status check failed');
  });

  it('still returns the healthy alts when only the incidents endpoint fails', async () => {
    const blk = new ClaudeStatusBlank({
      fetchFn: makeFetch({ summary: HEALTHY, incidentsFails: true }),
    });
    const alts = (await blk.get()).split('\n');
    expect(alts[0]).toBe('No — all systems operational');
    // Incident alt falls back to the no-recent-incidents marker.
    expect(alts[3]).toBe('(no recent incidents)');
  });
});
