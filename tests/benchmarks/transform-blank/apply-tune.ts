/**
 * APPLY prompt tuning — A/B benchmark.
 *
 * Compares the CURRENT P2_APPLY_SYSTEM against trimmed/reorganised variants
 * to find a leaner prompt with equal-or-better pass rate.
 *
 * Like the EXTRACT trim experiment (Experiments.md #2) which gained +5-7pp
 * by stripping verbosity. Same hypothesis: APPLY's 45 examples + 11 rules
 * may be over-constraining the model.
 *
 * Run:
 *   GROQ_API_KEY=... npx tsx tests/benchmarks/transform-blank/apply-tune.ts
 */

import { chat } from './groq';
import { P2_APPLY_SYSTEM } from '../../../packages/opencues-core/src/sources/transform-blank-source';
import { injectCursorSentinel, stripCursorSentinel } from '../../../packages/opencues-core/src/cursor-sentinel';

type Category =
  | 'literal-swap' | 'concept-swap' | 'tense' | 'case' | 'pluralise'
  | 'composed' | 'conditional' | 'role-preserve' | 'markdown'
  | 'positional' | 'multiline-preserve'
  | 'add-fill' | 'add-anchored' | 'add-cursor' | 'add-auto-style';

interface CaseSpec {
  name: string;
  category: Category;
  instruction: string;
  target: string;
  cursorOffset?: number;
  expectInOutput: string;
  /** Optional: enforce exact newline count in output. */
  requireOriginalNewlines?: number;
}

const FANOUT = 3;

const CASES: CaseSpec[] = [
  // ─────────── literal swap ───────────
  { name: 'L1: change boy to girl', category: 'literal-swap',
    instruction: 'change boy to girl', target: 'the boy ran fast', expectInOutput: 'girl' },
  { name: 'L2: rename foo to bar', category: 'literal-swap',
    instruction: 'rename foo to bar', target: 'foo is the start, then foo again', expectInOutput: 'bar is the start, then bar' },
  { name: 'L3: he/she swap', category: 'literal-swap',
    instruction: 'he/she swap', target: 'he gave the book to John', expectInOutput: 'she' },

  // ─────────── concept swap ───────────
  { name: 'C1: change pet from dog to cat', category: 'concept-swap',
    instruction: 'change pet from dog to cat', target: 'the dog wagged its tail and barked at the postman', expectInOutput: 'meowed' },
  { name: 'C2: change vehicle bike→car', category: 'concept-swap',
    instruction: 'change vehicle from bike to car', target: 'I rode my bike to school and my helmet kept me safe', expectInOutput: 'seatbelt' },
  { name: 'C3: protagonist→wizard', category: 'concept-swap',
    instruction: 'change protagonist to wizard', target: 'the knight drew his sword and charged the dragon', expectInOutput: 'wand' },
  { name: 'C4: setting→ocean', category: 'concept-swap',
    instruction: 'change setting to ocean', target: 'the camel walked across the dunes carrying water in its hump', expectInOutput: 'gills' },

  // ─────────── tense ───────────
  { name: 'T1: past tense', category: 'tense',
    instruction: 'make past tense', target: 'I run to the store every day', expectInOutput: 'ran' },
  { name: 'T2: present tense', category: 'tense',
    instruction: 'make present tense', target: 'I ran to the store yesterday', expectInOutput: 'run' },

  // ─────────── case ───────────
  { name: 'CA1: capitalize proper nouns', category: 'case',
    instruction: 'capitalize proper nouns', target: 'i visited paris and london last june', expectInOutput: 'Paris' },
  { name: 'CA2: uppercase brands', category: 'case',
    instruction: 'uppercase brands', target: 'i bought apple, samsung, and sony products', expectInOutput: 'SAMSUNG' },
  { name: 'CA3: british english', category: 'case',
    instruction: 'make it british english', target: 'the color of the harbor is gray', expectInOutput: 'colour' },

  // ─────────── pluralise ───────────
  { name: 'P1: pluralize basic', category: 'pluralise',
    instruction: 'pluralize', target: 'the child found one mouse', expectInOutput: 'mice' },
  { name: 'P2: pluralize except mass', category: 'pluralise',
    instruction: 'pluralize except mass nouns', target: 'the child drank water and ate one cookie at the table', expectInOutput: 'cookies' },

  // ─────────── composed ───────────
  { name: 'CO1: past tense | remove pronouns', category: 'composed',
    instruction: 'make past tense | remove pronouns', target: 'I run to the store every day', expectInOutput: 'ran' },
  { name: 'CO2: pluralize | past tense', category: 'composed',
    instruction: 'pluralize | make past tense', target: 'the child runs to the park', expectInOutput: 'ran' },

  // ─────────── conditional ───────────
  { name: 'CN1: change boy→girl except sentence 2', category: 'conditional',
    instruction: 'change boy to girl but not in the second sentence', target: 'The boy ran to the park. The boy met another boy there. They played until the boy went home.', expectInOutput: 'The girl ran' },

  // ─────────── role preserve ───────────
  { name: 'R1: add 10% to final only', category: 'role-preserve',
    instruction: 'add 10%', target: 'original price 100, final price 100', expectInOutput: '110' },

  // ─────────── markdown ───────────
  { name: 'M1: bold a word', category: 'markdown',
    instruction: 'make wilfred bold', target: 'hii my name is wilfred.', expectInOutput: '**wilfred**' },
  { name: 'M2: italic a word', category: 'markdown',
    instruction: 'italicize wilfred', target: 'hii my name is wilfred.', expectInOutput: '*wilfred*' },
  { name: 'M3: strike a word', category: 'markdown',
    instruction: 'strike through the word wilfred', target: 'hii my name is wilfred.', expectInOutput: '~~wilfred~~' },
  { name: 'M4: heading the first line', category: 'markdown',
    instruction: 'make the first line a heading', target: 'My Notes\n\nToday I worked on the runtime.', expectInOutput: '# My Notes' },
  { name: 'M5: turn into list', category: 'markdown',
    instruction: 'turn the items into a list', target: 'I bought apples bananas and oranges.', expectInOutput: '- apples' },

  // ─────────── positional (cursor) ───────────
  { name: 'POS1: insert comma here', category: 'positional',
    instruction: 'insert a comma here', target: 'hello world', cursorOffset: 5, expectInOutput: ',' },
  { name: 'POS2: split paragraph here', category: 'positional',
    instruction: 'split this paragraph here', target: 'first part second part more text', cursorOffset: 10, expectInOutput: '\n' },
  { name: 'POS3: add line break here', category: 'positional',
    instruction: 'add a line break here', target: 'hi my name is wilfred and I work on opencues', cursorOffset: 21, expectInOutput: '\n' },

  // ─────────── multiline-preserve ───────────
  { name: 'ML1: rephrase mid-line, breaks preserve', category: 'multiline-preserve',
    instruction: 'rephrase this line', target: '# Meeting Notes\n\nThe meeting starts at 3pm sharp.\n\nWe will cover budget.', cursorOffset: 35, expectInOutput: '3pm', requireOriginalNewlines: 4 },
  { name: 'ML2: bold middle of 3 lines', category: 'multiline-preserve',
    instruction: 'bold this line', target: 'first line\nsecond line\nthird line', cursorOffset: 18, expectInOutput: '**', requireOriginalNewlines: 2 },
  { name: 'ML3: italicise bullet item', category: 'multiline-preserve',
    instruction: 'italicise this item', target: '- apples\n- bananas\n- oranges\n- pears', cursorOffset: 14, expectInOutput: '*bananas*', requireOriginalNewlines: 3 },
  { name: 'ML4: heading + body intact', category: 'multiline-preserve',
    instruction: 'shorten this line', target: 'short header\n\nThis is a very long sentence that goes on.\n\nbye', cursorOffset: 30, expectInOutput: 'short header', requireOriginalNewlines: 4 },

  // ─────────── ADD/INSERT (real failure cases from logs) ───────────
  // FILL PLACEHOLDER pattern.
  { name: 'A1 [log]: add my name Wilfred → [Your Name]', category: 'add-fill',
    instruction: 'add my name Wilfred',
    target: "Dear [Manager's Name],\n\nI hope you are well.\n\nBest regards,\n[Your Name]",
    expectInOutput: 'Wilfred' },
  { name: 'A2 [log]: add company CS Limited → [Company]', category: 'add-fill',
    instruction: 'add company CS Limited',
    target: 'Dear Karen,\n\nI am writing on behalf of [Company]. Regards.',
    expectInOutput: 'CS Limited' },
  { name: 'A3 [log]: add position Boss → [Your Position]', category: 'add-fill',
    instruction: 'add my position Boss',
    target: 'I am writing to resign from my role as [Your Position] at the company.',
    expectInOutput: 'Boss' },
  { name: 'A4 [log]: add last working day 31st June 2026', category: 'add-fill',
    instruction: 'add last working day 31st June 2026',
    target: 'My last working day will be [Last Working Day]. Thank you.',
    expectInOutput: '31st June 2026' },
  { name: 'A5 [log]: add manager Karen', category: 'add-fill',
    instruction: "add manager's name Karen",
    target: "Dear [Manager's Name],\n\nbody text.",
    expectInOutput: 'Karen' },

  // ANCHORED INSERT pattern.
  { name: 'A6 [log]: add joke after dear line', category: 'add-anchored',
    instruction: 'add a joke after the dear line',
    target: 'Dear Karen,\n\nI hope you are well.',
    expectInOutput: 'Dear Karen,' },                // surrounding text preserved
  { name: 'A7: add greeting before signature', category: 'add-anchored',
    instruction: 'add "Cheers" before the signature',
    target: 'Body text.\n\nBest,\nWilfred',
    expectInOutput: 'Cheers' },

  // AUTO STYLING pattern.
  { name: 'A8 [log]: add bolding where appropriate', category: 'add-auto-style',
    instruction: 'add bolding where appropriate',
    target: 'Dear Karen,\n\nI am writing to formally resign from my position as Senior Engineer at CS Limited. My last day will be 31st June 2026.\n\nBest regards,\nWilfred',
    expectInOutput: '**' },                         // any bold marker present
  { name: 'A9 [log]: make bold the bits necessary', category: 'add-auto-style',
    instruction: 'make bold the bits necessary',
    target: 'This document contains private information about Acme Corp and is confidential.',
    expectInOutput: '**' },
];

// ─────────── Prompt variants to test ───────────

/** TRIMMED — drop redundant examples, keep critical ones. */
const P2_APPLY_TRIMMED = `You receive:
- INSTRUCTION: a short imperative editing command
- TARGET: the text to apply the instruction to

Apply the INSTRUCTION to the TARGET and emit the rewritten TARGET. No commentary.

Output exactly one line, nothing else:
REWRITE: <rewritten target>

RULES:
1. Apply the instruction to ALL applicable spans, not just the first.
2. Preserve everything that wasn't targeted (other words, punctuation, casing).
3. PRESERVE STRUCTURE — keep paragraph breaks (\\n\\n) and line breaks (\\n) verbatim. Multi-paragraph in → multi-paragraph out.
4. CONCEPT-SWAP — when the instruction names a CATEGORY ("change pet from dog to cat", "change setting to ocean", "switch sport from X to Y"), propagate dependent vocabulary (verbs, objects, properties) that becomes wrong after the swap. Words that work for both stay UNCHANGED. LITERAL swaps ("change boy to girl") do NOT trigger propagation — only swap the literal tokens.
5. ROLE PRESERVATION — when target labels numbers with roles ("original price 100, final price 100"), only update the role the instruction names.
6. COMPOSED INSTRUCTIONS ("X | Y") — apply both transforms; result grammatical under both.
7. CONDITIONAL INSTRUCTIONS ("X but not Y", "X except Y") — apply only where the condition holds.
8. CURSOR ANCHOR — TARGET may contain a [CURSOR] marker. For POSITIONAL instructions ("here", "this line", "this word", "add X", "split here", "before/after this", "new line/paragraph here"), apply the edit AT the [CURSOR] location. For non-positional instructions (translate, capitalise, fix typos, make shorter, etc.), IGNORE [CURSOR]. ALWAYS strip [CURSOR] from your output. Mapping:
   - "line break here" / "new line here" → insert "\\n"
   - "paragraph break here" / "new paragraph here" / "split paragraph here" → insert "\\n\\n"
   - "insert <text> here" → insert <text>
9. MARKDOWN — when the instruction asks for inline styling on a span ("make X bold", "italicize Y", "strikethrough Z", "make heading", "turn into list"), the rewrite MUST contain the ENTIRE TARGET verbatim except for adding markers around the named span:
   - bold → \`**span**\`
   - italic → \`*span*\`
   - strikethrough → \`~~span~~\`
   - heading → prefix with \`# \`
   - list → prefix each item with \`- \`
   Never collapse the body to just the bare span.

EXAMPLES:

INSTRUCTION: change boy to girl
TARGET: the boy ran fast
REWRITE: the girl ran fast

INSTRUCTION: make past tense
TARGET: I run to the store every day
REWRITE: I ran to the store every day

INSTRUCTION: make it british english
TARGET: the color of the harbor is gray
REWRITE: the colour of the harbour is grey

INSTRUCTION: pluralize
TARGET: the child found one mouse
REWRITE: the children found mice

INSTRUCTION: change pet from dog to cat
TARGET: the dog wagged its tail and barked at the postman
REWRITE: the cat swished its tail and meowed at the postman

INSTRUCTION: add 10%
TARGET: original price 100, final price 100
REWRITE: original price 100, final price 110

INSTRUCTION: change boy to girl but not in the second sentence
TARGET: The boy ran to the park. The boy met another boy there. They played until the boy went home.
REWRITE: The girl ran to the park. The boy met another boy there. They played until the girl went home.

INSTRUCTION: pluralize | make past tense
TARGET: the child runs to the park
REWRITE: the children ran to the park

INSTRUCTION: make wilfred bold
TARGET: hii my name is wilfred.
REWRITE: hii my name is **wilfred**.

INSTRUCTION: italicize wilfred
TARGET: hii my name is wilfred.
REWRITE: hii my name is *wilfred*.

INSTRUCTION: make the first line a heading
TARGET: My Notes

Today I worked on the runtime.
REWRITE: # My Notes

Today I worked on the runtime.

INSTRUCTION: turn the items into a list
TARGET: I bought apples bananas and oranges.
REWRITE: - apples
- bananas
- oranges

INSTRUCTION: insert a comma here
TARGET: hello[CURSOR] world
REWRITE: hello, world

INSTRUCTION: add a line break here
TARGET: hi my name is wilfred[CURSOR] and I work on opencues
REWRITE: hi my name is wilfred
 and I work on opencues

INSTRUCTION: bold this line
TARGET: first line
second [CURSOR]line
third line
REWRITE: first line
**second line**
third line`;

const VARIANTS: Array<{ name: string; prompt: string; chars: number; examples: number }> = [
  { name: 'CURRENT', prompt: P2_APPLY_SYSTEM, chars: P2_APPLY_SYSTEM.length, examples: (P2_APPLY_SYSTEM.match(/^INSTRUCTION:/gm) ?? []).length },
  { name: 'TRIMMED', prompt: P2_APPLY_TRIMMED, chars: P2_APPLY_TRIMMED.length, examples: (P2_APPLY_TRIMMED.match(/^INSTRUCTION:/gm) ?? []).length },
];

// ─────────── runner ───────────

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const BLUE = '\x1b[34m';

interface Attempt { pass: boolean; output: string; latencyMs: number; }

async function applyOnce(prompt: string, c: CaseSpec): Promise<Attempt> {
  const t0 = Date.now();
  const target = typeof c.cursorOffset === 'number'
    ? injectCursorSentinel(c.target, c.cursorOffset)
    : c.target;
  const r = await chat([
    { role: 'system', content: prompt },
    { role: 'user', content: `INSTRUCTION: ${c.instruction}\nTARGET: ${target}` },
  ], { temperature: 0, maxTokens: 1024 });
  const m = r.text.match(/REWRITE:[ \t]*([\s\S]*?)\s*$/i);
  const stripped = stripCursorSentinel(m ? m[1].trim() : r.text.trim());
  let pass = stripped.includes(c.expectInOutput);
  if (pass && typeof c.requireOriginalNewlines === 'number') {
    const actual = (stripped.match(/\n/g) ?? []).length;
    if (actual < c.requireOriginalNewlines - 1) pass = false;
  }
  return { pass, output: stripped, latencyMs: Date.now() - t0 };
}

async function main() {
  console.log(`${BOLD}APPLY prompt-tuning A/B${RESET}`);
  for (const v of VARIANTS) {
    console.log(`  ${v.name.padEnd(8)}  ${v.chars} chars  ${v.examples} examples`);
  }
  console.log();

  // For each case run all variants × fanout.
  const results = new Map<string, Map<string, Attempt[]>>(); // case → variant → attempts
  for (const c of CASES) {
    const perVariant = new Map<string, Attempt[]>();
    for (const v of VARIANTS) {
      const attempts: Attempt[] = [];
      for (let i = 0; i < FANOUT; i++) attempts.push(await applyOnce(v.prompt, c));
      perVariant.set(v.name, attempts);
    }
    results.set(c.name, perVariant);

    const cur = perVariant.get('CURRENT')!;
    const trm = perVariant.get('TRIMMED')!;
    const curPass = cur.filter(a => a.pass).length;
    const trmPass = trm.filter(a => a.pass).length;
    const delta = trmPass - curPass;
    const arrow = delta > 0 ? `${GREEN}↑+${delta}${RESET}` : delta < 0 ? `${RED}↓${delta}${RESET}` : `${DIM}±0${RESET}`;
    console.log(`${BOLD}${c.name}${RESET} ${DIM}[${c.category}]${RESET}  current=${curPass}/${FANOUT}  trimmed=${trmPass}/${FANOUT}  ${arrow}`);
  }

  console.log();
  console.log(`${BOLD}Category breakdown${RESET}`);
  const catAgg = new Map<Category, Record<string, { pass: number; total: number }>>();
  for (const c of CASES) {
    const perV = results.get(c.name)!;
    const slot = catAgg.get(c.category) ?? {};
    for (const v of VARIANTS) {
      const passes = perV.get(v.name)!.filter(a => a.pass).length;
      slot[v.name] = { pass: (slot[v.name]?.pass ?? 0) + passes, total: (slot[v.name]?.total ?? 0) + FANOUT };
    }
    catAgg.set(c.category, slot);
  }
  for (const [cat, slot] of catAgg) {
    const cur = slot['CURRENT'], trm = slot['TRIMMED'];
    const delta = trm.pass - cur.pass;
    const arrow = delta > 0 ? `${GREEN}↑+${delta}${RESET}` : delta < 0 ? `${RED}↓${delta}${RESET}` : `${DIM}±0${RESET}`;
    console.log(`  ${cat.padEnd(22)}  current=${cur.pass}/${cur.total}  trimmed=${trm.pass}/${trm.total}  ${arrow}`);
  }

  console.log();
  console.log(`${BOLD}Overall${RESET}`);
  for (const v of VARIANTS) {
    let pass = 0, total = 0;
    for (const c of CASES) {
      const attempts = results.get(c.name)!.get(v.name)!;
      pass += attempts.filter(a => a.pass).length;
      total += attempts.length;
    }
    console.log(`  ${v.name.padEnd(8)}  ${pass}/${total} (${((pass/total)*100).toFixed(1)}%)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
