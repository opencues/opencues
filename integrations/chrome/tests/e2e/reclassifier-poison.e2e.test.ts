// Regression pin — loading-animation `_` frame must not poison the
// source-reclassifier and swallow a subsequent real `_` on a normal input
// (opencues/opencues#348).
//
// On a non-cycling <input>/<textarea>, a bare `_` fill runs the
// loading-animation blank while the LLM resolves. Its default bounce frame
// is `_` (BOUNCE_FRAMES[0]); on an EMPTY field the whole buffer written is
// just "_", so the animation issues runtime writes of "_". Before the fix,
// `writeNormalInputValue` called `sourceReclassifier.markRuntimeWrite('_')`,
// so within the reclassifier's 1.5s TTL the user's NEXT real `_` matched the
// stale frame, was reclassified `runtime`, and the resolver silently skipped
// the blank (runtime writes must never fire blanks). The user saw the first
// `_` work and the next do nothing until they deleted + retyped (past the
// TTL). The fix drops `markRuntimeWrite` from the normal-input write path
// (its synthetic input echo is isTrusted=false and always dropped, so there
// was never a real echo to reclassify there).
//
// This drives the exact user journey: two consecutive bare-`_` fills in one
// empty field. Frames are forced to a single "_" + a fast interval + a small
// LLM delay so the poison entry is GUARANTEED fresh when the second `_` is
// typed — otherwise a broken build could pass by luck. Mutation-verified:
// restoring the `markRuntimeWrite('_')` call turns the second assertion red.

import { test, expect } from './extension.fixture';
import { opencuesMd, cuesMd } from './seed-config';
import { MockLlm, fluidBlankReply } from './mock-llm';

test.describe('M1 — reclassifier vs loading-animation regression', () => {
  test('two consecutive bare-`_` fills in a normal input — the second is not swallowed', async ({ context, seed }) => {
    const VAL = 'OCRECLASSFILL';
    // Both fills are a bare "_" on an empty field → identical buffer, so one
    // fallback reply serves both. Answer is underscore-free so a filled "_"
    // is unambiguous.
    const llm = new MockLlm().setFallback(fluidBlankReply('_', VAL, 'FILL'));
    // Delay > the animation interval so the "_" frame ticks (as a runtime
    // write) before the fill lands.
    await llm.install(context, { delayMs: 300 });

    await seed({
      bundleFiles: {
        'OPENCUES.md': opencuesMd({
          debug: true,
          fluidBlank: true,
          extra: {
            // Force every animation frame to "_" (fast) so the reclassifier
            // poison entry is fresh throughout the fill, making the pre-fix
            // failure deterministic rather than dependent on bounce phase.
            'blank-loading-animation': 'custom',
            'blank-loading-frames': '_,-',
            'blank-loading-interval-ms': '30',
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

    // Fill 1 — bare `_` on the empty field. The animation writes "_" frames
    // (runtime writes) while the delayed mock resolves.
    await page.keyboard.type('_');
    await expect(t).toHaveValue(VAL, { timeout: 15_000 });

    // Fill 2 — clear + bare `_` again, WITHIN the reclassifier's 1.5s TTL of
    // fill 1's "_" animation frame. THIS is the keystroke that was silently
    // dropped before the fix (classified `runtime`, resolver skipped it).
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    await page.keyboard.type('_');
    await expect(
      t,
      'the second bare `_` was swallowed — a loading-animation "_" frame poisoned the source-reclassifier',
    ).toHaveValue(VAL, { timeout: 15_000 });

    expect(llm.callCount, 'both fills should have hit the mock LLM').toBeGreaterThanOrEqual(2);
  });
});
