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
  parseLocalCueFile,
  validateLocalCueData,
  LocalCueSource,
} from './local-cue-source';
import { LocalCueData } from '../types';

// Sample tips data for testing
const sampleLocalCueData: LocalCueData = [
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
    const result = lookupWord('ultrathink', sampleLocalCueData);
    assert.ok(result);
    assert.strictEqual(result.word, 'ultrathink');
    assert.strictEqual(result.cueTip, 'Add ultrathink to prompt for max reasoning');
    assert.deepStrictEqual(result.alternatives, ['ultrathink', 'Tab', 'deep thinking']);
    assert.strictEqual(result.source, 'tips');
  });

  it('should find word in groups structure', () => {
    const result = lookupWord('agents', sampleLocalCueData);
    assert.ok(result);
    assert.strictEqual(result.word, 'agents');
    assert.strictEqual(result.cueTip, 'Spawn parallel workers via Task tool');
    assert.deepStrictEqual(result.alternatives, ['agents', 'swarm', 'background']);
  });

  it('should find synonym in groups structure', () => {
    const result = lookupWord('sub-agents', sampleLocalCueData);
    assert.ok(result);
    assert.strictEqual(result.word, 'sub-agents');
    assert.strictEqual(result.cueTip, 'Spawn parallel workers via Task tool');
  });

  it('should be case-insensitive', () => {
    const result = lookupWord('ULTRATHINK', sampleLocalCueData);
    assert.ok(result);
    assert.strictEqual(result.cueTip, 'Add ultrathink to prompt for max reasoning');
  });

  it('should return null for unknown word', () => {
    const result = lookupWord('unknown', sampleLocalCueData);
    assert.strictEqual(result, null);
  });

  it('should include per-alt tips', () => {
    const result = lookupWord('ultrathink', sampleLocalCueData);
    assert.ok(result);
    assert.ok(result.altCueTips);
    assert.strictEqual(result.altCueTips['ultrathink'], 'Add ultrathink to prompt for max reasoning');
    assert.strictEqual(result.altCueTips['Tab'], 'Press Tab to toggle extended thinking mode');
  });
});

describe('lookupWords', () => {
  it('should look up multiple words', () => {
    const words = ['The', 'agents', 'use', 'ultrathink'];
    const results = lookupWords(words, sampleLocalCueData);

    assert.strictEqual(results.size, 2);
    assert.ok(results.has(1)); // 'agents' at index 1
    assert.ok(results.has(3)); // 'ultrathink' at index 3
    assert.ok(!results.has(0)); // 'The' not found
    assert.ok(!results.has(2)); // 'use' not found
  });
});

describe('parseLocalCueFile', () => {
  it('should parse valid JSON', () => {
    const json = JSON.stringify(sampleLocalCueData);
    const result = parseLocalCueFile(json);
    assert.deepStrictEqual(result, sampleLocalCueData);
  });

  it('should throw on invalid JSON', () => {
    assert.throws(() => parseLocalCueFile('not json'), /JSON/);
  });

  it('should throw on non-array JSON', () => {
    assert.throws(() => parseLocalCueFile('{}'), /array/);
  });
});

describe('validateLocalCueData', () => {
  it('should return no errors for valid data', () => {
    const errors = validateLocalCueData(sampleLocalCueData);
    assert.deepStrictEqual(errors, []);
  });

  it('should detect missing id', () => {
    const data = [{ words: {} }];
    const errors = validateLocalCueData(data);
    assert.ok(errors.some((e: any) => e.includes('id')));
  });

  it('should detect invalid words entry', () => {
    const data = [{ id: 'test', words: { foo: { tip: 123 } } }];
    const errors = validateLocalCueData(data);
    assert.ok(errors.some((e: any) => e.includes('tip')));
  });
});

describe('LocalCueSource', () => {
  it('should implement CueSource interface', async () => {
    const source = new LocalCueSource(sampleLocalCueData);

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
    const source = new LocalCueSource(sampleLocalCueData, { domain: 'claude-code' });

    assert.ok(source.supports({ text: 'test', words: ['test'], domain: 'claude-code' }));
    assert.ok(!source.supports({ text: 'test', words: ['test'], domain: 'medical' }));
  });
});

console.log('All tests defined. Run with: node --test dist/sources/tips-file.test.js');
