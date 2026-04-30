// Pins the colocated-helpers contract for shipped control scripts.
//
// Bug class this guards against: shipped scripts hardcoding install-time
// paths (e.g. "${HOME}/.claude/actions/BrightCtl.exe") OR walking a
// candidate-path list to find their helpers. Both patterns were silently
// broken when the install layout moved (~/.claude/opencues → compact
// footprint). The fix: scripts use ${SCRIPT_DIR}/<helper> only — helpers
// live colocated with the script that calls them.
//
// These tests do NOT run the OS-bound helpers (BrightCtl.exe, VolCtl.exe,
// SpeakCtl.exe). They:
//   1. Source-grep each shipped script for the failure-mode tokens.
//   2. Spawn the script in a temp HOME with NO helpers present and
//      assert it falls through to the host fallback (e.g. brightnessctl
//      on Linux) or a sane default — never crashes, never silently
//      writes stale data to the wrong path.

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const DEFAULTS_CONTROLS = path.join(REPO_ROOT, 'defaults/blanks');
const DEFAULTS_SCRIPTS = path.join(REPO_ROOT, 'defaults/scripts');

// Shipped scripts the colocated contract applies to. speak.sh + SpeakCtl.cs
// were moved out of CC's patches/actions/ into defaults/scripts/ as part of
// the cross-host shared-utilities refactor — TTS is now seeded by
// `opencues seed-configs` to ~/.opencues/scripts/ and used by every native
// host (CC, OC, Codex), not piggybacked on CC's install.
const SHIPPED_SCRIPTS: { path: string; helpers: readonly string[] }[] = [
  { path: path.join(DEFAULTS_CONTROLS, 'brightness/brightness-blank.sh'), helpers: ['BrightCtl.exe', 'brightness-set.ps1'] },
  { path: path.join(DEFAULTS_CONTROLS, 'volume/volume-blank.sh'),         helpers: ['VolCtl.exe'] },
  { path: path.join(DEFAULTS_SCRIPTS, 'speak.sh'),                        helpers: ['SpeakCtl.exe'] },
];

describe('shipped control scripts: colocated-helpers contract', () => {
  describe('source-level checks (regressions in path-finding)', () => {
    for (const { path: scriptPath, helpers } of SHIPPED_SCRIPTS) {
      const name = path.basename(scriptPath);
      it(`${name}: file exists`, () => {
        expect(fs.existsSync(scriptPath)).toBe(true);
      });

      it(`${name}: contains no find_helper() function (the deprecated path-walker pattern)`, () => {
        const src = fs.readFileSync(scriptPath, 'utf8');
        expect(src).not.toMatch(/^find_helper\(\)/m);
      });

      it(`${name}: contains no hardcoded ~/.claude/actions/ helper paths (the legacy install location)`, () => {
        const src = fs.readFileSync(scriptPath, 'utf8');
        // Match any of: $HOME/.claude/actions/<helper>, ${HOME}/.claude/actions/<helper>, ~/.claude/actions/<helper>
        const stale = /\$\{?HOME\}?\/\.claude\/actions\/(BrightCtl|VolCtl|SpeakCtl|brightness-set)/;
        expect(src).not.toMatch(stale);
      });

      it(`${name}: looks up its helpers via \${SCRIPT_DIR}/<helper> (colocated)`, () => {
        const src = fs.readFileSync(scriptPath, 'utf8');
        for (const helper of helpers) {
          // Either references the helper by an exact ${SCRIPT_DIR}/<helper>
          // pattern OR doesn't reference it at all (e.g. brightness.sh's
          // PowerShell branch only uses brightness-set.ps1 conditionally).
          const used = new RegExp(`\\b${helper.replace(/\./g, '\\.')}\\b`).test(src);
          if (!used) continue;
          const colocated = new RegExp(`\\$\\{SCRIPT_DIR\\}/${helper.replace(/\./g, '\\.')}`).test(src);
          expect(colocated, `${name} references ${helper} but not via \${SCRIPT_DIR}/${helper}`).toBe(true);
        }
      });
    }
  });

  describe('runtime smoke tests (no helpers present)', () => {
    // Skip on non-Linux just in case; the scripts are bash + may rely on
    // bash-isms / Linux command names. The fallback branches we care about
    // are bash-portable.
    const skip = os.platform() === 'win32';

    it.skipIf(skip)('brightness-blank.sh get: returns a bare integer, never crashes', () => {
      const out = execFileSync('bash', [path.join(DEFAULTS_CONTROLS, 'brightness/brightness-blank.sh'), 'get'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'oc-test-home-')) },
      });
      expect(out.trim()).toMatch(/^\d{1,3}$/);
    });

    it.skipIf(skip)('volume-blank.sh get: returns a bare integer, never crashes', () => {
      const out = execFileSync('bash', [path.join(DEFAULTS_CONTROLS, 'volume/volume-blank.sh'), 'get'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'oc-test-home-')) },
      });
      expect(out.trim()).toMatch(/^\d{1,3}$/);
    });

    it.skipIf(skip)('opencues-blank.sh get: returns "<setting>\\t<value>" when a populated opencues.md is colocated', () => {
      // opencues-blank.sh's contract: read the opencues.md file two
      // levels up from the script. Set up the layout it expects.
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-test-home-'));
      const ctlDir = path.join(tmpHome, '.opencues/blanks/opencues');
      fs.mkdirSync(ctlDir, { recursive: true });
      fs.copyFileSync(
        path.join(DEFAULTS_CONTROLS, 'opencues/opencues-blank.sh'),
        path.join(ctlDir, 'opencues-blank.sh'),
      );
      fs.chmodSync(path.join(ctlDir, 'opencues-blank.sh'), 0o755);
      fs.copyFileSync(
        path.join(REPO_ROOT, 'defaults/opencues.md'),
        path.join(tmpHome, '.opencues/opencues.md'),
      );

      const out = execFileSync('bash', [path.join(ctlDir, 'opencues-blank.sh'), 'get'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: tmpHome },
      });
      expect(out.trim()).toMatch(/^[a-z][a-z0-9_-]*\t.+$/);
    });

    // Documents the behavior the host needs to seed against. The script
    // exits 1 + outputs nothing when opencues.md is empty — same silent-
    // failure mode that hits OpenCuesSettingsBlank.set(). install.cjs
    // seed-configs + setup.sh section 7a-bis ensure this state never
    // happens on a real install.
    it.skipIf(skip)('opencues-blank.sh get: silently exits 1 when opencues.md is 0 bytes', () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-test-home-'));
      const ctlDir = path.join(tmpHome, '.opencues/blanks/opencues');
      fs.mkdirSync(ctlDir, { recursive: true });
      fs.copyFileSync(
        path.join(DEFAULTS_CONTROLS, 'opencues/opencues-blank.sh'),
        path.join(ctlDir, 'opencues-blank.sh'),
      );
      fs.chmodSync(path.join(ctlDir, 'opencues-blank.sh'), 0o755);
      fs.writeFileSync(path.join(tmpHome, '.opencues/opencues.md'), '');

      const result = spawnSync('bash', [path.join(ctlDir, 'opencues-blank.sh'), 'get'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: tmpHome },
      });
      expect(result.status).toBe(1);
      expect(result.stdout.trim()).toBe('');
    });
  });
});
