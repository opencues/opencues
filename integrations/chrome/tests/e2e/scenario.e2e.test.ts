// M1 — scenario (feature-liveness) checks. Drive a real feature through
// the actual loaded extension to observable output. A "wired but inert
// in chrome" build (unguarded process.env, stubbed NodeHttpAdapter,
// dead node-only code) fails here because the substitution never lands.

import { test, expect } from './extension.fixture';
import { fluidBlankSeed } from './seed-config';
import { MockLlm, fluidBlankReply } from './mock-llm';

test.describe('M1 — feature liveness', () => {
  test('fluid-blank: `_` lookup substitutes the mock LLM answer', async ({ context, seed }) => {
    // Neutral prose so no built-in keyword blank (dictionary / weather /
    // stock / …) claims the `_` — it must fall through to fluid-blank's
    // LLM lookup, which posts to the (mocked) groq host via the SW proxy.
    // Answer is underscore-free so filling the blank `_` is unambiguous.
    const phrase = 'the sky today looks _';
    const ANSWER = 'OCE2EMOCKVALUE';
    const llm = new MockLlm().setFallback(fluidBlankReply(phrase, ANSWER, 'FILL'));
    await llm.install(context);
    await seed(fluidBlankSeed(/* debug */ true));

    const page = await context.newPage();
    await page.goto('/tests/e2e/pages/contenteditable.html');

    const ce = page.locator('#ce');
    await ce.focus();
    await page.keyboard.type(phrase);

    // Runtime contract: the `_` gets filled with the mock answer end to
    // end (a dead build leaves "the sky today looks _" untouched). The
    // distinctive token proves the substitution came from OUR intercepted
    // LLM call, not a real fetch or a different blank.
    await expect(ce).toHaveText(`the sky today looks ${ANSWER}`, { timeout: 15_000 });
    expect(llm.callCount, 'LLM was never hit — feature is inert or route missed the SW fetch').toBeGreaterThan(0);
  });
});
