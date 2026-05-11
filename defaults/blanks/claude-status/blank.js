/// <reference path="../../user-blank.d.ts" />
/**
 * @type {import('../../user-blank').UserBlankModule}
 *
 * claude-status — Anthropic/Claude service status via Statuspage API.
 *
 * 30s cache. Returns four cycleable alts: yes/no + reason, one-word
 * indicator, component breakdown, and last-incident context.
 *
 * Migrated from packages/opencues-runtime/src/blanks/claude-status.ts
 * (May 2026).
 */

const SUMMARY_URL = 'https://status.claude.com/api/v2/summary.json';
const INCIDENTS_URL = 'https://status.claude.com/api/v2/incidents.json';
const CACHE_TTL_MS = 30_000;

function formatAgo(iso) {
  if (!iso) return 'recently';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const min = Math.round(ms / 60_000);
  if (min < 60) return min + 'm ago';
  const hr = Math.round(min / 60);
  if (hr < 24) return hr + 'h ago';
  const days = Math.round(hr / 24);
  return days + 'd ago';
}

function formatAlts(summary, lastIncident) {
  const indicator = summary.status.indicator;
  const isUp = indicator === 'none';
  const unhealthy = summary.components.filter(c => c.status !== 'operational');
  const total = summary.components.length;

  const reason = isUp
    ? 'all systems operational'
    : indicator + ': ' + (unhealthy.map(c => c.name).join(', ') || summary.status.description);
  const yesNo = (isUp ? 'No' : 'Yes') + ' — ' + reason;

  const breakdown = unhealthy.length === 0
    ? 'all ' + total + ' components operational'
    : unhealthy.map(c => c.name + ': ' + c.status).join(', ');

  let incident = '(no recent incidents)';
  const active = summary.incidents && summary.incidents.find(i => !i.resolved_at);
  if (active) {
    incident = 'active: ' + active.name;
  } else if (lastIncident) {
    const ago = formatAgo(lastIncident.resolved_at || lastIncident.started_at);
    incident = 'last incident ' + ago + ': ' + lastIncident.name;
  }

  return [yesNo, indicator, breakdown, incident];
}

export default {
  async get(ctx, args) {
    // 30s cache via ctx.storage
    const cachedRaw = await ctx.storage.get('cached');
    const cacheTsStr = await ctx.storage.get('ts');
    const cacheTs = cacheTsStr ? parseInt(cacheTsStr, 10) : 0;
    if (cachedRaw && ctx.now() - cacheTs < CACHE_TTL_MS) {
      return cachedRaw;
    }

    try {
      const sumResp = await ctx.fetch(SUMMARY_URL);
      if (!sumResp.ok) throw new Error('summary http ' + sumResp.status);
      const summary = await sumResp.json();

      // Best-effort secondary fetch — losing the incidents endpoint
      // just omits the 4th alt.
      let lastIncident;
      try {
        const incResp = await ctx.fetch(INCIDENTS_URL);
        if (incResp.ok) {
          const data = await incResp.json();
          lastIncident = data.incidents && data.incidents[0];
        }
      } catch { /* swallow */ }

      const alts = formatAlts(summary, lastIncident);
      const result = alts.join('\n');
      await ctx.storage.set('cached', result);
      await ctx.storage.set('ts', String(ctx.now()));
      return result;
    } catch (e) {
      return 'Yes — status check failed';
    }
  },
};
