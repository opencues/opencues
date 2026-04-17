import { describe, expect, it } from 'vitest';
import { BlankFill } from './blank-fill';
import { ConfigLoader } from './config-loader';
import { MockAdapter } from '../../testing/mock-adapter';

const TIPS = JSON.stringify({ concepts: [] });

const VOLUME_CUE = `---
type: control
name: volume
control: volume
script: ./volume.sh
upArgs: ["up", "6"]
downArgs: ["down", "6"]
blankKeywords: volume, vol, sound, audio
---
`;

const AFFIRM_CUE = `---
type: control
name: affirmations
blankKeywords: affirmation, affirm
stepValues: ["I am strong", "I am brave"]
---
`;

const PROMPT_CUE = `---
type: control
name: prompt
blankKeywords: improve prompt, write prompt, prompt
blankProximity: 0
---
`;

async function setup(text: string) {
  const adapter = new MockAdapter({
    cwd: '/proj',
    files: {
      '/tips.json': TIPS,
      '/proj/controls/volume/cue.md': VOLUME_CUE,
      '/proj/controls/affirmations/cue.md': AFFIRM_CUE,
      '/proj/controls/prompt/cue.md': PROMPT_CUE,
    },
  });
  adapter.pushText(text);
  const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
  await loader.load();
  const bf = new BlankFill(adapter, loader);
  bf.subscribe();
  return { adapter, loader, bf };
}

describe('BlankFill detection (Step 23)', () => {
  it('matches single-word keyword: "affirm _" → affirmations', async () => {
    const { bf } = await setup('affirm _');
    const slots = bf.scan('affirm _');
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      index: 1,
      keyword: 'affirm',
      controlName: 'affirmations',
      keywordStart: 0,
      keywordEnd: 0,
      proximity: 0,
    });
  });

  it('matches multi-word keyword: "improve prompt _"', async () => {
    const { bf } = await setup('improve prompt _');
    const slots = bf.scan('improve prompt _');
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      index: 2,
      keyword: 'improve prompt',
      controlName: 'prompt',
      keywordStart: 0,
      keywordEnd: 1,
      proximity: 0,
    });
  });

  it('no match when no keyword precedes _', async () => {
    const { bf } = await setup('the cat _ sat');
    expect(bf.scan('the cat _ sat')).toHaveLength(0);
  });

  it('detects multiple slots in one input', async () => {
    const { bf } = await setup('affirm _ improve prompt _');
    const slots = bf.scan('affirm _ improve prompt _');
    expect(slots).toHaveLength(2);
    expect(slots.map(s => s.controlName)).toEqual(['affirmations', 'prompt']);
  });

  it('honours blankProximity: prompt requires keyword adjacent to _', async () => {
    // "prompt for image _" — keyword "prompt" is 2 words away (> 0). No match.
    const { bf } = await setup('prompt for image _');
    expect(bf.scan('prompt for image _')).toHaveLength(0);
    // Same setup but adjacent — "prompt _" → matches.
    expect(bf.scan('prompt _')).toHaveLength(1);
  });

  it('matches synonyms: vol / sound / audio all map to volume', async () => {
    const { bf } = await setup('vol _');
    expect(bf.scan('vol _')[0]?.controlName).toBe('volume');
    expect(bf.scan('sound _')[0]?.controlName).toBe('volume');
    expect(bf.scan('audio _')[0]?.controlName).toBe('volume');
  });

  it('case-insensitive keyword matching', async () => {
    const { bf } = await setup('Volume _');
    expect(bf.scan('Volume _')[0]?.controlName).toBe('volume');
  });

  it('subscribe re-scans on text change', async () => {
    const { adapter, bf } = await setup('hello');
    expect(bf.slots).toHaveLength(0);
    adapter.pushText('affirm _');
    expect(bf.slots).toHaveLength(1);
    expect(bf.slots[0].controlName).toBe('affirmations');
  });
});
