// M1 — refocus reuses cue state (the suspend/reuse fix).
//
// Bug: focusing away from a contenteditable and back wiped the buffer's
// DynDefs (cue spans) via resetBufferState, and nothing re-resolved, so the
// spans vanished even though the text was identical. Fix: blur SUSPENDS
// (keeps state, hides paint); refocusing the SAME element reuses the result
// (repaint, no re-resolve); a focus change to a DIFFERENT element still
// resets + re-resolves.
//
// Observable: a localhost-scoped word-cue (match: .*) fires exactly one LLM
// resolve per buffer. The intercepted call count is the probe — reuse keeps
// it flat, a reset re-resolves.

import { test, expect } from './extension.fixture';
import { onSiteCueSeed, SITE_PROBE_MARKER } from './seed-config';
import { MockLlm } from './mock-llm';

// A word-cue reply (strict-JSON shape: groq + gpt-oss, see config-source.ts
// parseJsonResponse) that gives word 1 ("meeting" in "the meeting is today")
// one alternative. The resolver registers it as a DynDef, and DimRender dims
// every registered DynDef: the paintable span the reapply-on-refocus contract
// is observed on. The alternative is deliberately synthetic (not a plausible
// suggestion) per the fixture rule in the root CLAUDE.md.
const wordAltReply = (): string =>
  JSON.stringify({ alternatives: [{ index: 1, alts: ['ALT-ONE'] }] });

// Valid classify reply (INDEX:TOKEN per word) so the resolve completes and
// doesn't retry — the CALL is what we count, but a clean reply avoids inflating
// the count with error retries.
const classifyReply = (): string =>
  Array.from({ length: 16 }, (_, i) => `${i}:PROBED`).join('\n');

test.describe('M1 — refocus reuses cue state (suspend/reuse)', () => {
  test('same-field refocus reuses the result; a different field re-resolves', async ({ context, seed }) => {
    const llm = new MockLlm().setFallback(classifyReply);
    await llm.install(context);
    await seed(onSiteCueSeed(/* debug */ true));

    const page = await context.newPage();
    await page.goto('/tests/e2e/pages/refocus.html');
    const ce = page.locator('#ce');
    const ce2 = page.locator('#ce2');
    const outside = page.locator('#outside');

    // Type content → the word-cue resolves at least once.
    await ce.focus();
    await page.keyboard.type('the meeting is today');
    await expect
      .poll(() => llm.callCount, { timeout: 15_000 })
      .toBeGreaterThan(0);
    // Let all debounced resolves from typing settle before snapshotting.
    await page.waitForTimeout(1500);
    const afterType = llm.callCount;

    // Blur to a non-editable element → SUSPEND (state kept, not reset).
    await outside.focus();
    // Refocus the SAME field → REUSE: no re-resolve. Wait well past the
    // ~500ms resolve debounce so a re-resolve would have fired if it were
    // going to.
    await ce.focus();
    await page.waitForTimeout(1500);
    expect(
      llm.callCount,
      'same-field refocus re-resolved instead of reusing the preserved result',
    ).toBe(afterType);

    // Focus a DIFFERENT field, then back to #ce → a genuine cross-buffer change:
    // #ce is reset on the way out and re-resolved on return, so the count climbs.
    await ce2.focus();
    await page.waitForTimeout(200);
    await ce.focus();
    await expect
      .poll(() => llm.callCount, { timeout: 15_000 })
      .toBeGreaterThan(afterType);
  });

  test('the visible dim paint reappears on same-field refocus', async ({ context, seed }) => {
    // The user-visible contract: after refocus the cue SPANS are painted again,
    // not just the state present. Observe the CSS Custom Highlight range count.
    //
    // The span comes from an LLM word-cue (the localhost-scoped probe cue,
    // answered by the mock). It used to come from a STATIC tip word declared in
    // a folder cue's JSON block, but the static tips layer was removed in spec
    // 0.12 (core 0.60.0): a typed pack word no longer grays, so that fixture
    // could never paint and this test timed out waiting for the first dim.
    // Only registered DynDefs dim now; a word-cue is one.
    const llm = new MockLlm().setFallback(wordAltReply);
    await llm.install(context);
    await seed(onSiteCueSeed(/* debug */ true));

    const page = await context.newPage();
    await page.goto('/tests/e2e/pages/refocus.html');
    const ce = page.locator('#ce');
    const outside = page.locator('#outside');

    const dimSize = (): Promise<number> =>
      page.evaluate(() => {
        const hs = (globalThis.CSS as unknown as { highlights?: Map<string, { size: number }> }).highlights;
        if (!hs || typeof hs.get !== 'function') return 0;
        const h = hs.get('oc-dim');
        return h && typeof h.size === 'number' ? h.size : 0;
      });

    await ce.focus();
    await page.keyboard.type('the meeting is today');
    // Spans painted once the cue resolves.
    await expect.poll(dimSize, { timeout: 15_000 }).toBeGreaterThan(0);

    // Blur → paint cleared (suspend hides it).
    await outside.focus();
    await expect.poll(dimSize, { timeout: 5_000 }).toBe(0);

    // Refocus the SAME field → the preserved spans are repainted.
    await ce.focus();
    await expect.poll(dimSize, { timeout: 5_000 }).toBeGreaterThan(0);
  });

  test('a pre-existing draft resolves on first focus (no keystroke needed)', async ({ context, seed }) => {
    // Companion contract: focusing a field that ALREADY has content re-resolves
    // it, so cues appear without typing. Same mechanism as the cross-buffer
    // re-resolve above.
    const llm = new MockLlm().setFallback(classifyReply);
    await llm.install(context);
    await seed(onSiteCueSeed(/* debug */ true));

    const page = await context.newPage();
    await page.goto('/tests/e2e/pages/refocus.html');

    // Seed #ce with pre-existing text WITHOUT focusing it (a draft).
    await page.evaluate(() => {
      const el = document.getElementById('ce')!;
      el.textContent = 'the quarterly report is late';
    });
    // Nothing resolved yet: never focused. This used to flake (about 1 in 3):
    // the mock counted the bootstrap's key-verification GET (verifyLlmKeyAtBoot,
    // fired on every page boot) as an LLM call, so whether it had landed yet
    // decided the count. The mock now counts chat POSTs only.
    expect(llm.callCount).toBe(0);

    // Focus it → the buffer is re-fed to the resolver → a resolve fires.
    await page.locator('#ce').focus();
    await expect
      .poll(() => llm.callCount, { timeout: 15_000 })
      .toBeGreaterThan(0);
    expect(llm.sawContent(new RegExp(SITE_PROBE_MARKER)), 'the call that fired is not the word-cue resolve').toBe(true);
  });
});
