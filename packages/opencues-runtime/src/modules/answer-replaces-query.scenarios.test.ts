/**
 * Scenario tests for the Spotlight "answer replaces the question" journey.
 *
 * User journey this pins (mac host, Spotlight focused — ~37 visible
 * chars, no room for a question AND its answer):
 *   1. User types "capital of france _" into the Spotlight search field.
 *   2. The host reports getAnswerReplacesQuery() === true for that field.
 *   3. FluidBlank answers → the field reads exactly "Paris". The typed
 *      question is GONE, not trailing in front of the answer.
 *
 * Two halves are joined here on purpose:
 *   - the runtime half (adapter flag → CueContext → WIPE splice), and
 *   - the source half (`replaceQuerySpan` from @opencues/core, which
 *     decides WHICH range the wipe covers, imported rather than
 *     hard-coded so the two can't drift).
 *
 * The default host (no flag) keeps the non-destructive FILL behaviour —
 * pinned below, because that is the shape every other host relies on.
 */

import { describe, expect, it } from 'vitest';
import { replaceQuerySpan } from '@opencues/core';
import { Resolver } from './resolver';
import { ConfigLoader } from './config-loader';
import { HighlightState } from '../state/highlight-state';
import { DynDefs, type WordDef } from '../state/dyn-defs';
import { MockAdapter } from '../../testing/mock-adapter';
import type { HostAdapter } from '../adapter';

const TIPS = JSON.stringify({ concepts: [] });
const CUES_MD = `---
name: test-cues
domain: test
version: 1
---
`;

interface ScriptedResult {
  wordIndex: number;
  word: string;
  alternatives: string[];
  spanStart?: number;
  spanEnd?: number;
  source: string;
  priority?: number;
}

/** `replacesQuery` models the host's per-field answer: Spotlight true,
 *  TextEdit / CC / OC false (or the method absent entirely). */
function setupSpotlightScenario(initialText: string, replacesQuery: boolean | 'absent') {
  const adapter = new MockAdapter({
    hostName: 'mac',
    cwd: '/proj',
    files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD },
  });
  adapter.pushText(initialText);
  if (replacesQuery !== 'absent') {
    (adapter as HostAdapter).getAnswerReplacesQuery = () => replacesQuery;
  }
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
  const resolver = new Resolver(adapter, hlState, dynDefs, loader, {
    endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {},
  });
  let scripted: ScriptedResult[] = [];
  const contexts: Array<{ text: string; answerReplacesQuery?: boolean }> = [];
  (resolver as unknown as {
    _resolver: { resolve(ctx: unknown): Promise<{ results: ScriptedResult[] }> };
  })._resolver = {
    resolve: async (ctx: unknown) => {
      contexts.push(ctx as { text: string; answerReplacesQuery?: boolean });
      return { results: scripted };
    },
  };
  function scriptNext(results: ScriptedResult[]): void { scripted = results; }
  return { adapter, dynDefs, resolver, scriptNext, contexts };
}

/** What FluidBlankSource emits for this buffer given the host flag —
 *  span from the shared core helper, never hard-coded here. */
function fluidAnswer(text: string, answer: string, replacesQuery: boolean): ScriptedResult {
  const words = text.split(/\s+/).filter(Boolean);
  const span = replacesQuery ? replaceQuerySpan(text) : null;
  return {
    wordIndex: words.lastIndexOf('_'),
    word: '_',
    alternatives: ['_', answer],
    ...(span ? { spanStart: span[0], spanEnd: span[1] } : {}),
    source: 'fluid-blank',
    priority: 92,
  };
}

function findFluidBlankDef(dynDefs: DynDefs): WordDef | undefined {
  for (const [, def] of dynDefs.entries()) {
    if (def.blankName === 'fluid-blank') return def;
  }
  return undefined;
}

describe('Spotlight — the answer replaces the typed question', () => {
  it('wipes the question: "capital of france _" → "Paris"', async () => {
    const text = 'capital of france _';
    const { adapter, dynDefs, resolver, scriptNext } = setupSpotlightScenario(text, true);
    scriptNext([fluidAnswer(text, 'Paris', true)]);
    await resolver.resolveAndApply(adapter.getText());

    // The whole point: a 37-char field shows the answer, nothing else.
    expect(adapter.getText()).toBe('Paris');
    // The question is still recorded on the def (a cycling-capable host
    // could walk back to it; Spotlight can't, hence the source's guards).
    const def = findFluidBlankDef(dynDefs);
    expect(def!.alternatives).toEqual(['Paris', text]);
    expect(def!.spanStart).toBe(0);
    expect(def!.spanEnd).toBe('Paris'.length);
  });

  it('the host flag reaches the CueContext (and stays absent otherwise)', async () => {
    const on = setupSpotlightScenario('capital of france _', true);
    on.scriptNext([]);
    await on.resolver.resolveAndApply(on.adapter.getText());
    expect(on.contexts.at(-1)!.answerReplacesQuery).toBe(true);

    const off = setupSpotlightScenario('capital of france _', false);
    off.scriptNext([]);
    await off.resolver.resolveAndApply(off.adapter.getText());
    expect(off.contexts.at(-1)!.answerReplacesQuery).toBeUndefined();

    // A host that never implements the method behaves like `false`.
    const absent = setupSpotlightScenario('capital of france _', 'absent');
    absent.scriptNext([]);
    await absent.resolver.resolveAndApply(absent.adapter.getText());
    expect(absent.contexts.at(-1)!.answerReplacesQuery).toBeUndefined();
  });

  it('a normal host keeps the question and fills only the `_`', async () => {
    const text = 'capital of france _';
    const { adapter, resolver, scriptNext } = setupSpotlightScenario(text, false);
    scriptNext([fluidAnswer(text, 'Paris', false)]);
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('capital of france Paris');
  });

  it('multi-line buffer is never wiped, even with the flag on', async () => {
    // The source-side guard: a newline means the buffer is the user's own
    // content, so no span is emitted and the resolver fills the gap.
    const text = 'shopping list\ncapital of france _';
    const { adapter, resolver, scriptNext } = setupSpotlightScenario(text, true);
    scriptNext([fluidAnswer(text, 'Paris', true)]);
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('shopping list\ncapital of france Paris');
  });

  it('mid-sentence `_` fills in place, even with the flag on', async () => {
    const text = 'water boils at _ degrees';
    const { adapter, resolver, scriptNext } = setupSpotlightScenario(text, true);
    scriptNext([fluidAnswer(text, '100', true)]);
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('water boils at 100 degrees');
  });

  it('a follow-up question in the same field wipes again (no stacking)', async () => {
    const first = 'capital of france _';
    const { adapter, resolver, scriptNext } = setupSpotlightScenario(first, true);
    scriptNext([fluidAnswer(first, 'Paris', true)]);
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('Paris');

    // User clears the field and asks something else (Spotlight's normal
    // rhythm — Esc, retype). The second answer must stand alone too.
    adapter.pushText('capital of spain _');
    scriptNext([fluidAnswer('capital of spain _', 'Madrid', true)]);
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('Madrid');
  });
});
