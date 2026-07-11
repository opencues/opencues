// Tests for `opencues install skill <name>` and `opencues install plugin
// <name>` — the two sub-commands dispatched out of install.cjs before the
// host-installer path. Unlike the multi-host orchestration (deferred per
// this pass's brief — see install.routing.test.cjs's header), these are
// pure file-copy + config-merge logic with no network call and no
// subprocess spawn, so they're safe and meaningful to exercise for real
// under a sandboxed HOME.
//
// Hermeticity: REPO_ROOT is the REAL repo root (read-only — we only ever
// read defaults/skills/cues/SKILL.md and integrations/opencode/plugin/
// cues.ts from it, both shipped fixtures, never written to). HOME and
// USERPROFILE are overridden to a fresh mkdtemp dir for every test and
// restored after — os.homedir() reads %USERPROFILE% on Windows, not
// $HOME (verified empirically; see seed-configs.test.cjs's header for the
// same note), so both are always set together. --project mode additionally
// chdir's into a throwaway project dir and restores cwd afterwards. No
// test ever touches the real ~/.claude/, ~/.config/opencode/, or cwd-based
// .claude/ of this repo checkout.

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const install = require('./install.cjs');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

let tmpHome;
let origLog, origErr, origExit;
let logs, errs;
const savedEnv = {};

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencues-install-skillplugin-'));
  savedEnv.HOME = process.env.HOME;
  savedEnv.USERPROFILE = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  logs = [];
  errs = [];
  origLog = console.log;
  origErr = console.error;
  origExit = process.exit;
  console.log = (...a) => logs.push(stripAnsi(a.join(' ')));
  console.error = (...a) => errs.push(stripAnsi(a.join(' ')));
  process.exit = (code) => { throw new Error(`__EXIT_${code}__`); };
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  process.exit = origExit;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('install skill — validation', () => {
  it('missing <name> exits 2', async () => {
    await assert.rejects(() => install(['skill'], { REPO_ROOT }), /__EXIT_2__/);
    assert.match(errs.join('\n'), /missing <name>/);
  });

  it('unknown skill name exits 2, naming the expected source path', async () => {
    await assert.rejects(() => install(['skill', 'not-a-real-skill-xyz'], { REPO_ROOT }), /__EXIT_2__/);
    assert.match(errs.join('\n'), /no such skill "not-a-real-skill-xyz"/);
    assert.match(errs.join('\n'), /defaults[\\/]skills[\\/]not-a-real-skill-xyz[\\/]SKILL\.md/);
  });
});

describe('install skill — global install (default target)', () => {
  it('writes only the claude-code target when no opencode config dir exists', async () => {
    await assert.rejects(() => install(['skill', 'cues'], { REPO_ROOT }), /__EXIT_0__/);
    const ccTarget = path.join(tmpHome, '.claude', 'skills', 'cues', 'SKILL.md');
    const ocTarget = path.join(tmpHome, '.config', 'opencode', 'skills', 'cues', 'SKILL.md');
    assert.strictEqual(fs.existsSync(ccTarget), true);
    assert.strictEqual(fs.existsSync(ocTarget), false, 'opencode target must not be created when ~/.config/opencode does not exist');
    const src = fs.readFileSync(path.join(REPO_ROOT, 'defaults', 'skills', 'cues', 'SKILL.md'), 'utf8');
    assert.strictEqual(fs.readFileSync(ccTarget, 'utf8'), src);
  });

  it('writes BOTH targets when ~/.config/opencode already exists', async () => {
    fs.mkdirSync(path.join(tmpHome, '.config', 'opencode'), { recursive: true });
    await assert.rejects(() => install(['skill', 'cues'], { REPO_ROOT }), /__EXIT_0__/);
    const ccTarget = path.join(tmpHome, '.claude', 'skills', 'cues', 'SKILL.md');
    const ocTarget = path.join(tmpHome, '.config', 'opencode', 'skills', 'cues', 'SKILL.md');
    assert.strictEqual(fs.existsSync(ccTarget), true);
    assert.strictEqual(fs.existsSync(ocTarget), true);
  });
});

describe('install skill — --project / --target', () => {
  let realCwd;
  let projectDir;

  beforeEach(() => {
    realCwd = process.cwd();
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencues-install-skill-project-'));
    process.chdir(projectDir);
  });

  afterEach(() => {
    process.chdir(realCwd);
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('--project writes under <cwd>/.claude/skills/<name>/SKILL.md, not HOME', async () => {
    await assert.rejects(() => install(['skill', 'cues', '--project'], { REPO_ROOT }), /__EXIT_0__/);
    const projectTarget = path.join(projectDir, '.claude', 'skills', 'cues', 'SKILL.md');
    assert.strictEqual(fs.existsSync(projectTarget), true);
    assert.strictEqual(fs.existsSync(path.join(tmpHome, '.claude', 'skills', 'cues', 'SKILL.md')), false);
  });

  it('--target writes to the exact explicit path only', async () => {
    const explicit = path.join(projectDir, 'wherever', 'SKILL.md');
    await assert.rejects(() => install(['skill', 'cues', '--target', explicit], { REPO_ROOT }), /__EXIT_0__/);
    assert.strictEqual(fs.existsSync(explicit), true);
    assert.strictEqual(fs.existsSync(path.join(tmpHome, '.claude')), false);
  });
});

describe('install skill — overwrite protection', () => {
  it('without --force, an existing SKILL.md is left untouched and a skip is logged', async () => {
    const ccTarget = path.join(tmpHome, '.claude', 'skills', 'cues', 'SKILL.md');
    fs.mkdirSync(path.dirname(ccTarget), { recursive: true });
    fs.writeFileSync(ccTarget, 'local tweak — do not clobber\n');

    await assert.rejects(() => install(['skill', 'cues'], { REPO_ROOT }), /__EXIT_0__/);
    assert.strictEqual(fs.readFileSync(ccTarget, 'utf8'), 'local tweak — do not clobber\n');
    assert.match(logs.join('\n'), /already exists \(use --force to overwrite\)/);
  });

  it('--force backs up the existing file to .bak and overwrites with the shipped source', async () => {
    const ccTarget = path.join(tmpHome, '.claude', 'skills', 'cues', 'SKILL.md');
    fs.mkdirSync(path.dirname(ccTarget), { recursive: true });
    fs.writeFileSync(ccTarget, 'local tweak — do not clobber\n');

    await assert.rejects(() => install(['skill', 'cues', '--force'], { REPO_ROOT }), /__EXIT_0__/);
    const src = fs.readFileSync(path.join(REPO_ROOT, 'defaults', 'skills', 'cues', 'SKILL.md'), 'utf8');
    assert.strictEqual(fs.readFileSync(ccTarget, 'utf8'), src);
    assert.strictEqual(fs.readFileSync(ccTarget + '.bak', 'utf8'), 'local tweak — do not clobber\n');
  });
});

describe('install plugin — validation', () => {
  it('missing <name> exits 2', async () => {
    await assert.rejects(() => install(['plugin'], { REPO_ROOT }), /__EXIT_2__/);
    assert.match(errs.join('\n'), /missing <name>/);
  });

  it('unknown plugin name exits 2, naming the expected source path', async () => {
    await assert.rejects(() => install(['plugin', 'not-a-real-plugin-xyz'], { REPO_ROOT }), /__EXIT_2__/);
    assert.match(errs.join('\n'), /no such plugin "not-a-real-plugin-xyz"/);
    assert.match(errs.join('\n'), /integrations[\\/]opencode[\\/]plugin[\\/]not-a-real-plugin-xyz\.ts/);
  });
});

describe('install plugin — install + config.json registration', () => {
  it('copies the plugin file + prompt source and registers a file:// entry in config.json', async () => {
    await assert.rejects(() => install(['plugin', 'cues'], { REPO_ROOT }), /__EXIT_0__/);

    const target = path.join(tmpHome, '.config', 'opencode', 'plugins', 'cues.ts');
    const promptTarget = path.join(tmpHome, '.config', 'opencode', 'plugins', 'cues.SKILL.md');
    const cfgPath = path.join(tmpHome, '.config', 'opencode', 'config.json');

    assert.strictEqual(fs.existsSync(target), true);
    assert.strictEqual(
      fs.readFileSync(target, 'utf8'),
      fs.readFileSync(path.join(REPO_ROOT, 'integrations', 'opencode', 'plugin', 'cues.ts'), 'utf8'),
    );
    assert.strictEqual(fs.existsSync(promptTarget), true);

    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.ok(Array.isArray(cfg.plugin));
    assert.strictEqual(cfg.plugin.length, 1);
    assert.strictEqual(cfg.plugin[0], `file://${target}`);
  });

  it('a second install does not duplicate the config.json registration and skips the existing plugin file', async () => {
    await assert.rejects(() => install(['plugin', 'cues'], { REPO_ROOT }), /__EXIT_0__/);
    logs.length = 0;
    await assert.rejects(() => install(['plugin', 'cues'], { REPO_ROOT }), /__EXIT_0__/);

    const cfgPath = path.join(tmpHome, '.config', 'opencode', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.strictEqual(cfg.plugin.length, 1, 'plugin entry must not be duplicated on re-install');

    const out = logs.join('\n');
    assert.match(out, /already exists \(use --force to overwrite\)/);
    assert.match(out, /plugin already registered/);
  });

  it('--force backs up the existing plugin file before overwriting', async () => {
    await assert.rejects(() => install(['plugin', 'cues'], { REPO_ROOT }), /__EXIT_0__/);
    const target = path.join(tmpHome, '.config', 'opencode', 'plugins', 'cues.ts');
    fs.writeFileSync(target, '// locally modified\n');

    await assert.rejects(() => install(['plugin', 'cues', '--force'], { REPO_ROOT }), /__EXIT_0__/);
    assert.strictEqual(fs.readFileSync(target + '.bak', 'utf8'), '// locally modified\n');
    assert.strictEqual(
      fs.readFileSync(target, 'utf8'),
      fs.readFileSync(path.join(REPO_ROOT, 'integrations', 'opencode', 'plugin', 'cues.ts'), 'utf8'),
    );
  });

  it('--target overrides the plugin file destination', async () => {
    const explicit = path.join(tmpHome, 'custom-plugins', 'cues.ts');
    await assert.rejects(() => install(['plugin', 'cues', '--target', explicit], { REPO_ROOT }), /__EXIT_0__/);
    assert.strictEqual(fs.existsSync(explicit), true);
    // Registration + config.json still land under the default opencode config dir.
    const cfgPath = path.join(tmpHome, '.config', 'opencode', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.strictEqual(cfg.plugin[0], `file://${explicit}`);
  });
});
