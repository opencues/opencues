// Known-bug pin for `opencues init` (non --minimal path).
//
// init.cjs's own `files` list (init.cjs:27) is:
//   ['CUES.md', 'BLANKS.md', 'AUDITORS.md', 'README.md']
// and for each non-README file it does (init.cjs:52):
//   const content = minimal && p.name !== 'README.md' ? '' : fs.readFileSync(p.src, 'utf8');
// i.e. WITHOUT --minimal, every listed file is read from
// `ctx.PKG_DIR/src/templates/<name>`. But there is no
// `src/templates/AUDITORS.md` in the package (only CUES.md, BLANKS.md,
// README.md, and new/{cue,blank}.md exist).
//
// Expected: `opencues init` (no flags) scaffolds all four files
// successfully, same as `opencues init --minimal` does today.
// Actual: it creates CUES.md and BLANKS.md, THEN throws an uncaught
// ENOENT reading the missing AUDITORS.md template, leaving `.cues/`
// half-scaffolded (no AUDITORS.md, no README.md) and the process exits 1
// via cli.cjs's top-level catch (`opencues init: Error: ENOENT ...`).
//
// Proposed fix direction: add `packages/opencues-cli/src/templates/AUDITORS.md`
// (mirroring the comment-only schema style of CUES.md/BLANKS.md), OR make
// the read defensive (fall back to '' when the template file is missing)
// so a future new scaffolded file can't crash the whole command the same way.
//
// This is a vitest file (not node:test) specifically so `it.fails` can
// pin the bug — see packages/opencues-runtime/src/modules/blank-fill.test.ts
// for the established it.fails convention this follows. Not picked up by
// this package's `node --test src/commands/*.test.cjs` script (vitest
// cannot even be `require()`d from a .cjs file — confirmed empirically);
// run explicitly with `npx vitest run src/commands/init.knownbug.test.mjs`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const init = require('./init.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(PKG_DIR, '../..');

let realCwd;
let projectDir;

beforeEach(() => {
  realCwd = process.cwd();
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-init-knownbug-'));
  process.chdir(projectDir);
});

afterEach(() => {
  process.chdir(realCwd);
  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('known bug: init.cjs missing AUDITORS.md template', () => {
  it.fails('opencues init (no --minimal) should scaffold all four files without throwing', () => {
    const origLog = console.log;
    console.log = () => {};
    try {
      init([], { PKG_DIR, REPO_ROOT });
    } finally {
      console.log = origLog;
    }
    const dir = path.join(projectDir, '.cues');
    expect(fs.existsSync(path.join(dir, 'CUES.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'BLANKS.md'))).toBe(true);
    // This is the line that currently throws before ever being reached:
    expect(fs.existsSync(path.join(dir, 'AUDITORS.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true);
  });
});
