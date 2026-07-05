import { defineConfig } from '@playwright/test';

// End-to-end suite that loads the REAL unpacked extension into Chromium
// and drives features to observable output — distinct from the
// write-path suite (playwright.config.ts / *.pw.test.ts), which loads a
// test-bundle subset with a chrome-API stub and never boots the
// extension.
//
// Two check categories live here (tests/e2e/*.e2e.test.ts):
//   - security  — a control that should block still blocks (degraded-open detector)
//   - scenario  — a real feature journey runs end-to-end to observable output
//
// Run-on-demand (NOT a required CI gate):
//   npm run build && npm run test:e2e:chrome
//
// The extension is loaded from the WSL-side dist/ directly (no /mnt/c
// sync, no native-messaging host needed for the host-independent
// features exercised here). Extension loading uses --headless=new via
// the fixture in tests/e2e/extension.fixture.ts.

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.e2e\.test\.ts/,
  // Extension tests share one persistent browser context per worker;
  // keep them serial within a file to avoid storage cross-talk.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:4174',
    trace: 'on-first-retry',
  },
  // Serve the chrome integration root so pages at
  // /tests/e2e/pages/<name>.html are reachable over http:// (content
  // scripts don't inject on file://).
  webServer: {
    command: 'npx http-server . -p 4174 -s -c-1',
    port: 4174,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
