/**
 * Probe — verify the polish prompt now drops redundant labels naturally
 * across diverse blank shapes (not just numeric/currency). Runs the
 * actual scenarios the user tested in opencode, hitting real cerebras.
 *
 * Inputs taken verbatim from the user's session log so the probe and
 * the live session would agree on what polish should do.
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
  GROQ_API_KEY: process.env.GROQ_API_KEY,
});

const log = () => {};

const cases = [
  {
    id: 'weather-bare',
    substituted: 'weather London 17°C Overcast',
    contextBefore: '',
    contextAfter: '',
    hint: 'weather snapshot — drop the keyword + city when prose does not supply them',
    expect: /17°/,
    expectNot: /weather London /,
  },
  {
    id: 'capital-of-france',
    substituted: 'France capital: Paris',
    contextBefore: 'The ',
    contextAfter: '.',
    hint: 'country fact — drop the leading "France capital:" prefix when prose already names the country',
    expect: /Paris/,
    expectNot: /France capital/,
  },
  {
    id: 'population-of-france',
    substituted: 'France population: 67.4M',
    contextBefore: 'Quick fact, the population of france is ',
    contextAfter: ' people.',
    hint: 'country fact — drop the leading "France population:" prefix',
    expect: /67\.4M/,
    expectNot: /France population/,
  },
  {
    id: 'define-eunomia',
    substituted: 'eunomia: not found',
    contextBefore: 'The word eunomia — ',
    contextAfter: ' in this dictionary.',
    hint: 'dictionary entry — drop the word prefix when the word is in the prose',
    expect: /not found/,
    expectNot: /eunomia:/,
  },
  {
    id: 'hn-bare',
    substituted: 'A backdoor in a LinkedIn job offer (412 points)',
    contextBefore: "Today's top story is \"",
    contextAfter: '". Thought you might enjoy.',
    hint: 'HN headline — drop trailing point counts in conversational prose',
    expect: /backdoor in a LinkedIn job offer/,
    expectNot: /\(412 points\)/,
  },
  {
    id: 'stocks-conversational-truncate',
    substituted: 'NVDA: $212.45',
    contextBefore: 'Hi team, AAPL is at $200, NVDA is at ',
    contextAfter: '. Thoughts?',
    hint: 'stock price — fit surrounding prose; drop ticker prefix if redundant',
    expect: /\$212/,
    expectNot: /NVDA:/,
  },
];

async function main() {
  const runner = buildBlankIntegrationRunner(stubConfigLoader, getApiKeys, log);
  if (!runner) {
    console.error('runner failed to build');
    process.exit(1);
  }

  let passed = 0;
  console.log('\nfit-naturally probe (cerebras gpt-oss-120b)\n');
  for (const c of cases) {
    const t0 = Date.now();
    const r = await runner({
      substituted: c.substituted,
      contextBefore: c.contextBefore,
      contextAfter: c.contextAfter,
      hint: c.hint,
    });
    const ms = Date.now() - t0;
    const okPositive = c.expect.test(r.polished);
    const okNegative = !c.expectNot || !c.expectNot.test(r.polished);
    const ok = okPositive && okNegative;
    if (ok) passed++;
    const mark = ok ? '✓' : '✗';
    console.log(`${mark} [${c.id}] ${ms}ms  reason=${r.reason}`);
    console.log(`    substituted:  "${c.substituted}"`);
    console.log(`    polished:     "${r.polished}"`);
    if (!ok) {
      if (!okPositive) console.log(`    !! expected match: ${c.expect}`);
      if (!okNegative) console.log(`    !! should NOT contain: ${c.expectNot}`);
    }
    console.log();
  }
  console.log(`${passed}/${cases.length} cases polished correctly.`);
  process.exit(passed === cases.length ? 0 : 1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
