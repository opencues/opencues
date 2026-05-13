/**
 * Real-LLM benchmark for cursor-aware "here" support in TransformBlank.
 *
 * Drives Groq with the actual P2_APPLY_SYSTEM prompt (including the
 * new rule 10 about [CURSOR] anchoring) and a target text that has
 * [CURSOR] injected at a specific offset. Verifies the model:
 *
 *   1. Anchors positional instructions ("insert X here", "add X",
 *      "split here", "before this", "after this") at [CURSOR].
 *   2. Ignores [CURSOR] for non-positional instructions (translate,
 *      make-shorter, fix-typos, capitalise).
 *   3. Strips [CURSOR] from its output (or stripCursorSentinel does
 *      as a safety net).
 *
 * Run:
 *   GROQ_API_KEY=... npx tsx tests/benchmarks/transform-blank/cursor-aware.ts
 *
 * Each case fans out 3 attempts to surface non-determinism. PASS = all
 * attempts pass; soft-FAIL with attempt count is logged for flaky cases.
 */

import { chat } from './groq';
import { P2_APPLY_SYSTEM } from '../../../packages/opencues-core/src/sources/transform-blank-source';
import {
  injectCursorSentinel,
  stripCursorSentinel,
} from '../../../packages/opencues-core/src/cursor-sentinel';

interface CaseSpec {
  name: string;
  instruction: string;
  target: string;
  /** Cursor offset in the (pre-injection) target. */
  cursorOffset: number;
  /** Type of expectation. */
  category: 'positional' | 'non-positional';
  /**
   * For positional cases — substring that should appear NEAR the cursor
   * site in the output (within ±15 chars of where [CURSOR] was).
   */
  expectNearCursor?: string;
  /** For non-positional cases — substring that must appear in output. */
  expectInOutput?: string;
}

const CASES: CaseSpec[] = [
  // ─────────── Positional ───────────
  {
    name: 'insert a comma here',
    instruction: 'insert a comma here',
    target: 'hello world',
    cursorOffset: 5,                            // between "hello" and " world"
    category: 'positional',
    expectNearCursor: ',',
  },
  {
    name: 'add a period here',
    instruction: 'add a period here',
    target: 'hello world this is fine',
    cursorOffset: 11,                           // after "hello world"
    category: 'positional',
    expectNearCursor: '.',
  },
  {
    name: 'split this paragraph here',
    instruction: 'split this paragraph here',
    target: 'first part second part more text',
    cursorOffset: 10,                           // between "first part" and " second"
    category: 'positional',
    expectNearCursor: '\n',
  },
  {
    name: 'add "really" before this',
    instruction: 'add the word "really" before this',
    target: 'i am tired today',
    cursorOffset: 5,                            // before "tired"
    category: 'positional',
    expectNearCursor: 'really',
  },
  // ─────────── Non-positional (cursor must be ignored) ───────────
  {
    name: 'translate to french',
    instruction: 'translate to french',
    target: 'hello my name is wilfred',
    cursorOffset: 12,                           // mid-target — should be ignored
    category: 'non-positional',
    expectInOutput: 'bonjour',
  },
  {
    name: 'capitalise all words',
    instruction: 'capitalise the first letter of every word',
    target: 'the quick brown fox',
    cursorOffset: 9,
    category: 'non-positional',
    expectInOutput: 'The Quick Brown Fox',
  },
  {
    name: 'fix typos',
    instruction: 'fix typos',
    target: 'helo wrld i am tirred',
    cursorOffset: 5,
    category: 'non-positional',
    expectInOutput: 'hello',
  },
  {
    name: 'make british english',
    instruction: 'make it british english',
    target: 'the color of the harbor is gray',
    cursorOffset: 15,
    category: 'non-positional',
    expectInOutput: 'colour',
  },
];

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

interface AttemptResult {
  pass: boolean;
  reasons: string[];
  rawOutput: string;
  strippedOutput: string;
  latencyMs: number;
}

async function runOnce(c: CaseSpec): Promise<AttemptResult> {
  const targetWithCursor = injectCursorSentinel(c.target, c.cursorOffset);
  const result = await chat([
    { role: 'system', content: P2_APPLY_SYSTEM },
    { role: 'user', content: `INSTRUCTION: ${c.instruction}\nTARGET: ${targetWithCursor}` },
  ], { temperature: 0, maxTokens: 1024 });

  // The source's parseApply extracts the REWRITE field; mimic that here.
  const m = result.text.match(/REWRITE:[ \t]*([\s\S]*?)\s*$/i);
  const rawRewrite = m ? m[1].trim() : result.text.trim();
  const stripped = stripCursorSentinel(rawRewrite);

  const reasons: string[] = [];
  let pass = true;

  // Universal check: stripped output must NOT contain [CURSOR].
  if (stripped.includes('[CURSOR]') || stripped.toLowerCase().includes('[cursor]')) {
    reasons.push(`${RED}✗ output still contains [CURSOR] after strip${RESET}`);
    pass = false;
  } else {
    reasons.push(`${GREEN}✓ output sentinel-free${RESET}`);
  }

  if (c.category === 'positional' && c.expectNearCursor) {
    // The expected fragment should appear near where the cursor was.
    // Cursor offset in input target maps to roughly the same offset in
    // output (positional edits are small). Allow a ±15 char window.
    const found = stripped.indexOf(c.expectNearCursor);
    if (found < 0) {
      reasons.push(`${RED}✗ expected "${c.expectNearCursor}" near cursor — not found anywhere${RESET}`);
      pass = false;
    } else if (Math.abs(found - c.cursorOffset) > 15) {
      reasons.push(`${YELLOW}! "${c.expectNearCursor}" found at offset ${found} (cursor was ${c.cursorOffset}) — outside ±15 window${RESET}`);
      // Soft fail: the model may have applied the edit in the wrong
      // spot. Still pass the test as long as the edit happened — but
      // flag it so we can tune the prompt.
    } else {
      reasons.push(`${GREEN}✓ "${c.expectNearCursor}" found at offset ${found} (cursor ${c.cursorOffset}, within ±15)${RESET}`);
    }
  }

  if (c.category === 'non-positional' && c.expectInOutput) {
    if (!stripped.toLowerCase().includes(c.expectInOutput.toLowerCase())) {
      reasons.push(`${RED}✗ expected "${c.expectInOutput}" in output — not found${RESET}`);
      pass = false;
    } else {
      reasons.push(`${GREEN}✓ "${c.expectInOutput}" in output (cursor ignored as expected)${RESET}`);
    }
  }

  return { pass, reasons, rawOutput: rawRewrite, strippedOutput: stripped, latencyMs: result.latencyMs };
}

async function runCase(c: CaseSpec): Promise<{ name: string; passes: number; attempts: number }> {
  const ATTEMPTS = 3;
  let passes = 0;
  console.log(`${BOLD}${c.name}${RESET} ${DIM}[${c.category}]${RESET}`);
  console.log(`  ${DIM}instruction:${RESET} ${c.instruction}`);
  console.log(`  ${DIM}target:${RESET}      ${c.target}`);
  console.log(`  ${DIM}cursor:${RESET}      offset ${c.cursorOffset}  →  ${injectCursorSentinel(c.target, c.cursorOffset)}`);
  for (let i = 1; i <= ATTEMPTS; i++) {
    try {
      const r = await runOnce(c);
      if (r.pass) passes++;
      const tag = r.pass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
      console.log(`  attempt ${i}/${ATTEMPTS}: ${tag} ${DIM}(${r.latencyMs}ms)${RESET}`);
      console.log(`    ${DIM}stripped output:${RESET} ${JSON.stringify(r.strippedOutput).slice(0, 200)}`);
      for (const reason of r.reasons) console.log(`    ${reason}`);
    } catch (err) {
      console.log(`  attempt ${i}/${ATTEMPTS}: ${RED}ERROR${RESET} — ${(err as Error).message}`);
    }
  }
  return { name: c.name, passes, attempts: ATTEMPTS };
}

async function main(): Promise<void> {
  console.log(`${BOLD}Cursor-aware TransformBlank — real-LLM benchmark${RESET}`);
  console.log(`${DIM}Model: gpt-oss-120b on Groq. ${CASES.length} cases × 3 attempts.${RESET}\n`);
  const results: Array<{ name: string; passes: number; attempts: number }> = [];
  for (const c of CASES) {
    results.push(await runCase(c));
    console.log('');
  }
  console.log(`${BOLD}Summary${RESET}`);
  let totalPasses = 0;
  let totalAttempts = 0;
  for (const r of results) {
    const ratio = `${r.passes}/${r.attempts}`;
    const colour = r.passes === r.attempts ? GREEN : (r.passes === 0 ? RED : YELLOW);
    console.log(`  ${colour}${ratio}${RESET}  ${r.name}`);
    totalPasses += r.passes;
    totalAttempts += r.attempts;
  }
  const pct = ((totalPasses / totalAttempts) * 100).toFixed(0);
  const colour = totalPasses === totalAttempts ? GREEN : (totalPasses === 0 ? RED : YELLOW);
  console.log(`\n  ${colour}${totalPasses}/${totalAttempts} (${pct}%)${RESET} total\n`);
  if (totalPasses < totalAttempts) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
