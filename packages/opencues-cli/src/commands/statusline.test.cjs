// Tests for `opencues statusline` — enable/disable/status against
// ~/.claude/settings.json (user scope) or <cwd>/.claude/settings.json
// (project scope).
//
// Hermeticity: HOME + USERPROFILE point at a fresh mkdtemp dir for every
// test (lib/cc-statusline.cjs resolves the fork script + settings path
// via os.homedir()). Project-scope tests additionally chdir into a
// throwaway project dir (statusline.cjs never threads an explicit cwd
// through to the lib — project scope is always the real process.cwd()),
// and restore the original cwd afterward. statusline.cjs never calls
// process.exit — every path returns a numeric code — so no stubbing is
// needed.

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const statusline = require('./statusline.cjs');

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const ctx = { pkg: { version: 'test' } };

let tmpHome;
let realHome, realUserProfile;
let logs, errs;
let origLog, origErr;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-statusline-test-'));
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  logs = [];
  errs = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a) => logs.push(stripAnsi(a.join(' ')));
  console.error = (...a) => errs.push(stripAnsi(a.join(' ')));
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realUserProfile;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

function installFakeFork() {
  const scriptPath = path.join(tmpHome, 'claude-code-cues', '.cues', 'statusline.sh');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\necho fake\n');
  return scriptPath;
}

function userSettingsPath() {
  return path.join(tmpHome, '.claude', 'settings.json');
}

// ─── Happy path ────────────────────────────────────────────────────────────

describe('opencues statusline', () => {
  it('happy: --help prints usage and returns undefined', () => {
    const code = statusline(['--help'], ctx);
    assert.match(logs.join('\n'), /opencues statusline <enable/);
    assert.strictEqual(code, undefined);
  });

  it('happy: no args prints usage and returns undefined (not 2)', () => {
    const code = statusline([], ctx);
    assert.match(logs.join('\n'), /opencues statusline <enable/);
    assert.strictEqual(code, undefined);
  });

  it('happy: `status` with no CC fork installed reports "not installed" and returns 0', () => {
    const code = statusline(['status'], ctx);
    assert.strictEqual(code, 0);
    assert.match(logs.join('\n'), /not installed — run `opencues install claude-code` first/);
  });

  it('happy: `enable` with a fork present creates settings.json and returns 0', () => {
    const scriptPath = installFakeFork();
    const code = statusline(['enable'], ctx);
    assert.strictEqual(code, 0);
    const data = JSON.parse(fs.readFileSync(userSettingsPath(), 'utf8'));
    assert.strictEqual(data.statusLine.command, scriptPath);
    assert.strictEqual(data.statusLine.refreshInterval, 1);
    assert.match(logs.join('\n'), /Restart Claude Code/);
  });

  it('happy: `disable` after `enable` clears the statusLine field and returns 0', () => {
    installFakeFork();
    statusline(['enable'], ctx);
    logs.length = 0;
    const code = statusline(['disable'], ctx);
    assert.strictEqual(code, 0);
    const data = JSON.parse(fs.readFileSync(userSettingsPath(), 'utf8'));
    assert.strictEqual(data.statusLine, undefined);
  });

  it('happy: `status` after `enable` reports the "ours" state', () => {
    installFakeFork();
    statusline(['enable'], ctx);
    logs.length = 0;
    const code = statusline(['status'], ctx);
    assert.strictEqual(code, 0);
    assert.match(logs.join('\n'), /configured — points at our script/);
  });
});

// ─── Edge cases ────────────────────────────────────────────────────────────

describe('opencues statusline — edge cases', () => {
  it('edge: `enable` is a no-op (still returns 0) when already enabled', () => {
    installFakeFork();
    statusline(['enable'], ctx);
    const before = fs.readFileSync(userSettingsPath(), 'utf8');
    logs.length = 0;
    const code = statusline(['enable'], ctx);
    assert.strictEqual(code, 0);
    assert.match(logs.join('\n'), /Already enabled/);
    assert.strictEqual(fs.readFileSync(userSettingsPath(), 'utf8'), before);
  });

  it('edge: `enable` refuses to clobber a user-custom statusLine without --force', () => {
    installFakeFork();
    fs.mkdirSync(path.dirname(userSettingsPath()), { recursive: true });
    fs.writeFileSync(userSettingsPath(), JSON.stringify({ statusLine: { type: 'command', command: '/usr/bin/starship' } }));
    const code = statusline(['enable'], ctx);
    assert.strictEqual(code, 1);
    assert.match(logs.join('\n'), /Refusing to overwrite/);
    const data = JSON.parse(fs.readFileSync(userSettingsPath(), 'utf8'));
    assert.strictEqual(data.statusLine.command, '/usr/bin/starship');
  });

  it('edge: `enable --force` replaces a user-custom statusLine and backs it up', () => {
    const scriptPath = installFakeFork();
    fs.mkdirSync(path.dirname(userSettingsPath()), { recursive: true });
    fs.writeFileSync(userSettingsPath(), JSON.stringify({ statusLine: { type: 'command', command: '/usr/bin/starship' }, otherField: 'preserved' }));
    const code = statusline(['enable', '--force'], ctx);
    assert.strictEqual(code, 0);
    const data = JSON.parse(fs.readFileSync(userSettingsPath(), 'utf8'));
    assert.strictEqual(data.statusLine.command, scriptPath);
    assert.strictEqual(data.otherField, 'preserved', 'must preserve unrelated settings.json fields');
    assert.strictEqual(fs.existsSync(userSettingsPath() + '.bak.cues-statusline'), true);
    const backup = JSON.parse(fs.readFileSync(userSettingsPath() + '.bak.cues-statusline', 'utf8'));
    assert.strictEqual(backup.statusLine.command, '/usr/bin/starship');
  });

  it('edge: `disable` refuses to clear a user-custom statusLine', () => {
    installFakeFork();
    fs.mkdirSync(path.dirname(userSettingsPath()), { recursive: true });
    fs.writeFileSync(userSettingsPath(), JSON.stringify({ statusLine: { type: 'command', command: '/usr/bin/starship' } }));
    const code = statusline(['disable'], ctx);
    assert.strictEqual(code, 1);
    assert.match(logs.join('\n'), /Refusing to remove/);
  });

  it('edge: `disable` when nothing is configured is a no-op returning 0', () => {
    const code = statusline(['disable'], ctx);
    assert.strictEqual(code, 0);
    assert.match(logs.join('\n'), /Already disabled/);
  });

  it('edge: --project scope writes to <cwd>/.claude/settings.json, not the sandboxed HOME', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-statusline-project-'));
    const realCwd = process.cwd();
    installFakeFork();
    process.chdir(projectDir);
    try {
      const code = statusline(['enable', '--project'], ctx);
      assert.strictEqual(code, 0);
      assert.strictEqual(fs.existsSync(path.join(projectDir, '.claude', 'settings.json')), true);
      assert.strictEqual(fs.existsSync(userSettingsPath()), false, 'must not touch the user-level settings.json');
    } finally {
      process.chdir(realCwd);
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('edge: `enable` with an unreadable/corrupt settings.json is refused with a clear error', () => {
    installFakeFork();
    fs.mkdirSync(path.dirname(userSettingsPath()), { recursive: true });
    fs.writeFileSync(userSettingsPath(), 'not valid json {{{');
    const code = statusline(['enable'], ctx);
    assert.strictEqual(code, 1);
    assert.match(logs.join('\n'), /is unreadable/);
  });
});

// ─── Invalid input ─────────────────────────────────────────────────────────

describe('opencues statusline — invalid input', () => {
  it('invalid: a flag with no subcommand (e.g. only --project) returns 2 and prints help', () => {
    const code = statusline(['--project'], ctx);
    assert.strictEqual(code, 2);
    assert.match(logs.join('\n'), /opencues statusline <enable/);
  });

  it('invalid: unknown subcommand returns 2 with a clear error naming valid subcommands', () => {
    const code = statusline(['bogus-subcommand'], ctx);
    assert.strictEqual(code, 2);
    assert.match(errs.join('\n'), /unknown subcommand "bogus-subcommand"/);
    assert.match(errs.join('\n'), /enable, disable, status/);
  });

  it('invalid: `enable` with no CC fork anywhere is refused with action "no-script"', () => {
    const code = statusline(['enable'], ctx);
    assert.strictEqual(code, 1);
    assert.match(logs.join('\n'), /No installed CC fork found/);
  });
});
