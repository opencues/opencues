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

// ---------------------------------------------------------------------------
// The terminal/no-ambient WIPE journey. Before core 0.55.0, FluidBlank's
// WIPE gate required a host to declare `singleLine`/`disposable`; no native
// host adapter (Claude Code, OpenCode, gemini-cli, shell) does that, so a
// bare terminal lookup like the README's ffmpeg example always FILLed —
// the ask stayed on screen and only `_` was replaced. Core 0.55.0 added a
// second path: `bufferIsExactlyTheLookup` + the model's own MODE vote, no
// host declaration required (see fluid-blank-source.ts's WIPE gate +
// docs/architecture/blank-sources.md § WIPE gate). This scenario doesn't
// re-test THAT decision — it's unit-pinned in @opencues/core's
// fluid-blank-source.test.ts — it pins what happens AFTER the decision:
// does the resolver splice, register, and let the user cycle back exactly
// like any other WIPE, on a buffer that carries no ambient context at all
// (setupChainScenario passes none — the terminal shape).
// ---------------------------------------------------------------------------
describe('fluid-blank WIPE with no host ambient declaration (the terminal/CLI path)', () => {
  it('WIPEs a bare terminal lookup end-to-end, and cycling back restores the original ask', async () => {
    const ask = 'ffmpeg command to convert a video to web-ready mp4 _';
    const answer = 'ffmpeg -i input.mov -vcodec libx264 -crf 23 -pix_fmt yuv420p -acodec aac output.mp4';
    const { adapter, dynDefs, resolver, scriptNext } = setupChainScenario(ask);
    scriptNext([fluidWipe(ask, answer)]);
    await resolver.resolveAndApply(adapter.getText());

    // The whole line was replaced — the ask is gone, not left sitting
    // above the answer the way a FILL would leave it.
    expect(adapter.getText()).toBe(answer);

    const def = findFluidBlankDef(dynDefs);
    expect(def).toBeDefined();
    expect(def!.spanStart).toBe(0);
    expect(def!.spanEnd).toBe(answer.length);
    // alts[0] = the answer now on screen; alts[1] = the original ask,
    // reachable by cycling — same reverse-chronological convention every
    // other fluid-blank WIPE uses, regardless of which gate path fired.
    expect(def!.alternatives).toEqual([answer, ask]);
    expect(def!.currentIndex).toBe(0);

    // Cycle back (Up, in the runtime's convention) — the user should land
    // on their original terminal command, byte-for-byte, not a mangled or
    // partially-restored line.
    rewriteDef(dynDefs, def!, { currentIndex: 1 });
    const cycled = findFluidBlankDef(dynDefs);
    expect(cycled!.alternatives[cycled!.currentIndex]).toBe(ask);
  });
});

// ---------------------------------------------------------------------------
// FILL splice widening — the "restated clause" fix (core 0.55.0's
// findRestatedClauseSpan). Confirmed as a LIVE bug against real providers
// while validating the WIPE-gate work above, not a hypothetical: a compact
// factual sentence like "there are _ oceans on earth" gets answered with
// the FULL restated clause ("there are 5 oceans on earth") per FluidBlank's
// own ANSWER RULE 5. FILL's old behaviour spliced that answer at just the
// `_` character — this scenario pins what that actually produced before the
// fix (duplicated words) and what it produces after (spanStart/spanEnd
// widen to the verified span, same splice path WIPE already uses, still
// tagged FILL). See fluid-blank-source.ts's findRestatedClauseSpan doc
// comment and fluid-blank-source.test.ts's "FILL splice widening" suite for
// the source-level pin; this is the resolver-level confirmation.
// ---------------------------------------------------------------------------
describe('fluid-blank FILL splice widening (restated-clause fix)', () => {
  it('a restated-clause FILL answer replaces the whole span, not just `_` — no duplicated words', async () => {
    const ask = 'there are _ oceans on earth';
    const answer = 'there are 5 oceans on earth';
    const { adapter, dynDefs, resolver, scriptNext } = setupChainScenario(ask);
    // Same fixture shape as fluidWipe (spanStart/spanEnd set) — the
    // resolver's isMultiWordSpan branch keys off spanStart being a number,
    // not off any WIPE-specific flag, so a widened FILL routes identically.
    // Unlike fluidWipe, `source` stays 'fluid-blank' with no WIPE-only
    // metadata — this fixture only exists to prove the splice range, not
    // to re-test the WIPE gate itself.
    scriptNext([{
      wordIndex: blankWordIndex(ask),
      word: '_',
      alternatives: ['_', answer],
      spanStart: 0,
      spanEnd: ask.length,
      source: 'fluid-blank',
      priority: 92,
    }]);
    await resolver.resolveAndApply(adapter.getText());

    // The pre-fix bug: splicing at just `_` (target.start/target.end,
    // ignoring the wider span) produced "there are there are 5 oceans on
    // earth oceans on earth". This must not happen.
    expect(adapter.getText()).toBe(answer);
    expect(adapter.getText()).not.toMatch(/there are.*there are/i);

    const def = findFluidBlankDef(dynDefs);
    expect(def).toBeDefined();
    expect(def!.spanStart).toBe(0);
    expect(def!.spanEnd).toBe(answer.length);
    // Cycling back still restores the original ask byte-for-byte — the
    // widened splice doesn't change the cycling contract.
    expect(def!.alternatives).toEqual([answer, ask]);
    rewriteDef(dynDefs, def!, { currentIndex: 1 });
    const cycled = findFluidBlankDef(dynDefs);
    expect(cycled!.alternatives[cycled!.currentIndex]).toBe(ask);
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
