/**
 * Smoke test for the boot-wiring of the integration runner. Exercises
 * the EXACT path BlankFill follows in a live host session:
 *
 *   1. boot-common.buildBlankIntegrationRunner(configLoader, getApiKeys, log)
 *      → returns the IntegrationPassRunner
 *   2. runner(request) → resolves blanks-bucket provider → dispatches
 *      via core.dispatchChat → polishes via core.runIntegrationPass
 *   3. Returns { polished, llmCalled, accepted, reason }
 *
 * Uses a minimal stub configLoader (mirrors what the real ConfigLoader
 * exposes — only the surfaces the runner reads). All other host
 * machinery is skipped — this is a pure wiring + dispatch test.
 *
 * Run:
 *   CEREBRAS_API_KEY=... node tests/benchmarks/integration-pass/boot-smoke.cjs
 */

const path = require('path');
const cwd = path.resolve(__dirname, '..', '..', '..');
const { buildBlankIntegrationRunner } = require(path.join(cwd, 'packages/opencues-runtime/dist/src/boot-common'));

// Minimal stub configLoader — only the fields buildBlankIntegrationRunner
// reaches into. Matches the shape returned by ConfigLoader.opencuesState.
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

// API-key getter — what the host's secrets layer supplies. The runner
// re-reads on every dispatch so a mid-session key swap propagates.
const getApiKeys = () => ({
  CEREBRAS_API_KEY: process.env.CEREBRAS_API_KEY,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
});

const logs = [];
const log = (level, msg, data) => {
  logs.push({ level, msg, data });
  console.log(`[${level}] ${msg}${data ? ' ' + JSON.stringify(data).slice(0, 80) : ''}`);
};

async function main() {
  console.log('boot-smoke: building runner via buildBlankIntegrationRunner');
  const runner = buildBlankIntegrationRunner(stubConfigLoader, getApiKeys, log);
  if (!runner) {
    console.error('FATAL: buildBlankIntegrationRunner returned null — @opencues/core not require()-able OR no provider resolved');
    process.exit(1);
  }
  console.log('boot-smoke: runner built successfully');

  // Realistic stocks-shaped request — same shape BlankFill produces in
  // applyAsyncFill: substituted is the raw blank output, contexts are
  // ±300 chars from the splice point, hint comes from BLANK.md.
  // Drop-the-upvote-count scenario: polish should strip "(412 points)".
  const request = {
    substituted: 'Show HN: I built a Rust thing (412 points)',
    contextBefore: 'Hi team,\n\nQuick share — today\'s top story is "',
    contextAfter: '". Thought it might inspire next sprint.',
    hint: 'top story title — drop upvote counts in conversational prose',
  };
  console.log(`\nboot-smoke: dispatching with substituted="${request.substituted}"`);

  const t0 = Date.now();
  const result = await runner(request);
  const latencyMs = Date.now() - t0;

  console.log(`\nboot-smoke: result:`);
  console.log(`  polished:  "${result.polished}"`);
  console.log(`  reason:    ${result.reason}`);
  console.log(`  accepted:  ${result.accepted}`);
  console.log(`  llmCalled: ${result.llmCalled}`);
  console.log(`  latency:   ${latencyMs}ms`);

  if (result.reason === 'polished' || result.reason === 'verbatim-from-llm') {
    console.log('\n✓ boot-wiring works end-to-end — runner dispatches via cerebras, polish lands.');
    process.exit(0);
  } else if (result.reason === 'rejected-dispatch-error') {
    console.error('\n✗ Dispatch failed — check that CEREBRAS_API_KEY is set and the bucket resolves.');
    process.exit(1);
  } else {
    console.error(`\n✗ Unexpected reason: ${result.reason}`);
    process.exit(1);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
