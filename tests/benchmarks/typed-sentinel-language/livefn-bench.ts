/**
 * LIVE FUNCTIONS bench — does the LLM emit `[STOCK(ticker=X)]` for a stock the
 * catalog does NOT pre-list, instead of a generic placeholder? This is the
 * Phase-4 on-demand prompt-quality gate: the live agentic run showed the LLM
 * writing `[Amazon Stock Price]` rather than `[STOCK(ticker=AMZN)]`, so the
 * on-demand fetch never fired. We tune the LIVE FUNCTIONS block here.
 *
 * Drives the EXACT production transform prompt: FUSED_SYSTEM + the typed
 * blank-context catalog (pre-fetched NVDA/AAPL/TSLA/MSFT/GOOGL instances) +
 * the LIVE FUNCTIONS block (inlined here, mirroring boot-common.getRenderedBlock).
 *
 * Run: OPENCUES_BENCH_PROVIDER=cerebras npx tsx tests/benchmarks/typed-sentinel-language/livefn-bench.ts --provider cerebras
 */

import { pickProvider, type ProviderId } from './providers';
/* eslint-disable @typescript-eslint/no-var-requires */
const FUSED_SYSTEM: string = require('../../../packages/opencues-core/dist/sources/transform-blank-source.js').FUSED_SYSTEM;
const renderBlankCtx: (snap: unknown, mode: string, lang: string) => string =
  require('../../../packages/opencues-core/dist/blank-context.js').renderBlankContextCatalogForTransform;

// Pre-fetched instances (the as-context slots) — these resolve WITHOUT a call.
const SNAPSHOT = {
  fields: [
    { token: '[STOCK NVDA]', description: 'NVIDIA share price', value: '$880.00' },
    { token: '[STOCK AAPL]', description: 'Apple share price', value: '$254.10' },
    { token: '[STOCK TSLA]', description: 'Tesla share price', value: '$232.69' },
    { token: '[STOCK MSFT]', description: 'Microsoft share price', value: '$430.00' },
    { token: '[STOCK GOOGL]', description: 'Alphabet share price', value: '$190.00' },
  ],
  catalog: new Map([
    ['[STOCK NVDA]', '$880.00'], ['[STOCK AAPL]', '$254.10'], ['[STOCK TSLA]', '$232.69'],
    ['[STOCK MSFT]', '$430.00'], ['[STOCK GOOGL]', '$190.00'],
  ]),
};

// LIVE FUNCTIONS block — mirror of boot-common.getRenderedBlock (keep in sync),
// with all three ai-callable functions (stocks + weather + crypto).
const LIVE_FUNCTIONS = `\n\nLIVE FUNCTIONS — these fetch live data for ANY argument, not only the values pre-listed above. When the content names an entity one of these can fetch (a stock ticker, a city's weather, …), emit the function CALL with that entity as the argument; the runtime fetches the live value and substitutes it.
This OVERRIDES the "write a natural placeholder" rule for any entity a function covers: prefer the CALL [STOCK(ticker=AMZN)] over a generic placeholder like [Amazon Stock Price] or [Today's Price]. Use the ticker symbol / city / id as the argument; if the prose names a company, use its ticker (Amazon→AMZN, Netflix→NFLX, Reddit→RDDT).
- [STOCK(ticker: string): number] — Stock price
- [WEATHER(city: string): string] — Current weather for a city
- [CRYPTO(symbol: string): number] — Crypto price (USD)
Examples: "Amazon's share price" → [STOCK(ticker=AMZN)] · "how's Netflix doing" → [STOCK(ticker=NFLX)] · "weather in Berlin" → [WEATHER(city=Berlin)] · "solana's price" → [CRYPTO(symbol=SOL)].`;

const SYSTEM = `${FUSED_SYSTEM}${renderBlankCtx(SNAPSHOT, 'safe', 'typed')}${LIVE_FUNCTIONS}`;

// Cases — generative transforms naming a NON-pre-fetched entity, across all
// three ai-callable functions. Each expects a specific [FN(argName=arg)] call.
const CASES: Array<{ id: string; input: string; fn: string; argName: string; arg: string }> = [
  // stocks (pre-fetched: NVDA/AAPL/TSLA/MSFT/GOOGL)
  { id: 'amazon',   input: "write one short sentence about amazon's current share price _", fn: 'STOCK', argName: 'ticker', arg: 'AMZN' },
  { id: 'netflix',  input: 'draft a one-line market note: netflix is trading at _',          fn: 'STOCK', argName: 'ticker', arg: 'NFLX' },
  { id: 'reddit',   input: "mention reddit's stock price in a single sentence _",            fn: 'STOCK', argName: 'ticker', arg: 'RDDT' },
  { id: 'meta',     input: "write a sentence noting meta's share price right now _",          fn: 'STOCK', argName: 'ticker', arg: 'META' },
  // weather (pre-fetched: the user's workCity only)
  { id: 'tokyo',    input: "write one line about the current weather in tokyo _",            fn: 'WEATHER', argName: 'city', arg: 'Tokyo' },
  { id: 'reykjavik',input: 'note the weather in reykjavik right now in a sentence _',         fn: 'WEATHER', argName: 'city', arg: 'Reykjavik' },
  { id: 'cairo',    input: "draft a one-liner about how the weather is in cairo today _",     fn: 'WEATHER', argName: 'city', arg: 'Cairo' },
  // crypto (pre-fetched: BTC/ETH)
  { id: 'solana',   input: "write a sentence about solana's current price _",                fn: 'CRYPTO', argName: 'symbol', arg: 'SOL' },
  { id: 'dogecoin', input: 'one line: dogecoin is trading at _',                             fn: 'CRYPTO', argName: 'symbol', arg: 'DOGE' },
  { id: 'cardano',  input: "mention cardano's price in a short sentence _",                   fn: 'CRYPTO', argName: 'symbol', arg: 'ADA' },
];

function fullRewrite(out: string): string {
  const m = out.match(/FULL_REWRITE:\s*([\s\S]*)$/);
  return (m ? m[1] : out).trim();
}
// Did it emit the expected FN call for the expected arg? (case-insensitive, quote-tolerant)
function emittedCall(rewrite: string, fn: string, argName: string, arg: string): boolean {
  const re = new RegExp(`\\[${fn}\\(${argName}\\s*=\\s*["']?${arg}["']?\\)`, 'i');
  return re.test(rewrite);
}
function emittedAnyCall(rewrite: string, fn: string): boolean {
  return new RegExp(`\\[${fn}\\(\\w+\\s*=`, 'i').test(rewrite);
}

async function main() {
  const provider = pickProvider((process.argv.find((_, i, a) => a[i - 1] === '--provider') as ProviderId) || (process.env.OPENCUES_BENCH_PROVIDER as ProviderId) || 'cerebras');
  console.log(`\nLIVE FUNCTIONS bench — ${CASES.length} non-pre-fetched stock cases`);
  console.log(`Provider: ${provider.id} (${provider.modelLabel})\n`);

  let exact = 0, anyCall = 0;
  for (const c of CASES) {
    let rewrite = '';
    try {
      const out = await provider.chat(provider.sysUser(SYSTEM, `INPUT: ${c.input}`), { temperature: 0, seed: 42, maxTokens: 512 });
      rewrite = fullRewrite(out.text);
    } catch (e) { rewrite = `<err: ${e instanceof Error ? e.message : String(e)}>`; }
    const hit = emittedCall(rewrite, c.fn, c.argName, c.arg);
    const any = emittedAnyCall(rewrite, c.fn);
    if (hit) exact++;
    if (any) anyCall++;
    const tag = hit ? '✓' : any ? '~' : '✗';
    console.log(`${tag} ${c.id.padEnd(10)} expect [${c.fn}(${c.argName}=${c.arg})]  →  ${rewrite.slice(0, 80)}`);
  }
  console.log(`\nexact call: ${exact}/${CASES.length} (${(exact / CASES.length * 100).toFixed(0)}%)   any correct-fn call: ${anyCall}/${CASES.length}`);
}
main().catch(e => { console.error(e); process.exit(1); });
