/**
 * AgentRewrite benchmark runner.
 *
 * Drives the same REWRITE prompt + three-way merge the runtime uses.
 * For each case in `cases.ts`:
 *   1. Send (doc, task) to Groq.
 *   2. Parse the rewritten document from the response.
 *   3. Three-way-merge (snapshot=doc, rewrite=LLM-output, live=doc)
 *      — this is the no-typing scenario; any deltas come from the LLM.
 *   4. Score against the case's `expected` shape.
 *
 * Run with:  GROQ_API_KEY=... npx tsx tests/benchmarks/agent-rewrite/run.ts
 *
 * Flags:
 *   --parallel <N>     Concurrency (default 4).
 *   --category <name>  Run only cases in this category.
 *   --case <id>        Run a single case.
 *   --verbose          Print the LLM's rewrite + merge result for each case.
 */

// Provider selection — defaults to Groq for the canonical benchmark
// runs; set OPENCUES_BENCH_PROVIDER=gemini-flash-lite to route through
// the sibling gemini.ts module (Gemini 3.1 Flash Lite). Same chat()
// signature, same workload — apples-to-apples model comparison.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const _provider = process.env.OPENCUES_BENCH_PROVIDER === 'gemini-flash-lite'
  ? require('./gemini')
  : require('./groq');
const chat: typeof import('./groq').chat = _provider.chat;
const MODEL: string = _provider.MODEL;
import { CASES, type BenchCase } from './cases';
import { threeWayMerge } from '../../../packages/opencues-runtime/src/modules/word-diff';
import { parseRewriteOutput } from '../../../packages/opencues-runtime/src/modules/agent-rewrite';

interface ParsedArgs {
  parallel: number;
  category: string | null;
  caseId: string | null;
  verbose: boolean;
}

function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2);
  const out: ParsedArgs = { parallel: 4, category: null, caseId: null, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--parallel') out.parallel = parseInt(argv[++i] ?? '4', 10);
    else if (a === '--category') out.category = argv[++i] ?? null;
    else if (a === '--case') out.caseId = argv[++i] ?? null;
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

const REWRITE_SYSTEM_PROMPT = `You are an inline editor. The user is composing a document and has given you a TASK. Your job: return the rewritten document with the task applied — making whatever spelling, grammar, capitalisation, punctuation, and content changes the task asks for.

Rules:
- Output the ENTIRE rewritten document. Do not truncate, abbreviate, or summarise.
- Apply baseline edits even if the TASK doesn't explicitly ask: capitalise sentence-starts and proper nouns, fix obvious typos, collapse duplicated stop-words, add missing terminal punctuation on clearly-complete sentences. The TASK runs ON TOP of these baselines.
- Preserve the document's structure: paragraph breaks, line breaks, intentional whitespace.
- Do NOT add stylistic punctuation (salutation commas, appositive commas, em dashes) unless the TASK explicitly asks for it.
- Do NOT add commentary, explanations, code fences, or markdown decorations. Output the rewritten document and nothing else.

Output format:

REWRITTEN:
<the entire rewritten document>
END`;

interface CaseResult {
  readonly id: string;
  readonly category: string;
  readonly pass: boolean;
  readonly latencyMs: number;
  readonly mergedText: string;
  readonly llmRewrite: string;
  readonly reason: string;
}

async function runCase(c: BenchCase): Promise<CaseResult> {
  const userMsg = `TASK: ${c.task}\nDOCUMENT:\n${c.doc}`;
  const t0 = Date.now();
  const { text: response, latencyMs } = await chat(
    [
      { role: 'system', content: REWRITE_SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ],
    { temperature: 0, maxTokens: Math.max(1024, c.doc.length * 2 + 256), seed: 42 },
  );

  const rewrite = parseRewriteOutput(response);
  if (rewrite === null) {
    return {
      id: c.id, category: c.category, pass: false,
      latencyMs, mergedText: c.doc, llmRewrite: response,
      reason: 'parse failed',
    };
  }

  // No-typing scenario: live === snapshot, so the merge result IS the LLM rewrite
  // (modulo whitespace handling + drift checks). Run it through the merge anyway
  // so we exercise the same code path as the runtime.
  const merged = threeWayMerge(c.doc, rewrite, c.doc);
  const mergedText = merged.newText;

  // Score.
  let pass = true;
  let reason = 'ok';
  if (c.expected.equals !== undefined) {
    if (mergedText.trim() !== c.expected.equals.trim()) {
      pass = false;
      reason = `equals mismatch — got "${mergedText.trim()}"`;
    }
  }
  if (pass && c.expected.contains) {
    for (const needle of c.expected.contains) {
      if (!mergedText.includes(needle)) {
        pass = false;
        reason = `missing required substring "${needle}"`;
        break;
      }
    }
  }
  if (pass && c.expected.notContains) {
    for (const forbidden of c.expected.notContains) {
      if (mergedText.includes(forbidden)) {
        pass = false;
        reason = `contains forbidden substring "${forbidden}"`;
        break;
      }
    }
  }

  return { id: c.id, category: c.category, pass, latencyMs, mergedText, llmRewrite: rewrite, reason };
}

async function main(): Promise<void> {
  const args = parseArgs();
  let cases = CASES.slice();
  if (args.category) cases = cases.filter(c => c.category === args.category);
  if (args.caseId) cases = cases.filter(c => c.id === args.caseId);
  if (cases.length === 0) {
    console.error('No cases match.');
    process.exit(1);
  }

  console.log(`Running ${cases.length} case(s) against ${MODEL}, parallel=${args.parallel}\n`);

  const results: CaseResult[] = [];
  // Simple chunked parallel — process N at a time.
  for (let i = 0; i < cases.length; i += args.parallel) {
    const chunk = cases.slice(i, i + args.parallel);
    const got = await Promise.all(chunk.map(runCase));
    for (const r of got) {
      const mark = r.pass ? '\x1b[32m●\x1b[0m' : '✗';
      console.log(`${mark} ${r.id.padEnd(8)} [${r.category.padEnd(22)}] ${r.latencyMs}ms — ${r.reason}`);
      if (args.verbose || !r.pass) {
        console.log(`    rewrite: ${JSON.stringify(r.llmRewrite.slice(0, 120))}${r.llmRewrite.length > 120 ? '…' : ''}`);
        console.log(`    merged:  ${JSON.stringify(r.mergedText.slice(0, 120))}${r.mergedText.length > 120 ? '…' : ''}`);
      }
      results.push(r);
    }
  }

  // Summary.
  const passCount = results.filter(r => r.pass).length;
  const failCount = results.length - passCount;
  const passRate = ((passCount / results.length) * 100).toFixed(1);
  const avgLatency = Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / results.length);

  console.log('');
  console.log(`──────────────────────────────────────────────`);
  console.log(`Pass rate: ${passCount}/${results.length} (${passRate}%) — avg latency ${avgLatency}ms`);

  // By-category breakdown.
  const cats = new Map<string, { pass: number; total: number }>();
  for (const r of results) {
    const e = cats.get(r.category) ?? { pass: 0, total: 0 };
    e.total += 1;
    if (r.pass) e.pass += 1;
    cats.set(r.category, e);
  }
  console.log('');
  console.log('By category:');
  for (const [cat, e] of [...cats.entries()].sort()) {
    const pct = ((e.pass / e.total) * 100).toFixed(0);
    console.log(`  ${cat.padEnd(24)} ${e.pass}/${e.total}  ${pct}%`);
  }

  if (failCount > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
