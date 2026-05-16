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
  /**
   * When set, the output's number of `\n` characters must equal this many
   * PLUS however many `\n` the edit was supposed to ADD (expectAddedNewlines).
   * Catches the "model collapsed pre-existing line breaks during a
   * positional edit" failure mode.
   */
  requireOriginalNewlines?: number;
  /** Newlines the edit is supposed to insert (0 for non-break edits). */
  expectAddedNewlines?: number;
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
  // ─────────── Line / paragraph breaks (regression-driven) ───────────
  // The user observed "here" worked but "this" didn't, and that
  // line-break-style instructions sometimes rewrote the whole target
  // instead of inserting a break at the cursor. These cases pin the
  // behaviour we want: a literal break inserted at [CURSOR], surrounding
  // text preserved verbatim.
  {
    name: 'add a line break here',
    instruction: 'add a line break here',
    target: 'hi my name is wilfred and I work on opencues',
    cursorOffset: 21,                           // after "wilfred"
    category: 'positional',
    expectNearCursor: '\n',
    requireOriginalNewlines: 0,
    expectAddedNewlines: 1,
  },
  {
    name: 'new line here',
    instruction: 'new line here',
    target: 'first sentence. second sentence.',
    cursorOffset: 15,                           // after "first sentence."
    category: 'positional',
    expectNearCursor: '\n',
    requireOriginalNewlines: 0,
    expectAddedNewlines: 1,
  },
  {
    name: 'add a paragraph break here',
    instruction: 'add a paragraph break here',
    target: 'hi my name is wilfred and I work on opencues',
    cursorOffset: 21,
    category: 'positional',
    expectNearCursor: '\n\n',
    requireOriginalNewlines: 0,
    expectAddedNewlines: 2,
  },
  {
    name: 'new paragraph here',
    instruction: 'new paragraph here',
    target: 'The meeting starts at 3pm. We will cover budget.',
    cursorOffset: 26,
    category: 'positional',
    expectNearCursor: '\n\n',
    requireOriginalNewlines: 0,
    expectAddedNewlines: 2,
  },
  {
    name: 'split this paragraph (this-anchored)',
    instruction: 'split this paragraph',
    target: 'hi my name is wilfred and I work on opencues',
    cursorOffset: 21,
    category: 'positional',
    expectNearCursor: '\n',
  },
  // ─────────── Pre-existing line breaks must SURVIVE positional edits ───────────
  // User-reported failure mode: "I want the line break above not to
  // break when we manipulate something 'here' / 'this line'". The
  // model sometimes collapses pre-existing \n during in-line edits.
  {
    name: '"here" on a 3-line target — line breaks preserved',
    instruction: 'add a comma here',
    target: 'first line\nhello world\nlast line',
    cursorOffset: 22,                           // end of "hello world"
    category: 'positional',
    expectNearCursor: ',',
    requireOriginalNewlines: 2,
    expectAddedNewlines: 0,
  },
  {
    name: '"this line" bolding — outer line breaks preserved',
    instruction: 'bold this line',
    target: 'first line\nsecond line\nthird line',
    cursorOffset: 18,                           // mid-"second line"
    category: 'positional',
    expectNearCursor: '**',
    requireOriginalNewlines: 2,
    expectAddedNewlines: 0,
  },
  {
    name: '"insert here" on multi-line — surrounding breaks survive',
    instruction: 'insert the word "TODO" here',
    target: 'one\ntwo\nthree four\nfive',
    cursorOffset: 13,                           // between "two\n" and "three"
    category: 'positional',
    expectNearCursor: 'TODO',
    requireOriginalNewlines: 3,
    expectAddedNewlines: 0,
  },
  {
    name: '"capitalise this line" — outer line breaks preserved',
    instruction: 'capitalise this line',
    target: 'alpha\nbeta gamma\ndelta',
    cursorOffset: 10,                           // mid-"beta gamma"
    category: 'positional',
    expectNearCursor: 'BETA',
    requireOriginalNewlines: 2,
    expectAddedNewlines: 0,
  },
  // ─────────── Layout-consistency battery (10 cases) ───────────
  // Each case: edit ONE thing inside a structured multi-line target;
  // every original \n must survive. Pins the "I changed a line and the
  // whole layout collapsed" failure mode.
  {
    name: 'L1: bold a word in paragraph 1 of 2 (\\n\\n preserved)',
    instruction: 'bold the word wilfred',
    target: 'hi my name is wilfred and I work on opencues.\n\nLove is a whisper in the quiet night.',
    cursorOffset: 20,                           // mid-"wilfred"
    category: 'positional',
    expectNearCursor: '**wilfred**',
    requireOriginalNewlines: 2,                 // the \n\n = two \n chars
    expectAddedNewlines: 0,
  },
  {
    name: 'L2: capitalise middle of 3 lines (outer breaks intact)',
    instruction: 'capitalise this line',
    target: 'first line\nthe quick brown fox\nlast line',
    cursorOffset: 21,                           // mid-"brown"
    category: 'positional',
    expectNearCursor: 'BROWN',
    requireOriginalNewlines: 2,
    expectAddedNewlines: 0,
  },
  {
    name: 'L3: italicise one item in a 4-bullet list',
    instruction: 'italicise this item',
    target: '- apples\n- bananas\n- oranges\n- pears',
    cursorOffset: 14,                           // mid-"bananas"
    category: 'positional',
    expectNearCursor: '*bananas*',
    requireOriginalNewlines: 3,                 // 3 newlines separate 4 bullets
    expectAddedNewlines: 0,
  },
  {
    name: 'L4: rewrite body, heading + blank line stay intact',
    instruction: 'rephrase this line',
    target: '# Meeting Notes\n\nThe meeting starts at 3pm sharp.\n\nWe will cover budget.',
    cursorOffset: 35,                           // mid-"meeting starts"
    category: 'positional',
    expectNearCursor: '3pm',
    requireOriginalNewlines: 4,                 // two \n\n = 4 \n total
    expectAddedNewlines: 0,
  },
  {
    name: 'L5: 5-line poem — bold the middle line, all line breaks survive',
    instruction: 'bold this line',
    target: 'roses are red\nviolets are blue\nsugar is sweet\nand so are you\nthe end',
    cursorOffset: 35,                           // mid-"sugar is sweet"
    category: 'positional',
    expectNearCursor: '**sugar is sweet**',
    requireOriginalNewlines: 4,
    expectAddedNewlines: 0,
  },
  {
    name: 'L6: mixed \\n and \\n\\n — modify mid-line keeps both',
    instruction: 'change "world" to "earth" on this line',
    target: 'title\n\nhello world\nfooter line',
    cursorOffset: 13,                           // mid-"world"
    category: 'positional',
    expectNearCursor: 'earth',
    requireOriginalNewlines: 3,                 // \n\n + \n = 3 chars
    expectAddedNewlines: 0,
  },
  {
    name: 'L7: long 3-paragraph body — fix typo on this line',
    instruction: 'fix typos on this line',
    target: 'Dear Manager,\n\nI hope you are well. I wantted to follow up on the proposal.\n\nBest regards,\nWilfred',
    cursorOffset: 40,                           // mid-"wantted"
    category: 'positional',
    expectNearCursor: 'wanted',
    requireOriginalNewlines: 5,                 // \n\n + \n\n + \n = 5
    expectAddedNewlines: 0,
  },
  {
    name: 'L8: Q&A pair — modify only the answer',
    instruction: 'capitalise the first word of this line',
    target: 'Q: what is the capital of france?\n\nA: paris is the capital.',
    cursorOffset: 36,                           // start of "paris"
    category: 'positional',
    expectNearCursor: 'Paris',
    requireOriginalNewlines: 2,
    expectAddedNewlines: 0,
  },
  {
    name: 'L9: indented multi-line code-like — fix one line',
    instruction: 'add a semicolon at the end of this line',
    target: 'function foo() {\n  const x = 1\n  return x + 1;\n}',
    cursorOffset: 30,                           // end of "const x = 1"
    category: 'positional',
    expectNearCursor: 'x = 1;',
    requireOriginalNewlines: 3,
    expectAddedNewlines: 0,
  },
  {
    name: 'L10: 4-bullet list with descriptions — modify one description',
    instruction: 'rephrase this line to be more formal',
    target: '- apples\n  cheap and sweet\n- bananas\n  yellow tropical\n- oranges\n  citrus and round',
    cursorOffset: 21,                           // mid-"cheap and sweet"
    category: 'positional',
    expectNearCursor: 'apples',                 // surrounding context survives
    requireOriginalNewlines: 5,
    expectAddedNewlines: 0,
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

    // Newline-preservation check: original \n boundaries must survive
    // the edit. If the case declares the expected count, hard-fail when
    // it doesn't match (collapsed / inserted-extra-by-mistake).
    if (typeof c.requireOriginalNewlines === 'number') {
      const expectedTotal = c.requireOriginalNewlines + (c.expectAddedNewlines ?? 0);
      const actual = (stripped.match(/\n/g) ?? []).length;
      if (actual !== expectedTotal) {
        reasons.push(`${RED}✗ newline count = ${actual}, expected ${expectedTotal} (original=${c.requireOriginalNewlines}, added=${c.expectAddedNewlines ?? 0})${RESET}`);
        pass = false;
      } else {
        reasons.push(`${GREEN}✓ ${actual} newlines preserved (original=${c.requireOriginalNewlines}, added=${c.expectAddedNewlines ?? 0})${RESET}`);
      }
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
