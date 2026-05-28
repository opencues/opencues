// Builds test-bundle.js before the Playwright run.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export default async function globalSetup() {
  const here = dirname(fileURLToPath(import.meta.url));
  execFileSync('node', [resolve(here, 'build.mjs')], { stdio: 'inherit' });
}
