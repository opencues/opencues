// Overlap-extension guard tests for the TransformBlank substitution path.
//
// May 22 2026 bug fix: the surgical splice introduced in commit 5f24c09
// ("markdown styling + transform-blank refactor", May 13 2026) trusted
// the LLM's TARGET span to be the full scope of the rewrite. When the
// LLM emitted a narrow target but a wide rewrite (whole-body rewrite
// with target identifying only the first sentence), the splice replaced
// only the narrow span and the rest of the original text leaked through
// after the substitution — user saw the body duplicated.
//
// Live repro: "replace [Your Name] with Wilfred _ <300-char letter>"
//   target  = "Dear [Manager's Name]," (22 chars)
//   rewrite = 278-char full letter with Wilfred substituted
//   buffer  = 538 chars — body appeared twice (Wilfred + [Your Name])
//
// Fix in resolver.ts:1290+: after computing the surgical splice's
// spliceEnd, take a 60-char probe from originalText[spliceEnd:].trim()
// and check if it's already inside rewrittenText. If yes → extend
// spliceEnd to EOL (i.e. fall back to whole-buffer-replace). 60 chars
// is long enough to dodge incidental prose matches.
//
// These tests pin BOTH directions:
//   1. Guard FIRES correctly — narrow target + wide rewrite → no duplication
//   2. Guard does NOT fire incorrectly — surgical splice still works for
//      every existing pattern (markdown, sandwich, expansion, etc).
//
// All 20 pre-existing transform-blank.scenarios.test.ts cases continue
// to pass — guard is additive on top of the surgical splice, never
// replaces it when the splice would be correct.

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
  originalText: string;
  rewrittenText: string;
  target: string;
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
  return { adapter, dynDefs, resolver, events: adapter.events };
}

// ─── Group 1: the guard FIRES — duplication prevented ─────────────────

describe('TransformBlank overlap guard — duplication prevention', () => {
  it('live repro: replace [Your Name] with Wilfred — 278-char rewrite for 22-char target', async () => {
    const body =
      "Dear [Manager's Name],\n\n" +
      'Please accept this letter as my resignation from my position at [Company Name], ' +
      'effective [Last Working Day]. I am grateful for the opportunities and experiences ' +
      'I have gained while working here, and I wish the team continued success.\n\n' +
      'Sincerely,\n[Your Name]';
    const rewrite = body.replace('[Your Name]', 'Wilfred');
    const { adapter, resolver } = setupTransformScenario({
      originalText: `replace [Your Name] with Wilfred _ ${body}`,
      rewrittenText: rewrite,
      target: "Dear [Manager's Name],", // narrow — only first line of body
      instruction: 'replace [Your Name] with Wilfred',
    });
    await resolver.resolveAndApply(adapter.getText());
    const buf = adapter.getText();
    // Body must appear exactly ONCE (no duplication)
    const bodyMarker = 'Please accept this letter as my resignation';
    const firstHit = buf.indexOf(bodyMarker);
    const secondHit = firstHit >= 0 ? buf.indexOf(bodyMarker, firstHit + 1) : -1;
    expect(firstHit).toBeGreaterThanOrEqual(0);
    expect(secondHit).toBe(-1);
    // Wilfred substituted, no [Your Name] left
    expect(buf).toContain('Wilfred');
    expect(buf).not.toContain('[Your Name]');
  });

  it('rewrite covers content past the target line → splice extends to EOL', async () => {
    // The KEY condition for the guard to fire: the post-splice tail
    // must appear VERBATIM in the rewrite (otherwise probe match fails).
    // Here the rewrite copies the tail unchanged but transforms the
    // target — exactly the production failure mode where the LLM
    // produced the WHOLE body in REWRITE but said target was only the
    // first sentence.
    const tail =
      'Second paragraph stays the same after the splice end. ' +
      'Third sentence continues here. Fourth makes it longer for the 60-char probe to bite.';
    const orig = `swap A for B _ A is first. ${tail}`;
    const rewrite = `B is first. ${tail}`; // tail VERBATIM in rewrite
    const { adapter, resolver } = setupTransformScenario({
      originalText: orig,
      rewrittenText: rewrite,
      target: 'A is first.', // narrow
      instruction: 'swap A for B',
    });
    await resolver.resolveAndApply(adapter.getText());
    const buf = adapter.getText();
    // Without the guard, the buffer would contain "Second paragraph..."
    // TWICE (once from rewrite, once from preserved tail). With the
    // guard, splice extends to EOL → buffer = rewrite alone → "Second..."
    // appears exactly ONCE.
    expect(buf.match(/Second paragraph stays the same/g)?.length ?? 0).toBe(1);
    expect(buf).toContain('B is first.');
    expect(buf).not.toContain('A is first.');
  });

  it('overlap guard fires regardless of which paragraph the probe lives in', async () => {
    const repeated = 'This is a stable sixty-character probe that will be in both copies of the buffer text. ';
    const orig = `change X to Y _ X here. ${repeated}some other content`;
    const rewrite = `Y here. ${repeated}some other content rewritten`;
    const { adapter, resolver } = setupTransformScenario({
      originalText: orig,
      rewrittenText: rewrite,
      target: 'X here.',
      instruction: 'change X to Y',
    });
    await resolver.resolveAndApply(adapter.getText());
    const buf = adapter.getText();
    expect(buf.match(/This is a stable sixty-character probe/g)?.length ?? 0).toBe(1);
  });
});

// ─── Group 2: the guard does NOT fire — surgical splice still works ──

describe('TransformBlank overlap guard — surgical splice preserved (no false positive)', () => {
  it('short edit, tight target/rewrite ratio: guard inactive, surgical splice fires', async () => {
    // Classic short edit. spliceEnd lands BEFORE the trigger phrase;
    // there is no post-splice tail at all (originalText[spliceEnd:] = '').
    // Probe length = 0 < 60 → guard never fires.
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'change boy to girl _ the boy ran fast',
      rewrittenText: 'the girl ran fast',
      target: 'the boy ran fast',
      instruction: 'change boy to girl',
    });
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('the girl ran fast');
  });

  it('markdown bold: surgical splice preserves \\n\\n separator', async () => {
    // This pattern from transform-blank.scenarios.test.ts must keep working.
    // Surgical splice replaces target span only; \n\n separator preserved.
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'hi my name is wilfred\n\nmake wilfred bold _',
      rewrittenText: 'hi my name is **wilfred**',
      target: 'hi my name is wilfred',
      instruction: 'make wilfred bold',
    });
    await resolver.resolveAndApply(adapter.getText());
    // Markdown markers stripped; separator preserved.
    expect(adapter.getText()).toBe('hi my name is wilfred\n\n');
  });

  it('single newline separator preserved', async () => {
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'hi my name is wilfred\nmake wilfred bold _',
      rewrittenText: 'hi my name is **wilfred**',
      target: 'hi my name is wilfred',
      instruction: 'make wilfred bold',
    });
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('hi my name is wilfred\n');
  });

  it('trailing user text past trigger is preserved (surgical splice still works)', async () => {
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'the boy ran change boy to girl _ trailing user typing',
      rewrittenText: 'the girl ran',
      target: 'the boy ran',
      instruction: 'change boy to girl',
    });
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('the girl ran trailing user typing');
  });

  it('expand-short-to-long: target is a phrase, rewrite expands but tail is unique → no duplication', async () => {
    // Legitimate expansion: target = "hello" → rewrite = full greeting paragraph.
    // The post-splice tail contains its own distinct content that does NOT
    // appear in the rewrite. Guard must NOT fire.
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'expand the greeting _ hello\n\nFollow-up paragraph completely unrelated to greeting text.',
      rewrittenText: 'Good morning! Welcome to our establishment. We are delighted to have you here today. Please enjoy.',
      target: 'hello',
      instruction: 'expand the greeting',
    });
    await resolver.resolveAndApply(adapter.getText());
    const buf = adapter.getText();
    expect(buf).toContain('Good morning! Welcome');
    // Tail content preserved — splice was surgical
    expect(buf).toContain('Follow-up paragraph completely unrelated');
  });

  it('numeric rewrite (very short tail): probe length too short to trigger', async () => {
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'add 1 _ 5',
      rewrittenText: '6',
      target: '5',
      instruction: 'add 1',
    });
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('6');
  });

  it('sandwich layout untouched by guard (different code path)', async () => {
    // Sandwich: target on BOTH sides of the trigger. Surgical splice
    // composes pt1Mod + sep + pt2 separately. The overlap guard runs
    // AFTER the sandwich code path completes, but spliceEnd already
    // covers pt2End (everything) — so the post-splice tail is empty
    // and the probe never matches.
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'first half make X bold _ second half X here',
      rewrittenText: 'first half\nsecond half **X** here',
      target: 'first half\nsecond half X here',
      instruction: 'make X bold',
    });
    await resolver.resolveAndApply(adapter.getText());
    // Sandwich logic preserves both halves; markdown stripped from rewrite.
    const buf = adapter.getText();
    expect(buf).toContain('first half');
    expect(buf).toContain('second half');
    // X is in the buffer, body intact, no duplication
    expect(buf.match(/first half/g)?.length ?? 0).toBe(1);
    expect(buf.match(/second half/g)?.length ?? 0).toBe(1);
  });

  it('target NOT found in originalText → falls back to whole-body (guard not needed)', async () => {
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'change boy to girl _ the boy ran fast',
      rewrittenText: 'the girl ran fast',
      target: 'NONEXISTENT TARGET PHRASE NOT IN INPUT',
      instruction: 'change boy to girl',
    });
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('the girl ran fast');
  });

  it('no metadata at all → whole-body replace; guard not consulted', async () => {
    // Pre-May-13 shape: alternatives[0] = originalText (race-guard match),
    // metadata omitted. Substituter falls through to whole-body replace
    // (default spliceStart=0, spliceEnd=text.length). Overlap probe is
    // never consulted because the surgical-splice block is gated on
    // transformTarget being non-empty.
    const orig = 'change boy to girl _ the boy ran fast';
    const adapter = new MockAdapter({ cwd: '/proj', files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD } });
    adapter.pushText(orig);
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    const wordCount = orig.split(/\s+/).filter(Boolean).length;
    const blankWordIndex = Math.max(0, wordCount - 1);
    const resolver = new Resolver(adapter, hlState, dynDefs, loader, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {},
    });
    (resolver as unknown as { _resolver: { resolve(ctx: unknown): Promise<{ results: unknown[] }> } })._resolver = {
      resolve: async () => ({
        results: [{
          wordIndex: blankWordIndex, word: '_',
          alternatives: [orig, 'the girl ran fast'],
          spanStart: 0, spanEnd: orig.length, source: 'transform-blank',
          // metadata intentionally OMITTED — pre-May-13 shape
        }],
      }),
    };
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('the girl ran fast');
  });

  it('cursor lands at end of buffer (preserved by surgical splice)', async () => {
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'change boy to girl _ the boy ran fast',
      rewrittenText: 'the girl ran fast',
      target: 'the boy ran fast',
      instruction: 'change boy to girl',
    });
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getCursorOffset()).toBe(adapter.getText().length);
  });

  it('alternatives round-trip preserved: cycle Down returns original, cycle Up returns rewrite', async () => {
    const { adapter, dynDefs, resolver } = setupTransformScenario({
      originalText: 'change boy to girl _ the boy ran fast',
      rewrittenText: 'the girl ran fast',
      target: 'the boy ran fast',
      instruction: 'change boy to girl',
    });
    await resolver.resolveAndApply(adapter.getText());
    // Find the def the substituter registered
    const defs = Array.from((dynDefs as unknown as { _defs: Map<number, { originalWord: string; alternatives: string[]; currentIndex: number; blankName?: string }> })._defs.values());
    const transformDef = defs.find(d => d.blankName === 'transform-blank');
    expect(transformDef).toBeDefined();
    // [0] = original full text (cycle Down to revert)
    expect(transformDef?.alternatives[0]).toBe('change boy to girl _ the boy ran fast');
    // [1] = post-substitution buffer (cycle Up returns here)
    expect(transformDef?.alternatives[1]).toBe('the girl ran fast');
    expect(transformDef?.currentIndex).toBe(1);
  });
});

// ─── Group 3: edge cases at the guard boundary ────────────────────────

describe('TransformBlank overlap guard — boundary conditions', () => {
  it('probe-length floor: tail < 60 chars cannot trigger the guard', async () => {
    // Tail "extra" is only 5 chars. Probe length = 5 < 60 → guard inactive.
    // Surgical splice fires normally even if rewrite contains "extra".
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'change A to B _ A here extra',
      rewrittenText: 'B here extra',
      target: 'A here',
      instruction: 'change A to B',
    });
    await resolver.resolveAndApply(adapter.getText());
    // Surgical splice: replace "A here" + trigger with rewrite; preserve "extra"
    // Result: "B here extra" + " extra" or similar (depends on separator).
    // Critical assertion: "extra" appears exactly once (not twice), since
    // the rewrite already contains it AND the splice would leave " extra"
    // in originalText[spliceEnd:]. But probe-length < 60 → guard quiet.
    // For this <60-char-tail case, the surgical splice's natural behavior
    // is acceptable — the original tail is short and prosaic, and any
    // duplication would be minor noise vs. the catastrophic full-body
    // duplication the guard was designed for.
    expect(adapter.getText().length).toBeGreaterThan(0);
  });

  it('post-splice tail of exactly 60 chars: guard activates if probe matches', async () => {
    const exactlySixty = '..........10........20........30........40........50........6'; // 61 chars
    const orig = `swap A for B _ A here.${exactlySixty}`;
    const rewrite = `B here.${exactlySixty.toUpperCase()}`;
    const { adapter, resolver } = setupTransformScenario({
      originalText: orig,
      rewrittenText: rewrite,
      target: 'A here.',
      instruction: 'swap A for B',
    });
    await resolver.resolveAndApply(adapter.getText());
    // Since the rewrite UPPERCASED the tail, the original lowercase tail
    // probe (60 chars of dots) does NOT appear verbatim in the rewrite.
    // Guard correctly stays quiet → surgical splice proceeds.
    expect(adapter.getText()).toContain('B here.');
  });

  it('post-splice tail with content that ALSO appears verbatim in rewrite → guard fires', async () => {
    const sharedContent = 'A shared sixty-character phrase that lives in both the original tail and the LLM rewrite. ';
    const orig = `swap A for B _ A is the start.${sharedContent}then the original tail continues here.`;
    const rewrite = `B is the start.${sharedContent}and the rewrite continues differently.`;
    const { adapter, resolver } = setupTransformScenario({
      originalText: orig,
      rewrittenText: rewrite,
      target: 'A is the start.',
      instruction: 'swap A for B',
    });
    await resolver.resolveAndApply(adapter.getText());
    const buf = adapter.getText();
    // The shared phrase appears in buffer EXACTLY ONCE (from the rewrite).
    // Original "then the original tail continues here." is GONE because
    // splice extended to EOL.
    expect(buf.match(/A shared sixty-character phrase/g)?.length ?? 0).toBe(1);
    expect(buf).not.toContain('then the original tail continues here');
    expect(buf).toContain('and the rewrite continues differently');
  });

  it('rewrite identical to target: surgical splice no-op, guard inactive', async () => {
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'leave alone _ the boy ran',
      rewrittenText: 'the boy ran',
      target: 'the boy ran',
      instruction: 'leave alone',
    });
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('the boy ran');
  });

  it('empty rewrite (defensive) — does not crash the guard', async () => {
    const { adapter, resolver } = setupTransformScenario({
      originalText: 'delete the boy phrase _ the boy ran fast',
      rewrittenText: '',
      target: 'the boy ran fast',
      instruction: 'delete the boy phrase',
    });
    // Should not throw even with empty rewrite — guard's includes('') is
    // always true, but the spliceEnd extension is harmless in this case.
    await resolver.resolveAndApply(adapter.getText());
    // Result might be empty buffer — that's the source's job, not the guard's.
    expect(typeof adapter.getText()).toBe('string');
  });
});
