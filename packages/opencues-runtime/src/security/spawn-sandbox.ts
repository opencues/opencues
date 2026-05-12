// Shared security utilities for native-host `spawnProcess`
// implementations. Each integration (CC / OC / gemini-cli) wraps its
// child_process.spawn callsite with these helpers so the same trust
// model applies across hosts:
//
//   1. validateScriptPath() — refuse script paths that resolve
//      outside any of the configured CUES roots. Defends against
//      a malicious cue pack writing `blankScript: /etc/passwd`. Uses
//      fs.realpathSync so a symlink inside a root pointing outside
//      is also refused.
//
//   2. appendAuditLog() — writes one line per script invocation to
//      `<first-root>/.opencues-log`. Satisfies the spec's SHOULD 4
//      requirement (`blank-spec.md` § Trust model): runtimes SHOULD
//      log blankScript invocations with source path + exit code.
//
// These helpers are imported by per-integration patches. Chrome has
// its own sandbox in host/host.cjs (it doesn't use this module —
// the chrome runtime has no Node primitives in the content-script
// context).

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Path sandbox ────────────────────────────────────────────────────────

export interface SandboxResult {
  /** True when the path is under one of the allowed roots (or non-absolute). */
  readonly ok: boolean;
  /** When ok: the canonical resolved path (post-realpath). */
  readonly resolved?: string;
  /** When !ok: a short reason for diagnostics. */
  readonly reason?: string;
}

/**
 * True when `abs` lies inside or equals `root` (filesystem-prefix check,
 * not string-prefix — handles trailing-separator subtleties).
 */
function withinRoot(abs: string, root: string): boolean {
  if (abs === root) return true;
  return abs.startsWith(root + path.sep);
}

/**
 * Validate that a single absolute path (typically `args[0]` — the
 * script the runtime asked us to bash) stays inside one of the
 * provided roots, even after symlink resolution.
 *
 * Non-absolute paths pass through (`{ok: true, resolved: input}`) —
 * spawn will look them up via PATH like any other command.
 *
 * Empty `roots` is treated as "no allow-list, refuse all absolute
 * paths" — fail-closed. Pass at least one root.
 */
export function validateScriptPath(p: string, roots: readonly string[]): SandboxResult {
  if (typeof p !== 'string' || p.length === 0) return { ok: true, resolved: p };
  if (!path.isAbsolute(p)) return { ok: true, resolved: p };

  if (roots.length === 0) {
    return { ok: false, reason: 'no CUES roots configured' };
  }

  const absResolved = path.resolve(p);
  let real: string;
  try { real = fs.realpathSync(absResolved); }
  catch { real = absResolved; }  // ENOENT — let spawn fail naturally

  const resolvedRoots = roots.map(r => path.resolve(r));
  for (const root of resolvedRoots) {
    if (withinRoot(real, root)) return { ok: true, resolved: real };
  }
  return {
    ok: false,
    reason: `script path resolves outside CUES roots: ${real}`,
  };
}

// ─── Audit log ───────────────────────────────────────────────────────────

export interface AuditSpec {
  readonly command: string;
  readonly args?: readonly string[];
}
export interface AuditResult {
  readonly exitCode: number;
  readonly timedOut?: boolean;
}

/**
 * Append one CSV-ish line to the audit log:
 *
 *   2026-05-11T18:50:23Z  claude-code  bash  /home/.../volume-blank.sh,get,volume  exit=0  ms=84
 *
 * Best-effort — swallows write errors so a missing/locked log file
 * never breaks the user's blank-fill. Lands in `<first-root>/.opencues-log`.
 *
 * Pass `durationMs` if you measured it; otherwise the line just
 * records the invocation.
 */
export function appendAuditLog(
  hostName: string,
  spec: AuditSpec,
  result: AuditResult,
  roots: readonly string[],
  durationMs?: number,
): void {
  if (roots.length === 0) return;
  // Pick the FIRST EXISTING root. Opencode + gemini-cli's getCuesRoots()
  // pushes `<cwd>/.cues` ahead of `~/.cues/`, but their cwd is the fork
  // directory (e.g. /home/wilfred/opencode-cues/) which has no `.cues/`.
  // Naively writing to `roots[0]/.opencues-log` then ENOENTs silently
  // (try/catch on appendFileSync swallows), so the audit log never lands
  // — leaving security-push SHOULD 4 unmet on those hosts. Walking until
  // an existing root keeps the spec's "lands in <first-root>" semantics
  // while skipping placeholder roots that don't exist on disk.
  let root: string | undefined;
  for (const r of roots) {
    try { if (fs.statSync(r).isDirectory()) { root = r; break; } } catch { /* skip */ }
  }
  if (!root) return;
  const ts = new Date().toISOString();
  const argsStr = (spec.args ?? []).join(',');
  const dur = durationMs !== undefined ? `  ms=${durationMs}` : '';
  const flag = result.timedOut ? '  timedOut=true' : '';
  const line = `${ts}\t${hostName}\t${spec.command}\t${argsStr}\texit=${result.exitCode}${dur}${flag}\n`;
  try {
    fs.appendFileSync(path.join(root, '.opencues-log'), line);
  } catch { /* best-effort */ }
}
