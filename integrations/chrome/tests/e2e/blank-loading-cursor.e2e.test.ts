// Regression pin — the loading-animation spinner must not drag the
// cursor to buffer-start while a blank is resolving.
//
// Origin: OpenTUI hosts (shell, opencode) hit this live —
// `textarea.setText()` resets `cursorOffset` to 0 as a side effect, and
// `BlankLoadingAnimator`'s per-frame write (`_writeChar`, in
// packages/opencues-runtime/src/modules/blank-loading.ts) called
// `adapter.setText()` on every animation tick without restoring the
// cursor afterward — so on those hosts the caret visibly snapped to 0
// on every tick for the whole wait, then jumped back once the real
// answer landed. Fixed there by saving the cursor before the write and
// restoring it after (mirrors glimmer-render.ts's `_writeFrame`).
//
// IMPORTANT — mutation-tested here and it does NOT discriminate that
// fix on chrome: chrome's own `diffWriteText` (src/opencues-bootstrap.ts)
// already wraps every `setText` call — normal-input AND contenteditable
// alike — with its own independent capture-before/restore-after of the
// cursor, regardless of which layer the write originated from. Reverting
// the runtime module's fix and rebuilding, this test still passed. So
// the OpenTUI-class bug structurally cannot reproduce on chrome's
// adapter layer, fix or no fix — this test does not prove the runtime
// module's fix does anything here.
//
// It's kept anyway as an end-to-end pin of the OBSERVABLE contract
// (cursor never moves while a blank animates through to its answer) via
// chrome's own protection layer — real value, different claim: it
// guards against a future change to `diffWriteText`'s own capture/
// restore, not against a regression in `blank-loading.ts`.

import { test, expect } from './extension.fixture';
import { opencuesMd, cuesMd } from './seed-config';
import { MockLlm, fluidBlankReply } from './mock-llm';

test.describe('M1 — blank-loading spinner cursor preservation', () => {
  test('cursor stays put through the resolve wait, on a normal input', async ({ context, seed }) => {
    const PHRASE = 'the current population of iceland is _';
    const ANSWER = 'OCPOPCURSORVAL';
    // FILL keeps the phrase and replaces just `_`.
    const llm = new MockLlm().setFallback(fluidBlankReply(PHRASE, ANSWER, 'FILL'));
    // Long enough for several ~animation ticks to land as real setText
    // calls before the mock resolves (mirrors reclassifier-poison's
    // delayMs technique — Playwright has no fake timers here, so this
    // maps to real wall-clock animation frames in the page).
    await llm.install(context, { delayMs: 450 });

    await seed({
      bundleFiles: {
        'OPENCUES.md': opencuesMd({
          debug: true,
          fluidBlank: true,
          extra: {
            'blank-loading-animation': 'custom',
            'blank-loading-frames': '◐,◓,◑,◒',
            'blank-loading-interval-ms': '40',
          },
        }),
        'CUES.md': cuesMd(),
      },
      hostKeys: { GROQ_API_KEY: 'test-key-not-validated-locally' },
    });

    const page = await context.newPage();
    await page.goto('/tests/e2e/pages/textarea.html');
    const t = page.locator('#t');
    await t.focus();

    // Typing the whole phrase leaves the caret right after the trailing
    // `_` — a nonzero position (PHRASE.length), the exact spot the bug
    // dragged back to 0.
    await page.keyboard.type(PHRASE);
    const expectedCursor = PHRASE.length;
    await expect(t).toHaveValue(PHRASE);

    // Sample selectionStart repeatedly across the resolve window. If any
    // sample reads 0 (or anything other than expectedCursor) while the
    // field still shows the unresolved/animating buffer, the spinner
    // dragged the cursor — the exact regression this pins.
    const samples: number[] = [];
    let sawAnimationFrame = false;
    const deadline = Date.now() + 400;
    while (Date.now() < deadline) {
      const [cursor, value] = await t.evaluate((el: HTMLTextAreaElement) => [
        el.selectionStart ?? -1,
        el.value,
      ]) as [number, string];
      samples.push(cursor);
      if (value !== PHRASE) sawAnimationFrame = true; // a spinner glyph frame or the landed answer
      if (value === `the current population of iceland is ${ANSWER}`) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // Give the fill time to fully land if the loop above exited early.
    await expect(t).toHaveValue(`the current population of iceland is ${ANSWER}`, { timeout: 15_000 });

    expect(llm.callCount, 'LLM was never hit — blank never fired').toBeGreaterThan(0);
    expect(sawAnimationFrame, 'never observed an animating/landed frame — the wait was too short to be a real test').toBe(true);
    expect(samples.length, 'no cursor samples captured during the resolve window').toBeGreaterThan(0);
    for (const s of samples) {
      expect(s, `cursor read ${s} during the resolve wait, expected ${expectedCursor} throughout`).toBe(expectedCursor);
    }
  });
});
