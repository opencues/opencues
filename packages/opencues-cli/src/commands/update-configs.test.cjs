// Tests for `opencues update-configs` — a thin dispatch wrapper around
// `seed-configs.cjs` (out of scope for this pass; these tests exercise
// update-configs.cjs's OWN contract: does it forward argv/ctx correctly
// and print its own --help, without duplicating seed-configs' full test
// matrix).
//
// Hermeticity: spawns the real CLI as a child process (mirrors
// validate.test.cjs's convention) so we never stub process.exit or
// touch this process's module cache. Every spawn gets HOME +
// USERPROFILE pointed at a fresh mkdtemp dir AND always passes
// `--project`, so the target is `<projectDir>/.cues` — the real user's
// `~/.cues/` is never read or written, even indirectly.

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CLI_BIN = path.join(REPO_ROOT, 'packages/opencues-cli/bin/cli.cjs');

let tmpHome;

before(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-updateconfigs-home-'));
});

after(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

function freshProject(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `oc-updateconfigs-proj-${name}-`));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function run(projectDir, args = []) {
  return spawnSync(
    'node',
    [CLI_BIN, 'update-configs', '--project', ...args],
    { cwd: projectDir, env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome }, encoding: 'utf8' },
  );
}

// ─── Happy path ────────────────────────────────────────────────────────────

describe('opencues update-configs', () => {
  it('happy: --help prints usage naming the four/five phases and does not touch the project dir', () => {
    const proj = freshProject('help');
    try {
      const res = spawnSync('node', [CLI_BIN, 'update-configs', '--help'], { cwd: proj, env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome }, encoding: 'utf8' });
      assert.strictEqual(res.status, 0);
      assert.match(res.stdout, /opencues update-configs/);
      assert.match(res.stdout, /SEED/);
      assert.match(res.stdout, /opencues seed-configs/);
      assert.match(res.stdout, /still works/);
      assert.strictEqual(fs.existsSync(path.join(proj, '.cues')), false);
    } finally {
      cleanup(proj);
    }
  });

  it('happy: --project --dry-run prints a plan and creates nothing', () => {
    const proj = freshProject('dryrun');
    try {
      const res = run(proj, ['--dry-run']);
      assert.strictEqual(res.status, 0, `stderr: ${res.stderr}`);
      assert.match(res.stdout, /\[dry-run\] Nothing executed\./);
      assert.strictEqual(fs.existsSync(path.join(proj, '.cues', 'cues')), false);
    } finally {
      cleanup(proj);
    }
  });

  it('happy: --project performs a real first-time seed of cues/blanks/auditors under <project>/.cues', () => {
    const proj = freshProject('realseed');
    try {
      const res = run(proj);
      assert.strictEqual(res.status, 0, `stderr: ${res.stderr}`);
      assert.strictEqual(fs.existsSync(path.join(proj, '.cues', 'cues')), true);
      assert.strictEqual(fs.existsSync(path.join(proj, '.cues', 'blanks')), true);
      assert.strictEqual(fs.existsSync(path.join(proj, '.cues', 'auditors')), true);
      // Project scope never seeds a top-level OPENCUES.md (runtime
      // settings are user-level only) or scripts/ (per SEED_FILES_PROJECT).
      assert.strictEqual(fs.existsSync(path.join(proj, '.cues', 'OPENCUES.md')), false);
    } finally {
      cleanup(proj);
    }
  });
});

// ─── Edge cases ────────────────────────────────────────────────────────────

describe('opencues update-configs — edge cases', () => {
  it('edge: running twice is idempotent (second run reports SKIP, never errors, never duplicates)', () => {
    const proj = freshProject('idempotent');
    try {
      const first = run(proj);
      assert.strictEqual(first.status, 0);
      const second = run(proj);
      assert.strictEqual(second.status, 0, `stderr: ${second.stderr}`);
      assert.match(second.stdout, /SKIP \(exists\)/);
    } finally {
      cleanup(proj);
    }
  });

  it('edge: --silent suppresses stdout entirely while still performing the seed', () => {
    const proj = freshProject('silent');
    try {
      const res = run(proj, ['--silent']);
      assert.strictEqual(res.status, 0, `stderr: ${res.stderr}`);
      assert.strictEqual(res.stdout, '');
      assert.strictEqual(fs.existsSync(path.join(proj, '.cues', 'cues')), true);
    } finally {
      cleanup(proj);
    }
  });

  it('edge: a pre-existing user-authored file under .cues/cues/<name>/CUE.md is never overwritten', () => {
    const proj = freshProject('preserve');
    try {
      const customDir = path.join(proj, '.cues', 'cues', 'my-custom-cue');
      fs.mkdirSync(customDir, { recursive: true });
      fs.writeFileSync(path.join(customDir, 'CUE.md'), '---\nname: my-custom-cue\n---\ncustom content\n');
      const res = run(proj);
      assert.strictEqual(res.status, 0, `stderr: ${res.stderr}`);
      assert.strictEqual(
        fs.readFileSync(path.join(customDir, 'CUE.md'), 'utf8'),
        '---\nname: my-custom-cue\n---\ncustom content\n',
      );
    } finally {
      cleanup(proj);
    }
  });
});

// ─── Invalid input ─────────────────────────────────────────────────────────

describe('opencues update-configs — invalid input', () => {
  it('invalid: unknown extra flags are ignored — command still succeeds', () => {
    const proj = freshProject('unknownflag');
    try {
      const res = run(proj, ['--this-is-not-a-real-flag']);
      assert.strictEqual(res.status, 0, `stderr: ${res.stderr}`);
      assert.strictEqual(fs.existsSync(path.join(proj, '.cues', 'cues')), true);
    } finally {
      cleanup(proj);
    }
  });

  it('invalid: target path exists as a FILE instead of a directory — command fails loudly rather than silently no-op-ing', () => {
    // .cues must be a directory; if a file of that name already exists,
    // fs.mkdirSync(targetDir, { recursive: true }) throws ENOTDIR/EEXIST.
    // Pin this as an observed crash (not a graceful degrade) rather than
    // asserting behavior seed-configs.cjs doesn't actually implement.
    const proj = freshProject('fileclash');
    try {
      fs.writeFileSync(path.join(proj, '.cues'), 'not a directory');
      const res = run(proj);
      assert.notStrictEqual(res.status, 0, 'expected a nonzero exit when .cues is a file, not a directory');
      assert.ok(res.stderr.length > 0 || res.status !== 0, 'expected a visible failure signal');
    } finally {
      cleanup(proj);
    }
  });
});
