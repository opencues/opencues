// Tests for `opencues version` — prints integrations/installed-hosts/
// internal-libraries. Read-only (never writes), never calls process.exit.
//
// Hermeticity: HOME + USERPROFILE point at a fresh mkdtemp dir for every
// test (os.homedir() reads %USERPROFILE% on Windows, not $HOME). The
// "installed hosts" section walks os.homedir()-relative paths via
// lib/version-markers.cjs — sandboxing HOME means we fully control what
// "installs" are visible. ctx.REPO_ROOT points at the real repo root
// (read-only — version.cjs only reads package.json files from it).

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const version = require('./version.cjs');
const { writeMarker } = require('../lib/version-markers.cjs');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

let tmpHome;
let realHome, realUserProfile;
let logs;
let origLog;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-version-test-'));
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  logs = [];
  origLog = console.log;
  console.log = (...a) => logs.push(stripAnsi(a.join(' ')));
});

afterEach(() => {
  console.log = origLog;
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realUserProfile;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── Happy path ────────────────────────────────────────────────────────────

describe('opencues version', () => {
  it('happy: prints the three section headers', () => {
    version([], { REPO_ROOT, pkg: { version: 'test' } });
    const out = logs.join('\n');
    assert.match(out, /Integrations \(source\)/);
    assert.match(out, /Installed hosts/);
    assert.match(out, /Internal libraries \(source\)/);
  });

  it('happy: lists every integration with a version from its package.json', () => {
    version([], { REPO_ROOT, pkg: { version: 'test' } });
    const out = logs.join('\n');
    assert.match(out, /@opencues\/claude-code/);
    assert.match(out, /@opencues\/opencode/);
    assert.match(out, /@opencues\/chrome/);
  });

  it('happy: no installs detected (fully empty REPO_ROOT) — prints the "run opencues install" hint', () => {
    // enumerateInstalledHosts' shell/chrome candidates are rooted at
    // ctx.REPO_ROOT (not HOME), so the REAL repo's shell/chrome
    // node_modules would make those show as "installed" regardless of
    // the HOME sandbox. Use a throwaway empty REPO_ROOT here so every
    // candidate's parent dir is genuinely absent.
    const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-version-emptyrepo-'));
    try {
      version([], { REPO_ROOT: emptyRepo, pkg: { version: 'test' } });
      assert.match(logs.join('\n'), /no installs detected — run `opencues install <host>`/);
    } finally {
      fs.rmSync(emptyRepo, { recursive: true, force: true });
    }
  });

  it('happy: --help prints usage and does not print any actual integration row', () => {
    version(['--help'], { REPO_ROOT, pkg: { version: 'test' } });
    const out = logs.join('\n');
    assert.match(out, /opencues version/);
    // The help text's own prose legitimately says "Integrations (source)"
    // as a section description — assert on the absence of an ACTUAL data
    // row instead (a real version number pulled from a package.json).
    assert.doesNotMatch(out, /@opencues\/claude-code/);
    assert.doesNotMatch(out, /v0\./);
  });

  it('happy: lists internal library versions for core + runtime', () => {
    version([], { REPO_ROOT, pkg: { version: 'test' } });
    const out = logs.join('\n');
    assert.match(out, /@opencues\/core/);
    assert.match(out, /@opencues\/runtime/);
  });
});

// ─── Edge cases ────────────────────────────────────────────────────────────

describe('opencues version — edge cases', () => {
  it('edge: a fresh claude-code fork with a marker shows up as a deployed install', () => {
    const forkDir = path.join(tmpHome, 'claude-code-cues');
    const markerDir = path.join(forkDir, '.cues');
    fs.mkdirSync(markerDir, { recursive: true });
    // writeMarker computes real srcHash/versions from the real REPO_ROOT,
    // so a fresh marker always classifies 'fresh' against the very same
    // REPO_ROOT this test passes to version().
    writeMarker('claude-code', markerDir, { REPO_ROOT, pkg: { version: 'test' } });

    version([], { REPO_ROOT, pkg: { version: 'test' } });
    const out = logs.join('\n');
    assert.match(out, /Installed hosts \(deployed\)/);
    assert.match(out, /claude-code/);
    assert.match(out, /no version marker — re-run install to populate|runtime .* \/ core/);
  });

  it('edge: a stale marker (mismatched runtime version) is still listed, with its recorded versions', () => {
    const forkDir = path.join(tmpHome, 'claude-code-cues');
    const markerDir = path.join(forkDir, '.cues');
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, 'version.json'), JSON.stringify({
      host: 'claude-code', cli: 'test', runtime: '0.0.1-stale', core: '0.0.1-stale',
      srcHash: 'deadbeefdeadbeef', repoRoot: REPO_ROOT, installedAt: new Date().toISOString(),
    }));
    version([], { REPO_ROOT, pkg: { version: 'test' } });
    assert.match(logs.join('\n'), /0\.0\.1-stale/);
  });

  it('edge: chrome has no upstream package.json (self-owned, no host to report) — shown with "(host version unknown)"', () => {
    // Chrome's marker root is REPO_ROOT-relative, not HOME-relative — use
    // a fully synthetic REPO_ROOT so this never touches the real repo's
    // build output.
    const fakeRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-version-chromefake-'));
    try {
      const chromeDist = path.join(fakeRepo, 'integrations', 'chrome', 'dist');
      fs.mkdirSync(chromeDist, { recursive: true });
      writeMarker('chrome', chromeDist, { REPO_ROOT: fakeRepo, pkg: { version: 'test' } });
      version([], { REPO_ROOT: fakeRepo, pkg: { version: 'test' } });
      const out = logs.join('\n');
      assert.match(out, /chrome/);
      assert.match(out, /\(host version unknown\)/);
    } finally {
      fs.rmSync(fakeRepo, { recursive: true, force: true });
    }
  });

  it('edge: missing @opencues/core package.json in a REPO_ROOT still prints without crashing', () => {
    const fakeRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-version-fakerepo-'));
    try {
      assert.doesNotThrow(() => version([], { REPO_ROOT: fakeRepo, pkg: { version: 'test' } }));
      const out = logs.join('\n');
      assert.match(out, /Internal libraries \(source\)/);
    } finally {
      fs.rmSync(fakeRepo, { recursive: true, force: true });
    }
  });
});

// ─── Invalid input ─────────────────────────────────────────────────────────

describe('opencues version — invalid input', () => {
  it('invalid: unknown extra args are ignored, full report still prints', () => {
    version(['--bogus-flag', 'garbage'], { REPO_ROOT, pkg: { version: 'test' } });
    assert.match(logs.join('\n'), /Integrations \(source\)/);
  });

  it('invalid: ctx without ctx.pkg falls back to reading the CLI package.json for the version banner (does not throw)', () => {
    assert.doesNotThrow(() => version([], { REPO_ROOT }));
    assert.match(logs.join('\n'), /Integrations \(source\)/);
  });

  it('invalid: a corrupted integration package.json is surfaced as a thrown JSON parse error (no try/catch around the read)', () => {
    // version.cjs does `JSON.parse(fs.readFileSync(pkgPath, 'utf8'))` for
    // each integration's package.json with no try/catch — pins that a
    // corrupted package.json crashes the command rather than degrading.
    const fakeRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-version-corrupt-'));
    try {
      const ccDir = path.join(fakeRepo, 'integrations', 'claude-code');
      fs.mkdirSync(ccDir, { recursive: true });
      fs.writeFileSync(path.join(ccDir, 'package.json'), 'not valid json{{{');
      assert.throws(() => version([], { REPO_ROOT: fakeRepo, pkg: { version: 'test' } }), SyntaxError);
    } finally {
      fs.rmSync(fakeRepo, { recursive: true, force: true });
    }
  });
});
