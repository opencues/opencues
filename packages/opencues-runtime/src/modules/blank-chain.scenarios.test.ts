/**
 * Scenario tests for sequential LLM-blank substitutions building a
 * walkable chain in WordDef.alternatives.
 *
 * User journey this pins:
 *   1. User types "hello world translate to japanese _"
 *   2. FluidBlank/TransformBlank fires → buffer becomes "こんにちは世界"
 *   3. User appends " translate to chinese _"
 *   4. Same pipeline fires → buffer becomes "你好世界"
 *   5. For fluid-blank, pressing Up should walk back through history
 *      one step at a time (reverse-chronological — newest first):
 *      你好世界 → "こんにちは世界 translate to chinese _" → こんにちは世界
 *      → "hello world translate to japanese _". Matches the convention
 *      every other blank type uses (alts[0] = baseline, alts[1+] =
 *      forward-cycle targets).
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
  it('captures the user\'s question alongside the answer (reverse-chronological)', async () => {
    const { adapter, dynDefs, resolver, scriptNext } = setupChainScenario(
      'translate hello to japanese _',
    );
    scriptNext([fluidWipe('translate hello to japanese _', 'こんにちは')]);
    await resolver.resolveAndApply(adapter.getText());

    expect(adapter.getText()).toBe('こんにちは');
    const def = findFluidBlankDef(dynDefs);
    expect(def).toBeDefined();
    // alts[0] = current visible (the answer); alts[1] = the prompt the
    // user typed. Up-arrow advances to alts[1] (revert to prompt). This
    // matches the convention every other blank type uses: alts[0] =
    // baseline, alts[1+] = forward-cycle targets.
    expect(def!.alternatives[0]).toBe('こんにちは');
    expect(def!.alternatives[1]).toBe('translate hello to japanese _');
    expect(def!.currentIndex).toBe(0);
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
    // Chain depth 4, reverse-chronological — newest at index 0 so
    // pressing Up walks back through history one step at a time:
    //   [newest answer, newest question, prior answer, original prompt]
    expect(def!.alternatives).toEqual([
      '你好',
      'こんにちは translate to chinese _',
      'こんにちは',
      'translate hello to japanese _',
    ]);
    expect(def!.currentIndex).toBe(0);
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
    // Fresh def — no japanese in the chain. Reverse-chronological:
    // answer first, question second.
    expect(def!.alternatives).toEqual([
      '你好',
      'hola translate to chinese _',
    ]);
    expect(def!.currentIndex).toBe(0);
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

    // User cycles Up twice to land on "こんにちは" (index 2 in the new
    // reverse-chronological ['你好', q2, 'こんにちは', q1]) then re-summons.
    const def = findFluidBlankDef(dynDefs);
    expect(def).toBeDefined();
    // Simulate the cycled state — production code does this via applyAltCycle,
    // but we set it directly to keep the test focused on truncate semantics.
    rewriteDef(dynDefs, def!, {
      currentIndex: 2,
      spanStart: 0,
      spanEnd: 'こんにちは'.length,
    });
    adapter.pushText('こんにちは translate to korean _');
    scriptNext([fluidWipe('こんにちは translate to korean _', '안녕하세요')]);
    await resolver.resolveAndApply(adapter.getText());

    const finalDef = findFluidBlankDef(dynDefs);
    expect(finalDef).toBeDefined();
    // Abandoned head ["你好", "こんにちは translate to chinese _"] (items
    // newer than where the user cycled to) was discarded; the new branch
    // ["안녕하세요", "こんにちは translate to korean _"] is prepended.
    expect(finalDef!.alternatives).toEqual([
      '안녕하세요',
      'こんにちは translate to korean _',
      'こんにちは',
      'translate hello to japanese _',
    ]);
    expect(finalDef!.currentIndex).toBe(0);
  });

  it('chains across a multi-word answer (spanEnd covers the WHOLE answer, not just the first word)', async () => {
    // Pre-fix regression: fluid-blank set spanEnd to the END OF THE
    // FIRST WORD of the substitute. For a single-word answer that
    // happens to be correct; for a multi-word answer like "William
    // Shakespeare" at start=0, spanEnd was 7 (end of "William") rather
    // than 19 (end of "Shakespeare"). The next substitute's chain
    // verbatim check (`liveText.slice(spanStart, spanEnd) === currentAlt`)
    // then compared "William " against "William Shakespeare" and bailed,
    // dropping the first link from the chain.
    const { adapter, dynDefs, resolver, scriptNext } = setupChainScenario(
      'who wrote hamlet _',
    );
    scriptNext([fluidWipe('who wrote hamlet _', 'William Shakespeare')]);
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('William Shakespeare');

    const firstDef = findFluidBlankDef(dynDefs);
    expect(firstDef).toBeDefined();
    // spanEnd MUST cover the whole "William Shakespeare" answer.
    expect(firstDef!.spanStart).toBe(0);
    expect(firstDef!.spanEnd).toBe('William Shakespeare'.length);

    // Second substitute wraps the answer in a new lookup phrase. With the
    // bug, this would create a FRESH def (chain broken); with the fix,
    // the chain extends.
    adapter.pushText('William Shakespeare year of birth _');
    scriptNext([fluidWipe('William Shakespeare year of birth _', '1564')]);
    await resolver.resolveAndApply(adapter.getText());

    const def = findFluidBlankDef(dynDefs);
    expect(def).toBeDefined();
    expect(def!.alternatives).toEqual([
      '1564',
      'William Shakespeare year of birth _',
      'William Shakespeare',
      'who wrote hamlet _',
    ]);
    expect(def!.currentIndex).toBe(0);
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
    // Reverse-chronological — newest at index 0 so pressing Up walks
    // back through history one step at a time. Matches fluid-blank
    // and every other blank type (alts[0] = current visible).
    expect(def!.alternatives).toEqual([
      '你好',
      'こんにちは translate to chinese _',
      'こんにちは',
      'translate hello to japanese _',
    ]);
    expect(def!.currentIndex).toBe(0);
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
    // fresh fluid-blank (chinese substitute). The fluid-blank def is
    // reverse-chronological — alts[0] = answer, alts[1] = question —
    // no japanese leaked in.
    const transformDef = findTransformBlankDef(dynDefs);
    const fluidDef = findFluidBlankDef(dynDefs);
    expect(fluidDef).toBeDefined();
    expect(fluidDef!.alternatives).toEqual([
      '你好',
      'こんにちは translate to chinese _',
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
