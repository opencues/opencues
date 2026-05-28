// Real-browser verification of replaceAllText's undo behaviour on a
// plain <div contenteditable> (Gmail / YouTube / generic compose).
//
// The structural risk the stateless tests can't pin down: does Chrome's
// `execCommand('insertHTML', false, html)` on a select-all selection
// actually produce ONE undo entry? If yes → Ctrl+Z restores 'original'.
// If no (two entries, browser implementation detail) → Ctrl+Z leaves
// the buffer blank, same bug surface we set out to fix.

import { test, expect } from '@playwright/test';

test.describe('Generic contenteditable — replaceAllText undo behaviour', () => {
  test('writes new body and a single Ctrl+Z restores the original', async ({ page }) => {
    page.on('pageerror', (err) => console.log('[page error]', err.message));
    await page.goto('/tests/playwright/pages/generic.html');
    // Give the bundle one tick to finish initialising.
    await page.waitForFunction(() => !!(window as { __OC?: unknown }).__OC, undefined, { timeout: 5000 });

    const editor = page.locator('#editor');

    // Sanity: page loaded with the seed body.
    await expect(editor).toHaveText('original body');

    // Drive the production code path.
    await page.evaluate(() => {
      window.__OC.replaceAllText('rewritten body');
    });

    await expect(editor).toHaveText('rewritten body');

    // First Ctrl+Z. With the fix (one insertHTML entry) → buffer goes
    // back to 'original body'. Pre-fix (delete + paste = two entries)
    // → buffer would be blank.
    await editor.focus();
    await page.keyboard.press('Control+Z');

    const afterUndo = (await editor.textContent())?.trim() ?? '';
    expect(afterUndo).toBe('original body');
    expect(afterUndo).not.toBe('');
  });

  test('two consecutive substitutions undo cleanly in reverse order', async ({ page }) => {
    await page.goto('/tests/playwright/pages/generic.html');
    const editor = page.locator('#editor');
    await expect(editor).toHaveText('original body');

    await page.evaluate(() => { window.__OC.replaceAllText('first rewrite'); });
    await expect(editor).toHaveText('first rewrite');
    await page.evaluate(() => { window.__OC.replaceAllText('second rewrite'); });
    await expect(editor).toHaveText('second rewrite');

    // Each substitution is one undo entry. Two presses → original.
    await editor.focus();
    await page.keyboard.press('Control+Z');
    expect((await editor.textContent())?.trim()).toBe('first rewrite');
    await page.keyboard.press('Control+Z');
    expect((await editor.textContent())?.trim()).toBe('original body');
  });

  test('Ctrl+Y after Ctrl+Z restores the substitution (redo path is intact)', async ({ page }) => {
    await page.goto('/tests/playwright/pages/generic.html');
    const editor = page.locator('#editor');

    await page.evaluate(() => { window.__OC.replaceAllText('rewritten body'); });
    await expect(editor).toHaveText('rewritten body');

    await editor.focus();
    await page.keyboard.press('Control+Z');
    expect((await editor.textContent())?.trim()).toBe('original body');

    await page.keyboard.press('Control+Y');
    expect((await editor.textContent())?.trim()).toBe('rewritten body');
  });
});
