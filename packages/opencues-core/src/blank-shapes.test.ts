import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { matchBlankShape } from './blank-shapes';
import type { BlankConfig } from './cues-md';

const VOLUME_SHAPES: BlankConfig['blankShapes'] = [
  { pattern: '^volume\\s*_$', action: 'get' },
  { pattern: '^volume\\s+(\\d+)\\s*%?\\s*_$', action: 'set', valueGroup: 1 },
  { pattern: '^set\\s+volume\\s+(?:to\\s+)?(\\d+)\\s*%?\\s*_$', action: 'set', valueGroup: 1 },
  { pattern: '^volume\\s+(up|down)\\s*_$', action: 'step', valueGroup: 1 },
];

function blanks(shapes: BlankConfig['blankShapes']): ReadonlyMap<string, Pick<BlankConfig, 'blankShapes'>> {
  return new Map([['volume', { blankShapes: shapes }]]);
}

describe('matchBlankShape', () => {
  const b = blanks(VOLUME_SHAPES);

  it('matches a bare get shape', () => {
    assert.deepStrictEqual(matchBlankShape('volume _', b), { blankName: 'volume', action: 'get', value: undefined });
  });

  it('matches a set shape + extracts the value (proximity-independent)', () => {
    // "volume 30 _" — value sits BETWEEN keyword and `_`, which proximity:0
    // rejects. The shape captures it deterministically.
    assert.deepStrictEqual(matchBlankShape('volume 30 _', b), { blankName: 'volume', action: 'set', value: '30' });
  });

  it('matches the "set volume to N" phrasing', () => {
    assert.deepStrictEqual(matchBlankShape('set volume to 80 _', b), { blankName: 'volume', action: 'set', value: '80' });
  });

  it('matches a step shape', () => {
    assert.deepStrictEqual(matchBlankShape('volume up _', b), { blankName: 'volume', action: 'step', value: 'up' });
  });

  it('is case-insensitive', () => {
    assert.strictEqual(matchBlankShape('Volume 40 _', b)?.value, '40');
  });

  it('tolerates host zero-width markers + surrounding whitespace', () => {
    assert.strictEqual(matchBlankShape('  volume 25 _​ ', b)?.value, '25');
  });

  it('does NOT match conversational / ambiguous input (clean cede)', () => {
    assert.strictEqual(matchBlankShape('what should i set the volume to _', b), null);
    assert.strictEqual(matchBlankShape('the volume of the box is _', b), null);
    assert.strictEqual(matchBlankShape('how much is amd stock _', b), null);
  });

  it('returns null when there is no `_`', () => {
    assert.strictEqual(matchBlankShape('volume 30', b), null);
  });

  it('skips no-shapes + malformed-pattern blanks, never throws', () => {
    const bad = new Map<string, Pick<BlankConfig, 'blankShapes'>>([
      ['noshapes', {}],
      ['malformed', { blankShapes: [{ pattern: '([', action: 'get' }] }],
      ['volume', { blankShapes: VOLUME_SHAPES }],
    ]);
    assert.deepStrictEqual(matchBlankShape('volume 50 _', bad), { blankName: 'volume', action: 'set', value: '50' });
  });
});
