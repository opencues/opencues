// Pins the four phases of `opencues seed-configs`:
//
//   1. SEED   — first-time copy of repo defaults to ~/.cues/. Skips
//               files that exist with content.
//   2. SYNC   — overwrites stale library files (.sh / .cs / .ps1)
//               from defaults/{blanks,scripts}/ every run. Never
//               touches .md (user content).
//   3. HEAL   — re-seeds 0-byte OPENCUES.md (the runtime's
//               OpenCuesSettingsBlank silently no-ops on empty
//               content; an empty file would break "opencues ___"
//               blank-fills on every native host).
//   4. COMPILE — colocated .cs → .exe (WSL only — skipped here).
//
// Each phase has its own invariant. SEED skips when the target exists
// AND has content, so a 0-byte file re-seeds (HEAL phase). SYNC keeps
// library scripts current as path-resolution logic evolves between
// repo versions. These tests pin all three behaviours with a temp
// HOME so they're hermetic.

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

  it('SEED phase: copies defaults into a fresh ~/.cues/', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    seedConfigs(['--silent'], { REPO_ROOT });

    const userDir = path.join(tmpHome, '.cues');
    // OPENCUES.md lives at the top of .cues/ alongside CUES.md / BLANKS.md.
    expect(fs.existsSync(path.join(userDir, 'OPENCUES.md'))).toBe(true);
    // Old layout files are gone.
    expect(fs.existsSync(path.join(tmpHome, '.opencues'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, '.opencuesrc'))).toBe(false);
    // Library shape: words/ + blanks/ + scripts/ under .cues/.
    expect(fs.existsSync(path.join(userDir, 'blanks/brightness/BLANK.md'))).toBe(true);
    expect(fs.existsSync(path.join(userDir, 'blanks/brightness/brightness-blank.sh'))).toBe(true);
    expect(fs.existsSync(path.join(userDir, 'scripts/speak.sh'))).toBe(true);
    expect(fs.existsSync(path.join(userDir, 'scripts/SpeakCtl.cs'))).toBe(true);
    // Tips live in cues/tips/CUE.md (folder-only layout).
    expect(fs.existsSync(path.join(userDir, 'cues/tips/CUE.md'))).toBe(true);
  });

  it('SEED phase: merges user OPENCUES.md with defaults (preserves user scalar VALUES + body; refreshes settings: schema)', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const userRc = '---\nvoice-mode: inactive\n---\n\n# my own custom config\n';
    const userDir = path.join(tmpHome, '.cues');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'OPENCUES.md'), userRc);

    seedConfigs(['--silent'], { REPO_ROOT });

    const after = fs.readFileSync(path.join(userDir, 'OPENCUES.md'), 'utf8');
    // User's cycled scalar VALUE wins over default.
    expect(after).toMatch(/^voice-mode:\s*inactive\b/m);
    // User's body is preserved verbatim.
    expect(after).toContain('# my own custom config');
    // Defaults' settings: schema block lands so the selector blank can
    // navigate every shipped setting (was the gap that stranded new
    // entries like `max-concurrent-auditors` on existing installs).
    expect(after).toMatch(/^settings:\s*$/m);
    expect(after).toMatch(/^\s+voice-mode:\s*$/m);
  });

  it('HEAL phase: re-seeds a 0-byte OPENCUES.md from defaults', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const userDir = path.join(tmpHome, '.cues');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'OPENCUES.md'), '');
    expect(fs.statSync(path.join(userDir, 'OPENCUES.md')).size).toBe(0);

    seedConfigs(['--silent'], { REPO_ROOT });

    const after = fs.readFileSync(path.join(userDir, 'OPENCUES.md'), 'utf8');
    expect(after.length).toBeGreaterThan(0);
    expect(after).toContain('settings:');
    expect(after).toContain('voice-mode');
  });

it('HEAL phase: renames legacy blanks/<name>/BLANK.md to BLANK.md', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const userDir = path.join(tmpHome, '.cues');
    const ctlDir = path.join(userDir, 'blanks/brightness');
    fs.mkdirSync(ctlDir, { recursive: true });
    const userBlankMd = '---\nname: brightness\ntype: blank\ntip: legacy filename\n---\n';
    fs.writeFileSync(path.join(ctlDir, 'cue.md'), userBlankMd);

    seedConfigs(['--silent'], { REPO_ROOT });

    expect(fs.existsSync(path.join(ctlDir, 'cue.md'))).toBe(false);
    expect(fs.existsSync(path.join(ctlDir, 'BLANK.md'))).toBe(true);
    expect(fs.readFileSync(path.join(ctlDir, 'BLANK.md'), 'utf8')).toBe(userBlankMd);
  });

  it('HEAL phase: rename is idempotent — BLANK.md already present, cue.md absent', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const userDir = path.join(tmpHome, '.cues');
    const ctlDir = path.join(userDir, 'blanks/brightness');
    fs.mkdirSync(ctlDir, { recursive: true });
    const userBlankMd = '---\nname: brightness\ntype: blank\n---\n';
    fs.writeFileSync(path.join(ctlDir, 'BLANK.md'), userBlankMd);

    seedConfigs(['--silent'], { REPO_ROOT });
    seedConfigs(['--silent'], { REPO_ROOT });

    expect(fs.existsSync(path.join(ctlDir, 'cue.md'))).toBe(false);
    expect(fs.readFileSync(path.join(ctlDir, 'BLANK.md'), 'utf8')).toBe(userBlankMd);
  });

  it('SYNC phase: refreshes a stale library script with repo content', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const userDir = path.join(tmpHome, '.cues');
    const ctlDir = path.join(userDir, 'blanks/brightness');
    fs.mkdirSync(ctlDir, { recursive: true });
    fs.writeFileSync(path.join(ctlDir, 'BLANK.md'), '---\nname: brightness\ntype: blank\n---\n');
    const staleScript = '#!/bin/bash\n# stale\necho "stale"\n';
    fs.writeFileSync(path.join(ctlDir, 'brightness-blank.sh'), staleScript);
    fs.chmodSync(path.join(ctlDir, 'brightness-blank.sh'), 0o755);

    seedConfigs(['--silent'], { REPO_ROOT });

    const after = fs.readFileSync(path.join(ctlDir, 'brightness-blank.sh'), 'utf8');
    const repo = fs.readFileSync(path.join(REPO_ROOT, 'defaults/blanks/brightness/brightness-blank.sh'), 'utf8');
    expect(after).toBe(repo);
    expect(after).not.toContain('# stale');
  });

  it('SYNC phase: never overwrites a .md file (user content boundary)', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const userDir = path.join(tmpHome, '.cues');
    const ctlDir = path.join(userDir, 'blanks/brightness');
    fs.mkdirSync(ctlDir, { recursive: true });
    const customBLANKMd = '---\nname: brightness\ntype: blank\ntip: my custom tip\n---\n';
    fs.writeFileSync(path.join(ctlDir, 'BLANK.md'), customBLANKMd);

    seedConfigs(['--silent'], { REPO_ROOT });

    expect(fs.readFileSync(path.join(ctlDir, 'BLANK.md'), 'utf8')).toBe(customBLANKMd);
    expect(fs.existsSync(path.join(ctlDir, 'brightness-blank.sh'))).toBe(true);
  });

  it('--project flag scopes to <cwd>/.cues (settings stay user-level)', () => {
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
    // Project-level: words/ + blanks/ are seeded under <cwd>/.cues/.
    // No OPENCUES.md at project level (settings are runtime-owned, user-only).
    expect(fs.existsSync(path.join(projectDir, '.cues/cues/tips/CUE.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'OPENCUES.md'))).toBe(false);
    // User-level untouched (no defaults seeded since this run was --project).
    expect(fs.existsSync(path.join(tmpHome, '.cues/OPENCUES.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, '.cues/cues/tips.md'))).toBe(false);
  });
});
