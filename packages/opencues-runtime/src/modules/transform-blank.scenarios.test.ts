// Scenario tests for the TransformBlank substitution path in resolver.ts.
//
// The runtime decides how to splice the LLM's rewrite back into the
// user's buffer. EXTRACT tells us what the TARGET was and where the
// TRIGGER phrase sat; the runtime computes the splice range and
// preserves everything outside it (separator, trailing content, the
// half on the other side of a sandwiched trigger, etc).
//
// Each test scripts the resolver's `_resolver.resolve` to return a
// fake CueResult shaped like what `transform-blank-source.ts` emits in
// production. We then assert what the buffer looks like after the
// substitution + (when relevant) which markdown.styled event fired.
//
// Companion to the runtime-level fix in resolver.ts (findSandwichedTarget
// + surgical splice logic) and the prompt-level fix in
// transform-blank-source.ts (P1_EXTRACT_SYSTEM rule 11 + sandwich
// layout). The benchmark in tests/benchmarks/transform-blank/ exercises
// the same scenarios against a live LLM; these tests pin the splice
// math without spending LLM tokens.

import { describe, expect, it } from 'vitest';
import { Resolver } from './resolver';
import { ConfigLoader } from './config-loader';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { MockAdapter } from '../../testing/mock-adapter';

const TIPS = JSON.stringify({ concepts: [] });
const CUES_MD = `---
name: test-cues
domain: test
version: 1
---
`;

interface ScriptedTransformResult {
  /** The full text the user typed (target + separator + trigger). */
  originalText: string;
  /** The LLM's rewrite of the TARGET only (may contain markdown markers). */
  rewrittenText: string;
  /** The TARGET string EXTRACT returned. */
  target: string;
  /** The INSTRUCTION string EXTRACT returned. */
  instruction: string;
}

function setupTransformScenario(s: ScriptedTransformResult) {
  const adapter = new MockAdapter({
    cwd: '/proj',
    files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD },
  });
  adapter.pushText(s.originalText);
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
  const wordCount = s.originalText.split(/\s+/).filter(Boolean).length;
  const blankWordIndex = Math.max(0, wordCount - 1);
  const resolver = new Resolver(adapter, hlState, dynDefs, loader, {
    endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {},
  });
  (resolver as unknown as { _resolver: { resolve(ctx: unknown): Promise<{ results: unknown[] }> } })._resolver = {
    resolve: async () => ({
      results: [{
        wordIndex: blankWordIndex,
        word: '_',
        alternatives: [s.originalText, s.rewrittenText],
        spanStart: 0,
        spanEnd: s.originalText.length,
        source: 'transform-blank',
        metadata: { transformTarget: s.target, transformInstruction: s.instruction },
      }],
    }),
  };
  // MockAdapter exposes a public .events array that emitEvent appends to.
  return { adapter, dynDefs, resolver, events: adapter.events };
}

describe('TransformBlank surgical splice — layout: instruction first', () => {
  it('replaces target after the trigger; preserves nothing before (typical case)', async () => {
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'change boy to girl _ the boy ran fast',
      rewrittenText: 'the girl ran fast',
      target: 'the boy ran fast',
      instruction: 'change boy to girl',
    });
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('the girl ran fast');
  });
});

describe('TransformBlank surgical splice — layout: instruction trailing', () => {
  it('preserves target before the trigger; removes the trigger phrase', async () => {
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'the boy ran fast change boy to girl _',
      rewrittenText: 'the girl ran fast',
      target: 'the boy ran fast',
      instruction: 'change boy to girl',
    });
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('the girl ran fast');
  });

  it('preserves the paragraph break (\\n\\n) between target and trigger', async () => {
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'hi my name is wilfred\n\nmake wilfred bold _',
      rewrittenText: 'hi my name is **wilfred**',
      target: 'hi my name is wilfred',
      instruction: 'make wilfred bold',
    });
    await resolver.resolveAndApply(adapter.getText());
    // Stripped buffer: "hi my name is wilfred" + "\n\n" preserved separator
    expect(adapter.getText()).toBe('hi my name is wilfred\n\n');
  });

  it('preserves a single newline (\\n) between target and trigger', async () => {
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'hi my name is wilfred\nmake wilfred bold _',
      rewrittenText: 'hi my name is **wilfred**',
      target: 'hi my name is wilfred',
      instruction: 'make wilfred bold',
    });
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('hi my name is wilfred\n');
  });

  it('preserves trailing user text after the trigger', async () => {
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'the boy ran fast change boy to girl _\nthen the family went home',
      rewrittenText: 'the girl ran fast',
      target: 'the boy ran fast',
      instruction: 'change boy to girl',
    });
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('the girl ran fast\nthen the family went home');
  });
});

describe('TransformBlank surgical splice — layout: sandwiched trigger', () => {
  it('joins two halves around a sandwiched trigger; bold marker applied', async () => {
    const { adapter, resolver, events } = setupTransformScenario({
      originalText: 'hi my name is wilfred\nmake wilfred bold _\nand I work on opencues',
      // APPLY returns both halves with markdown markers on the bold word.
      rewrittenText: 'hi my name is **wilfred**\nand I work on opencues',
      target: 'hi my name is wilfred\nand I work on opencues',
      instruction: 'make wilfred bold',
    });
    await resolver.resolveAndApply(adapter.getText());
    // Structural whitespace around the trigger LINE is preserved —
    // the trigger line itself becomes empty rather than disappearing.
    // Original layout was 3 lines (pt1 / trigger / pt2); new layout
    // keeps 3 lines (pt1 / empty / pt2).
    expect(adapter.getText()).toBe('hi my name is wilfred\n\nand I work on opencues');
    const styled = events.find(e => e.type === 'markdown.styled');
    expect(styled).toBeTruthy();
    // Bold range covers "wilfred" in the final buffer.
    expect(styled!.body!.bold).toEqual([{ start: 14, end: 21 }]);
  });

  it('handles paragraph-break-separated sandwich (target\\n\\ntrigger\\n\\ntarget)', async () => {
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'hi my name is wilfred\n\nmake wilfred bold _\n\nand I work on opencues',
      rewrittenText: 'hi my name is **wilfred**\n\nand I work on opencues',
      target: 'hi my name is wilfred\n\nand I work on opencues',
      instruction: 'make wilfred bold',
    });
    await resolver.resolveAndApply(adapter.getText());
    // Original was 5 lines (pt1, empty, trigger, empty, pt2). New is
    // also 5 lines (pt1, empty, empty-was-trigger, empty, pt2).
    expect(adapter.getText()).toBe('hi my name is wilfred\n\n\n\nand I work on opencues');
  });

  it('preserves the empty trigger line on a basic sandwich (no extra paragraph breaks)', async () => {
    // Reported bug: "when we remove a target and that is the only
    // thing on the line we 'lose' that line since its effectively
    // empty". The fix preserves the LINE — its content becomes empty
    // but the line break terminating it survives.
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'hi\n\nmake hi bold _\n\nworld',
      rewrittenText: '**hi**\nworld',
      target: 'hi\nworld',
      instruction: 'make hi bold',
    });
    await resolver.resolveAndApply(adapter.getText());
    // Original 5 lines (hi / "" / trigger / "" / world).
    // New 5 lines (hi / "" / "" (was-trigger) / "" / world).
    expect(adapter.getText()).toBe('hi\n\n\n\nworld');
  });
});

describe('TransformBlank surgical splice — fallback', () => {
  it('falls back to whole-body replace when target cannot be located', async () => {
    // LLM reworded the target heavily — EXTRACT's TARGET no longer
    // appears verbatim in originalText. Surgical splice can't compute
    // a range, so the buffer is replaced wholesale with the rewrite.
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'the boy ran fast change boy to girl _',
      rewrittenText: 'the girl ran fast',
      target: 'TOTALLY DIFFERENT TEXT THAT DOES NOT APPEAR',
      instruction: 'change boy to girl',
    });
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('the girl ran fast');
  });

  it('no metadata at all → whole-body replace', async () => {
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'a b c _',
      rewrittenText: 'rewritten',
      target: '',         // empty → no surgical attempt
      instruction: '',
    });
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('rewritten');
  });
});

describe('TransformBlank surgical splice — markdown.styled emission', () => {
  it('emits bold range in FINAL-buffer coords after splicing', async () => {
    const { adapter, resolver, events } = setupTransformScenario({
      originalText: 'before-prefix hi my name is wilfred make wilfred bold _',
      rewrittenText: 'hi my name is **wilfred**',
      target: 'hi my name is wilfred',
      instruction: 'make wilfred bold',
    });
    await resolver.resolveAndApply(adapter.getText());
    // Final buffer: "before-prefix " (14 chars) + "hi my name is wilfred" (21 chars).
    // Bold range over "wilfred" in stripped-rewrite coords = [14, 21];
    // shifted by preservedPrefix.length (14) → [28, 35] in final coords.
    expect(adapter.getText()).toBe('before-prefix hi my name is wilfred');
    const styled = events.find(e => e.type === 'markdown.styled');
    expect(styled).toBeTruthy();
    expect(styled!.body!.bold).toEqual([{ start: 28, end: 35 }]);
  });

  it('does not emit markdown.styled when rewrite has no markers', async () => {
    const { adapter, resolver, events } = setupTransformScenario({
      originalText: 'the boy ran fast change boy to girl _',
      rewrittenText: 'the girl ran fast',
      target: 'the boy ran fast',
      instruction: 'change boy to girl',
    });
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('the girl ran fast');
    expect(events.find(e => e.type === 'markdown.styled')).toBeFalsy();
  });
});

describe('TransformBlank surgical splice — user-corrected words via cycling', () => {
  it('does not revert a user-cycled spelling correction when the next transform fires', async () => {
    // Scenario from a real bug report: user typed "hhii", cycled Up to
    // accept the "hi" suggestion, then typed " my name is wilfred\n\n
    // make wilfred bold _". The asTyped view used to be reconstructed
    // by reverting EVERY non-transform-blank def to its originalWord —
    // so EXTRACT saw "hhii" again, APPLY rewrote with "hhii", and the
    // substitute pass overwrote the user's correction. Fix: only
    // revert agent-task defs in asTyped; user-driven cycles stay.
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD },
    });
    const visible = 'hi my name is wilfred\n\nmake wilfred bold _';
    adapter.pushText(visible);
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    // Simulate a user-accepted spelling correction: def for word 0
    // ("hi") with originalWord "hhii". A user-source def, blankName
    // intentionally NOT 'agent-task'.
    dynDefs.set(0, {
      originalWord: 'hhii',
      alternatives: ['hhii', 'hi'],
      currentIndex: 1,
      spanStart: 0,
      spanEnd: 2,
      blankName: 'spelling',
    });
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    const resolver = new Resolver(adapter, hlState, dynDefs, loader, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {},
    });
    (resolver as unknown as { _resolver: { resolve(ctx: { asTypedText?: string }): Promise<{ results: unknown[] }> } })._resolver = {
      resolve: async (ctx) => {
        // The asTyped view that reaches the LLM should reflect the
        // user's accepted "hi" — NOT the original "hhii". This is the
        // load-bearing assertion: ctx.asTypedText (when set by the
        // runtime's call site) must not contain "hhii".
        expect(ctx.asTypedText ?? '').not.toContain('hhii');
        return {
          results: [{
            wordIndex: 8,
            word: '_',
            alternatives: [visible, 'hi my name is **wilfred**'],
            spanStart: 0, spanEnd: visible.length,
            source: 'transform-blank',
            metadata: {
              transformTarget: 'hi my name is wilfred',
              transformInstruction: 'make wilfred bold',
            },
          }],
        };
      },
    };
    await resolver.resolveAndApply(visible);
    // Buffer ends up with the user's correction intact; bold applied.
    expect(adapter.getText()).toBe('hi my name is wilfred\n\n');
    const styled = adapter.events.find(e => e.type === 'markdown.styled');
    expect(styled).toBeTruthy();
    expect(styled!.body!.text).toBe('hi my name is wilfred\n\n');
  });
});

describe('TransformBlank rich-text — preserves prior markdown styling across transforms', () => {
  it('forwards markdown markers from MarkdownRender cache into the LLM EXTRACT input', async () => {
    // After a "make wilfred bold _" substitution, the visible buffer is
    // the stripped form. The next transform ("make it caps _") would
    // lose the bold without a rich-text view, because EXTRACT only
    // sees plain text. Pin that the resolver builds richText from the
    // markdownRender cache and the LLM receives the marker form.
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD },
    });
    const visible = 'hi my name is wilfred make it caps _';
    adapter.pushText(visible);
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });

    // Mock markdownRender carrying a cached payload from a prior
    // substitution: "hi my name is wilfred" with bold over "wilfred".
    const markdownRender = {
      getCachedPayload: () => ({
        text: 'hi my name is wilfred',
        bold: [{ start: 14, end: 21 }],
        italic: [], code: [], strike: [], heading: [], list: [],
      }),
    };
    const resolver = new Resolver(
      adapter, hlState, dynDefs, loader,
      { endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {} },
      undefined, undefined, undefined, markdownRender,
    );
    let capturedRichText: string | undefined;
    (resolver as unknown as { _resolver: { resolve(ctx: { richText?: string }): Promise<{ results: unknown[] }> } })._resolver = {
      resolve: async (ctx) => {
        capturedRichText = ctx.richText;
        return {
          results: [{
            wordIndex: 7, word: '_',
            alternatives: [visible, 'hi my name is **WILFRED**'],
            spanStart: 0, spanEnd: visible.length,
            source: 'transform-blank',
            metadata: {
              transformTarget: 'hi my name is **wilfred**',
              transformInstruction: 'make it caps',
            },
          }],
        };
      },
    };

    await resolver.resolveAndApply(visible);
    // richText should carry the **wilfred** markers, then the user's
    // suffix after the cached styled prefix.
    expect(capturedRichText).toBe('hi my name is **wilfred** make it caps _');
    // Substitute path: stripMarkdown on transformTarget → "hi my name is wilfred",
    // indexOf in visible finds it at 0, splice with the new rewrite (also markdown-aware).
    expect(adapter.getText()).toBe('hi my name is WILFRED');
    const styled = adapter.events.find(e => e.type === 'markdown.styled');
    expect(styled).toBeTruthy();
    // Bold range on "WILFRED" in the final stripped buffer (positions 14-21).
    expect(styled!.body!.bold).toEqual([{ start: 14, end: 21 }]);
  });

  it('forwards markers even when cached text carries trailing separator the user typed over', async () => {
    // Realistic chrome scenario: prior substitution wrote
    //   "hii my name is Wilfred\n\n"   (separator preserved by surgical splice)
    // and emitted markdown.styled with that exact text. The user then
    // typed over the trailing newlines, ending at "hii my name is
    // Wilfred make it caps _". A naïve startsWith on the full
    // cached.text would fail (the new buffer DOESN'T start with the
    // trailing-newline version). Pin that the cache lookup uses the
    // BODY (text up to the last styled range), so the marker view
    // still gets built and the LLM keeps the bold marker through caps.
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD },
    });
    const visible = 'hii my name is Wilfred make it caps _';
    adapter.pushText(visible);
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    // Cached text includes the preserved \n\n trailing — exactly what
    // applyMarkdownAwareSplice emits when the prior substitution
    // preserved the user's paragraph separator. The styled body is
    // "hii my name is Wilfred" (positions 0-22); the trailing `\n\n`
    // sits AFTER the last styled range.
    const markdownRender = {
      getCachedPayload: () => ({
        text: 'hii my name is Wilfred\n\n',
        bold: [{ start: 15, end: 22 }],
        italic: [], code: [], strike: [], heading: [], list: [],
      }),
    };
    const resolver = new Resolver(
      adapter, hlState, dynDefs, loader,
      { endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {} },
      undefined, undefined, undefined, markdownRender,
    );
    let capturedRichText: string | undefined;
    (resolver as unknown as { _resolver: { resolve(ctx: { richText?: string }): Promise<{ results: unknown[] }> } })._resolver = {
      resolve: async (ctx) => {
        capturedRichText = ctx.richText;
        return {
          results: [{
            wordIndex: 7, word: '_',
            alternatives: [visible, 'HII MY NAME IS **WILFRED**'],
            spanStart: 0, spanEnd: visible.length,
            source: 'transform-blank',
            metadata: {
              transformTarget: 'hii my name is **Wilfred**',
              transformInstruction: 'make it caps',
            },
          }],
        };
      },
    };
    await resolver.resolveAndApply(visible);
    // Body match against trailing-newline-stripped cached text means
    // the richText gets built using the body, with the user's suffix
    // appended.
    expect(capturedRichText).toBe('hii my name is **Wilfred** make it caps _');
    // Final buffer keeps bold on the now-uppercased name.
    expect(adapter.getText()).toBe('HII MY NAME IS WILFRED');
    const styled = adapter.events.find(e => e.type === 'markdown.styled');
    expect(styled).toBeTruthy();
    expect(styled!.body!.bold).toEqual([{ start: 15, end: 22 }]);
  });

  it('falls back to visible text when MarkdownRender has nothing cached', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD },
    });
    const visible = 'hi my name is wilfred make wilfred bold _';
    adapter.pushText(visible);
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    const markdownRender = { getCachedPayload: () => null };
    const resolver = new Resolver(
      adapter, hlState, dynDefs, loader,
      { endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {} },
      undefined, undefined, undefined, markdownRender,
    );
    let capturedRichText: string | undefined;
    (resolver as unknown as { _resolver: { resolve(ctx: { richText?: string }): Promise<{ results: unknown[] }> } })._resolver = {
      resolve: async (ctx) => {
        capturedRichText = ctx.richText;
        return {
          results: [{
            wordIndex: 7, word: '_',
            alternatives: [visible, 'hi my name is **wilfred**'],
            spanStart: 0, spanEnd: visible.length,
            source: 'transform-blank',
            metadata: { transformTarget: 'hi my name is wilfred', transformInstruction: 'make wilfred bold' },
          }],
        };
      },
    };
    await resolver.resolveAndApply(visible);
    expect(capturedRichText).toBeUndefined();
    expect(adapter.getText()).toBe('hi my name is wilfred');
  });
});

describe('TransformBlank surgical splice — cursor lands at end of new buffer', () => {
  it('cursor lands at end of buffer (past preserved trailing separators)', async () => {
    // The user typed at the trigger position (after `_`). The trigger
    // sat AFTER preserved structural whitespace (\n\n\n separator).
    // A targeted modification mustn't pull the caret BACKWARDS across
    // that structure — the user typed past it intentionally. Cursor
    // lands at end-of-buffer so the next keystroke continues from
    // where they were.
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'My name is wilfred\n\n\nMake wilfred caps _',
      rewrittenText: 'My name is **WILFRED**',
      target: 'My name is wilfred',
      instruction: 'Make wilfred caps',
    });
    await resolver.resolveAndApply(adapter.getText());
    // New buffer: "My name is WILFRED" + "\n\n\n" (separator preserved) = 21 chars.
    // Cursor at end of buffer = 21.
    expect(adapter.getText()).toBe('My name is WILFRED\n\n\n');
    expect(adapter.getCursorOffset()).toBe(adapter.getText().length);
  });

  it('cursor at end on the simple instruction-first case (no preserved separators)', async () => {
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'change boy to girl _ the boy ran fast',
      rewrittenText: 'the girl ran fast',
      target: 'the boy ran fast',
      instruction: 'change boy to girl',
    });
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getCursorOffset()).toBe(adapter.getText().length);
  });

  it('cursor lands at end even with preservedPrefix before the rewrite', async () => {
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'Note: the boy ran fast change boy to girl _',
      rewrittenText: 'the girl ran fast',
      target: 'the boy ran fast',
      instruction: 'change boy to girl',
    });
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('Note: the girl ran fast');
    expect(adapter.getCursorOffset()).toBe(adapter.getText().length);
  });
});

describe('TransformBlank surgical splice — DynDef shape', () => {
  it('alternatives[0] = original, alternatives[1] = final buffer (round-trip via cycle)', async () => {
    const { adapter, resolver, dynDefs } = setupTransformScenario({
      originalText: 'hi my name is wilfred\n\nmake wilfred bold _',
      rewrittenText: 'hi my name is **wilfred**',
      target: 'hi my name is wilfred',
      instruction: 'make wilfred bold',
    });
    await resolver.resolveAndApply(adapter.getText());
    expect(dynDefs.size).toBe(1);
    const def = [...dynDefs.entries()][0]?.[1];
    expect(def!.alternatives[0]).toBe('hi my name is wilfred\n\nmake wilfred bold _');
    expect(def!.alternatives[1]).toBe('hi my name is wilfred\n\n');
    expect(def!.currentIndex).toBe(1);
    expect(def!.blankName).toBe('transform-blank');
  });
});
