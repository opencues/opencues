// Pins the colocated-helpers contract for shipped blank scripts.
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
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const DEFAULTS_BLANKS = path.join(REPO_ROOT, 'defaults/blanks');
const DEFAULTS_SCRIPTS = path.join(REPO_ROOT, 'defaults/scripts');

// Shipped scripts the colocated contract applies to. speak.sh + SpeakCtl.cs
// were moved out of CC's patches/actions/ into defaults/scripts/ as part of
// the cross-host shared-utilities refactor — TTS is now seeded by
// `opencues seed-configs` to ~/.cues/scripts/ and used by every native
// host (CC, OC), not piggybacked on CC's install.
const SHIPPED_SCRIPTS: { path: string; helpers: readonly string[] }[] = [
  { path: path.join(DEFAULTS_BLANKS, 'brightness/brightness-blank.sh'), helpers: ['BrightCtl.exe', 'brightness-set.ps1'] },
  { path: path.join(DEFAULTS_BLANKS, 'volume/volume-blank.sh'),         helpers: ['VolCtl.exe'] },
  { path: path.join(DEFAULTS_SCRIPTS, 'speak.sh'),                        helpers: ['SpeakCtl.exe'] },
];

describe('shipped blank scripts: colocated-helpers contract', () => {
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

    it.skipIf(skip)('brightness-blank.sh get: returns selector-satellite "brightness\\t<N>%", never crashes', () => {
      // June 2026: brightness migrated to selector-satellite emission
      // (mirrors volume). Script echoes `brightness\t<value>%` so the
      // runtime's blankSatellite path splices it as one wipeable span.
      const out = execFileSync('bash', [path.join(DEFAULTS_BLANKS, 'brightness/brightness-blank.sh'), 'get'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'oc-test-home-')) },
      });
      expect(out.trim()).toMatch(/^brightness\t\d{1,3}%$/);
    });

    it.skipIf(skip)('brightness-blank.sh set <N>: applies + echoes post-clamp selector-satellite', () => {
      // set 200 clamps to 100 + echoes `brightness\t100%`.
      const out = execFileSync('bash', [path.join(DEFAULTS_BLANKS, 'brightness/brightness-blank.sh'), 'set', '200'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'oc-test-home-')) },
      });
      expect(out.trim()).toBe('brightness\t100%');
    });

    it.skipIf(skip)('volume-blank.sh get: returns selector-satellite "volume\\t<N>%", never crashes', () => {
      // June 2026: volume migrated to selector-satellite emission. The
      // script now echoes `volume\t<value>%` (TAB-separated) so the
      // runtime's blankSatellite path splices it as one wipeable span.
      const out = execFileSync('bash', [path.join(DEFAULTS_BLANKS, 'volume/volume-blank.sh'), 'get'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'oc-test-home-')) },
      });
      expect(out.trim()).toMatch(/^volume\t\d{1,3}%$/);
    });

    it.skipIf(skip)('volume-blank.sh set <N>: applies + echoes post-clamp selector-satellite', () => {
      // Calling set 200 must clamp to 100 and echo `volume\t100%` so
      // the buffer reflects the FINAL state, not the user's pre-clamp
      // input. Same pattern: TAB-separated label+value.
      const out = execFileSync('bash', [path.join(DEFAULTS_BLANKS, 'volume/volume-blank.sh'), 'set', '200'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'oc-test-home-')) },
      });
      expect(out.trim()).toBe('volume\t100%');
    });

    // opencues-blank.sh + sentinel-blank.sh used to live here. Both
    // were retired June 2026: OpenCuesSettingsBlank + SentinelBlank in
    // @opencues/runtime serve every host via blankInvoke (the resolver
    // tries blankInvoke before spawnProcess for any blank name found
    // in the registry, and never falls through for these two). No
    // shell fallback ships from defaults anymore — see PR migrating
    // these to impl-only.
  });
});
