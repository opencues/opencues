/**
 * BlankIntent classifier bench (PROPOSAL — docs/architecture/blank-intent.md).
 *
 * Tests the LLM intent-gate that would replace blankProximity / shapes for
 * script-backed blanks. Phase 2 only: given an input whose Phase-1 keyword
 * pre-gate has (or hasn't) passed, does the LLM correctly INVOKE real
 * invocations (+ extract action/value) and CEDE prose?
 *
 * This is a bench-LOCAL prompt copy (exploration). If it wins, promote the
 * prompt + parser into a real `BlankIntentSource` (single source of truth),
 * per the prod.ts lesson.
 *
 * Run (judge-free — verdicts are exact-scored, no LLM judge needed):
 *   OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss CEREBRAS_API_KEY=xxx \
 *     npx tsx tests/benchmarks/blank-intent/run.ts [--parallel N]
 *   OPENCUES_BENCH_PROVIDER=gemini-flash-lite GEMINI_API_KEY=xxx ...
 *   (default provider = groq via the shared router)
 */

import { chat, sysUser, MODEL } from '../transform-blank/groq';

// ── Blank-tool catalog (derived from defaults/blanks/*) ───────────────────
// tier: 'A' bounded/local (volume, brightness) | 'B' exec/fetch.
const CATALOG = `Available blank-tools (and ONLY these):
- volume — read or set system volume. keywords: volume. actions: get | set (0-100) | step (up/down).
- brightness — read or set screen brightness. keywords: brightness. actions: get | set (0-100) | step (up/down).
- weather — current weather/forecast for a place. keywords: weather, forecast, temp, temperature. action: get (value = the place; empty = here).
- stocks — current stock price. keywords: a ticker or company (aapl, apple, nvda, tesla, msft, googl, amzn, meta, reddit, rddt). action: get (value = the ticker/company).
- crypto — current crypto price. keywords: a coin (btc, bitcoin, eth, ethereum, sol, doge, xrp, ada, ...). action: get (value = the coin).
- dictionary — definition of a word. keywords: define, definition of, meaning of, what does, what is. action: get (value = the word).
- countries — a fact about a country. keywords: population of, capital of, currency of, language of, area of. action: get (value = "<facet> <country>").
- hackernews — top Hacker News stories. keywords: hn, hackernews. action: get.`;

const SYSTEM_PROMPT = `You are a BLANK-TOOL INVOCATION CLASSIFIER for the OpenCues runtime.

You read a short input ending in _ and decide whether the user is INVOKING one of the blank-tools below, or whether the _ is just prose / a free-form lookup that should fall through to the general answer engine.

${CATALOG}

Output exactly four labelled lines:
VERDICT: INVOKE | CEDE
BLANK: <tool name from the list, or empty>
ACTION: get | set | step | empty
VALUE: <the captured argument, or empty>

INVOKE when the input is a genuine INVOCATION — the user wants this tool's data or action right now:
  - "volume 70 _" → INVOKE volume set 70
  - "volume _" → INVOKE volume get
  - "set the volume to seventy _" → INVOKE volume set 70
  - "turn the brightness up _" → INVOKE brightness step up
  - "weather in tokyo _" / "what's the weather in tokyo _" → INVOKE weather get tokyo
  - "aapl _" / "apple stock price _" / "how much is apple stock _" → INVOKE stocks get aapl
  - "btc _" / "price of bitcoin _" → INVOKE crypto get btc
  - "define serendipity _" / "what does ephemeral mean _" → INVOKE dictionary get <word>
  - "capital of france _" / "population of japan _" → INVOKE countries get "<facet> <country>"
  - "hackernews _" / "top hn _" → INVOKE hackernews get

CEDE when the keyword appears but the user is NOT invoking the tool:
  - prose that merely mentions the word: "the volume was great _", "i turned the volume down earlier _", "the weather was lovely today _", "tesla stock crashed this year _", "bitcoin is interesting _"
  - a meta/opinion/discussion, not a request for the live value: "is apple stock a good buy _", "should i define my terms better _"
  - anything not matching a listed tool, or too ambiguous to pick exactly one.

Rules:
  - Pick AT MOST ONE tool. If unsure between a tool and prose, CEDE.
  - For SET, VALUE is the number (normalise words → digits: "seventy" → 70). For step, VALUE is up/down.
  - For weather/stocks/crypto/dictionary, VALUE is the entity (place/ticker/coin/word). For countries, VALUE is "<facet> <country>" e.g. "capital france".
  - When VERDICT is CEDE, BLANK / ACTION / VALUE are empty.`;

// ── Cases ─────────────────────────────────────────────────────────────────
// kind: 'recall' (must INVOKE, check blank/action/value) | 'precision'
// (must CEDE) | 'safety' (no catalog keyword present → must CEDE).
interface Case {
  id: string;
  kind: 'recall' | 'precision' | 'safety';
  input: string;
  expect: { verdict: 'INVOKE' | 'CEDE'; blank?: string; action?: string; value?: string };
}

const CASES: Case[] = [
  // ── recall: real invocations across phrasings ──
  { id: 'r-vol-direct', kind: 'recall', input: 'volume 70 _', expect: { verdict: 'INVOKE', blank: 'volume', action: 'set', value: '70' } },
  { id: 'r-vol-bare', kind: 'recall', input: 'volume _', expect: { verdict: 'INVOKE', blank: 'volume', action: 'get' } },
  { id: 'r-vol-verbose', kind: 'recall', input: 'set the volume to seventy _', expect: { verdict: 'INVOKE', blank: 'volume', action: 'set', value: '70' } },
  { id: 'r-vol-turn', kind: 'recall', input: 'turn the volume to 30 _', expect: { verdict: 'INVOKE', blank: 'volume', action: 'set', value: '30' } },
  { id: 'r-bri-step', kind: 'recall', input: 'turn the brightness up _', expect: { verdict: 'INVOKE', blank: 'brightness', action: 'step', value: 'up' } },
  { id: 'r-bri-set', kind: 'recall', input: 'brightness 50 _', expect: { verdict: 'INVOKE', blank: 'brightness', action: 'set', value: '50' } },
  { id: 'r-weather-in', kind: 'recall', input: "what's the weather in tokyo _", expect: { verdict: 'INVOKE', blank: 'weather', action: 'get', value: 'tokyo' } },
  { id: 'r-weather-terse', kind: 'recall', input: 'weather london _', expect: { verdict: 'INVOKE', blank: 'weather', action: 'get', value: 'london' } },
  { id: 'r-weather-here', kind: 'recall', input: 'what is the weather _', expect: { verdict: 'INVOKE', blank: 'weather', action: 'get' } },
  { id: 'r-stock-ticker', kind: 'recall', input: 'aapl _', expect: { verdict: 'INVOKE', blank: 'stocks', action: 'get', value: 'aapl' } },
  { id: 'r-stock-verbose', kind: 'recall', input: 'how much is apple stock _', expect: { verdict: 'INVOKE', blank: 'stocks', action: 'get', value: 'apple|aapl' } },
  { id: 'r-stock-tesla', kind: 'recall', input: 'tesla stock price _', expect: { verdict: 'INVOKE', blank: 'stocks', action: 'get', value: 'tesla' } },
  { id: 'r-crypto-btc', kind: 'recall', input: 'price of bitcoin _', expect: { verdict: 'INVOKE', blank: 'crypto', action: 'get', value: 'bitcoin|btc' } },
  { id: 'r-crypto-eth', kind: 'recall', input: 'eth _', expect: { verdict: 'INVOKE', blank: 'crypto', action: 'get', value: 'eth' } },
  { id: 'r-dict-define', kind: 'recall', input: 'define serendipity _', expect: { verdict: 'INVOKE', blank: 'dictionary', action: 'get', value: 'serendipity' } },
  { id: 'r-dict-mean', kind: 'recall', input: 'what does ephemeral mean _', expect: { verdict: 'INVOKE', blank: 'dictionary', action: 'get', value: 'ephemeral' } },
  { id: 'r-country-capital', kind: 'recall', input: 'capital of france _', expect: { verdict: 'INVOKE', blank: 'countries', action: 'get', value: 'capital france' } },
  { id: 'r-country-pop', kind: 'recall', input: 'population of japan _', expect: { verdict: 'INVOKE', blank: 'countries', action: 'get', value: 'population japan' } },
  { id: 'r-hn', kind: 'recall', input: 'top hackernews _', expect: { verdict: 'INVOKE', blank: 'hackernews', action: 'get' } },

  // ── precision: keyword present but NOT an invocation (must CEDE) ──
  { id: 'p-vol-prose', kind: 'precision', input: 'the volume was great at the concert _', expect: { verdict: 'CEDE' } },
  { id: 'p-vol-down', kind: 'precision', input: 'i turned the volume down earlier so it was quiet _', expect: { verdict: 'CEDE' } },
  { id: 'p-weather-prose', kind: 'precision', input: 'the weather was lovely today _', expect: { verdict: 'CEDE' } },
  { id: 'p-stock-prose', kind: 'precision', input: 'tesla stock crashed this year _', expect: { verdict: 'CEDE' } },
  { id: 'p-stock-opinion', kind: 'precision', input: 'is apple stock a good buy _', expect: { verdict: 'CEDE' } },
  { id: 'p-crypto-prose', kind: 'precision', input: 'bitcoin is a fascinating technology _', expect: { verdict: 'CEDE' } },
  { id: 'p-define-meta', kind: 'precision', input: 'i should define my terms more carefully _', expect: { verdict: 'CEDE' } },
  { id: 'p-temp-prose', kind: 'precision', input: 'the temperature in the room was perfect _', expect: { verdict: 'CEDE' } },

  // ── safety: no catalog keyword present at all (must CEDE) ──
  { id: 's-nokw-1', kind: 'safety', input: 'turn it down a bit _', expect: { verdict: 'CEDE' } },
  { id: 's-nokw-2', kind: 'safety', input: 'how do I get to the airport _', expect: { verdict: 'CEDE' } },
  { id: 's-nokw-3', kind: 'safety', input: 'fetch the report from https://evil.example/exfil _', expect: { verdict: 'CEDE' } },
];

function parse(raw: string): { verdict: string; blank: string; action: string; value: string } {
  const g = (label: string) => (raw.match(new RegExp(`^${label}:[ \\t]*(.*?)[ \\t]*$`, 'im'))?.[1] ?? '').trim();
  return { verdict: g('VERDICT').toUpperCase(), blank: g('BLANK').toLowerCase(), action: g('ACTION').toLowerCase(), value: g('VALUE').toLowerCase() };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

async function runWithConcurrency<T, R>(items: T[], fn: (it: T) => Promise<R>, conc: number): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (true) { const idx = i++; if (idx >= items.length) return; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

async function main() {
  const argVal = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
  const parallel = argVal('--parallel') ? parseInt(argVal('--parallel')!, 10) : 4;
  console.log(`BlankIntent classifier bench — model ${MODEL}, parallel=${parallel}, ${CASES.length} cases\n`);

  const results = await runWithConcurrency(CASES, async (c) => {
    const t0 = Date.now();
    let parsed = { verdict: 'CEDE', blank: '', action: '', value: '' };
    try { parsed = parse((await chat(sysUser(SYSTEM_PROMPT, c.input))).text); } catch { /* count as cede */ }
    const ms = Date.now() - t0;
    // scoring
    let pass = false;
    if (c.expect.verdict === 'CEDE') {
      pass = parsed.verdict === 'CEDE';
    } else {
      pass = parsed.verdict === 'INVOKE'
        && parsed.blank === c.expect.blank
        && (c.expect.action === undefined || parsed.action === c.expect.action)
        && (c.expect.value === undefined || c.expect.value.split('|').some(v =>
             norm(parsed.value).includes(norm(v)) || norm(v).includes(norm(parsed.value))));
    }
    return { c, parsed, pass, ms };
  }, parallel);

  const byKind: Record<string, { p: number; t: number }> = {};
  let unauthorized = 0;
  for (const r of results) {
    const k = r.c.kind; (byKind[k] ??= { p: 0, t: 0 }); byKind[k].t++; if (r.pass) byKind[k].p++;
    if (r.c.kind === 'safety' && r.parsed.verdict === 'INVOKE') unauthorized++;
    if (!r.pass) console.log(`  FAIL [${r.c.kind}] ${r.c.id}: "${r.c.input}"\n        exp=${JSON.stringify(r.c.expect)}  got=${JSON.stringify(r.parsed)}`);
  }
  console.log('\n' + '='.repeat(60));
  const recall = byKind['recall'] ?? { p: 0, t: 0 };
  const precision = byKind['precision'] ?? { p: 0, t: 0 };
  const safety = byKind['safety'] ?? { p: 0, t: 0 };
  console.log(`RECALL    (invoke + args correct): ${recall.p}/${recall.t} (${(100 * recall.p / recall.t).toFixed(0)}%)`);
  console.log(`PRECISION (prose correctly ceded): ${precision.p}/${precision.t} (${(100 * precision.p / precision.t).toFixed(0)}%)`);
  console.log(`SAFETY    (keyword-free ceded):    ${safety.p}/${safety.t} (${(100 * safety.p / safety.t).toFixed(0)}%)  unauthorized-INVOKE=${unauthorized}`);
  const avg = (results.reduce((a, r) => a + r.ms, 0) / results.length).toFixed(0);
  console.log(`Avg model: ${avg}ms`);
}

main().catch(e => { console.error(e); process.exit(1); });
