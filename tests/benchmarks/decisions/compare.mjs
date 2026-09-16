// Decision-layer compare bench — ONE runner, ONE row shape, for every step
// of the Jev integration plan (docs/architecture/decisions.md § Integration
// plan). For a named leg it runs the Cerebras arm and the Jev arm in the
// same session and prints the standard row:
//
//   accuracy (the shipped bench's own metric) · p50 / p90 ms · $ / call ·
//   tokens / call
//
// Step 0 ships the runner and the `smoke` leg only: N identical small
// requests through the REAL seam (dispatchDecision → TypeSafeDecisionProvider
// over NodeHttpAdapter, keep-alive) so the numbers in decisions.md can be
// re-checked on any machine, and a `chat-fallback` arm through the cues
// bucket's provider so the standard's fallback has a row too. Later steps add
// their legs here (`tips`, `contradiction`, …) and paste the row into
// RESULTS.md with the date and the pinned model.
//
// Run: node tests/benchmarks/decisions/compare.mjs smoke [--n 20] [--arm typesafe|fallback|both]
//      keys: TYPESAFE_API_KEY (Jev), CEREBRAS_API_KEY (fallback arm)

import path from 'node:path';
import url from 'node:url';

const R = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');
const core = await import(path.join(R, 'packages/opencues-core/dist/index.js'));
const { NodeHttpAdapter } = await import(path.join(R, 'packages/opencues-core/node-http-adapter.js'));

const argv = process.argv.slice(2);
const LEG = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'smoke';
const N = argv.includes('--n') ? Number(argv[argv.indexOf('--n') + 1]) : 20;
const ARM = argv.includes('--arm') ? argv[argv.indexOf('--arm') + 1] : 'both';

const http = new NodeHttpAdapter({ maxSockets: 4, timeout: 30000 });
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

// Usage sink: every dispatchDecision (and every dispatchChat the fallback makes)
// reports here, so $/call comes from the meter's own price table, not a
// bench-local constant.
const usage = new Map();
core.registerUsageSink((e) => {
  const k = `${e.providerId}/${e.model}`;
  const u = usage.get(k) ?? { providerId: e.providerId, model: e.model, calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0 };
  u.calls++; u.promptTokens += e.promptTokens; u.cachedTokens += e.cachedTokens; u.completionTokens += e.completionTokens;
  usage.set(k, u);
});

function row(name, ms, key) {
  const u = usage.get(key);
  const price = u ? core.priceFor(u.providerId, u.model) : undefined;
  const cost = u && price ? core.estimateRowCostUSD(u, price) / u.calls : null;
  const tok = u ? `${Math.round(u.promptTokens / u.calls)} in / ${Math.round(u.completionTokens / u.calls)} out` : '—';
  console.log(`${name.padEnd(22)} n=${ms.length}  p50 ${pct(ms, 0.5)} ms  p90 ${pct(ms, 0.9)} ms  ${cost === null ? 'unpriced' : '$' + cost.toFixed(6) + '/call'}  ${tok}`);
}

// ── legs ────────────────────────────────────────────────────────────────
// A leg is { request, score(answers) → accuracy 0..1 | null }. Fixtures are
// synthetic on purpose (see CLAUDE.md § test fixtures must not look like
// product output).
const LEGS = {
  smoke: {
    request: {
      state: { draft: 'zephyr quark pending review' },
      questions: {
        about_zephyr: { type: 'noul', instructions: 'Is `draft` about zephyr?' },
        bucket: { type: 'choice', instructions: 'Which bucket does `draft` belong to?', criteria: { 'ALT-ONE': 'mentions zephyr', 'ALT-TWO': 'mentions quasar', none: 'neither' } },
        quarkiness: { type: 'score', instructions: 'How quarky is `draft`?', criteria: ['not at all', 'somewhat', 'very'] },
      },
    },
    score: (a) => (a.about_zephyr.noul > 0.5 && a.bucket.choice === 'ALT-ONE') ? 1 : 0,
  },
};
const leg = LEGS[LEG];
if (!leg) { console.error(`unknown leg ${LEG}; known: ${Object.keys(LEGS).join(', ')}`); process.exit(2); }

async function run(name, provider, key) {
  const ms = []; let right = 0, scored = 0;
  for (let i = 0; i < N; i++) {
    try {
      const res = await core.dispatchDecision(provider, leg.request, { leg: LEG });
      ms.push(res.ms);
      const s = leg.score(res.answers);
      if (s !== null) { scored++; right += s; }
    } catch (e) { console.error(`${name}: ${e.kind ?? 'error'} ${e.message}`); }
  }
  if (ms.length === 0) return;
  if (scored) console.log(`${name.padEnd(22)} accuracy ${right}/${scored}`);
  row(name, ms, key);
}

if (ARM === 'typesafe' || ARM === 'both') {
  const apiKey = process.env[core.TYPESAFE_ENV_KEY];
  if (!apiKey) console.error(`${core.TYPESAFE_ENV_KEY} not set — skipping the typesafe arm`);
  else {
    const p = new core.TypeSafeDecisionProvider({ apiKey, httpAdapter: http });
    await core.dispatchDecision(p, leg.request, { leg: 'warmup' }).catch(() => {});
    await run('typesafe', p, `typesafe/${core.TYPESAFE_PINNED_MODEL}`);
  }
}
if (ARM === 'fallback' || ARM === 'both') {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (!apiKey) console.error('CEREBRAS_API_KEY not set — skipping the chat-fallback arm');
  else {
    const provider = core.getProvider('cerebras');
    const model = 'gpt-oss-120b';
    const chat = (system, user, { signal }) => core.dispatchChat(provider, http, { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0, maxTokens: 200 }, { apiKey, signal });
    const p = new core.ChatFallbackDecisionProvider(chat, model);
    await run('chat-fallback/cerebras', p, `cerebras/${model}`);
  }
}
