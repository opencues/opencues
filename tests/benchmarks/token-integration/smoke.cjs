/**
 * PR1 smoke — exercise the token-integration runner end-to-end against
 * cerebras with cases drawn from the user's reported workflow.
 *
 * Cases mix the two intent shapes the regex used to confuse:
 *   - sentence-with-slot: "NVDA is at _" → expect REPLACE = "_"
 *   - lookup question: "whats nvda stock price _" → expect REPLACE = whole input
 *   - conversational continuation: "Tell me about NVDA — _"
 *   - labelled prose: "Hi team, AAPL is at $200, NVDA: _"
 */

const path = require('path');
const cwd = path.resolve(__dirname, '..', '..', '..');
const { buildBlankTokenIntegrationRunner } = require(path.join(cwd, 'packages/opencues-runtime/dist/src/boot-common'));

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
const getApiKeys = () => ({ CEREBRAS_API_KEY: process.env.CEREBRAS_API_KEY });
const log = () => {};

const cases = [
  {
    id: 'fill-mode-is-at',
    buffer: 'nvda is at _',
    substitute: 'NVDA: $212.45',
    hint: 'fluid-blank LLM answer with catalog sentinel',
    expect: { replaceShouldBe: '_', withShouldContain: '$212' },
  },
  {
    id: 'lookup-mode-whats',
    buffer: 'whats nvda stock price _',
    substitute: 'NVDA: $212.45',
    hint: 'fluid-blank LLM answer with catalog sentinel',
    expect: { replaceShouldBe: 'whats nvda stock price _', withShouldContain: '$212' },
  },
  {
    id: 'labelled-prose-drop-redundant',
    buffer: 'Hi team, AAPL is at $200, NVDA: _',
    substitute: 'NVDA: $212.45',
    hint: 'fluid-blank LLM answer with catalog sentinel',
    expect: { replaceShouldBe: '_', withShouldNotContain: 'NVDA:' },
  },
  {
    id: 'conversational-continuation',
    buffer: 'Tell me about NVDA — _',
    substitute: 'NVDA: $212.45',
    hint: 'fluid-blank LLM answer with catalog sentinel',
    expect: { replaceShouldBe: '_', withMinLen: 5 },
  },
];

function applyResult(buffer, result) {
  return buffer.replace(result.replace, result.with_);
}

async function main() {
  const runner = buildBlankTokenIntegrationRunner(stubConfigLoader, getApiKeys, log);
  if (!runner) {
    console.error('runner null'); process.exit(1);
  }

  let passed = 0;
  console.log('\nPR1 token-integration smoke (cerebras gpt-oss-120b)\n');
  for (const c of cases) {
    const t0 = Date.now();
    const r = await runner({ buffer: c.buffer, substitute: c.substitute, hint: c.hint });
    const ms = Date.now() - t0;
    const finalBuffer = applyResult(c.buffer, r);
    let ok = true;
    const failures = [];
    if (c.expect.replaceShouldBe !== undefined && r.replace !== c.expect.replaceShouldBe) {
      ok = false;
      failures.push(`expected REPLACE="${c.expect.replaceShouldBe}", got "${r.replace}"`);
    }
    if (c.expect.withShouldContain && !r.with_.includes(c.expect.withShouldContain)) {
      ok = false;
      failures.push(`WITH "${r.with_}" missing "${c.expect.withShouldContain}"`);
    }
    if (c.expect.withShouldNotContain && r.with_.includes(c.expect.withShouldNotContain)) {
      ok = false;
      failures.push(`WITH "${r.with_}" should not contain "${c.expect.withShouldNotContain}"`);
    }
    if (c.expect.withMinLen && r.with_.length < c.expect.withMinLen) {
      ok = false;
      failures.push(`WITH too short: "${r.with_}"`);
    }
    if (ok) passed++;
    console.log(`${ok ? '✓' : '✗'} [${c.id}] ${ms}ms reason=${r.reason}`);
    console.log(`    buffer: "${c.buffer}"`);
    console.log(`    sub:    "${c.substitute}"`);
    console.log(`    REPLACE="${r.replace}"  WITH="${r.with_}"`);
    console.log(`    final:  "${finalBuffer}"`);
    if (!ok) for (const f of failures) console.log(`    !! ${f}`);
    console.log();
  }
  console.log(`${passed}/${cases.length} cases passed.`);
  process.exit(passed === cases.length ? 0 : 1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
