/**
 * Buffer calculators through BlankFill: a METRIC fills after the text and
 * keeps its label; an INLINE transform (`slug for X _`) is a normal fill
 * over its own argument; a BUFFER transform (`title case _`, `sort lines
 * _`) replaces the text before the command; a parameterised metric (`count
 * of the _`) reads the buffer and its parameter. Real BLANK.md, real
 * TablesBlank (no stub), synthetic prose.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { BlankFill } from '../../modules/blank-fill';
import { ConfigLoader } from '../../modules/config-loader';
import { MockAdapter } from '../../../testing/mock-adapter';
import { TablesBlank } from '../tables';
import { createBlankInvoke } from '../index';

const TIPS = JSON.stringify({ concepts: [] });
const TABLES_MD = readFileSync(resolvePath(__dirname, '../../../../../defaults/blanks/tables/BLANK.md'), 'utf8');

async function setup(text: string) {
  const adapter = new MockAdapter({
    cwd: '/proj',
    files: { '/mock/CUES.md': TIPS, '/proj/blanks/tables/BLANK.md': TABLES_MD, '/proj/OPENCUES.md': '---\ntable-lookups-mode: on\n---\n' },
    capabilities: ['render-override', 'dim-ranges', 'highlight-range', 'file-read', 'file-write', 'force-render', 'change-source', 'blank-invoke'],
  });
  // the real blank behind blankInvoke
  const invoke = createBlankInvoke(new Map([['tables', new TablesBlank()]]));
  (adapter as unknown as { blankInvoke: typeof invoke }).blankInvoke = invoke;
  const loader = new ConfigLoader(adapter, { settingsFile: '/proj/OPENCUES.md' });
  await loader.load();
  const bf = new BlankFill(adapter, loader);
  bf.subscribe();
  adapter.pushText(text);
  await new Promise((r) => setTimeout(r, 30));
  return adapter;
}
const last = (a: MockAdapter) => a.setTextCalls.at(-1) ?? a.getText();

describe('buffer calculators through BlankFill', () => {
  it('a metric fills after the text and keeps its label', async () => {
    const a = await setup('Zorb the flumph sat on a blorp. It hummed.\nword count _');
    expect(last(a)).toBe('Zorb the flumph sat on a blorp. It hummed.\nword count 9 words · 42 chars · 2 sentences · ~2 s read');
  });
  it('a parameterised metric reads the buffer and its parameter', async () => {
    const a = await setup('the zorb and the flumph and the blorp.\ncount of the _');
    expect(last(a)).toBe('the zorb and the flumph and the blorp.\nthe ×3');
  });
  it('an inline transform is a normal fill over its own argument', async () => {
    const a = await setup('notes so far. slug for My Zorb Post Part 2 _');
    expect(last(a)).toBe('notes so far. my-zorb-post-part-2');
  });
  it('a buffer transform replaces the text before the command', async () => {
    const a = await setup('the zorb of the flumph\ntitle case _');
    expect(last(a)).toBe('The Zorb of the Flumph');
  });
  it('a line transform keeps its lines (single answer, not alternatives)', async () => {
    const a = await setup('blorp\nzorb\nflumph\nsort lines _');
    expect(last(a)).toBe('blorp\nflumph\nzorb');
    const b = await setup('zorb\nflumph\nnumber the lines _');
    expect(last(b)).toBe('1. zorb\n2. flumph');
  });
  it('a transform keeps paragraph breaks and indent (the card is the whole text, not its non-empty lines)', async () => {
    const a = await setup('zorb flumph\n\n  blorp zorb\n\nflumph\nupper case _');
    expect(last(a)).toBe('ZORB FLUMPH\n\n  BLORP ZORB\n\nFLUMPH');
  });
  it('a wrap with its column parameter', async () => {
    const a = await setup('zorb flumph blorp zorb flumph blorp\nwrap at 12 _');
    expect(last(a)).toBe('zorb flumph\nblorp zorb\nflumph blorp');
  });
  it('an inline encoding round-trips', async () => {
    const a = await setup('base64 for zorb _');
    expect(last(a)).toBe('em9yYg==');
    const b = await setup('decode base64 em9yYg== _');
    expect(last(b)).toBe('zorb');
  });
  it('a transform with nothing before it declines with its miss, never an empty buffer', async () => {
    const a = await setup('title case _');
    expect(last(a)).toBe('title case [err] nothing to case');
  });
  it('an inline parameter form (`repeat 3 times for ab`) reaches the calculator with an empty buffer', async () => {
    const a = await setup('repeat 3 times for ab _');
    expect(last(a)).toBe('ababab');
    const b = await setup('random number between 1 and 1 _');
    expect(last(b)).toBe('1');
  });
  it('a keyword in prose with no shape match is NOT a claim: claimedSlotIndices() is empty, so the `_` router stays in play', async () => {
    // `ex vat` is a tables keyword; without a number leading the segment the shape does not match. Before this,
    // the resolver read the raw scan() slot as keyword-bound → no route request for the `_`.
    const a = await setup("what's 120 ex vat _");
    expect(a.blankInvokeCalls).toHaveLength(0);
    const loader = new ConfigLoader(a, { settingsFile: '/proj/OPENCUES.md' });
    await loader.load();
    const bf = new BlankFill(a, loader);
    expect(bf.claimedSlotIndices("what's 120 ex vat _")).toEqual([]);
    expect(bf.claimedSlotIndices('120 ex vat _')).toEqual([3]);
  });
  it('prose using a transform word is not claimed', async () => {
    for (const text of ['please reverse the decision _', 'sort of tired _', 'the slug crawled _', 'repeat after me _']) {
      const a = await setup(text);
      expect(a.getText(), text).toBe(text);
    }
  });
});
