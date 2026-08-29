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
  it('alternatives[0] = final buffer, alternatives[1] = original (reverse-chronological)', async () => {
    const { adapter, resolver, dynDefs } = setupTransformScenario({
      originalText: 'hi my name is wilfred\n\nmake wilfred bold _',
      rewrittenText: 'hi my name is **wilfred**',
      target: 'hi my name is wilfred',
      instruction: 'make wilfred bold',
    });
    await resolver.resolveAndApply(adapter.getText());
    expect(dynDefs.size).toBe(1);
    const def = [...dynDefs.entries()][0]?.[1];
    // alts[0] = the rewrite BODY (current visible), with TRAILING whitespace
    // trimmed so the def's span doesn't cover the editor's empty tail lines —
    // otherwise a trailing edit (space / newline / continuing to type) breaks
    // slice(0,spanEnd)===alt[0] and the def is dropped then re-resolved (the
    // "transform span dies on a trailing edit" flicker). alts[1] = the original
    // prompt body (cycle Up reverts).
    expect(def!.alternatives[0]).toBe('hi my name is wilfred');
    expect(def!.alternatives[1]).toBe('hi my name is wilfred\n\nmake wilfred bold _');
    expect(def!.currentIndex).toBe(0);
    expect(def!.blankName).toBe('transform-blank');
    // The span ends at the body, NOT the buffer length — the trailing "\n\n"
    // stays in the buffer but OUTSIDE the span (matches how sentence-cues trim).
    expect(def!.spanEnd).toBe('hi my name is wilfred'.length);
    expect(adapter.getText()).toBe('hi my name is wilfred\n\n');
    // The invariant that makes the def robust: the buffer sliced to the span
    // equals alt[0], so a trailing edit is "after the span" and doesn't break it.
    expect(adapter.getText().slice(def!.spanStart, def!.spanEnd)).toBe(def!.alternatives[0]);
  });
});

// Fused / whole-buffer substitute path — the LLM owns the complete
// rewritten buffer (FULL_REWRITE). Source emits no `transformTarget`
// metadata, so the runtime takes the three-way-merge branch instead of
// the surgical splice. Pins the structural fix for the May 2026
// long-body duplication bug class.
function setupFusedWholeBuffer(originalText: string, fullRewrite: string) {
  const adapter = new MockAdapter({
    cwd: '/proj',
    files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD },
  });
  adapter.pushText(originalText);
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
  const wordCount = originalText.split(/\s+/).filter(Boolean).length;
  const blankWordIndex = Math.max(0, wordCount - 1);
  const resolver = new Resolver(adapter, hlState, dynDefs, loader, {
    endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {},
  });
  (resolver as unknown as { _resolver: { resolve(ctx: unknown): Promise<{ results: unknown[] }> } })._resolver = {
    resolve: async () => ({
      results: [{
        wordIndex: blankWordIndex,
        word: '_',
        alternatives: [originalText, fullRewrite],
        spanStart: 0,
        spanEnd: originalText.length,
        source: 'transform-blank',
        // No transformTarget — runtime takes the whole-buffer / threeWayMerge path.
        metadata: { pipelineMode: 'fused', transformInstruction: 'noop' },
      }],
    }),
  };
  return { adapter, dynDefs, resolver };
}

describe('TransformBlank fused / whole-buffer — duplication-bug structural fix', () => {
  it('long-body rewrite: no body duplication even when rewrite ≈ original length', async () => {
    // The May 2026 modify-resignation-letter bug: FUSED emitted a narrow
    // TARGET ("Dear [Manager's Name],") but a wide REWRITE covering the
    // whole letter. Old splice path concat-tailed the rest of originalText
    // → 538-char buffer with body appearing twice. With FULL_REWRITE
    // contract + threeWayMerge, the LLM-emitted rewrite IS the whole
    // buffer; there's no concat tail to overrun.
    const originalText = 'replace [Your Name] with Wilfred _ Dear [Manager\'s Name],\n\nI am writing to formally resign from my position at [Company]. My last day will be [Date]. Sincerely,\n[Your Name]';
    const fullRewrite = 'Dear [Manager\'s Name],\n\nI am writing to formally resign from my position at [Company]. My last day will be [Date]. Sincerely,\nWilfred';
    const { adapter } = setupFusedWholeBuffer(originalText, fullRewrite);
    await (adapter as unknown as { events: unknown[] });
    const { resolver } = setupFusedWholeBuffer(originalText, fullRewrite);
    await resolver.resolveAndApply(originalText);
  });

  it('whole-buffer replace lands exactly the LLM rewrite (no tail concat)', async () => {
    const originalText = 'change boy to girl _ the boy ran fast\nand the boy was happy\nand the boy slept';
    // LLM emits the whole rewritten buffer with instruction phrase deleted.
    const fullRewrite = 'the girl ran fast\nand the girl was happy\nand the girl slept';
    const { adapter, resolver } = setupFusedWholeBuffer(originalText, fullRewrite);
    await resolver.resolveAndApply(originalText);
    expect(adapter.getText()).toBe(fullRewrite);
  });

  it('trailing whitespace is trimmed from the span, so a trailing edit does NOT drop the def', async () => {
    // The live bug: an editor buffer ends in empty lines ("\n\n\n"). The
    // whole-buffer transform used to set spanEnd = bufferText.length, so the
    // span COVERED those newlines and alt[0] INCLUDED them. Then the user
    // presses space / adds a line / keeps typing after the result → the chars
    // inside the span change → slice(0,spanEnd) != alt[0] → STALE → the def is
    // DROPPED then re-resolved (the "transform span dies on a trailing edit"
    // flicker). Sentence-cues never had this because they trim to their
    // sentence. This pins the matching trim on the transform def.
    const originalText = 'make it formal _\n\n\n';
    const fullRewrite = 'Good day to you.\n\n\n';
    const { adapter, dynDefs, resolver } = setupFusedWholeBuffer(originalText, fullRewrite);
    await resolver.resolveAndApply(originalText);
    expect(dynDefs.size).toBe(1);
    const def = [...dynDefs.entries()][0]?.[1];
    expect(def!.blankName).toBe('transform-blank');
    // Span + alt[0] exclude the trailing newlines (they stay in the buffer).
    expect(def!.alternatives[0]).toBe('Good day to you.');
    expect(def!.spanEnd).toBe('Good day to you.'.length);
    const buffer = adapter.getText();
    expect(buffer).toBe('Good day to you.\n\n\n');
    expect(buffer.slice(def!.spanStart, def!.spanEnd)).toBe(def!.alternatives[0]);

    // Now the actual repro: user types a trailing space (an edit AFTER the
    // span). slideCharSpans must keep it, pruneStale must keep it — the def
    // survives instead of dying + re-resolving.
    const edited = buffer + ' ';
    dynDefs.slideCharSpans(buffer, edited);
    dynDefs.pruneStale(edited.split(/\s+/).filter(Boolean).map(word => ({ word })));
    expect(dynDefs.size).toBe(1); // NOT dropped
    const after = [...dynDefs.entries()][0]?.[1];
    expect(after!.blankName).toBe('transform-blank');
    expect(edited.slice(after!.spanStart, after!.spanEnd)).toBe(after!.alternatives[0]);
  });

  it('pathological LLM rewrite that contains duplicated body still produces the LLM output, not a concat', async () => {
    // Even if the LLM emits a buggy duplicated rewrite, the runtime never
    // appends originalText[tail:] on top of it — the merge path applies
    // diff hunks against the live buffer, so the worst case is the LLM's
    // own (possibly bad) full rewrite. Critically, it's NOT ~2× the body
    // length from a concat-tail accident.
    const originalText = 'capitalize _ hello world';
    // Buggy LLM: emitted the same content twice.
    const buggyFullRewrite = 'HELLO WORLD HELLO WORLD';
    const { adapter, resolver } = setupFusedWholeBuffer(originalText, buggyFullRewrite);
    await resolver.resolveAndApply(originalText);
    // The buffer is exactly the LLM's (buggy) output — no further
    // concatenation. Production benches now show this failure mode is
    // ~rare (84%+ accuracy on default providers); when it does happen,
    // the user sees the LLM's bad output but never a SPLICE-INDUCED
    // duplication that's strictly longer than what the LLM emitted.
    expect(adapter.getText()).toBe(buggyFullRewrite);
    expect(adapter.getText().length).toBeLessThanOrEqual(buggyFullRewrite.length);
  });

  it('preserves in-flight user typing past the trigger via three-way-merge', async () => {
    // User typed "change boy to girl _" then started typing " and look".
    // The resolver was called against the pre-typing snapshot. By the
    // time we substitute, the live buffer has more content than the
    // snapshot. threeWayMerge applies the LLM hunks to the live buffer,
    // preserving the user's in-flight typing.
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD },
    });
    const snapshot = 'change boy to girl _ the boy ran';
    const liveAtSubstituteTime = 'change boy to girl _ the boy ran and looked around';
    adapter.pushText(liveAtSubstituteTime);
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    const resolver = new Resolver(adapter, hlState, dynDefs, loader, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {},
    });
    const fullRewrite = 'the girl ran';
    (resolver as unknown as { _resolver: { resolve(ctx: unknown): Promise<{ results: unknown[] }> } })._resolver = {
      resolve: async () => ({
        results: [{
          wordIndex: 6, word: '_',
          alternatives: [snapshot, fullRewrite],
          spanStart: 0, spanEnd: snapshot.length,
          source: 'transform-blank',
          metadata: { pipelineMode: 'fused', transformInstruction: 'change boy to girl' },
        }],
      }),
    };
    // resolveAndApply uses adapter.getText() as the live text, runs the
    // resolver (which returns snapshot+fullRewrite), then merges. The
    // user's " and looked around" suffix survives because it sits past
    // the LLM hunk's region.
    await resolver.resolveAndApply(liveAtSubstituteTime);
    // The merged buffer keeps the user's in-flight typing as a suffix.
    expect(adapter.getText().endsWith('looked around')).toBe(true);
  });
});

// ─── Regression: tip entry for `_` must not block LLM blanks ───────────
//
// Bug history (2026-05-28): the resolver's tip-suppression filter (a
// word-cue rule that defers to hand-curated tips over LLM synonyms)
// was applied to every result including blank substitutions. The shell
// integration's `tips-shell/CUE.md` contained an explanatory tip entry
// for `_` itself (alts=["blank","fill","underscore"]). On every shell
// session, EVERY TransformBlank / FluidBlank / ConfigIntent
// substitution silently skipped with no log line — because
// `target.word === "_"` had a cueMap entry with >1 alt, the resolver
// `continue`'d before reaching the substitute branch.
//
// The fix exempts both LLM blank sources AND any target whose word is
// `_` from the tip-suppression rule. These two tests pin both halves.
// Don't relax either guard.
describe('TransformBlank — tip entry for `_` must not block substitution', () => {
  it('substitutes through even when the cueMap has a tip on `_` with multi-alt', async () => {
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'draft an email _',
      rewrittenText: 'hello landlord email body',
      target: '',
      instruction: 'draft an email',
    });
    // Plant a tip on `_` matching what tips-shell/CUE.md once shipped —
    // the exact shape that bottomed the original silent-skip.
    interface CueLoaderMutable { lookup(word: string): { alternatives: string[] } | null }
    const loaderUnsafe = (resolver as unknown as { configLoader: CueLoaderMutable }).configLoader;
    const realLookup = loaderUnsafe.lookup.bind(loaderUnsafe);
    loaderUnsafe.lookup = (w: string) => {
      if (w === '_') return { alternatives: ['_', 'blank', 'fill', 'underscore'] };
      return realLookup(w);
    };
    await resolver.resolveAndApply(adapter.getText());
    // Buffer must have been rewritten — no silent skip.
    expect(adapter.getText()).toBe('hello landlord email body');
  });

  it('still suppresses LLM word-cue results when the target word has a hand-curated tip', async () => {
    // The exemption is narrow: ONLY LLM blanks (and the `_` target)
    // bypass tip-suppression. A word-cue claiming an unrelated word
    // (e.g. "ultrathink") that the user has a tip for must still
    // defer to the curated alts.
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD },
    });
    adapter.pushText('i want to ultrathink this');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    const resolver = new Resolver(adapter, hlState, dynDefs, loader, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {},
    });
    interface CueLoaderMutable { lookup(word: string): { alternatives: string[] } | null }
    const loaderUnsafe = loader as unknown as CueLoaderMutable;
    loaderUnsafe.lookup = (w: string) =>
      w === 'ultrathink' ? { alternatives: ['ultrathink', 'tab', 'think harder'] } : null;
    (resolver as unknown as { _resolver: { resolve(ctx: unknown): Promise<{ results: unknown[] }> } })._resolver = {
      resolve: async () => ({
        results: [{
          wordIndex: 3,
          word: 'ultrathink',
          alternatives: ['ultrathink', 'deeply consider', 'meticulously reason'],
          source: 'word-cues',
        }],
      }),
    };
    await resolver.resolveAndApply(adapter.getText());
    // Word-cue's LLM alternatives must NOT override the hand-curated
    // tip — dynDefs should be empty at this index (suppression fired).
    expect(dynDefs.get(3)).toBeUndefined();
  });
});

// ─── replace-parse geometry: a SMALL target with words between it and the
// trigger ────────────────────────────────────────────────────────────────
//
// Every scenario above comes from the retired 3-pass EXTRACT, whose target
// was the whole non-trigger body — so target and trigger were always
// ADJACENT and the gap between them was always pure whitespace. The splice
// stripped both edges of that gap and always appended it after the rewrite,
// and in that one shape both choices are invisible.
//
// `replace-parse-mode` (#420) drives the same branch with a target that is a
// FEW CHARACTERS inside a longer sentence, which makes a gap with real words
// in it the common case. These pin the two things that then matter: the
// surviving word boundary, and which side of the rewrite the gap belongs on.
describe('TransformBlank surgical splice — layout: replace-parse (small target)', () => {
  it('keeps the word boundary when text sits between target and trigger', async () => {
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'her name is Sarha in the invite fix the spelling _',
      rewrittenText: 'Sarah',
      target: 'Sarha',
      instruction: 'fix the spelling',
    });
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('her name is Sarah in the invite');
  });

  it('re-orders nothing when the trigger comes FIRST', async () => {
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'uppercase it _ the ticker is aapl',
      rewrittenText: 'AAPL',
      target: 'aapl',
      instruction: 'uppercase it',
    });
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('the ticker is AAPL');
  });

  it('still closes the gap when target and trigger ARE adjacent', async () => {
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'her name is Sarha fix the spelling _',
      rewrittenText: 'Sarah',
      target: 'Sarha',
      instruction: 'fix the spelling',
    });
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('her name is Sarah');
  });

  it('leaves punctuation in the gap exactly where it was', async () => {
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'ship it to eu-west-1 today, make that frankfurt _',
      rewrittenText: 'eu-central-1',
      target: 'eu-west-1',
      instruction: 'make that frankfurt',
    });
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('ship it to eu-central-1 today,');
  });

  it('preserves a newline in the gap rather than treating it as a boundary', async () => {
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'oven at 425F\nfor the lamb make that celsius _',
      rewrittenText: '220C',
      target: '425F',
      instruction: 'make that celsius',
    });
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('oven at 220C\nfor the lamb');
  });
});
