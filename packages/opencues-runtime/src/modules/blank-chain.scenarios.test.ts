/**
 * Scenario tests for sequential LLM-blank substitutions building a
 * walkable chain in WordDef.alternatives.
 *
 * User journey this pins:
 *   1. User types "hello world translate to japanese _"
 *   2. FluidBlank/TransformBlank fires → buffer becomes "こんにちは世界"
 *   3. User appends " translate to chinese _"
 *   4. Same pipeline fires → buffer becomes "你好世界"
 *   5. Pressing Down should walk: 你好世界 → "こんにちは世界 translate to
 *      chinese _" → こんにちは世界 → "hello world translate to japanese _"
 *
 * Before this feature, step 4 clobbered the def from step 2 — the
 * japanese waypoint and the original english prompt were both lost.
 * Now `dyn-defs.findChainableLlmDef` detects that the prior result
 * sits verbatim inside the new substitute's span and the resolver
 * extends the alternatives list instead of replacing.
 *
 * Invalidation rules pinned here:
 *   - User edit inside the prior result → chain breaks (verbatim check
 *     fails) → fresh def, no chain.
 *   - User cycled mid-chain before re-summoning → abandoned tail is
 *     truncated (alt-history equivalent of git branch).
 *   - Different pipelines don't graft (fluid → transform stays
 *     independent).
 */

import { describe, expect, it } from 'vitest';
import { Resolver } from './resolver';
import { ConfigLoader } from './config-loader';
import { HighlightState } from '../state/highlight-state';
import { DynDefs, type WordDef } from '../state/dyn-defs';
import { MockAdapter } from '../../testing/mock-adapter';

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
  source: 'fluid-blank' | 'transform-blank';
  priority?: number;
  metadata?: Record<string, unknown>;
}

function setupChainScenario(initialText: string) {
  const adapter = new MockAdapter({
    cwd: '/proj',
    files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD },
  });
  adapter.pushText(initialText);
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
  const resolver = new Resolver(adapter, hlState, dynDefs, loader, {
    endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {},
  });
  let scripted: ScriptedResult[] = [];
  (resolver as unknown as { _resolver: { resolve(ctx: unknown): Promise<{ results: ScriptedResult[] }> } })._resolver = {
    resolve: async () => ({ results: scripted }),
  };
  function scriptNext(results: ScriptedResult[]): void { scripted = results; }
  return { adapter, dynDefs, resolver, scriptNext };
}

// Locate the `_` token's word index — production FluidBlankSource uses
// this as result.wordIndex so the resolver's `target = wordSpans[
// r.wordIndex]` lands on the `_` and the synonym filter
// `a !== target.word` correctly drops the literal "_" from alternatives.
function blankWordIndex(currentText: string): number {
  const words = currentText.split(/\s+/).filter(Boolean);
  const idx = words.lastIndexOf('_');
  return idx >= 0 ? idx : 0;
}

// Build a fluid-blank WIPE-mode result that replaces the entire current
// buffer text with `answer`.
function fluidWipe(currentText: string, answer: string): ScriptedResult {
  return {
    wordIndex: blankWordIndex(currentText),
    word: '_',
    alternatives: ['_', answer],
    spanStart: 0,
    spanEnd: currentText.length,
    source: 'fluid-blank',
    priority: 92,
  };
}

function transformWhole(currentText: string, rewritten: string): ScriptedResult {
  return {
    wordIndex: blankWordIndex(currentText),
    word: '_',
    alternatives: [currentText, rewritten],
    spanStart: 0,
    spanEnd: currentText.length,
    source: 'transform-blank',
    priority: 93,
    // No transformTarget set — drives the whole-body merge path
    metadata: { transformInstruction: 'translate' },
  };
}

describe('fluid-blank chain — sequential WIPE substitutions', () => {
  it('captures the user\'s question as alternatives[0] (not just "_")', async () => {
    const { adapter, dynDefs, resolver, scriptNext } = setupChainScenario(
      'translate hello to japanese _',
    );
    scriptNext([fluidWipe('translate hello to japanese _', 'こんにちは')]);
    await resolver.resolveAndApply(adapter.getText());

    expect(adapter.getText()).toBe('こんにちは');
    const def = findFluidBlankDef(dynDefs);
    expect(def).toBeDefined();
    // Down-arrow target = the prompt the user typed, not a bare "_".
    expect(def!.alternatives[0]).toBe('translate hello to japanese _');
    expect(def!.alternatives[1]).toBe('こんにちは');
    expect(def!.currentIndex).toBe(1);
  });

  it('extends the chain when a second WIPE encompasses the first result', async () => {
    const { adapter, dynDefs, resolver, scriptNext } = setupChainScenario(
      'translate hello to japanese _',
    );
    scriptNext([fluidWipe('translate hello to japanese _', 'こんにちは')]);
    await resolver.resolveAndApply(adapter.getText());

    // User appends a chinese translate prompt on top of the japanese result.
    adapter.pushText('こんにちは translate to chinese _');
    scriptNext([fluidWipe('こんにちは translate to chinese _', '你好')]);
    await resolver.resolveAndApply(adapter.getText());

    expect(adapter.getText()).toBe('你好');
    const def = findFluidBlankDef(dynDefs);
    expect(def).toBeDefined();
    // Chain depth 4: [original english prompt, japanese result,
    //                 mid-chain question, chinese result]
    expect(def!.alternatives).toEqual([
      'translate hello to japanese _',
      'こんにちは',
      'こんにちは translate to chinese _',
      '你好',
    ]);
    expect(def!.currentIndex).toBe(3);
  });

  it('does NOT extend when the prior result was edited inside (verbatim check fails)', async () => {
    const { adapter, dynDefs, resolver, scriptNext } = setupChainScenario(
      'translate hello to japanese _',
    );
    scriptNext([fluidWipe('translate hello to japanese _', 'こんにちは')]);
    await resolver.resolveAndApply(adapter.getText());

    // User edits the substituted text itself — they CHOSE different content.
    // The previous chain entry's currentAlt ("こんにちは") is no longer at the
    // recorded span; the chain must reset.
    adapter.pushText('hola translate to chinese _');
    scriptNext([fluidWipe('hola translate to chinese _', '你好')]);
    await resolver.resolveAndApply(adapter.getText());

    const def = findFluidBlankDef(dynDefs);
    expect(def).toBeDefined();
    // Fresh def — no japanese in the chain.
    expect(def!.alternatives).toEqual([
      'hola translate to chinese _',
      '你好',
    ]);
    expect(def!.currentIndex).toBe(1);
  });

  it('truncates the abandoned tail when the user cycled mid-chain before re-summoning', async () => {
    const { adapter, dynDefs, resolver, scriptNext } = setupChainScenario(
      'translate hello to japanese _',
    );
    scriptNext([fluidWipe('translate hello to japanese _', 'こんにちは')]);
    await resolver.resolveAndApply(adapter.getText());

    adapter.pushText('こんにちは translate to chinese _');
    scriptNext([fluidWipe('こんにちは translate to chinese _', '你好')]);
    await resolver.resolveAndApply(adapter.getText());

    // User cycles back to "こんにちは" (currentIndex 1) then re-summons.
    const def = findFluidBlankDef(dynDefs);
    expect(def).toBeDefined();
    // Simulate the cycled state — production code does this via applyAltCycle,
    // but we set it directly to keep the test focused on truncate semantics.
    rewriteDef(dynDefs, def!, {
      currentIndex: 1,
      spanStart: 0,
      spanEnd: 'こんにちは'.length,
    });
    adapter.pushText('こんにちは translate to korean _');
    scriptNext([fluidWipe('こんにちは translate to korean _', '안녕하세요')]);
    await resolver.resolveAndApply(adapter.getText());

    const finalDef = findFluidBlankDef(dynDefs);
    expect(finalDef).toBeDefined();
    // Tail "[こんにちは translate to chinese _, 你好]" was discarded;
    // new branch "[こんにちは translate to korean _, 안녕하세요]" took its place.
    expect(finalDef!.alternatives).toEqual([
      'translate hello to japanese _',
      'こんにちは',
      'こんにちは translate to korean _',
      '안녕하세요',
    ]);
    expect(finalDef!.currentIndex).toBe(3);
  });
});

describe('transform-blank chain — sequential whole-buffer rewrites', () => {
  it('extends the chain when a second transform-blank fires on the prior result', async () => {
    const { adapter, dynDefs, resolver, scriptNext } = setupChainScenario(
      'translate hello to japanese _',
    );
    scriptNext([transformWhole('translate hello to japanese _', 'こんにちは')]);
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('こんにちは');

    adapter.pushText('こんにちは translate to chinese _');
    scriptNext([transformWhole('こんにちは translate to chinese _', '你好')]);
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('你好');

    const def = findTransformBlankDef(dynDefs);
    expect(def).toBeDefined();
    expect(def!.alternatives).toEqual([
      'translate hello to japanese _',
      'こんにちは',
      'こんにちは translate to chinese _',
      '你好',
    ]);
    expect(def!.currentIndex).toBe(3);
  });

  it('does NOT graft a fluid-blank onto a transform-blank chain', async () => {
    const { adapter, dynDefs, resolver, scriptNext } = setupChainScenario(
      'translate hello to japanese _',
    );
    scriptNext([transformWhole('translate hello to japanese _', 'こんにちは')]);
    await resolver.resolveAndApply(adapter.getText());

    adapter.pushText('こんにちは translate to chinese _');
    scriptNext([fluidWipe('こんにちは translate to chinese _', '你好')]);
    await resolver.resolveAndApply(adapter.getText());

    // Two independent defs: one transform-blank (japanese chain), one
    // fresh fluid-blank (chinese substitute). The fluid-blank's alts[0]
    // = the question; alts[1] = 你好 — no japanese leaked in.
    const transformDef = findTransformBlankDef(dynDefs);
    const fluidDef = findFluidBlankDef(dynDefs);
    expect(fluidDef).toBeDefined();
    expect(fluidDef!.alternatives).toEqual([
      'こんにちは translate to chinese _',
      '你好',
    ]);
    // The transform-blank def may have been pruned (its span [0, 'こんにちは'.length)
    // overlaps the fluid-blank wipe range). What we care about: NO chain merge.
    if (transformDef) {
      expect(transformDef.alternatives).not.toContain('你好');
    }
  });
});

// Locate the canonical fluid-blank def in the map. Sequential WIPE
// substitutes produce at most one entry; this surfaces it without
// hard-coding a word index that shifts as the chain grows.
function findFluidBlankDef(dynDefs: DynDefs): WordDef | undefined {
  for (const [, def] of dynDefs.entries()) {
    if (def.blankName === 'fluid-blank') return def;
  }
  return undefined;
}

function findTransformBlankDef(dynDefs: DynDefs): WordDef | undefined {
  for (const [, def] of dynDefs.entries()) {
    if (def.blankName === 'transform-blank') return def;
  }
  return undefined;
}

// WordDef.alternatives + currentIndex are readonly at the type level,
// so simulating "user cycled to alt N" requires deleting + re-inserting
// the def with the cycled state. Mirrors what applyAltCycle does at the
// observable level (currentIndex bump + span recompute).
function rewriteDef(dynDefs: DynDefs, def: WordDef, patch: Partial<WordDef>): void {
  for (const [idx, d] of dynDefs.entries()) {
    if (d === def) {
      dynDefs.delete(idx);
      dynDefs.set(idx, { ...def, ...patch } as WordDef);
      return;
    }
  }
}
