/**
 * Hard-task quality bench — gpt-oss-120b (open) vs gpt-5.4-nano (closed).
 *
 * Purpose: the speed bench's 6-task battery was too easy (all 4
 * candidates passed everything), so it doesn't tell us whether the
 * proprietary nano model is meaningfully smarter than the open weights
 * we're running on Groq. This bench picks tasks designed to break the
 * weaker model — context-sensitive synonyms, obscure factual lookups,
 * multi-step imperative edits, homophone disambiguation, basic
 * arithmetic that small models often fluff.
 *
 * The pass criteria are lenient (substring or set-membership) but the
 * tasks themselves are tighter. A model that 'pattern-matches' without
 * understanding will fail on at least a few.
 */
/* eslint-disable no-console */
import * as https from 'node:https';
import { URL } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  getProvider,
  buildProviderRequest,
  parseProviderResponse,
  type ProviderId,
} from '../src/llm-provider';

interface Candidate { id: ProviderId; model: string; label: string; reasoningEffort?: 'none' | 'low' | 'medium' | 'high' }

const ALL_CANDIDATES: Candidate[] = [
  { id: 'groq',     model: 'openai/gpt-oss-120b', label: 'groq/gpt-oss-120b (low)',       reasoningEffort: 'low' },
  { id: 'groq',     model: 'openai/gpt-oss-120b', label: 'groq/gpt-oss-120b (medium)',    reasoningEffort: 'medium' },
  { id: 'groq',     model: 'openai/gpt-oss-120b', label: 'groq/gpt-oss-120b (high)',      reasoningEffort: 'high' },
  { id: 'cerebras', model: 'gpt-oss-120b',         label: 'cerebras/gpt-oss-120b (low)',     reasoningEffort: 'low' },
  { id: 'cerebras', model: 'gpt-oss-120b',         label: 'cerebras/gpt-oss-120b (medium)',  reasoningEffort: 'medium' },
  { id: 'cerebras', model: 'gpt-oss-120b',         label: 'cerebras/gpt-oss-120b (high)',    reasoningEffort: 'high' },
  { id: 'openai',   model: 'gpt-5.4-nano',         label: 'openai/gpt-5.4-nano (none)',      reasoningEffort: 'none' as 'low' },
  { id: 'openai',   model: 'gpt-5.4-nano',         label: 'openai/gpt-5.4-nano (low)',       reasoningEffort: 'low' },
];

// `BENCH_FILTER=groq,cerebras` to scope. Useful for re-running pairs
// (e.g. just the gpt-oss head-to-head) without burning tokens on the
// rest of the matrix.
const filter = process.env.BENCH_FILTER;
const CANDIDATES: Candidate[] = filter
  ? ALL_CANDIDATES.filter((c) => filter.split(',').some((f) => c.id === f.trim()))
  : ALL_CANDIDATES;

interface Task {
  id: string;
  category: 'word' | 'lookup' | 'transform' | 'spelling' | 'reasoning' | 'rewrite';
  desc: string;
  system: string;
  user: string;
  /** True if output is acceptable. Lenient — substring match unless noted. */
  accept(out: string): boolean;
}

const TASKS: Task[] = [
  // ── Context-sensitive word alternatives ────────────────────────────
  {
    id: 'word-bank-river',
    category: 'word',
    desc: 'word alts: "bank" in river context (NOT financial)',
    system: 'You produce word alternatives that fit the context. Output ONLY index:alts format (e.g. 0:alt1,alt2,alt3). No prose.',
    user: 'sentence: "we sat on the bank watching the river flow"\nword: 0=bank',
    // Should be shore/edge/side, NOT money/financial-related.
    accept: (s) => /\b(shore|edge|side|riverside|bankside|verge|brink)\b/i.test(s)
                && !/\b(money|financ|account|deposit|cash)\b/i.test(s),
  },
  {
    id: 'word-light-weight',
    category: 'word',
    desc: 'word alts: "light" meaning low-weight (NOT illumination)',
    system: 'You produce word alternatives that fit the context. Output ONLY index:alts format. No prose.',
    user: 'sentence: "this backpack is light enough to carry all day"\nword: 0=light',
    accept: (s) => /\b(lightweight|portable|airy|featherweight|unburdens?ome|weightless)\b/i.test(s)
                && !/\b(bright|illuminat|lamp|sun|dawn)\b/i.test(s),
  },
  // ── Obscure factual lookups ────────────────────────────────────────
  {
    id: 'lookup-author',
    category: 'lookup',
    desc: 'fact: who wrote "A Brief History of Time"',
    system: 'Answer with a name only.',
    user: 'Who wrote "A Brief History of Time"?',
    accept: (s) => /stephen\s*hawking/i.test(s),
  },
  {
    id: 'lookup-element',
    category: 'lookup',
    desc: 'fact: chemical symbol for tungsten',
    system: 'Answer with the symbol only, no other text.',
    user: 'Chemical symbol for tungsten?',
    accept: (s) => /^\s*W\b/i.test(s.trim()),
  },
  {
    id: 'lookup-port',
    category: 'lookup',
    desc: 'fact: default port for IMAPS',
    system: 'Answer with the number only.',
    user: 'Default TCP port for IMAPS?',
    accept: (s) => /\b993\b/.test(s),
  },
  {
    id: 'lookup-year',
    category: 'lookup',
    desc: 'fact: year ARPANET went live',
    system: 'Answer with the year only.',
    user: 'In what year did ARPANET first go live?',
    accept: (s) => /\b1969\b/.test(s),
  },
  // ── Multi-step transform-blank ─────────────────────────────────────
  {
    id: 'transform-multi',
    category: 'transform',
    desc: 'transform: change tense AND swap a noun',
    system: 'Apply ALL listed edits. Output ONLY the edited passage.',
    user: 'Edits: (1) change present to past tense, (2) replace "dog" with "cat". Passage: "The dog runs across the field and barks at the cyclist."',
    accept: (s) => /\bcat\s+ran\s+across/i.test(s) && /\bbarked\s+at/i.test(s),
  },
  {
    id: 'transform-list',
    category: 'transform',
    desc: 'transform: alphabetise a list while preserving punctuation',
    system: 'Apply the edit and output ONLY the edited text.',
    user: 'Edit: alphabetise the items. Text: "She bought oranges, apples, pears, and bananas."',
    accept: (s) => /apples,\s*bananas,\s*oranges,?\s*and\s*pears/i.test(s),
  },
  // ── Homophone / subtle spelling ────────────────────────────────────
  {
    id: 'spell-homophone',
    category: 'spelling',
    desc: 'pick correct homophone in context',
    system: 'Output ONLY the corrected sentence.',
    user: 'Pick the right word: "Their/There/They\'re going to the park if its/it\'s sunny."',
    // Accept either correct rendering: "They're going to the park if it's sunny."
    accept: (s) => /they['’]re\s+going.*if\s+it['’]s\s+sunny/i.test(s),
  },
  {
    id: 'spell-context',
    category: 'spelling',
    desc: 'context-dependent spelling: principal vs principle',
    system: 'Fix the wrong word and output ONLY the corrected sentence.',
    user: 'Fix the wrong word: "The school principle made an announcement."',
    accept: (s) => /school\s+principal\s+made/i.test(s),
  },
  // ── Reasoning / arithmetic ─────────────────────────────────────────
  {
    id: 'reason-arith',
    category: 'reasoning',
    desc: 'multi-step arithmetic without showing work',
    system: 'Answer with the number only. No work shown.',
    user: 'Sara has 3 baskets with 12 apples each. She gives away 7 apples. How many remain?',
    accept: (s) => /\b29\b/.test(s),
  },
  {
    id: 'reason-logic',
    category: 'reasoning',
    desc: 'simple syllogism',
    system: 'Answer "yes" or "no" only.',
    user: 'All birds can fly. Penguins are birds. Can penguins fly? (Answer based ONLY on the premises given, ignore real-world knowledge.)',
    accept: (s) => /\byes\b/i.test(s.trim()),
  },
  // ── Compact rewrite (agent surface) ────────────────────────────────
  {
    id: 'rewrite-formal',
    category: 'rewrite',
    desc: 'rewrite informal → formal, preserve meaning',
    system: 'Apply the edit and output ONLY the rewritten text.',
    user: 'Edit: rewrite formally. Text: "yo this thing is super broke and we gotta fix it asap"',
    accept: (s) => !/yo|gotta|asap|super broke/i.test(s)
                && /\b(broken|malfunctioning|nonfunctional)\b/i.test(s)
                && (/immediately|urgently|promptly|as soon as possible/i.test(s) || s.length > 60),
  },
  {
    id: 'rewrite-disambiguate',
    category: 'rewrite',
    desc: 'rewrite to remove ambiguity',
    system: 'Apply the edit and output ONLY the rewritten text.',
    user: 'Edit: remove the ambiguous pronoun "it" by naming what it refers to. Text: "I dropped the phone on the table and it broke."',
    accept: (s) => /\bphone\s+broke/i.test(s) && !/\bit\s+broke\b/i.test(s),
  },
];

// HTTP layer — keep-alive shared agent.
const AGENTS = new Map<string, https.Agent>();
function agentFor(host: string): https.Agent {
  let a = AGENTS.get(host);
  if (!a) { a = new https.Agent({ keepAlive: true, maxSockets: 4, timeout: 60000 }); AGENTS.set(host, a); }
  return a;
}
function postJson(url: string, body: string, headers: Record<string, string>, timeoutMs = 60000): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body).toString() },
      agent: agentFor(u.hostname),
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${timeoutMs}ms`)));
    req.write(body); req.end();
  });
}

interface Result { cand: string; taskId: string; category: string; pass: boolean; ms: number; out: string; err?: string }

async function runOne(c: Candidate, t: Task): Promise<Result> {
  const provider = getProvider(c.id)!;
  const apiKey = process.env[provider.envKeyName]!;
  const built = buildProviderRequest(c.id, {
    model: c.model,
    messages: [{ role: 'system', content: t.system }, { role: 'user', content: t.user }],
    // 1024 (was 300): high-reasoning runs were exhausting the budget on
    // internal reasoning tokens, leaving zero for visible content. With
    // 1024 even gpt-oss-120b at high has headroom on these short tasks.
    maxTokens: 1024,
    temperature: 0,
    reasoningEffort: c.reasoningEffort === 'none' ? undefined : (c.reasoningEffort ?? 'low'),
  }, { apiKey });
  // Patch in OpenAI-only knobs that buildProviderRequest doesn't touch
  // (the ChatRequest type stops at low|medium|high, so 'none' plus
  // verbosity have to be patched here for the gpt-5 line).
  const body = JSON.parse(built.body);
  if (c.id === 'openai' && /^(gpt-5|o\d)/i.test(c.model)) {
    body.reasoning_effort = c.reasoningEffort ?? 'none';
    body.verbosity = 'low';
  }
  const t0 = performance.now();
  try {
    const res = await postJson(built.url, JSON.stringify(body), built.headers, 30000);
    const ms = performance.now() - t0;
    if (res.status !== 200) {
      return { cand: c.label, taskId: t.id, category: t.category, pass: false, ms, out: '', err: `HTTP ${res.status}: ${res.text.slice(0, 80)}` };
    }
    const text = parseProviderResponse(c.id, res.text).trim();
    return { cand: c.label, taskId: t.id, category: t.category, pass: t.accept(text), ms, out: text.slice(0, 100) };
  } catch (err) {
    const ms = performance.now() - t0;
    return { cand: c.label, taskId: t.id, category: t.category, pass: false, ms, out: '', err: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  console.log(`Hard-task bench: ${TASKS.length} tasks × ${CANDIDATES.length} candidates`);
  console.log(`Categories: ${[...new Set(TASKS.map((t) => t.category))].join(', ')}\n`);
  const results: Result[] = [];
  for (const c of CANDIDATES) {
    for (const t of TASKS) {
      process.stderr.write(`  ${c.label.padEnd(34)} ${t.id.padEnd(22)} … `);
      const r = await runOne(c, t);
      results.push(r);
      process.stderr.write(`${r.pass ? 'PASS' : 'FAIL'} ${Math.round(r.ms)}ms\n`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  console.log('\n══ RESULTS ══════════════════════════════════════════════════════════════════');
  console.log('candidate                          | task                   | cat       | ms   | result');
  console.log('-----------------------------------+------------------------+-----------+------+--------');
  for (const r of results) {
    const tag = r.pass ? '\x1b[32m●\x1b[0m' : '✗';
    const out = (r.out || r.err || '').replace(/\n/g, ' ').slice(0, 60);
    console.log(`${r.cand.padEnd(34)} | ${r.taskId.padEnd(22)} | ${r.category.padEnd(9)} | ${String(Math.round(r.ms)).padStart(4)} | ${tag} ${out}`);
  }
  console.log('\n── per-candidate summary ──');
  const byC = new Map<string, { pass: number; total: number; ms: number; byCat: Map<string, { p: number; t: number }> }>();
  for (const r of results) {
    let e = byC.get(r.cand);
    if (!e) { e = { pass: 0, total: 0, ms: 0, byCat: new Map() }; byC.set(r.cand, e); }
    e.total += 1; if (r.pass) e.pass += 1; e.ms += r.ms;
    let cat = e.byCat.get(r.category);
    if (!cat) { cat = { p: 0, t: 0 }; e.byCat.set(r.category, cat); }
    cat.t += 1; if (r.pass) cat.p += 1;
  }
  const ents = Array.from(byC.entries());
  for (const [cand, e] of ents) {
    const cats = Array.from(e.byCat.entries()).map(([k, v]) => `${k}:${v.p}/${v.t}`).join(' ');
    console.log(`  ${cand.padEnd(34)} ${e.pass}/${e.total}  avg ${(e.ms / e.total).toFixed(0)}ms  [${cats}]`);
  }
}
main().catch((e) => { console.error(e); process.exit(2); });
