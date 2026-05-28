// Real-browser verification of replaceAllText against a live Lexical
// editor (the engine Reddit's compose uses).
//
// This is the high-risk path the stateless tests can't pin down. The
// hypothesis: with __lexicalEditor + $createTextNode etc. available on
// window, the bootstrap's API-path runs one editor.update() that
// clears + inserts in a single transaction. The harness exposes all
// those globals, so we exercise the API branch.

import { test, expect } from '@playwright/test';

test.describe('Lexical editor — replaceAllText undo behaviour', () => {
  test('writes new body and a single Ctrl+Z restores the original', async ({ page }) => {
    page.on('pageerror', (err) => console.log('[page error]', err.message));
    await page.goto('/tests/playwright/pages/lexical.html');
    await page.waitForFunction(() => !!(window as { __OC?: unknown }).__OC, undefined, { timeout: 5000 });

    const editor = page.locator('#editor');
    await expect(editor).toHaveText('original');

    await page.evaluate(() => { window.__OC.replaceAllText('rewritten'); });
    await expect(editor).toHaveText('rewritten');

    await editor.focus();
    await page.keyboard.press('Control+Z');

    // CRITICAL: must NOT be empty. Bug-shape would land here.
    const afterUndo = (await editor.textContent())?.trim() ?? '';
    expect(afterUndo).not.toBe('');
    expect(afterUndo).toBe('original');
  });

  test('FALLBACK PATH (no __lexicalEditor): Ctrl+A + paste still produces a single undo entry', async ({ page }) => {
    page.on('pageerror', (err) => console.log('[page error]', err.message));
    await page.goto('/tests/playwright/pages/lexical.html');
    await page.waitForFunction(() => !!(window as { __OC?: unknown }).__OC, undefined, { timeout: 5000 });

    // Hide __lexicalEditor + the Lexical creator globals so the
    // bootstrap's API-path check (lex && $createParagraphNode &&
    // $createTextNode) fails and it falls back to Ctrl+A + paste.
    // The real editor is still mounted underneath — it just looks
    // "anonymous" to the bootstrap. This mirrors deployments where
    // Lexical is bundled but doesn't expose the instance on the DOM.
    await page.evaluate(() => {
      const el = document.getElementById('editor') as HTMLElement & { __lexicalEditor?: unknown };
      delete el.__lexicalEditor;
      delete (window as Record<string, unknown>).$createParagraphNode;
      delete (window as Record<string, unknown>).$createTextNode;
    });

    const editor = page.locator('#editor');
    await expect(editor).toHaveText('original');

    await page.evaluate(() => { window.__OC.replaceAllText('rewritten'); });
    await expect(editor).toHaveText('rewritten');

    await editor.focus();
    await page.keyboard.press('Control+Z');

    const afterUndo = (await editor.textContent())?.trim() ?? '';
    // The critical assertion: not blank after a single Ctrl+Z.
    expect(afterUndo).not.toBe('');
    expect(afterUndo).toBe('original');
  });

  test('two consecutive substitutions undo to original in two presses', async ({ page }) => {
    await page.goto('/tests/playwright/pages/lexical.html');
    await page.waitForFunction(() => !!(window as { __OC?: unknown }).__OC, undefined, { timeout: 5000 });
    const editor = page.locator('#editor');

    await page.evaluate(() => { window.__OC.replaceAllText('first'); });
    await expect(editor).toHaveText('first');
    await page.evaluate(() => { window.__OC.replaceAllText('second'); });
    await expect(editor).toHaveText('second');

    await editor.focus();
    await page.keyboard.press('Control+Z');
    expect((await editor.textContent())?.trim()).toBe('first');
    expect((await editor.textContent())?.trim()).not.toBe('');

    await page.keyboard.press('Control+Z');
    expect((await editor.textContent())?.trim()).toBe('original');
  });
});
