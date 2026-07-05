// M2 — security-control liveness (degraded-open detectors). Each test
// asserts a control that SHOULD block still blocks. If a control silently
// degraded open (stopped rejecting hostile input) the assertion fails —
// the failure mode no unit test or static lint can see.
//
// Every negative (blocked) case is paired with a positive control (the
// same input on a trusted/allowed path DOES fire), so the block isn't a
// trivial pass caused by the feature being dead everywhere.

import { test, expect } from './extension.fixture';
import { fluidBlankSeed } from './seed-config';
import { MockLlm, fluidBlankReply } from './mock-llm';

const ANSWER = 'OCE2ESECVALUE'; // underscore-free so a fill is unambiguous

test.describe('M2 — security control liveness', () => {
  test('trust-gate: a synthetic (untrusted) `_` injection is refused', async ({ context, seed }) => {
    const phrase = 'the sky today looks _';
    const llm = new MockLlm().setFallback(fluidBlankReply(phrase, ANSWER, 'FILL'));
    await llm.install(context);
    await seed(fluidBlankSeed(true));

    const page = await context.newPage();
    await page.goto('/tests/e2e/pages/contenteditable.html');
    const ce = page.locator('#ce');
    await ce.focus();

    // Attack: a hostile page raises the `_` count itself and fires a
    // synthetic input event (isTrusted:false, no earned credit).
    await page.evaluate((p) => {
      const el = document.querySelector('#ce') as HTMLElement;
      el.textContent = p;
      el.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '_' }),
      );
    }, phrase);
    await page.waitForTimeout(3000);

    // LIVE: the injection is dropped, so the buffer keeps its literal `_`
    // and no substitution lands. Degraded-open would show
    // "the sky today looks OCE2ESECVALUE".
    await expect(ce).toHaveText(phrase);
  });

  test('trust-gate positive control: a real typed `_` DOES fill', async ({ context, seed }) => {
    const phrase = 'the sky today looks _';
    const llm = new MockLlm().setFallback(fluidBlankReply(phrase, ANSWER, 'FILL'));
    await llm.install(context);
    await seed(fluidBlankSeed(true));

    const page = await context.newPage();
    await page.goto('/tests/e2e/pages/contenteditable.html');
    const ce = page.locator('#ce');
    await ce.focus();
    await page.keyboard.type(phrase);

    // Proves the block above isn't a trivial pass (the pipeline works
    // when the `_` is trusted).
    await expect(ce).toHaveText(`the sky today looks ${ANSWER}`, { timeout: 15_000 });
  });

  test('sensitive-field: a password input is never attached or filled', async ({ context, seed }) => {
    const phrase = 'the sky looks _';
    const llm = new MockLlm().setFallback(fluidBlankReply(phrase, ANSWER, 'FILL'));
    await llm.install(context);
    await seed(fluidBlankSeed(true));

    const page = await context.newPage();
    await page.goto('/tests/e2e/pages/textarea.html');
    const pw = page.locator('#pw'); // <input type="password">
    await pw.focus();
    await page.keyboard.type(phrase);
    await page.waitForTimeout(3000);

    // LIVE: refused at attach → no read/write path → value untouched.
    await expect(pw).toHaveValue(phrase);
  });

  test('sensitive-field: a mistyped CC field (type=text, autocomplete=cc-number) is refused', async ({ context, seed }) => {
    // The isSensitiveField HEURISTIC layer (not the type allow-list): a
    // `type="text"` field that autocomplete-declares itself a card number
    // must still be refused. This is the audit residual #25 surface.
    const phrase = 'the sky looks _';
    const llm = new MockLlm().setFallback(fluidBlankReply(phrase, ANSWER, 'FILL'));
    await llm.install(context);
    await seed(fluidBlankSeed(true));

    const page = await context.newPage();
    await page.goto('/tests/e2e/pages/textarea.html');
    const cc = page.locator('#cc'); // <input type="text" autocomplete="cc-number">
    await cc.focus();
    await page.keyboard.type(phrase);
    await page.waitForTimeout(3000);

    await expect(cc).toHaveValue(phrase);
  });

  test('sensitive-field positive control: a plain text field DOES fill', async ({ context, seed }) => {
    const phrase = 'the sky looks _';
    const llm = new MockLlm().setFallback(fluidBlankReply(phrase, ANSWER, 'FILL'));
    await llm.install(context);
    await seed(fluidBlankSeed(true));

    const page = await context.newPage();
    await page.goto('/tests/e2e/pages/textarea.html');
    const t = page.locator('#t'); // plain <textarea>, not sensitive
    await t.focus();
    await page.keyboard.type(phrase);

    await expect(t).toHaveValue(`the sky looks ${ANSWER}`, { timeout: 15_000 });
  });

  // TODO(site-filter): a seeded folder-cue (cues/<name>/CUE.md) is not
  // discovered from the storage bundle under Playwright — ConfigLoader
  // logs "loaded 0 cue entries" and the resolver builds with only
  // [fluid-blank], even though readBundledDir() reads the same
  // getBundleIndex() the seed writes. No parse/filter warning fires, so
  // the folder is invisible to discovery (not dropped). Blocker is chrome
  // folder-cue discovery-from-seed, not the site-filter control itself.
  // Kept as a documented gap rather than a silent omission. Next step:
  // trace ConfigLoader's folder prewalk vs getBundleIndex readiness at
  // boot, or seed via the bake-time dist/configs path instead of storage.
  test.fixme('site-filter: an off-site cue is filtered out on localhost', async ({ context, seed }) => {
    // Intended shape once discovery-from-seed works:
    //   seed offSiteCueSeed() (on-site: [example.com]) → type the word →
    //   assert NO cue substitution on localhost; and the onSiteCueSeed()
    //   (on-site: [localhost]) positive control DOES fire — proving the
    //   filter, not a dead cue, is what blocked it.
    void context; void seed;
  });
});
