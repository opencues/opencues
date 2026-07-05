// Playwright fixture that loads the REAL unpacked OpenCues extension
// into Chromium and exposes helpers to seed config + observe boot.
//
// Extension loading requires a persistent context + new-headless
// (--headless=new works without a display, unlike old headless which
// can't load extensions, and unlike headed which needs an X server in
// WSL). The extension root is the integrations/chrome dir (manifest.json
// there references dist/content.js etc.) — build it first with
// `npm run build`.
//
// Config normally arrives from the native-messaging host, which does not
// run under Playwright. So `seed()` writes the same chrome.storage.local
// keys the host would push, via the service-worker context, BEFORE the
// page's content script boots.

import {
  test as base,
  chromium,
  type BrowserContext,
  type Worker,
} from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// tests/e2e/ -> integrations/chrome/ (dir containing manifest.json)
export const EXT_ROOT = path.resolve(here, '../../');

export interface SeedData {
  /** Bundle file map, keys relative to `.cues/` (e.g. "OPENCUES.md",
   *  "cues/foo/CUE.md", "blanks/bar/BLANK.md"). */
  bundleFiles: Record<string, string>;
  /** Provider API keys the host would push. resolveLLM refuses to build
   *  a source without a non-empty key, so seed a dummy for the provider
   *  under test (e.g. { GROQ_API_KEY: 'test-key' }). */
  hostKeys?: Record<string, string>;
}

const RUNTIME_PREFIX = 'opencues_runtime:/chrome-storage/.cues/';

export const test = base.extend<{
  context: BrowserContext;
  serviceWorker: Worker;
  seed: (data: SeedData) => Promise<void>;
}>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [
        '--headless=new',
        `--disable-extensions-except=${EXT_ROOT}`,
        `--load-extension=${EXT_ROOT}`,
        '--no-sandbox',
      ],
      serviceWorkers: 'allow',
    });
    await use(context);
    await context.close();
  },

  serviceWorker: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await use(sw);
  },

  seed: async ({ serviceWorker }, use) => {
    await use(async (data: SeedData) => {
      // Mirror the bundle's OPENCUES.md into the per-file runtime
      // override key too — the boot-time debug-mode read consults
      // `opencues_runtime:/chrome-storage/.cues/OPENCUES.md` first,
      // falling back to the bundle. Seeding both guarantees the setting
      // is live before the content script reads it.
      const overrides: Record<string, string> = {};
      if (data.bundleFiles['OPENCUES.md'] !== undefined) {
        overrides[`${RUNTIME_PREFIX}OPENCUES.md`] = data.bundleFiles['OPENCUES.md'];
      }
      await serviceWorker.evaluate(
        async ([d, ov]) => {
          await chrome.storage.local.set({
            opencues_bundle: {
              files: (d as { bundleFiles: Record<string, string> }).bundleFiles,
              root: '/chrome-storage/.cues',
            },
            ...((d as { hostKeys?: Record<string, string> }).hostKeys
              ? { opencues_host_keys: (d as { hostKeys?: Record<string, string> }).hostKeys }
              : {}),
            ...(ov as Record<string, string>),
          });
        },
        [data, overrides] as const,
      );
    });
  },
});

export const expect = test.expect;
