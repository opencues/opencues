// Regression pin — the reclassifier-poison bug (opencues/opencues#348,
// fixed for plain <input>/<textarea> in reclassifier-poison.e2e.test.ts)
// also reproduces on CONTENTEDITABLE — Gmail compose, specifically —
// and needed a DIFFERENT fix because contenteditable can't take the
// same shortcut a plain input does.
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
// The plain-input fix (dropping markRuntimeWrite from that path
// entirely) doesn't transfer here: a plain input's own echo is always
// isTrusted=false and dropped upstream regardless, so the mark was
// pure liability there. Contenteditable's execCommand-driven echoes
// ARE isTrusted=true — markRuntimeWrite is load-bearing (it's what
// stops the runtime's own write from re-triggering the resolver on
// itself, the original May 2026 runaway-loop bug). Dropping it here
// would trade this bug back for that one.
//
// Fix: createSourceReclassifier now takes a per-caller ttlMs (default
// unchanged at 1500ms for every other host). Chrome passes a much
// shorter CHROME_RUNTIME_WRITE_TTL_MS (400ms, opencues-bootstrap.ts) —
// comfortably covers chrome's near-synchronous multi-echo window
// (Gmail fires 2-4 input events per write, all within tens of ms) but
// is far too short for a real clear-and-retype to plausibly land
// inside. See boot-common.ts's RUNTIME_WRITE_TTL_MS doc for the full
// writeup.
//
// This drives the retry back-to-back with NO artificial wait — that's
// deliberate, not an oversight. Mutation-verified: against the
// unfixed 1500ms-everywhere TTL, this exact back-to-back sequence
// fails (fill 2 stays "_", nothing lands — the Control+A / Delete /
// type round trips over CDP already take long enough in this harness
// to land past a would-be short TTL but comfortably inside 1500ms).
// With chrome's 400ms override applied, the identical sequence passes
// every time. Restoring the reverted TTL turns this assertion red;
// no explicit sleep needed to prove either direction.

import { test, expect } from './extension.fixture';
import { opencuesMd, cuesMd } from './seed-config';
import { MockLlm, fluidBlankReply } from './mock-llm';

test.describe('M1 — reclassifier vs loading-animation regression (contenteditable)', () => {
  test('two consecutive bare-`_` fills on a contenteditable — the second is not swallowed', async ({ context, seed }) => {
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
    // keystroke that was silently dropped before the fix.
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
