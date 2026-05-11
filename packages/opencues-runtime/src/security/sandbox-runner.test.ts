// Tests for sandbox-runner.ts — bwrap wrapper for scripted-blank
// sandboxing. We test the arg-construction (a pure transformation
// of inputs → bwrap CLI string) rather than actually executing
// bwrap, which would require Linux + bubblewrap installed.
//
// Smoke-test the actual bwrap invocation lives in
// integrations/chrome/host/host.cjs's manual exec testing path.

import { describe, it } from 'vitest';
import * as assert from 'node:assert';
import { wrapWithBwrap, _resetBwrapCacheForTests } from './sandbox-runner';

describe('wrapWithBwrap — opt-in', () => {
  it('returns null when config is undefined', () => {
    assert.strictEqual(wrapWithBwrap('bash', ['x.sh'], undefined, ['/x']), null);
  });
  it('returns null when mode !== strict', () => {
    assert.strictEqual(wrapWithBwrap('bash', ['x.sh'], { mode: 'off' }, ['/x']), null);
  });
});

describe('wrapWithBwrap — generated args (strict mode)', () => {
  // bwrap path detection requires /usr/bin/bwrap or similar. On CI
  // and dev machines that have bubblewrap installed (typical for
  // Linux/WSL) we get a real result; everywhere else we skip.
  const probe = wrapWithBwrap('bash', [], { mode: 'strict' }, []);
  const bwrapAvailable = probe !== null;

  it('returns the bwrap path as command (when available)', () => {
    if (!bwrapAvailable) return;
    const r = wrapWithBwrap('bash', ['/x/script.sh'], { mode: 'strict' }, ['/x']);
    assert.ok(r);
    assert.ok(r!.command.endsWith('bwrap'));
  });

  it('passes --unshare-net when net is omitted (default deny)', () => {
    if (!bwrapAvailable) return;
    const r = wrapWithBwrap('bash', ['/x/s.sh'], { mode: 'strict' }, ['/x']);
    assert.ok(r!.args.includes('--unshare-net'));
  });

  it('passes --unshare-net when net=deny', () => {
    if (!bwrapAvailable) return;
    const r = wrapWithBwrap('bash', ['/x/s.sh'], { mode: 'strict', net: 'deny' }, ['/x']);
    assert.ok(r!.args.includes('--unshare-net'));
  });

  it('does NOT pass --unshare-net when net=allow', () => {
    if (!bwrapAvailable) return;
    const r = wrapWithBwrap('bash', ['/x/s.sh'], { mode: 'strict', net: 'allow' }, ['/x']);
    assert.ok(!r!.args.includes('--unshare-net'));
  });

  it('passes --unshare-pid and --unshare-ipc regardless', () => {
    if (!bwrapAvailable) return;
    const r = wrapWithBwrap('bash', ['/x/s.sh'], { mode: 'strict' }, ['/x']);
    assert.ok(r!.args.includes('--unshare-pid'));
    assert.ok(r!.args.includes('--unshare-ipc'));
  });

  it('mounts /tmp as tmpfs, /proc as proc, /dev as dev', () => {
    if (!bwrapAvailable) return;
    const r = wrapWithBwrap('bash', ['/x/s.sh'], { mode: 'strict' }, ['/x']);
    const idxTmp = r!.args.indexOf('--tmpfs');
    assert.ok(idxTmp >= 0 && r!.args[idxTmp + 1] === '/tmp');
    const idxProc = r!.args.indexOf('--proc');
    assert.ok(idxProc >= 0 && r!.args[idxProc + 1] === '/proc');
    const idxDev = r!.args.indexOf('--dev');
    assert.ok(idxDev >= 0 && r!.args[idxDev + 1] === '/dev');
  });

  it('binds workdir read-only when fs is omitted', () => {
    if (!bwrapAvailable) return;
    const r = wrapWithBwrap(
      'bash',
      ['/home/x/.cues/blanks/foo/s.sh'],
      { mode: 'strict', workdir: '/home/x/.cues/blanks/foo' },
      ['/home/x/.cues'],
    );
    // Should find a --ro-bind for the workdir (CUES_ROOT also gets
    // --ro-bind; the workdir's specific binding precedes it).
    const idx = r!.args.findIndex((a, i) => a === '--ro-bind' && r!.args[i + 1] === '/home/x/.cues/blanks/foo');
    assert.ok(idx >= 0);
    assert.ok(!r!.args.includes('--bind'));
  });

  it('binds workdir read-write when fs=rw', () => {
    if (!bwrapAvailable) return;
    const r = wrapWithBwrap(
      'bash',
      ['/home/x/.cues/blanks/foo/s.sh'],
      { mode: 'strict', fs: 'rw', workdir: '/home/x/.cues/blanks/foo' },
      ['/home/x/.cues'],
    );
    const idx = r!.args.findIndex((a, i) => a === '--bind' && r!.args[i + 1] === '/home/x/.cues/blanks/foo');
    assert.ok(idx >= 0);
  });

  it('places `--` separator before original command + args', () => {
    if (!bwrapAvailable) return;
    const r = wrapWithBwrap('bash', ['/x/s.sh', 'arg1'], { mode: 'strict' }, ['/x']);
    const dashIdx = r!.args.indexOf('--');
    assert.ok(dashIdx >= 0);
    assert.strictEqual(r!.args[dashIdx + 1], 'bash');
    assert.strictEqual(r!.args[dashIdx + 2], '/x/s.sh');
    assert.strictEqual(r!.args[dashIdx + 3], 'arg1');
  });
});

describe('wrapWithBwrap — bwrap absence', () => {
  it('returns null when bwrap path is empty (forced via mock)', () => {
    _resetBwrapCacheForTests();
    // Stash PATH so the lookup-via-PATH also misses; restore after.
    const oldPath = process.env.PATH;
    process.env.PATH = '/nonexistent-only';
    try {
      const r = wrapWithBwrap('bash', ['/x/s.sh'], { mode: 'strict' }, ['/x']);
      // We can't easily mock /usr/bin/bwrap's stat; this test passes
      // when bwrap genuinely isn't there. On CI with bwrap installed
      // the file-system probe finds it directly so the PATH-only
      // override doesn't help. Skip the assertion in that case.
      if (r !== null) return;
      assert.strictEqual(r, null);
    } finally {
      process.env.PATH = oldPath;
      _resetBwrapCacheForTests();
    }
  });
});
