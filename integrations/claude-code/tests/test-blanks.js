#!/usr/bin/env node
/**
 * Test Suite: Blanks Pipeline
 *
 * Tests parsers, ConfigSource, ClassifiedSourceGroup, and buildSourcesFromConfig.
 */

const cues = require(process.env.HOME + '/.claude/node_modules/cues-core');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      result.then(() => {
        console.log(`✓ ${name}`);
        passed++;
      }).catch(e => {
        console.log(`✗ ${name}`);
        console.log(`  Error: ${e.message}`);
        failed++;
      });
      return result;
    }
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
  if (!condition) throw new Error(msg);
}

// Mock HTTP adapter that returns canned responses
function mockAdapter(response) {
  return {
    post: async () => JSON.stringify({
      choices: [{ message: { content: response } }]
    })
  };
}

console.log('='.repeat(60));
console.log('Blanks Pipeline Tests');
console.log('='.repeat(60));
console.log('');

// ============================================================================
// Test 1: Parsers
// ============================================================================
console.log('--- Parsers ---');

test('parseCompute: basic expression', () => {
  assertEqual(cues.parseCompute('COMPUTE=4*12'), ['48'], 'Should evaluate 4*12');
});

test('parseCompute: division', () => {
  assertEqual(cues.parseCompute('COMPUTE=100/4'), ['25'], 'Should evaluate 100/4');
});

test('parseCompute: parentheses', () => {
  assertEqual(cues.parseCompute('COMPUTE=(80+90+100)/3'), ['90'], 'Should evaluate average');
});

test('parseCompute: no match returns empty', () => {
  assertEqual(cues.parseCompute('no compute here'), [], 'Should return empty');
});

test('parseCompute: unsafe expression returns empty', () => {
  assertEqual(cues.parseCompute('COMPUTE=process.exit(1)'), [], 'Should reject unsafe');
});

test('parseCompute: decimal result', () => {
  const result = cues.parseCompute('COMPUTE=10/3');
  assertTrue(result.length === 1, 'Should have one result');
  assertTrue(parseFloat(result[0]) > 3.33 && parseFloat(result[0]) < 3.34, 'Should be ~3.3333');
});

test('parseAnswer: basic answer', () => {
  assertEqual(cues.parseAnswer('ANSWER=Paris'), ['Paris'], 'Should extract Paris');
});

test('parseAnswer: multi-word answer', () => {
  assertEqual(cues.parseAnswer('ANSWER=Tim Cook'), ['Tim Cook'], 'Should extract Tim Cook');
});

test('parseAnswer: no match returns empty', () => {
  assertEqual(cues.parseAnswer('no answer here'), [], 'Should return empty');
});

test('parseAlternatives: single index', () => {
  const words = ['The', '_', 'dog'];
  const result = cues.parseAlternatives('1:big,small,brown', words);
  assertTrue(result.length === 1, 'Should have one result');
  assertEqual(result[0].wordIndex, 1, 'Should be index 1');
  assertEqual(result[0].alternatives, ['big', 'small', 'brown'], 'Blank alts should not prepend original');
});

test('parseAlternatives: non-blank word prepends original', () => {
  const words = ['The', 'quick', 'fox'];
  const result = cues.parseAlternatives('1:fast,slow,rapid', words);
  assertTrue(result.length === 1, 'Should have one result');
  assertEqual(result[0].alternatives, ['quick', 'fast', 'slow', 'rapid'], 'Should prepend original');
});

test('parseAlternatives: skips number positions', () => {
  const words = ['The', '42', 'items'];
  const result = cues.parseAlternatives('1:forty-two,many', words);
  assertTrue(result.length === 0, 'Should skip number position');
});

test('parseAlternatives: multiple indices', () => {
  const words = ['The', '_', 'dog', '_'];
  const result = cues.parseAlternatives('1:big,small\n3:barked,ran', words);
  assertTrue(result.length === 2, 'Should have two results');
});

test('parseRaw: returns trimmed response', () => {
  assertEqual(cues.parseRaw('  hello world  '), ['hello world'], 'Should trim');
});

test('parseRaw: empty returns empty', () => {
  assertEqual(cues.parseRaw('   '), [], 'Should return empty for whitespace');
});

// ============================================================================
// Test 1b: Parser edge cases — realistic LLM output
// ============================================================================
console.log('\n--- Parser edge cases (real LLM output) ---');

// parseCompute: LLM often adds reasoning before the answer
test('parseCompute: reasoning before COMPUTE', () => {
  assertEqual(cues.parseCompute('The expression is 4 times 12.\nCOMPUTE=4*12'), ['48'], 'Should find COMPUTE after reasoning');
});

test('parseCompute: COMPUTE with spaces around =', () => {
  assertEqual(cues.parseCompute('COMPUTE = 100/4'), ['25'], 'Should handle spaces around =');
});

test('parseCompute: COMPUTE with lowercase', () => {
  assertEqual(cues.parseCompute('compute=50*1.20'), ['60'], 'Should be case-insensitive');
});

test('parseCompute: expression with negative result', () => {
  assertEqual(cues.parseCompute('COMPUTE=5-10'), ['-5'], 'Should handle negative');
});

test('parseCompute: expression with modulo', () => {
  assertEqual(cues.parseCompute('COMPUTE=17%5'), ['2'], 'Should handle modulo');
});

test('parseCompute: expression resulting in 0', () => {
  assertEqual(cues.parseCompute('COMPUTE=5-5'), ['0'], 'Should handle zero');
});

test('parseCompute: very large number', () => {
  assertEqual(cues.parseCompute('COMPUTE=2**20'), ['1048576'], 'Should handle large numbers');
});

test('parseCompute: expression with trailing text', () => {
  assertEqual(cues.parseCompute('COMPUTE=4*12\nThe answer is 48.'), ['48'], 'Should ignore trailing text');
});

test('parseCompute: empty expression', () => {
  assertEqual(cues.parseCompute('COMPUTE='), [], 'Should return empty for empty expression');
});

test('parseCompute: division by zero', () => {
  assertEqual(cues.parseCompute('COMPUTE=1/0'), [], 'Should reject Infinity');
});

// parseAnswer: LLM formatting variations
test('parseAnswer: reasoning before ANSWER', () => {
  assertEqual(cues.parseAnswer('The capital of France is Paris.\nANSWER=Paris'), ['Paris'], 'Should find after reasoning');
});

test('parseAnswer: ANSWER with extra spaces', () => {
  assertEqual(cues.parseAnswer('ANSWER =  Tim Cook  '), ['Tim Cook'], 'Should trim value');
});

test('parseAnswer: answer with lowercase', () => {
  assertEqual(cues.parseAnswer('answer=1945'), ['1945'], 'Should be case-insensitive');
});

test('parseAnswer: answer with special characters', () => {
  assertEqual(cues.parseAnswer('ANSWER=J.K. Rowling'), ['J.K. Rowling'], 'Should handle dots');
});

test('parseAnswer: empty answer', () => {
  assertEqual(cues.parseAnswer('ANSWER='), [], 'Should return empty for empty value');
});

test('parseAnswer: very long answer rejected', () => {
  const long = 'ANSWER=' + 'x'.repeat(101);
  assertEqual(cues.parseAnswer(long), [], 'Should reject answers over 100 chars');
});

test('parseAnswer: answer exactly 100 chars accepted', () => {
  const val = 'x'.repeat(100);
  assertEqual(cues.parseAnswer('ANSWER=' + val), [val], 'Should accept answers at 100 chars');
});

test('parseAnswer: LLM returns multiple lines, only first ANSWER used', () => {
  assertEqual(cues.parseAnswer('ANSWER=Paris\nANSWER=London'), ['Paris'], 'Should use first match');
});

// parseAlternatives: LLM formatting variations
test('parseAlternatives: pipe-separated entries', () => {
  const words = ['The', 'quick', 'fox'];
  const result = cues.parseAlternatives('1:fast,slow,rapid|2:wolf,dog,hound', words);
  assertTrue(result.length === 2, 'Should parse pipe-separated');
  assertEqual(result[0].wordIndex, 1, 'First entry index');
  assertEqual(result[1].wordIndex, 2, 'Second entry index');
});

test('parseAlternatives: newline-separated entries', () => {
  const words = ['The', 'quick', 'fox'];
  const result = cues.parseAlternatives('1:fast,slow,rapid\n2:wolf,dog,hound', words);
  assertTrue(result.length === 2, 'Should parse newline-separated');
});

test('parseAlternatives: equals sign instead of colon', () => {
  const words = ['The', '_', 'dog'];
  const result = cues.parseAlternatives('1=big,small,brown', words);
  assertTrue(result.length === 1, 'Should handle = separator');
  assertEqual(result[0].alternatives, ['big', 'small', 'brown'], 'Should parse alts after =');
});

test('parseAlternatives: extra spaces in alternatives', () => {
  const words = ['The', '_', 'dog'];
  const result = cues.parseAlternatives('1: big , small , brown ', words);
  assertTrue(result.length === 1, 'Should handle spaces');
  assertEqual(result[0].alternatives, ['big', 'small', 'brown'], 'Should trim all alts');
});

test('parseAlternatives: LLM adds reasoning before output', () => {
  const words = ['The', '_', 'dog'];
  const response = 'The blank needs an adjective before "dog".\n1:big,small,brown';
  const result = cues.parseAlternatives(response, words);
  assertTrue(result.length === 1, 'Should find alternatives after reasoning');
});

test('parseAlternatives: out-of-bounds index ignored', () => {
  const words = ['The', 'fox'];
  const result = cues.parseAlternatives('5:wolf,dog', words);
  assertTrue(result.length === 0, 'Should skip index >= words.length');
});

test('parseAlternatives: empty alternatives ignored', () => {
  const words = ['The', '_'];
  const result = cues.parseAlternatives('1:', words);
  assertTrue(result.length === 0, 'Should skip empty alternatives');
});

test('parseAlternatives: single alternative for blank', () => {
  const words = ['The', '_', 'dog'];
  const result = cues.parseAlternatives('1:big', words);
  assertTrue(result.length === 1, 'Should accept single alt');
  assertEqual(result[0].alternatives, ['big'], 'Should have one alt');
});

test('parseAlternatives: single alternative for non-blank prepends original', () => {
  const words = ['The', 'quick', 'fox'];
  const result = cues.parseAlternatives('1:fast', words);
  assertTrue(result.length === 1, 'Should accept single alt');
  assertEqual(result[0].alternatives, ['quick', 'fast'], 'Should prepend original');
});

test('parseAlternatives: LLM returns markdown formatting', () => {
  const words = ['She', '_', 'quickly'];
  const response = '**1**: ran, walked, sprinted';
  // The regex expects digit:alts — markdown bold ** will break the match
  // This is a known limitation; verify it fails gracefully
  const result = cues.parseAlternatives(response, words);
  // May or may not parse depending on regex — just verify no crash
  assertTrue(Array.isArray(result), 'Should not crash on markdown');
});

test('parseAlternatives: LLM returns numbered list format', () => {
  const words = ['The', '_', 'cat', '_'];
  const response = '1: big, small, fluffy\n3: ran, jumped, slept';
  const result = cues.parseAlternatives(response, words);
  assertTrue(result.length === 2, 'Should parse numbered list');
});

// End-to-end: ConfigSource with realistic mock LLM responses
console.log('\n--- ConfigSource with realistic LLM responses ---');

test('ConfigSource: compute with reasoning prefix', async () => {
  const src = new cues.ConfigSource({
    sourceConfig: { name: 'math', scope: 'blanks', parser: 'compute', promptText: 'Solve:' },
    httpAdapter: mockAdapter('Let me calculate: half of 16 is 16/2.\nCOMPUTE=16/2'),
    endpoint: 'http://x', apiKey: 'k', defaultModel: 'm',
  });
  const result = await src.getCues({ text: 'half of 16 = _', words: ['half', 'of', '16', '=', '_'] });
  assertTrue(result.results.length === 1, 'Should have result');
  assertEqual(result.results[0].alternatives, ['_', '8'], 'Should compute 8');
});

test('ConfigSource: answer with reasoning prefix', async () => {
  const src = new cues.ConfigSource({
    sourceConfig: { name: 'factual', scope: 'blanks', parser: 'answer', promptText: 'Answer:' },
    httpAdapter: mockAdapter('The chemical symbol for gold is Au, from Latin aurum.\nANSWER=Au'),
    endpoint: 'http://x', apiKey: 'k', defaultModel: 'm',
  });
  const result = await src.getCues({ text: 'chemical symbol for gold is _', words: ['chemical', 'symbol', 'for', 'gold', 'is', '_'] });
  assertTrue(result.results.length === 1, 'Should have result');
  assertEqual(result.results[0].alternatives, ['_', 'Au'], 'Should extract Au');
});

test('ConfigSource: alternatives with mixed formatting', async () => {
  const src = new cues.ConfigSource({
    sourceConfig: { name: 'grammar', scope: 'blanks', parser: 'alternatives', promptText: 'Fill:' },
    httpAdapter: mockAdapter('Based on context, the blank needs an adjective.\n1: big, small, brown, happy, loud'),
    endpoint: 'http://x', apiKey: 'k', defaultModel: 'm',
  });
  const result = await src.getCues({ text: 'The _ dog', words: ['The', '_', 'dog'] });
  assertTrue(result.results.length === 1, 'Should have result');
  assertEqual(result.results[0].alternatives, ['big', 'small', 'brown', 'happy', 'loud'], 'Should parse all 5 alts');
});

test('ConfigSource: compute returns single digit', async () => {
  const src = new cues.ConfigSource({
    sourceConfig: { name: 'math', scope: 'blanks', parser: 'compute', promptText: 'Solve:' },
    httpAdapter: mockAdapter('COMPUTE=2+1'),
    endpoint: 'http://x', apiKey: 'k', defaultModel: 'm',
  });
  const result = await src.getCues({ text: '2 + 1 = _', words: ['2', '+', '1', '=', '_'] });
  assertTrue(result.results.length === 1, 'Should have result');
  assertEqual(result.results[0].alternatives, ['_', '3'], 'Should handle single digit result');
});

test('ConfigSource: LLM returns empty/garbage', async () => {
  const src = new cues.ConfigSource({
    sourceConfig: { name: 'math', scope: 'blanks', parser: 'compute', promptText: 'Solve:' },
    httpAdapter: mockAdapter('I cannot solve this problem.'),
    endpoint: 'http://x', apiKey: 'k', defaultModel: 'm',
  });
  const result = await src.getCues({ text: '??? = _', words: ['???', '=', '_'] });
  assertTrue(result.results.length === 0, 'Should return empty for unparseable response');
});

test('ConfigSource: LLM returns malformed JSON', async () => {
  const src = new cues.ConfigSource({
    sourceConfig: { name: 'math', scope: 'blanks', parser: 'compute', promptText: 'Solve:' },
    httpAdapter: { post: async () => 'not json at all' },
    endpoint: 'http://x', apiKey: 'k', defaultModel: 'm',
  });
  const result = await src.getCues({ text: '2 + 2 = _', words: ['2', '+', '2', '=', '_'] });
  assertTrue(result.results.length === 0, 'Should return empty');
  assertTrue(!!result.error, 'Should have error message');
});

test('ConfigSource: network error handled gracefully', async () => {
  const src = new cues.ConfigSource({
    sourceConfig: { name: 'math', scope: 'blanks', parser: 'compute', promptText: 'Solve:' },
    httpAdapter: { post: async () => { throw new Error('Connection refused'); } },
    endpoint: 'http://x', apiKey: 'k', defaultModel: 'm',
  });
  const result = await src.getCues({ text: '2 + 2 = _', words: ['2', '+', '2', '=', '_'] });
  assertTrue(result.results.length === 0, 'Should return empty');
  assertTrue(result.error === 'Connection refused', 'Should capture error message');
});

// ============================================================================
// Test 2: ConfigSource
// ============================================================================
console.log('\n--- ConfigSource ---');

test('ConfigSource: words scope skips blanks', () => {
  const src = new cues.ConfigSource({
    sourceConfig: { name: 'grammar', scope: 'words', promptText: 'test prompt' },
    httpAdapter: mockAdapter(''), endpoint: 'http://x', apiKey: 'k', defaultModel: 'm',
  });
  assertTrue(src.supports({ text: 'hello world', words: ['hello', 'world'] }), 'Should support non-blank');
  assertTrue(!src.supports({ text: 'hello _', words: ['hello', '_'] }), 'Should NOT support blanks');
});

test('ConfigSource: blanks scope only handles blanks', () => {
  const src = new cues.ConfigSource({
    sourceConfig: { name: 'math', scope: 'blanks', parser: 'compute', promptText: 'test' },
    httpAdapter: mockAdapter(''), endpoint: 'http://x', apiKey: 'k', defaultModel: 'm',
  });
  assertTrue(!src.supports({ text: 'hello world', words: ['hello', 'world'] }), 'Should NOT support non-blank');
  assertTrue(src.supports({ text: '4 * 12 = _', words: ['4', '*', '12', '=', '_'] }), 'Should support blanks');
});

test('ConfigSource: all scope supports everything', () => {
  const src = new cues.ConfigSource({
    sourceConfig: { name: 'universal', scope: 'all', promptText: 'test' },
    httpAdapter: mockAdapter(''), endpoint: 'http://x', apiKey: 'k', defaultModel: 'm',
  });
  assertTrue(src.supports({ text: 'hello', words: ['hello'] }), 'Should support non-blank');
  assertTrue(src.supports({ text: '_', words: ['_'] }), 'Should support blank');
});

test('ConfigSource: default scope is words', () => {
  const src = new cues.ConfigSource({
    sourceConfig: { name: 'test', promptText: 'test' },
    httpAdapter: mockAdapter(''), endpoint: 'http://x', apiKey: 'k', defaultModel: 'm',
  });
  assertTrue(src.scope === 'words', 'Default scope should be words');
});

test('ConfigSource: priority from config', () => {
  const src = new cues.ConfigSource({
    sourceConfig: { name: 'test', priority: 75, promptText: 'test' },
    httpAdapter: mockAdapter(''), endpoint: 'http://x', apiKey: 'k', defaultModel: 'm',
  });
  assertTrue(src.priority === 75, 'Priority should be 75');
});

test('ConfigSource: compute parser returns result with _ prepended', async () => {
  const src = new cues.ConfigSource({
    sourceConfig: { name: 'math', scope: 'blanks', parser: 'compute', promptText: 'Solve:' },
    httpAdapter: mockAdapter('COMPUTE=4*12'), endpoint: 'http://x', apiKey: 'k', defaultModel: 'm',
  });
  const result = await src.getCues({ text: '4 * 12 = _', words: ['4', '*', '12', '=', '_'] });
  assertTrue(result.results.length === 1, 'Should have one result');
  assertEqual(result.results[0].wordIndex, 4, 'Should target blank at index 4');
  assertEqual(result.results[0].alternatives, ['_', '48'], 'Should be [_, 48]');
});

test('ConfigSource: answer parser returns result with _ prepended', async () => {
  const src = new cues.ConfigSource({
    sourceConfig: { name: 'factual', scope: 'blanks', parser: 'answer', promptText: 'Answer:' },
    httpAdapter: mockAdapter('ANSWER=Paris'), endpoint: 'http://x', apiKey: 'k', defaultModel: 'm',
  });
  const result = await src.getCues({ text: 'capital of France is _', words: ['capital', 'of', 'France', 'is', '_'] });
  assertTrue(result.results.length === 1, 'Should have one result');
  assertEqual(result.results[0].alternatives, ['_', 'Paris'], 'Should be [_, Paris]');
});

test('ConfigSource: alternatives parser for words scope', async () => {
  const src = new cues.ConfigSource({
    sourceConfig: { name: 'grammar', scope: 'words', promptText: 'Give alts:' },
    httpAdapter: mockAdapter('1:fast,slow,rapid'), endpoint: 'http://x', apiKey: 'k', defaultModel: 'm',
  });
  const result = await src.getCues({ text: 'The quick fox', words: ['The', 'quick', 'fox'] });
  assertTrue(result.results.length === 1, 'Should have one result');
  assertEqual(result.results[0].alternatives, ['quick', 'fast', 'slow', 'rapid'], 'Should prepend original');
});

test('ConfigSource: no promptText returns empty', async () => {
  const src = new cues.ConfigSource({
    sourceConfig: { name: 'empty' },
    httpAdapter: mockAdapter(''), endpoint: 'http://x', apiKey: 'k', defaultModel: 'm',
  });
  const result = await src.getCues({ text: 'hello', words: ['hello'] });
  assertTrue(result.results.length === 0, 'Should return empty');
});

// ============================================================================
// Test 3: ClassifiedSourceGroup
// ============================================================================
console.log('\n--- ClassifiedSourceGroup ---');

test('ClassifiedSourceGroup: supports only blanks', () => {
  const group = new cues.ClassifiedSourceGroup({
    sources: [],
    httpAdapter: mockAdapter(''), endpoint: 'http://x', apiKey: 'k', model: 'm',
  });
  assertTrue(!group.supports({ text: 'hello', words: ['hello'] }), 'Should NOT support non-blank');
  assertTrue(group.supports({ text: 'hello _', words: ['hello', '_'] }), 'Should support blanks');
});

test('ClassifiedSourceGroup: fast classify by regex match', async () => {
  const mathSrc = new cues.ConfigSource({
    sourceConfig: { name: 'math', scope: 'blanks', parser: 'compute', match: '\\d+\\s*[+\\-*/]\\s*\\d+', promptText: 'Solve:' },
    httpAdapter: mockAdapter('COMPUTE=4*12'), endpoint: 'http://x', apiKey: 'k', defaultModel: 'm',
  });
  const grammarSrc = new cues.ConfigSource({
    sourceConfig: { name: 'grammar', scope: 'blanks', parser: 'alternatives', promptText: 'Fill:' },
    httpAdapter: mockAdapter('1:big,small'), endpoint: 'http://x', apiKey: 'k', defaultModel: 'm',
  });
  const group = new cues.ClassifiedSourceGroup({
    sources: [mathSrc, grammarSrc],
    httpAdapter: mockAdapter(''), endpoint: 'http://x', apiKey: 'k', model: 'm',
  });
  const result = await group.getCues({ text: '4 * 12 = _', words: ['4', '*', '12', '=', '_'] });
  assertTrue(result.results.length === 1, 'Should have one result');
  assertTrue(result.results[0].source === 'math', 'Should pick math source via regex');
});

test('ClassifiedSourceGroup: fast classify by keywords', async () => {
  const factualSrc = new cues.ConfigSource({
    sourceConfig: { name: 'factual', scope: 'blanks', parser: 'answer', keywords: 'capital of, ceo of', promptText: 'Answer:' },
    httpAdapter: mockAdapter('ANSWER=Paris'), endpoint: 'http://x', apiKey: 'k', defaultModel: 'm',
  });
  const grammarSrc = new cues.ConfigSource({
    sourceConfig: { name: 'grammar', scope: 'blanks', parser: 'alternatives', promptText: 'Fill:' },
    httpAdapter: mockAdapter(''), endpoint: 'http://x', apiKey: 'k', defaultModel: 'm',
  });
  const group = new cues.ClassifiedSourceGroup({
    sources: [factualSrc, grammarSrc],
    httpAdapter: mockAdapter(''), endpoint: 'http://x', apiKey: 'k', model: 'm',
  });
  const result = await group.getCues({ text: 'capital of France is _', words: ['capital', 'of', 'France', 'is', '_'] });
  assertTrue(result.results.length === 1, 'Should have one result');
  assertTrue(result.results[0].source === 'factual', 'Should pick factual source via keyword');
});

test('ClassifiedSourceGroup: defaults to grammar when no match', async () => {
  const mathSrc = new cues.ConfigSource({
    sourceConfig: { name: 'math', scope: 'blanks', parser: 'compute', match: '\\d+\\s*[+\\-*/]\\s*\\d+', promptText: 'Solve:' },
    httpAdapter: mockAdapter(''), endpoint: 'http://x', apiKey: 'k', defaultModel: 'm',
  });
  const grammarSrc = new cues.ConfigSource({
    sourceConfig: { name: 'grammar', scope: 'blanks', parser: 'alternatives', promptText: 'Fill:' },
    httpAdapter: mockAdapter('1:big,small,brown'), endpoint: 'http://x', apiKey: 'k', defaultModel: 'm',
  });
  const group = new cues.ClassifiedSourceGroup({
    sources: [mathSrc, grammarSrc],
    httpAdapter: mockAdapter(''), endpoint: 'http://x', apiKey: 'k', model: 'm',
  });
  const result = await group.getCues({ text: 'The _ dog', words: ['The', '_', 'dog'] });
  assertTrue(result.results.length === 1, 'Should have one result');
  assertTrue(result.results[0].source === 'grammar', 'Should default to grammar');
});

// ============================================================================
// Test 4: buildSourcesFromConfig
// ============================================================================
console.log('\n--- buildSourcesFromConfig ---');

test('buildSourcesFromConfig: parses cues.md + blanks.md', () => {
  const cuesMd = fs.readFileSync(path.join(__dirname, '../../../cues.md'), 'utf8');
  const blanksMd = fs.readFileSync(path.join(__dirname, '../../../blanks.md'), 'utf8');
  const cuesCfg = cues.parseCuesMd(cuesMd);
  const blanksCfg = cues.parseCuesMd(blanksMd);

  const sources = cues.buildSourcesFromConfig(cuesCfg, blanksCfg, {
    httpAdapter: mockAdapter(''), endpoint: 'http://x', apiKey: 'k', defaultModel: 'm',
  });

  assertTrue(sources.length >= 2, 'Should have at least 2 sources (grammar words + blanks group)');

  // Check we have words-scoped sources from cues.md
  const wordsSources = sources.filter(s => s.scope === 'words' || (s.id !== 'blanks' && !s.scope));
  assertTrue(wordsSources.length >= 1, 'Should have at least one words source');

  // Check we have a ClassifiedSourceGroup for blanks
  const blanksGroup = sources.find(s => s.id === 'blanks');
  assertTrue(!!blanksGroup, 'Should have a blanks group');
});

test('buildSourcesFromConfig: works with no blanks.md', () => {
  const cuesMd = fs.readFileSync(path.join(__dirname, '../../../cues.md'), 'utf8');
  const cuesCfg = cues.parseCuesMd(cuesMd);

  const sources = cues.buildSourcesFromConfig(cuesCfg, undefined, {
    httpAdapter: mockAdapter(''), endpoint: 'http://x', apiKey: 'k', defaultModel: 'm',
  });

  assertTrue(sources.length >= 1, 'Should have at least one source');
  const blanksGroup = sources.find(s => s.id === 'blanks');
  assertTrue(!blanksGroup, 'Should NOT have a blanks group');
});

// ============================================================================
// Run async tests and print summary
// ============================================================================
setTimeout(() => {
  console.log('');
  console.log('='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));
  process.exit(failed > 0 ? 1 : 0);
}, 2000);
