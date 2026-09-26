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
//
// Mutation check (re-done when the sampling was rewritten): removing
// only ONE of the two restores (diffWriteText's normal-input
// setSelectionRange, or the animator's setCursorOffset after its frame
// write) stays green, because the other still holds the caret. Removing
// BOTH turns it red ("cursor read 0 during the resolve wait"), so the
// sampling below does observe a dragged caret.

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
    //
    // No `toHaveValue(PHRASE)` gate here: the `_` keystroke starts the
    // loading animation straight away, so the first spinner frame replaces
    // the `_` within a tick of the last key and the bare PHRASE is on screen
    // for too short a time to be observed reliably. A gate on it failed
    // every run (it saw only spinner frames, then the answer): it asserted
    // a buffer state the product never holds long enough to poll.
    await page.keyboard.type(PHRASE);
    const expectedCursor = PHRASE.length;
    const PREFIX = 'the current population of iceland is ';
    const FRAMES = ['◐', '◓', '◑', '◒'];
    const waiting = new Set([PHRASE, ...FRAMES.map((f) => PREFIX + f)]);
    const landedLength = PREFIX.length + ANSWER.length;

    // Sample selectionStart repeatedly across the resolve window, from the
    // first instant after the last keystroke until the answer lands. While
    // the buffer is in its WAITING state (the `_`, or a spinner glyph in its
    // place) the caret must sit at expectedCursor on every sample: a 0 (or
    // anything else) means the spinner dragged the cursor, the exact
    // regression this pins. Once the answer lands (the answer, or a glimmer
    // frame of it: same length, same prefix) the waiting window is over.
    const samples: number[] = [];
    let sawSpinnerFrame = false;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const [cursor, value] = await t.evaluate((el: HTMLTextAreaElement) => [
        el.selectionStart ?? -1,
        el.value,
      ]) as [number, string];
      if (value.startsWith(PREFIX) && value.length === landedLength) break; // answer landed
      expect(waiting.has(value), `unexpected buffer during the resolve wait: ${JSON.stringify(value)}`).toBe(true);
      samples.push(cursor);
      if (value !== PHRASE) sawSpinnerFrame = true;
      await new Promise((r) => setTimeout(r, 15));
    }

    // The fill (and any glimmer on it) settles to the real answer.
    await expect(t).toHaveValue(`${PREFIX}${ANSWER}`, { timeout: 15_000 });

    expect(llm.callCount, 'LLM was never hit — blank never fired').toBeGreaterThan(0);
    expect(sawSpinnerFrame, 'never observed a spinner frame in the field: the animation never wrote, so this proved nothing').toBe(true);
    expect(samples.length, 'no cursor samples captured during the resolve window').toBeGreaterThan(0);
    for (const s of samples) {
      expect(s, `cursor read ${s} during the resolve wait, expected ${expectedCursor} throughout`).toBe(expectedCursor);
    }
  });
});
