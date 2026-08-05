'use strict';

// fork-paths — the single source of truth for on-disk fork locations.
// Hermetic: every test runs against a mkdtemp fake HOME (PR #41 pattern).

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome = '';
let savedHome;

before(() => { savedHome = process.env.HOME; });
after(() => { if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome; });
beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-forkpaths-'));
  process.env.HOME = tmpHome;
});

// require fresh each time so os.homedir() re-reads HOME (it's cached per-call, not per-module)
function fp() { delete require.cache[require.resolve('./fork-paths.cjs')]; return require('./fork-paths.cjs'); }
const mkforkdir = (rel) => { const p = path.join(tmpHome, rel); fs.mkdirSync(p, { recursive: true }); return p; };

test('forkDir places forks under ~/.opencues/forks/<host>', () => {
  const { forkDir, forksRoot } = fp();
  assert.strictEqual(forksRoot(), path.join(tmpHome, '.opencues', 'forks'));
  assert.strictEqual(forkDir('claude-code'), path.join(tmpHome, '.opencues', 'forks', 'claude-code'));
  assert.strictEqual(forkDir('opencode'), path.join(tmpHome, '.opencues', 'forks', 'opencode'));
  assert.strictEqual(forkDir('gemini-cli'), path.join(tmpHome, '.opencues', 'forks', 'gemini-cli'));
});

test('forkDir supports a dev-fork suffix (claude-code-150)', () => {
  const { forkDir } = fp();
  assert.strictEqual(forkDir('claude-code', '150'), path.join(tmpHome, '.opencues', 'forks', 'claude-code-150'));
});

test('supportDir uses .cues for CC and .opencues for OC/gemini', () => {
  const { supportDir, forkDir } = fp();
  assert.strictEqual(supportDir('claude-code', forkDir('claude-code')), path.join(tmpHome, '.opencues', 'forks', 'claude-code', '.cues'));
  assert.strictEqual(supportDir('opencode', forkDir('opencode')), path.join(tmpHome, '.opencues', 'forks', 'opencode', '.opencues'));
  assert.strictEqual(supportDir('gemini-cli', forkDir('gemini-cli')), path.join(tmpHome, '.opencues', 'forks', 'gemini-cli', '.opencues'));
});

test('legacyForkDir names the old top-level layout', () => {
  const { legacyForkDir } = fp();
  assert.strictEqual(legacyForkDir('claude-code'), path.join(tmpHome, 'claude-code-cues'));
  assert.strictEqual(legacyForkDir('opencode'), path.join(tmpHome, 'opencode-cues'));
  assert.strictEqual(legacyForkDir('gemini-cli'), path.join(tmpHome, 'gemini-cli-cues'));
  assert.strictEqual(legacyForkDir('claude-code', '170'), path.join(tmpHome, 'claude-code-cues-170'));
});

test('resolveForkDir: new location wins when it exists', () => {
  mkforkdir('.opencues/forks/claude-code');
  const { resolveForkDir, forkDir } = fp();
  assert.strictEqual(resolveForkDir('claude-code'), forkDir('claude-code'));
});

test('resolveForkDir: falls back to legacy when only the old dir exists', () => {
  mkforkdir('claude-code-cues');
  const { resolveForkDir, legacyForkDir } = fp();
  assert.strictEqual(resolveForkDir('claude-code'), legacyForkDir('claude-code'));
});

test('resolveForkDir: new wins even when both exist (post-reinstall)', () => {
  mkforkdir('claude-code-cues');
  mkforkdir('.opencues/forks/claude-code');
  const { resolveForkDir, forkDir } = fp();
  assert.strictEqual(resolveForkDir('claude-code'), forkDir('claude-code'));
});

test('resolveForkDir: neither exists → the new default (install target)', () => {
  const { resolveForkDir, forkDir } = fp();
  assert.strictEqual(resolveForkDir('opencode'), forkDir('opencode'));
});

test('legacyForkExists reflects the old dir on disk', () => {
  const { legacyForkExists } = fp();
  assert.strictEqual(legacyForkExists('gemini-cli'), false);
  mkforkdir('gemini-cli-cues');
  assert.strictEqual(fp().legacyForkExists('gemini-cli'), true);
});

test('enumerateForkDirs finds forks in BOTH locations, deduped, incl. dev forks', () => {
  mkforkdir('.opencues/forks/claude-code');
  mkforkdir('.opencues/forks/claude-code-150');   // new-location dev fork
  mkforkdir('claude-code-cues');                   // legacy canonical
  mkforkdir('claude-code-cues-170');               // legacy dev fork
  mkforkdir('.opencues/forks/opencode');           // different host — excluded
  const { enumerateForkDirs } = fp();
  const dirs = enumerateForkDirs('claude-code').map((d) => path.basename(d)).sort();
  assert.deepStrictEqual(dirs, ['claude-code', 'claude-code-150', 'claude-code-cues', 'claude-code-cues-170']);
});

test('enumerateForkDirs is empty when nothing is installed', () => {
  const { enumerateForkDirs } = fp();
  assert.deepStrictEqual(fp().enumerateForkDirs('claude-code'), []);
});

test('migrateLegacyFork: RENAMEs legacy → new when new is absent (no re-clone)', () => {
  const legacy = mkforkdir('claude-code-cues');
  fs.writeFileSync(path.join(legacy, 'marker.txt'), 'keep me');   // checkout content to preserve
  const { migrateLegacyFork, forkDir, legacyForkDir } = fp();
  const msg = migrateLegacyFork('claude-code');
  assert.match(msg, /migrated/);
  assert.strictEqual(fs.existsSync(legacyForkDir('claude-code')), false);       // legacy gone
  assert.strictEqual(fs.existsSync(forkDir('claude-code')), true);              // new exists
  assert.strictEqual(fs.readFileSync(path.join(forkDir('claude-code'), 'marker.txt'), 'utf8'), 'keep me'); // content moved, not lost
});

test('migrateLegacyFork: REMOVEs legacy orphan when new already exists', () => {
  mkforkdir('opencode-cues');                    // legacy
  const neu = mkforkdir('.opencues/forks/opencode');
  fs.writeFileSync(path.join(neu, 'new.txt'), 'fresh');
  const { migrateLegacyFork, legacyForkDir, forkDir } = fp();
  const msg = migrateLegacyFork('opencode');
  assert.match(msg, /removed legacy fork orphan/);
  assert.strictEqual(fs.existsSync(legacyForkDir('opencode')), false);          // orphan removed
  assert.strictEqual(fs.existsSync(path.join(forkDir('opencode'), 'new.txt')), true); // new untouched
});

test('migrateLegacyFork: no-op when there is no legacy dir', () => {
  const { migrateLegacyFork } = fp();
  assert.strictEqual(migrateLegacyFork('gemini-cli'), null);
});
