// Tests for lib/ai-callable.cjs — the ai-callable trust-list manager
// embedded by `opencues config`.
//
// Hermeticity: this module resolves its target file ONCE at require
// time via `process.env.OPENCUES_HOME || path.join(os.homedir(), '.cues')`
// (see the module's `HOME`/`OPENCUES_PATH` constants at the top of the
// file). That means:
//   1. We must set `process.env.OPENCUES_HOME` to a throwaway mkdtemp
//      dir BEFORE the very first `require('./ai-callable.cjs')` in this
//      process, since the path is captured once and cached.
//   2. Because OPENCUES_HOME takes priority over os.homedir() in the
//      module's own resolution, this sidesteps the HOME/USERPROFILE
//      windows-homedir gotcha entirely — no real home directory is ever
//      consulted.
// We additionally set HOME/USERPROFILE for defense-in-depth (belt and
// braces), even though the module never reads them once OPENCUES_HOME
// is set.
//
// Only `manage` and `trustedCount` are exported — the parsing/writing
// helpers (readAllow, writeAllow, blankInfo) are module-private, so
// coverage here is necessarily via those two entry points.

'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let SANDBOX;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_OPENCUES_HOME = process.env.OPENCUES_HOME;

before(() => {
  SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-ai-callable-test-'));
  process.env.OPENCUES_HOME = SANDBOX;
  process.env.HOME = SANDBOX;
  process.env.USERPROFILE = SANDBOX;
});

after(() => {
  if (ORIGINAL_OPENCUES_HOME === undefined) delete process.env.OPENCUES_HOME; else process.env.OPENCUES_HOME = ORIGINAL_OPENCUES_HOME;
  if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Required to run AFTER the env vars above are set (module-load-time capture).
const { manage, trustedCount } = require('./ai-callable.cjs');

const OPENCUES_PATH = path.join(SANDBOX, 'OPENCUES.md');
function writeOpenCues(body) {
  fs.writeFileSync(OPENCUES_PATH, body);
}
function removeOpenCues() {
  try { fs.unlinkSync(OPENCUES_PATH); } catch { /* ignore */ }
}

beforeEach(() => {
  removeOpenCues();
});

// ─── Happy path ────────────────────────────────────────────────────────────

describe('trustedCount', () => {
  it('happy: returns 0 when OPENCUES.md exists with no ai-callable-allow line', () => {
    writeOpenCues('---\nvoice-mode: off\n---\n');
    assert.strictEqual(trustedCount(), 0);
  });

  it('happy: counts a comma-separated ai-callable-allow list', () => {
    writeOpenCues('---\nai-callable-allow: foo, bar, baz\n---\n');
    assert.strictEqual(trustedCount(), 3);
  });

  it('happy: single-entry list counts as 1', () => {
    writeOpenCues('---\nai-callable-allow: onlyone\n---\n');
    assert.strictEqual(trustedCount(), 1);
  });
});

// ─── Edge cases ────────────────────────────────────────────────────────────

describe('trustedCount — edge cases', () => {
  it('edge: trims whitespace around each entry', () => {
    writeOpenCues('---\nai-callable-allow:   foo ,  bar  ,baz\n---\n');
    assert.strictEqual(trustedCount(), 3);
  });

  it('edge: an empty value after the colon yields zero entries', () => {
    writeOpenCues('---\nai-callable-allow:\n---\n');
    assert.strictEqual(trustedCount(), 0);
  });

  it('edge: legacy `param-safe-allow:` scalar is read as a fallback', () => {
    writeOpenCues('---\nparam-safe-allow: legacyone, legacytwo\n---\n');
    assert.strictEqual(trustedCount(), 2);
  });

  it('edge: `ai-callable-allow:` takes priority over the legacy scalar when both are present', () => {
    writeOpenCues('---\nai-callable-allow: new1\nparam-safe-allow: legacy1, legacy2\n---\n');
    assert.strictEqual(trustedCount(), 1);
  });

  it('edge: a stray fence-only value (e.g. "---") is filtered out, not counted as an entry', () => {
    // The `^-+$` guard in readAllow drops any all-dash residue.
    writeOpenCues('---\nai-callable-allow: ---\n---\n');
    assert.strictEqual(trustedCount(), 0);
  });

  it('edge: does not match a scalar with a similar-but-different name', () => {
    writeOpenCues('---\nnot-ai-callable-allow-really: foo\n---\n');
    assert.strictEqual(trustedCount(), 0);
  });
});

// ─── Invalid input ─────────────────────────────────────────────────────────

describe('trustedCount — invalid / missing file', () => {
  it('invalid: OPENCUES.md does not exist at all — returns 0, not a throw', () => {
    removeOpenCues();
    assert.doesNotThrow(() => trustedCount());
    assert.strictEqual(trustedCount(), 0);
  });

  it('invalid: OPENCUES.md exists but has no frontmatter fence at all', () => {
    writeOpenCues('just some prose, no frontmatter\n');
    assert.strictEqual(trustedCount(), 0);
  });

  it('invalid: 0-byte OPENCUES.md returns 0, not a throw', () => {
    writeOpenCues('');
    assert.doesNotThrow(() => trustedCount());
    assert.strictEqual(trustedCount(), 0);
  });
});

describe('manage — TTY gate', () => {
  it('invalid: rejects with a clear error when called in a non-interactive environment (no crash, no partial write)', async () => {
    // OPENCUES.md need not even exist — manage() should reach the
    // prompt.select() call (which throws in non-TTY) without crashing
    // on any earlier step (missing file, missing blanks dir, etc).
    removeOpenCues();
    const origLog = console.log;
    console.log = () => {};
    try {
      await assert.rejects(
        () => manage({ pkg: { version: 'test' } }),
        /requires an interactive terminal/,
      );
    } finally {
      console.log = origLog;
    }
  });

  it('edge: still reaches the TTY gate (no earlier crash) when OPENCUES.md declares a trusted entry with an unreachable blank', () => {
    writeOpenCues('---\nai-callable-allow: ghost-blank\n---\n');
    const origLog = console.log;
    console.log = () => {};
    return assert.rejects(
      () => manage({ pkg: { version: 'test' } }),
      /requires an interactive terminal/,
    ).finally(() => { console.log = origLog; });
  });
});
