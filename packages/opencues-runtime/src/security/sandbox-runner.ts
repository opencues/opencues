// OS-level sandbox for scripted blanks. Wraps a `child_process.spawn`
// call with `bubblewrap (bwrap)` so the script runs with:
//
//   * read-only filesystem outside its own folder
//   * no network access (default)
//   * a fresh tmpfs /tmp
//   * a new PID + IPC namespace
//   * the caller's user (no root escalation)
//
// Opt-in per blank via frontmatter (`sandbox: strict`). Existing
// blanks that don't declare sandboxing run unwrapped, same as today —
// this is additive, not a forced upgrade.
//
// bwrap is Linux-only (covers WSL2). macOS would use `sandbox-exec`;
// Windows native would need AppContainer/Job Objects. For now, on
// platforms without bwrap, the wrapper returns null and the host
// runs the spec unmodified — the path sandbox + audit log still
// apply, just not OS-level confinement.

import * as fs from 'node:fs';
import * as path from 'node:path';

export type SandboxMode = 'strict' | 'off';
export type SandboxNet = 'allow' | 'deny';
export type SandboxFs = 'ro' | 'rw';

export interface SandboxConfig {
  /** Opt-in level — only 'strict' triggers wrapping. */
  readonly mode?: SandboxMode;
  /** Network policy inside the sandbox. Defaults to 'deny'. */
  readonly net?: SandboxNet;
  /** Filesystem-write policy for the blank's own folder. Defaults to 'ro'. */
  readonly fs?: SandboxFs;
  /** The blank's folder (typically `~/.cues/blanks/<name>/`). Bind-mounted
   *  read-only by default, read-write when `fs: 'rw'`. */
  readonly workdir?: string;
}

export interface WrappedSpec {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Wrap a command with `bwrap` per the SandboxConfig.
 *
 * Returns the new ProcessSpec-shape (command + args) if sandboxing
 * was applied, or null when:
 *   * sandbox config is missing or mode !== 'strict'
 *   * bwrap is not available on this system
 *
 * Caller is responsible for falling back to the unwrapped spec in
 * the null case (and logging the fall-back somewhere visible if it
 * matters — typically it doesn't, since unwrapped is the v1 default).
 */
export function wrapWithBwrap(
  command: string,
  args: readonly string[],
  cfg: SandboxConfig | undefined,
  cuesRoots: readonly string[],
): WrappedSpec | null {
  if (!cfg || cfg.mode !== 'strict') return null;
  const bwrap = findBwrap();
  if (!bwrap) return null;

  const bwrapArgs: string[] = [
    // Read-only access to system directories. The blank's script
    // can call /bin/sh, /usr/bin/* etc. but can't modify any of it.
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/bin', '/bin',
    '--ro-bind-try', '/lib', '/lib',
    '--ro-bind-try', '/lib64', '/lib64',
    '--ro-bind-try', '/etc', '/etc',
    '--ro-bind-try', '/sbin', '/sbin',
    // Minimal /dev (just /dev/null, /dev/zero, /dev/random/urandom, /dev/tty).
    '--dev', '/dev',
    // Fresh tmpfs /tmp — visible writes confined to the sandbox.
    '--tmpfs', '/tmp',
    // New /proc inside the sandbox.
    '--proc', '/proc',
    // New PID + IPC namespaces — the script can't see other
    // processes on the system.
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    // User namespace — kernel-best-effort. On older kernels without
    // unprivileged user namespaces this falls back to the caller's
    // user (still confined, just no namespace flip).
    '--unshare-user-try',
    // Die when the parent (bwrap launcher) exits.
    '--die-with-parent',
    // (Older bwrap < 0.5 doesn't support --clearenv. The caller
    // already controls env via spec.env passed to child_process.spawn,
    // so we don't need bwrap to clear it.)
  ];

  // Network unshare unless explicitly allowed.
  if (cfg.net !== 'allow') {
    bwrapArgs.push('--unshare-net');
  } else {
    // Allow network. Bind /etc/resolv.conf + /etc/hosts so DNS works
    // (some setups have these inside /etc already covered by the
    // --ro-bind-try /etc above, but explicit doesn't hurt).
    bwrapArgs.push('--ro-bind-try', '/etc/resolv.conf', '/etc/resolv.conf');
  }

  // Mount the blank's own folder (typically `~/.cues/blanks/<name>/`)
  // so the script can find its colocated assets. Read-only unless
  // `fs: 'rw'`.
  if (cfg.workdir) {
    const flag = cfg.fs === 'rw' ? '--bind' : '--ro-bind';
    bwrapArgs.push(flag, cfg.workdir, cfg.workdir);
  }

  // Also bind every CUES root read-only so the script can read
  // sibling cues / blanks (rare, but the blank's own folder might
  // reference `../shared/` etc.). The blank's specific folder
  // (above) gets the writable flag if requested; the broader root
  // stays read-only.
  for (const root of cuesRoots) {
    if (root && root !== cfg.workdir && fs.existsSync(root)) {
      bwrapArgs.push('--ro-bind', root, root);
    }
  }

  // After all flags, the real command + args. `--` separates them
  // from bwrap's own arg parsing.
  bwrapArgs.push('--', command, ...args);

  return { command: bwrap, args: bwrapArgs };
}

// Cache bwrap path lookup. `null` = looked-up-and-not-found,
// `undefined` = not-yet-looked-up.
let _bwrapPath: string | null | undefined;
function findBwrap(): string | null {
  if (_bwrapPath !== undefined) return _bwrapPath;
  for (const p of ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/opt/homebrew/bin/bwrap']) {
    try { if (fs.statSync(p).isFile()) { _bwrapPath = p; return p; } }
    catch { /* try next */ }
  }
  // Fall back to PATH lookup via env. Cheap heuristic.
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'bwrap');
    try { if (fs.statSync(p).isFile()) { _bwrapPath = p; return p; } }
    catch { /* */ }
  }
  _bwrapPath = null;
  return null;
}

/** Reset the bwrap-path cache. Test-only. */
export function _resetBwrapCacheForTests(): void {
  _bwrapPath = undefined;
}
