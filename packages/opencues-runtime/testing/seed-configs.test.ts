// Pins the four phases of `opencues seed-configs`:
//
//   1. SEED   — first-time copy of repo defaults to ~/.opencues/. Skips
//               files that exist with content.
//   2. SYNC   — overwrites stale library files (.sh / .cs / .ps1)
//               from defaults/{blanks,scripts}/ every run. Never
//               touches .md (user content).
//   3. HEAL   — re-seeds 0-byte opencues.md (the runtime's
//               OpenCuesSettingsBlank silently no-ops on empty
//               content; an empty file would break "opencues ___"
//               blank-fills on every native host).
//   4. COMPILE — colocated .cs → .exe (WSL only — skipped here).
//
// Each phase has its own bug class. SEED's "skip if exists" was the
// original logic; we extended it to "skip if exists with content" so
// 0-byte files re-seed (HEAL phase). SYNC was added because library
// files would otherwise drift when path-resolution logic changed
// between repo versions, silently breaking shipped blanks. These
// tests pin all three behaviors with a temp HOME so they're hermetic.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const seedConfigs = require(path.join(
  REPO_ROOT, 'packages/opencues-cli/src/commands/seed-configs.cjs',
)) as (argv: string[], ctx: { REPO_ROOT: string }) => void;

describe('opencues seed-configs', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-seed-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('SEED phase: copies defaults into a fresh ~/.opencues/', () => {
    // Suppress chatty console output — assertions check filesystem state.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    seedConfigs(['--silent'], { REPO_ROOT });

    const userDir = path.join(tmpHome, '.opencues');
    expect(fs.existsSync(path.join(userDir, 'cues.md'))).toBe(true);
    // opencues.md and blanks.md are gone post-unification.
    expect(fs.existsSync(path.join(userDir, 'opencues.md'))).toBe(false);
    expect(fs.existsSync(path.join(userDir, 'blanks.md'))).toBe(false);
    expect(fs.existsSync(path.join(userDir, 'blanks/brightness/cue.md'))).toBe(true);
    expect(fs.existsSync(path.join(userDir, 'blanks/brightness/brightness-blank.sh'))).toBe(true);
    // scripts/ — the shared utility dir.
    expect(fs.existsSync(path.join(userDir, 'scripts/speak.sh'))).toBe(true);
    expect(fs.existsSync(path.join(userDir, 'scripts/SpeakCtl.cs'))).toBe(true);
    // Tip groups exist as folders under cues/.
    expect(fs.existsSync(path.join(userDir, 'cues/extended-thinking/cue.md'))).toBe(true);
  });

  it('SEED phase: preserves a user-edited .md file (does NOT overwrite content)', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Pre-seed cues.md with custom user content.
    const userDir = path.join(tmpHome, '.opencues');
    fs.mkdirSync(userDir, { recursive: true });
    const userCues = '# my own custom cues\nfoo: bar\n';
    fs.writeFileSync(path.join(userDir, 'cues.md'), userCues);

    seedConfigs(['--silent'], { REPO_ROOT });

    expect(fs.readFileSync(path.join(userDir, 'cues.md'), 'utf8')).toBe(userCues);
  });

  it('HEAL phase: re-seeds a 0-byte cues.md from defaults', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const userDir = path.join(tmpHome, '.opencues');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'cues.md'), '');
    expect(fs.statSync(path.join(userDir, 'cues.md')).size).toBe(0);

    seedConfigs(['--silent'], { REPO_ROOT });

    const after = fs.readFileSync(path.join(userDir, 'cues.md'), 'utf8');
    expect(after.length).toBeGreaterThan(0);
    // Sanity: looks like the shipped settings template.
    expect(after).toContain('settings:');
    expect(after).toContain('voice-mode');
  });

  it('SYNC phase: refreshes a stale library script with repo content', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Pre-seed the user-level dir + a stale brightness-blank.sh (no find_helper
    // — simulates the pre-colocated-helpers layout from earlier in this session).
    const userDir = path.join(tmpHome, '.opencues');
    const ctlDir = path.join(userDir, 'blanks/brightness');
    fs.mkdirSync(ctlDir, { recursive: true });
    fs.writeFileSync(path.join(ctlDir, 'cue.md'), '---\nname: brightness\ntype: blank\n---\n');
    const staleScript = '#!/bin/bash\n# stale\necho "stale"\n';
    fs.writeFileSync(path.join(ctlDir, 'brightness-blank.sh'), staleScript);
    fs.chmodSync(path.join(ctlDir, 'brightness-blank.sh'), 0o755);

    seedConfigs(['--silent'], { REPO_ROOT });

    // After sync, brightness-blank.sh should match the repo's defaults — not the stale stub.
    const after = fs.readFileSync(path.join(ctlDir, 'brightness-blank.sh'), 'utf8');
    const repo = fs.readFileSync(path.join(REPO_ROOT, 'defaults/blanks/brightness/brightness-blank.sh'), 'utf8');
    expect(after).toBe(repo);
    expect(after).not.toContain('# stale');
  });

  it('SYNC phase: never overwrites a .md file (user content boundary)', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const userDir = path.join(tmpHome, '.opencues');
    const ctlDir = path.join(userDir, 'blanks/brightness');
    fs.mkdirSync(ctlDir, { recursive: true });
    // Custom cue.md content that differs from defaults.
    const customCueMd = '---\nname: brightness\ntype: blank\ntip: my custom tip\n---\n';
    fs.writeFileSync(path.join(ctlDir, 'cue.md'), customCueMd);

    seedConfigs(['--silent'], { REPO_ROOT });

    // .md preserved; library scripts synced.
    expect(fs.readFileSync(path.join(ctlDir, 'cue.md'), 'utf8')).toBe(customCueMd);
    expect(fs.existsSync(path.join(ctlDir, 'brightness-blank.sh'))).toBe(true);
  });

  it('--project flag scopes to <cwd>/.opencues (settings stay user-level via cues.md frontmatter)', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const projectDir = path.join(tmpHome, 'my-project');
    fs.mkdirSync(projectDir, { recursive: true });
    const cwd = process.cwd();
    process.chdir(projectDir);
    try {
      seedConfigs(['--silent', '--project'], { REPO_ROOT });
    } finally {
      process.chdir(cwd);
    }
    expect(fs.existsSync(path.join(projectDir, '.opencues/cues.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, '.opencues/opencues.md'))).toBe(false);
    // User-level untouched.
    expect(fs.existsSync(path.join(tmpHome, '.opencues/opencues.md'))).toBe(false);
  });
});
