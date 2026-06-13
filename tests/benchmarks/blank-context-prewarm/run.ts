// Latency micro-bench for the BlankContextCache pre-warm timer.
//
// This bench does NOT call any LLM — pre-warm only affects WHEN the
// cache snapshot is computed, never the snapshot's content. So a
// real LLM bench (tests/benchmarks/blank-context-recall/) is the
// quality gate; this bench measures the runtime-layer latency win.
//
// Methodology:
//   - Stand up a fake Blank with a configurable simulated-HTTP delay
//     (per-call latency, matching real Finnhub/OpenWeather/CoinGecko
//     budgets).
//   - Build the provider with prewarm ON (35s default — the bench
//     can't wait 35s, so we just wait for the immediate-fire tick).
//   - Build a second provider with prewarm OFF (legacy lazy path).
//   - Measure the wall-clock of the FIRST provider() invocation in
//     each — that's what the user pays when they type `_`.
//
// Expected result: prewarm-ON's first call returns within ms (cache
// already populated by the immediate tick), prewarm-OFF's first call
// waits for the simulated HTTP fan-out.
//
// Run:
//   npx tsx tests/benchmarks/blank-context-prewarm/run.ts

import { buildBlankContextProvider } from '../../../packages/opencues-runtime/dist/src/boot-common';
import type { Blank } from '../../../packages/opencues-runtime/dist/src/blanks/types';

const SIMULATED_FETCH_MS = 200;          // Realistic single-source HTTP cost
const N_SOURCES = 10;                    // Match production catalog size

class DelayedBlank implements Blank {
  readonly readOnly = true;
  calls = 0;
  constructor(public readonly name: string, private readonly delayMs: number) {}
  async get(_slot?: string): Promise<string> {
    this.calls++;
    await new Promise(resolve => setTimeout(resolve, this.delayMs));
    return `value-${this.calls}`;
  }
}

interface FakeConfig {
  blankContextMode: 'off' | 'safe' | 'raw';
  prewarmMs: string;
}

function makeFakeConfigLoader(args: FakeConfig, blanks: Map<string, DelayedBlank>): unknown {
  const settings = new Map<string, string>();
  settings.set('blank-context-prewarm-ms', args.prewarmMs);
  return {
    opencuesState: {
      blankContextMode: args.blankContextMode,
      settings,
    },
    identity: { fields: [], catalog: new Map() },
    mergedBlanksConfig: {
      blanks: Object.fromEntries(
        Array.from(blanks.keys()).map((name, idx) => [
          name,
          {
            name,
            asContext: 'safe',
            contextSlots: [`SLOT-${idx}`],
            contextTtl: 60,
          },
        ]),
      ),
    },
  };
}

function makeBlanks(count: number, delayMs: number): Map<string, DelayedBlank> {
  const m = new Map<string, DelayedBlank>();
  for (let i = 0; i < count; i++) {
    m.set(`blank-${i}`, new DelayedBlank(`blank-${i}`, delayMs));
  }
  return m;
}

async function measureFirstCall(prewarmMs: string): Promise<{ firstCallMs: number; blankCalls: number }> {
  const blanks = makeBlanks(N_SOURCES, SIMULATED_FETCH_MS);
  const configLoader = makeFakeConfigLoader(
    { blankContextMode: 'safe', prewarmMs },
    blanks,
  );
  const provider = buildBlankContextProvider(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    configLoader as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    blanks as any,
    () => {},
  );
  if (!provider) throw new Error('provider was undefined');

  // For 'on' (prewarm) — wait for the immediate-fire tick to populate
  // the cache. Worst case it takes (slowest fetch) ≈ SIMULATED_FETCH_MS
  // because Promise.all parallelises. Add buffer.
  if (prewarmMs !== 'off') {
    await new Promise(resolve => setTimeout(resolve, SIMULATED_FETCH_MS + 50));
  }

  const callsBeforeUser = Array.from(blanks.values()).reduce((s, b) => s + b.calls, 0);

  // Now the user types `_` — measure THIS call's wall-clock.
  const t0 = performance.now();
  await provider();
  const firstCallMs = performance.now() - t0;

  const callsAfterUser = Array.from(blanks.values()).reduce((s, b) => s + b.calls, 0);

  provider.stop?.();
  return { firstCallMs, blankCalls: callsAfterUser - callsBeforeUser };
}

async function main(): Promise<void> {
  const RUNS = 5;

  console.log('blank-context-prewarm latency micro-bench');
  console.log(`  catalog size: ${N_SOURCES} sources`);
  console.log(`  per-source simulated HTTP: ${SIMULATED_FETCH_MS}ms`);
  console.log(`  runs per variant: ${RUNS}\n`);

  const baselineRuns: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const { firstCallMs, blankCalls } = await measureFirstCall('off');
    baselineRuns.push(firstCallMs);
    console.log(`  baseline (prewarm off) run ${i + 1}: ${firstCallMs.toFixed(1)}ms  (blank.get calls: ${blankCalls})`);
  }

  console.log('');
  const prewarmRuns: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const { firstCallMs, blankCalls } = await measureFirstCall('35000');
    prewarmRuns.push(firstCallMs);
    console.log(`  prewarm-on (35000ms)  run ${i + 1}: ${firstCallMs.toFixed(1)}ms  (blank.get calls: ${blankCalls})`);
  }

  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const baselineMedian = median(baselineRuns);
  const prewarmMedian = median(prewarmRuns);
  const delta = baselineMedian - prewarmMedian;

  console.log('\n' + '─'.repeat(60));
  console.log(`baseline median: ${baselineMedian.toFixed(1)}ms`);
  console.log(`prewarm  median: ${prewarmMedian.toFixed(1)}ms`);
  console.log(`saved:           ${delta.toFixed(1)}ms  (${((delta / baselineMedian) * 100).toFixed(1)}%)`);
  console.log('─'.repeat(60));
}

main().catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
