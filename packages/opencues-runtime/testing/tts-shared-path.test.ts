// Pins the cross-host TTS path contract.
//
// Prior bug class: each host's bootstrap walked a candidate path list to
// find speak.sh — which often piggybacked on CC's installed copy. Result:
// uninstalling CC silently broke OC + Codex TTS. The fix moved speak.sh +
// SpeakCtl.cs from CC's patches/actions/ into defaults/scripts/, and made
// every host resolve TTS to the same user-level path:
//
//   ~/.cues/scripts/speak.sh   (or $OPENCUES_HOME/scripts/speak.sh)
//
// These tests verify each host's bootstrap source resolves to that one
// path. Source-level checks instead of runtime invocation because the
// bootstraps are TS modules that get patched into native hosts — they're
// not directly importable from a vitest run.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');

describe('TTS shared-path contract', () => {
  it('speak.sh + SpeakCtl.cs live in defaults/scripts/ (shared, not CC-only)', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'defaults/scripts/speak.sh'))).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, 'defaults/scripts/SpeakCtl.cs'))).toBe(true);
    // The OLD location must NOT have these any more — if they reappear, OC's
    // bootstrap will silently revert to piggybacking on CC's install.
    expect(fs.existsSync(path.join(REPO_ROOT, 'integrations/claude-code/patches/actions/speak.sh'))).toBe(false);
    expect(fs.existsSync(path.join(REPO_ROOT, 'integrations/claude-code/patches/actions/SpeakCtl.cs'))).toBe(false);
  });

  it('CC opencuesRuntime.ts ttsScriptPath resolves to ~/.cues/scripts/speak.sh', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'integrations/claude-code/patches/opencuesRuntime.ts'),
      'utf8',
    );
    // Extract just the ttsScriptPath line — comments elsewhere in the
    // file legitimately mention paths like ~/claude-code-cues/, so we
    // can't anti-grep file-wide.
    const ttsLine = src.split('\n').find(l => l.includes('ttsScriptPath:'));
    expect(ttsLine).toBeDefined();
    // Path is built as ".cues" + "/scripts/speak.sh" via template
    // concatenation. Honors OPENCUES_HOME for env-driven overrides.
    expect(ttsLine!).toContain('"/.cues"');
    expect(ttsLine!).toContain('"/scripts/speak.sh"');
    expect(ttsLine!).toContain('OPENCUES_HOME');
    // Anti-regression: no require.resolve trick (coupled TTS to CC's
    // install layout) and no <fork>/.cues/scripts/ hardcode (CC-only).
    expect(ttsLine!).not.toMatch(/require.*\.resolve/);
    expect(ttsLine!).not.toContain('claude-code-cues');
  });

  it('OC opencuesBootstrap.ts resolveTtsScript returns one-line user-level path', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'integrations/opencode/patches/opencuesBootstrap.ts'),
      'utf8',
    );
    // Anti-regression guards for the bug class:
    expect(src).not.toContain('candidates');                          // no path walker array
    expect(src).not.toContain('claude-code-cues');                    // no piggybacking on CC
    expect(src).not.toContain('.claude/opencues/');                   // no pre-compact-footprint paths
    expect(src).not.toContain('.claude/actions/');                    // no legacy paths
    // Positive: reference the canonical user-level path.
    expect(src).toContain('scripts/speak.sh');
    expect(src).toContain('OPENCUES_HOME');
  });
});
