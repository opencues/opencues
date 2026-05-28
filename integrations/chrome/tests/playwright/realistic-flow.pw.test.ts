// Reproduce the user-reported symptom: after a transform-blank
// substitution, ONE Ctrl+Z lands on a BLANK buffer; a SECOND Ctrl+Z
// gets back to the summon text. The pinned-cases generic-ce test
// passes because it seeds via textContent (no undo entries) — in real
// usage the user TYPES the summon text, which adds entries above the
// substitution on the stack.
//
// This test types the seed text via the keyboard so the stack mirrors
// the real flow:
//   stack[0..n] = typing of 'fix this _'
//   stack[n+1]  = replaceAllText('rewritten body')
// One Ctrl+Z SHOULD revert replaceAllText → 'fix this _'.
// If it lands on '' → blank-screen bug still present.

import { test, expect } from '@playwright/test';

test.describe('Realistic typed-summon-then-substitute flow', () => {
  test('after typed summon + replaceAllText, one Ctrl+Z restores the typed summon (not blank)', async ({ page }) => {
    page.on('pageerror', (err) => console.log('[page error]', err.message));
    await page.goto('/tests/playwright/pages/generic.html');
    await page.waitForFunction(() => !!(window as { __OC?: unknown }).__OC, undefined, { timeout: 5000 });

    const editor = page.locator('#editor');

    // Clear the seeded text and type the summon afresh — keystrokes go
    // through Chrome's input pipeline and DO create undo entries.
    await editor.focus();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.keyboard.type('fix this _');

    // Sanity: the editor now ends with "fix this _" (delete-then-type
    // may have inherited the original seed's div block structure).
    expect((await editor.textContent())?.trim()).toContain('fix this _');

    // Fire the substitution.
    await page.evaluate(() => { window.__OC.replaceAllText('rewritten body'); });
    await expect(editor).toHaveText('rewritten body');

    // First Ctrl+Z. With the fix correctly producing ONE undo entry,
    // this should restore the typed state ("fix this _" or its block-
    // structured equivalent). NOT blank.
    await editor.focus();
    await page.keyboard.press('Control+Z');

    const afterUndo = (await editor.textContent())?.trim() ?? '';
    // CRITICAL — this is the user-reported failure mode.
    expect(afterUndo).not.toBe('');
    expect(afterUndo).toContain('fix this _');
  });

  test('after typed multi-block summon + replaceAllText, one Ctrl+Z restores the typed summon', async ({ page }) => {
    page.on('pageerror', (err) => console.log('[page error]', err.message));
    await page.goto('/tests/playwright/pages/generic.html');
    await page.waitForFunction(() => !!(window as { __OC?: unknown }).__OC, undefined, { timeout: 5000 });

    const editor = page.locator('#editor');

    // Multi-block: Gmail's compose creates a new <div> on each Enter.
    await editor.focus();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.keyboard.type('Hello world');
    await page.keyboard.press('Enter');
    await page.keyboard.type('fix this paragraph _');

    const seedText = (await editor.textContent())?.trim() ?? '';
    expect(seedText).toContain('fix this paragraph _');

    await page.evaluate(() => {
      window.__OC.replaceAllText('Hello world\nThe paragraph is now fixed.');
    });
    await expect(editor).toContainText('paragraph is now fixed');

    await editor.focus();
    await page.keyboard.press('Control+Z');

    const afterUndo = (await editor.textContent())?.trim() ?? '';
    expect(afterUndo).not.toBe('');
    expect(afterUndo).toContain('fix this paragraph _');
  });
});
