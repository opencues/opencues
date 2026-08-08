// ask-cues on Chrome — the AskUserQuestion cue renders in the browser.
//
// ask-cues is a built-in source (not a CUE.md), built via the shared resolver
// on Chrome exactly like CC/OC. Chrome has no session transcript, so it grounds
// on PAGE CONTEXT (ambient page title + field label) instead. This drives a
// contenteditable field with a vague claim and asserts the ❓ question tip
// paints the #oc-inline-note overlay — proving the feature is live on Chrome,
// not inert.

import { test, expect } from './extension.fixture';
import { opencuesMd, cuesMd } from './seed-config';
import { MockLlm } from './mock-llm';

// ask-cues parses a ToolQuestion JSON object (NOT `ALT:` lines). The mock
// returns one for every call — safe because we disable every other prose cue,
// so ask-cues is the only source that hits the LLM on plain text.
const askReply = (): string =>
  JSON.stringify({
    header: 'Evidence',
    question: 'Substantiate the claim, or qualify it?',
    options: [
      { label: 'Add data', description: 'back it with numbers', apply: 'The new dashboard cut task time 30%.' },
      { label: 'Qualify', description: 'soften the absolute', apply: 'The new dashboard is generally more intuitive.' },
      { label: 'Keep as is', description: 'no change' },
    ],
  });

test.describe('ask-cues (chrome)', () => {
  test('a vague sentence paints the ❓ AskUserQuestion tip via #oc-inline-note', async ({ context, seed }) => {
    const llm = new MockLlm().setFallback(askReply);
    await llm.install(context);
    await seed({
      bundleFiles: {
        // ask-cues on; every competing prose cue off so the mock's JSON reply
        // only ever reaches ask-cues. ambient on so PAGE CONTEXT flows (Chrome
        // grounding) — proves the plumbing, though the mock reply is fixed.
        'OPENCUES.md': opencuesMd({
          debug: true,
          extra: {
            'ask-cues-mode': 'on',
            'ambient-context-mode': 'on',
            'session-contradiction-mode': 'off',
            'sentence-cues-mode': 'off',
            'word-cues-mode': 'off',
            'contradiction-cues-mode': 'off',
            'fluid-config-mode': 'off',
          },
        }),
        'CUES.md': cuesMd(),
      },
      hostKeys: { GROQ_API_KEY: 'test-key-not-validated-locally' },
    });

    const page = await context.newPage();
    await page.goto('/tests/e2e/pages/contenteditable.html');
    const ce = page.locator('#ce');
    await ce.focus();
    // Trailing period → clean sentence segmentation; caret ends inside the span.
    await page.keyboard.type('the new dashboard is way more intuitive.');

    const noteText = (): Promise<string> =>
      page.evaluate(() => {
        const el = document.getElementById('oc-inline-note') as HTMLElement | null;
        if (!el || el.style.display === 'none') return '';
        return el.textContent ?? '';
      });

    // The ❓ question tip appears once ask-cues resolves + the caret is in span.
    await expect.poll(noteText, { timeout: 15_000 }).toContain('❓');
    expect(await noteText(), 'inline-note connector').toContain('↳');
    expect(llm.callCount, 'ask-cues never resolved — feature inert on chrome').toBeGreaterThan(0);
  });
});
