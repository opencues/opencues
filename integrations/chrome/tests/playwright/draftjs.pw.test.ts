// Real-browser verification of replaceAllText against a live Draft.js
// editor (the engine Twitter/X compose uses).
//
// The hypothesis the stateless tests can't pin down: with Backspace
// removed, does Draft.js's onPaste handler actually replace the
// Ctrl+A-set internal selection (one history entry) instead of
// appending at end-of-buffer (which would produce 'originalrewritten')?

import { test, expect } from '@playwright/test';

test.describe('Draft.js editor — replaceAllText undo behaviour', () => {
  test('writes new body and a single Ctrl+Z restores the original', async ({ page }) => {
    page.on('pageerror', (err) => console.log('[page error]', err.message));
    await page.goto('/tests/playwright/pages/draftjs.html');
    await page.waitForFunction(() => !!(window as { __OC?: unknown }).__OC, undefined, { timeout: 5000 });

    const editor = page.locator('#draft-editable');
    await expect(editor).toContainText('original');

    await page.evaluate(() => { window.__OC.replaceAllText('rewritten'); });
    await expect(editor).toContainText('rewritten');

    // Guard: should NOT contain both (append-bug shape).
    expect(await editor.textContent()).not.toContain('originalrewritten');

    await editor.focus();
    await page.keyboard.press('Control+Z');

    const afterUndo = (await editor.textContent())?.trim() ?? '';
    expect(afterUndo).not.toBe('');
    expect(afterUndo).toContain('original');
    expect(afterUndo).not.toContain('rewritten');
  });
});
