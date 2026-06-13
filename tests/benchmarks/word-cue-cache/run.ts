// Latency micro-bench for the word-cue result cache.
//
// Measures wall-clock of RoutedWordSourceGroup.getCues() with a stub
// source simulating realistic LLM latency. Compares:
//   - cold call (cache miss → "LLM" round-trip)
//   - warm call (cache hit → no round-trip)
//
// Doesn't call any real LLM. The win is structural: zero LLM call
// when the sub-context text is unchanged from a recent dispatch.
//
// Run:
//   npx tsx tests/benchmarks/word-cue-cache/run.ts

import { RoutedWordSourceGroup } from '../../../packages/opencues-core/dist/sources/routed-word-source-group';
import type { CueContext, CueSourceResult } from '../../../packages/opencues-core/dist/types';
import type { SourceConfig } from '../../../packages/opencues-core/dist/cues-md';

const SIMULATED_LLM_MS = 280;  // Matches production spelling-source dispatch

class SimulatedSpellingSource {
  readonly id = 'spelling';
  readonly priority = 10;
  readonly sourceConfig: SourceConfig;
  callCount = 0;

  constructor() {
    this.sourceConfig = {
      name: 'spelling',
      promptText: 'p',
      priority: 10,
      parser: 'alternatives',
      scope: 'words',
      match: '.*',
    };
  }

  supports() { return true; }

  async getCues(_context: CueContext): Promise<CueSourceResult> {
    this.callCount++;
    await new Promise(resolve => setTimeout(resolve, SIMULATED_LLM_MS));
    return { results: [], timing: SIMULATED_LLM_MS };
  }
}

function mkContext(words: string[]): CueContext {
  return { text: words.join(' '), words };
}

async function measure(label: string, fn: () => Promise<void>): Promise<number> {
  const t0 = performance.now();
  await fn();
  const elapsed = performance.now() - t0;
  console.log(`  ${label.padEnd(50)} ${elapsed.toFixed(1)}ms`);
  return elapsed;
}

async function main(): Promise<void> {
  console.log('word-cue cache latency micro-bench');
  console.log(`  simulated spelling-source LLM: ${SIMULATED_LLM_MS}ms\n`);

  const RUNS = 5;
  const cold: number[] = [];
  const warm: number[] = [];

  for (let i = 0; i < RUNS; i++) {
    const source = new SimulatedSpellingSource();
    const group = new RoutedWordSourceGroup({ sources: [source as any] });
    const buf = `cat sat on the mat ${i}`.split(' ');

    const t1 = await measure(`run ${i + 1} cold (first call)`, async () => {
      await group.getCues(mkContext(buf));
    });
    cold.push(t1);

    const t2 = await measure(`run ${i + 1} warm (identical buffer)`, async () => {
      await group.getCues(mkContext(buf));
    });
    warm.push(t2);

    if (source.callCount !== 1) {
      console.error(`  WARN: expected 1 source call, saw ${source.callCount}`);
    }
    console.log('');
  }

  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const coldMed = median(cold);
  const warmMed = median(warm);

  console.log('─'.repeat(60));
  console.log(`cold median: ${coldMed.toFixed(1)}ms`);
  console.log(`warm median: ${warmMed.toFixed(1)}ms`);
  console.log(`saved:       ${(coldMed - warmMed).toFixed(1)}ms  (${(((coldMed - warmMed) / coldMed) * 100).toFixed(1)}%)`);
  console.log('─'.repeat(60));
}

main().catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
