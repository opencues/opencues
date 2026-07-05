// M0 — the harness smoke test. Proves the real extension loads, the
// service worker registers, seeded config reaches the content script,
// and the runtime boots + attaches. A total-silent-death build (the
// `failed=true` bug class) fails here.
//
// The boot proof is a DOM/functional signal (attach injects the
// highlight-style element), NOT a console line — the debug-gated console
// output doesn't reliably surface to page.on('console') under headless,
// and asserting the runtime *contract* (it attached) is exactly the
// repo's scenario-test philosophy.

import { test, expect } from './extension.fixture';
import { bootSeed } from './seed-config';

test.describe('M0 — extension boot', () => {
  test('service worker registers and exposes an extension id', async ({ serviceWorker }) => {
    expect(serviceWorker.url()).toMatch(
      /^chrome-extension:\/\/[a-p]{32}\/dist\/background\.js$/,
    );
  });

  test('content script boots and attaches to a focused contenteditable', async ({ context, seed }) => {
    await seed(bootSeed(/* debug */ true));

    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.goto('/tests/e2e/pages/contenteditable.html');
    await page.locator('#ce').focus();

    // Attach injects <style id="oc-highlight-styles"> into the shared
    // document — the debug-independent "runtime booted AND attached to
    // my element" signal. If boot threw (silent death), this never
    // appears.
    await expect(page.locator('#oc-highlight-styles')).toHaveCount(1, { timeout: 10_000 });
    expect(pageErrors, 'content script threw at boot').toEqual([]);
  });
});
