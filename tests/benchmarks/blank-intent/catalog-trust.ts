/**
 * BlankIntent — third-party catalog-trust bench.
 *
 * Question: if third-party blanks contribute NO author free-text (only
 * name + keywords + a fixed action enum), does routing to them degrade?
 * Tests three catalog renderings for the third-party blanks:
 *   - minimal:    name + keywords + actions
 *   - structured: + value-type + category (fixed vocab, no prose)
 *   - full:       + free-text description (the unsafe baseline)
 *
 * First-party blanks (trusted) keep their rich inline catalog throughout;
 * only the THIRD-PARTY portion varies by mode. We report routing accuracy
 * on the third-party cases per mode.
 *
 *   OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss CEREBRAS_API_KEY=xxx GROQ_API_KEY=xxx \
 *     npx tsx tests/benchmarks/blank-intent/catalog-trust.ts [--parallel N]
 */

import { chat, sysUser, MODEL } from '../transform-blank/groq';

// First-party (trusted) catalog — unchanged across modes.
const FIRST_PARTY = `- volume — read or set system volume. keywords: volume. actions: get | set (0-100) | step (up/down).
- weather — current weather for a place. keywords: weather, forecast, temp. action: get (value = the place).
- stocks — current stock price. keywords: a ticker/company (aapl, apple, tesla, nvda). action: get (value = the ticker).
- dictionary — definition of a word. keywords: define, meaning of, what does. action: get (value = the word).`;

// Third-party blanks — one well-named, two opaque acronyms.
interface TPBlank { name: string; keywords: string; actions: string; valueType: string; category: string; description: string; }
const THIRD_PARTY: TPBlank[] = [
  { name: 'moonphase', keywords: 'moonphase, moon phase', actions: 'get', valueType: 'none', category: 'lookup', description: 'the current phase of the moon' },
  { name: 'aqi', keywords: 'aqi', actions: 'get', valueType: 'place', category: 'lookup', description: 'air quality index for a city' },
  { name: 'fx', keywords: 'fx', actions: 'get', valueType: 'currency-pair', category: 'finance', description: 'foreign-exchange rate between two currencies' },
];

type Mode = 'minimal' | 'structured' | 'full';
function renderTP(b: TPBlank, mode: Mode): string {
  if (mode === 'minimal') return `- ${b.name} — keywords: ${b.keywords}. actions: ${b.actions}.`;
  if (mode === 'structured') return `- ${b.name} — keywords: ${b.keywords}. actions: ${b.actions}. value: ${b.valueType}. category: ${b.category}.`;
  return `- ${b.name} — ${b.description}. keywords: ${b.keywords}. actions: ${b.actions}. value: ${b.valueType}. category: ${b.category}.`;
}
const catalogFor = (mode: Mode) =>
  `Available blank-tools (and ONLY these):\n${FIRST_PARTY}\n${THIRD_PARTY.map(b => renderTP(b, mode)).join('\n')}`;

const promptFor = (mode: Mode) => `You are a BLANK-TOOL INVOCATION CLASSIFIER for the OpenCues runtime.
You read a short input ending in _ and decide whether the user is INVOKING one of the blank-tools below, or whether the _ is prose / a lookup that should CEDE.

${catalogFor(mode)}

Output exactly four labelled lines:
VERDICT: INVOKE | CEDE
BLANK: <tool name from the list, or empty>
ACTION: get | set | step | empty
VALUE: <the captured argument, or empty>

INVOKE when the input is a genuine invocation (the user wants this tool's data now). CEDE when the keyword merely appears in prose ("the moon was beautiful _", "the aqi was terrible during the wildfires _", "the fx market was volatile _"), or nothing matches. Pick AT MOST ONE tool; if unsure, CEDE. For lookups VALUE is the entity (place / currency-pair / word).`;

interface Case { id: string; tp: boolean; input: string; expect: { verdict: 'INVOKE' | 'CEDE'; blank?: string; value?: string } }
const CASES: Case[] = [
  // third-party recall (must INVOKE + value)
  { id: 'tp-moon-bare', tp: true, input: 'moonphase _', expect: { verdict: 'INVOKE', blank: 'moonphase' } },
  { id: 'tp-moon-verbose', tp: true, input: "what's the moon phase tonight _", expect: { verdict: 'INVOKE', blank: 'moonphase' } },
  { id: 'tp-aqi-terse', tp: true, input: 'aqi tokyo _', expect: { verdict: 'INVOKE', blank: 'aqi', value: 'tokyo' } },
  { id: 'tp-aqi-delhi', tp: true, input: 'aqi in delhi _', expect: { verdict: 'INVOKE', blank: 'aqi', value: 'delhi' } },
  { id: 'tp-fx-pair', tp: true, input: 'fx usd to eur _', expect: { verdict: 'INVOKE', blank: 'fx', value: 'usd' } },
  { id: 'tp-fx-gbp', tp: true, input: 'fx gbp jpy _', expect: { verdict: 'INVOKE', blank: 'fx', value: 'gbp' } },
  // third-party precision (must CEDE)
  { id: 'tp-moon-prose', tp: true, input: 'the moon was beautiful last night _', expect: { verdict: 'CEDE' } },
  { id: 'tp-aqi-prose', tp: true, input: 'the aqi was terrible during the wildfires _', expect: { verdict: 'CEDE' } },
  { id: 'tp-fx-prose', tp: true, input: 'the fx market was volatile today _', expect: { verdict: 'CEDE' } },
  // a couple first-party controls (should be stable across modes)
  { id: 'fp-weather', tp: false, input: 'weather tokyo _', expect: { verdict: 'INVOKE', blank: 'weather', value: 'tokyo' } },
  { id: 'fp-prose', tp: false, input: 'the weather was lovely today _', expect: { verdict: 'CEDE' } },
];

function parse(raw: string) {
  const g = (l: string) => (raw.match(new RegExp(`^${l}:[ \\t]*(.*?)[ \\t]*$`, 'im'))?.[1] ?? '').trim();
  return { verdict: g('VERDICT').toUpperCase(), blank: g('BLANK').toLowerCase(), value: g('VALUE').toLowerCase() };
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
function score(c: Case, p: { verdict: string; blank: string; value: string }) {
  if (c.expect.verdict === 'CEDE') return p.verdict === 'CEDE';
  return p.verdict === 'INVOKE' && p.blank === c.expect.blank
    && (c.expect.value === undefined || norm(p.value).includes(norm(c.expect.value)));
}

async function pool<T, R>(items: T[], fn: (t: T) => Promise<R>, conc: number): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: conc }, async () => { while (true) { const k = i++; if (k >= items.length) return; out[k] = await fn(items[k]); } }));
  return out;
}

async function main() {
  const i = process.argv.indexOf('--parallel'); const par = i >= 0 ? parseInt(process.argv[i + 1], 10) : 4;
  console.log(`Catalog-trust bench — model ${MODEL}, ${CASES.length} cases × 3 modes\n`);
  for (const mode of ['minimal', 'structured', 'full'] as Mode[]) {
    const sys = promptFor(mode);
    const res = await pool(CASES, async (c) => {
      let p = { verdict: 'CEDE', blank: '', value: '' };
      try { p = parse((await chat(sysUser(sys, c.input))).text); } catch { /* cede */ }
      return { c, p, pass: score(c, p) };
    }, par);
    const tp = res.filter(r => r.c.tp); const fp = res.filter(r => !r.c.tp);
    const tpPass = tp.filter(r => r.pass).length; const fpPass = fp.filter(r => r.pass).length;
    console.log(`── mode=${mode.padEnd(10)} third-party ${tpPass}/${tp.length}   first-party(control) ${fpPass}/${fp.length}`);
    for (const r of tp.filter(r => !r.pass)) console.log(`     MISS ${r.c.id}: "${r.c.input}" exp=${JSON.stringify(r.c.expect)} got=${JSON.stringify(r.p)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
