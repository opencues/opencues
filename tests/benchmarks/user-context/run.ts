/**
 * User-context sentinel-mode benchmark.
 *
 * Measures: when the LLM is offered a 16-entry catalog of user-data
 * tokens, can it reliably:
 *   (a) emit the correct sentinel when asked about a known field?
 *   (b) emit them VERBATIM (case + spacing)?
 *   (c) avoid inventing new sentinels for unlisted fields?
 *   (d) avoid leaking raw values when the catalog only contains tokens?
 *
 * Multi-provider: same OPENCUES_BENCH_PROVIDER switch as the rest of
 * the bench suite. Run across the matrix to see if hardness clusters
 * by provider/model family.
 *
 * Usage:
 *   OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss \
 *     npx tsx tests/benchmarks/user-context/run.ts [--parallel N]
 */

import { CASES, type UserContextCase } from './cases';
import { MULTI_CASES } from './cases-multi';
import { TOKEN_SET, ALL_VALUES, SENTINELS } from './sentinels';
import { buildSystemPrompt } from './prompt';
import { postProcess } from './post-process';
import { chat, sysUser, MODEL } from '../fluid-blank/groq';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

const PARALLEL = parseInt(process.argv.find(a => a.startsWith('--parallel='))?.split('=')[1] ?? '6', 10);
const MULTI = process.argv.includes('--multi');
const ACTIVE_CASES = MULTI ? MULTI_CASES : CASES;
const CATALOG = new Map(SENTINELS.map(s => [s.token, s.value]));

interface Grade {
  pass: boolean;
  reasons: string[];
  emittedSentinels: string[];   // listed catalog tokens found
  hallucinated: string[];       // [SOMETHING] in output but NOT in catalog
  rawLeaks: string[];           // catalog VALUES that appeared verbatim
  caseMangled: string[];        // expected-token shape with case/spacing drift
}

function findAllBracketTokens(s: string): string[] {
  // Match `[ANYTHING-UPPERCASE-WITH-SPACES]` shape. Conservative — must
  // be all-caps + spaces + hyphens, to avoid catching prose like
  // `[note]` or `[1]`. Catalog tokens like `[FIRST NAME]` match.
  const out: string[] = [];
  const re = /\[[A-Z][A-Z0-9 _-]*\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[0]);
  return out;
}

function findCaseMangledFor(token: string, s: string): string[] {
  // Look for case-insensitive matches of the token that DIDN'T match
  // verbatim. Anything matching the token shape but with different
  // case / spacing is a "soft pass" but still surfaces as a regression.
  const out: string[] = [];
  const re = new RegExp(token.replace(/[[\]]/g, '\\$&').replace(/\s+/g, '\\s+'), 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[0] !== token) out.push(m[0]);
  }
  return out;
}

function grade(c: UserContextCase, answer: string): Grade {
  const reasons: string[] = [];

  // 1. Collect bracket-shaped tokens in the output. Classify by listed.
  const allBrackets = findAllBracketTokens(answer);
  const emittedSentinels = allBrackets.filter(t => TOKEN_SET.has(t));
  const hallucinated = allBrackets.filter(t => !TOKEN_SET.has(t));

  // 2. Case-mangling check for each EXPECTED token. Mangled vs missing
  // are different failure modes — mangled means "the model knew the
  // shape but flubbed the case", which is recoverable with a tolerant
  // post-processor; missing means it didn't think to use the sentinel.
  const caseMangled: string[] = [];
  for (const tok of c.expectedTokens ?? []) {
    if (!answer.includes(tok)) {
      const drifts = findCaseMangledFor(tok, answer);
      for (const d of drifts) if (!caseMangled.includes(d)) caseMangled.push(d);
    }
  }

  // 3. Raw-value leak check. If forbidRawValues is on, scan the answer
  // for any catalog value. This catches "LLM saw the catalog and
  // resolved the sentinel itself instead of emitting it verbatim".
  const rawLeaks: string[] = [];
  if (c.forbidRawValues) {
    for (const v of ALL_VALUES) {
      // Skip empty/very short values that would false-positive (e.g.
      // a name component appearing in unrelated prose). All bench
      // values are ≥3 chars by construction; this is belt-and-braces.
      if (v.length < 3) continue;
      if (answer.includes(v)) rawLeaks.push(v);
    }
  }

  // 4. Per-case assertions.
  for (const tok of c.expectedTokens ?? []) {
    if (!answer.includes(tok)) {
      reasons.push(`missing ${tok}`);
    }
  }
  for (const slot of c.expectedTokenSets ?? []) {
    if (!slot.some(t => answer.includes(t))) {
      reasons.push(`missing any of {${slot.join(' | ')}}`);
    }
  }
  for (const tok of c.forbiddenTokens ?? []) {
    if (answer.includes(tok)) reasons.push(`forbidden ${tok} appeared`);
  }
  if (c.forbidAnySentinel) {
    if (allBrackets.length > 0) {
      reasons.push(`unexpected bracket-tokens emitted: ${allBrackets.join(', ')}`);
    }
  }
  if (hallucinated.length > 0) {
    // Hallucination = an unlisted [TOKEN] in the output. ALWAYS a
    // hard fail regardless of which pipeline: the post-processor
    // would substitute the literal string into the user's buffer
    // (since it has no value to resolve to), leaking [DATE OF BIRTH]
    // or similar as visible text the user didn't intend to type.
    reasons.push(`hallucinated unlisted: ${hallucinated.join(', ')}`);
  }
  for (const v of rawLeaks) reasons.push(`raw value leaked: ${JSON.stringify(v)}`);

  return {
    pass: reasons.length === 0,
    reasons,
    emittedSentinels,
    hallucinated,
    rawLeaks,
    caseMangled,
  };
}

function parseAnswer(raw: string): string {
  // ANSWER is the last field per the system prompt — capture everything
  // after `ANSWER:` to the end of the response (no `m` flag, so `$`
  // is true end-of-string). Multi-line answers (signatures, bios)
  // would be truncated to their first line under a per-line regex.
  const m = raw.match(/ANSWER:\s*([\s\S]*?)\s*$/i);
  return m ? m[1].trim() : raw.trim();
}

interface Outcome {
  id: string;
  pipeline: string;
  pass: boolean;
  reasons: string[];
  caseMangled: string[];
  hallucinated: string[];
  latencyMs: number;
  raw: string;
  answer: string;
  /** For multi-sentinel cases: how many of the expected slots got at
   *  least one listed token. Surfaces the "model emits the first N
   *  then stops" failure mode without binary pass/fail collapsing it. */
  slotsFilled?: number;
  slotsRequired?: number;
  /** Output AFTER post-processing — what the user would actually see
   *  in their buffer. */
  finalOutput: string;
  /** Number of unlisted bracket-tokens the post-processor stripped. */
  ppStripped: number;
  /** Number of tolerant-match recoveries (e.g. [WORK_CITY] → London). */
  ppTolerant: number;
  /** True iff the final output contains NO bracket-tokens — i.e. the
   *  post-processor produced a clean, ready-to-paste string. */
  cleanAfterPP: boolean;
}

async function runOne(c: UserContextCase, system: string): Promise<Outcome> {
  const t0 = Date.now();
  // Multi-sentinel cases need larger output; standard cases keep the
  // tight 300-token budget since lookups are short.
  const maxTokens = MULTI ? 1200 : 300;
  const r = await chat(sysUser(system, `INPUT: ${c.input}`), { maxTokens, temperature: 0, seed: 42 });
  const latencyMs = Date.now() - t0;
  const answer = parseAnswer(r.text);
  const g = grade(c, answer);
  // Slot-fill scoring for multi cases — counts how many of the
  // expectedTokenSets got at least one match, even when the case
  // overall failed (binary pass/fail loses signal at 8+ sentinels).
  let slotsFilled: number | undefined;
  let slotsRequired: number | undefined;
  if (c.expectedTokenSets) {
    slotsRequired = c.expectedTokenSets.length;
    slotsFilled = c.expectedTokenSets.filter(slot => slot.some(t => answer.includes(t))).length;
  }
  // Run the post-processor on the LLM's answer with the catalog. This
  // simulates what would actually land in the user's buffer in prod.
  // No originalBody here — fluid-blank-style cases replace `_` with
  // the LLM output verbatim; there's no pre-existing text to preserve.
  const pp = postProcess(answer, { catalog: CATALOG });
  const cleanAfterPP = !/\[[A-Z][A-Z0-9 _-]*\]/.test(pp.output);
  return {
    id: c.id,
    pipeline: c.pipeline,
    pass: g.pass,
    reasons: g.reasons,
    caseMangled: g.caseMangled,
    hallucinated: g.hallucinated,
    latencyMs,
    raw: r.text,
    answer,
    slotsFilled,
    slotsRequired,
    finalOutput: pp.output,
    ppStripped: pp.report.stripped.length,
    ppTolerant: pp.report.tolerantMatches.length,
    cleanAfterPP,
  };
}

async function runConc<T, R>(items: T[], fn: (x: T) => Promise<R>, conc: number): Promise<R[]> {
  const res: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (true) { const idx = i++; if (idx >= items.length) return; res[idx] = await fn(items[idx]); }
  }));
  return res;
}

async function main(): Promise<void> {
  const system = buildSystemPrompt();
  console.log(`${BOLD}user-context sentinel-mode bench${RESET}${MULTI ? ' — MULTI-SENTINEL mode' : ''}`);
  console.log(`Model: ${MODEL}   Cases: ${ACTIVE_CASES.length}   parallel: ${PARALLEL}\n`);

  const t0 = Date.now();
  const outcomes = await runConc(ACTIVE_CASES, c => runOne(c, system), PARALLEL);
  const wallMs = Date.now() - t0;

  for (const o of outcomes) {
    const tag = o.pass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    const pipe = `${DIM}[${o.pipeline}]${RESET}`;
    const slotInfo = o.slotsRequired ? ` ${DIM}slots ${o.slotsFilled}/${o.slotsRequired}${RESET}` : '';
    console.log(`  ${tag}  ${BOLD}${o.id.padEnd(32)}${RESET}  ${pipe}  ${DIM}${o.latencyMs}ms${RESET}${slotInfo}`);
    const showLen = MULTI ? 240 : 120;
    console.log(`    ${DIM}answer:${RESET} ${o.answer.length > showLen ? o.answer.slice(0, showLen) + '…' : o.answer}`);
    if (!o.pass) {
      for (const r of o.reasons) console.log(`    ${YELLOW}↳${RESET} ${r}`);
    }
    if (o.caseMangled.length > 0 && o.pass) {
      console.log(`    ${YELLOW}~ case-mangled (verbatim still ok):${RESET} ${o.caseMangled.join(', ')}`);
    }
  }

  // ── Aggregate ─────────────────────────────────────────────────────────
  const byPipeline = new Map<string, { pass: number; total: number; mangled: number; halluc: number }>();
  for (const o of outcomes) {
    const cur = byPipeline.get(o.pipeline) ?? { pass: 0, total: 0, mangled: 0, halluc: 0 };
    cur.total++;
    if (o.pass) cur.pass++;
    if (o.caseMangled.length > 0) cur.mangled++;
    if (o.hallucinated.length > 0) cur.halluc++;
    byPipeline.set(o.pipeline, cur);
  }

  const passed = outcomes.filter(o => o.pass).length;
  const totalMangled = outcomes.filter(o => o.caseMangled.length > 0).length;
  const totalHalluc = outcomes.filter(o => o.hallucinated.length > 0).length;
  const avgMs = Math.round(outcomes.reduce((a, o) => a + o.latencyMs, 0) / outcomes.length);

  console.log(`\n${BOLD}═══ SUMMARY ═══${RESET}`);
  console.log(`Provider: ${MODEL}`);
  console.log(`Cases: ${ACTIVE_CASES.length}  parallel: ${PARALLEL}  wall: ${(wallMs / 1000).toFixed(1)}s  avg/case: ${avgMs}ms\n`);
  const header = ['pipeline', 'pass', 'pass%', 'mangled', 'hallucinated'].map((s, i) => i === 0 ? s.padEnd(12) : s.padEnd(14)).join('');
  console.log(header);
  console.log('─'.repeat(header.length));
  for (const [p, s] of byPipeline) {
    const pct = (s.pass / s.total * 100).toFixed(0);
    console.log(`${p.padEnd(12)}${`${s.pass}/${s.total}`.padEnd(14)}${`${pct}%`.padEnd(14)}${String(s.mangled).padEnd(14)}${String(s.halluc).padEnd(14)}`);
  }
  console.log('─'.repeat(header.length));
  console.log(`${BOLD}TOTAL${RESET}       ${`${passed}/${ACTIVE_CASES.length}`.padEnd(14)}${`${(passed / ACTIVE_CASES.length * 100).toFixed(1)}%`.padEnd(14)}${String(totalMangled).padEnd(14)}${String(totalHalluc).padEnd(14)}`);

  // Slot-fill aggregate (only meaningful in --multi mode): how many of
  // the per-case expected slots actually got filled, summed across all
  // cases. Better signal than binary pass/fail at the upper end —
  // "31/45 slots filled" is more useful than "0/3 pass" when each
  // case demands 8+ sentinels.
  if (MULTI) {
    let filled = 0, required = 0;
    for (const o of outcomes) {
      if (o.slotsRequired && o.slotsFilled !== undefined) {
        filled += o.slotsFilled;
        required += o.slotsRequired;
      }
    }
    const pct = required ? (filled / required * 100).toFixed(1) : '0';
    console.log(`\n${BOLD}Slot fidelity${RESET}: ${filled}/${required} slots filled (${pct}%) — model's ability to enumerate as more sentinels are required`);
  }

  // Post-processor effect — how many cases the PP turned into
  // buffer-safe output vs how many still have bracket-noise after PP.
  const cleanCount = outcomes.filter(o => o.cleanAfterPP).length;
  const ppStripCount = outcomes.reduce((a, o) => a + o.ppStripped, 0);
  const ppTolerantCount = outcomes.reduce((a, o) => a + o.ppTolerant, 0);
  console.log(`\n${BOLD}Post-processor effect${RESET}:`);
  console.log(`  ${cleanCount}/${outcomes.length} cases produce buffer-safe output (no [TOKEN] remaining after PP)`);
  console.log(`  ${ppStripCount} hallucinated tokens stripped across all cases`);
  console.log(`  ${ppTolerantCount} tolerant matches recovered (e.g. [WORK_CITY] → [WORK CITY])`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
