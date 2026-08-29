// M1 — glimmer transition liveness. The host-owned Highlight API
// animation must actually engage on a landed substitution: the whole
// pipeline can be "wired but dead" while the fill itself works
// (trigger fires, tolerant locate succeeds, engine constructs — and
// collects ZERO characters). Live bug this pins: a Range whose
// endpoints sit inside one text node has that text node as its
// commonAncestorContainer, and a TreeWalker never visits its own root,
// so the engine animated "0 chars / 0 words" — invisible, while
// OpenCode boiled on the identical trigger. Asserting on the debug log
// keeps this world-agnostic (isolated-world highlight registrations
// aren't reliably visible to main-world CSS.highlights probes).

import { test, expect } from './extension.fixture';
import { fluidBlankSeed } from './seed-config';
import { MockLlm, fluidBlankReply } from './mock-llm';

test.describe('M1 — glimmer transition liveness', () => {
  test('fluid-blank fill engages the highlight glimmer with a non-empty span', async ({ context, seed }) => {
    const phrase = 'the sky today looks _';
    const ANSWER = 'OCE2EMOCKVALUE';
    const llm = new MockLlm().setFallback(fluidBlankReply(phrase, ANSWER, 'FILL'));
    await llm.install(context);
    await seed(fluidBlankSeed(/* debug */ true));

    const page = await context.newPage();
    const logs: string[] = [];
    page.on('console', (msg) => { logs.push(msg.text()); });
    await page.goto('/tests/e2e/pages/contenteditable.html');

    const ce = page.locator('#ce');
    await ce.focus();
    await page.keyboard.type(phrase);

    await expect(ce).toHaveText(`the sky today looks ${ANSWER}`, { timeout: 15_000 });
    // Let the transition window run out fully before inspecting.
    await page.waitForTimeout(1500);

    const startLine = logs.find((l) => l.includes('glimmer: host animation start'));
    expect(startLine, 'runtime never delegated to the host animation — trigger parity broken').toBeTruthy();

    const animLine = logs.find((l) => /glimmer: animating (\d+) chars/.test(l));
    expect(animLine, 'binding never built the engine (gave up or errored) — see debug log').toBeTruthy();
    const chars = Number(/glimmer: animating (\d+) chars/.exec(animLine!)![1]);
    expect(chars, 'engine collected an empty span — the animation is invisible').toBe(ANSWER.length);

    const gaveUp = logs.find((l) => l.includes('span never stabilized'));
    expect(gaveUp, 'binding gave up locating the landed span').toBeFalsy();
  });
});
