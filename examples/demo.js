/**
 * Cues System Demo (CommonJS)
 *
 * Run with: node examples/demo.js
 */

const {
  CueResolver,
  LocalCueSource,
} = require('../packages/cues-core/dist/index.js');

// Sample tips data (normally loaded from file)
const sampleCueData = [
  {
    id: 'extended-thinking',
    words: {
      ultrathink: {
        tip: 'Add "ultrathink" to prompt for maximum reasoning depth',
        alts: ['Tab', 'deep thinking', 'extended thinking'],
      },
      Tab: {
        tip: 'Press Tab to toggle extended thinking mode',
        alts: ['ultrathink', 'deep thinking'],
      },
    },
  },
  {
    id: 'parallel-execution',
    groups: [
      {
        synonyms: ['agents', 'sub-agents', 'subagents', 'parallel agents'],
        tip: 'Spawn parallel workers via Task tool - faster for multi-file ops',
        alts: ['swarm', 'background'],
      },
      {
        synonyms: ['swarm', 'team'],
        tip: 'Multiple coordinated agents working on related tasks',
        alts: ['agents', 'background'],
      },
      {
        synonyms: ['background', 'Ctrl+B'],
        tip: 'Press Ctrl+B to send running agent to background',
        alts: ['agents', 'swarm'],
      },
    ],
  },
];

async function main() {
  console.log('=== Cues System Demo ===\n');

  // Create a tips source
  const localCueSource = new LocalCueSource(sampleCueData, {
    id: 'demo-tips',
    priority: 100,
  });

  // Create the resolver
  const resolver = new CueResolver([localCueSource]);

  // Test input
  const text = 'I want to use ultrathink with parallel agents for this task';
  const words = text.split(/\s+/);

  console.log(`Input: "${text}"\n`);
  console.log('Words:', words);
  console.log('');

  // Resolve cues
  const result = await resolver.resolve({ text, words });

  console.log('=== Results ===\n');
  console.log(`Total time: ${result.totalTime}ms`);
  console.log(`Errors: ${result.errors.length}`);
  console.log('');

  for (const metric of result.metrics) {
    console.log(`Source "${metric.sourceId}": ${metric.latencyMs}ms, ${metric.resultCount} results`);
  }
  console.log('');

  console.log('=== Cues Found ===\n');
  for (const cue of result.results) {
    console.log(`Word "${cue.word}" at index ${cue.wordIndex}:`);
    console.log(`  Tip: ${cue.cueTip}`);
    console.log(`  Alternatives: ${cue.alternatives.join(', ')}`);
    console.log(`  Source: ${cue.source}`);
    if (cue.altCueTips) {
      console.log('  Per-alt tips:');
      for (const [alt, tip] of Object.entries(cue.altCueTips)) {
        console.log(`    "${alt}": ${tip.substring(0, 50)}...`);
      }
    }
    console.log('');
  }
}

main().catch(console.error);
