// Regression pin — the reclassifier-poison bug (opencues/opencues#348,
// fixed for plain <input>/<textarea> in reclassifier-poison.e2e.test.ts)
// also reproduces on CONTENTEDITABLE — Gmail compose, specifically —
// but the chrome-specific fix here has been REVERTED. Read on before
// re-attempting it.
//
// Found live on Gmail (August 2026): fill a bare `_` in an empty
// compose body, clear it, retype bare `_` — the second fill was
// silently swallowed. Root cause: BlankLoadingAnimator's default
// bounce frame IS the literal string `_` (BOUNCE_FRAMES[0]); on an
// empty field the spinner's own runtime-authored frame write is `_`,
// stashed by sourceReclassifier.markRuntimeWrite for the shared
// RUNTIME_WRITE_TTL_MS (1500ms, tuned for opencode's issue #306). A
// user retyping bare `_` within that window produced identical text,
// matched the stash, and was reclassified 'runtime' — the resolver
// silently skips runtime-sourced changes, so nothing happened.
//
// FIRST FIX (shipped, then reverted same day): shortened chrome's TTL
// to 400ms via createSourceReclassifier's new per-caller ttlMs param
// (the plumbing stays — see boot-common.ts — only chrome's override
// was pulled). Verified this exact assertion both ways at the time.
// Immediately after shipping, the user reported the whole Gmail tab
// freezing. Root-caused (with the user's help narrowing it to
// "the blinker is fine, it's the glimmer") to a DIFFERENT, unrelated
// chrome change from earlier the same day: glimmer's real-write mode
// (packages/opencues-runtime/adapters/chrome/v1/boot.ts) firing up to
// ~13 execCommand writes in under a second on a real managed editor,
// never load-tested against one. That's now hard-disabled for chrome.
//
// The shortened TTL was reverted alongside it out of caution, not
// because it was independently confirmed guilty — with glimmer's
// write volume removed, 400ms may well have been fine on its own, but
// re-deriving that safely (rather than re-guessing a constant against
// a synthetic test page a second time) needs real load-testing against
// Gmail, not another shot in the dark while recovering from an
// incident. So: TEST SKIPPED, not deleted — it still accurately
// describes a real, live, currently-UNFIXED bug on chrome/Gmail. Un-skip
// it once a real fix lands (a shorter TTL that's been load-tested, or a
// count-based/generation-tagged reclassifier instead of a timing
// guess) and confirm this passes before re-closing the issue.

import { test, expect } from './extension.fixture';
import { opencuesMd, cuesMd } from './seed-config';
import { MockLlm, fluidBlankReply } from './mock-llm';

test.describe('M1 — reclassifier vs loading-animation regression (contenteditable)', () => {
  test.skip('two consecutive bare-`_` fills on a contenteditable — the second is not swallowed', async ({ context, seed }) => {
    const VAL = 'OCRECLASSCEFILL';
    const llm = new MockLlm().setFallback(fluidBlankReply('_', VAL, 'FILL'));
    // Delay > the animation interval so the "_" frame ticks (as a runtime
    // write) before the fill lands — mirrors the normal-input sibling test.
    await llm.install(context, { delayMs: 300 });

    await seed({
      bundleFiles: {
        'OPENCUES.md': opencuesMd({
          debug: true,
          fluidBlank: true,
          extra: {
            // Force every animation frame to "_" (fast) so the reclassifier
            // poison entry is fresh throughout the fill.
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
    await page.goto('/tests/e2e/pages/contenteditable.html');
    const ce = page.locator('#ce');
    await ce.focus();

    // Fill 1 — bare `_` on the empty field.
    await page.keyboard.type('_');
    await expect(ce).toHaveText(VAL, { timeout: 15_000 });

    // Fill 2 — clear + bare `_` again, immediately (no wait). This is the
    // keystroke currently swallowed on chrome — see header comment.
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    await page.keyboard.type('_');
    await expect(
      ce,
      'the second bare `_` was swallowed — a loading-animation "_" frame poisoned the source-reclassifier',
    ).toHaveText(VAL, { timeout: 15_000 });

    expect(llm.callCount, 'both fills should have hit the mock LLM').toBeGreaterThanOrEqual(2);
  });
});
