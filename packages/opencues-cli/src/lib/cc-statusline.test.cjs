// Tests for cc-statusline.cjs — the opt-in user/project statusline
// enable/disable logic.
//
// The point of this test suite is to pin the "graceful guest" rules
// so we don't accidentally regress to clobbering user customisations:
//
//   - enable on empty file → CREATES with our statusLine, no other fields
//   - enable when already ours → NO-OP (idempotent re-runs)
//   - enable on stale opencues path → REPLACES (auto-migration)
//   - enable on user-custom command → REFUSES without --force
//   - enable on user-custom with --force → REPLACES + backs up
//   - disable when ours → CLEARS the field, preserves other fields
//   - disable when missing → NO-OP
//   - disable on user-custom → REFUSES (never touch what's not ours)
//   - corrupted JSON → REFUSES with clear error
//
// Each test runs in a fresh tmpdir so concurrent runs + the user's
// real ~/.claude/ are never touched.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const lib = require('./cc-statusline.cjs');

// Each test gets its own tmpdir to simulate cwd / HOME.
function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `oc-statusline-${name}-`));
}

// Plant a fake CC fork so resolveStatuslineScript returns a path.
// Returns the script path for assertions.
function plantFork(home) {
  const forkDir = path.join(home, 'claude-code-cues', '.cues');
  fs.mkdirSync(forkDir, { recursive: true });
  const scriptPath = path.join(forkDir, 'statusline.sh');
  fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\necho fake');
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

// Override HOME for the duration of a test, restore after.
function withHome(home, fn) {
  const prior = process.env.HOME;
  process.env.HOME = home;
  try { return fn(); }
  finally { process.env.HOME = prior; }
}

test('isOpenCuesPath: recognises every layout', () => {
  assert.ok(lib.isOpenCuesPath('/home/u/claude-code-cues/.cues/statusline.sh'));
  assert.ok(lib.isOpenCuesPath('/home/u/claude-code-cues-150/.cues/statusline.sh'));
  assert.ok(lib.isOpenCuesPath('/home/u/.claude/highlight-statusline.sh'));
  assert.ok(lib.isOpenCuesPath('/home/u/.claude/opencues/statusline.sh'));
  assert.ok(!lib.isOpenCuesPath('/usr/local/bin/starship-claude.sh'));
  assert.ok(!lib.isOpenCuesPath(undefined));
  assert.ok(!lib.isOpenCuesPath(null));
  assert.ok(!lib.isOpenCuesPath(42));
});

test('enable user: no settings.json → creates with statusLine only', () => {
  const home = tmpdir('enable-create');
  const scriptPath = plantFork(home);
  withHome(home, () => {
    const r = lib.enable('user');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.action, 'created');
    const data = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    assert.deepStrictEqual(data.statusLine, { type: 'command', command: scriptPath, refreshInterval: 1 });
    // Only the statusLine field — we never invent other fields.
    assert.deepStrictEqual(Object.keys(data), ['statusLine']);
  });
});

test('enable user: existing settings with no statusLine → merges, preserves other fields', () => {
  const home = tmpdir('enable-merge');
  const scriptPath = plantFork(home);
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ theme: 'dark-ansi', env: { FOO: 'bar' } }));
  withHome(home, () => {
    const r = lib.enable('user');
    assert.strictEqual(r.action, 'created');
    const data = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.strictEqual(data.theme, 'dark-ansi', 'theme preserved');
    assert.deepStrictEqual(data.env, { FOO: 'bar' }, 'env preserved');
    assert.deepStrictEqual(data.statusLine, { type: 'command', command: scriptPath, refreshInterval: 1 });
  });
});

test('enable user: already configured → no-op, idempotent', () => {
  const home = tmpdir('enable-idempotent');
  const scriptPath = plantFork(home);
  withHome(home, () => {
    lib.enable('user');                   // first run
    const r2 = lib.enable('user');        // second run
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.action, 'no-op');
    assert.match(r2.message, /Already enabled/);
  });
});

test('enable user: stale opencues path → replaces silently with new path', () => {
  const home = tmpdir('enable-stale');
  const scriptPath = plantFork(home);
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  // Plant a stale legacy opencues path.
  fs.writeFileSync(settings, JSON.stringify({
    statusLine: { type: 'command', command: path.join(home, '.claude', 'highlight-statusline.sh') },
  }));
  withHome(home, () => {
    const r = lib.enable('user');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.action, 'replaced-stale');
    const data = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.strictEqual(data.statusLine.command, scriptPath);
  });
});

test('enable user: user-custom statusLine → REFUSES without --force', () => {
  const home = tmpdir('enable-refuse');
  plantFork(home);
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({
    statusLine: { type: 'command', command: '/usr/local/bin/starship-claude.sh' },
  }));
  withHome(home, () => {
    const r = lib.enable('user');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.action, 'refused');
    assert.match(r.message, /starship-claude\.sh/);
    assert.match(r.message, /--force/);
    // File must be unchanged.
    const data = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.strictEqual(data.statusLine.command, '/usr/local/bin/starship-claude.sh');
    // No backup created (refuse means no write happened).
    assert.ok(!fs.existsSync(settings + '.bak.cues-statusline'));
  });
});

test('enable user: user-custom with --force → replaces + backs up', () => {
  const home = tmpdir('enable-force');
  const scriptPath = plantFork(home);
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({
    statusLine: { type: 'command', command: '/usr/local/bin/starship-claude.sh' },
  }));
  withHome(home, () => {
    const r = lib.enable('user', { force: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.action, 'updated');
    const data = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.strictEqual(data.statusLine.command, scriptPath);
    // Backup must be present + contain the prior content.
    const backup = JSON.parse(fs.readFileSync(settings + '.bak.cues-statusline', 'utf8'));
    assert.strictEqual(backup.statusLine.command, '/usr/local/bin/starship-claude.sh');
  });
});

test('enable: no installed CC fork → returns no-script error', () => {
  const home = tmpdir('enable-no-fork');
  // Don't plant fork.
  withHome(home, () => {
    const r = lib.enable('user');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.action, 'no-script');
    assert.match(r.message, /install claude-code/);
  });
});

test('enable project: writes to <cwd>/.claude/settings.json', () => {
  const home = tmpdir('enable-project-home');
  const projectCwd = tmpdir('enable-project-cwd');
  const scriptPath = plantFork(home);
  withHome(home, () => {
    const r = lib.enable('project', { cwd: projectCwd });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.action, 'created');
    // Project file written, NOT user file.
    const projectSettings = path.join(projectCwd, '.claude', 'settings.json');
    assert.ok(fs.existsSync(projectSettings));
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'settings.json')));
    const data = JSON.parse(fs.readFileSync(projectSettings, 'utf8'));
    assert.strictEqual(data.statusLine.command, scriptPath);
  });
});

test('disable: ours → clears field, preserves other fields', () => {
  const home = tmpdir('disable-ours');
  const scriptPath = plantFork(home);
  withHome(home, () => {
    lib.enable('user');
    // Add another field after enable so we can check preservation.
    const settingsPath = path.join(home, '.claude', 'settings.json');
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    data.theme = 'dark';
    fs.writeFileSync(settingsPath, JSON.stringify(data));

    const r = lib.disable('user');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.action, 'cleared');
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(after.statusLine, undefined);
    assert.strictEqual(after.theme, 'dark', 'other fields preserved');
  });
});

test('disable: user-custom → REFUSES, file unchanged', () => {
  const home = tmpdir('disable-refuse');
  plantFork(home);
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({
    statusLine: { type: 'command', command: '/usr/local/bin/starship-claude.sh' },
  }));
  withHome(home, () => {
    const r = lib.disable('user');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.action, 'refused');
    // Unchanged.
    const data = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.strictEqual(data.statusLine.command, '/usr/local/bin/starship-claude.sh');
  });
});

test('disable: nothing configured → no-op', () => {
  const home = tmpdir('disable-noop');
  plantFork(home);
  withHome(home, () => {
    const r = lib.disable('user');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.action, 'no-op');
  });
});

test('inspect: corrupted JSON → broken', () => {
  const home = tmpdir('broken');
  plantFork(home);
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, 'not json {{{');
  withHome(home, () => {
    const info = lib.inspect('user');
    assert.strictEqual(info.state, 'broken');
    assert.match(info.error, /invalid JSON/);
  });
});

test('enable: refuses to touch broken JSON file', () => {
  const home = tmpdir('enable-broken');
  plantFork(home);
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, 'not json {{{');
  withHome(home, () => {
    const r = lib.enable('user');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.action, 'refused');
    // File is unchanged (still corrupted, we don't try to repair it).
    assert.strictEqual(fs.readFileSync(settings, 'utf8'), 'not json {{{');
  });
});

// ── commandScriptExists + auditProjectStatuslines (Sep 2026) ─────────
// The dead-script class: a project-level statusLine pointing at a script
// from a retired install layout renders NO statusline for CC sessions in
// exactly that directory, silently. These pin the tri-state existence
// check and the ~/.claude.json machine-wide sweep.

test('commandScriptExists: tri-state over shell command strings', () => {
  const home = tmpdir('cse');
  const script = path.join(home, 'x.sh');
  fs.writeFileSync(script, '#!/bin/sh\n');
  // bare absolute path
  assert.strictEqual(lib.commandScriptExists(script), 'exists');
  assert.strictEqual(lib.commandScriptExists(path.join(home, 'nope.sh')), 'missing');
  // interpreter-prefixed + args
  assert.strictEqual(lib.commandScriptExists(`bash ${script} --flag`), 'exists');
  assert.strictEqual(lib.commandScriptExists(`bash ${home}/nope.sh --flag`), 'missing');
  // quoted path
  assert.strictEqual(lib.commandScriptExists(`"${script}"`), 'exists');
  // ~/ expansion
  withHome(home, () => {
    assert.strictEqual(lib.commandScriptExists('~/x.sh'), 'exists');
    assert.strictEqual(lib.commandScriptExists('~/nope.sh'), 'missing');
  });
  // bare $PATH command — not ours to judge
  assert.strictEqual(lib.commandScriptExists('starship prompt'), 'unknown');
  assert.strictEqual(lib.commandScriptExists(''), 'unknown');
  assert.strictEqual(lib.commandScriptExists(undefined), 'unknown');
});

test('auditProjectStatuslines: flags only dead scripts across the registry', () => {
  const home = tmpdir('audit');
  const liveDir = path.join(home, 'proj-live');
  const deadDir = path.join(home, 'proj-dead');
  const bareDir = path.join(home, 'proj-bare');
  const noneDir = path.join(home, 'proj-none');
  const liveScript = path.join(home, 'live.sh');
  fs.writeFileSync(liveScript, '#!/bin/sh\n');
  const mkSettings = (dir, statusLine) => {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'),
      JSON.stringify(statusLine ? { statusLine } : {}));
  };
  mkSettings(liveDir, { type: 'command', command: liveScript });
  // The exact Sep 2026 shape — retired ~/claude-code-cues layout:
  mkSettings(deadDir, { type: 'command', command: path.join(home, 'claude-code-cues', '.cues', 'statusline.sh') });
  mkSettings(bareDir, { type: 'command', command: 'starship prompt' });
  mkSettings(noneDir, null);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    projects: {
      [liveDir]: {}, [deadDir]: {}, [bareDir]: {}, [noneDir]: {},
      [path.join(home, 'gone-dir')]: {}, // registered dir that no longer exists
    },
  }));
  withHome(home, () => {
    const rows = lib.auditProjectStatuslines();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].dir, deadDir);
    assert.ok(rows[0].cmd.endsWith('/.cues/statusline.sh'));
    assert.strictEqual(rows[0].opencues, true);
  });
});

test('auditProjectStatuslines: no registry → empty, never throws', () => {
  const home = tmpdir('noreg');
  withHome(home, () => {
    assert.deepStrictEqual(lib.auditProjectStatuslines(), []);
  });
});
