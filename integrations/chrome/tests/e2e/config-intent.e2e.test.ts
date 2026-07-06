// M1 — config-intent (fluid-config) feature liveness, chrome-only setting.
//
// Reproduces the reported gap: `move the status bar to the top _` DID
// reposition the bar (scalar applied) but left NOTHING in the field —
// whereas a normal setting change (e.g. `voice mode off _`) splices a
// selector-satellite pair like `voice-mode active` into the buffer. The
// config-intent SOURCE emits an identical result shape for both, so this
// drives the real extension to see whether chrome renders the pair.
//
// config-intent makes TWO LLM calls on a SETTING hit: the CLASSIFIER
// (SYSTEM_PROMPT) and a SUMMON extraction (SUMMON_PROMPT). Both are
// mocked here by a marker in each prompt.

import { test, expect } from './extension.fixture';
import { opencuesMd, cuesMd } from './seed-config';
import { MockLlm } from './mock-llm';

function configIntentSeed() {
  return {
    bundleFiles: {
      // fluid-config-mode on → ConfigIntentSource is built. fluid-blank on
      // too (harmless) so a plain `_` still has a home if classify NONEs.
      'OPENCUES.md': opencuesMd({ debug: true, fluidBlank: true, extra: { 'fluid-config-mode': 'on' } }),
      'CUES.md': cuesMd(),
    },
    hostKeys: { GROQ_API_KEY: 'test-key-not-validated-locally' },
  };
}

test.describe('M1 — config-intent (fluid-config)', () => {
  test('setting change splices a selector-satellite pair into the field (statusbar-position)', async ({ context, seed }) => {
    const phrase = 'move the status bar to the top _';
    const llm = new MockLlm()
      // Classifier → statusbar-position: top (the chrome-only FEATURE).
      .reply(/CONFIGURATION INTENT CLASSIFIER/, 'SETTING: statusbar-position\nVALUE: top\nCONFIDENCE: 0.95')
      // Summon extraction → the whole command is the summon (no prior text).
      .reply(/extract the COMMAND SPAN/, phrase)
      // Anything else → NONE, so no other source acts.
      .setFallback('INTENT: NONE\nCONFIDENCE: 0.9');
    await llm.install(context);
    await seed(configIntentSeed());

    const page = await context.newPage();
    await page.goto('/tests/e2e/pages/contenteditable.html');

    const ce = page.locator('#ce');
    await ce.focus();
    await page.keyboard.type(phrase);

    // Runtime contract (the reported bug): after config-intent applies the
    // setting, the summon words are wiped and the "<setting> <value>"
    // selector-satellite pair is spliced into the field — exactly like a
    // normal `voice mode off _`. A missing pair (field left blank or with
    // the raw query) is the regression.
    await expect(ce, 'config-intent should splice the setting pair into the field').toContainText('statusbar-position', { timeout: 15_000 });
    await expect(ce).toContainText('top');
    // The summon words must be gone (wiped span).
    await expect(ce).not.toContainText('move the status bar');
    // And the LLM classifier was actually hit (feature not inert).
    expect(llm.callCount, 'classifier LLM was never hit — config-intent inert').toBeGreaterThan(0);
    // Field ends up as exactly the pair "statusbar-position top".
    expect((await ce.textContent())?.trim()).toBe('statusbar-position top');
  });

  test('normal-input (textarea): setting change still splices the pair (the reported gap)', async ({ context, seed }) => {
    const phrase = 'move the status bar to the top _';
    const llm = new MockLlm()
      .reply(/CONFIGURATION INTENT CLASSIFIER/, 'SETTING: statusbar-position\nVALUE: top\nCONFIDENCE: 0.95')
      .reply(/extract the COMMAND SPAN/, phrase)
      .setFallback('INTENT: NONE\nCONFIDENCE: 0.9');
    await llm.install(context);
    await seed(configIntentSeed());

    const page = await context.newPage();
    await page.goto('/tests/e2e/pages/textarea.html');

    const ta = page.locator('#t');
    await ta.focus();
    await page.keyboard.type(phrase);

    // The reported bug: on a normal input (chrome's no-cycling profile),
    // config-intent applied the scalar but left the field unchanged — the
    // selector-satellite pair was pruned. It should still land as text.
    await expect(ta, 'config-intent should splice the setting pair into the textarea').toHaveValue(/statusbar-position/, { timeout: 15_000 });
    await expect(ta).toHaveValue(/top/);
    await expect(ta).not.toHaveValue(/move the status bar/);
    expect(llm.callCount).toBeGreaterThan(0);
    expect((await ta.inputValue()).trim()).toBe('statusbar-position top');
  });
});
