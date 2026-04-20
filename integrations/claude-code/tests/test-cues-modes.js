#!/usr/bin/env node
/**
 * Test Suite: cues-core exports
 *
 * Verifies the public API of cues-core.
 */

const cues = require(process.env.HOME + '/.claude/node_modules/cues-core');

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

function assertTrue(condition, msg) {
  if (!condition) throw new Error(msg);
}

console.log('='.repeat(60));
console.log('cues-core Export Tests');
console.log('='.repeat(60));
console.log('');

// ============================================================================
// ConfigSource API
// ============================================================================
console.log('--- ConfigSource API ---');

test('ConfigSource is exported', () => {
  assertTrue(typeof cues.ConfigSource === 'function', 'Should be a constructor');
});

test('ClassifiedSourceGroup is exported', () => {
  assertTrue(typeof cues.ClassifiedSourceGroup === 'function', 'Should be a constructor');
});

test('buildSourcesFromConfig is exported', () => {
  assertTrue(typeof cues.buildSourcesFromConfig === 'function', 'Should be a function');
});

// ============================================================================
// Parsers
// ============================================================================
console.log('\n--- Parsers ---');

test('parseCompute is exported', () => {
  assertTrue(typeof cues.parseCompute === 'function', 'Should be a function');
  assertTrue(cues.parseCompute('COMPUTE=4*12')[0] === '48', 'Should compute 48');
});

test('parseAnswer is exported', () => {
  assertTrue(typeof cues.parseAnswer === 'function', 'Should be a function');
  assertTrue(cues.parseAnswer('ANSWER=Paris')[0] === 'Paris', 'Should extract Paris');
});

test('parseAlternatives is exported', () => {
  assertTrue(typeof cues.parseAlternatives === 'function', 'Should be a function');
});

test('parseRaw is exported', () => {
  assertTrue(typeof cues.parseRaw === 'function', 'Should be a function');
});

// ============================================================================
// Resolver
// ============================================================================
console.log('\n--- Resolver ---');

test('CueResolver is exported', () => {
  assertTrue(typeof cues.CueResolver === 'function', 'Should be a constructor');
});

test('createResolver is exported', () => {
  assertTrue(typeof cues.createResolver === 'function', 'Should be a function');
});

// ============================================================================
// Local tips
// ============================================================================
console.log('\n--- Local Tips ---');

test('LocalCueSource is exported', () => {
  assertTrue(typeof cues.LocalCueSource === 'function', 'Should be a constructor');
});

test('buildLookupMap is exported', () => {
  assertTrue(typeof cues.buildLookupMap === 'function', 'Should be a function');
});

test('lookupMultiple is exported', () => {
  assertTrue(typeof cues.lookupMultiple === 'function', 'Should be a function');
});

test('formatAsWordDefs is exported', () => {
  assertTrue(typeof cues.formatAsWordDefs === 'function', 'Should be a function');
});

// ============================================================================
// Config parser
// ============================================================================
console.log('\n--- Config Parser ---');

test('parseCuesMd is exported', () => {
  assertTrue(typeof cues.parseCuesMd === 'function', 'Should be a function');
});

test('validateCuesMd is exported', () => {
  assertTrue(typeof cues.validateCuesMd === 'function', 'Should be a function');
});

// ============================================================================
// Summary
// ============================================================================
console.log('\n' + '='.repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));

process.exit(failed > 0 ? 1 : 0);
