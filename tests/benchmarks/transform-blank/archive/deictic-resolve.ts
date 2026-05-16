/**
 * Real-LLM benchmark for the P1.5 deictic-resolver step.
 *
 * For each case:
 *  - Run APPLY on the RAW instruction (baseline — what we ship today)
 *  - Run P1.5 (resolve deictics) → APPLY on the RESOLVED instruction (new path)
 *  - Compare success rates side by side
 *
 * Also exercises the conditional trigger (`needsDeicticResolution`) — cases
 * tagged `expectsTrigger: true/false` verify the cheap regex catches what it
 * should and skips what it shouldn't.
 *
 * Run:
 *   GROQ_API_KEY=... npx tsx tests/benchmarks/transform-blank/deictic-resolve.ts
 *
 * Each case fans out 3 attempts per path to surface non-determinism.
 */

import { chat } from './groq';
import {
  P2_APPLY_SYSTEM,
  P1_5_RESOLVE_DEICTICS_SYSTEM,
  needsDeicticResolution,
} from '../../../packages/opencues-core/src/sources/transform-blank-source';
import {
  injectCursorSentinel,
  stripCursorSentinel,
} from '../../../packages/opencues-core/src/cursor-sentinel';

type Category =
  | 'this-line' | 'this-word' | 'this-sentence' | 'this-paragraph'
  | 'this-standalone' | 'it-them' | 'these-those'
  | 'positional-no-resolve' | 'non-deictic' | 'edge-case';

interface CaseSpec {
  name: string;
  category: Category;
  instruction: string;
  target: string;
  cursorOffset: number;
  /** Trigger expectation — should `needsDeicticResolution(instruction)` return true? */
  expectsTrigger: boolean;
  /** Substring required in APPLY's stripped output to pass. */
  expectInOutput: string;
  /** Optional: if set, the output must preserve this many `\n` chars. */
  requireOriginalNewlines?: number;
}

const FANOUT = 3;

const CASES: CaseSpec[] = [
  // ─────────── this-line (8 cases) ───────────
  {
    name: '1: bold this line on 3-line target',
    category: 'this-line',
    instruction: 'make this line bold',
    target: 'first line\nDear Karen,\nbest regards',
    cursorOffset: 22,                            // mid "Dear Karen,"
    expectsTrigger: true,
    expectInOutput: '**Dear Karen,**',
    requireOriginalNewlines: 2,
  },
  {
    name: '2: capitalise this line',
    category: 'this-line',
    instruction: 'make this line all caps',
    target: 'hi\nthe meeting is at 3pm\nbye',
    cursorOffset: 12,
    expectsTrigger: true,
    expectInOutput: 'THE MEETING IS AT 3PM',
    requireOriginalNewlines: 2,
  },
  {
    name: '3: italicise this line',
    category: 'this-line',
    instruction: 'italicise this line',
    target: 'alpha\nbeta gamma\ndelta',
    cursorOffset: 10,
    expectsTrigger: true,
    expectInOutput: '*beta gamma*',
    requireOriginalNewlines: 2,
  },
  {
    name: '4: delete this line',
    category: 'this-line',
    instruction: 'delete this line',
    target: 'keep one\ndrop this\nkeep two',
    cursorOffset: 13,
    expectsTrigger: true,
    expectInOutput: 'keep one',                  // line dropped → "keep one\nkeep two"
    requireOriginalNewlines: 1,
  },
  {
    name: '5: fix typos on this line',
    category: 'this-line',
    instruction: 'fix typos on this line',
    target: 'good line\nhelo wrld\nfine line',
    cursorOffset: 12,
    expectsTrigger: true,
    expectInOutput: 'hello world',
    requireOriginalNewlines: 2,
  },
  {
    name: '6: shorten this line',
    category: 'this-line',
    instruction: 'shorten this line',
    target: 'short\nThis is a very long sentence that goes on and on and on.\nshort2',
    cursorOffset: 30,
    expectsTrigger: true,
    expectInOutput: 'short',                     // first line preserved
    requireOriginalNewlines: 2,
  },
  {
    name: '7: rephrase this line',
    category: 'this-line',
    instruction: 'rephrase this line more formally',
    target: 'intro\nhey wassup yall\noutro',
    cursorOffset: 12,
    expectsTrigger: true,
    expectInOutput: 'intro',                     // outer lines untouched
    requireOriginalNewlines: 2,
  },
  {
    name: '8: translate this line',
    category: 'this-line',
    instruction: 'translate this line to french',
    target: 'english one\nhello world\nenglish two',
    cursorOffset: 16,
    expectsTrigger: true,
    expectInOutput: 'bonjour',
    requireOriginalNewlines: 2,
  },

  // ─────────── this-word (6 cases) ───────────
  {
    name: '9: bold this word',
    category: 'this-word',
    instruction: 'bold this word',
    target: 'hi my name is wilfred today',
    cursorOffset: 16,                            // mid "wilfred"
    expectsTrigger: true,
    expectInOutput: '**wilfred**',
  },
  {
    name: '10: capitalise this word',
    category: 'this-word',
    instruction: 'capitalise this word',
    target: 'the quick brown fox',
    cursorOffset: 12,                            // mid "brown"
    expectsTrigger: true,
    expectInOutput: 'BROWN',
  },
  {
    name: '11: italicise this word',
    category: 'this-word',
    instruction: 'italicise this word',
    target: 'hello beautiful world',
    cursorOffset: 10,                            // mid "beautiful"
    expectsTrigger: true,
    expectInOutput: '*beautiful*',
  },
  {
    name: '12: delete this word',
    category: 'this-word',
    instruction: 'delete this word',
    target: 'keep alpha drop bravo keep charlie',
    cursorOffset: 17,                            // mid "drop"
    expectsTrigger: true,
    expectInOutput: 'keep alpha',                // "drop" gone
  },
  {
    name: '13: pluralise this word',
    category: 'this-word',
    instruction: 'pluralise this word',
    target: 'I saw one cat in the yard',
    cursorOffset: 11,                            // mid "cat"
    expectsTrigger: true,
    expectInOutput: 'cats',
  },
  {
    name: '14: define this word',
    category: 'this-word',
    instruction: 'replace this word with a synonym',
    target: 'the meeting was very productive today',
    cursorOffset: 25,                            // mid "productive"
    expectsTrigger: true,
    expectInOutput: 'today',                     // surrounding context survives
  },

  // ─────────── this-sentence (5 cases) ───────────
  {
    name: '15: rephrase this sentence',
    category: 'this-sentence',
    instruction: 'rephrase this sentence',
    target: 'I went to the store yesterday. I bought some apples. They were red.',
    cursorOffset: 35,                            // mid "I bought some apples"
    expectsTrigger: true,
    expectInOutput: 'apples',
  },
  {
    name: '16: shorten this sentence',
    category: 'this-sentence',
    instruction: 'shorten this sentence',
    target: 'A. This is a very long sentence with many extra words that go on. B.',
    cursorOffset: 30,
    expectsTrigger: true,
    expectInOutput: 'A.',                        // surrounding sentences survive
  },
  {
    name: '17: make this sentence past tense',
    category: 'this-sentence',
    instruction: 'make this sentence past tense',
    target: 'Today is Monday. I run to the store. The weather is nice.',
    cursorOffset: 25,
    expectsTrigger: true,
    expectInOutput: 'ran',
  },
  {
    name: '18: question form for this sentence',
    category: 'this-sentence',
    instruction: 'turn this sentence into a question',
    target: 'Intro line. The meeting is at 3pm. Outro line.',
    cursorOffset: 20,
    expectsTrigger: true,
    expectInOutput: '?',
  },
  {
    name: '19: delete this sentence',
    category: 'this-sentence',
    instruction: 'delete this sentence',
    target: 'Keep one. Drop me please. Keep two.',
    cursorOffset: 16,
    expectsTrigger: true,
    expectInOutput: 'Keep one.',
  },

  // ─────────── this-paragraph (3 cases) ───────────
  {
    name: '20: italicise this paragraph',
    category: 'this-paragraph',
    instruction: 'italicise this paragraph',
    target: 'first para line.\n\nThis is the second paragraph. It has two sentences.\n\nfooter',
    cursorOffset: 30,
    expectsTrigger: true,
    expectInOutput: '*This is the second paragraph',
    requireOriginalNewlines: 4,                  // two \n\n = 4 \n total
  },
  {
    name: '21: shorten this paragraph',
    category: 'this-paragraph',
    instruction: 'shorten this paragraph',
    target: 'A.\n\nThis paragraph has many words and goes on for a while with details.\n\nB.',
    cursorOffset: 40,
    expectsTrigger: true,
    expectInOutput: 'A.',                        // outer paragraphs survive
    requireOriginalNewlines: 4,
  },
  {
    name: '22: translate this paragraph',
    category: 'this-paragraph',
    instruction: 'translate this paragraph to spanish',
    target: 'english intro\n\nhello world how are you\n\nenglish outro',
    cursorOffset: 30,
    expectsTrigger: true,
    expectInOutput: 'hola',
    requireOriginalNewlines: 4,
  },

  // ─────────── this-standalone / it / them (6 cases) ───────────
  {
    name: '23: shorten it (single-sentence target)',
    category: 'it-them',
    instruction: 'shorten it',
    target: 'Dear hiring manager, I am writing to express my strong interest in the role of Senior Engineer at your company.',
    cursorOffset: 50,
    expectsTrigger: true,
    expectInOutput: 'Dear',                      // some text survives, but shorter
  },
  {
    name: '24: capitalise this (standalone)',
    category: 'this-standalone',
    instruction: 'capitalise this',
    target: 'hello world today is monday',
    cursorOffset: 10,                            // mid "world"
    expectsTrigger: true,
    expectInOutput: 'WORLD',
  },
  {
    name: '25: bold that word',
    category: 'this-standalone',
    instruction: 'bold that word',
    target: 'alpha beta gamma',
    cursorOffset: 8,                             // mid "beta"
    expectsTrigger: true,
    expectInOutput: '**beta**',
  },
  {
    name: '26: italicise them (plural — "these words")',
    category: 'these-those',
    instruction: 'italicise these two words',
    target: 'keep some really cool words around',
    cursorOffset: 17,                            // mid "cool"
    expectsTrigger: true,
    expectInOutput: '*',                         // some span got italicised
  },
  {
    name: '27: pluralise it',
    category: 'it-them',
    instruction: 'pluralise it',
    target: 'I saw a beautiful butterfly in the garden',
    cursorOffset: 18,                            // mid "butterfly"
    expectsTrigger: true,
    expectInOutput: 'butterflies',
  },
  {
    name: '28: fix this typo',
    category: 'this-standalone',
    instruction: 'fix this typo',
    target: 'helo wrld and bye',
    cursorOffset: 7,                             // mid "wrld"
    expectsTrigger: true,
    expectInOutput: 'world',
  },

  // ─────────── positional (here / at this point) — NO resolve ───────────
  {
    name: '29: add a comma here',
    category: 'positional-no-resolve',
    instruction: 'add a comma here',
    target: 'apples bananas and oranges',
    cursorOffset: 14,                            // after "bananas"
    expectsTrigger: false,                       // "here" alone — no deictic trigger word
    expectInOutput: ',',
  },
  {
    name: '30: add a line break here',
    category: 'positional-no-resolve',
    instruction: 'add a line break here',
    target: 'first part second part',
    cursorOffset: 10,
    expectsTrigger: false,
    expectInOutput: '\n',
  },
  {
    name: '31: insert "TODO" here',
    category: 'positional-no-resolve',
    instruction: 'insert TODO here',
    target: 'review the PR before lunch',
    cursorOffset: 13,
    expectsTrigger: false,
    expectInOutput: 'TODO',
  },

  // ─────────── non-deictic — instruction should pass through unchanged ───────────
  {
    name: '32: translate to french (no deictic)',
    category: 'non-deictic',
    instruction: 'translate to french',
    target: 'hello my name is wilfred',
    cursorOffset: 12,
    expectsTrigger: false,
    expectInOutput: 'bonjour',
  },
  {
    name: '33: capitalise all words',
    category: 'non-deictic',
    instruction: 'capitalise the first letter of every word',
    target: 'the quick brown fox',
    cursorOffset: 9,
    expectsTrigger: false,
    expectInOutput: 'The Quick Brown Fox',
  },
  {
    name: '34: fix typos (no deictic)',
    category: 'non-deictic',
    instruction: 'fix typos',
    target: 'helo wrld i am tirred',
    cursorOffset: 5,
    expectsTrigger: false,
    expectInOutput: 'hello',
  },
  {
    name: '35: make british english',
    category: 'non-deictic',
    instruction: 'make it british english',
    target: 'the color of the harbor is gray',
    cursorOffset: 15,
    expectsTrigger: true,                        // "it" triggers
    expectInOutput: 'colour',
  },
  {
    name: '36: pluralise everything',
    category: 'non-deictic',
    instruction: 'pluralise every noun',
    target: 'the cat sat on the mat',
    cursorOffset: 8,
    expectsTrigger: false,
    expectInOutput: 'cats',
  },

  // ─────────── edge cases ───────────
  {
    name: '37: mixed deictic ("make this line bold and bold the word X")',
    category: 'edge-case',
    instruction: 'bold this line and italicise wilfred',
    target: 'header line\nmy name is wilfred here\nfooter line',
    cursorOffset: 18,
    expectsTrigger: true,
    expectInOutput: '**',
  },
  {
    name: '38: deictic with cursor at start of word',
    category: 'this-word',
    instruction: 'bold this word',
    target: 'alpha beta gamma',
    cursorOffset: 6,                             // start of "beta"
    expectsTrigger: true,
    expectInOutput: '**beta**',
  },
  {
    name: '39: deictic with cursor at end of word',
    category: 'this-word',
    instruction: 'bold this word',
    target: 'alpha beta gamma',
    cursorOffset: 10,                            // end of "beta"
    expectsTrigger: true,
    expectInOutput: '**beta**',
  },
  {
    name: '40: deictic with cursor in trailing punctuation',
    category: 'this-word',
    instruction: 'bold this word',
    target: 'hello world!',
    cursorOffset: 11,                            // at "!" — model needs to pick "world"
    expectsTrigger: true,
    expectInOutput: '**world**',
  },

  // ─────────── 20 more "this" cases — verb-suffix, noun variants, abstract referents ───────────
  {
    name: '41: bold this (standalone, cursor in word)',
    category: 'this-standalone',
    instruction: 'bold this',
    target: 'hello wilfred today',
    cursorOffset: 9,
    expectsTrigger: true,
    expectInOutput: '**wilfred**',
  },
  {
    name: '42: italicise this (standalone)',
    category: 'this-standalone',
    instruction: 'italicise this',
    target: 'alpha beta gamma',
    cursorOffset: 8,
    expectsTrigger: true,
    expectInOutput: '*beta*',
  },
  {
    name: '43: delete this (standalone)',
    category: 'this-standalone',
    instruction: 'delete this word',
    target: 'keep drop keep',
    cursorOffset: 7,
    expectsTrigger: true,
    expectInOutput: 'keep keep',
  },
  {
    name: '44: uppercase this (standalone)',
    category: 'this-standalone',
    instruction: 'uppercase this',
    target: 'hello world today',
    cursorOffset: 8,
    expectsTrigger: true,
    expectInOutput: 'WORLD',
  },
  {
    name: '45: strikethrough this',
    category: 'this-standalone',
    instruction: 'strikethrough this',
    target: 'apples bananas oranges',
    cursorOffset: 10,
    expectsTrigger: true,
    expectInOutput: '~~bananas~~',
  },
  {
    name: '46: bold this name',
    category: 'this-word',
    instruction: 'bold this name',
    target: 'hi my name is wilfred today',
    cursorOffset: 18,
    expectsTrigger: true,
    expectInOutput: '**wilfred**',
  },
  {
    name: '47: capitalise this title',
    category: 'this-line',
    instruction: 'capitalise this title',
    target: 'introduction\nlorem ipsum body text\nappendix',
    cursorOffset: 5,
    expectsTrigger: true,
    expectInOutput: 'INTRODUCTION',
    requireOriginalNewlines: 2,
  },
  {
    name: '48: turn this list into numbered',
    category: 'this-paragraph',
    instruction: 'turn this list into a numbered list',
    target: 'header\n\n- apples\n- bananas\n- oranges\n\nfooter',
    cursorOffset: 20,
    expectsTrigger: true,
    expectInOutput: '1.',
    requireOriginalNewlines: 4,
  },
  {
    name: '49: remove this item',
    category: 'this-line',
    instruction: 'remove this item',
    target: '- apples\n- drop me\n- oranges',
    cursorOffset: 13,
    expectsTrigger: true,
    expectInOutput: '- apples',
    requireOriginalNewlines: 1,
  },
  {
    name: '50: fix this typo',
    category: 'this-word',
    instruction: 'fix this typo',
    target: 'I went to the storre yesterday and bought apples',
    cursorOffset: 18,
    expectsTrigger: true,
    expectInOutput: 'store',
  },
  {
    name: '51: bold this whole line',
    category: 'this-line',
    instruction: 'bold this whole line',
    target: 'line one\nthe meeting is at 3pm\nline three',
    cursorOffset: 15,
    expectsTrigger: true,
    expectInOutput: '**the meeting is at 3pm**',
    requireOriginalNewlines: 2,
  },
  {
    name: '52: capitalise this entire paragraph',
    category: 'this-paragraph',
    instruction: 'capitalise this entire paragraph',
    target: 'intro\n\nhello world\n\noutro',
    cursorOffset: 12,
    expectsTrigger: true,
    expectInOutput: 'HELLO WORLD',
    requireOriginalNewlines: 4,
  },
  {
    name: '53: shorten this bit',
    category: 'this-standalone',
    instruction: 'shorten this bit',
    target: 'A. This is a very long sentence with a great many extra words that go on and on. B.',
    cursorOffset: 30,
    expectsTrigger: true,
    expectInOutput: 'A.',
  },
  {
    name: '54: rephrase this part more formally',
    category: 'this-standalone',
    instruction: 'rephrase this part more formally',
    target: 'intro line\nhey wassup yall lets meet\noutro line',
    cursorOffset: 18,
    expectsTrigger: true,
    expectInOutput: 'intro line',
    requireOriginalNewlines: 2,
  },
  {
    name: '55: translate this section',
    category: 'this-paragraph',
    instruction: 'translate this section to spanish',
    target: 'english intro\n\nhello world\n\nenglish outro',
    cursorOffset: 18,
    expectsTrigger: true,
    expectInOutput: 'hola',
    requireOriginalNewlines: 4,
  },
  {
    name: '56: clean this up',
    category: 'this-standalone',
    instruction: 'clean this up',
    target: 'hello   world  yeah    so',
    cursorOffset: 5,
    expectsTrigger: true,
    expectInOutput: 'hello world',
  },
  {
    name: '57: simplify this sentence',
    category: 'this-sentence',
    instruction: 'simplify this sentence',
    target: 'preface. The aforementioned individual proceeded to ambulate towards the establishment. closing.',
    cursorOffset: 40,
    expectsTrigger: true,
    expectInOutput: 'walked',
  },
  {
    name: '58: rephrase this sentence in plain english',
    category: 'this-sentence',
    instruction: 'rephrase this sentence in plain english',
    target: 'A. The aforementioned individual proceeded to ambulate towards the establishment. B.',
    cursorOffset: 40,
    expectsTrigger: true,
    expectInOutput: 'walked',
  },
  {
    name: '59: bold this (cursor mid-word in long target)',
    category: 'this-standalone',
    instruction: 'bold this',
    target: 'apples bananas oranges',
    cursorOffset: 10,
    expectsTrigger: true,
    expectInOutput: '**bananas**',
  },
  {
    name: '60: capitalise this (cursor at very start)',
    category: 'this-standalone',
    instruction: 'capitalise this',
    target: 'wilfred is here',
    cursorOffset: 0,
    expectsTrigger: true,
    expectInOutput: 'WILFRED',
  },

  // ─────────── REAL phrasings pulled from /tmp/opencues.log ───────────
  // Explicit word reference — NO deictic. Should pass through P1.5 unchanged.
  {
    name: '61 [log]: make wilfred bold (non-deictic explicit word)',
    category: 'non-deictic',
    instruction: 'make wilfred bold',
    target: 'hi my name is wilfred today',
    cursorOffset: 20,
    expectsTrigger: false,
    expectInOutput: '**wilfred**',
  },
  {
    name: '62 [log]: make wilfred italic',
    category: 'non-deictic',
    instruction: 'make wilfred italic',
    target: 'hi my name is wilfred today',
    cursorOffset: 20,
    expectsTrigger: false,
    expectInOutput: '*wilfred*',
  },
  {
    name: '63 [log]: make wilfred caps (verb variant for uppercase)',
    category: 'non-deictic',
    instruction: 'make wilfred caps',
    target: 'hi my name is wilfred today',
    cursorOffset: 20,
    expectsTrigger: false,
    expectInOutput: 'WILFRED',
  },
  {
    name: '64 [log]: make wilfred capitalised',
    category: 'non-deictic',
    instruction: 'make wilfred capitalised',
    target: 'hi my name is wilfred today',
    cursorOffset: 20,
    expectsTrigger: false,
    expectInOutput: 'Wilfred',                  // title-case interp is reasonable
  },
  {
    name: '65 [log]: make wilfred not bold (un-apply)',
    category: 'non-deictic',
    instruction: 'make wilfred not bold',
    target: 'hi my name is **wilfred** today',
    cursorOffset: 20,
    expectsTrigger: false,
    expectInOutput: 'wilfred',                  // ** removed
  },
  {
    name: '66 [log]: make wilfred text italic (X text)',
    category: 'non-deictic',
    instruction: 'make wilfred text italic',
    target: 'hi my name is wilfred today',
    cursorOffset: 20,
    expectsTrigger: false,
    expectInOutput: '*wilfred*',
  },
  {
    name: '67 [log]: make wilfred text bold and italic (composed)',
    category: 'non-deictic',
    instruction: 'make wilfred text bold and italic',
    target: 'hi my name is wilfred today',
    cursorOffset: 20,
    expectsTrigger: false,
    expectInOutput: 'wilfred',                  // some marker appears
  },
  {
    name: '68 [log]: change will for wilfred (substitution)',
    category: 'non-deictic',
    instruction: 'change will for wilfred',
    target: 'hi my name is will today',
    cursorOffset: 20,
    expectsTrigger: false,
    expectInOutput: 'wilfred',
  },
  {
    name: '69 [log]: remove italics (global, non-deictic)',
    category: 'non-deictic',
    instruction: 'remove italics',
    target: 'hi my *name* is *wilfred* today',
    cursorOffset: 15,
    expectsTrigger: false,
    expectInOutput: 'name is wilfred',          // markers gone
  },
  {
    name: '70 [log]: make this line full caps (your actual failing case)',
    category: 'this-line',
    instruction: 'make this line full caps',
    target: 'Dear Karen,\n\nI hope you are well.\n\nBest regards.',
    cursorOffset: 25,                            // mid "I hope you are well."
    expectsTrigger: true,
    expectInOutput: 'I HOPE YOU ARE WELL.',
    requireOriginalNewlines: 4,
  },
  {
    name: '71 [log]: make this line capitalized',
    category: 'this-line',
    instruction: 'make this line capitalized',
    target: 'Dear Karen,\n\nthe meeting is at 3pm\n\nBest regards.',
    cursorOffset: 25,
    expectsTrigger: true,
    expectInOutput: 'MEETING',                  // some uppercasing happens
    requireOriginalNewlines: 4,
  },
  {
    name: '72 [log]: capitalize the words on this line',
    category: 'this-line',
    instruction: 'capitalize the words on this line',
    target: 'intro\nhello world today\noutro',
    cursorOffset: 12,
    expectsTrigger: true,
    expectInOutput: 'World',                    // title-case is the most likely read
    requireOriginalNewlines: 2,
  },
  {
    name: '73 [log]: sign off the email here',
    category: 'positional-no-resolve',
    instruction: 'sign off the email here',
    target: 'Dear team,\n\nThank you for the update.\n\n',
    cursorOffset: 40,                            // at the trailing position
    expectsTrigger: false,
    expectInOutput: 'regards',                  // some sign-off appears
  },
  {
    name: '74 [log]: capitalize here',
    category: 'positional-no-resolve',
    instruction: 'capitalize here',
    target: 'hello world today is monday',
    cursorOffset: 7,                             // mid "world"
    expectsTrigger: false,
    expectInOutput: 'WORLD',
  },
  {
    name: '75 [log]: change will for Wilfred (canonicalised)',
    category: 'non-deictic',
    instruction: 'change will for Wilfred',
    target: 'hi my name is will today',
    cursorOffset: 20,
    expectsTrigger: false,
    expectInOutput: 'Wilfred',
  },
];

// ─────────── ANSI helpers ───────────
const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const BLUE = '\x1b[34m';

// ─────────── Runners ───────────

interface AttemptResult { pass: boolean; output: string; latencyMs: number; }
interface CaseResult {
  raw: AttemptResult[];
  resolved: AttemptResult[];
  resolvedInstruction: string;
  triggerObserved: boolean;
}

async function resolveDeictics(c: CaseSpec): Promise<string> {
  if (!needsDeicticResolution(c.instruction)) return c.instruction;
  const targetWithCursor = injectCursorSentinel(c.target, c.cursorOffset);
  const result = await chat([
    { role: 'system', content: P1_5_RESOLVE_DEICTICS_SYSTEM },
    { role: 'user', content: `INSTRUCTION: ${c.instruction}\nTARGET: ${targetWithCursor}` },
  ], { temperature: 0, maxTokens: 512 });
  const m = result.text.match(/RESOLVED:[ \t]*([\s\S]*?)\s*$/i);
  return (m ? m[1].trim() : result.text.trim()) || c.instruction;
}

async function applyOnce(instruction: string, c: CaseSpec): Promise<AttemptResult> {
  const t0 = Date.now();
  const targetWithCursor = injectCursorSentinel(c.target, c.cursorOffset);
  const result = await chat([
    { role: 'system', content: P2_APPLY_SYSTEM },
    { role: 'user', content: `INSTRUCTION: ${instruction}\nTARGET: ${targetWithCursor}` },
  ], { temperature: 0, maxTokens: 1024 });
  const m = result.text.match(/REWRITE:[ \t]*([\s\S]*?)\s*$/i);
  const stripped = stripCursorSentinel((m ? m[1].trim() : result.text.trim()));
  let pass = stripped.includes(c.expectInOutput);
  if (pass && typeof c.requireOriginalNewlines === 'number') {
    const actual = (stripped.match(/\n/g) ?? []).length;
    // Allow flex: actual >= required - 1 (deletions allow one less)
    if (actual < c.requireOriginalNewlines - 1) pass = false;
  }
  return { pass, output: stripped, latencyMs: Date.now() - t0 };
}

async function runCase(c: CaseSpec): Promise<CaseResult> {
  // Raw path: fan out 3 attempts on the original instruction.
  const raw: AttemptResult[] = [];
  for (let i = 0; i < FANOUT; i++) raw.push(await applyOnce(c.instruction, c));

  // Resolved path: resolve once, then fan out 3 APPLY attempts.
  const resolvedInstruction = await resolveDeictics(c);
  const resolved: AttemptResult[] = [];
  for (let i = 0; i < FANOUT; i++) resolved.push(await applyOnce(resolvedInstruction, c));

  return {
    raw,
    resolved,
    resolvedInstruction,
    triggerObserved: needsDeicticResolution(c.instruction),
  };
}

function summarize(r: AttemptResult[]): { passes: number; total: number; rate: number } {
  const passes = r.filter(a => a.pass).length;
  return { passes, total: r.length, rate: passes / r.length };
}

// ─────────── Main ───────────

async function main() {
  console.log(`${BOLD}P1.5 deictic-resolver benchmark${RESET}`);
  console.log(`${DIM}${CASES.length} cases × ${FANOUT} fanout × 2 paths = ${CASES.length * FANOUT * 2} APPLY calls + ~${CASES.filter(c => needsDeicticResolution(c.instruction)).length} P1.5 calls${RESET}`);
  console.log();

  const results: Array<{ c: CaseSpec; r: CaseResult }> = [];
  let triggerMismatch = 0;
  for (const c of CASES) {
    const r = await runCase(c);
    results.push({ c, r });

    const triggerOk = r.triggerObserved === c.expectsTrigger;
    if (!triggerOk) triggerMismatch++;
    const trigStr = triggerOk
      ? `${GREEN}trigger=${r.triggerObserved}${RESET}`
      : `${RED}trigger=${r.triggerObserved} (expected ${c.expectsTrigger})${RESET}`;

    const rawSum = summarize(r.raw);
    const resSum = summarize(r.resolved);
    const delta = resSum.passes - rawSum.passes;
    const arrow = delta > 0 ? `${GREEN}↑+${delta}${RESET}` : delta < 0 ? `${RED}↓${delta}${RESET}` : `${DIM}±0${RESET}`;
    console.log(`${BOLD}${c.name}${RESET} ${DIM}[${c.category}]${RESET}`);
    console.log(`  ${DIM}instruction:${RESET} ${c.instruction}`);
    console.log(`  ${DIM}resolved:   ${RESET} ${c.instruction === r.resolvedInstruction ? DIM+'(unchanged)'+RESET : BLUE+r.resolvedInstruction+RESET}`);
    console.log(`  raw=${rawSum.passes}/${rawSum.total}   resolved=${resSum.passes}/${resSum.total}   ${arrow}   ${trigStr}`);
    console.log();
  }

  // Aggregate by category.
  console.log(`${BOLD}Category breakdown${RESET}`);
  const catMap = new Map<Category, { raw: number; res: number; total: number }>();
  for (const { c, r } of results) {
    const acc = catMap.get(c.category) ?? { raw: 0, res: 0, total: 0 };
    acc.raw += summarize(r.raw).passes;
    acc.res += summarize(r.resolved).passes;
    acc.total += FANOUT;
    catMap.set(c.category, acc);
  }
  for (const [cat, agg] of catMap) {
    const rawPct = ((agg.raw / agg.total) * 100).toFixed(0);
    const resPct = ((agg.res / agg.total) * 100).toFixed(0);
    const delta = agg.res - agg.raw;
    const arrow = delta > 0 ? `${GREEN}↑+${delta}${RESET}` : delta < 0 ? `${RED}↓${delta}${RESET}` : `${DIM}±0${RESET}`;
    console.log(`  ${cat.padEnd(24)}  raw=${agg.raw}/${agg.total} (${rawPct}%)   resolved=${agg.res}/${agg.total} (${resPct}%)   ${arrow}`);
  }
  console.log();

  // Totals.
  const totalRaw = [...catMap.values()].reduce((s, v) => s + v.raw, 0);
  const totalRes = [...catMap.values()].reduce((s, v) => s + v.res, 0);
  const totalAll = [...catMap.values()].reduce((s, v) => s + v.total, 0);
  const overallDelta = totalRes - totalRaw;
  console.log(`${BOLD}Overall${RESET}`);
  console.log(`  raw      = ${totalRaw}/${totalAll} (${((totalRaw/totalAll)*100).toFixed(1)}%)`);
  console.log(`  resolved = ${totalRes}/${totalAll} (${((totalRes/totalAll)*100).toFixed(1)}%)`);
  console.log(`  delta    = ${overallDelta > 0 ? GREEN+'+'+overallDelta+RESET : overallDelta < 0 ? RED+overallDelta+RESET : '±0'} attempts`);
  console.log();
  console.log(`Conditional trigger mismatches: ${triggerMismatch}/${CASES.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
