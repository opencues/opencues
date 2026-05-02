// Pins the seed-configs target-state classification rule.
//
// The bug this guards against: the historic `e.exists = fs.existsSync(dst)`
// check classified a 0-byte file as "exists", so seed-configs would skip it
// forever — leaving the user with an empty ~/.opencuesrc. That
// empty file silently breaks `opencues ___` / `config ___` blank-fills on
// every native host (the OpenCuesSettingsBlank no-ops on empty content).
//
// New rule (in integrations/claude-code/bin/seed-helpers.cjs):
//   true  → skip (file exists with content, OR directory exists)
//   false → seed (missing OR file is 0 bytes)
//
// These tests live in opencues-runtime/testing/ rather than next to the
// helper so they pick up the workspace's vitest runner without needing a
// separate test setup in the CC integration package.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// CommonJS module — load via createRequire since we're in ESM-mode tests.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const SEED_HELPERS_PATH = path.resolve(
  __dirname,
  '../../../integrations/claude-code/bin/seed-helpers.cjs',
);
const { targetExistsWithContent } = require(SEED_HELPERS_PATH) as {
  targetExistsWithContent: (dst: string) => boolean;
};

describe('seed-configs: targetExistsWithContent', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-seed-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns false for a missing path (must seed)', () => {
    expect(targetExistsWithContent(path.join(tmp, 'nope.md'))).toBe(false);
  });

  it('returns false for a 0-byte file (must re-seed — the bug class this fixes)', () => {
    const f = path.join(tmp, 'opencues.md');
    fs.writeFileSync(f, '');
    expect(fs.statSync(f).size).toBe(0); // sanity
    expect(targetExistsWithContent(f)).toBe(false);
  });

  it('returns true for a file with any non-empty content (skip — preserves user edits)', () => {
    const f = path.join(tmp, 'cues.md');
    fs.writeFileSync(f, 'x'); // single byte is enough
    expect(targetExistsWithContent(f)).toBe(true);
  });

  it('returns true for a directory regardless of contents (cues/, blanks/ are always present-once-seeded)', () => {
    const d = path.join(tmp, 'cues');
    fs.mkdirSync(d);
    expect(targetExistsWithContent(d)).toBe(true);
  });

  it('returns true for an empty directory (fs.stat.size on a dir is the entry size, not contents)', () => {
    const d = path.join(tmp, 'blanks');
    fs.mkdirSync(d);
    // Sanity: directory has zero entries but the function still says "present".
    expect(fs.readdirSync(d)).toHaveLength(0);
    expect(targetExistsWithContent(d)).toBe(true);
  });
});
