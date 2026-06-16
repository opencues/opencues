/**
 * End-to-end probe for the integration pass — exercises the full chain
 * built in PR6: integration-pass module + dispatchChat + cerebras
 * provider + validator + cache.
 *
 * Drives the *core* `runIntegrationPass` against a real `dispatchChat`
 * with the canonical scenarios from `identity-dehydration-plan.md`:
 *
 *   - stocks $254.00 in whole-dollar prose → expect $254
 *   - stocks $254.00 in spreadsheet prose  → expect verbatim
 *   - weather "14°C, overcast" in tweet     → expect tighter form
 *   - HN headline with upvote count + email prose → expect headline only
 *   - apple-position email referencing AAPL → expect polished mention
 *   - hallucination probe: prompt model to invent a number → expect REJECT
 *
 * Output: per-scenario row showing input → polished + reason + latency.
 *
 * Run:
 *   OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss \
 *     npx tsx tests/benchmarks/integration-pass/e2e-probe.ts
 */

// Direct relative import — benches live outside the package boundary so
// the workspace alias '@opencues/core' isn't resolvable here. Mirrors
// the identity-order bench's pattern (it inlines the prompt/catalog
// constants rather than importing from core).
import {
  makeIntegrationCache,
  runIntegrationPass,
  type IntegrationDispatch,
} from '../../../packages/opencues-core/src/integration-pass';
import { chat, sysUser, MODEL } from '../fluid-blank/groq';

interface Scenario {
  id: string;
  substituted: string;
  contextBefore: string;
  contextAfter: string;
  hint?: string;
  expect:
    | { kind: 'polished'; preview: string }
    | { kind: 'verbatim' }
    | { kind: 'rejected'; reason: string };
}

const SCENARIOS: Scenario[] = [
  {
    id: 'stock-whole-dollars',
    substituted: '$254.00',
    contextBefore: 'AAPL closed at $200 today. NVIDIA opened at ',
    contextAfter: ' and rallied into the afternoon.',
    hint: 'stock price — match prose currency conventions',
    expect: { kind: 'polished', preview: '$254' },
  },
  {
    id: 'stock-spreadsheet',
    substituted: '$254.00',
    contextBefore: 'Holdings ledger:\n- AAPL: $200.00\n- NVIDIA: ',
    contextAfter: '\n- TSLA: $192.34',
    hint: 'stock price — match prose currency conventions',
    expect: { kind: 'verbatim' },
  },
  {
    id: 'weather-tweet',
    substituted: '14°C, overcast',
    contextBefore: 'Morning run, ',
    contextAfter: ' — perfect mileage weather ☁️ #marathon',
    hint: 'weather snapshot — tweet-tight when surrounding prose is casual',
    expect: { kind: 'polished', preview: '14°' },
  },
  {
    id: 'hn-headline-drop-upvotes',
    substituted: 'Show HN: I built a thing in Rust (412 points)',
    contextBefore: 'Hi team,\n\nQuick share — today\'s top story is "',
    contextAfter: '". Thought it might inspire next sprint.',
    hint: 'top story title — drop upvote counts in prose',
    expect: { kind: 'polished', preview: 'Show HN: I built a thing in Rust' },
  },
  {
    id: 'apple-position-mention',
    substituted: 'NVDA: $254.00',
    contextBefore: 'Team,\n\nReviewing the portfolio, I recommend we trim our NVIDIA exposure given the recent rally to ',
    contextAfter: '. The valuation looks stretched relative to next-quarter guidance.',
    hint: 'current quote — trim labels already supplied by the surrounding prose',
    expect: { kind: 'polished', preview: '$254' },
  },
  {
    id: 'short-skip',
    // Below SUBSTITUTE_MIN_CHARS (4) — should skip without an LLM call.
    substituted: '$5',
    contextBefore: 'AAPL traded at ',
    contextAfter: ' for most of the morning.',
    expect: { kind: 'rejected', reason: 'skipped-short' },
  },
];

const dispatch: IntegrationDispatch = async (system, user) => {
  const r = await chat(
    sysUser(system, user),
    { temperature: 0, seed: 42, maxTokens: 128 },
  );
  return r.text;
};

async function main() {
  console.log(`\nintegration-pass e2e probe — provider=${MODEL}\n`);
  console.log(`scenario                         expected         result         reason                  latencyMs  preview`);
  console.log('─'.repeat(110));

  const cache = makeIntegrationCache();
  let passed = 0;
  let total = 0;
  for (const s of SCENARIOS) {
    total++;
    const t0 = Date.now();
    const result = await runIntegrationPass(
      {
        substituted: s.substituted,
        contextBefore: s.contextBefore,
        contextAfter: s.contextAfter,
        hint: s.hint,
      },
      dispatch,
      cache,
    );
    const latency = Date.now() - t0;

    // Pass/fail logic per expectation kind.
    let outcome: 'PASS' | 'FAIL';
    if (s.expect.kind === 'rejected') {
      outcome = result.reason === s.expect.reason ? 'PASS' : 'FAIL';
    } else if (s.expect.kind === 'verbatim') {
      outcome = result.polished === s.substituted ? 'PASS' : 'FAIL';
    } else {
      // 'polished': must equal/contain the expected preview AND be
      // different from input.
      outcome = result.accepted && result.polished.includes(s.expect.preview)
        ? 'PASS' : 'FAIL';
    }
    if (outcome === 'PASS') passed++;

    const preview = result.polished.length > 50
      ? result.polished.slice(0, 50) + '…'
      : result.polished;
    console.log(
      `${s.id.padEnd(33)}${(s.expect.kind).padEnd(17)}${outcome.padEnd(15)}${result.reason.padEnd(24)}${String(latency).padEnd(11)}${preview}`,
    );
  }

  console.log('─'.repeat(110));
  console.log(`\n${passed}/${total} scenarios pass.\n`);
  if (passed !== total) process.exit(1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
