// Tests for lib/compat.cjs — compat.json helpers used by `opencues update`.
//
// Scope: every pure/file-based helper (loadCompat, semverCompare,
// matchesRange, classifyVersion, isTested, isKnownIncompatible,
// readNpmPin, readGitPin, writeGitPin). All of these take an explicit
// `repoRoot` / `home` argument rather than resolving os.homedir()
// internally, so no HOME sandboxing is needed — every path in these
// tests is a throwaway mkdtemp dir passed in directly.
//
// Deliberately OUT of scope: fetchJson / queryNpmVersions /
// queryGitHubTags make real HTTPS calls with no injectable transport;
// exercising them would either hit the network in CI or require
// mocking node:https at the module level for a handful of thin
// wrapper functions. Not worth the risk/complexity for this pass.

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadCompat, semverCompare, matchesRange, classifyVersion,
  isTested, isKnownIncompatible, readNpmPin, readGitPin, writeGitPin,
} = require('./compat.cjs');

let tmpRoot;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-compat-test-'));
});

afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── Happy path ────────────────────────────────────────────────────────────

describe('loadCompat', () => {
  it('happy: reads + parses a valid compat.json', () => {
    const dir = path.join(tmpRoot, 'integrations', 'claude-code');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'compat.json'), JSON.stringify({ 'host-kind': 'npm', 'compat-range': '2.1.x' }));
    const compat = loadCompat(tmpRoot, 'claude-code');
    assert.strictEqual(compat['host-kind'], 'npm');
    assert.strictEqual(compat['compat-range'], '2.1.x');
  });

  it('edge: missing compat.json returns null', () => {
    assert.strictEqual(loadCompat(tmpRoot, 'no-such-host'), null);
  });
});

describe('semverCompare', () => {
  it('happy: orders numeric versions ascending', () => {
    assert.ok(semverCompare('2.1.100', '2.1.150') < 0);
    assert.ok(semverCompare('2.1.150', '2.1.100') > 0);
    assert.strictEqual(semverCompare('2.1.150', '2.1.150'), 0);
  });

  it('edge: tolerates a leading "v" prefix', () => {
    assert.strictEqual(semverCompare('v1.2.3', '1.2.3'), 0);
  });

  it('edge: a shorter version is treated as "less than" a longer one sharing its prefix', () => {
    // '1.2.0-rc' parses to ['1','2','0','rc'] (4 segments) vs '1.2.0''s 3 —
    // the length-mismatch branch (not the same-position string-compare
    // branch) decides this, so the extra 'rc' segment makes it sort
    // AFTER, not before (contrary to what the same-position branch's
    // comment claims for actual semver pre-release ordering — that
    // comment describes a different code path than this case exercises).
    assert.ok(semverCompare('1.2.0-rc', '1.2.0') > 0);
    assert.ok(semverCompare('1.2.0', '1.2.0-rc') < 0);
  });

  it('edge: comparison is antisymmetric for a same-length non-numeric-vs-numeric segment', () => {
    assert.strictEqual(semverCompare('1.rc', '1.0'), -semverCompare('1.0', '1.rc'));
  });

  it('invalid: mismatched segment counts — shorter version sorts first', () => {
    assert.ok(semverCompare('1.2', '1.2.1') < 0);
    assert.ok(semverCompare('1.2.1', '1.2') > 0);
  });
});

describe('matchesRange', () => {
  it('happy: "X.Y.x" glob matches any patch version', () => {
    assert.strictEqual(matchesRange('2.1.170', '2.1.x'), true);
    assert.strictEqual(matchesRange('2.2.0', '2.1.x'), false);
  });

  it('happy: ">=N" matches at/above the floor', () => {
    assert.strictEqual(matchesRange('125', '>=121'), true);
    assert.strictEqual(matchesRange('120', '>=121'), false);
  });

  it('edge: exact-match range', () => {
    assert.strictEqual(matchesRange('1.4.0', '1.4.0'), true);
    assert.strictEqual(matchesRange('1.4.1', '1.4.0'), false);
  });

  it('edge: "X - Y" bound range where NEITHER bound is a glob never matches (documented limitation, not exercised further here)', () => {
    // matchesRange only truly resolves a bounded range when one side is an
    // "X.Y.x" glob (see the code comment "accept either bound's prefix").
    // With two exact bounds there's no logic to test "falls between them" —
    // only exact-equality-with-either-bound. This is expected as-is.
    assert.strictEqual(matchesRange('1.4.5', '1.4.0 - 1.5.0'), false);
  });

  it('edge: bounded range with an ".x" upper bound matches within the window', () => {
    // Regression: the ' - ' split now runs BEFORE the `endsWith('.x')`
    // glob branch, so a compound range whose string literally ends in ".x"
    // (the common authoring shape) is split into its bounds first instead
    // of being treated as one un-matchable prefix.
    assert.strictEqual(matchesRange('1.4.5', '1.4.0 - 1.4.x'), true);
    assert.strictEqual(matchesRange('1.4.0', '1.4.0 - 1.4.x'), true); // lower bound (exact)
    assert.strictEqual(matchesRange('1.5.0', '1.4.0 - 1.4.x'), false); // above the window
  });

  it('invalid: empty/undefined range never matches', () => {
    assert.strictEqual(matchesRange('1.0.0', ''), false);
    assert.strictEqual(matchesRange('1.0.0', undefined), false);
  });
});

describe('isKnownIncompatible / isTested / classifyVersion', () => {
  const compat = {
    'compat-range': '2.1.x',
    tested: ['2.1.100', { version: '2.1.150' }],
    'known-incompatible': [
      { version: '2.1.113', reason: 'anchor moved' },
      { 'first-broken': '2.1.200', reason: 'regression from 200 onward' },
    ],
  };

  it('happy: a tested version classifies as tested', () => {
    assert.strictEqual(isTested('2.1.100', compat), true);
    assert.strictEqual(isTested('2.1.150', compat), true);
    assert.deepStrictEqual(classifyVersion('2.1.100', compat), { status: 'tested' });
  });

  it('edge: an untested-but-in-range version classifies as compat-untested', () => {
    assert.deepStrictEqual(classifyVersion('2.1.170', compat), { status: 'compat-untested' });
  });

  it('edge: out-of-range version classifies as out-of-range', () => {
    // 1.0.0 is below the "first-broken: 2.1.200" floor (so not flagged
    // incompatible) and outside the "2.1.x" compat-range.
    assert.deepStrictEqual(classifyVersion('1.0.0', compat), { status: 'out-of-range' });
  });

  it('invalid: an exact known-incompatible version is flagged with its reason', () => {
    const ki = isKnownIncompatible('2.1.113', compat);
    assert.ok(ki);
    assert.strictEqual(ki.reason, 'anchor moved');
    assert.deepStrictEqual(classifyVersion('2.1.113', compat), { status: 'incompatible', reason: 'anchor moved' });
  });

  it('invalid: "first-broken" flags every version from that point up', () => {
    assert.ok(isKnownIncompatible('2.1.200', compat));
    assert.ok(isKnownIncompatible('2.1.250', compat));
    assert.strictEqual(isKnownIncompatible('2.1.199', compat), null);
  });

  it('invalid: missing known-incompatible array returns null, not a crash', () => {
    assert.strictEqual(isKnownIncompatible('1.0.0', {}), null);
  });
});

describe('readNpmPin', () => {
  it('happy: reads the pinned version from the fork package.json', () => {
    const forkDir = path.join(tmpRoot, 'fork');
    fs.mkdirSync(forkDir, { recursive: true });
    fs.writeFileSync(path.join(forkDir, 'package.json'), JSON.stringify({ version: '2.1.170' }));
    const compat = {
      'host-kind': 'npm',
      'pin-location': { kind: 'npm-package-json', 'fork-default': forkDir, 'path-from-fork': 'package.json', field: 'version' },
    };
    assert.strictEqual(readNpmPin(tmpRoot, compat), '2.1.170');
  });

  it('edge: strips a caret/tilde prefix from the recorded version', () => {
    const forkDir = path.join(tmpRoot, 'fork2');
    fs.mkdirSync(forkDir, { recursive: true });
    fs.writeFileSync(path.join(forkDir, 'package.json'), JSON.stringify({ version: '^2.1.170' }));
    const compat = {
      'host-kind': 'npm',
      'pin-location': { kind: 'npm-package-json', 'fork-default': forkDir, 'path-from-fork': 'package.json', field: 'version' },
    };
    assert.strictEqual(readNpmPin(tmpRoot, compat), '2.1.170');
  });

  it('edge: supports a nested dotted field path', () => {
    const forkDir = path.join(tmpRoot, 'fork-nested');
    fs.mkdirSync(forkDir, { recursive: true });
    fs.writeFileSync(path.join(forkDir, 'package.json'), JSON.stringify({ nested: { v: '9.9.9' } }));
    const compat = {
      'host-kind': 'npm',
      'pin-location': { kind: 'npm-package-json', 'fork-default': forkDir, 'path-from-fork': 'package.json', field: 'nested.v' },
    };
    assert.strictEqual(readNpmPin(tmpRoot, compat), '9.9.9');
  });

  it('invalid: non-npm host-kind returns null without touching the filesystem', () => {
    assert.strictEqual(readNpmPin(tmpRoot, { 'host-kind': 'git' }), null);
  });

  it('invalid: missing package.json returns null', () => {
    const compat = {
      'host-kind': 'npm',
      'pin-location': { kind: 'npm-package-json', 'fork-default': path.join(tmpRoot, 'nope'), 'path-from-fork': 'package.json', field: 'version' },
    };
    assert.strictEqual(readNpmPin(tmpRoot, compat), null);
  });

  it('invalid: malformed JSON returns null, not a throw', () => {
    const forkDir = path.join(tmpRoot, 'fork3');
    fs.mkdirSync(forkDir, { recursive: true });
    fs.writeFileSync(path.join(forkDir, 'package.json'), 'not json');
    const compat = {
      'host-kind': 'npm',
      'pin-location': { kind: 'npm-package-json', 'fork-default': forkDir, 'path-from-fork': 'package.json', field: 'version' },
    };
    assert.strictEqual(readNpmPin(tmpRoot, compat), null);
  });

  it('invalid: missing `field` in pin-location returns null (no default field assumed)', () => {
    const forkDir = path.join(tmpRoot, 'fork-nofield');
    fs.mkdirSync(forkDir, { recursive: true });
    fs.writeFileSync(path.join(forkDir, 'package.json'), JSON.stringify({ version: '2.1.170' }));
    const compat = {
      'host-kind': 'npm',
      'pin-location': { kind: 'npm-package-json', 'fork-default': forkDir, 'path-from-fork': 'package.json' },
    };
    assert.strictEqual(readNpmPin(tmpRoot, compat), null);
  });
});

describe('readGitPin / writeGitPin', () => {
  it('happy: round-trips version + sha through the pin file', () => {
    const pinRelPath = 'integrations/opencode/compat-pin.json';
    fs.mkdirSync(path.join(tmpRoot, 'integrations', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, pinRelPath), JSON.stringify({ version: '1.0.0', sha: 'abc1234' }));
    const compat = {
      'host-kind': 'git',
      'current-pin-source': { kind: 'json-file', 'path-from-repo': pinRelPath },
    };
    const pin = readGitPin(tmpRoot, compat);
    assert.deepStrictEqual({ version: pin.version, sha: pin.sha }, { version: '1.0.0', sha: 'abc1234' });

    writeGitPin(tmpRoot, compat, { version: '1.1.0', sha: 'def5678' });
    const after = readGitPin(tmpRoot, compat);
    assert.deepStrictEqual({ version: after.version, sha: after.sha }, { version: '1.1.0', sha: 'def5678' });
  });

  it('edge: readGitPin returns null for a non-git host-kind', () => {
    assert.strictEqual(readGitPin(tmpRoot, { 'host-kind': 'npm' }), null);
  });

  it('invalid: readGitPin returns null when the pin file is missing', () => {
    const compat = {
      'host-kind': 'git',
      'current-pin-source': { kind: 'json-file', 'path-from-repo': 'nope.json' },
    };
    assert.strictEqual(readGitPin(tmpRoot, compat), null);
  });

  it('invalid: writeGitPin throws a clear error when compat.json has no json-file pin-source', () => {
    assert.throws(() => writeGitPin(tmpRoot, { 'current-pin-source': null }, { version: '1', sha: 'a' }), /no json-file pin-source/);
  });
});
