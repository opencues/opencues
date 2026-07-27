// M1 — inline cue note overlay (chrome paint of the terminal's note).
//
// CSS Custom Highlight can't inject text, so a passive cue's advisory
// (def.cueTip) is painted as a span-anchored gray overlay (#oc-inline-note)
// pinned below the flagged span, revealed while the caret is inside it. A
// sentence-cue is the deterministic-to-mock passive cue: its LLM reply is
// just `ALT:` lines and its cueTip is the cue name.

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

    await expect.poll(noteText, { timeout: 15_000 }).toContain('formalcue');
    // The note is the connector + cue name — the terminal's exact text shape.
    expect(await noteText()).toContain('↳');
    expect(llm.callCount, 'sentence-cue never resolved — feature inert').toBeGreaterThan(0);
  });
});
