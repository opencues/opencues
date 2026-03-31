#!/usr/bin/env node
/**
 * Test Suite: cues-core Modes (GRAMMAR, MATH, FACTUAL)
 *
 * Tests the new source modules and classifier.
 */

const cues = require('/home/wilfred/.claude/node_modules/cues-core');

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

console.log('='.repeat(60));
console.log('cues-core Modes Tests');
console.log('='.repeat(60));
console.log('');

// ============================================================================
// Test 1: Prompts are exported
// ============================================================================
console.log('--- Prompts ---');

test('CLASSIFIER_PROMPT is exported', () => {
  assertTrue(typeof cues.CLASSIFIER_PROMPT === 'string', 'Should be string');
  assertTrue(cues.CLASSIFIER_PROMPT.includes('MODE=MATH'), 'Should mention MATH');
});

test('MATH_PROMPT is exported', () => {
  assertTrue(typeof cues.MATH_PROMPT === 'string', 'Should be string');
  assertTrue(cues.MATH_PROMPT.includes('COMPUTE='), 'Should mention COMPUTE');
});

test('FACTUAL_PROMPT is exported', () => {
  assertTrue(typeof cues.FACTUAL_PROMPT === 'string', 'Should be string');
  assertTrue(cues.FACTUAL_PROMPT.includes('ANSWER='), 'Should mention ANSWER');
});

test('GRAMMAR_PROMPT is exported', () => {
  assertTrue(typeof cues.GRAMMAR_PROMPT === 'string', 'Should be string');
  assertTrue(cues.GRAMMAR_PROMPT.includes('synonym'), 'Should mention synonym');
});

test('BLANK_GRAMMAR_PROMPT is exported', () => {
  assertTrue(typeof cues.BLANK_GRAMMAR_PROMPT === 'string', 'Should be string');
  assertTrue(cues.BLANK_GRAMMAR_PROMPT.includes('blank'), 'Should mention blank');
});

// ============================================================================
// Test 2: Heuristic functions
// ============================================================================
console.log('\n--- Heuristics ---');

test('looksLikeMath detects math expressions', () => {
  assertTrue(cues.looksLikeMath('4 + 5 = _'), '4 + 5 = _ should be math');
  assertTrue(cues.looksLikeMath('half of 16'), 'half of 16 should be math');
  assertTrue(cues.looksLikeMath('50% of 200'), '50% of 200 should be math');
  assertTrue(cues.looksLikeMath('square root of 144'), 'square root should be math');
  assertTrue(!cues.looksLikeMath('The dog ran'), 'The dog ran should not be math');
});

test('looksLikeFactual detects factual questions', () => {
  assertTrue(cues.looksLikeFactual('The CEO of Apple is _'), 'CEO of should be factual');
  assertTrue(cues.looksLikeFactual('The capital of France is _'), 'capital of should be factual');
  assertTrue(cues.looksLikeFactual('Who invented the telephone'), 'Who invented should be factual');
  assertTrue(!cues.looksLikeFactual('The quick brown fox'), 'quick brown fox should not be factual');
});

// ============================================================================
// Test 3: Math evaluator
// ============================================================================
console.log('\n--- Math Evaluator ---');

test('evaluateMath handles simple expressions', () => {
  assertEqual(cues.evaluateMath('4*12'), 48, '4*12 should be 48');
  assertEqual(cues.evaluateMath('100/4'), 25, '100/4 should be 25');
  assertEqual(cues.evaluateMath('2+3'), 5, '2+3 should be 5');
});

test('evaluateMath handles percentages', () => {
  assertEqual(cues.evaluateMath('50*1.20'), 60, '50*1.20 should be 60');
  assertEqual(cues.evaluateMath('0.15*200'), 30, '0.15*200 should be 30');
});

test('evaluateMath handles powers', () => {
  assertEqual(cues.evaluateMath('2**8'), 256, '2**8 should be 256');
  assertEqual(cues.evaluateMath('3**3'), 27, '3**3 should be 27');
});

test('evaluateMath handles direct numbers', () => {
  assertEqual(cues.evaluateMath('42'), 42, '42 should be 42');
  assertEqual(cues.evaluateMath('12'), 12, '12 should be 12');
});

test('evaluateMath handles parentheses', () => {
  assertEqual(cues.evaluateMath('(80+90+100)/3'), 90, 'average should be 90');
  assertEqual(cues.evaluateMath('(100*9/5)+32'), 212, 'celsius to fahrenheit');
});

test('evaluateMath handles modulo', () => {
  assertEqual(cues.evaluateMath('17%5'), 2, '17%5 should be 2');
});

test('evaluateMath rejects unsafe expressions', () => {
  assertEqual(cues.evaluateMath('process.exit()'), null, 'Should reject process.exit');
  assertEqual(cues.evaluateMath('require("fs")'), null, 'Should reject require');
});

// ============================================================================
// Test 4: Classes are exported
// ============================================================================
console.log('\n--- Classes ---');

test('ModeClassifier is exported', () => {
  assertTrue(typeof cues.ModeClassifier === 'function', 'Should be function');
});

test('MathSource is exported', () => {
  assertTrue(typeof cues.MathSource === 'function', 'Should be function');
});

test('FactualSource is exported', () => {
  assertTrue(typeof cues.FactualSource === 'function', 'Should be function');
});

test('GrammarSource is exported', () => {
  assertTrue(typeof cues.GrammarSource === 'function', 'Should be function');
});

// ============================================================================
// Test 5: Source instantiation
// ============================================================================
console.log('\n--- Source Instantiation ---');

const mockHttpAdapter = {
  post: async (url, body, headers) => {
    return JSON.stringify({
      choices: [{ message: { content: 'COMPUTE=42' } }]
    });
  }
};

const commonConfig = {
  httpAdapter: mockHttpAdapter,
  endpoint: 'https://api.example.com',
  apiKey: 'test-key',
  model: 'test-model',
};

test('MathSource can be instantiated', () => {
  const source = new cues.MathSource(commonConfig);
  assertTrue(source.id === 'math', 'ID should be math');
  assertTrue(source.priority === 90, 'Priority should be 90');
});

test('FactualSource can be instantiated', () => {
  const source = new cues.FactualSource(commonConfig);
  assertTrue(source.id === 'factual', 'ID should be factual');
});

test('GrammarSource can be instantiated', () => {
  const source = new cues.GrammarSource(commonConfig);
  assertTrue(source.id === 'grammar', 'ID should be grammar');
  assertTrue(source.priority === 50, 'Priority should be 50');
});

test('MathSource.supports checks for blanks', () => {
  const source = new cues.MathSource(commonConfig);
  assertTrue(source.supports({ words: ['a', '_', 'b'] }), 'Should support blanks');
  assertTrue(!source.supports({ words: ['a', 'b', 'c'] }), 'Should not support no blanks');
});

test('GrammarSource.supports always true', () => {
  const source = new cues.GrammarSource(commonConfig);
  assertTrue(source.supports({ words: ['a', 'b'] }), 'Should support any');
  assertTrue(source.supports({ words: [] }), 'Should support empty');
});

// ============================================================================
// Summary
// ============================================================================
console.log('\n' + '='.repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));

process.exit(failed > 0 ? 1 : 0);
