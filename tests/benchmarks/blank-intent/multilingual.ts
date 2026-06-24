/**
 * BlankIntent — breadth + multilingual stress bench.
 *
 * Four dimensions:
 *   - en        : broad English recall + precision
 *   - en-kw+val : English keyword, NON-English value (realistic — Phase-1
 *                 fires on the English keyword; value is foreign script)
 *   - foreign   : fully non-English invocation (no English keyword) —
 *                 a CAPABILITY test for the classifier. NOTE: in production
 *                 Phase-1's English-keyword gate would NOT fire on these
 *                 unless the blank declares multilingual keywords; reported
 *                 separately for that reason.
 *   - prose     : prose (English + foreign) that must CEDE
 *
 *   OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss CEREBRAS_API_KEY=xxx GROQ_API_KEY=xxx \
 *     npx tsx tests/benchmarks/blank-intent/multilingual.ts [--parallel N]
 */

import { chat, sysUser, MODEL } from '../transform-blank/groq';

const CATALOG = `Available blank-tools (and ONLY these):
- volume — read or set system volume. keywords: volume. actions: get | set (0-100) | step (up/down).
- brightness — read or set screen brightness. keywords: brightness. actions: get | set (0-100) | step.
- weather — current weather for a place. keywords: weather, forecast, temp. action: get (value = the place).
- stocks — current stock price. keywords: a ticker/company (aapl, apple, tesla, nvda, msft). action: get (value = the ticker).
- crypto — current crypto price. keywords: a coin (btc, bitcoin, eth, sol, doge). action: get (value = the coin).
- dictionary — definition of a word. keywords: define, meaning of, what does. action: get (value = the word).
- countries — a fact about a country. keywords: population of, capital of, currency of. action: get (value = "<facet> <country>").`;

const SYSTEM_PROMPT = `You are a BLANK-TOOL INVOCATION CLASSIFIER for the OpenCues runtime.
The input may be in ANY language. Decide whether the user is INVOKING one of the blank-tools below, or whether the _ is prose / a lookup that should CEDE.

${CATALOG}

Output exactly four labelled lines:
VERDICT: INVOKE | CEDE
BLANK: <tool name from the list, or empty>
ACTION: get | set | step | empty
VALUE: <the captured argument verbatim from the input, or empty>

INVOKE on a genuine invocation in any language; map the user's words to the right tool by meaning ("volumen"/"lautstärke" → volume; "tiempo"/"météo"/"wetter"/"天気"/"weather" → weather; "precio de bitcoin" → crypto). CEDE when the keyword merely appears in prose ("the volume was great _", "el volumen estaba genial _", "la météo était belle _"), or nothing matches. Pick AT MOST ONE; if unsure, CEDE. VALUE is the entity (place / ticker / coin / word) copied from the input.`;

interface Case { id: string; lang: string; kind: 'recall' | 'prose'; input: string; expect: { verdict: 'INVOKE' | 'CEDE'; blank?: string; value?: string } }

const CASES: Case[] = [
  // ── en: broad recall ──
  { id: 'en-vol-1', lang: 'en', kind: 'recall', input: 'crank the volume to 80 _', expect: { verdict: 'INVOKE', blank: 'volume', value: '80' } },
  { id: 'en-vol-2', lang: 'en', kind: 'recall', input: 'can you set volume to half _', expect: { verdict: 'INVOKE', blank: 'volume', value: '50' } },
  { id: 'en-wx-1', lang: 'en', kind: 'recall', input: 'forecast for san francisco _', expect: { verdict: 'INVOKE', blank: 'weather', value: 'san francisco' } },
  { id: 'en-wx-2', lang: 'en', kind: 'recall', input: 'is it raining in seattle _', expect: { verdict: 'INVOKE', blank: 'weather', value: 'seattle' } },
  { id: 'en-stk-1', lang: 'en', kind: 'recall', input: 'whats nvidia trading at _', expect: { verdict: 'INVOKE', blank: 'stocks', value: 'nvidia|nvda' } },
  { id: 'en-cry-1', lang: 'en', kind: 'recall', input: 'how much is one ethereum _', expect: { verdict: 'INVOKE', blank: 'crypto', value: 'ethereum|eth' } },
  { id: 'en-dict-1', lang: 'en', kind: 'recall', input: 'meaning of perfunctory _', expect: { verdict: 'INVOKE', blank: 'dictionary', value: 'perfunctory' } },
  { id: 'en-ctry-1', lang: 'en', kind: 'recall', input: 'currency of brazil _', expect: { verdict: 'INVOKE', blank: 'countries', value: 'brazil' } },

  // ── en-kw+val: English keyword, non-English / non-Latin value ──
  { id: 'val-jp', lang: 'en+val', kind: 'recall', input: 'weather 東京 _', expect: { verdict: 'INVOKE', blank: 'weather', value: '東京|tokyo' } },
  { id: 'val-ru', lang: 'en+val', kind: 'recall', input: 'weather Москва _', expect: { verdict: 'INVOKE', blank: 'weather', value: 'москва|moscow' } },
  { id: 'val-ar', lang: 'en+val', kind: 'recall', input: 'weather القاهرة _', expect: { verdict: 'INVOKE', blank: 'weather', value: 'القاهرة|cairo' } },
  { id: 'val-de', lang: 'en+val', kind: 'recall', input: 'define schadenfreude _', expect: { verdict: 'INVOKE', blank: 'dictionary', value: 'schadenfreude' } },
  { id: 'val-pt', lang: 'en+val', kind: 'recall', input: 'capital of são paulo state _', expect: { verdict: 'INVOKE', blank: 'countries' } },

  // ── foreign: fully non-English invocation (no English keyword) ──
  { id: 'es-vol', lang: 'es', kind: 'recall', input: 'sube el volumen a 70 _', expect: { verdict: 'INVOKE', blank: 'volume', value: '70' } },
  { id: 'es-wx', lang: 'es', kind: 'recall', input: 'qué tiempo hace en madrid _', expect: { verdict: 'INVOKE', blank: 'weather', value: 'madrid' } },
  { id: 'es-cry', lang: 'es', kind: 'recall', input: 'precio de bitcoin _', expect: { verdict: 'INVOKE', blank: 'crypto', value: 'bitcoin|btc' } },
  { id: 'fr-wx', lang: 'fr', kind: 'recall', input: 'météo à paris _', expect: { verdict: 'INVOKE', blank: 'weather', value: 'paris' } },
  { id: 'fr-dict', lang: 'fr', kind: 'recall', input: 'définition de sérendipité _', expect: { verdict: 'INVOKE', blank: 'dictionary', value: 'sérendipité|serendipity' } },
  { id: 'de-vol', lang: 'de', kind: 'recall', input: 'lautstärke auf 30 _', expect: { verdict: 'INVOKE', blank: 'volume', value: '30' } },
  { id: 'de-wx', lang: 'de', kind: 'recall', input: 'wetter in berlin _', expect: { verdict: 'INVOKE', blank: 'weather', value: 'berlin' } },
  { id: 'jp-wx', lang: 'jp', kind: 'recall', input: '東京の天気 _', expect: { verdict: 'INVOKE', blank: 'weather', value: '東京|tokyo' } },
  { id: 'zh-wx', lang: 'zh', kind: 'recall', input: '北京的天气 _', expect: { verdict: 'INVOKE', blank: 'weather', value: '北京|beijing' } },

  // ── prose: must CEDE (English + foreign) ──
  { id: 'en-prose-1', lang: 'en', kind: 'prose', input: 'the volume on that album is incredible _', expect: { verdict: 'CEDE' } },
  { id: 'en-prose-2', lang: 'en', kind: 'prose', input: 'bitcoin has been in the news a lot _', expect: { verdict: 'CEDE' } },
  { id: 'es-prose', lang: 'es', kind: 'prose', input: 'el volumen estaba genial anoche _', expect: { verdict: 'CEDE' } },
  { id: 'fr-prose', lang: 'fr', kind: 'prose', input: 'la météo était belle aujourd hui _', expect: { verdict: 'CEDE' } },
  { id: 'de-prose', lang: 'de', kind: 'prose', input: 'das wetter war heute schön _', expect: { verdict: 'CEDE' } },
  { id: 'jp-prose', lang: 'jp', kind: 'prose', input: '昨日の天気は最高だった _', expect: { verdict: 'CEDE' } },
];

function parse(raw: string) {
  const g = (l: string) => (raw.match(new RegExp(`^${l}:[ \\t]*(.*?)[ \\t]*$`, 'im'))?.[1] ?? '').trim();
  return { verdict: g('VERDICT').toUpperCase(), blank: g('BLANK').toLowerCase(), value: g('VALUE') };
}
const norm = (s: string) => s.toLowerCase().normalize('NFC').replace(/\s+/g, ' ').trim();
function score(c: Case, p: { verdict: string; blank: string; value: string }) {
  if (c.expect.verdict === 'CEDE') return p.verdict === 'CEDE';
  if (!(p.verdict === 'INVOKE' && p.blank === c.expect.blank)) return false;
  if (c.expect.value === undefined) return true;
  const pv = norm(p.value);
  return c.expect.value.split('|').some(v => { const nv = norm(v); return nv.length > 0 && (pv.includes(nv) || nv.includes(pv)); });
}

async function pool<T, R>(items: T[], fn: (t: T) => Promise<R>, conc: number): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: conc }, async () => { while (true) { const k = i++; if (k >= items.length) return; out[k] = await fn(items[k]); } }));
  return out;
}

async function main() {
  const i = process.argv.indexOf('--parallel'); const par = i >= 0 ? parseInt(process.argv[i + 1], 10) : 4;
  console.log(`Multilingual BlankIntent bench — model ${MODEL}, ${CASES.length} cases\n`);
  const res = await pool(CASES, async (c) => {
    let p = { verdict: 'CEDE', blank: '', value: '' };
    try { p = parse((await chat(sysUser(SYSTEM_PROMPT, c.input))).text); } catch { /* cede */ }
    return { c, p, pass: score(c, p) };
  }, par);
  const grp: Record<string, { p: number; t: number }> = {};
  for (const r of res) { const k = `${r.c.lang}/${r.c.kind}`; (grp[k] ??= { p: 0, t: 0 }); grp[k].t++; if (r.pass) grp[k].p++; }
  for (const k of Object.keys(grp).sort()) console.log(`  ${k.padEnd(16)} ${grp[k].p}/${grp[k].t}`);
  const pass = res.filter(r => r.pass).length;
  console.log(`  ${'TOTAL'.padEnd(16)} ${pass}/${res.length} (${(100 * pass / res.length).toFixed(0)}%)`);
  for (const r of res.filter(r => !r.pass)) console.log(`     MISS [${r.c.lang}] ${r.c.id}: "${r.c.input}" exp=${JSON.stringify(r.c.expect)} got=${JSON.stringify(r.p)}`);
}
main().catch(e => { console.error(e); process.exit(1); });
