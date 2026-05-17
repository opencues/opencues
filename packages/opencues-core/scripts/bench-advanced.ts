/**
 * Advanced-features bench — does reasoning_effort actually help on
 * OpenCues's harder LLM surfaces?
 *
 * The earlier hard-task battery saturated at low reasoning. This one
 * uses tasks that match the production paths most likely to benefit
 * from deeper internal thinking:
 *
 *   - TRANSFORM-BLANK : multi-edit imperatives, concept-swap with
 *     dependent-vocab propagation, conditional edits, paragraph
 *     preservation. Uses the actual `P2_APPLY_SYSTEM` prompt from
 *     transform-blank-source.ts.
 *   - AGENT-REWRITE   : full-buffer holistic edits — typo + grammar
 *     mix, parallel-structure repair, tense-agreement, terminator
 *     punctuation under task instruction. Uses the actual
 *     `REWRITE_SYSTEM_PROMPT` from agent-rewrite.ts (with [CURSOR]
 *     sentinel).
 *   - FLUID-BLANK FUSED: span-extraction + answering — the single-call
 *     pass that has to spot a lookup query inside surrounding noise
 *     AND produce a canonical short answer.
 *     Uses the actual `FUSED_SYSTEM_PROMPT` from fluid-blank-source.ts.
 *
 * Verdict criterion: at low reasoning, do these tasks fail more than
 * they did on the easy battery? Does medium / high recover them on
 * Cerebras (the host where deeper reasoning is cheap)?
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

interface Candidate { id: ProviderId; model: string; label: string; reasoningEffort?: 'low' | 'medium' | 'high' }

const ALL_CANDIDATES: Candidate[] = [
  { id: 'groq',     model: 'openai/gpt-oss-120b', label: 'groq (low)',     reasoningEffort: 'low' },
  { id: 'groq',     model: 'openai/gpt-oss-120b', label: 'groq (medium)',  reasoningEffort: 'medium' },
  { id: 'groq',     model: 'openai/gpt-oss-120b', label: 'groq (high)',    reasoningEffort: 'high' },
  { id: 'cerebras', model: 'gpt-oss-120b',         label: 'cerebras (low)',    reasoningEffort: 'low' },
  { id: 'cerebras', model: 'gpt-oss-120b',         label: 'cerebras (medium)', reasoningEffort: 'medium' },
  { id: 'cerebras', model: 'gpt-oss-120b',         label: 'cerebras (high)',   reasoningEffort: 'high' },
];

// Production prompts — copied verbatim from the source modules so the
// bench actually measures what users will see in prod, not a sanitised
// abbreviation.

const P2_APPLY_SYSTEM = `You receive:
- INSTRUCTION: a short imperative editing command
- TARGET: the text to apply the instruction to

Apply the INSTRUCTION to the TARGET and emit the rewritten TARGET. No commentary.

Output exactly one line, nothing else:
REWRITE: <rewritten target>

RULES:
1. Apply the instruction to ALL applicable spans, not just the first.
2. Preserve everything that wasn't targeted (other words, punctuation, casing).
3. For ambiguous co-reference (e.g. "swap genders" with possessive pronouns), pick one consistent interpretation rather than refusing.
4. Output ONLY the rewritten TARGET. Do not include the instruction.
5. CONCEPT-SWAP PROPAGATION — when the instruction names a CATEGORY rather than just two words (e.g. "change pet from dog to cat", "change profession from X to Y", "change era to medieval", "switch sport from X to Y"), update not only the named noun but also the verbs, objects, sounds, and properties that go with it. Cats meow and swish their tails (dogs bark and wag); cars use seatbelts and are driven (bikes use helmets and are ridden). Propagate dependent vocabulary.

   Sub-rules: (a) MINIMAL EDIT — propagate ONLY what's actually inappropriate; words that work for both stay UNCHANGED. (b) PRESERVE STRUCTURE — keep sentence skeleton, possessives. (c) COMPLETE THE ACTION — sport-specific verbs need full action ("dunked the ball" → "kicked the ball INTO THE GOAL").

   LITERAL swaps (no category word — "change boy to girl", "rename foo to bar") do NOT trigger propagation.

6. ROLE PRESERVATION — when the instruction modifies SOME numbers but the target labels them with roles ("original price 100, final price 100"), update ONLY the numbers tied to the named role.

7. COMPOSED INSTRUCTIONS — apply BOTH transforms; result must be grammatical under both constraints.

8. PRESERVE STRUCTURE (paragraphs/line breaks) — preserve \\n\\n verbatim. Multi-paragraph in → multi-paragraph out, same boundaries.

9. CONDITIONAL INSTRUCTIONS ("X but not Y", "X except Y", "X only when Z") — apply ONLY where the condition holds.

EXAMPLES:

INSTRUCTION: change boy to girl
TARGET: the boy ran fast
REWRITE: the girl ran fast

INSTRUCTION: he/she swap
TARGET: he gave the book to John
REWRITE: she gave the book to John

INSTRUCTION: make it british english
TARGET: the color of the harbor is gray
REWRITE: the colour of the harbour is grey`;

const REWRITE_SYSTEM_PROMPT = `You are an inline editor. The user is composing a document and has given you a TASK. Your job: return the rewritten document with the task applied — making whatever spelling, grammar, capitalisation, punctuation, and content changes the task asks for.

The DOCUMENT contains a [CURSOR] marker showing where the user is currently typing. You MUST omit the [CURSOR] marker from your output (it's input only).

Rules:
- Output the ENTIRE rewritten document. Strip the [CURSOR] marker.
- Apply baseline edits even if the TASK doesn't explicitly ask: capitalise sentence-starts and proper nouns, fix obvious typos, collapse duplicated stop-words.
- TERMINAL PUNCTUATION (period, question mark, exclamation): add it ONLY when the sentence has a clear next-sentence after it. NEVER add to the IN-FLIGHT SENTENCE (the one containing [CURSOR]).
- Do NOT add commentary, explanations, code fences. Output the rewritten document and nothing else.

Output format:
REWRITTEN:
<the entire rewritten document, with [CURSOR] stripped>
END`;

interface Task {
  id: string;
  category: 'transform' | 'agent' | 'fluid';
  desc: string;
  system: string;
  user: string;
  accept(out: string): boolean;
}

const TASKS: Task[] = [
  // ── TRANSFORM-BLANK: production P2_APPLY tasks ────────────────────
  {
    id: 'tx-concept-pet',
    category: 'transform',
    desc: 'concept-swap: change pet from dog to cat (vocab propagation)',
    system: P2_APPLY_SYSTEM,
    user: 'INSTRUCTION: change pet from dog to cat\nTARGET: My dog barked at the squirrel and wagged its tail.',
    accept: (s) => /\bcat\b/i.test(s) && /\bmeow|hiss|purr|swish/i.test(s) && !/\bbark/i.test(s),
  },
  {
    id: 'tx-conditional',
    category: 'transform',
    desc: 'conditional edit: capitalise titles but not adjectives',
    system: P2_APPLY_SYSTEM,
    user: 'INSTRUCTION: capitalise role/job titles but leave generic adjectives lowercase\nTARGET: the senior senator spoke to the angry teacher and the brave president',
    // expect: senior senator stays lowercase (descriptor) but Senator/Teacher/President capitalised? Tricky.
    // Lenient: at least Senator and President capitalised, not "angry"/"brave".
    accept: (s) => /\b(Senator|President)\b/.test(s) && !/\bAngry\b/.test(s) && !/\bBrave\b/.test(s),
  },
  {
    id: 'tx-multi-paragraph',
    category: 'transform',
    desc: 'preserve \\n\\n structure across multi-paragraph edit',
    system: P2_APPLY_SYSTEM,
    user: 'INSTRUCTION: change all "I" to "we"\nTARGET: I went to the store.\n\nI bought milk.\n\nI returned home.',
    accept: (s) => {
      const paragraphs = s.split(/\n\n+/);
      return paragraphs.length === 3
        && /we\s+went/i.test(paragraphs[0])
        && /we\s+bought/i.test(paragraphs[1])
        && /we\s+returned/i.test(paragraphs[2]);
    },
  },
  {
    id: 'tx-role-numbers',
    category: 'transform',
    desc: 'role preservation: only change "discount" amount',
    system: P2_APPLY_SYSTEM,
    user: 'INSTRUCTION: change discount from 10 to 25\nTARGET: original price 100, discount 10, final price 90',
    accept: (s) => /discount\s*25/i.test(s) && /original\s*price\s*100/i.test(s),
  },
  {
    id: 'tx-composed',
    category: 'transform',
    desc: 'composed instruction: past tense AND british english',
    system: P2_APPLY_SYSTEM,
    user: 'INSTRUCTION: make past tense and british english\nTARGET: I organize the colors of my favorite analog meters.',
    accept: (s) => /\borganised\b/i.test(s) && /\bcolours\b/i.test(s) && /\bfavourite\b/i.test(s) && /\banalogue\b/i.test(s),
  },
  // ── AGENT-REWRITE: production REWRITE_SYSTEM_PROMPT tasks ─────────
  {
    id: 'agent-typo-mix',
    category: 'agent',
    desc: 'fix multiple typos + grammar in prose',
    system: REWRITE_SYSTEM_PROMPT,
    user: 'TASK: fix typos and grammar\nDOCUMENT:\ni rote a leter to my freind yesturday but the adress was wrong[CURSOR]',
    accept: (s) => /wrote/i.test(s) && /letter/i.test(s) && /friend/i.test(s) && /yesterday/i.test(s) && /address/i.test(s),
  },
  {
    id: 'agent-parallel-struct',
    category: 'agent',
    desc: 'fix parallel structure error',
    system: REWRITE_SYSTEM_PROMPT,
    user: 'TASK: fix grammar\nDOCUMENT:\nI like swimming, hiking, and to read books in the evening.[CURSOR]',
    // Should be "to swim, to hike, and to read" OR "swimming, hiking, and reading"
    accept: (s) => /swimming.*hiking.*reading/i.test(s) || /to\s*swim.*to\s*hike.*to\s*read/i.test(s),
  },
  {
    id: 'agent-tense-agreement',
    category: 'agent',
    desc: 'fix tense agreement across sentences',
    system: REWRITE_SYSTEM_PROMPT,
    user: 'TASK: make consistent past tense\nDOCUMENT:\nThe team played well yesterday. They are working hard. They win the game.[CURSOR]',
    accept: (s) => /played.*were\s*working.*won/is.test(s),
  },
  {
    id: 'agent-no-terminal',
    category: 'agent',
    desc: 'must NOT add terminal punctuation to in-flight sentence',
    system: REWRITE_SYSTEM_PROMPT,
    user: 'TASK: fix typos\nDOCUMENT:\nfirst paragraph done.\n\ni am writing a sentance about[CURSOR]',
    // The in-flight sentence ("i am writing a sentence about") must NOT
    // get a period — model must respect the [CURSOR] rule.
    accept: (s) => {
      const fixed = /sentence\s*about/i.test(s);
      const noTerminator = !/sentence\s*about\s*[.!?]/i.test(s);
      return fixed && noTerminator;
    },
  },
  {
    id: 'agent-formality',
    category: 'agent',
    desc: 'rewrite formal preserving meaning',
    system: REWRITE_SYSTEM_PROMPT,
    user: 'TASK: rewrite this in a formal academic tone\nDOCUMENT:\nso basically the experiment kinda worked but not really, we got some weird numbers and stuff[CURSOR]',
    // Should remove "kinda", "stuff", "weird"; should retain "experiment" + "results"-like words.
    accept: (s) => !/\b(kinda|basically|stuff|weird)\b/i.test(s) && /experiment/i.test(s),
  },
  // ── FLUID-BLANK P1 SEGMENT: span identification under noise ────────
  {
    id: 'fluid-embedded',
    category: 'fluid',
    desc: 'span identification with conversational noise around it',
    system: 'Output exactly two lines:\nSPAN: <exact contiguous substring of the input, including the _>\nCONTEXT: <words from the input outside the span; or "none">',
    user: 'INPUT: hey when are you free we can grab coffee at what is a good cafe in central london _ for tomorrow afternoon',
    // Right answer: SPAN should be the lookup query, not the whole sentence.
    accept: (s) => {
      const m = s.match(/SPAN:\s*(.+?)$/m);
      if (!m) return false;
      const span = m[1].trim();
      // Must contain the lookup phrase shape.
      return /good\s+cafe.*london/i.test(span) && span.includes('_') && span.length < 60;
    },
  },
  {
    id: 'fluid-non-sequitur',
    category: 'fluid',
    desc: 'span where lookup is non-sequitur to surrounding chatter',
    system: 'Output exactly two lines:\nSPAN: <exact contiguous substring of the input, including the _>\nCONTEXT: <words from the input outside the span; or "none">',
    user: 'INPUT: discussing pizza unicode for ampersand _ anyway back to pizza toppings',
    accept: (s) => {
      const m = s.match(/SPAN:\s*(.+?)$/m);
      if (!m) return false;
      const span = m[1].trim();
      return /unicode.*ampersand/i.test(span) && span.includes('_') && !/pizza/i.test(span);
    },
  },
];

// HTTP layer — keep-alive shared.
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
    // 2048 — these production prompts are big (the P2_APPLY system is
    // 2-3k tokens), and high-reasoning needs headroom on top of any
    // generated rewrite. Don't shortchange the budget here.
    maxTokens: 2048,
    temperature: 0,
    reasoningEffort: c.reasoningEffort,
  }, { apiKey });
  const t0 = performance.now();
  try {
    const res = await postJson(built.url, built.body, built.headers, 60000);
    const ms = performance.now() - t0;
    if (res.status !== 200) {
      return { cand: c.label, taskId: t.id, category: t.category, pass: false, ms, out: '', err: `HTTP ${res.status}: ${res.text.slice(0, 80)}` };
    }
    const text = parseProviderResponse(c.id, res.text).trim();
    return { cand: c.label, taskId: t.id, category: t.category, pass: t.accept(text), ms, out: text.slice(0, 120) };
  } catch (err) {
    const ms = performance.now() - t0;
    return { cand: c.label, taskId: t.id, category: t.category, pass: false, ms, out: '', err: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  const filterSet = process.env.BENCH_CAND;
  const cands = filterSet
    ? ALL_CANDIDATES.filter((c) => filterSet.split(',').some((f) => c.label.includes(f)))
    : ALL_CANDIDATES;
  console.log(`Advanced bench: ${TASKS.length} tasks × ${cands.length} candidates\n`);
  const results: Result[] = [];
  for (const c of cands) {
    for (const t of TASKS) {
      process.stderr.write(`  ${c.label.padEnd(22)} ${t.id.padEnd(24)} … `);
      const r = await runOne(c, t);
      results.push(r);
      process.stderr.write(`${r.pass ? 'PASS' : 'FAIL'} ${Math.round(r.ms)}ms\n`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  console.log('\n══ RESULTS ══════════════════════════════════════════════════════════════════');
  for (const r of results) {
    const tag = r.pass ? '✓' : '✗';
    const out = (r.out || r.err || '').replace(/\n/g, ' ').slice(0, 70);
    console.log(`${r.cand.padEnd(22)} | ${r.taskId.padEnd(24)} | ${r.category.padEnd(9)} | ${String(Math.round(r.ms)).padStart(5)}ms | ${tag} ${out}`);
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
  for (const [cand, e] of Array.from(byC.entries())) {
    const cats = Array.from(e.byCat.entries()).map(([k, v]) => `${k}:${v.p}/${v.t}`).join(' ');
    console.log(`  ${cand.padEnd(22)} ${e.pass}/${e.total}  avg ${(e.ms / e.total).toFixed(0)}ms  [${cats}]`);
  }
}
main().catch((e) => { console.error(e); process.exit(2); });
