// Real-browser verification that the (unchanged) ProseMirror branch
// — execCommand('insertText') over select-all — still produces ONE
// undo entry. This was already correct pre-fix; the test pins it
// against regression while I'm refactoring nearby code.

import { test, expect } from '@playwright/test';

test.describe('ProseMirror — replaceAllText undo behaviour', () => {
  test('writes new body and a single Ctrl+Z restores the original', async ({ page }) => {
    page.on('pageerror', (err) => console.log('[page error]', err.message));
    await page.goto('/tests/playwright/pages/prosemirror.html');
    await page.waitForFunction(() => !!(window as { __OC?: unknown }).__OC, undefined, { timeout: 5000 });

    const editor = page.locator('#pm-editable');
    await expect(editor).toHaveText('original');

    await page.evaluate(() => { window.__OC.replaceAllText('rewritten'); });
    await expect(editor).toHaveText('rewritten');

    await editor.focus();
    await page.keyboard.press('Control+Z');

    const afterUndo = (await editor.textContent())?.trim() ?? '';
    expect(afterUndo).not.toBe('');
    expect(afterUndo).toBe('original');
  });
});
