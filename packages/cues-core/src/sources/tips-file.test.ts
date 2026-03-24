/**
 * Tests for tips-file.ts
 *
 * Run with: node --test dist/sources/tips-file.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  lookupWord,
  lookupWords,
  parseTipsFile,
  validateTipsData,
  TipsFileSource,
} from './tips-file';
import { TipsData } from '../types';

// Sample tips data for testing
const sampleTipsData: TipsData = [
  {
    id: 'test-words',
    words: {
      ultrathink: {
        tip: 'Add ultrathink to prompt for max reasoning',
        alts: ['Tab', 'deep thinking'],
      },
      Tab: {
        tip: 'Press Tab to toggle extended thinking mode',
        alts: ['ultrathink', 'deep thinking'],
      },
    },
  },
  {
    id: 'test-groups',
    groups: [
      {
        synonyms: ['agents', 'sub-agents', 'subagents'],
        tip: 'Spawn parallel workers via Task tool',
        alts: ['swarm', 'background'],
      },
      {
        synonyms: ['swarm', 'team'],
        tip: 'Multiple coordinated agents',
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

describe('lookupWord', () => {
  it('should find word in words structure', () => {
    const result = lookupWord('ultrathink', sampleTipsData);
    assert.ok(result);
    assert.strictEqual(result.word, 'ultrathink');
    assert.strictEqual(result.tip, 'Add ultrathink to prompt for max reasoning');
    assert.deepStrictEqual(result.alternatives, ['ultrathink', 'Tab', 'deep thinking']);
    assert.strictEqual(result.source, 'tips');
  });

  it('should find word in groups structure', () => {
    const result = lookupWord('agents', sampleTipsData);
    assert.ok(result);
    assert.strictEqual(result.word, 'agents');
    assert.strictEqual(result.tip, 'Spawn parallel workers via Task tool');
    assert.deepStrictEqual(result.alternatives, ['agents', 'swarm', 'background']);
  });

  it('should find synonym in groups structure', () => {
    const result = lookupWord('sub-agents', sampleTipsData);
    assert.ok(result);
    assert.strictEqual(result.word, 'sub-agents');
    assert.strictEqual(result.tip, 'Spawn parallel workers via Task tool');
  });

  it('should be case-insensitive', () => {
    const result = lookupWord('ULTRATHINK', sampleTipsData);
    assert.ok(result);
    assert.strictEqual(result.tip, 'Add ultrathink to prompt for max reasoning');
  });

  it('should return null for unknown word', () => {
    const result = lookupWord('unknown', sampleTipsData);
    assert.strictEqual(result, null);
  });

  it('should include per-alt tips', () => {
    const result = lookupWord('ultrathink', sampleTipsData);
    assert.ok(result);
    assert.ok(result.altTips);
    assert.strictEqual(result.altTips['ultrathink'], 'Add ultrathink to prompt for max reasoning');
    assert.strictEqual(result.altTips['Tab'], 'Press Tab to toggle extended thinking mode');
  });
});

describe('lookupWords', () => {
  it('should look up multiple words', () => {
    const words = ['The', 'agents', 'use', 'ultrathink'];
    const results = lookupWords(words, sampleTipsData);

    assert.strictEqual(results.size, 2);
    assert.ok(results.has(1)); // 'agents' at index 1
    assert.ok(results.has(3)); // 'ultrathink' at index 3
    assert.ok(!results.has(0)); // 'The' not found
    assert.ok(!results.has(2)); // 'use' not found
  });
});

describe('parseTipsFile', () => {
  it('should parse valid JSON', () => {
    const json = JSON.stringify(sampleTipsData);
    const result = parseTipsFile(json);
    assert.deepStrictEqual(result, sampleTipsData);
  });

  it('should throw on invalid JSON', () => {
    assert.throws(() => parseTipsFile('not json'), /JSON/);
  });

  it('should throw on non-array JSON', () => {
    assert.throws(() => parseTipsFile('{}'), /array/);
  });
});

describe('validateTipsData', () => {
  it('should return no errors for valid data', () => {
    const errors = validateTipsData(sampleTipsData);
    assert.deepStrictEqual(errors, []);
  });

  it('should detect missing id', () => {
    const data = [{ words: {} }];
    const errors = validateTipsData(data);
    assert.ok(errors.some((e) => e.includes('id')));
  });

  it('should detect invalid words entry', () => {
    const data = [{ id: 'test', words: { foo: { tip: 123 } } }];
    const errors = validateTipsData(data);
    assert.ok(errors.some((e) => e.includes('tip')));
  });
});

describe('TipsFileSource', () => {
  it('should implement CueSource interface', async () => {
    const source = new TipsFileSource(sampleTipsData);

    assert.strictEqual(source.id, 'tips');
    assert.ok(source.priority > 0);
    assert.ok(source.supports({ text: 'test', words: ['test'] }));

    const result = await source.getCues({
      text: 'agents use ultrathink',
      words: ['agents', 'use', 'ultrathink'],
    });

    assert.ok(result.results.length >= 2);
    assert.ok(result.timing !== undefined);
    assert.strictEqual(result.error, undefined);
  });

  it('should respect domain filtering', () => {
    const source = new TipsFileSource(sampleTipsData, { domain: 'claude-code' });

    assert.ok(source.supports({ text: 'test', words: ['test'], domain: 'claude-code' }));
    assert.ok(!source.supports({ text: 'test', words: ['test'], domain: 'medical' }));
  });
});

console.log('All tests defined. Run with: node --test dist/sources/tips-file.test.js');
