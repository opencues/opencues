// M2 — security-control liveness (degraded-open detectors). Each test
// asserts a control that SHOULD block still blocks. If a control silently
// degraded open (stopped rejecting hostile input) the assertion fails —
// the failure mode no unit test or static lint can see.
//
// Every negative (blocked) case is paired with a positive control (the
// same input on a trusted/allowed path DOES fire), so the block isn't a
// trivial pass caused by the feature being dead everywhere.

import { test, expect } from './extension.fixture';
import { fluidBlankSeed, offSiteCueSeed, onSiteCueSeed, SITE_PROBE_MARKER } from './seed-config';
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

  // The observable is whether the probe cue's LLM call fires. Its prompt
  // carries SITE_PROBE_MARKER, so the mock can tell a registered cue
  // (call fired) from a filtered one (never called) — no cycling needed.
  test('site-filter: an off-site cue never fires on localhost', async ({ context, seed }) => {
    const marker = new RegExp(SITE_PROBE_MARKER);
    const llm = new MockLlm().reply(marker, '0:PROBED');
    await llm.install(context);
    await seed(offSiteCueSeed(true)); // on-site: [example.com]

    const page = await context.newPage();
    await page.goto('/tests/e2e/pages/contenteditable.html');
    await page.locator('#ce').focus();
    await page.keyboard.type('sky is blue today');
    await page.waitForTimeout(4000);

    // LIVE: example.com-scoped cue is filtered at bundle read on
    // localhost → never registered → its LLM call never fires.
    expect(llm.sawContent(marker), 'off-site cue fired on localhost — site-filter degraded open').toBe(false);
  });

  test('site-filter positive control: the same cue scoped to localhost DOES fire', async ({ context, seed }) => {
    const marker = new RegExp(SITE_PROBE_MARKER);
    const llm = new MockLlm().reply(marker, '0:PROBED');
    await llm.install(context);
    await seed(onSiteCueSeed(true)); // on-site: [localhost]

    const page = await context.newPage();
    await page.goto('/tests/e2e/pages/contenteditable.html');
    await page.locator('#ce').focus();
    await page.keyboard.type('sky is blue today');

    // Proves the off-site block above isn't a trivial pass: the identical
    // cue, scoped to localhost, IS registered and its LLM call fires.
    await expect.poll(() => llm.sawContent(marker), { timeout: 12_000 }).toBe(true);
  });
});
