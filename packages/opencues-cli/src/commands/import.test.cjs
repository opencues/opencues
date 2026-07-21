// Tests for `opencues import` — config pack downloader/installer.
//
// Zero prior coverage. This suite avoids all network I/O (every
// download-requiring path is exercised via `--dry-run`, which returns
// before `downloadToFile` is ever called) and instead drives the
// LOCAL-PATH source kind (`./pack/`) to exercise staging, validation
// (script-path safety gate + malformed-frontmatter gate), the trust
// summary, and the real install/rename-into-place flow.
//
// Hermeticity: HOME + USERPROFILE (os.homedir() reads USERPROFILE on
// Windows — see seed-configs.test.cjs) point at a fresh mkdtemp dir for
// every test, restored after. `--project` scope additionally chdir's
// into its own fresh tmp project dir so nothing ever touches the real
// user's ~/.cues/.
//
// process.exit is stubbed to record the code and throw a sentinel Error
// so control never actually leaves the test process (same pattern as
// seed-configs.test.cjs / check-keys.test.cjs).

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const importCmd = require('./import.cjs');

const REPO_ROOT = path.resolve(__dirname, '../../../..');

let realHome, realUserProfile, realCwd;
let tmpHome;

beforeEach(() => {
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  realCwd = process.cwd();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-import-home-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  process.chdir(realCwd);
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realUserProfile;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

function ctx() { return { REPO_ROOT }; }

// Capture console.log/console.error output, stub process.exit to record
// the code and throw a sentinel so we never actually terminate the test
// process. Returns { logs, errs, exitCode, threw, rejection }.
async function run(argv) {
  const logs = [];
  const errs = [];
  const origLog = console.log, origErr = console.error, origExit = process.exit;
  let exitCode = null;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errs.push(a.join(' '));
  process.exit = (code) => { exitCode = code; throw new Error('__EXIT__'); };
  let threw = false, rejection = null;
  try {
    await importCmd(argv, ctx());
  } catch (err) {
    threw = true;
    rejection = err;
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  }
  return { logs, errs, exitCode, threw, rejection };
}

function makeProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-import-proj-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function makeLocalPack(parentDir, name, files) {
  const packDir = path.join(parentDir, name);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(packDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return packDir;
}

// ─── Happy path ────────────────────────────────────────────────────────────

test('happy: --help prints usage and performs no filesystem writes', async () => {
  const proj = makeProject();
  try {
    process.chdir(proj);
    const { logs, exitCode, threw } = await run(['--help']);
    assert.strictEqual(threw, false);
    assert.strictEqual(exitCode, null);
    assert.ok(logs.some(l => l.includes('opencues import')));
    assert.strictEqual(fs.existsSync(path.join(proj, '.cues')), false);
  } finally {
    cleanup(proj);
  }
});

test('happy: --dry-run on a valid local pack prints the plan without installing', async () => {
  const parent = makeProject();
  try {
    const packDir = makeLocalPack(parent, 'mypack', {
      'cues/legalish/CUE.md': '---\nname: legalish\nmatch: contract\n---\n\nSuggest alternatives.\n',
    });
    process.chdir(parent);
    const { logs, exitCode } = await run([`./mypack`, '--project', '--dry-run']);
    assert.strictEqual(exitCode, null);
    assert.ok(logs.some(l => l.includes('dry-run')));
    assert.strictEqual(fs.existsSync(path.join(parent, '.cues', 'packs', 'mypack')), false);
    void packDir;
  } finally {
    cleanup(parent);
  }
});

test('happy: real install of a valid local pack lands files + writes .cues-pack.json', async () => {
  const parent = makeProject();
  try {
    makeLocalPack(parent, 'goodpack', {
      'cues/legalish/CUE.md': '---\nname: legalish\nmatch: contract\n---\n\nSuggest alternatives.\n',
      'blanks/mybla/BLANK.md': '---\nname: mybla\ntype: blank\nblankKeywords: mybla\nimpl: MyBlaBlank\n---\n',
    });
    process.chdir(parent);
    const { logs, errs, exitCode, threw } = await run(['./goodpack', '--project', '--yes']);
    assert.strictEqual(threw, false, `unexpected throw; errs: ${JSON.stringify(errs)}`);
    assert.strictEqual(exitCode, null);
    const target = path.join(parent, '.cues', 'packs', 'goodpack');
    assert.strictEqual(fs.existsSync(path.join(target, 'cues', 'legalish', 'CUE.md')), true);
    assert.strictEqual(fs.existsSync(path.join(target, 'blanks', 'mybla', 'BLANK.md')), true);
    const meta = JSON.parse(fs.readFileSync(path.join(target, '.cues-pack.json'), 'utf8'));
    assert.strictEqual(meta.name, 'goodpack');
    assert.strictEqual(meta.scope, 'project');
    assert.ok(logs.some(l => l.includes('installed pack')));
  } finally {
    cleanup(parent);
  }
});

test('happy: --name overrides the installed pack directory name', async () => {
  const parent = makeProject();
  try {
    makeLocalPack(parent, 'sourcename', {
      'cues/foo/CUE.md': '---\nname: foo\nmatch: x\n---\n\nbody\n',
    });
    process.chdir(parent);
    const { exitCode, threw } = await run(['./sourcename', '--project', '--name', 'renamed', '--yes']);
    assert.strictEqual(threw, false);
    assert.strictEqual(exitCode, null);
    assert.strictEqual(fs.existsSync(path.join(parent, '.cues', 'packs', 'renamed')), true);
    assert.strictEqual(fs.existsSync(path.join(parent, '.cues', 'packs', 'sourcename')), false);
  } finally {
    cleanup(parent);
  }
});

test('happy: default (user) scope installs under sandboxed HOME/.cues/packs', async () => {
  const parent = makeProject();
  try {
    makeLocalPack(parent, 'userpack', {
      'cues/foo/CUE.md': '---\nname: foo\nmatch: x\n---\n\nbody\n',
    });
    process.chdir(parent);
    const { exitCode, threw } = await run(['./userpack', '--yes']);
    assert.strictEqual(threw, false);
    assert.strictEqual(exitCode, null);
    assert.strictEqual(fs.existsSync(path.join(tmpHome, '.cues', 'packs', 'userpack')), true);
  } finally {
    cleanup(parent);
  }
});

// ─── Edge cases ────────────────────────────────────────────────────────────

test('edge: --force reinstalls over an already-installed pack', async () => {
  const parent = makeProject();
  try {
    makeLocalPack(parent, 'reinst', { 'cues/a/CUE.md': '---\nname: a\nmatch: x\n---\n\nb1\n' });
    process.chdir(parent);
    await run(['./reinst', '--project', '--yes']);
    const target = path.join(parent, '.cues', 'packs', 'reinst');
    assert.strictEqual(fs.existsSync(path.join(target, '.cues-pack.json')), true);

    // Mutate the source and reinstall with --force.
    fs.writeFileSync(path.join(parent, 'reinst', 'cues', 'a', 'CUE.md'), '---\nname: a\nmatch: y\n---\n\nb2\n');
    const { exitCode, threw } = await run(['./reinst', '--project', '--force', '--yes']);
    assert.strictEqual(threw, false);
    assert.strictEqual(exitCode, null);
    const content = fs.readFileSync(path.join(target, 'cues', 'a', 'CUE.md'), 'utf8');
    assert.match(content, /match: y/);
  } finally {
    cleanup(parent);
  }
});

test('edge: unrecognised flags (--name at end of argv with no value) fall back to default name', async () => {
  const parent = makeProject();
  try {
    makeLocalPack(parent, 'trailname', { 'cues/a/CUE.md': '---\nname: a\nmatch: x\n---\n\nb\n' });
    process.chdir(parent);
    const { threw, exitCode } = await run(['./trailname', '--project', '--yes', '--name']);
    assert.strictEqual(threw, false);
    assert.strictEqual(exitCode, null);
    // nameOverride ends up undefined -> falls back to resolved.defaultName.
    assert.strictEqual(fs.existsSync(path.join(parent, '.cues', 'packs', 'trailname')), true);
  } finally {
    cleanup(parent);
  }
});

test('edge: gist:/github:/https source resolution is printed correctly under --dry-run (no network)', async () => {
  const proj = makeProject();
  try {
    process.chdir(proj);
    const gist = await run(['gist:abc123', '--dry-run']);
    assert.ok(gist.logs.some(l => l.includes('gist.github.com/abc123/archive/HEAD.tar.gz')));

    const gh = await run(['github:someuser/somerepo', '--dry-run']);
    assert.ok(gh.logs.some(l => l.includes('api.github.com/repos/someuser/somerepo/tarball/HEAD')));

    const ghRef = await run(['github:someuser/somerepo#v1.2', '--dry-run']);
    assert.ok(ghRef.logs.some(l => l.includes('tarball/v1.2')));

    const url = await run(['https://example.com/some-pack.tar.gz', '--dry-run']);
    assert.ok(url.logs.some(l => l.includes('Target:') && l.includes('some-pack')));
  } finally {
    cleanup(proj);
  }
});

test('edge: ~-prefixed local source expands against sandboxed HOME', async () => {
  const parent = makeProject();
  try {
    fs.mkdirSync(path.join(tmpHome, 'homepack', 'cues', 'a'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'homepack', 'cues', 'a', 'CUE.md'), '---\nname: a\nmatch: x\n---\n\nb\n');
    process.chdir(parent);
    const { threw, exitCode } = await run(['~/homepack', '--project', '--yes']);
    assert.strictEqual(threw, false);
    assert.strictEqual(exitCode, null);
    assert.strictEqual(fs.existsSync(path.join(parent, '.cues', 'packs', 'homepack')), true);
  } finally {
    cleanup(parent);
  }
});

// ─── Invalid input ─────────────────────────────────────────────────────────

test('invalid: missing <source> exits 2 with usage guidance', async () => {
  const proj = makeProject();
  try {
    process.chdir(proj);
    const { errs, exitCode, threw } = await run([]);
    assert.strictEqual(threw, true);
    assert.strictEqual(exitCode, 2);
    assert.ok(errs.some(e => e.includes('missing <source>')));
  } finally {
    cleanup(proj);
  }
});

test('invalid: unrecognised source string exits 1', async () => {
  const proj = makeProject();
  try {
    process.chdir(proj);
    const { errs, exitCode, threw } = await run(['not-a-known-scheme']);
    assert.strictEqual(threw, true);
    assert.strictEqual(exitCode, 1);
    assert.ok(errs.some(e => e.includes('unrecognised source')));
  } finally {
    cleanup(proj);
  }
});

test('invalid: malformed github: source (missing repo) exits 1', async () => {
  const proj = makeProject();
  try {
    process.chdir(proj);
    const { errs, exitCode, threw } = await run(['github:justauser']);
    assert.strictEqual(threw, true);
    assert.strictEqual(exitCode, 1);
    assert.ok(errs.some(e => e.includes('bad github source')));
  } finally {
    cleanup(proj);
  }
});

test('invalid: local source path that does not exist exits 1', async () => {
  const proj = makeProject();
  try {
    process.chdir(proj);
    const { errs, exitCode, threw } = await run(['./does-not-exist-anywhere']);
    assert.strictEqual(threw, true);
    assert.strictEqual(exitCode, 1);
    assert.ok(errs.some(e => e.includes('not found')));
  } finally {
    cleanup(proj);
  }
});

test('invalid: local source path that is a file, not a directory, exits 1', async () => {
  const proj = makeProject();
  try {
    fs.writeFileSync(path.join(proj, 'afile.txt'), 'x');
    process.chdir(proj);
    const { errs, exitCode, threw } = await run(['./afile.txt']);
    assert.strictEqual(threw, true);
    assert.strictEqual(exitCode, 1);
    assert.ok(errs.some(e => e.includes('not a directory')));
  } finally {
    cleanup(proj);
  }
});

test('invalid: already-installed pack without --force refuses and exits 1', async () => {
  const parent = makeProject();
  try {
    makeLocalPack(parent, 'dup', { 'cues/a/CUE.md': '---\nname: a\nmatch: x\n---\n\nb\n' });
    process.chdir(parent);
    await run(['./dup', '--project', '--yes']);
    const { errs, exitCode, threw } = await run(['./dup', '--project', '--yes']);
    assert.strictEqual(threw, true);
    assert.strictEqual(exitCode, 1);
    assert.ok(errs.some(e => e.includes('already installed')));
  } finally {
    cleanup(parent);
  }
});

test('invalid: absolute script: path in a blank is refused by the safety validator', async () => {
  const parent = makeProject();
  try {
    makeLocalPack(parent, 'evilabs', {
      'blanks/evil/BLANK.md': '---\nname: evil\ntype: blank\nblankKeywords: evil\nblankScript: /etc/passwd\n---\n',
    });
    process.chdir(parent);
    const { logs, exitCode, threw } = await run(['./evilabs', '--project', '--yes']);
    assert.strictEqual(threw, true);
    assert.strictEqual(exitCode, 1);
    assert.ok(logs.some(l => l.includes('refused absolute/traversing script path')));
    assert.strictEqual(fs.existsSync(path.join(parent, '.cues', 'packs', 'evilabs')), false);
  } finally {
    cleanup(parent);
  }
});

test('invalid: traversing blankScript: path (../) is refused by the safety validator', async () => {
  const parent = makeProject();
  try {
    makeLocalPack(parent, 'evilrel', {
      'blanks/evil/BLANK.md': '---\nname: evil\ntype: blank\nblankKeywords: evil\nblankScript: ../../evil.sh\n---\n',
    });
    process.chdir(parent);
    const { logs, exitCode, threw } = await run(['./evilrel', '--project', '--yes']);
    assert.strictEqual(threw, true);
    assert.strictEqual(exitCode, 1);
    assert.ok(logs.some(l => l.includes('refused absolute/traversing script path')));
  } finally {
    cleanup(parent);
  }
});

test('invalid: --unsafe-allow-scripts bypasses the traversing-script refusal', async () => {
  const parent = makeProject();
  try {
    makeLocalPack(parent, 'evilallowed', {
      'blanks/evil/BLANK.md': '---\nname: evil\ntype: blank\nblankKeywords: evil\nblankScript: ../../evil.sh\n---\n',
    });
    process.chdir(parent);
    const { exitCode, threw } = await run(['./evilallowed', '--project', '--yes', '--unsafe-allow-scripts']);
    assert.strictEqual(threw, false);
    assert.strictEqual(exitCode, null);
    assert.strictEqual(fs.existsSync(path.join(parent, '.cues', 'packs', 'evilallowed', 'blanks', 'evil', 'BLANK.md')), true);
  } finally {
    cleanup(parent);
  }
});

test('invalid: malformed frontmatter (--- fence present but nothing parseable) is refused', async () => {
  const parent = makeProject();
  try {
    makeLocalPack(parent, 'badfm', {
      'cues/broken/CUE.md': '---\n:::not:valid:::\n---\n\nbody\n',
    });
    process.chdir(parent);
    const { logs, exitCode, threw } = await run(['./badfm', '--project', '--yes']);
    assert.strictEqual(threw, true);
    assert.strictEqual(exitCode, 1);
    assert.ok(logs.some(l => l.includes('frontmatter is malformed') || l.includes('parse failed')),
      `expected a frontmatter validation error, got: ${JSON.stringify(logs)}`);
  } finally {
    cleanup(parent);
  }
});
