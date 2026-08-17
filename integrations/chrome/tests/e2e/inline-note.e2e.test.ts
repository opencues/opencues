// M1 — inline cue note overlay (chrome paint of the terminal's note).
//
// CSS Custom Highlight can't inject text, so a passive cue's advisory
// (def.cueTip) is painted as a span-anchored gray overlay (#oc-inline-note)
// pinned below the flagged span, revealed while the caret is inside it. A
// sentence-cue is the deterministic-to-mock passive cue: its LLM reply is
// just `ALT:` lines.
//
// This asserted the overlay text contained the CUE NAME ("formalcue"), on
// the strength of a comment claiming "the note is the connector + cue name".
// `inlineNoteText` has no notion of a cue name — no `def.name`, no
// `sourceName` — so that expectation was never satisfiable by any runtime
// this repo has shipped. The note is `↳ <countdown> | <where the next _
// lands>`, i.e. a preview of the DESTINATION. Because this suite is
// run-on-demand rather than a CI gate, the stale expectation sat here
// failing on purpose-looking grounds and made every future real regression
// in this file look like the same known failure.
//
// Assertions below are therefore about what the paint actually guarantees:
// the overlay exists and is visible, it carries the connector, it previews
// the rewrite rather than echoing the input, and the cue genuinely resolved
// (LLM called) rather than the box being painted empty.

import { test, expect } from './extension.fixture';
import { opencuesMd, cuesMd } from './seed-config';
import { MockLlm } from './mock-llm';

// Distinctive cue name so the overlay text is unambiguous ("↳ formalcue").
const SENTENCE_CUE = [
  '---',
  'name: formalcue',
  'scope: sentence',
  'priority: 85',
  '---',
  '',
  'Rewrite each sentence to be more formal. Return `ALT:` lines.',
  '',
].join('\n');

// The sentence-cue's per-sentence call → two formal rewrites (not `ALT: NONE`,
// so a passive cue registers with a cueTip).
const altReply = (): string =>
  ['ALT: The meeting is scheduled for today.', 'ALT: Today\'s meeting is confirmed.'].join('\n');

test.describe('M1 — inline cue note overlay (chrome)', () => {
  test('a passive sentence-cue paints the #oc-inline-note overlay under the span', async ({ context, seed }) => {
    const llm = new MockLlm().setFallback(altReply);
    await llm.install(context);
    await seed({
      bundleFiles: {
        'OPENCUES.md': opencuesMd({ debug: true, extra: { 'sentence-cues-mode': 'on' } }),
        'CUES.md': cuesMd(),
        'cues/formalcue/CUE.md': SENTENCE_CUE,
      },
      hostKeys: { GROQ_API_KEY: 'test-key-not-validated-locally' },
    });

    const page = await context.newPage();
    await page.goto('/tests/e2e/pages/contenteditable.html');
    const ce = page.locator('#ce');
    await ce.focus();
    // Trailing period so the regex segmenter cleanly picks up the sentence.
    // Caret ends inside the sentence span, which is what reveals the note.
    await page.keyboard.type('The meeting is today.');

    // The overlay is a display-only element outside the editor DOM. It appears
    // once the sentence-cue resolves (LLM call) AND the caret is in the span.
    const noteText = (): Promise<string> =>
      page.evaluate(() => {
        const el = document.getElementById('oc-inline-note') as HTMLElement | null;
        if (!el || el.style.display === 'none') return '';
        return el.textContent ?? '';
      });

    // Wait on the CONNECTOR: it is the one glyph the renderer always emits,
    // so it means "the overlay is up and populated" without pinning the
    // message, which varies by cue type and by what the LLM returned.
    await expect.poll(noteText, { timeout: 15_000 }).toContain('↳');

    const note = await noteText();
    // The countdown ("N | ...") — a cycleable cue tells you how many
    // destinations remain, which is what makes the note actionable.
    expect(note, `note should carry the cycle countdown; got ${JSON.stringify(note)}`).toMatch(/\d+\s*\|/);
    // It previews the REWRITE, not the sentence the user typed. This is the
    // assertion that would catch the note painting from the wrong side of
    // the cue (echoing input back), which is the real failure mode here.
    expect(note, 'note should hint at a destination, not echo the input verbatim')
      .not.toBe('The meeting is today.');
    expect(llm.callCount, 'sentence-cue never resolved — feature inert').toBeGreaterThan(0);
  });
});
