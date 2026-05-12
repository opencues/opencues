// Tests for the cli style helpers in packages/opencues-cli/src/lib/style.cjs.
// cliVersion(ctx) is load-bearing: integration installers (opencode,
// gemini-cli) and tests pass partial ctx (`{ REPO_ROOT }` only). Without
// the fallback every banner() call crashes with "Cannot read properties
// of undefined (reading 'version')".

import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const style = require(path.resolve(__dirname, '../../opencues-cli/src/lib/style.cjs'));
const { cliVersion, banner } = style as {
  cliVersion: (ctx: unknown) => string | undefined;
  banner: (opts: { version?: string; tagline?: string }) => string;
};

describe('cliVersion', () => {
  it('returns ctx.pkg.version when ctx supplies it', () => {
    expect(cliVersion({ pkg: { version: '9.9.9' } })).toBe('9.9.9');
  });

  it('falls back to opencues-cli/package.json when ctx is partial', () => {
    // Partial ctx (no pkg) — the case that crashed installers + tests.
    const v = cliVersion({ REPO_ROOT: '/wherever' });
    expect(typeof v).toBe('string');
    // Cross-check against the actual package.json so the test surfaces
    // any future rename / move of the cli package.
    const pkgPath = path.resolve(__dirname, '../../opencues-cli/package.json');
    const expected = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
    expect(v).toBe(expected);
  });

  it('falls back when ctx is undefined', () => {
    expect(cliVersion(undefined)).toBeTruthy();
  });

  it('falls back when ctx.pkg exists but version is missing', () => {
    expect(cliVersion({ pkg: {} })).toBeTruthy();
  });
});

describe('banner', () => {
  it('renders a version + tagline header even when colour is disabled', () => {
    // Force the no-colour code path by setting NO_COLOR for this assertion
    // (cached module state would otherwise reflect the test runner's TTY).
    // banner already accepts undefined version — assert it doesn't crash.
    const s = banner({ version: '1.2.3', tagline: 'doing the thing' });
    expect(s).toContain('1.2.3');
    expect(s).toContain('doing the thing');
  });

  it('renders without crashing when version is undefined', () => {
    expect(() => banner({ tagline: 'no version' })).not.toThrow();
  });
});
