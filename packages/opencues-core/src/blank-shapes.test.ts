import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { matchBlankShape, blankClaimsUnderscore } from './blank-shapes';
import { synthesizeKeywordShapes, type BlankConfig } from './cues-md';

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

  // SEGMENT-SCOPED: a shape matches the SENTENCE/line containing `_`, so a
  // command on the last line claims even with prior content above — but prose
  // that merely leads the segment never matches (anchored grammar).
  it('matches a command on the last line with prior content above', () => {
    assert.deepStrictEqual(
      matchBlankShape('some earlier notes here.\nvolume 30 _', b),
      { blankName: 'volume', action: 'set', value: '30' },
    );
  });

  it('does NOT match when the keyword is on a PREVIOUS line', () => {
    assert.strictEqual(matchBlankShape('volume notes\njust a plain line _', b), null);
  });

  it('de-greedy: prose that only mentions the keyword mid-line never matches', () => {
    assert.strictEqual(matchBlankShape('the volume was lovely today _', b), null);
  });

  // SENTENCE-scoped: a command claims its `_` when it leads its SENTENCE, not
  // just its physical line. A sentence terminator (`.`/`!`/`?` + space, or a
  // CJK terminator) resets the anchor the same way a newline does — so the
  // shaped-blank router agrees with fluid-config's `summonPhraseStart`.
  it('matches a command after a sentence terminator on the SAME line', () => {
    assert.deepStrictEqual(
      matchBlankShape('let me check the audio. volume 30 _', b),
      { blankName: 'volume', action: 'set', value: '30' },
    );
  });

  it('matches after ! and ? terminators too', () => {
    assert.strictEqual(matchBlankShape('done! volume up _', b)?.value, 'up');
    assert.strictEqual(matchBlankShape('what now? volume _', b)?.action, 'get');
  });

  it('matches after a CJK terminator (no trailing space)', () => {
    assert.strictEqual(matchBlankShape('こんにちは世界。volume 40 _', b)?.value, '40');
  });

  it('decimal/version dots do NOT split (precision held)', () => {
    // "3.5" has no space after the dot, so it is NOT a boundary; the segment
    // stays the whole line → leads with "the" → no match. (The set shape wants
    // an integer anyway, so even a wrong split would cede cleanly.)
    assert.strictEqual(matchBlankShape('the cost was 3.5 dollars volume _', b), null);
    // But a real sentence end before the command DOES fire it.
    assert.strictEqual(matchBlankShape('the cost was 3.5 dollars. volume _', b)?.action, 'get');
  });

  it('prose ending in a period that is NOT a command still cedes', () => {
    assert.strictEqual(matchBlankShape('i turned the volume down. what a day _', b), null);
  });
});

// The SINGLE cede predicate shared by FluidBlank / TransformBlank /
// ConfigIntent. Testing it once covers all three — that's the whole point of
// centralising it (the June 2026 long-buffer bug was ConfigIntent carrying a
// stale inline copy that diverged from the other two).
describe('blankClaimsUnderscore (shared cede predicate)', () => {
  const words = (t: string) => t.replace(/[​‌]/g, '').split(/\s+/).filter(Boolean);
  const VB = new Map<string, Pick<BlankConfig, 'blankShapes' | 'blankKeywords'>>([
    ['volume', { blankShapes: VOLUME_SHAPES, blankKeywords: ['volume'] }],
  ]);

  it('a shaped command claims its `_`', () => {
    assert.strictEqual(blankClaimsUnderscore('volume 30 _', words('volume 30 _'), VB), true);
    assert.strictEqual(blankClaimsUnderscore('volume _', words('volume _'), VB), true);
  });

  // THE REGRESSION (June 2026): a stray keyword in PROSE must NOT claim, so a
  // following settings command still routes to ConfigIntent. The word "volume"
  // sits in the woven `The volume is now 30%`, on the same line as `_`, but
  // `volume` is a SHAPED blank → the legacy keyword cede is skipped, and the
  // `_`'s segment ("voice mode off _") matches no shape → no claim.
  it('a stray keyword in prose does NOT claim (shaped blank skips keyword cede)', () => {
    const t = 'let me check the audio. The volume is now 30%. voice mode off _';
    assert.strictEqual(blankClaimsUnderscore(t, words(t), VB), false);
  });

  it('a NON-shaped keyword blank still claims via keyword on the line (legacy)', () => {
    const legacy = new Map<string, Pick<BlankConfig, 'blankShapes' | 'blankKeywords'>>([
      ['notes', { blankKeywords: ['note'] }], // no shapes → legacy keyword cede applies
    ]);
    assert.strictEqual(blankClaimsUnderscore('note this down _', words('note this down _'), legacy), true);
    // …but a stray "note" with the keyword on a PREVIOUS line does not.
    assert.strictEqual(blankClaimsUnderscore('note above\nplain line _', words('note above\nplain line _'), legacy), false);
  });

  it('no `_` → no claim', () => {
    assert.strictEqual(blankClaimsUnderscore('volume 30', words('volume 30'), VB), false);
  });
});

describe('synthesizeKeywordShapes (keyword → shape desugaring)', () => {
  it('a non-settable keyword yields get-with-arg + bare-get, routed by matchBlankShape', () => {
    const shapes = synthesizeKeywordShapes(['weather', 'forecast'], false);
    const b = new Map([['weather', { blankShapes: shapes }]]);
    assert.deepStrictEqual(matchBlankShape('weather oslo _', b), { blankName: 'weather', action: 'get', value: 'oslo' });
    assert.deepStrictEqual(matchBlankShape('forecast _', b), { blankName: 'weather', action: 'get', value: undefined });
    // Synonym alternation works.
    assert.strictEqual(matchBlankShape('forecast tokyo _', b)?.value, 'tokyo');
  });

  it('a settable keyword (blankStep) also yields set + step shapes', () => {
    const shapes = synthesizeKeywordShapes(['volume'], true);
    const b = new Map([['volume', { blankShapes: shapes }]]);
    assert.deepStrictEqual(matchBlankShape('volume 30 _', b), { blankName: 'volume', action: 'set', value: '30' });
    assert.deepStrictEqual(matchBlankShape('volume up _', b), { blankName: 'volume', action: 'step', value: 'up' });
    assert.deepStrictEqual(matchBlankShape('volume _', b), { blankName: 'volume', action: 'get', value: undefined });
  });

  it('multi-word keywords join their words with flexible whitespace', () => {
    const shapes = synthesizeKeywordShapes(['what is the word for'], false);
    const b = new Map([['dict', { blankShapes: shapes }]]);
    assert.strictEqual(matchBlankShape('what is the word for serendipity _', b)?.value, 'serendipity');
  });

  it('returns [] for an empty keyword list', () => {
    assert.deepStrictEqual(synthesizeKeywordShapes([], false), []);
  });
});

// ───────────────────────────────────────────────────────────────────────
// argValidator — runtime-injected arg validation at the shape chokepoint.
// A shape whose CAPTURED arg fails validation never matches, and because
// every claim/cede site funnels through matchBlankShape, the miss
// releases the `_` to fluid-blank everywhere at once (the LLM answers
// "Istanbul is a city…" instead of the blank substituting a not-found
// error — live Spotlight report 2026-07-21).
// ───────────────────────────────────────────────────────────────────────

describe('argValidator (shape-captured arg validation)', () => {
  const countriesShapes = synthesizeKeywordShapes(['capital of', 'population of'], false);
  const withValidator = (ok: (a: string) => boolean): ReadonlyMap<string, Pick<BlankConfig, 'blankShapes' | 'blankKeywords' | 'argValidator'>> =>
    new Map([['countries', {
      blankShapes: countriesShapes,
      blankKeywords: ['capital of', 'population of'],
      argValidator: ok,
    }]]);

  it('a captured arg that passes validation matches normally', () => {
    const m = matchBlankShape('capital of france _', withValidator(a => a === 'france'));
    assert.strictEqual(m?.blankName, 'countries');
    assert.strictEqual(m?.value, 'france');
  });

  it('a captured arg that fails validation never matches — clean cede', () => {
    assert.strictEqual(matchBlankShape('capital of istanbul _', withValidator(a => a === 'france')), null);
  });

  it('blankClaimsUnderscore releases the `_` on validation failure (fluid may claim the trick question)', () => {
    const b = withValidator(a => a === 'france');
    const t1 = 'capital of france _';
    assert.strictEqual(blankClaimsUnderscore(t1, t1.split(' '), b), true);
    const t2 = 'capital of istanbul _';
    assert.strictEqual(blankClaimsUnderscore(t2, t2.split(' '), b), false);
  });

  it('no validator declared → behaviour unchanged (any captured arg matches)', () => {
    const b = new Map([['countries', { blankShapes: countriesShapes }]]);
    assert.strictEqual(matchBlankShape('capital of istanbul _', b)?.blankName, 'countries');
  });

  it('shapes with no captured value ignore the validator', () => {
    const b = new Map([['volume', {
      blankShapes: [{ pattern: '^volume\\s*_$', action: 'get' as const }],
      argValidator: () => false,
    }]]);
    assert.strictEqual(matchBlankShape('volume _', b)?.blankName, 'volume');
  });
});
