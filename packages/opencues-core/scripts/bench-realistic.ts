/**
 * Realistic-prompts bench.
 *
 * Uses the FULL production prompts (imported from src/sources/, no
 * abbreviation) and realistic-shape cases lifted from the existing
 * fixture suites. The earlier `bench-advanced` was contaminated by my
 * abbreviated fluid prompt (it had no examples, so all candidates
 * failed). This bench fixes that.
 *
 * Suites:
 *   AGENT-REWRITE  — 14 cases from tests/benchmarks/agent-rewrite/
 *                    cases.ts, using REWRITE_SYSTEM_PROMPT verbatim.
 *   TRANSFORM-BLANK — 12 cases mirroring the production prompt's
 *                    advertised behaviours (concept-swap propagation,
 *                    composed instructions, role preservation,
 *                    paragraph structure, conditional, multi-span,
 *                    british-english, gender swap, generative add).
 *                    Uses P2_APPLY_SYSTEM verbatim.
 *   FLUID-BLANK P1 — 12 cases from tests/benchmarks/fluid-blank/
 *                    cases.ts. Uses the FULL P1_SYSTEM_PROMPT (130+
 *                    lines of examples) so the model has the same
 *                    spec it gets in prod.
 *
 * Candidates: groq + cerebras at low / medium / high. OpenAI excluded
 * because earlier benches showed it ~5× slower at the same quality.
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
import { P1_SYSTEM_PROMPT, P3_SYSTEM_PROMPT } from '../src/sources/fluid-blank-source';
import { P2_APPLY_SYSTEM } from '../src/sources/transform-blank-source';

interface Candidate { id: ProviderId; model: string; label: string; reasoningEffort: 'low' | 'medium' | 'high' }

const ALL_CANDIDATES: Candidate[] = [
  { id: 'groq',     model: 'openai/gpt-oss-120b', label: 'groq (low)',       reasoningEffort: 'low' },
  { id: 'groq',     model: 'openai/gpt-oss-120b', label: 'groq (medium)',    reasoningEffort: 'medium' },
  { id: 'groq',     model: 'openai/gpt-oss-120b', label: 'groq (high)',      reasoningEffort: 'high' },
  { id: 'cerebras', model: 'gpt-oss-120b',         label: 'cerebras (low)',     reasoningEffort: 'low' },
  { id: 'cerebras', model: 'gpt-oss-120b',         label: 'cerebras (medium)',  reasoningEffort: 'medium' },
  { id: 'cerebras', model: 'gpt-oss-120b',         label: 'cerebras (high)',    reasoningEffort: 'high' },
];

// Inline the agent-rewrite REWRITE_SYSTEM_PROMPT — lives in the runtime
// package, not directly importable from core. Verbatim copy of
// packages/opencues-runtime/src/modules/agent-rewrite.ts.
const REWRITE_SYSTEM_PROMPT = `You are an inline editor. The user is composing a document and has given you a TASK. Your job: return the rewritten document with the task applied — making whatever spelling, grammar, capitalisation, punctuation, and content changes the task asks for.

The DOCUMENT contains a [CURSOR] marker showing where the user is currently typing. You MUST omit the [CURSOR] marker from your output (it's input only). Use it to identify the IN-FLIGHT SENTENCE — the sentence containing the cursor — which the user is still composing and may extend at any moment.

Rules:
- Output the ENTIRE rewritten document. Do not truncate, abbreviate, or summarise. Strip the [CURSOR] marker.
- Apply baseline edits even if the TASK doesn't explicitly ask: capitalise sentence-starts and proper nouns, fix obvious typos, collapse duplicated stop-words.
- TERMINAL PUNCTUATION (period, question mark, exclamation): add it ONLY when the sentence has a clear next-sentence after it (paragraph break, OR another sentence starting with a capitalised word). NEVER add terminal punctuation to the IN-FLIGHT SENTENCE — the user may still be typing it. NEVER add it to a sentence at the very end of the document with no following content.
- WHITESPACE STRUCTURE IS SACRED. Reproduce every newline EXACTLY as it appears in the input. A paragraph break (\\n\\n) MUST stay \\n\\n. A single newline MUST stay a single newline. Do NOT collapse \\n\\n into \\n, do NOT remove trailing newlines, do NOT canonicalise spacing. The user's whitespace structure is the user's choice.
- Do NOT add stylistic punctuation (salutation commas, appositive commas, em dashes) unless the TASK explicitly asks for it.
- Do NOT add commentary, explanations, code fences, or markdown decorations. Output the rewritten document and nothing else.

Output format:

REWRITTEN:
<the entire rewritten document, with [CURSOR] stripped>
END`;

// Tiny copy of agent-rewrite parser so the bench can verify that
// REWRITTEN/END framing was respected.
function parseRewriteOut(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^```(?:\w+)?\n/, '').replace(/\n```$/, '').trim();
  const m = s.match(/REWRITTEN:\s*\n/i);
  if (m) {
    const start = m.index! + m[0].length;
    let tail = s.slice(start);
    const end = tail.match(/^\s*END\s*$/im);
    if (end) tail = tail.slice(0, end.index!);
    s = tail.trim();
  }
  s = s.replace(/\n\s*END\s*$/i, '').trim();
  return s;
}

// ── Agent-rewrite cases (lifted from the fixture file) ───────────────

interface AgentCase {
  id: string;
  category: string;
  task: string;
  doc: string;                     // pre-[CURSOR] document
  cursorAt?: 'end';                // where to inject [CURSOR]
  expect: { equals?: string; contains?: string[]; notContains?: string[] };
}

const AGENT_CASES: AgentCase[] = [
  { id: 'sp-1', category: 'spelling', task: 'correct spelling', doc: 'I rite some text.',
    expect: { equals: 'I write some text.' } },
  { id: 'sp-2', category: 'spelling', task: 'correct spelling',
    doc: 'thier proposal was carefuly recieved.',
    expect: { contains: ['their', 'carefully', 'received'] } },
  { id: 'sp-3', category: 'spelling', task: 'correct spelling',
    doc: 'The team made significnt progress on the new platfrom.',
    expect: { contains: ['significant', 'platform'] } },
  { id: 'cap-1', category: 'capitalisation', task: 'capitalise sentence starts and proper nouns',
    doc: 'i went to london on monday with john.',
    expect: { contains: ['London', 'Monday', 'John'] } },
  { id: 'tr-1', category: 'translation', task: 'translate to spanish',
    doc: 'Monday Tuesday Wednesday',
    expect: { contains: ['lunes', 'martes'] } },
  { id: 'tr-2', category: 'translation', task: 'translate to french',
    doc: 'I want a cup of coffee.',
    expect: { contains: ['café'], notContains: ['coffee'] } },
  { id: 'gr-1', category: 'grammar', task: 'fix grammar',
    doc: 'I went to the the store yesterday.',
    expect: { equals: 'I went to the store yesterday.' } },
  { id: 'gr-2', category: 'grammar', task: 'fix grammar',
    doc: 'we went any way we could.',
    expect: { contains: ['anyway'] } },
  { id: 'ps-1', category: 'paragraph-structure', task: 'correct spelling',
    doc: 'first para has typoo.\n\nsecond para is fine.',
    expect: { contains: ['typo.', '\n\n'], notContains: ['typoo'] } },
  { id: 'ps-2', category: 'paragraph-structure', task: 'fix grammar and spelling',
    doc: 'Hi boi.\n\nI rite stuff here.\n\nWhat next?',
    expect: { contains: ['Hi boy', 'write stuff', '\n\n'] } },
  { id: 'id-1', category: 'idempotent', task: 'correct spelling',
    doc: 'This sentence is already perfect.',
    expect: { equals: 'This sentence is already perfect.' } },
  { id: 'st-1', category: 'style-formal', task: 'make formal',
    doc: 'hey whats up?',
    expect: { contains: ['Hello'], notContains: ['whats'] } },
  { id: 'st-2', category: 'style-british', task: 'use british english spelling',
    doc: 'I love the color of this organization.',
    expect: { contains: ['colour', 'organisation'] } },
  { id: 'lng-1', category: 'long-doc', task: 'correct spelling',
    doc: 'The team worked on the itteration and made significnt progress\nover two weeks on the new platform launching next month.\n\nEveryone on the team and our customrs were definately impressed\nby the speed of delivery and the quality of work.',
    expect: { contains: ['iteration', 'significant', 'customers', 'definitely'], notContains: ['itteration', 'customrs'] } },
];

// ── Transform-blank cases ────────────────────────────────────────────

interface TransformCase {
  id: string;
  category: string;
  instruction: string;
  target: string;
  accept(out: string): boolean;
}

const TRANSFORM_CASES: TransformCase[] = [
  { id: 'tx-literal-swap', category: 'literal',
    instruction: 'change boy to girl',
    target: 'the boy ran fast and the boy waved',
    accept: (s) => /the\s+girl\s+ran\s+fast.*the\s+girl\s+waved/i.test(s) },
  { id: 'tx-pronoun-swap', category: 'pronoun',
    instruction: 'he/she swap',
    target: 'he gave the book to John and then he left',
    accept: (s) => /she\s+gave/i.test(s) && /she\s+left/i.test(s) && !/\bhe\s+gave/i.test(s) },
  { id: 'tx-british', category: 'style',
    instruction: 'make it british english',
    target: 'the color of the harbor is gray',
    accept: (s) => /\bcolour\b/i.test(s) && /\bharbour\b/i.test(s) && /\bgrey\b/i.test(s) },
  { id: 'tx-tense', category: 'grammar',
    instruction: 'make past tense',
    target: 'I run to the store every day and I buy milk',
    accept: (s) => /\bran\s+to\b/i.test(s) && /\bbought\s+milk\b/i.test(s) },
  { id: 'tx-concept-pet', category: 'concept-swap',
    instruction: 'change pet from dog to cat',
    target: 'My dog barked at the squirrel and wagged its tail.',
    accept: (s) => /\bcat\b/i.test(s) && /(meow|hiss|purr|swish)/i.test(s) && !/bark/i.test(s) },
  { id: 'tx-concept-vehicle', category: 'concept-swap',
    instruction: 'change vehicle from car to bicycle',
    target: 'I drove the car down the highway with the radio on',
    accept: (s) => /\bbicycle|bike\b/i.test(s) && /(rode|cycled|pedalled|pedaled)/i.test(s) && !/highway/i.test(s) /* bikes don't go on highways */ },
  { id: 'tx-composed', category: 'composed',
    instruction: 'make past tense and british english',
    target: 'I organize the colors of my favorite analog meters.',
    accept: (s) => /\borganised\b/i.test(s) && /\bcolours\b/i.test(s) && /\bfavourite\b/i.test(s) && /\banalogue\b/i.test(s) },
  { id: 'tx-role-numbers', category: 'role-preservation',
    instruction: 'change discount from 10 to 25',
    target: 'original price 100, discount 10, final price 90',
    accept: (s) => /discount\s*25/i.test(s) && /original\s*price\s*100/i.test(s) && !/discount\s*10/i.test(s) },
  { id: 'tx-multi-paragraph', category: 'structure',
    instruction: 'change all "I" to "we"',
    target: 'I went to the store.\n\nI bought milk.\n\nI returned home.',
    accept: (s) => {
      const ps = s.split(/\n\n+/);
      return ps.length === 3 && /we\s+went/i.test(ps[0]) && /we\s+bought/i.test(ps[1]) && /we\s+returned/i.test(ps[2]);
    } },
  { id: 'tx-conditional', category: 'conditional',
    instruction: 'capitalise proper nouns but not common nouns',
    target: 'i met john in london last tuesday',
    accept: (s) => /\bJohn\b/.test(s) && /\bLondon\b/.test(s) && /\bTuesday\b/.test(s) && /\bmet\b/.test(s) /* lowercase verb stays */ },
  { id: 'tx-multi-span', category: 'multi-span',
    instruction: 'replace all instances of "thing" with "object"',
    target: 'The thing on the table is the same thing I saw earlier; that thing was odd.',
    accept: (s) => (s.match(/\bobject\b/gi)?.length ?? 0) >= 3 && !/\bthing\b/i.test(s) },
  { id: 'tx-generative', category: 'generative',
    instruction: 'add a polite closing greeting',
    target: 'Dear team,\n\nWe will meet on Thursday.',
    accept: (s) => /(regards|sincerely|best|cheers|kind\s*regards|warmly)/i.test(s) && /thursday/i.test(s) },
];

// ── Fluid-blank P1 SEGMENT cases (real fixtures) ─────────────────────

interface FluidCase {
  id: string;
  category: string;
  input: string;
  /** Substring that the SPAN should contain (case-insensitive). */
  spanContains: string[];
  /** Words that should NOT appear in the SPAN (chatter that belongs in CONTEXT). */
  spanNotContains: string[];
}

const FLUID_CASES: FluidCase[] = [
  // INLINE — preamble + lookup + _
  { id: 'f-unicode', category: 'inline',
    input: 'writing my doc unicode for underscore _',
    spanContains: ['unicode', 'underscore', '_'],
    spanNotContains: ['writing', 'my', 'doc'] },
  { id: 'f-hex-color', category: 'inline',
    input: 'css project hex for tomato red _',
    spanContains: ['hex', 'tomato', 'red', '_'],
    spanNotContains: ['css', 'project'] },
  { id: 'f-port', category: 'inline',
    input: 'firewall config default port for postgres _',
    spanContains: ['port', 'postgres', '_'],
    spanNotContains: ['firewall', 'config'] },
  { id: 'f-conversion', category: 'inline',
    input: 'recipe testing 100 celsius in fahrenheit _',
    spanContains: ['100', 'celsius', 'fahrenheit', '_'],
    spanNotContains: ['recipe', 'testing'] },
  { id: 'f-translation', category: 'inline',
    input: 'anniversary card french word for love _',
    spanContains: ['french', 'love', '_'],
    spanNotContains: ['anniversary', 'card'] },
  { id: 'f-atomic', category: 'inline',
    input: 'chem homework atomic number of gold _',
    spanContains: ['atomic', 'gold', '_'],
    spanNotContains: ['chem', 'homework'] },
  // EMBEDDED-WH — message-style chat with a wh-question embedded
  { id: 'f-embedded-wh', category: 'embedded',
    input: 'hey when are you free we can go to what is a good cafe in central london _',
    spanContains: ['cafe', 'london', '_'],
    spanNotContains: ['hey', 'free'] },
  { id: 'f-embedded-mime', category: 'embedded',
    input: 'travel planning chat I wonder what is the mime type for avi _',
    spanContains: ['mime', 'avi', '_'],
    spanNotContains: ['travel', 'planning', 'chat'] },
  // NON-SEQUITUR — lookup is unrelated to surrounding chatter
  { id: 'f-nonseq-pizza', category: 'non-sequitur',
    input: 'discussing pizza unicode for ampersand _ anyway back to pizza',
    spanContains: ['unicode', 'ampersand', '_'],
    spanNotContains: ['pizza'] },
  // COMPACT FACTUAL — short sentence with _, no preamble
  { id: 'f-compact', category: 'compact',
    input: 'Water boils at _ degrees Celsius',
    spanContains: ['water', 'boils', '_'],
    spanNotContains: [] },
  // LONG PREAMBLE
  { id: 'f-long-preamble', category: 'long-preamble',
    input: 'spent the morning reviewing client deliverables and finalizing the contract negotiations with the new vendor before lunch break atomic number of iron _',
    spanContains: ['atomic', 'iron', '_'],
    spanNotContains: ['client', 'deliverables', 'lunch'] },
  // SHOULD FAIL SOFT — _ is a UI placeholder, no lookup
  { id: 'f-no-lookup', category: 'no-lookup',
    input: 'fix _ here',
    spanContains: [] /* SPAN should be NONE */,
    spanNotContains: ['fix', 'here'] },
];

// ── HTTP layer ───────────────────────────────────────────────────────

const AGENTS = new Map<string, https.Agent>();
function agentFor(host: string): https.Agent {
  let a = AGENTS.get(host);
  if (!a) { a = new https.Agent({ keepAlive: true, maxSockets: 4, timeout: 60000 }); AGENTS.set(host, a); }
  return a;
}
function postJson(url: string, body: string, headers: Record<string, string>, timeoutMs = 90000): Promise<{ status: number; text: string }> {
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

interface Result { cand: string; suite: string; taskId: string; pass: boolean; ms: number; out: string; err?: string }

async function callLLM(c: Candidate, system: string, user: string, maxTokens = 2048): Promise<{ ok: boolean; ms: number; text: string; err?: string }> {
  const provider = getProvider(c.id)!;
  const apiKey = process.env[provider.envKeyName]!;
  const built = buildProviderRequest(c.id, {
    model: c.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    maxTokens,
    temperature: 0,
    reasoningEffort: c.reasoningEffort,
  }, { apiKey });
  const t0 = performance.now();
  try {
    const res = await postJson(built.url, built.body, built.headers, 90000);
    const ms = performance.now() - t0;
    if (res.status !== 200) {
      return { ok: false, ms, text: '', err: `HTTP ${res.status}: ${res.text.slice(0, 80)}` };
    }
    return { ok: true, ms, text: parseProviderResponse(c.id, res.text).trim() };
  } catch (err) {
    return { ok: false, ms: performance.now() - t0, text: '', err: err instanceof Error ? err.message : String(err) };
  }
}

// ── Suite runners ────────────────────────────────────────────────────

async function runAgent(c: Candidate, t: AgentCase): Promise<Result> {
  const userMsg = `TASK: ${t.task}\nDOCUMENT:\n${t.doc}[CURSOR]`;
  const r = await callLLM(c, REWRITE_SYSTEM_PROMPT, userMsg, 2048);
  if (!r.ok) return { cand: c.label, suite: 'agent', taskId: t.id, pass: false, ms: r.ms, out: '', err: r.err };
  const parsed = parseRewriteOut(r.text);
  let pass = true;
  if (t.expect.equals !== undefined) pass = parsed === t.expect.equals;
  if (t.expect.contains) pass = pass && t.expect.contains.every((c) => parsed.includes(c));
  if (t.expect.notContains) pass = pass && !t.expect.notContains.some((c) => parsed.toLowerCase().includes(c.toLowerCase()));
  return { cand: c.label, suite: 'agent', taskId: t.id, pass, ms: r.ms, out: parsed.replace(/\n/g, '⏎').slice(0, 90) };
}

async function runTransform(c: Candidate, t: TransformCase): Promise<Result> {
  const userMsg = `INSTRUCTION: ${t.instruction}\nTARGET: ${t.target}`;
  const r = await callLLM(c, P2_APPLY_SYSTEM, userMsg, 1024);
  if (!r.ok) return { cand: c.label, suite: 'transform', taskId: t.id, pass: false, ms: r.ms, out: '', err: r.err };
  // The prompt asks for "REWRITE: <text>"; tolerate either prefix or
  // bare output.
  const m = r.text.match(/^REWRITE:\s*(.+)$/im);
  const rewrite = (m ? m[1] : r.text).trim();
  return { cand: c.label, suite: 'transform', taskId: t.id, pass: t.accept(rewrite), ms: r.ms, out: rewrite.slice(0, 90) };
}

async function runFluid(c: Candidate, t: FluidCase): Promise<Result> {
  const userMsg = `INPUT: ${t.input}`;
  const r = await callLLM(c, P1_SYSTEM_PROMPT, userMsg, 256);
  if (!r.ok) return { cand: c.label, suite: 'fluid', taskId: t.id, pass: false, ms: r.ms, out: '', err: r.err };
  const m = r.text.match(/^SPAN:\s*(.*?)$/m);
  if (!m) return { cand: c.label, suite: 'fluid', taskId: t.id, pass: false, ms: r.ms, out: r.text.slice(0, 90), err: 'no SPAN line' };
  const span = m[1].trim();
  const isNoneCase = t.spanContains.length === 0;
  if (isNoneCase) {
    // Should be NONE (or empty) — accept either.
    return { cand: c.label, suite: 'fluid', taskId: t.id, pass: /^NONE$/i.test(span) || span === '', ms: r.ms, out: `SPAN=${span.slice(0, 60)}` };
  }
  const pass = t.spanContains.every((s) => span.toLowerCase().includes(s.toLowerCase()))
    && !t.spanNotContains.some((s) => span.toLowerCase().includes(s.toLowerCase()))
    && span.includes('_');
  return { cand: c.label, suite: 'fluid', taskId: t.id, pass, ms: r.ms, out: `SPAN=${span.slice(0, 60)}` };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const filterEnv = process.env.BENCH_CAND;
  const cands = filterEnv
    ? ALL_CANDIDATES.filter((c) => filterEnv.split(',').some((f) => c.label.includes(f)))
    : ALL_CANDIDATES;
  const totalTasks = AGENT_CASES.length + TRANSFORM_CASES.length + FLUID_CASES.length;
  console.log(`Realistic-prompts bench: ${totalTasks} tasks (${AGENT_CASES.length} agent + ${TRANSFORM_CASES.length} transform + ${FLUID_CASES.length} fluid) × ${cands.length} candidates`);
  console.log('Candidates:', cands.map((c) => c.label).join(', '), '\n');

  const results: Result[] = [];
  for (const c of cands) {
    process.stderr.write(`── ${c.label} ──\n`);
    for (const t of AGENT_CASES) {
      process.stderr.write(`  agent     ${t.id.padEnd(10)} … `);
      const r = await runAgent(c, t); results.push(r);
      process.stderr.write(`${r.pass ? 'PASS' : 'FAIL'} ${Math.round(r.ms)}ms\n`);
      await new Promise((r) => setTimeout(r, 150));
    }
    for (const t of TRANSFORM_CASES) {
      process.stderr.write(`  transform ${t.id.padEnd(20)} … `);
      const r = await runTransform(c, t); results.push(r);
      process.stderr.write(`${r.pass ? 'PASS' : 'FAIL'} ${Math.round(r.ms)}ms\n`);
      await new Promise((r) => setTimeout(r, 150));
    }
    for (const t of FLUID_CASES) {
      process.stderr.write(`  fluid     ${t.id.padEnd(20)} … `);
      const r = await runFluid(c, t); results.push(r);
      process.stderr.write(`${r.pass ? 'PASS' : 'FAIL'} ${Math.round(r.ms)}ms\n`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  // Per-suite summary, then per-candidate.
  console.log('\n══ PER-CANDIDATE × SUITE ════════════════════════════════════════════════════');
  console.log('candidate              | agent       | transform  | fluid     | total      | avg ms');
  console.log('-----------------------+-------------+------------+-----------+------------+--------');
  const suites = ['agent', 'transform', 'fluid'] as const;
  for (const c of cands) {
    const my = results.filter((r) => r.cand === c.label);
    const counts = suites.map((s) => {
      const slice = my.filter((r) => r.suite === s);
      const p = slice.filter((r) => r.pass).length;
      return { s, p, t: slice.length };
    });
    const totP = counts.reduce((a, b) => a + b.p, 0);
    const totT = counts.reduce((a, b) => a + b.t, 0);
    const avgMs = my.reduce((a, b) => a + b.ms, 0) / my.length;
    const cells = counts.map(({ p, t }) => `${p}/${t}`.padStart(6));
    console.log(`${c.label.padEnd(22)} | ${cells[0].padEnd(11)} | ${cells[1].padEnd(10)} | ${cells[2].padEnd(9)} | ${(totP + '/' + totT).padEnd(10)} | ${avgMs.toFixed(0)}ms`);
  }

  console.log('\n══ FAILURES (per task, by candidate) ════════════════════════════════════════');
  const taskOrder = [
    ...AGENT_CASES.map((t) => ({ id: t.id, suite: 'agent', label: `${t.category} / ${t.task}` })),
    ...TRANSFORM_CASES.map((t) => ({ id: t.id, suite: 'transform', label: `${t.category} / ${t.instruction}` })),
    ...FLUID_CASES.map((t) => ({ id: t.id, suite: 'fluid', label: `${t.category}` })),
  ];
  for (const tk of taskOrder) {
    const row = cands.map((c) => results.find((r) => r.cand === c.label && r.taskId === tk.id));
    const allPass = row.every((r) => r?.pass);
    if (allPass) continue;
    console.log(`  [${tk.suite}] ${tk.id} (${tk.label})`);
    for (let i = 0; i < cands.length; i += 1) {
      const r = row[i]!;
      const tag = r.pass ? '   ✓' : '   ✗';
      console.log(`     ${tag} ${cands[i].label.padEnd(20)} ${r.out || r.err || ''}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
