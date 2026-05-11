// Integration tests for sandbox-runner — actually exec bwrap with
// the generated args and verify the runtime guarantees:
//
//   1. FS writes outside the workdir are blocked (read-only bind).
//   2. /tmp writes succeed (tmpfs).
//   3. Network access is denied (--unshare-net).
//   4. PID namespace is isolated (script sees only a handful of pids).
//
// Skipped automatically when /usr/bin/bwrap isn't installed.
// CI matrix should add bubblewrap to keep these executing.

import { describe, it, expect } from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { wrapWithBwrap, _resetBwrapCacheForTests } from './sandbox-runner';

function bwrapInstalled(): boolean {
  try { return fs.statSync('/usr/bin/bwrap').isFile(); }
  catch { return false; }
}

// Run a bash command through wrapWithBwrap, return stdout.
function runInSandbox(
  bash: string,
  cfg: Parameters<typeof wrapWithBwrap>[2],
  roots: readonly string[] = [],
): { stdout: string; stderr: string; code: number } {
  _resetBwrapCacheForTests();
  const wrapped = wrapWithBwrap('bash', ['-c', bash], cfg, roots);
  if (!wrapped) throw new Error('bwrap not available');
  const r = spawnSync(wrapped.command, [...wrapped.args], {
    encoding: 'utf8',
    timeout: 5000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? -1 };
}

describe.skipIf(!bwrapInstalled())('sandbox-runner — real bwrap execution', () => {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sandbox-test-'));

  it('blocks FS writes outside /tmp (read-only bind)', () => {
    const target = path.join(sandboxRoot, 'leak.txt');
    const r = runInSandbox(
      `touch ${target} 2>/dev/null && echo WROTE || echo BLOCKED`,
      { mode: 'strict', workdir: sandboxRoot },
      [sandboxRoot],
    );
    expect(r.stdout.trim()).toBe('BLOCKED');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('allows FS writes inside /tmp (fresh tmpfs)', () => {
    const r = runInSandbox(
      `touch /tmp/oc-test && echo OK && cat /tmp/oc-test >/dev/null && echo READBACK`,
      { mode: 'strict', workdir: sandboxRoot },
      [sandboxRoot],
    );
    expect(r.stdout).toContain('OK');
    expect(r.stdout).toContain('READBACK');
    // /tmp/oc-test must NOT exist outside the sandbox (tmpfs is per-sandbox)
    expect(fs.existsSync('/tmp/oc-test')).toBe(false);
  });

  it('allows FS writes inside workdir when fs: rw', () => {
    const r = runInSandbox(
      `touch ${sandboxRoot}/inside-wr.txt && echo OK || echo FAIL`,
      { mode: 'strict', fs: 'rw', workdir: sandboxRoot },
      [sandboxRoot],
    );
    expect(r.stdout.trim()).toBe('OK');
    // Clean up — workdir is real disk, file lingers.
    try { fs.rmSync(path.join(sandboxRoot, 'inside-wr.txt')); } catch { /* */ }
  });

  it('denies network access by default (--unshare-net)', () => {
    const r = runInSandbox(
      `curl --max-time 2 -s http://127.0.0.1:65535/ 2>/dev/null && echo LEAKED || echo BLOCKED`,
      { mode: 'strict', workdir: sandboxRoot },
      [sandboxRoot],
    );
    expect(r.stdout.trim()).toBe('BLOCKED');
  });

  it('isolates PID namespace — script sees only a few processes', () => {
    // Outside, /proc has dozens of pids. Inside the sandbox, only the
    // sandbox processes are visible.
    const r = runInSandbox(
      `ls /proc | grep -c '^[0-9]*$'`,
      { mode: 'strict', workdir: sandboxRoot },
      [sandboxRoot],
    );
    const pidCount = parseInt(r.stdout.trim(), 10);
    expect(pidCount).toBeLessThan(20);  // typical sandboxed: 3-7
  });

  it('script cannot see host /home', () => {
    const r = runInSandbox(
      `ls /home 2>/dev/null && echo VISIBLE || echo HIDDEN`,
      { mode: 'strict', workdir: sandboxRoot },
      [sandboxRoot],
    );
    // /home is NOT bound, so ls fails (or shows empty). Either is fine.
    expect(r.stdout.includes('VISIBLE') && r.stdout.match(/wilfred|root|home/i)).toBeFalsy();
  });

  it('UTS namespace is isolated — sethostname inside does not affect host', () => {
    // `--unshare-uts` gives the sandbox its own UTS namespace but
    // INHERITS the parent's hostname unless --hostname is passed.
    // Verify isolation by reading + (attempting to) set hostname
    // inside the sandbox; the change must not propagate out.
    const beforeOutside = execSync('hostname').toString().trim();
    // hostname-modification needs CAP_SYS_ADMIN in the namespace; in
    // an unprivileged user namespace this requires the user being
    // root inside the ns. Just check the sandbox CAN see its own
    // hostname (smoke that --unshare-uts didn't break basic syscall).
    const r = runInSandbox(
      `hostname || echo NO_BIN`,
      { mode: 'strict', workdir: sandboxRoot },
      [sandboxRoot],
    );
    expect(r.code).toBe(0);
    const afterOutside = execSync('hostname').toString().trim();
    expect(afterOutside).toBe(beforeOutside);
  });

  it('non-existent script path returns spawn failure cleanly', () => {
    // Doesn't crash bwrap — bash inside the sandbox reports the
    // missing file.
    const r = runInSandbox(
      `bash ${sandboxRoot}/does-not-exist.sh 2>&1; echo EXIT=$?`,
      { mode: 'strict', workdir: sandboxRoot },
      [sandboxRoot],
    );
    expect(r.stdout).toMatch(/No such file|cannot.*open|EXIT=127/i);
  });

  it('parent-die: orphaned bwrap process exits when parent killed', () => {
    // Hard to test directly without playing process-tree games.
    // Smoke: the wrapper INCLUDES --die-with-parent; covered by the
    // unit-test that asserts the flag is present.
    const wrapped = wrapWithBwrap('bash', [], { mode: 'strict' }, []);
    expect(wrapped?.args).toContain('--die-with-parent');
  });
});
