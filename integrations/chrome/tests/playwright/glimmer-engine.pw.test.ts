// Real-Chromium unit tests for the highlight-glimmer engine. jsdom has
// no Highlight API, so these are the ONLY unit-level tests that can
// exercise the engine — the gap that let the single-text-node
// zero-chars bug ship (engine "animated" an empty span, invisibly,
// while every trigger and locate step worked).
//
// Same-world registry assertions: the harness runs in the page world,
// so CSS.highlights membership is directly inspectable — unlike the
// extension e2e, which can only watch the debug log across worlds.

import { test, expect } from '@playwright/test';

declare global {
  interface Window {
    __OCG: {
      createHighlightGlimmer(opts: unknown): {
        play(spec?: { durationMs?: number }): Promise<void>;
        cancel(): void;
        destroy(): void;
        charCount: number;
        wordCount: number;
      };
      supportsHighlightGlimmer(): boolean;
      glimmerRegistry(): [string, number][];
    };
  }
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (err) => console.log('[page error]', err.message));
  await page.goto('/tests/playwright/pages/glimmer.html');
  await page.waitForFunction(() => !!window.__OCG, undefined, { timeout: 5000 });
});

test.describe('highlight-glimmer engine (real Chromium)', () => {
  test('single-text-node Range collects every character — THE zero-chars regression', async ({ page }) => {
    const counts = await page.evaluate(() => {
      // Both endpoints inside ONE text node: commonAncestorContainer is
      // the text node itself, which a TreeWalker never visits as root.
      const tn = document.getElementById('single')!.firstChild as Text;
      const at = tn.data.indexOf('OCGLIMMERVALUE');
      const range = document.createRange();
      range.setStart(tn, at);
      range.setEnd(tn, at + 'OCGLIMMERVALUE'.length);
      const g = window.__OCG.createHighlightGlimmer({ target: range });
      const out = { chars: g.charCount, words: g.wordCount };
      g.destroy();
      return out;
    });
    expect(counts.chars).toBe('OCGLIMMERVALUE'.length);
    expect(counts.words).toBe(1);
  });

  test('multi-node element target counts words across inline-element boundaries', async ({ page }) => {
    const counts = await page.evaluate(() => {
      const g = window.__OCG.createHighlightGlimmer({ target: document.getElementById('multi')! });
      const out = { chars: g.charCount, words: g.wordCount };
      g.destroy();
      return out;
    });
    // alpha bravo charlie delta — "delta" spans <i>del</i>ta.
    expect(counts.words).toBe(4);
    expect(counts.chars).toBe('alphabravocharliedelta'.length);
  });

  test('blink phase hides the whole span; churn drops the global hide and paints displacement buckets', async ({ page }) => {
    await page.evaluate(() => {
      const el = document.getElementById('single')!;
      const g = window.__OCG.createHighlightGlimmer({ target: el });
      (window as unknown as { __g: typeof g }).__g = g;
      void g.play({ durationMs: 900 });
    });
    // Inside the 140ms blink: every char in the -hide bucket, no -off buckets yet.
    await page.waitForTimeout(60);
    const duringBlink = await page.evaluate(() => window.__OCG.glimmerRegistry());
    const hideDuringBlink = duringBlink.find(([n]) => n.endsWith('-hide'));
    expect(hideDuringBlink?.[1], 'blink must hide the full span').toBeGreaterThan(0);
    expect(duringBlink.some(([n, size]) => n.includes('-off-') && size > 0), 'no displacement during blink').toBe(false);

    // Well into churn: global hide dropped, displacement buckets active.
    await page.waitForTimeout(300);
    const duringChurn = await page.evaluate(() => window.__OCG.glimmerRegistry());
    const hideDuringChurn = duringChurn.find(([n]) => n.endsWith('-hide'));
    expect(hideDuringChurn?.[1] ?? 0, 'churn shows real text — global hide must be gone').toBe(0);
    expect(duringChurn.some(([n, size]) => n.includes('-off-') && size > 0), 'churn must displace characters').toBe(true);

    await page.evaluate(() => (window as unknown as { __g: { destroy(): void } }).__g.destroy());
  });

  test('play resolves on schedule and releases every range; destroy deregisters every name', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const el = document.getElementById('single')!;
      const g = window.__OCG.createHighlightGlimmer({ target: el });
      const t0 = performance.now();
      await g.play({ durationMs: 300 }); // + 140ms blink
      const elapsed = performance.now() - t0;
      const afterPlay = window.__OCG.glimmerRegistry();
      g.destroy();
      const afterDestroy = window.__OCG.glimmerRegistry();
      return { elapsed, afterPlayMembers: afterPlay.reduce((a, [, s]) => a + s, 0), afterDestroyNames: afterDestroy.length };
    });
    expect(result.elapsed).toBeGreaterThan(380); // blink + duration, minus one tick of slack
    expect(result.elapsed).toBeLessThan(1200);
    expect(result.afterPlayMembers, 'settle must release every range').toBe(0);
    expect(result.afterDestroyNames, 'destroy must deregister every highlight').toBe(0);
  });

  test('cancel mid-run settles immediately and leaves the registry clean', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const el = document.getElementById('single')!;
      const g = window.__OCG.createHighlightGlimmer({ target: el });
      const done = g.play({ durationMs: 900 });
      await new Promise((r) => setTimeout(r, 250)); // into churn
      g.cancel();
      await done; // cancel must resolve the play promise
      const members = window.__OCG.glimmerRegistry().reduce((a, [, s]) => a + s, 0);
      g.destroy();
      return { members };
    });
    expect(result.members).toBe(0);
  });

  test('liveness: replacing the span text mid-run finishes the animation instead of animating dead ranges', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const el = document.getElementById('single')!;
      const g = window.__OCG.createHighlightGlimmer({ target: el });
      const done = g.play({ durationMs: 1500 });
      await new Promise((r) => setTimeout(r, 300)); // into churn
      el.textContent = 'entirely new text'; // kills the old text nodes → ranges collapse
      const t0 = performance.now();
      await done; // must resolve promptly via the collapsed-range guard, not run the full 1640ms
      const finishMs = performance.now() - t0;
      const members = window.__OCG.glimmerRegistry().reduce((a, [, s]) => a + s, 0);
      g.destroy();
      return { finishMs, members };
    });
    expect(result.finishMs, 'collapsed-range guard must finish within ~2 ticks').toBeLessThan(400);
    expect(result.members).toBe(0);
  });
});
