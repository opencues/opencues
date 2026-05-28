import { defineConfig, devices } from '@playwright/test';

// Stateful layer for replaceAllText undo behaviour. The vitest+jsdom
// suite (src/replace-all-text-undo.test.ts) verifies CALL-SHAPE — that
// the bootstrap issues the right command per editor path. These tests
// verify the BROWSER'S RESPONSE to that command in real Chrome —
// specifically, that `replaceAllText` lands ONE undo entry and a
// single Ctrl+Z restores the original buffer (not blank).
//
// Each harness page (tests/playwright/pages/<editor>.html) loads
// test-bundle.js, which exposes window.__OC.{publishTarget, replaceAllText}.
// The page wires up a target element appropriate to that editor.

export default defineConfig({
  testDir: './tests/playwright',
  testMatch: /.*\.pw\.test\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Serve from the chrome integration root so harness pages can pull
  // in Draft.css from node_modules. The pages live at
  // /tests/playwright/pages/<editor>.html.
  webServer: {
    command: 'npx http-server . -p 4173 -s -c-1',
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  globalSetup: './tests/playwright/global-setup.ts',
});
