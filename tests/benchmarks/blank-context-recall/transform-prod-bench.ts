// Production-path transform-blank bench: calls the REAL TransformBlankSource
// with identity-context + blank-context populated, exactly as the live
// runtime does for compose/rewrite flows.
//
// Showcases the ADVANCED SCENARIOS unlocked by blank-as-context wiring
// in transform-blank (June 2026):
//   - "draft an email about today's weather _"     → [WEATHER LONDON] mid-prose
//   - "write a tweet about btc _"                  → [CRYPTO BTC] / [CRYPTO ETH] mid-prose
//   - "compose a market update mentioning crypto and weather _"
//                                                   → multi-token emission
//   - "draft a P.S. from me about today's forecast _"
//                                                   → mixes identity + blank-context
//
// Asserts: each case substitutes the live value into the final rewrite,
// no raw bracket-tokens leak past the post-processor.

import {
  TransformBlankSource,
  getProvider,
  type Identity,
  type BlankContextSnapshot,
  type CueContext,
} from '../../../packages/opencues-core/dist';

interface Case {
  id: string;
  input: string;
  expectSubstrings: ReadonlyArray<string>;
}

const LIVE_IDENTITY: Identity = {
  fields: [
    { key: 'firstName',    token: '[FIRST NAME]',    value: 'Wilfred',                   description: 'first name' },
    { key: 'fullName',     token: '[FULL NAME]',     value: 'Wilfred Kasekende',         description: 'full name' },
    { key: 'email',        token: '[EMAIL]',         value: 'w@commandstick.com',        description: 'email' },
    { key: 'jobTitle',     token: '[JOB TITLE]',     value: 'Founder',                   description: 'job title' },
    { key: 'company',      token: '[COMPANY]',       value: 'Command Stick',             description: 'company' },
    { key: 'workCity',     token: '[WORK CITY]',     value: 'London',                    description: 'work city' },
  ],
  catalog: new Map(),
};
for (const f of LIVE_IDENTITY.fields) LIVE_IDENTITY.catalog.set(f.token, f.value);

const LIVE_BLANK: BlankContextSnapshot = {
  fields: [
    { token: '[WEATHER LONDON]', description: 'current weather in London', value: 'London: 18°C Overcast' },
    { token: '[CRYPTO BTC]',     description: 'current USD price of BTC',  value: 'BITCOIN: $63,568.00' },
    { token: '[CRYPTO ETH]',     description: 'current USD price of ETH',  value: 'ETHEREUM: $3,521.40' },
    { token: '[STOCKS NVDA]',    description: 'current share price of NVDA', value: 'NVDA: $220.86' },
    { token: '[STOCKS AAPL]',    description: 'current share price of AAPL', value: 'AAPL: $311.84' },
  ],
  catalog: new Map(),
};
for (const f of LIVE_BLANK.fields) LIVE_BLANK.catalog.set(f.token, f.value);

const CASES: ReadonlyArray<Case> = [
  { id: 'email-weather', input: "draft a quick email to the team about today's weather _",
    expectSubstrings: ['London: 18°C Overcast'] },
  { id: 'tweet-btc', input: 'write a short tweet about how bitcoin is doing _',
    expectSubstrings: ['BITCOIN: $63,568.00'] },
  { id: 'note-crypto-pair', input: 'jot a note about how btc and eth are doing _',
    expectSubstrings: ['BITCOIN: $63,568.00', 'ETHEREUM: $3,521.40'] },
  { id: 'mix-weather-crypto', input: "compose a 2-line morning message: today's weather and how btc is doing _",
    expectSubstrings: ['London: 18°C Overcast', 'BITCOIN: $63,568.00'] },
  { id: 'identity-plus-weather', input: "draft an email from me about today's weather forecast _",
    expectSubstrings: ['London: 18°C Overcast', 'Wilfred'] },
  { id: 'all-three', input: 'one-paragraph daily standup: weather, btc, nvda _',
    expectSubstrings: ['London: 18°C Overcast', 'BITCOIN: $63,568.00', 'NVDA: $220.86'] },
  { id: 'rewrite-add-pricing', input: 'Team, quick update.\nadd a P.S. about today\'s btc price _',
    expectSubstrings: ['BITCOIN: $63,568.00'] },
];

function mkContext(input: string): CueContext {
  const words = input.split(/\s+/).filter(Boolean);
  return {
    text: input,
    words,
    blankIndices: words.map((w, i) => (w === '_' ? i : -1)).filter(i => i >= 0),
    identityContext: { fields: LIVE_IDENTITY.fields, catalog: LIVE_IDENTITY.catalog, mode: 'safe' },
    blankContext:    { fields: LIVE_BLANK.fields,    catalog: LIVE_BLANK.catalog,    mode: 'safe' },
  } as CueContext;
}

async function main(): Promise<void> {
  const apiKey = process.env.CEREBRAS_API_KEY ?? process.env.GROQ_API_KEY ?? '';
  if (!apiKey) {
    console.error('Set CEREBRAS_API_KEY or GROQ_API_KEY before running.');
    process.exit(1);
  }
  const useCerebras = Boolean(process.env.CEREBRAS_API_KEY);
  const provider = getProvider(useCerebras ? 'cerebras' : 'groq')!;
  const endpoint = useCerebras
    ? 'https://api.cerebras.ai/v1/chat/completions'
    : 'https://api.groq.com/openai/v1/chat/completions';
  const model = useCerebras ? 'gpt-oss-120b' : 'openai/gpt-oss-120b';

  // Node HTTPS adapter for live calls.
  const { NodeHttpAdapter } = require('../../../packages/opencues-core/node-http-adapter.js');
  const httpAdapter = new NodeHttpAdapter();

  const src = new TransformBlankSource({
    httpAdapter,
    provider,
    endpoint,
    apiKey,
    model,
    mode: useCerebras ? 'fused' : '3-pass',
  });

  console.log(`══════════════════════════════════════════════════════════════`);
  console.log(`Transform-blank PROD-bench — ${useCerebras ? 'cerebras (fused)' : 'groq (3-pass)'} on ${model}`);
  console.log(`══════════════════════════════════════════════════════════════\n`);

  let pass = 0;
  for (const c of CASES) {
    const t0 = Date.now();
    let rewrite = '';
    try {
      const res = await src.getCues(mkContext(c.input));
      rewrite = res.results[0]?.alternatives?.[1] ?? '';
    } catch (err) {
      console.log(`  ✗ ${c.id} — error: ${(err as Error).message}`);
      continue;
    }
    const dt = Date.now() - t0;
    const allFound = c.expectSubstrings.every(s => rewrite.includes(s));
    const noRawTokens = !rewrite.includes('[CRYPTO') && !rewrite.includes('[WEATHER') && !rewrite.includes('[STOCKS');
    const ok = allFound && noRawTokens;
    if (ok) pass++;
    const flag = ok ? '\x1b[32m●\x1b[0m' : '✗';
    const preview = rewrite.replace(/\s+/g, ' ').slice(0, 180);
    console.log(`  ${flag} ${c.id} (${dt}ms)`);
    console.log(`      input:  ${c.input}`);
    console.log(`      output: ${preview}${rewrite.length > 180 ? '…' : ''}`);
    if (!ok) {
      const missing = c.expectSubstrings.filter(s => !rewrite.includes(s));
      if (missing.length) console.log(`      MISSING: ${missing.join(' | ')}`);
      if (!noRawTokens) console.log(`      RAW TOKEN LEAK in output`);
    }
    console.log('');
  }

  console.log(`══════════════════════════════════════════════════════════════`);
  console.log(`PASS ${pass}/${CASES.length}`);
}

main().catch(err => { console.error('ERROR:', err); process.exit(1); });
