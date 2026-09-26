// M1 — kata coach observes an Enter keypress in chrome.
//
// Reproduces the reported "Enter key still doesn't work" in chrome. A
// kata coach is a debounced LLM call driven by observed user activity —
// typed text AND salient key presses (Enter/Tab/arrows). This drives a
// real kata in the loaded extension and asserts that pressing Enter
// causes ANOTHER coach tick (a fresh LLM call) — i.e. the keypress
// reached the runtime's observeKey. If the call count doesn't move after
// Enter, the key never reached the coach (the bug).
//
// The start of each test used to wait for `callCount > 0` right after
// `start kata email _`, as proof the coach ran. Starting a kata never ticks
// the coach, though; that wait was satisfied only by the bootstrap's key
// probe (a GET the mock counted as an LLM call until it learned not to). It
// now waits for the phrase to be consumed, then for the tick that typing
// produces.

import { test, expect } from './extension.fixture';
import { opencuesMd, cuesMd } from './seed-config';
import { MockLlm } from './mock-llm';

function kataSeed() {
  return {
    bundleFiles: {
      'OPENCUES.md': opencuesMd({ debug: true, extra: { 'kata-llm-provider': 'groq' } }),
      'CUES.md': cuesMd(),
    },
    hostKeys: { GROQ_API_KEY: 'test-key-not-validated-locally' },
  };
}

test.describe('M1 — kata coach observes keys', () => {
  test('pressing Enter triggers a coach tick (Enter reaches observeKey)', async ({ context, seed }) => {
    const llm = new MockLlm()
      // Any coach call → a valid IN_PROGRESS verdict (bundled `email` kata).
      .reply(/KATA COACH/, 'STEP: 1\nSTATUS: IN_PROGRESS\nCOACH: greet the recipient')
      .setFallback('STEP: 1\nSTATUS: IN_PROGRESS\nCOACH: keep going');
    await llm.install(context);
    await seed(kataSeed());

    const page = await context.newPage();
    await page.goto('/tests/e2e/pages/contenteditable.html');
    const ce = page.locator('#ce');
    await ce.focus();

    // Start the kata (bundled email kata). Starting does NOT tick the coach
    // (kata.ts handleControl 'start' only arms the idle timer); the observable
    // is the control phrase being consumed from the buffer.
    await page.keyboard.type('start kata email _');
    await expect(ce, 'kata did not start in chrome (control phrase not consumed)').toHaveText('', { timeout: 15_000 });

    // Type a little so the buffer is non-empty (Enter = newline here, not a
    // submit). Typed activity is what ticks the coach; wait for that tick,
    // then settle so no debounced tick is in flight.
    await ce.focus();
    await page.keyboard.type('Hi Sarah');
    await expect
      .poll(() => llm.callCount, { timeout: 15_000, message: 'kata coach never ran on typed activity in chrome' })
      .toBeGreaterThan(0);
    expect(llm.sawContent(/KATA COACH/), 'the call that fired is not a kata coach tick').toBe(true);
    await page.waitForTimeout(1500);
    const before = llm.callCount;

    // THE TEST: press Enter. On a non-empty buffer this inserts a newline,
    // but the coach must still OBSERVE the keypress → schedule a tick.
    await page.keyboard.press('Enter');
    await expect
      .poll(() => llm.callCount, { timeout: 8_000, message: 'Enter did NOT trigger a coach tick — the keypress never reached observeKey in chrome' })
      .toBeGreaterThan(before);
  });

  test('normal-input (textarea): Enter also reaches observeKey', async ({ context, seed }) => {
    const llm = new MockLlm()
      .reply(/KATA COACH/, 'STEP: 1\nSTATUS: IN_PROGRESS\nCOACH: greet the recipient')
      .setFallback('STEP: 1\nSTATUS: IN_PROGRESS\nCOACH: keep going');
    await llm.install(context);
    await seed(kataSeed());

    const page = await context.newPage();
    await page.goto('/tests/e2e/pages/textarea.html');
    const ta = page.locator('#t');
    await ta.focus();

    await page.keyboard.type('start kata email _');
    await expect(ta, 'kata did not start in the textarea (control phrase not consumed)').toHaveValue('', { timeout: 15_000 });

    await ta.focus();
    await page.keyboard.type('Hi Sarah');
    await expect
      .poll(() => llm.callCount, { timeout: 15_000, message: 'kata coach never ran on typed activity in the textarea' })
      .toBeGreaterThan(0);
    expect(llm.sawContent(/KATA COACH/), 'the call that fired is not a kata coach tick').toBe(true);
    await page.waitForTimeout(1500);
    const before = llm.callCount;

    await page.keyboard.press('Enter');
    await expect
      .poll(() => llm.callCount, { timeout: 8_000, message: 'Enter did NOT trigger a coach tick in a textarea (normal-input forwarding)' })
      .toBeGreaterThan(before);
  });
});
