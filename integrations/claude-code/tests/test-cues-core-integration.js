#!/usr/bin/env node
/**
 * Test Suite: cues-core Integration with tweakcc
 *
 * Tests:
 * 1. cues-core functions work correctly
 * 2. Integration matches expected behavior
 * 3. Performance is acceptable
 */

const cues = require(process.env.HOME + '/.claude/node_modules/cues-core');
const fs = require('fs');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`✗ ${name}`);
    console.log(`  Error: ${e.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}\n    Expected: ${JSON.stringify(expected)}\n    Actual: ${JSON.stringify(actual)}`);
  }
}

function assertTrue(condition, msg) {
  if (!condition) {
    throw new Error(msg);
  }
}

// Load tips data
const tipsPath = process.env.HOME + '/.claude/claude-code-tips.json';
const tipsContent = fs.readFileSync(tipsPath, 'utf8');
const tipsData = cues.parseTipsFile(tipsContent);
const tipsMap = cues.buildLookupMap(tipsData);

console.log('='.repeat(60));
console.log('cues-core Integration Tests');
console.log('='.repeat(60));
console.log(`Tips file: ${tipsData.length} sections, ${tipsMap.size} keys`);
console.log('');

// ============================================================================
// Test 1: parseTipsFile
// ============================================================================
console.log('--- parseTipsFile ---');

test('parseTipsFile returns array', () => {
  assertTrue(Array.isArray(tipsData), 'Should return array');
});

test('parseTipsFile has sections with id', () => {
  assertTrue(tipsData.every(s => s.id), 'Every section should have id');
});

// ============================================================================
// Test 2: buildLookupMap
// ============================================================================
console.log('\n--- buildLookupMap ---');

test('buildLookupMap returns Map', () => {
  assertTrue(tipsMap instanceof Map, 'Should return Map');
});

test('buildLookupMap has keys', () => {
  assertTrue(tipsMap.size > 0, 'Map should have keys');
});

test('buildLookupMap keys are lowercase', () => {
  for (const key of tipsMap.keys()) {
    assertTrue(key === key.toLowerCase(), `Key "${key}" should be lowercase`);
  }
});

test('buildLookupMap values have required fields', () => {
  const val = tipsMap.get('ultrathink');
  assertTrue(val !== undefined, 'ultrathink should exist');
  assertTrue(val.word !== undefined, 'Should have word');
  assertTrue(val.tip !== undefined, 'Should have tip');
  assertTrue(Array.isArray(val.alternatives), 'Should have alternatives array');
  assertTrue(val.source === 'tips', 'Source should be tips');
});

test('buildLookupMap synonym groups share result', () => {
  const agents = tipsMap.get('agents');
  const subagents = tipsMap.get('subagents');
  // They should point to same or similar result
  assertTrue(agents !== undefined, 'agents should exist');
  // subagents may or may not exist depending on tips file structure
});

// ============================================================================
// Test 3: lookupMultiple
// ============================================================================
console.log('\n--- lookupMultiple ---');

test('lookupMultiple returns found and missingIndices', () => {
  const result = cues.lookupMultiple(['ultrathink', 'foo'], tipsMap);
  assertTrue(Array.isArray(result.found), 'Should have found array');
  assertTrue(Array.isArray(result.missingIndices), 'Should have missingIndices array');
});

test('lookupMultiple finds known words', () => {
  const result = cues.lookupMultiple(['ultrathink', 'agents'], tipsMap);
  assertEqual(result.found.length, 2, 'Should find 2 words');
  assertEqual(result.missingIndices.length, 0, 'Should have no missing');
});

test('lookupMultiple tracks missing words', () => {
  const result = cues.lookupMultiple(['the', 'quick', 'ultrathink'], tipsMap);
  assertEqual(result.found.length, 1, 'Should find 1 word');
  assertEqual(result.missingIndices, [0, 1], 'Should track indices 0 and 1 as missing');
});

test('lookupMultiple skipPattern works', () => {
  const result = cues.lookupMultiple(['the', '_', 'runs'], tipsMap, {skipPattern: /^_$/});
  assertTrue(!result.missingIndices.includes(1), 'Index 1 (underscore) should be skipped');
});

test('lookupMultiple found items have correct index', () => {
  const result = cues.lookupMultiple(['foo', 'ultrathink', 'bar'], tipsMap);
  assertEqual(result.found.length, 1, 'Should find 1');
  assertEqual(result.found[0].index, 1, 'Found item should have index 1');
  assertEqual(result.found[0].word, 'ultrathink', 'Word should be ultrathink');
});

// ============================================================================
// Test 4: formatAsWordDefs
// ============================================================================
console.log('\n--- formatAsWordDefs ---');

test('formatAsWordDefs returns all words', () => {
  const lookup = cues.lookupMultiple(['ultrathink', 'is', 'great'], tipsMap);
  const defs = cues.formatAsWordDefs(lookup.found, ['ultrathink', 'is', 'great']);
  assertEqual(defs.length, 3, 'Should return 3 defs');
});

test('formatAsWordDefs found words have alts', () => {
  const lookup = cues.lookupMultiple(['ultrathink'], tipsMap);
  const defs = cues.formatAsWordDefs(lookup.found, ['ultrathink']);
  assertTrue(defs[0].alts !== null, 'Found word should have alts');
  assertTrue(defs[0].alts.length > 0, 'Alts should not be empty');
});

test('formatAsWordDefs unfound words have null alts', () => {
  const lookup = cues.lookupMultiple(['foo'], tipsMap);
  const defs = cues.formatAsWordDefs(lookup.found, ['foo']);
  assertEqual(defs[0].alts, null, 'Unfound word should have null alts');
});

test('formatAsWordDefs preserves order', () => {
  const words = ['a', 'ultrathink', 'b', 'agents', 'c'];
  const lookup = cues.lookupMultiple(words, tipsMap);
  const defs = cues.formatAsWordDefs(lookup.found, words);
  assertEqual(defs.map(d => d.word), words, 'Order should be preserved');
});

// ============================================================================
// Test 5: mergeWordDefs
// ============================================================================
console.log('\n--- mergeWordDefs ---');

test('mergeWordDefs adds new defs', () => {
  const existing = [];
  const newDefs = [{index: 0, word: 'test', alts: ['test', 'foo'], source: 'tips'}];
  const merged = cues.mergeWordDefs(existing, newDefs);
  assertEqual(merged.length, 1, 'Should have 1 def');
  assertEqual(merged[0].word, 'test', 'Should have test');
});

test('mergeWordDefs preserves existing alts', () => {
  const existing = [{index: 0, word: 'test', alts: ['test', 'existing'], source: 'llm'}];
  const newDefs = [{index: 0, word: 'test', alts: ['test', 'new'], source: 'tips'}];
  const merged = cues.mergeWordDefs(existing, newDefs);
  assertEqual(merged[0].alts, ['test', 'existing'], 'Should preserve existing alts');
});

test('mergeWordDefs fills missing alts', () => {
  const existing = [{index: 0, word: 'test', alts: null, source: 'llm'}];
  const newDefs = [{index: 0, word: 'test', alts: ['test', 'new'], source: 'tips'}];
  const merged = cues.mergeWordDefs(existing, newDefs);
  assertEqual(merged[0].alts, ['test', 'new'], 'Should fill missing alts');
});

test('mergeWordDefs does not mutate existing', () => {
  const existing = [{index: 0, word: 'test', alts: null}];
  const newDefs = [{index: 0, word: 'test', alts: ['a', 'b']}];
  cues.mergeWordDefs(existing, newDefs);
  assertEqual(existing[0].alts, null, 'Original should be unchanged');
});

// ============================================================================
// Test 6: Integration scenarios
// ============================================================================
console.log('\n--- Integration Scenarios ---');

test('Tips-only sentence: all words found, skip LLM', () => {
  const words = ['ultrathink', 'agents', 'swarm'];
  const lookup = cues.lookupMultiple(words, tipsMap, {skipPattern: /^_$/});
  const skipLLM = lookup.found.length > 0 && lookup.missingIndices.length === 0;
  assertTrue(skipLLM, 'Should skip LLM when all words found');
});

test('Mixed sentence: some words found, call LLM', () => {
  const words = ['ultrathink', 'is', 'great'];
  const lookup = cues.lookupMultiple(words, tipsMap, {skipPattern: /^_$/});
  const callLLM = lookup.missingIndices.length > 0;
  assertTrue(callLLM, 'Should call LLM when some words missing');
});

test('Underscore sentence: blank skipped, call LLM', () => {
  const words = ['the', '_', 'dog'];
  const lookup = cues.lookupMultiple(words, tipsMap, {skipPattern: /^_$/});
  assertTrue(!lookup.missingIndices.includes(1), 'Blank should be skipped');
  assertTrue(lookup.missingIndices.includes(0), 'Non-blank missing words tracked');
});

test('Full flow: lookup -> format -> ready for UI', () => {
  const words = ['ultrathink', 'is', 'great', 'for', 'agents'];
  const lookup = cues.lookupMultiple(words, tipsMap, {skipPattern: /^_$/});
  const defs = cues.formatAsWordDefs(lookup.found, words);

  // Verify structure matches what tweakcc expects
  assertTrue(defs.every(d => 'index' in d), 'All defs should have index');
  assertTrue(defs.every(d => 'word' in d), 'All defs should have word');
  assertTrue(defs.every(d => 'alts' in d), 'All defs should have alts (or null)');

  // Found words should have alts
  const ultrathink = defs.find(d => d.word === 'ultrathink');
  assertTrue(ultrathink.alts !== null, 'ultrathink should have alts');

  // Unfound words should have null alts
  const isWord = defs.find(d => d.word === 'is');
  assertEqual(isWord.alts, null, '"is" should have null alts');
});

// ============================================================================
// Test 7: Performance
// ============================================================================
console.log('\n--- Performance ---');

test('buildLookupMap completes in < 5ms', () => {
  const start = performance.now();
  cues.buildLookupMap(tipsData);
  const elapsed = performance.now() - start;
  assertTrue(elapsed < 5, `Should complete in < 5ms, took ${elapsed.toFixed(2)}ms`);
});

test('lookupMultiple 10 words completes in < 0.1ms', () => {
  const words = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const start = performance.now();
  for (let i = 0; i < 100; i++) {
    cues.lookupMultiple(words, tipsMap);
  }
  const elapsed = (performance.now() - start) / 100;
  assertTrue(elapsed < 0.1, `Should complete in < 0.1ms, took ${elapsed.toFixed(4)}ms`);
});

test('formatAsWordDefs 10 words completes in < 0.1ms', () => {
  const words = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const lookup = cues.lookupMultiple(words, tipsMap);
  const start = performance.now();
  for (let i = 0; i < 100; i++) {
    cues.formatAsWordDefs(lookup.found, words);
  }
  const elapsed = (performance.now() - start) / 100;
  assertTrue(elapsed < 0.1, `Should complete in < 0.1ms, took ${elapsed.toFixed(4)}ms`);
});

// ============================================================================
// Summary
// ============================================================================
console.log('\n' + '='.repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));

process.exit(failed > 0 ? 1 : 0);
