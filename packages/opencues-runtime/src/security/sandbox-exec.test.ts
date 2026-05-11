// Tests for the macOS sandbox-exec wrapper + the cross-platform
// dispatcher. We test policy-string construction (a pure transform
// of inputs → CLI args) rather than executing sandbox-exec, which
// only runs on macOS.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  wrapWithSandboxExec,
  wrapForPlatform,
  _resetSandboxExecCacheForTests,
  _resetBwrapCacheForTests,
} from './sandbox-runner';

// Forcing process.platform inside vitest is awkward (read-only on
// some Node versions). Tests that depend on platform branching are
// gated on the actual host platform — they're skipped where they
// can't run, just like the bwrap tests.

const isDarwin = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

describe('wrapWithSandboxExec — opt-in', () => {
  beforeEach(() => _resetSandboxExecCacheForTests());

  it('returns null when config is undefined', () => {
    expect(wrapWithSandboxExec('bash', ['x.sh'], undefined, ['/x'])).toBeNull();
  });
  it('returns null when mode !== strict', () => {
    expect(wrapWithSandboxExec('bash', ['x.sh'], { mode: 'off' }, ['/x'])).toBeNull();
  });
  it('returns null on non-darwin platforms', () => {
    if (isDarwin) return; // skip on the host where it would succeed
    expect(wrapWithSandboxExec('bash', ['x.sh'], { mode: 'strict' }, ['/x'])).toBeNull();
  });
});

describe('wrapWithSandboxExec — policy construction (darwin only)', () => {
  beforeEach(() => _resetSandboxExecCacheForTests());

  it('builds a deny-default policy with allow-list re-grants', () => {
    if (!isDarwin) return;
    const r = wrapWithSandboxExec('bash', ['/x/s.sh'], { mode: 'strict' }, []);
    if (!r) return; // sandbox-exec missing on this mac
    expect(r.command).toBe('/usr/bin/sandbox-exec');
    expect(r.args[0]).toBe('-p');
    const policy = r.args[1];
    expect(policy).toContain('(version 1)');
    expect(policy).toContain('(deny default)');
    expect(policy).toContain('(allow process-fork)');
    expect(policy).toContain('(allow process-exec)');
  });

  it('denies network by default', () => {
    if (!isDarwin) return;
    const r = wrapWithSandboxExec('bash', [], { mode: 'strict' }, []);
    if (!r) return;
    expect(r.args[1]).toContain('(deny network*)');
    expect(r.args[1]).not.toContain('(allow network*)');
  });

  it('allows network when net=allow', () => {
    if (!isDarwin) return;
    const r = wrapWithSandboxExec('bash', [], { mode: 'strict', net: 'allow' }, []);
    if (!r) return;
    expect(r.args[1]).toContain('(allow network*)');
  });

  it('grants write access to workdir when fs=rw', () => {
    if (!isDarwin) return;
    const r = wrapWithSandboxExec('bash', [], { mode: 'strict', fs: 'rw', workdir: '/Users/me/.cues/blanks/x' }, []);
    if (!r) return;
    expect(r.args[1]).toContain('(allow file-write* (subpath "/Users/me/.cues/blanks/x"))');
  });

  it('does NOT grant write access when fs=ro (default)', () => {
    if (!isDarwin) return;
    const r = wrapWithSandboxExec('bash', [], { mode: 'strict', workdir: '/Users/me/.cues/blanks/x' }, []);
    if (!r) return;
    // The workdir line for write should be absent (only /tmp + /private/tmp + /private/var/folders).
    expect(r.args[1]).not.toContain('(allow file-write* (subpath "/Users/me/.cues/blanks/x"))');
  });

  it('escapes double quotes in workdir', () => {
    if (!isDarwin) return;
    const r = wrapWithSandboxExec('bash', [], { mode: 'strict', fs: 'rw', workdir: '/Users/me/has"quote/x' }, []);
    if (!r) return;
    expect(r.args[1]).toContain('/Users/me/has\\"quote/x');
  });

  it('always allows /tmp + /private/tmp writes', () => {
    if (!isDarwin) return;
    const r = wrapWithSandboxExec('bash', [], { mode: 'strict' }, []);
    if (!r) return;
    expect(r.args[1]).toContain('(allow file-write* (subpath "/tmp"))');
    expect(r.args[1]).toContain('(allow file-write* (subpath "/private/tmp"))');
  });

  it('appends command + args after the policy', () => {
    if (!isDarwin) return;
    const r = wrapWithSandboxExec('bash', ['-c', 'echo hi'], { mode: 'strict' }, []);
    if (!r) return;
    expect(r.args.slice(-3)).toEqual(['bash', '-c', 'echo hi']);
  });
});

describe('wrapForPlatform — dispatcher', () => {
  beforeEach(() => {
    _resetBwrapCacheForTests();
    _resetSandboxExecCacheForTests();
  });

  it('returns null for off-mode regardless of platform', () => {
    expect(wrapForPlatform('bash', [], undefined, [])).toBeNull();
    expect(wrapForPlatform('bash', [], { mode: 'off' }, [])).toBeNull();
  });

  it('on linux: produces a bwrap command (when bwrap installed)', () => {
    if (!isLinux) return;
    const r = wrapForPlatform('bash', ['/x'], { mode: 'strict' }, []);
    if (!r) return;
    expect(r.command).toMatch(/bwrap$/);
  });

  it('on darwin: produces a sandbox-exec command', () => {
    if (!isDarwin) return;
    const r = wrapForPlatform('bash', ['/x'], { mode: 'strict' }, []);
    if (!r) return;
    expect(r.command).toBe('/usr/bin/sandbox-exec');
  });
});
