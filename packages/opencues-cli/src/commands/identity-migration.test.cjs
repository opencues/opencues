// Tests for the USER.md → IDENTITY.md / user-context-mode → identity-context-mode
// migration logic that lives in `seed-configs` (silent self-heal) and
// `doctor` (informational surface).
//
// Each test spawns the real CLI against a sandbox HOME so the
// migration writes hit a tmpdir, not the developer's actual ~/.cues/.

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', '..', 'bin', 'cli.cjs');

function freshHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-mig-'));
  fs.mkdirSync(path.join(tmp, '.cues'), { recursive: true });
  return tmp;
}

function runCli(args, env) {
  return spawnSync('node', [CLI, ...args], {
    env: { ...process.env, ...env, FORCE_COLOR: '0', NO_COLOR: '1' },
    encoding: 'utf8',
  });
}

// ────────────────────────────────────────────────────────────────────────────
// seed-configs — self-heal renames
// ────────────────────────────────────────────────────────────────────────────

describe('seed-configs migration: USER.md → IDENTITY.md', () => {
  it('renames legacy USER.md to IDENTITY.md when only the legacy file exists', () => {
    const HOME = freshHome();
    const legacy = path.join(HOME, '.cues', 'USER.md');
    fs.writeFileSync(legacy, '---\nfirstName: Wilfred\n---\n', 'utf8');
    runCli(['seed-configs', '--silent'], { HOME });
    assert.ok(!fs.existsSync(legacy), 'legacy USER.md should be gone');
    const newFile = path.join(HOME, '.cues', 'IDENTITY.md');
    assert.ok(fs.existsSync(newFile), 'IDENTITY.md should exist');
    const written = fs.readFileSync(newFile, 'utf8');
    assert.match(written, /firstName: Wilfred/, 'frontmatter values should be preserved verbatim');
  });

  it('leaves BOTH files alone when IDENTITY.md already exists (avoids clobbering)', () => {
    const HOME = freshHome();
    const legacy = path.join(HOME, '.cues', 'USER.md');
    const current = path.join(HOME, '.cues', 'IDENTITY.md');
    fs.writeFileSync(legacy, '---\nfirstName: Old\n---\n', 'utf8');
    fs.writeFileSync(current, '---\nfirstName: New\n---\n', 'utf8');
    runCli(['seed-configs', '--silent'], { HOME });
    assert.ok(fs.existsSync(legacy), 'legacy USER.md should be left untouched');
    assert.ok(fs.existsSync(current), 'IDENTITY.md should still exist');
    assert.match(fs.readFileSync(current, 'utf8'), /firstName: New/, 'current should not be overwritten');
  });

  it('is a no-op when neither file exists', () => {
    const HOME = freshHome();
    const r = runCli(['seed-configs', '--silent'], { HOME });
    assert.strictEqual(r.status, 0);
    assert.ok(!fs.existsSync(path.join(HOME, '.cues', 'USER.md')));
    // IDENTITY.md may or may not be seeded depending on defaults; the
    // important contract is no crash on a fresh HOME.
  });
});

describe('seed-configs migration: user-context-mode → identity-context-mode scalar', () => {
  it('rewrites the legacy scalar in OPENCUES.md', () => {
    const HOME = freshHome();
    const settingsFile = path.join(HOME, '.cues', 'OPENCUES.md');
    // Minimal OPENCUES.md with the legacy scalar
    fs.writeFileSync(settingsFile, '---\nuser-context-mode: safe\n---\n', 'utf8');
    runCli(['seed-configs', '--silent'], { HOME });
    const written = fs.readFileSync(settingsFile, 'utf8');
    assert.match(written, /identity-context-mode: safe/, 'scalar should be renamed');
    assert.doesNotMatch(written, /user-context-mode:/, 'legacy scalar should be gone');
  });

  it('when BOTH scalars exist: legacy value wins (user-typed) + legacy line dropped', () => {
    // After mergeOpencuesMd injects the new `identity-context-mode: off`
    // default and the user had `user-context-mode: safe` set previously,
    // we expect the user's `safe` value to win and the legacy line to
    // be dropped. Right behaviour because the runtime back-compat-reads
    // both keys but seed-configs is converging the file onto the new
    // schema.
    const HOME = freshHome();
    const settingsFile = path.join(HOME, '.cues', 'OPENCUES.md');
    fs.writeFileSync(settingsFile, '---\nidentity-context-mode: off\nuser-context-mode: safe\n---\n', 'utf8');
    runCli(['seed-configs', '--silent'], { HOME });
    const written = fs.readFileSync(settingsFile, 'utf8');
    assert.match(written, /identity-context-mode: safe/, 'user value should win');
    assert.doesNotMatch(written, /user-context-mode:/, 'legacy line should be dropped');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// doctor — surface legacy state to the user
// ────────────────────────────────────────────────────────────────────────────

describe('doctor: surfaces legacy USER.md', () => {
  it('flags a leftover USER.md with a clear fix command', () => {
    const HOME = freshHome();
    fs.writeFileSync(path.join(HOME, '.cues', 'USER.md'), '---\nfirstName: Wilfred\n---\n', 'utf8');
    const r = runCli(['doctor'], { HOME });
    // doctor may exit non-zero on warnings — what we care about is the
    // stderr/stdout message naming the migration step.
    const out = r.stdout + r.stderr;
    assert.match(out, /USER\.md/, 'doctor should mention USER.md');
    assert.match(out, /opencues seed-configs/, 'doctor should point at the seed-configs fix');
  });

  it('flags legacy user-context-mode scalar in OPENCUES.md', () => {
    const HOME = freshHome();
    fs.writeFileSync(path.join(HOME, '.cues', 'OPENCUES.md'), '---\nuser-context-mode: safe\n---\n', 'utf8');
    const r = runCli(['doctor'], { HOME });
    const out = r.stdout + r.stderr;
    assert.match(out, /user-context-mode/, 'doctor should mention the legacy scalar');
    assert.match(out, /identity-context-mode/, 'doctor should mention the new scalar name');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Sanity — the renamed CLI path constant is correct end-to-end.
// ────────────────────────────────────────────────────────────────────────────

describe('opencues identity path: points at IDENTITY.md', () => {
  it('prints the new ~/.cues/IDENTITY.md path', () => {
    const HOME = freshHome();
    const r = runCli(['identity', 'path'], { HOME });
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /\.cues\/IDENTITY\.md/, 'path should end in IDENTITY.md');
    assert.doesNotMatch(r.stdout, /(USER|SENTINELS)\.md/, 'should not mention legacy names');
  });
});
