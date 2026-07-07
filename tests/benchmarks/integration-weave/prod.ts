/**
 * integration-weave/prod.ts — weaving-quality bench for the `integration-weave`
 * feature. Drives the REAL prompt (`FUSED_WEAVE_SYSTEM` + `WEAVE_VALUE_TOKEN`
 * imported from the runtime — no bench-local copy to drift) across a provider.
 *
 * The load-bearing contract is TOKEN SURVIVAL: the LLM must return the sentinel
 * token exactly once, never reformat/translate/drop it (the runtime swaps the
 * real value in afterward — see blank-weave.ts). This bench measures that rate
 * and prints the woven phrases so register/fluff quality can be eyeballed.
 *
 * Usage:
 *   CEREBRAS_API_KEY=xxx npx tsx tests/benchmarks/integration-weave/prod.ts [--provider cerebras|groq|gemini] [--parallel N]
 */
import * as https from 'https';
import { getProvider, dispatchChat, type HttpAdapterShape } from '../../../packages/opencues-core/src/llm-provider';
import { FUSED_WEAVE_SYSTEM, WEAVE_VALUE_TOKEN } from '../../../packages/opencues-runtime/src/modules/blank-weave';

interface Case { id: string; exemplar: string; priorContext: string; }

// Varied exemplars (registers) × prior contexts (empty, mid-thought, sentence
// lead, multi-line). The value the token stands for is deliberately NOT here —
// the model never sees it, which is the whole point.
const CASES: Case[] = [
  { id: 'weather-trip',   exemplar: "it's currently {value}",     priorContext: 'Planning a trip to Oslo next week.' },
  { id: 'weather-bare',   exemplar: "it's currently {value}",     priorContext: '' },
  { id: 'volume-setup',   exemplar: 'volume is now {value}',      priorContext: 'Getting the room ready for movie night.' },
  { id: 'volume-midline', exemplar: 'volume is now {value}',      priorContext: 'I cranked the speakers earlier but now' },
  { id: 'stock-note',     exemplar: 'trading at {value}',         priorContext: 'Thinking about whether to buy more NVDA —' },
  { id: 'stock-bare',     exemplar: 'trading at {value}',         priorContext: '' },
  { id: 'price-list',     exemplar: 'the price is {value}',       priorContext: 'Shopping list:\n- milk\n- eggs\n- the thing I wanted,' },
  { id: 'define-prose',   exemplar: 'it means {value}',           priorContext: "I keep seeing the word 'ephemeral' and" },
  { id: 'brightness',     exemplar: 'brightness at {value}',      priorContext: 'My eyes are tired, so the screen' },
  { id: 'time-greet',     exemplar: "it's {value}",               priorContext: 'Good morning! Just checking —' },
  { id: 'count-report',   exemplar: '{value} open issues',        priorContext: 'Status update for the team:' },
  { id: 'temp-formal',    exemplar: 'the temperature reads {value}', priorContext: 'Per the morning weather briefing,' },
];

const agent = new https.Agent({ keepAlive: true, maxSockets: 16 });
const httpAdapter: HttpAdapterShape = {
  post: (url: string, body: string, headers: Record<string, string>) => new Promise<string>((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + (u.search ?? ''), method: 'POST',
      headers: { ...headers, 'content-length': Buffer.byteLength(body) }, agent, timeout: 30000 },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body); req.end();
  }),
};

const PROVIDERS: Record<string, { endpoint: string; key: string | undefined; model: string }> = {
  cerebras: { endpoint: 'https://api.cerebras.ai/v1/chat/completions', key: process.env.CEREBRAS_API_KEY, model: process.env.OPENCUES_CEREBRAS_MODEL ?? 'gpt-oss-120b' },
  groq:     { endpoint: 'https://api.groq.com/openai/v1/chat/completions', key: process.env.GROQ_API_KEY, model: process.env.OPENCUES_GROQ_MODEL ?? 'openai/gpt-oss-120b' },
  gemini:   { endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent', key: process.env.GEMINI_API_KEY, model: process.env.OPENCUES_GEMINI_MODEL ?? 'gemini-3.1-flash-lite' },
};

async function runWithConcurrency<T, R>(items: T[], fn: (it: T) => Promise<R>, conc: number): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

async function main() {
  const argVal = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
  const providerId = argVal('--provider') ?? 'cerebras';
  const parallel = parseInt(argVal('--parallel') ?? '4', 10);
  const p = PROVIDERS[providerId];
  if (!p) { console.error(`Unknown provider "${providerId}". Known: ${Object.keys(PROVIDERS).join(', ')}`); process.exit(1); }
  if (!p.key) { console.error(`Missing API key for ${providerId}.`); process.exit(1); }
  const provider = getProvider(providerId);
  if (!provider) { console.error(`getProvider("${providerId}") returned null`); process.exit(1); }

  console.log(`\nintegration-weave bench — provider=${providerId} model=${p.model} cases=${CASES.length}\n`);

  const results = await runWithConcurrency(CASES, async (c) => {
    const placeholder = c.exemplar.replace(/\{value\}/g, WEAVE_VALUE_TOKEN);
    const user = `PRIOR TEXT:\n${c.priorContext.trim() || '(none)'}\n\nPLACEHOLDER PHRASE:\n${placeholder}`;
    try {
      const raw = await dispatchChat(provider, httpAdapter, {
        model: p.model,
        messages: [{ role: 'system', content: FUSED_WEAVE_SYSTEM }, { role: 'user', content: user }],
        temperature: 0,
      }, { apiKey: p.key!, endpoint: p.endpoint });
      const woven = raw.trim().replace(/^["'`]|["'`]$/g, '');
      const tokens = woven.split(WEAVE_VALUE_TOKEN).length - 1;
      const survived = tokens === 1 && woven !== WEAVE_VALUE_TOKEN;
      return { c, woven, tokens, survived };
    } catch (e) {
      return { c, woven: `<error: ${(e as Error).message}>`, tokens: -1, survived: false };
    }
  }, parallel);

  let ok = 0;
  for (const r of results) {
    const mark = r.survived ? '\x1b[32m●\x1b[0m' : '✗';
    if (r.survived) ok++;
    // Show the woven phrase with the token rendered as «value» so register reads naturally.
    const display = r.woven.split(WEAVE_VALUE_TOKEN).join('«value»');
    console.log(`${mark} ${r.c.id.padEnd(14)} ${r.tokens === 1 ? '' : `[tokens=${r.tokens}] `}${display}`);
  }
  console.log(`\nToken-survival: ${ok}/${results.length} (${Math.round((ok / results.length) * 100)}%)`);
  console.log('(Token survival is the hard contract. Register/fluff quality is the eyeball pass above.)\n');
  process.exit(ok === results.length ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
