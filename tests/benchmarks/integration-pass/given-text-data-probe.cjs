/**
 * Probe — the "given the text and this new data, how should the data
 * be integrated" framing. Cases drawn from user-reported scenarios
 * where polish previously didn't fire (no sentinel resolved, no
 * format-hint in surrounding prose).
 */

const path = require('path');
const cwd = path.resolve(__dirname, '..', '..', '..');
const { buildBlankIntegrationRunner } = require(path.join(cwd, 'packages/opencues-runtime/dist/src/boot-common'));

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
});

const cases = [
  {
    id: 'bare-large-integer-conversational',
    substituted: '67000000',
    contextBefore: 'Quick fact, the population of france is around ',
    contextAfter: ' people.',
    hint: 'fluid-blank LLM answer — fit naturally',
    expectNotEqual: '67000000',
    expectShape: /(67[\s,]?[\d.,]*(?:M|million|m)\b|67,000,000)/i,
  },
  {
    id: 'bare-large-integer-technical',
    substituted: '67000000',
    contextBefore: 'POP_FR: ',
    contextAfter: ' rows in table',
    hint: 'fluid-blank LLM answer',
    expectShape: /67(,?000,?000|0{6}|\.0M|M)/i,
  },
  {
    id: 'short-answer-no-polish-needed',
    substituted: 'Paris',
    contextBefore: 'The capital of france is ',
    contextAfter: '.',
    hint: 'fluid-blank LLM answer',
    expectEqual: 'Paris',
  },
  {
    id: 'single-digit-stays-single-digit',
    substituted: '8',
    contextBefore: 'The atomic number of oxygen is ',
    contextAfter: '.',
    hint: 'fluid-blank LLM answer',
    expectEqual: '8',
  },
  {
    id: 'stocks-conversational-truncate',
    substituted: 'NVDA: $212.45',
    contextBefore: 'Hi team, AAPL is at $200, NVDA is at ',
    contextAfter: '. Thoughts?',
    hint: 'stock price — fit surrounding prose',
    expectNotMatch: /NVDA:/,
    expectShape: /\$212/,
  },
];

async function main() {
  const runner = buildBlankIntegrationRunner(stubConfigLoader, getApiKeys, () => {});
  if (!runner) { console.error('runner null'); process.exit(1); }

  let passed = 0;
  console.log('\ngiven-text-data probe (cerebras gpt-oss-120b)\n');
  for (const c of cases) {
    const t0 = Date.now();
    const r = await runner({
      substituted: c.substituted,
      contextBefore: c.contextBefore,
      contextAfter: c.contextAfter,
      hint: c.hint,
    });
    const ms = Date.now() - t0;

    let ok = true;
    const failures = [];
    if (c.expectEqual !== undefined && r.polished !== c.expectEqual) {
      ok = false;
      failures.push(`expected "${c.expectEqual}", got "${r.polished}"`);
    }
    if (c.expectNotEqual !== undefined && r.polished === c.expectNotEqual) {
      ok = false;
      failures.push(`expected change from "${c.expectNotEqual}", but unchanged`);
    }
    if (c.expectShape && !c.expectShape.test(r.polished)) {
      ok = false;
      failures.push(`expected to match ${c.expectShape}, got "${r.polished}"`);
    }
    if (c.expectNotMatch && c.expectNotMatch.test(r.polished)) {
      ok = false;
      failures.push(`expected NOT to match ${c.expectNotMatch}, got "${r.polished}"`);
    }
    if (ok) passed++;
    const mark = ok ? '✓' : '✗';
    console.log(`${mark} [${c.id}] ${ms}ms reason=${r.reason}`);
    console.log(`    in:  "${c.substituted}"`);
    console.log(`    out: "${r.polished}"`);
    if (!ok) for (const f of failures) console.log(`    !! ${f}`);
    console.log();
  }
  console.log(`${passed}/${cases.length} cases polished correctly.`);
  process.exit(passed === cases.length ? 0 : 1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
