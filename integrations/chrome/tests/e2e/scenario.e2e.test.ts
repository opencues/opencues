// M1 — scenario (feature-liveness) checks. Drive a real feature through
// the actual loaded extension to observable output. A "wired but inert
// in chrome" build (unguarded process.env, stubbed NodeHttpAdapter,
// dead node-only code) fails here because the substitution never lands.

import { test, expect } from './extension.fixture';
import { fluidBlankSeed } from './seed-config';
import { MockLlm, fluidBlankReply } from './mock-llm';

test.describe('M1 — feature liveness', () => {
  test('fluid-blank: `_` lookup substitutes the mock LLM answer', async ({ context, seed }) => {
    // Neutral prose so no built-in keyword blank (dictionary / weather /
    // stock / …) claims the `_` — it must fall through to fluid-blank's
    // LLM lookup, which posts to the (mocked) groq host via the SW proxy.
    // Answer is underscore-free so filling the blank `_` is unambiguous.
    const phrase = 'the sky today looks _';
    const ANSWER = 'OCE2EMOCKVALUE';
    const llm = new MockLlm().setFallback(fluidBlankReply(phrase, ANSWER, 'FILL'));
    await llm.install(context);
    await seed(fluidBlankSeed(/* debug */ true));

    const page = await context.newPage();
    await page.goto('/tests/e2e/pages/contenteditable.html');

    const ce = page.locator('#ce');
    await ce.focus();
    await page.keyboard.type(phrase);

    // Runtime contract: the `_` gets filled with the mock answer end to
    // end (a dead build leaves "the sky today looks _" untouched). The
    // distinctive token proves the substitution came from OUR intercepted
    // LLM call, not a real fetch or a different blank.
    await expect(ce).toHaveText(`the sky today looks ${ANSWER}`, { timeout: 15_000 });
    expect(llm.callCount, 'LLM was never hit — feature is inert or route missed the SW fetch').toBeGreaterThan(0);
  });

  test('note blank: add persists to storage-backed NOTES.md, recall round-trips', async ({ context, seed }) => {
    // Fully deterministic — no LLM involved. Proves the whole chrome
    // chain: shape routing → blankInvoke → NoteBlank → chrome.storage
    // write → re-read on the next invocation. A build where notesMdIO
    // isn't threaded leaves the typed command untouched.
    const NOTE_BLANK_MD = [
      '---', 'name: note', 'type: blank', 'blankKeywords: note',
      'blankDismissible: true', 'blankClearKeywords: true', '---', '',
    ].join('\n');
    const base = fluidBlankSeed(/* debug */ true);
    await seed({
      ...base,
      bundleFiles: { ...base.bundleFiles, 'blanks/note/BLANK.md': NOTE_BLANK_MD },
    });

    const page = await context.newPage();
    await page.goto('/tests/e2e/pages/contenteditable.html');
    const ce = page.locator('#ce');
    await ce.focus();

    await page.keyboard.type('note add zoom: https://zoom.us/j/123 _');
    await expect(ce).toHaveText('[note saved: zoom · 1 note]', { timeout: 15_000 });

    // Recall in the same buffer — the entry must come back from the
    // storage-backed NOTES.md, label stripped, ready to tweak.
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    await page.keyboard.type('note zoom _');
    await expect(ce).toHaveText('https://zoom.us/j/123', { timeout: 15_000 });
  });
});
