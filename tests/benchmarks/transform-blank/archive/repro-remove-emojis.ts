/**
 * Standalone reproduction of the "remove emojis" TransformBlank bug.
 *
 * Hypothesis: when EXTRACT receives a long body + a trailing
 * "remove emojis _" instruction, the LLM either:
 *   (a) drops the body from TARGET and echoes the instruction text, OR
 *   (b) bleeds a stale instruction from a similar previous request
 *       (provider-level prompt cache contamination).
 *
 * This script calls Groq directly with the real P1_EXTRACT_SYSTEM prompt
 * (imported from the source) and the exact INPUT shape TransformBlank
 * would build. It runs a few variants:
 *
 *   1. Baseline: long body + "remove emojis _" — expect INSTRUCTION =
 *      "remove emojis", TARGET ≈ <full body>.
 *   2. Same call repeated 3× — sanity-check determinism.
 *   3. Same call after a different instruction ("add emojis where
 *      appropriate _") — looks for cross-request bleed.
 *   4. Short body (~50 chars) — control: is the bug specific to long
 *      bodies, or universal?
 *
 * Run:
 *   GROQ_API_KEY=... npx tsx tests/benchmarks/transform-blank/repro-remove-emojis.ts
 */

import { chat } from './groq';
import { P1_EXTRACT_SYSTEM, P2_APPLY_SYSTEM } from '../../../packages/opencues-core/src/sources/transform-blank-source';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

const LONG_BODY_NO_EMOJI = `Karen,

I am writing to formally resign from my position, effective two weeks from today.

I have concluded that the company's direction and leadership no longer align with my professional values and standards.

Over the past several months, I have observed limited opportunities for growth and meaningful contribution, which have been replaced by decisions that negatively affect employee morale and the integrity of our work.

This environment has left me feeling increasingly disillusioned and unappreciated, making it impossible for me to continue giving my best.

I hope my departure encourages reflection and positive change within the organization.

I will do everything possible during my remaining time to ensure a smooth transition of my responsibilities.

Sincerely,
Wilfred`;

const LONG_BODY_WITH_EMOJI = `Karen, ✉️

I am writing to formally resign from my position, effective two weeks from today. ⏳

I have concluded that the company's direction and leadership no longer align with my professional values and standards. 🚫

Over the past several months, I have observed limited opportunities for growth and meaningful contribution, which have been replaced by decisions that negatively affect employee morale and the integrity of our work. 📉

This environment has left me feeling increasingly disillusioned and unappreciated, making it impossible for me to continue giving my best. 😞

I hope my departure encourages reflection and positive change within the organization. 🔄

I will do everything possible during my remaining time to ensure a smooth transition of my responsibilities. 🤝

Sincerely, 🙏
Wilfred`;

const SHORT_BODY = `the boy ran fast`;

interface CaseSpec {
  name: string;
  body: string;
  instruction: string;
  expectInstructionContains: string;
  expectTargetContains: string;
}

const CASES: CaseSpec[] = [
  {
    name: '1. baseline: long body with emojis + "remove emojis _"',
    body: LONG_BODY_WITH_EMOJI,
    instruction: 'remove emojis',
    expectInstructionContains: 'remove emoji',
    expectTargetContains: 'Karen',
  },
  {
    name: '2. control: short body + "uppercase _"',
    body: SHORT_BODY,
    instruction: 'uppercase',
    expectInstructionContains: 'uppercase',
    expectTargetContains: 'boy ran fast',
  },
  {
    name: '3. long body NO emojis + "remove emojis _" (still expects body in TARGET)',
    body: LONG_BODY_NO_EMOJI,
    instruction: 'remove emojis',
    expectInstructionContains: 'remove emoji',
    expectTargetContains: 'Karen',
  },
];

interface Parsed {
  verdict?: string;
  instruction?: string;
  target?: string;
}

function parseExtract(raw: string): Parsed {
  const out: Parsed = {};
  const v = raw.match(/^VERDICT:[ \t]*([^\n]+)/m);
  if (v) out.verdict = v[1].trim();
  const i = raw.match(/^INSTRUCTION:[ \t]*([^\n]*)/m);
  if (i) out.instruction = i[1].trim();
  // TARGET is the LAST field — split on it and take everything after.
  // The previous regex bailed at end-of-line because of the /m flag.
  const idx = raw.indexOf('TARGET:');
  if (idx >= 0) out.target = raw.slice(idx + 'TARGET:'.length).trim();
  return out;
}

function budgetForOutput(expectedChars: number): number {
  // Mirror transform-blank-source.ts's runtime budget so the test
  // calls EXTRACT with the exact same max_tokens the chrome path uses.
  return Math.max(768, Math.min(4096, Math.ceil(expectedChars / 3) + 400));
}

async function runOne(c: CaseSpec, attempt: number): Promise<boolean> {
  const input = `${c.body}\n\n${c.instruction} _`;
  const result = await chat([
    { role: 'system', content: P1_EXTRACT_SYSTEM },
    { role: 'user', content: `INPUT: ${input}` },
  ], { temperature: 0, maxTokens: budgetForOutput(input.length) });

  const parsed = parseExtract(result.text);

  console.log(`${BOLD}${c.name} — attempt ${attempt}${RESET}`);
  console.log(`${DIM}  INPUT length:${RESET} ${input.length} chars`);
  console.log(`${DIM}  raw response (first 400 chars):${RESET}`);
  console.log(`    ${result.text.slice(0, 400).replace(/\n/g, '\n    ')}`);
  if (result.text.length > 400) console.log(`    ... (${result.text.length} total chars)`);
  console.log(`${DIM}  parsed:${RESET}`);
  console.log(`    verdict:     ${parsed.verdict ?? '(missing)'}`);
  console.log(`    instruction: ${parsed.instruction ?? '(missing)'}`);
  console.log(`    target:      ${(parsed.target ?? '').slice(0, 80)}${(parsed.target ?? '').length > 80 ? '…' : ''}`);
  console.log(`    target len:  ${(parsed.target ?? '').length} chars`);

  let pass = true;
  const checks: string[] = [];
  if (parsed.verdict !== 'TRANSFORM') {
    checks.push(`${RED}✗ verdict expected TRANSFORM, got ${parsed.verdict}${RESET}`);
    pass = false;
  } else {
    checks.push(`${GREEN}✓ verdict=TRANSFORM${RESET}`);
  }
  if (!(parsed.instruction ?? '').toLowerCase().includes(c.expectInstructionContains.toLowerCase())) {
    checks.push(`${RED}✗ instruction missing "${c.expectInstructionContains}" — got "${parsed.instruction}"${RESET}`);
    pass = false;
  } else {
    checks.push(`${GREEN}✓ instruction contains "${c.expectInstructionContains}"${RESET}`);
  }
  if (!(parsed.target ?? '').includes(c.expectTargetContains)) {
    checks.push(`${RED}✗ target missing "${c.expectTargetContains}" — got TARGET length ${(parsed.target ?? '').length}${RESET}`);
    pass = false;
  } else {
    checks.push(`${GREEN}✓ target contains "${c.expectTargetContains}"${RESET}`);
  }
  // Sanity check: INSTRUCTION should appear in INPUT.
  if (parsed.instruction && !input.toLowerCase().includes(parsed.instruction.toLowerCase())) {
    checks.push(`${YELLOW}! parser-guard would fire: INSTRUCTION not a substring of INPUT (suspect cache bleed or hallucination)${RESET}`);
  }
  for (const c of checks) console.log(`    ${c}`);
  console.log(`  ${pass ? GREEN + 'PASS' : RED + 'FAIL'}${RESET} — latency ${result.latencyMs}ms`);
  console.log('');
  return pass;
}

async function main(): Promise<void> {
  console.log(`${BOLD}TransformBlank EXTRACT — standalone repro${RESET}`);
  console.log(`${DIM}Probing whether the LLM puts the editor body into TARGET vs dropping it.${RESET}\n`);

  let totalPass = 0;
  let totalRun = 0;

  // Bump to 8 attempts per case — cache-bleed flakes might be 1-in-N.
  for (const c of CASES) {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const ok = await runOne(c, attempt);
      totalRun++;
      if (ok) totalPass++;
    }
  }

  // Cross-request bleed check: run the "add emojis" instruction first,
  // then immediately the "remove emojis" instruction with the same body
  // shape. Looks for INSTRUCTION leakage from the prior request.
  console.log(`${BOLD}4. cross-request bleed check (add → remove emojis, repeated 5×)${RESET}`);
  for (let pair = 1; pair <= 5; pair++) {
    await runOne({
      name: `   pair ${pair} — priming: "add emojis where appropriate _"`,
      body: LONG_BODY_NO_EMOJI,
      instruction: 'add emojis where appropriate',
      expectInstructionContains: 'add emoji',
      expectTargetContains: 'Karen',
    }, 1);
    totalRun++;
    const bleedOk = await runOne({
      name: `   pair ${pair} — immediate follow-up: "remove emojis _"`,
      body: LONG_BODY_WITH_EMOJI,
      instruction: 'remove emojis',
      expectInstructionContains: 'remove emoji',
      expectTargetContains: 'Karen',
    }, 1);
    totalRun++;
    if (bleedOk) totalPass++;
  }

  console.log(`${BOLD}Summary:${RESET} ${totalPass}/${totalRun} passed`);

  // Avoid unused-import lint warning on P2_APPLY_SYSTEM in case we add
  // an APPLY-side check later.
  void P2_APPLY_SYSTEM;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
