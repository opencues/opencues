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
// Platform support:
//   * Linux/WSL2 — bwrap (bubblewrap), see `wrapWithBwrap`.
//   * macOS     — `sandbox-exec` (Apple's seatbelt sandbox), see
//                 `wrapWithSandboxExec`. Ships in the base OS — no
//                 install needed. The mechanism is deprecated by
//                 Apple ("System Integrity Protection will eventually
//                 replace it") but is still present on macOS 14/15
//                 and still works for our use case.
//   * Windows native — AppContainer / Job Objects — not yet
//                 implemented. Falls through unwrapped.
//
// Use `wrapForPlatform()` instead of the per-platform wrappers when
// you don't care which mechanism applies — it dispatches by
// `process.platform`. Returns null when no sandbox is available for
// the current platform; caller must fall through unwrapped.

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

// ─── macOS: sandbox-exec ────────────────────────────────────────────────
//
// sandbox-exec consumes a TinyScheme-style policy passed via `-p`.
// We deny everything by default, then re-allow:
//   * process-fork / process-exec (the script itself needs to run)
//   * file-read* (system libs, /usr, /etc, the blank's folder)
//   * file-write* only inside the workdir if `fs: 'rw'`
//   * network* only if `net: 'allow'`
//   * mach-lookup for the dynamic linker and locale services
//
// macOS-specific quirks:
//   * No PID/IPC namespacing equivalent. The script CAN see other
//     processes via `ps`, but can't signal them without matching
//     uid (already enforced by kernel).
//   * No tmpfs equivalent for /tmp. The script can write to /tmp if
//     `fs: 'rw'`; we don't otherwise restrict it. Lower-priority gap
//     than the Linux story for now.
//   * The seatbelt policy language is sparsely documented; the rules
//     below mirror the public examples in /System/Library/Sandbox/
//     Profiles/. Don't add (deny default) without process-exec
//     allow — sandbox-exec refuses to load the policy.

/**
 * Wrap a command with `sandbox-exec` per the SandboxConfig.
 *
 * Returns the new ProcessSpec-shape if sandboxing was applied, or
 * null when:
 *   * sandbox config is missing or mode !== 'strict'
 *   * sandbox-exec is not available (non-macOS; or stripped-down
 *     macOS where /usr/bin/sandbox-exec is missing)
 */
export function wrapWithSandboxExec(
  command: string,
  args: readonly string[],
  cfg: SandboxConfig | undefined,
  cuesRoots: readonly string[],
): WrappedSpec | null {
  if (!cfg || cfg.mode !== 'strict') return null;
  const sbx = findSandboxExec();
  if (!sbx) return null;

  // Build the TinyScheme policy. Re-allow only what the script needs.
  const lines: string[] = [
    '(version 1)',
    '(deny default)',
    // The script (bash, the user's interpreter) must be able to fork
    // and exec. Without this, sandbox-exec refuses to launch.
    '(allow process-fork)',
    '(allow process-exec)',
    // Default-allow file-read (system libs, /usr, /etc, the blank's
    // own folder). The path sandbox already enforced realpath against
    // CUE_ROOT before reaching this layer.
    '(allow file-read*)',
    // sysctl-read is needed by many tools that probe system config
    // (curl, openssl, etc.). Allow read but not write.
    '(allow sysctl-read)',
    // mach-lookup is needed for the dynamic linker + locale; without
    // it, even `echo` fails to start.
    '(allow mach-lookup)',
    // Signals the script sends to ITSELF + child processes.
    '(allow signal (target self))',
    // The script's own process metadata.
    '(allow process-info* (target self))',
  ];

  // Network policy — allow vs deny.
  if (cfg.net === 'allow') {
    lines.push('(allow network*)');
  } else {
    // Implicitly denied by (deny default), but be explicit.
    lines.push('(deny network*)');
  }

  // File-write policy — only inside the workdir (if rw) + always
  // allow /tmp + /private/tmp (Mac's real tmp path).
  if (cfg.fs === 'rw' && cfg.workdir) {
    lines.push(`(allow file-write* (subpath "${escapeScheme(cfg.workdir)}"))`);
  }
  // Always allow /tmp writes — same as Linux's tmpfs(/tmp), though
  // without the per-sandbox isolation. The script can leave files
  // behind in /tmp; the path sandbox + audit log catch any escape
  // attempt that tries to use those files.
  lines.push('(allow file-write* (subpath "/tmp"))');
  lines.push('(allow file-write* (subpath "/private/tmp"))');
  lines.push('(allow file-write* (subpath "/private/var/folders"))');

  // Read access to every CUES root — sibling pack scripts, shared
  // assets, etc. (Linux's wrapper does the same.)
  for (const root of cuesRoots) {
    if (root && fs.existsSync(root)) {
      lines.push(`(allow file-read* (subpath "${escapeScheme(root)}"))`);
    }
  }

  const policy = lines.join('\n');
  return { command: sbx, args: ['-p', policy, command, ...args] };
}

function escapeScheme(s: string): string {
  // Backslashes + double-quotes need TinyScheme-style escaping.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

let _sandboxExecPath: string | null | undefined;
function findSandboxExec(): string | null {
  if (_sandboxExecPath !== undefined) return _sandboxExecPath;
  if (process.platform !== 'darwin') { _sandboxExecPath = null; return null; }
  for (const p of ['/usr/bin/sandbox-exec']) {
    try { if (fs.statSync(p).isFile()) { _sandboxExecPath = p; return p; } }
    catch { /* try next */ }
  }
  _sandboxExecPath = null;
  return null;
}

/** Reset the sandbox-exec path cache. Test-only. */
export function _resetSandboxExecCacheForTests(): void {
  _sandboxExecPath = undefined;
}

// ─── Platform dispatcher ───────────────────────────────────────────────

/**
 * Wrap a command with whichever OS sandbox is available for the
 * current platform. Linux → bwrap, macOS → sandbox-exec, else null.
 *
 * Call sites that don't care which mechanism applies should use this
 * — it keeps the per-platform branching in one place.
 */
export function wrapForPlatform(
  command: string,
  args: readonly string[],
  cfg: SandboxConfig | undefined,
  cuesRoots: readonly string[],
): WrappedSpec | null {
  if (!cfg || cfg.mode !== 'strict') return null;
  if (process.platform === 'linux') {
    return wrapWithBwrap(command, args, cfg, cuesRoots);
  }
  if (process.platform === 'darwin') {
    return wrapWithSandboxExec(command, args, cfg, cuesRoots);
  }
  return null;
}
