// A spelling result emitted by the session rail (the decision-layer
// passenger, Jev plan step 7B) must register exactly like the shipped
// spelling word-cue: the typed word first, the correction second,
// `cueSource: 'spelling'` so the note leads with ✍️ and the hint says
// "(underscore to correct)", and never a splice.
import { describe, expect, it } from 'vitest';
import { Resolver } from './resolver';
import { ConfigLoader } from './config-loader';
import { HighlightState } from '../state/highlight-state';
import { DynDefs, inlineNoteHint } from '../state/dyn-defs';
import { MockAdapter } from '../../testing/mock-adapter';

const TIPS = JSON.stringify({ concepts: [] });
const CUES_MD = `---
name: test-cues
domain: test
version: 1
---
`;

describe('Resolver — a spelling result from the session rail', () => {
  it('registers as a spelling word-cue with the correct hint, no splice', async () => {
    const adapter = new MockAdapter({ cwd: '/proj', files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD } });
    adapter.pushTextNoKeystroke('alpha zephr beta');
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    const dynDefs = new DynDefs();
    const resolver = new Resolver(adapter, new HighlightState(), dynDefs, loader, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {},
    });
    (resolver as unknown as Record<string, unknown>)._resolver = {
      resolve: async () => ({ results: [{ wordIndex: 1, word: 'zephr', alternatives: ['zephyr'], source: 'spelling', priority: 10, confidence: 0.93 }] }),
    };
    await resolver.resolveAndApply('alpha zephr beta');
    const def = dynDefs.get(1)!;
    expect(def).toBeDefined();
    expect(def.alternatives).toEqual(['zephr', 'zephyr']);
    expect(def.cueSource).toBe('spelling');
    expect(inlineNoteHint(def, { actuator: false, dismissable: false, forgetOffer: false, suppressed: false })).toBe('(underscore to correct)');
    expect(adapter.setTextCalls).toEqual([]);
  });
});
