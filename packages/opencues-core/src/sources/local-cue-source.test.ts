/**
 * Tests for tips-file.ts
 *
 * Run with: node --test dist/sources/tips-file.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  parseLocalCueFile,
  validateLocalCueData,
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


console.log('All tests defined. Run with: node --test dist/sources/tips-file.test.js');
