/**
 * Thinking-budget benchmark — how does latency + accuracy scale with
 * reasoning effort, per provider?
 *
 * Question this answers: "how much thinking can I afford on each
 * model before its latency exceeds my use-case threshold?"
 *
 * Workload: 40-case subset of the fluid-blank suite (curated mix of
 * easy + hard across categories — codepoints, math, geography,
 * history, science, translations). Single LLM call per case via the
 * production fused prompt. Real numbers, real network, deterministic
 * answer regex check (no LLM judge — keeps the bench fast and
 * reproducible).
 *
 * Each provider runs 4 levels: none / low / medium / high. Cell
 * results: median, mean, p95 latency + accuracy. Then we apply
 * use-case latency thresholds (word-cue 500ms, fluid-blank 1500ms,
 * transform-blank 3000ms — the p50 the user perceives as "feels
 * instant" / "tolerable wait" / "long but acceptable") to compute
 * each provider's max useable thinking budget per pipeline.
 *
 * Provider thinking parameters:
 *
 *   Groq gpt-oss-120b    reasoning_effort: none|low|medium|high
 *   Cerebras gpt-oss-120b reasoning_effort: none|low|medium|high
 *   OpenAI gpt-5.4-mini  reasoning_effort: minimal|low|medium|high
 *                        (we map none → minimal; chat-latest min is medium)
 *   Gemini Flash Lite    thinkingConfig.thinkingLevel: low|high
 *                        (no medium — mapped to low; none = budget 0)
 *
 * Usage:
 *   GROQ_API_KEY=... CEREBRAS_API_KEY=... GEMINI_API_KEY=... OPENAI_API_KEY=... \
 *     npx tsx tests/benchmarks/thinking-budget/run.ts
 *   Subset providers via PROVIDERS=groq,cerebras
 *   Subset levels via LEVELS=low,medium
 */

import { CASES as ALL_CASES, type FluidBlankCase } from '../fluid-blank/cases';
import { SYSTEM_PROMPT, parseFusedOutput } from '../fluid-blank/fused';
import * as groqImpl from '../fluid-blank/groq-impl';
import * as cerebrasImpl from '../fluid-blank/cerebras';
import * as geminiImpl from '../fluid-blank/gemini';
import * as openaiImpl from '../fluid-blank/openai';

type Reasoning = 'none' | 'low' | 'medium' | 'high';
type ProviderId = 'groq' | 'cerebras' | 'gemini' | 'openai';

const PARALLEL = parseInt(process.env.PARALLEL ?? '8', 10);
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS ?? '512', 10);

interface Adapter {
  id: ProviderId;
  modelLabel: string;
  chat: (msgs: { role: 'system' | 'user' | 'assistant'; content: string }[], opts: { maxTokens?: number; seed?: number; reasoning?: Reasoning }) => Promise<{ text: string; latencyMs: number }>;
}

function pickAdapters(): Adapter[] {
  const want = (process.env.PROVIDERS ?? 'groq,cerebras,gemini,openai').split(',').map(s => s.trim());
  const all: Adapter[] = [];
  if (process.env.GROQ_API_KEY && want.includes('groq')) all.push({ id: 'groq', modelLabel: 'groq · ' + groqImpl.MODEL, chat: groqImpl.chat });
  if (process.env.CEREBRAS_API_KEY && want.includes('cerebras')) all.push({ id: 'cerebras', modelLabel: 'cerebras · ' + cerebrasImpl.MODEL, chat: cerebrasImpl.chat });
  if (process.env.GEMINI_API_KEY && want.includes('gemini')) all.push({ id: 'gemini', modelLabel: 'gemini · ' + geminiImpl.MODEL, chat: geminiImpl.chat });
  if (process.env.OPENAI_API_KEY && want.includes('openai')) all.push({ id: 'openai', modelLabel: 'openai · ' + openaiImpl.MODEL, chat: openaiImpl.chat });
  return all;
}

function pickLevels(): Reasoning[] {
  const want = (process.env.LEVELS ?? 'none,low,medium,high').split(',').map(s => s.trim()) as Reasoning[];
  return want;
}

// Acceptance: case-insensitive substring match against expected.answer
// OR any of answerAlternates. No LLM judge — these are short factual
// answers with stable forms.
function judgePass(c: FluidBlankCase, actual: string): boolean {
  if (c.expected.shouldFailSoft) {
    // shouldFailSoft cases should produce no answer
    return actual === '' || actual.toUpperCase() === 'NONE';
  }
  const haystack = actual.toLowerCase();
  if (haystack.includes(c.expected.answer.toLowerCase())) return true;
  for (const alt of c.expected.answerAlternates ?? []) {
    if (haystack.includes(alt.toLowerCase())) return true;
  }
  return false;
}

// Take every Nth case to get a ~40-case stratified sample of the
// full 137-case suite. The full suite is grouped by category in
// declaration order; stride sampling keeps the mix representative
// without manual ID curation. Override the size via SUBSET=N.
const SUBSET_SIZE = parseInt(process.env.SUBSET ?? '40', 10);
const stride = Math.max(1, Math.floor(ALL_CASES.length / SUBSET_SIZE));
const CASES = ALL_CASES.filter((_, i) => i % stride === 0).slice(0, SUBSET_SIZE);

interface CellResult {
  provider: ProviderId;
  reasoning: Reasoning;
  pass: number;
  total: number;
  latencies: number[];
  errors: number;
}

function pctile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

async function runCell(adapter: Adapter, reasoning: Reasoning): Promise<CellResult> {
  const result: CellResult = {
    provider: adapter.id,
    reasoning,
    pass: 0,
    total: CASES.length,
    latencies: [],
    errors: 0,
  };

  const sysUser = (sys: string, user: string) => [
    { role: 'system' as const, content: sys },
    { role: 'user' as const, content: user },
  ];

  // Run with bounded parallelism — too high triggers rate limits.
  const queue = [...CASES];
  let firstErr: string | undefined;
  let firstMiss: string | undefined;
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const c = queue.shift();
      if (!c) return;
      try {
        const r = await adapter.chat(sysUser(SYSTEM_PROMPT, `INPUT: ${c.input}`), {
          maxTokens: MAX_TOKENS, seed: 42, reasoning,
        });
        const parsed = parseFusedOutput(r.text, r.latencyMs);
        const actual = parsed.answer ?? '';
        if (judgePass(c, actual)) result.pass++;
        else if (!firstMiss) firstMiss = `case ${c.id}: expected "${c.expected.answer}", got "${actual.slice(0, 80)}"`;
        result.latencies.push(r.latencyMs);
      } catch (e) {
        result.errors++;
        if (!firstErr) firstErr = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
      }
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, () => worker()));
  if (firstErr) console.log(`  ${adapter.id} ${reasoning} firstErr: ${firstErr}`);
  if (firstMiss && result.errors === 0) console.log(`  ${adapter.id} ${reasoning} firstMiss: ${firstMiss}`);
  return result;
}

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function colorLatency(ms: number, thresholdMs: number): string {
  const s = `${ms}ms`.padStart(7);
  if (ms <= thresholdMs * 0.6) return GREEN + s + RESET;
  if (ms <= thresholdMs) return YELLOW + s + RESET;
  return RED + s + RESET;
}

function colorAcc(pct: number): string {
  const s = `${pct.toFixed(0)}%`.padStart(5);
  if (pct >= 95) return GREEN + s + RESET;
  if (pct >= 80) return YELLOW + s + RESET;
  return RED + s + RESET;
}

async function main(): Promise<void> {
  const adapters = pickAdapters();
  const levels = pickLevels();
  if (adapters.length === 0) {
    console.error('No providers selected (set GROQ_API_KEY / CEREBRAS_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY).');
    process.exit(1);
  }

  console.log(`\n${BOLD}Thinking-budget bench${RESET}`);
  console.log(`Cases: ${CASES.length} (subset of fluid-blank suite)`);
  console.log(`Providers: ${adapters.map(a => a.modelLabel).join(', ')}`);
  console.log(`Levels: ${levels.join(', ')}`);
  console.log(`Parallel: ${PARALLEL}`);
  console.log(`\nUse-case latency thresholds (p50 target):`);
  console.log(`  word-cue     ≤ 500ms`);
  console.log(`  fluid-blank  ≤ 1500ms`);
  console.log(`  transform    ≤ 3000ms\n`);

  // Run all cells concurrently across providers (different rate-limit
  // domains) but serially within each provider (avoid burning a
  // provider's quota with parallel cells).
  const wallStart = Date.now();
  const cellsByProvider = new Map<ProviderId, Promise<CellResult[]>>();
  for (const a of adapters) {
    cellsByProvider.set(a.id, (async () => {
      const out: CellResult[] = [];
      for (const r of levels) out.push(await runCell(a, r));
      return out;
    })());
  }
  const allResults: CellResult[] = (await Promise.all(cellsByProvider.values())).flat();
  const wallMs = Date.now() - wallStart;

  // ── Table ─────────────────────────────────────────────────────────
  console.log(`${BOLD}Per-cell results${RESET}\n`);
  console.log(`provider   reasoning    acc       median    mean      p95      err`);
  console.log(`─────────────────────────────────────────────────────────────────────`);
  for (const a of adapters) {
    for (const r of levels) {
      const cell = allResults.find(c => c.provider === a.id && c.reasoning === r);
      if (!cell) continue;
      const accPct = (cell.pass / cell.total) * 100;
      const med = pctile(cell.latencies, 0.5);
      const mn = mean(cell.latencies);
      const p95 = pctile(cell.latencies, 0.95);
      console.log(
        `${a.id.padEnd(10)} ${r.padEnd(12)} ${colorAcc(accPct)}  ` +
        `${colorLatency(med, 1500)}  ${colorLatency(mn, 1500)}  ${colorLatency(p95, 3000)}  ${cell.errors.toString().padStart(3)}`,
      );
    }
    console.log();
  }

  // ── Knee-point per pipeline ───────────────────────────────────────
  // Requires BOTH latency ≤ threshold AND accuracy ≥ MIN_ACC. Without
  // the accuracy floor, "high reasoning fits 3s for transform" hides
  // the fact that gpt-oss-120b @ high collapses to 20-25% acc because
  // max_tokens=512 fills with reasoning before any output emits.
  const MIN_ACC_PCT = parseInt(process.env.MIN_ACC ?? '90', 10);
  console.log(`${BOLD}Knee point — max reasoning where p50 ≤ threshold AND acc ≥ ${MIN_ACC_PCT}%${RESET}\n`);
  const thresholds = [
    { name: 'word-cue', ms: 500 },
    { name: 'fluid-blank', ms: 1500 },
    { name: 'transform', ms: 3000 },
  ];
  console.log(`provider     ${thresholds.map(t => t.name.padEnd(15)).join('')}`);
  console.log(`─────────────────────────────────────────────────────────`);
  for (const a of adapters) {
    const row: string[] = [];
    for (const t of thresholds) {
      let knee = '—';
      for (const r of levels) {
        const cell = allResults.find(c => c.provider === a.id && c.reasoning === r);
        if (!cell || cell.errors > cell.total / 2) continue;
        const med = pctile(cell.latencies, 0.5);
        const accPct = (cell.pass / cell.total) * 100;
        if (med <= t.ms && accPct >= MIN_ACC_PCT) knee = r;
      }
      row.push(knee.padEnd(15));
    }
    console.log(`${a.id.padEnd(12)} ${row.join('')}`);
  }

  console.log(`\nWall clock: ${(wallMs / 1000).toFixed(1)}s\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
