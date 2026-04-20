#!/usr/bin/env node
/**
 * Benchmark: Tips Lookup Performance
 *
 * Compares O(n×m) linear scan vs O(1) hash map lookup
 */

const cues = require(process.env.HOME + '/.claude/node_modules/cues-core');
const fs = require('fs');

// Load tips data
const tipsPath = process.env.HOME + '/.claude/claude-code-tips.json';
const tipsContent = fs.readFileSync(tipsPath, 'utf8');
const tipsData = cues.parseLocalCueFile(tipsContent);

console.log(`Tips file: ${tipsData.length} sections`);

// Count total entries
let totalEntries = 0;
for (const sec of tipsData) {
  if (sec.groups) totalEntries += sec.groups.length;
  if (sec.words) totalEntries += Object.keys(sec.words).length;
}
console.log(`Total entries: ${totalEntries}`);

// Build hash map (what we do at startup)
const startBuild = performance.now();
const tipsMap = new Map();
for (const sec of tipsData) {
  if (sec.groups) {
    for (const grp of sec.groups) {
      const alts = [grp.synonyms[0], ...(grp.alts || [])];
      const result = { word: grp.synonyms[0], tip: grp.tip, alternatives: alts, source: 'tips' };
      for (const syn of grp.synonyms) {
        tipsMap.set(syn.toLowerCase(), result);
      }
    }
  }
  if (sec.words) {
    for (const [key, entry] of Object.entries(sec.words)) {
      const alts = [key, ...(entry.alts || [])];
      tipsMap.set(key.toLowerCase(), { word: key, tip: entry.tip, alternatives: alts, source: 'tips' });
    }
  }
}
const buildTime = performance.now() - startBuild;
console.log(`Map build time: ${buildTime.toFixed(3)}ms (${tipsMap.size} keys)`);
console.log('');

// Test words (mix of tips and non-tips)
const tipsWords = ['ultrathink', 'agents', 'swarm', '/compact', '/clear', 'background'];
const nonTipsWords = ['the', 'quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog'];
const mixedWords = [...tipsWords, ...nonTipsWords];

// Generate test inputs of various lengths
const testCases = [
  { name: '5 words (tips only)', words: tipsWords.slice(0, 5) },
  { name: '10 words (mixed)', words: mixedWords.slice(0, 10) },
  { name: '20 words (mixed)', words: [...mixedWords, ...mixedWords].slice(0, 20) },
  { name: '50 words (mixed)', words: Array(5).fill(mixedWords).flat().slice(0, 50) },
  { name: '100 words (mixed)', words: Array(10).fill(mixedWords).flat().slice(0, 100) },
];

const ITERATIONS = 10000;

console.log(`Benchmarking ${ITERATIONS} iterations each:\n`);
console.log('| Test Case | O(n×m) Linear | O(1) Hash Map | Speedup |');
console.log('|-----------|---------------|---------------|---------|');

for (const tc of testCases) {
  // Benchmark O(n×m) linear scan (old approach)
  const startLinear = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    for (const word of tc.words) {
      cues.lookupWord(word, tipsData);
    }
  }
  const linearTime = performance.now() - startLinear;
  const linearPerCall = (linearTime / ITERATIONS).toFixed(4);

  // Benchmark O(1) hash map (new approach)
  const startHash = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    for (const word of tc.words) {
      tipsMap.get(word.toLowerCase());
    }
  }
  const hashTime = performance.now() - startHash;
  const hashPerCall = (hashTime / ITERATIONS).toFixed(4);

  const speedup = (linearTime / hashTime).toFixed(1);

  console.log(`| ${tc.name.padEnd(20)} | ${linearPerCall.padStart(10)}ms | ${hashPerCall.padStart(10)}ms | ${speedup.padStart(6)}x |`);
}

console.log('');
console.log('Per-call times shown (divide by word count for per-word time)');
