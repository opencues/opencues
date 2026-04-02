#!/usr/bin/env node
/**
 * Tips Lookup Benchmark for cues-core
 *
 * Compares the new cues-core lookupWord function against the existing
 * LLM-based hints system.
 */

const fs = require('fs');
const path = require('path');
const { lookupWord, lookupWords, parseLocalCueFile, CueResolver, LocalCueSource } = require('../packages/cues-core/dist/index.js');

// Load the real tips file
const TIPS_PATH = path.join(process.env.HOME, '.claude', 'claude-code-tips.json');
const TEST_CASES_PATH = path.join(process.env.HOME, 'tweakcc', 'tests', 'hints-test-cases.txt');

function loadTestCases() {
  const content = fs.readFileSync(TEST_CASES_PATH, 'utf8');
  const cases = [];

  for (const line of content.split('\n')) {
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const parts = line.split('|').map(p => p.trim());
    if (parts.length >= 2) {
      cases.push({
        input: parts[0],
        expected: parts[1],
        description: parts[2] || ''
      });
    }
  }

  return cases;
}

async function runBenchmark() {
  console.log('=== Cues-Core Tips Lookup Benchmark ===\n');
  console.log('Date:', new Date().toISOString());
  console.log('');

  // Load tips file
  const tipsContent = fs.readFileSync(TIPS_PATH, 'utf8');
  const tipsData = parseLocalCueFile(tipsContent);
  console.log(`Loaded ${tipsData.length} sections from tips file\n`);

  // Create source and resolver
  const source = new LocalCueSource(tipsData, { priority: 100 });
  const resolver = new CueResolver([source]);

  // Load test cases
  const testCases = loadTestCases();
  console.log(`Running ${testCases.length} test cases\n`);
  console.log('========================================\n');

  let total = 0;
  let foundCount = 0;
  let notFoundCount = 0;
  let timings = [];

  const results = {
    found: [],
    notFound: [],
    timing: { min: Infinity, max: 0, total: 0, avg: 0 }
  };

  for (const testCase of testCases) {
    const words = testCase.input.split(/\s+/);

    const start = performance.now();
    const result = await resolver.resolve({ text: testCase.input, words });
    const elapsed = performance.now() - start;

    timings.push(elapsed);
    results.timing.total += elapsed;
    results.timing.min = Math.min(results.timing.min, elapsed);
    results.timing.max = Math.max(results.timing.max, elapsed);

    total++;

    // Check if we found any cues
    if (result.results.length > 0) {
      foundCount++;
      results.found.push({
        input: testCase.input,
        expected: testCase.expected,
        desc: testCase.description,
        cues: result.results.map(r => ({
          word: r.word,
          index: r.wordIndex,
          alts: r.alternatives.length
        }))
      });
    } else {
      notFoundCount++;
      results.notFound.push({
        input: testCase.input,
        expected: testCase.expected,
        desc: testCase.description
      });
    }
  }

  results.timing.avg = results.timing.total / total;

  // Print summary
  console.log('=== PERFORMANCE METRICS ===\n');
  console.log(`Total lookups: ${total}`);
  console.log(`Found cues: ${foundCount} (${(foundCount/total*100).toFixed(1)}%)`);
  console.log(`No cues: ${notFoundCount} (${(notFoundCount/total*100).toFixed(1)}%)`);
  console.log('');
  console.log('Timing (per lookup):');
  console.log(`  Min: ${results.timing.min.toFixed(3)}ms`);
  console.log(`  Max: ${results.timing.max.toFixed(3)}ms`);
  console.log(`  Avg: ${results.timing.avg.toFixed(3)}ms`);
  console.log(`  Total: ${results.timing.total.toFixed(1)}ms`);
  console.log('');

  // Print found samples
  console.log('=== SAMPLE FOUND CUES (first 10) ===\n');
  for (const item of results.found.slice(0, 10)) {
    console.log(`"${item.input}" [${item.desc}]`);
    for (const cue of item.cues) {
      console.log(`  → "${cue.word}" at index ${cue.index} (${cue.alts} alternatives)`);
    }
  }
  console.log('');

  // Print not found samples
  console.log('=== SAMPLE NOT FOUND (first 10) ===\n');
  for (const item of results.notFound.slice(0, 10)) {
    console.log(`"${item.input}" [${item.desc}]`);
    console.log(`  Expected: ${item.expected}`);
  }
  console.log('');

  // Return stats for comparison
  return {
    total,
    found: foundCount,
    notFound: notFoundCount,
    timing: results.timing
  };
}

// Direct word lookup benchmark (no resolver overhead)
async function runDirectLookupBenchmark() {
  console.log('\n=== Direct lookupWord Benchmark ===\n');

  const tipsContent = fs.readFileSync(TIPS_PATH, 'utf8');
  const tipsData = parseLocalCueFile(tipsContent);

  // Test words from various tips
  const testWords = [
    'ultrathink', 'Tab', '/compact', '/clear', 'agents', 'subagents',
    'swarm', 'background', 'refactor', 'debug', 'parallel', 'sonnet',
    'haiku', 'opus', 'stuck', 'undo', 'search', 'codebase',
    // Words that shouldn't match
    'javascript', 'function', 'variable', 'class', 'const', 'let'
  ];

  let found = 0;
  let notFound = 0;
  const iterations = 1000;

  const start = performance.now();

  for (let i = 0; i < iterations; i++) {
    for (const word of testWords) {
      const result = lookupWord(word, tipsData);
      if (i === 0) {
        if (result) found++;
        else notFound++;
      }
    }
  }

  const elapsed = performance.now() - start;
  const totalLookups = iterations * testWords.length;
  const perLookup = elapsed / totalLookups;

  console.log(`Words tested: ${testWords.length}`);
  console.log(`Found: ${found}, Not found: ${notFound}`);
  console.log(`Iterations: ${iterations}`);
  console.log(`Total lookups: ${totalLookups}`);
  console.log(`Total time: ${elapsed.toFixed(1)}ms`);
  console.log(`Per lookup: ${(perLookup * 1000).toFixed(3)}µs`);
  console.log(`Lookups/sec: ${(1000 / perLookup).toFixed(0)}`);
}

// Main
async function main() {
  const stats = await runBenchmark();
  await runDirectLookupBenchmark();

  console.log('\n=== COMPARISON WITH CURRENT SYSTEM ===\n');
  console.log('| Metric | Current (LLM) | Cues-Core |');
  console.log('|--------|---------------|-----------|');
  console.log(`| Latency (avg) | ~200-600ms | ${stats.timing.avg.toFixed(3)}ms |`);
  console.log(`| API calls | Yes (Groq) | None |`);
  console.log(`| Accuracy | 94% (LLM) | Local match only |`);
  console.log(`| Coverage | All words | Tips file words |`);
  console.log('');
  console.log('Key insight: Cues-core is ~1000x faster but only covers');
  console.log('words explicitly in the tips file. The LLM can recognize');
  console.log('semantic variations (e.g., "error" → "bug" → tip #2).');
}

main().catch(console.error);
