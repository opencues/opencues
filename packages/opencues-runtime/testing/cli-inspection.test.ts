// Pins the rename-rot bug class that surfaced in the May 2026 CLI
// review: inspection commands silently looking at `~/.opencues/`
// (legacy stub) instead of `~/.cues/`, and at lowercase filenames
// (`cue.md`, `OPENCUES.md`) instead of the canonical uppercase
// (`CUE.md`, `BLANK.md`, `OPENCUES.md`). Six commands all silently
// reported empty / wrong state on a healthy install.
//
// These tests build a synthetic ~/.cues/ tree in a temp HOME, run
// each fixed command, and assert it RESOLVES the synthetic configs
// rather than silently 404'ing. They run via direct require + a
// console.log spy (same pattern as seed-configs.test.ts) so the test
// is hermetic and fast.
//
// New tests in this class should mirror the same shape: tmp HOME +
// canonical-name fixtures + assert the command finds them.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const CLI_DIR = path.join(REPO_ROOT, 'packages/opencues-cli/src/commands');

// Strip SGR (colour/dim/bold) escape codes so assertions can match the
// plain text. The list command dim-styles the section counts, e.g.
// `Cues \x1b[2m(1)\x1b[22m`, which splits "Cues" from "(1)" for a naive
// regex. We only care about the words, not the styling.
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

// Each command's module.exports is the function we call.
type Cmd = (argv: string[], ctx: { REPO_ROOT: string; PKG_DIR: string }) => unknown;
const list     = require(path.join(CLI_DIR, 'list.cjs'))    as Cmd;
const show     = require(path.join(CLI_DIR, 'show.cjs'))    as Cmd;
const validate = require(path.join(CLI_DIR, 'validate.cjs'))as Cmd;
const debug    = require(path.join(CLI_DIR, 'debug.cjs'))   as Cmd;
const which    = require(path.join(CLI_DIR, 'which.cjs'))   as Cmd;
const newCmd   = require(path.join(CLI_DIR, 'new.cjs'))     as Cmd;
const doctor   = require(path.join(CLI_DIR, 'doctor.cjs'))  as Cmd;

const PKG_DIR = path.join(REPO_ROOT, 'packages/opencues-cli');
const ctx = { REPO_ROOT, PKG_DIR };

describe('CLI inspection commands — rename-rot regression suite', () => {
  let originalHome: string | undefined;
  let originalCwd: string;
  let tmpHome: string;
  let cuesDir: string;
  let logs: string[];

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalCwd = process.cwd();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cli-'));
    process.env.HOME = tmpHome;

    // Build a healthy synthetic ~/.cues/ with canonical filenames:
    //   OPENCUES.md  (runtime settings — frontmatter)
    //   cues/foo/CUE.md
    //   blanks/bar/BLANK.md
    cuesDir = path.join(tmpHome, '.cues');
    fs.mkdirSync(path.join(cuesDir, 'cues', 'foo'), { recursive: true });
    fs.mkdirSync(path.join(cuesDir, 'blanks', 'bar'), { recursive: true });
    fs.writeFileSync(path.join(cuesDir, 'OPENCUES.md'),
      '---\ndebug-mode: off\nvoice-mode: active\n---\n');
    fs.writeFileSync(path.join(cuesDir, 'cues', 'foo', 'CUE.md'),
      '---\nname: foo\ntype: tips\nmatch: foo\n---\n');
    fs.writeFileSync(path.join(cuesDir, 'blanks', 'bar', 'BLANK.md'),
      '---\nname: bar\ntype: blank\nblankKeywords: bar\n---\n');

    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(a => typeof a === 'string' ? a : String(a)).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(a => typeof a === 'string' ? a : String(a)).join(' '));
    });
  });

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    process.chdir(originalCwd);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ── list / show: must walk ~/.cues/ and find canonical files ────────

  it('list: finds cue + blank with canonical CUE.md / BLANK.md filenames', () => {
    list([], ctx);
    const out = logs.join('\n');
    expect(stripAnsi(out)).toMatch(/Cues \(1\)/);
    expect(stripAnsi(out)).toMatch(/Blanks \(1\)/);
    expect(out).toContain('foo');
    expect(out).toContain('bar');
    expect(out).toContain('CUE.md');
    expect(out).toContain('BLANK.md');
  });

  it('show <name>: resolves a folder entry by its canonical filename', () => {
    expect(() => show(['bar'], ctx)).not.toThrow();
    const out = logs.join('\n');
    // Formatted detail view (June 2026): "<name>  (blank)" header + aligned
    // frontmatter rows, replacing the old "Matches for …" raw dump.
    expect(stripAnsi(out)).toMatch(/bar\s+\(blank\)/);
    expect(out).toContain('BLANK.md');
    expect(stripAnsi(out)).toMatch(/blankKeywords\s+bar/);
  });

  // ── validate: must NOT emit spurious "no cue.md" warnings against ──
  // ── canonical-named folders. Pre-fix: 19 such WARNs per clean dir. ──

  it('validate: does not warn "has no cue.md" against canonical CUE.md', () => {
    validate(['--user'], ctx);
    const out = logs.join('\n');
    // Must NOT see the legacy spurious-warning shape.
    expect(out).not.toMatch(/has no cue\.md/);
    // Should successfully find the user-level dir and not crash.
    expect(out).toContain(cuesDir);
  });

  it('validate: looks for CUE.md / BLANK.md per subdir', () => {
    // Add a folder with NO entry file — expect a SINGLE warning that
    // names the canonical uppercase filename (not the legacy lowercase).
    fs.mkdirSync(path.join(cuesDir, 'blanks', 'empty-blank'));
    validate(['--user'], ctx);
    const out = logs.join('\n');
    expect(out).toMatch(/empty-blank.*has no BLANK\.md/);
  });

  // ── debug: must read OPENCUES.md (uppercase), not OPENCUES.md ───────

  it('debug (no arg): reads OPENCUES.md when canonical name is in place', () => {
    debug([], ctx);
    const out = logs.join('\n');
    // Must point at the canonical file path AND parse the frontmatter
    // value. Pre-fix: "<file>: not present (debug-mode would default to 'off')".
    expect(out).toContain('OPENCUES.md');
    expect(out).toMatch(/debug-mode = off/);
    expect(out).not.toMatch(/not present/);
  });

  // ── which: configuration search paths must be ~/.cues/, not ~/.opencues/

  it('which: configuration search paths land on ~/.cues/, not ~/.opencues/', () => {
    which([], ctx);
    const out = stripAnsi(logs.join('\n'));
    expect(out).toContain(path.join(tmpHome, '.cues'));
    // The rename-rot bug this guards is CONFIG resolution pointing at
    // ~/.opencues/ instead of ~/.cues/. Since the July 2026 fork
    // consolidation, ~/.opencues/forks/ IS the legitimate fork/deploy home,
    // so the install-state sections rightly print ~/.opencues/forks/…. Scope
    // the negative to the "Configuration search paths" section, which must
    // still be pure ~/.cues/.
    const configSection = out.slice(
      out.indexOf('Configuration search paths'),
      out.indexOf('CC install state'),
    );
    expect(configSection).not.toContain(path.join(tmpHome, '.opencues'));
    // Master-config row points at canonical OPENCUES.md.
    expect(out).toContain('OPENCUES.md');
  });

  // ── doctor: Configs section uses ~/.cues/ ───────────────────────────

  it('doctor: Configs section uses ~/.cues/, not ~/.opencues/', () => {
    process.chdir(tmpHome); // doctor checks process.cwd() too
    doctor([], ctx);
    const out = stripAnsi(logs.join('\n'));
    expect(out).toContain(path.join(tmpHome, '.cues'));
    // Fork consolidation (July 2026) moved host forks into ~/.opencues/forks/,
    // so the per-host install sections legitimately print ~/.opencues/…. The
    // guard is that the "Configs" section (config search paths) stays on
    // ~/.cues/ — scope the negative to it, up to the first per-host section.
    const configsSection = out.slice(
      out.indexOf('Configs'),
      out.indexOf('Claude Code (cc)'),
    );
    expect(configsSection).not.toContain(path.join(tmpHome, '.opencues'));
  });

  // ── new: scaffolds with canonical CUE.md / BLANK.md filenames ──────

  it('new cue <name>: writes CUE.md (canonical), not cue.md (legacy)', () => {
    // Re-mock console.error since `new` uses it for some output paths
    newCmd(['cue', 'newcue', '--dry-run'], ctx);
    const out = logs.join('\n');
    expect(out).toMatch(/CREATE.*\/cues\/newcue\/CUE\.md/);
    expect(out).not.toMatch(/CREATE.*\/cue\.md\b/);
  });

  it('new blank <name>: writes BLANK.md (canonical)', () => {
    newCmd(['blank', 'newblank', '--dry-run'], ctx);
    const out = logs.join('\n');
    expect(out).toMatch(/CREATE.*\/blanks\/newblank\/BLANK\.md/);
  });

  // ── Tolerance: lowercase legacy still resolves (non-strict reader) ──

  it('list: tolerates legacy lowercase cue.md alongside canonical CUE.md', () => {
    // A user mid-migration: one folder still has lowercase cue.md.
    fs.mkdirSync(path.join(cuesDir, 'cues', 'legacy-cue'));
    fs.writeFileSync(path.join(cuesDir, 'cues', 'legacy-cue', 'cue.md'),
      '---\nname: legacy-cue\ntype: tips\nmatch: legacy\n---\n');
    list([], ctx);
    const out = logs.join('\n');
    expect(out).toContain('legacy-cue');
    expect(out).toContain('foo'); // canonical entry still listed
  });
});
