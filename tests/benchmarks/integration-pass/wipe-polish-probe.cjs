/**
 * Probe — WIPE-mode polish with post-wipe context (June 2026 refinement).
 *
 *   case 1 — whole-input wipe: user typed "whats nvida stock price _",
 *     entire buffer wipes, substitute lands standalone. Polish should
 *     clean it (drop redundant label since no prose names the entity
 *     either) OR keep it (model's call) — but it should at least RUN
 *     instead of being short-circuited.
 *
 *   case 2 — partial wipe: user typed "Hi, AAPL $200, NVDA is at _",
 *     lookup phrase "NVDA is at" wipes, prose "Hi, AAPL $200," survives.
 *     The surviving prose does NOT name NVDA — polish should KEEP
 *     "NVDA:" prefix because dropping it would orphan the value.
 */

const path = require('path');
const cwd = path.resolve(__dirname, '..', '..', '..');
const { runIntegrationPass, makeIntegrationCache } = require(path.join(cwd, 'packages/opencues-core/dist/integration-pass'));
const { dispatchChat, resolveLLM, getProvider } = require(path.join(cwd, 'packages/opencues-core/dist/index'));

const apiKey = process.env.CEREBRAS_API_KEY;
const provider = getProvider('cerebras');

const dispatch = async (system, user) => {
  const out = await dispatchChat(
    provider,
    {
      post: async (url, body, headers) => {
        const res = await fetch(url, {
          method: 'POST',
          body: typeof body === 'string' ? body : new Uint8Array(body),
          headers,
        });
        return res.text();
      },
    },
    {
      model: 'gpt-oss-120b',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      maxTokens: 128,
      temperature: 0,
      seed: 42,
    },
    { apiKey, endpoint: undefined, maxThinking: false },
  );
  return out;
};

const cases = [
  {
    id: 'wipe-whole-input',
    // "whats nvida stock price _" — whole buffer wipes; substitute alone.
    substituted: 'NVDA: $212.45',
    contextBefore: '',
    contextAfter: '',
    hint: 'fluid-blank LLM answer with catalog sentinel; contextBefore/After is post-wipe (empty when whole input wiped)',
  },
  {
    id: 'wipe-partial-prose-survives',
    // "Hi team, AAPL is at $200, NVDA is at _" — wipe range is
    // "NVDA is at _", surviving prose is "Hi team, AAPL is at $200, "
    substituted: 'NVDA: $212.45',
    contextBefore: 'Hi team, AAPL is at $200, ',
    contextAfter: '',
    hint: 'fluid-blank LLM answer with catalog sentinel; contextBefore/After is post-wipe',
  },
];

async function main() {
  const cache = makeIntegrationCache();
  let passed = 0;
  console.log('\nwipe-polish probe (cerebras gpt-oss-120b)\n');
  for (const c of cases) {
    const t0 = Date.now();
    const r = await runIntegrationPass(
      { substituted: c.substituted, contextBefore: c.contextBefore, contextAfter: c.contextAfter, hint: c.hint },
      dispatch,
      cache,
    );
    const ms = Date.now() - t0;
    const ran = r.llmCalled;
    const mark = ran ? '✓' : '✗';
    if (ran) passed++;
    console.log(`${mark} [${c.id}] ${ms}ms reason=${r.reason} llmCalled=${ran}`);
    console.log(`    contextBefore: "${c.contextBefore}"`);
    console.log(`    substituted:   "${c.substituted}"`);
    console.log(`    polished:      "${r.polished}"`);
    console.log();
  }
  console.log(`${passed}/${cases.length} cases ran the LLM polish.`);
  process.exit(passed === cases.length ? 0 : 1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
