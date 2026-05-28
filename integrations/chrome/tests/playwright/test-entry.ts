// Playwright test entry. Bundles replaceAllText + publishTarget from
// opencues-bootstrap and exposes them on window so the test pages
// can drive the production code path directly.
//
// Built by esbuild before each Playwright run (see playwright.config.ts
// globalSetup). Output: tests/playwright/test-bundle.js.

// Side-effect import runs FIRST (ES imports are hoisted in source-order
// per ES spec) so chrome.* stubs are in place before the bootstrap
// module's top-level code reads them.
import './chrome-stub';
import { publishTarget, replaceAllText } from '../../src/opencues-bootstrap';

declare global {
  interface Window {
    __OC: {
      publishTarget: typeof publishTarget;
      replaceAllText: typeof replaceAllText;
    };
  }
}

window.__OC = { publishTarget, replaceAllText };
