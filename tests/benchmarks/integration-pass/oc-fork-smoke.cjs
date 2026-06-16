/**
 * Smoke test for the integration runner using the SHIPPED bundle inside
 * ~/opencode-cues — same path opencode's boot loads at startup. Verifies:
 *
 *   1. ~/opencode-cues/node_modules/@opencues/runtime/dist/src/boot-common
 *      loads cleanly under Bun (opencode's runtime).
 *   2. `buildBlankIntegrationRunner` resolves the cerebras provider via
 *      the shipped @opencues/core's resolveLLM + dispatchChat.
 *   3. End-to-end polish round-trips against real cerebras.
 *
 * This is stronger than tests/benchmarks/integration-pass/boot-smoke.cjs
 * (which loads from the local source tree). If THIS passes, an opencode
 * launch will pick up the wiring identically.
 *
 * Run:
 *   CEREBRAS_API_KEY=... bun tests/benchmarks/integration-pass/oc-fork-smoke.cjs
 */

const path = require('path');
const os = require('os');
const fork = path.join(os.homedir(), 'opencode-cues');
const bootPath = path.join(fork, 'node_modules', '@opencues', 'runtime', 'dist', 'src', 'boot-common.js');

console.log(`oc-fork-smoke: loading from ${bootPath}`);
const { buildBlankIntegrationRunner } = require(bootPath);

// Minimal stub configLoader — same shape as boot-smoke.cjs.
const stubConfigLoader = {
  opencuesState: {
    settings: new Map(),
    blanksLlmProvider: 'cerebras',
  },
};
stubConfigLoader.opencuesState.settings.get = key => stubConfigLoader.opencuesState.settings.get.map?.[key];
stubConfigLoader.opencuesState.settings.get.map = {
  'llm-provider': 'cerebras',
  'llm-model': 'gpt-oss-120b',
  'blanks-llm-model': 'gpt-oss-120b',
};

const getApiKeys = () => ({
  CEREBRAS_API_KEY: process.env.CEREBRAS_API_KEY,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
});

const logs = [];
const log = (level, msg, data) => {
  logs.push({ level, msg });
  console.log(`[${level}] ${msg}`);
};

async function probe(label, request) {
  console.log(`\noc-fork-smoke: [${label}] substituted="${request.substituted}"`);
  const t0 = Date.now();
  const result = await runner(request);
  const ms = Date.now() - t0;
  console.log(`  polished:  "${result.polished}"`);
  console.log(`  reason:    ${result.reason}  accepted=${result.accepted}  llmCalled=${result.llmCalled}  ${ms}ms`);
  return result;
}

let runner;

async function main() {
  console.log('oc-fork-smoke: building runner from shipped bundle');
  runner = buildBlankIntegrationRunner(stubConfigLoader, getApiKeys, log);
  if (!runner) {
    console.error('FATAL: runner is null — shipped bundle missing pieces or no provider resolved');
    process.exit(1);
  }
  console.log(`oc-fork-smoke: runner built (Bun=${typeof Bun !== 'undefined'})`);

  // 1) Whole-dollar prose — polish path.
  const r1 = await probe('whole-dollar-polish', {
    substituted: '$254.23',
    contextBefore: 'Hi team — quick check. AAPL is at $200 and NVDA at ',
    contextAfter: '. Looking healthy.',
    hint: 'stock price — match prose currency conventions',
  });

  // 2) HN headline with upvote count — should drop.
  const r2 = await probe('hn-drop-upvotes', {
    substituted: 'Show HN: I built a Rust thing (412 points)',
    contextBefore: 'Hi team,\n\nQuick share — today\'s top story is "',
    contextAfter: '". Thought it might inspire next sprint.',
    hint: 'top story title — drop upvote counts in conversational prose',
  });

  // 3) Short value — should skip without LLM call.
  const r3 = await probe('short-skip', {
    substituted: '$5',
    contextBefore: 'AAPL at ',
    contextAfter: ' today.',
  });

  // 4) Cache hit — repeat r1, should return in <5ms.
  const r4 = await probe('cache-hit', {
    substituted: '$254.23',
    contextBefore: 'Hi team — quick check. AAPL is at $200 and NVDA at ',
    contextAfter: '. Looking healthy.',
    hint: 'stock price — match prose currency conventions',
  });

  // Verify outcomes.
  const errors = [];
  if (!r1.accepted) errors.push(`r1: expected accepted=true, got ${r1.accepted} (${r1.reason})`);
  if (r2.reason !== 'polished') errors.push(`r2: expected polished, got ${r2.reason}`);
  if (r3.reason !== 'skipped-short') errors.push(`r3: expected skipped-short, got ${r3.reason}`);
  if (r4.reason !== 'cache-hit') errors.push(`r4: expected cache-hit, got ${r4.reason}`);

  if (errors.length > 0) {
    console.error('\n✗ oc-fork-smoke FAIL:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('\n✓ oc-fork-smoke: shipped bundle in ~/opencode-cues works end-to-end.');
  console.log(`✓ all 4 probes pass under ${typeof Bun !== 'undefined' ? 'Bun' : 'Node'}.`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
