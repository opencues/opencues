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
    // Tip packs are per-platform: tips-claude-code, tips-opencode, tips-gemini-cli, tips-shell.
    expect(fs.existsSync(path.join(userDir, 'cues/tips-claude-code/CUE.md'))).toBe(true);
  });

  it('SEED phase: merges user OPENCUES.md with defaults (preserves user scalar VALUES + body)', () => {
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
    // Post-May-2026: defaults/OPENCUES.md NO LONGER ships a settings:
    // schema block (the @opencues/core FEATURES + MENU_TUNABLES
    // registry is the source of truth — see feature-registry.ts).
    // Re-seeding doesn't add a settings: block; the runtime derives
    // the menu from the registry. Assertion is the inverse: confirm
    // we don't accidentally re-introduce the old block.
    expect(after).not.toMatch(/^settings:\s*$/m);
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

  it('HEAL phase: rename is idempotent — second run produces the same merged BLANK.md', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const userDir = path.join(tmpHome, '.cues');
    const ctlDir = path.join(userDir, 'blanks/brightness');
    fs.mkdirSync(ctlDir, { recursive: true });
    fs.writeFileSync(path.join(ctlDir, 'BLANK.md'), '---\nname: brightness\ntype: blank\n---\n');

    seedConfigs(['--silent'], { REPO_ROOT });
    const afterFirst = fs.readFileSync(path.join(ctlDir, 'BLANK.md'), 'utf8');
    seedConfigs(['--silent'], { REPO_ROOT });
    const afterSecond = fs.readFileSync(path.join(ctlDir, 'BLANK.md'), 'utf8');

    expect(fs.existsSync(path.join(ctlDir, 'cue.md'))).toBe(false);
    expect(afterSecond).toBe(afterFirst);
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

  it('SHIPPED-MD REFRESH: refreshes contract fields (on-host, sandbox) but preserves user fields (tip, custom keys)', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const userDir = path.join(tmpHome, '.cues');
    const ctlDir = path.join(userDir, 'blanks/brightness');
    fs.mkdirSync(ctlDir, { recursive: true });
    // Simulate a user with stale shipped BLANK.md — the on-host list has
    // a retired host (`codex`) and no sandbox declaration, plus a custom
    // tip the user actually wants to keep. This is the exact drift class
    // that hit `opencues/BLANK.md` after the May 2026 security push.
    const staleBLANKMd = '---\nname: brightness\ntype: blank\ntip: my custom tip\non-host: codex, claude-code\n---\n\n# my body\n';
    fs.writeFileSync(path.join(ctlDir, 'BLANK.md'), staleBLANKMd);

    seedConfigs(['--silent'], { REPO_ROOT });

    const after = fs.readFileSync(path.join(ctlDir, 'BLANK.md'), 'utf8');
    // Contract drift dropped: stale `on-host: codex, claude-code` is
    // gone because defaults' brightness/BLANK.md omits `on-host:`
    // entirely (auto-detected). User's stale value would otherwise
    // strand forever.
    expect(after).not.toContain('codex');
    // Contract field added: defaults shipped `sandbox: off` in the
    // security push; user file lacked it. Refresh lands it.
    expect(after).toMatch(/^sandbox: off$/m);
    // User-customised non-contract field preserved.
    expect(after).toContain('tip: my custom tip');
    // User body preserved.
    expect(after).toContain('# my body');
    // Library script still synced as before.
    expect(fs.existsSync(path.join(ctlDir, 'brightness-blank.sh'))).toBe(true);
  });

  it('CLEANUP: drops legacy flat-file <name>.md when the folder form (<name>/BLANK.md) exists', () => {
    // The user-blank migration left flat-file blanks (e.g. `blanks/stocks.md`)
    // orphaned next to the new folder form (`blanks/stocks/BLANK.md`).
    // discover.ts skips them so they're functionally dead, but they were
    // visibly cluttering ~/.cues/blanks/ and looked like active config.
    // seed-configs should cull these whenever both forms coexist.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const userDir = path.join(tmpHome, '.cues');
    const blanksDir = path.join(userDir, 'blanks');
    fs.mkdirSync(path.join(blanksDir, 'stocks'), { recursive: true });
    fs.writeFileSync(path.join(blanksDir, 'stocks/BLANK.md'), '---\nname: stocks\ntype: blank\n---\n');
    fs.writeFileSync(path.join(blanksDir, 'stocks.md'), '---\nname: stocks\ntype: blank\n# legacy flat file\n---\n');
    // Orphan with NO folder form — must NOT be deleted (might be user content).
    fs.writeFileSync(path.join(blanksDir, 'orphan.md'), '---\nname: orphan\n---\n');

    seedConfigs(['--silent'], { REPO_ROOT });

    expect(fs.existsSync(path.join(blanksDir, 'stocks.md'))).toBe(false);
    expect(fs.existsSync(path.join(blanksDir, 'stocks/BLANK.md'))).toBe(true);
    // Orphan with no folder form survives.
    expect(fs.existsSync(path.join(blanksDir, 'orphan.md'))).toBe(true);
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
    expect(fs.existsSync(path.join(projectDir, '.cues/cues/tips-claude-code/CUE.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'OPENCUES.md'))).toBe(false);
    // User-level untouched (no defaults seeded since this run was --project).
    expect(fs.existsSync(path.join(tmpHome, '.cues/OPENCUES.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, '.cues/cues/tips.md'))).toBe(false);
  });
});
