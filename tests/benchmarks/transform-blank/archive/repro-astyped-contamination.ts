/**
 * Confirms the asTypedText contamination hypothesis for the
 * "remove emojis" TransformBlank bug.
 *
 * Scenario:
 *   1. User typed "<no-emoji body> add emojis where appropriate _" in
 *      the editor and triggered TransformBlank. It substituted with
 *      <emoji body>, leaving a TransformBlank DynDef whose originalWord
 *      is the FULL prior visible text (body + the prior instruction).
 *   2. User now types " remove emojis _" at the end of the visible
 *      <emoji body>. The runtime calls reconstructAsTyped to build
 *      the EXTRACT input. Because the DynDef's originalWord includes
 *      "add emojis where appropriate _", that prior instruction gets
 *      re-injected into the asTyped view — EXTRACT sees TWO
 *      instructions and TWO `_`s.
 *
 * Test:
 *   (a) Pure-local: build the DynDef + call reconstructAsTyped and
 *       check the asTyped string contains BOTH instructions.
 *   (b) LLM: feed the contaminated asTyped to the real EXTRACT prompt
 *       and confirm it returns INSTRUCTION="add emojis where
 *       appropriate" / TARGET="remove emojis" — the exact bug shape.
 *
 * Run:
 *   npx tsx tests/benchmarks/transform-blank/repro-astyped-contamination.ts
 */

import { reconstructAsTyped, DynDefs } from '../../../packages/opencues-runtime/src/state/dyn-defs';
import { splitWords } from '../../../packages/opencues-runtime/src/modules/navigation';
import { chat } from './groq';
import { P1_EXTRACT_SYSTEM } from '../../../packages/opencues-core/src/sources/transform-blank-source';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

const NO_EMOJI_BODY = `Karen,

I am writing to formally resign from my position, effective two weeks from today.

Sincerely,
Wilfred`;

const EMOJI_BODY = `Karen, ✉️

I am writing to formally resign from my position, effective two weeks from today. ⏳

Sincerely, 🙏
Wilfred`;

// What the editor held BEFORE the first TransformBlank fired (the body
// the user typed PLUS the trigger phrase that drove the transform).
// This becomes alternatives[0] / originalWord on the DynDef.
const FIRST_ORIGINAL = `${NO_EMOJI_BODY} add emojis where appropriate _`;

// What's visible AFTER the first transform — emoji body alone.
const FIRST_REWRITE = EMOJI_BODY;

// What's visible NOW — emoji body + the user's NEW second-transform
// trigger phrase.
const VISIBLE_NOW = `${EMOJI_BODY} remove emojis _`;

function main(): Promise<void> {
  console.log(`${BOLD}=== Part A: pure-local reconstructAsTyped contamination ===${RESET}\n`);

  // Build a DynDef matching what TransformBlank emits after a
  // successful first transform. spanStart=0; spanEnd = end of last
  // word in the rewritten body (i.e. covers the entire visible body
  // PRE-second-trigger).
  const dynDefs = new DynDefs();
  const rewriteWords = splitWords(FIRST_REWRITE);
  const lastRewriteWord = rewriteWords[rewriteWords.length - 1];
  const def = {
    originalWord: FIRST_ORIGINAL,
    alternatives: [FIRST_ORIGINAL, FIRST_REWRITE],
    currentIndex: 1,                          // showing rewrite
    spanStart: 0,
    spanEnd: lastRewriteWord.end,
    blankName: 'transform-blank',
  };
  // anchor at the FIRST word of the rewritten span — that's where
  // TransformBlank places the def (newWordIndex per resolver.ts).
  dynDefs.set(rewriteWords[0].index, def);

  const asTyped = reconstructAsTyped(VISIBLE_NOW, dynDefs, splitWords);

  console.log(`${DIM}Visible (what user sees):${RESET}`);
  console.log(`  ${VISIBLE_NOW.replace(/\n/g, '\n  ')}\n`);
  console.log(`${DIM}AsTyped (what EXTRACT receives):${RESET}`);
  console.log(`  ${asTyped.replace(/\n/g, '\n  ')}\n`);

  const containsOldInstruction = asTyped.includes('add emojis where appropriate');
  const containsNewInstruction = asTyped.includes('remove emojis');
  const underscoreCount = (asTyped.match(/_/g) ?? []).length;

  console.log(`  contains "add emojis where appropriate": ${containsOldInstruction ? RED + 'YES (contamination)' + RESET : GREEN + 'no' + RESET}`);
  console.log(`  contains "remove emojis":                ${containsNewInstruction ? GREEN + 'yes' + RESET : RED + 'NO' + RESET}`);
  console.log(`  underscore count:                        ${underscoreCount} ${underscoreCount > 1 ? RED + '(too many — should be 1)' + RESET : ''}`);

  if (containsOldInstruction && underscoreCount > 1) {
    console.log(`\n${RED}${BOLD}✗ Contamination CONFIRMED — asTypedText carries the prior instruction into EXTRACT input.${RESET}\n`);
  } else {
    console.log(`\n${GREEN}${BOLD}\x1b[32m●\x1b[0m No contamination detected.${RESET}\n`);
    return Promise.resolve();
  }

  console.log(`${BOLD}=== Part B: feed the contaminated asTyped to the real EXTRACT prompt ===${RESET}\n`);

  return chat([
    { role: 'system', content: P1_EXTRACT_SYSTEM },
    { role: 'user', content: `INPUT: ${asTyped}` },
  ], { temperature: 0, maxTokens: 1024 }).then(res => {
    console.log(`${DIM}Raw EXTRACT response:${RESET}`);
    console.log(`  ${res.text.replace(/\n/g, '\n  ')}\n`);

    const verdictM = res.text.match(/^VERDICT:[ \t]*([^\n]+)/m);
    const instM = res.text.match(/^INSTRUCTION:[ \t]*([^\n]*)/m);
    const targetIdx = res.text.indexOf('TARGET:');
    const target = targetIdx >= 0 ? res.text.slice(targetIdx + 'TARGET:'.length).trim() : '';

    console.log(`  parsed verdict:     ${verdictM?.[1].trim()}`);
    console.log(`  parsed instruction: ${instM?.[1].trim()}`);
    console.log(`  parsed target len:  ${target.length} chars`);
    console.log(`  parsed target tail: ...${target.slice(-60)}`);

    // The bug: instruction matches the OLD trigger and target is the NEW one (or empty).
    const oldInstruction = (instM?.[1].trim() ?? '').toLowerCase().includes('add emojis');
    const targetIsNewInstruction = target.toLowerCase().trim().startsWith('remove emojis')
      && target.length < 50;

    if (oldInstruction && targetIsNewInstruction) {
      console.log(`\n${RED}${BOLD}✗ EXTRACT bug REPRODUCED — pulled the OLD instruction, dropped the body.${RESET}`);
    } else if (oldInstruction || target.length < 100) {
      console.log(`\n${RED}${BOLD}✗ EXTRACT misbehaved (instruction or target wrong) — partial repro.${RESET}`);
    } else {
      console.log(`\n${GREEN}${BOLD}\x1b[32m●\x1b[0m EXTRACT handled the contaminated input correctly. Bug must be elsewhere.${RESET}`);
    }
  });
}

main().catch(err => { console.error(err); process.exit(1); });
