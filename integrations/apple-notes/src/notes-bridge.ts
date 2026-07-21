// osascript spawn wrapper for the JXA scripts in ../jxa/.
//
// Every call is one `osascript -l JavaScript <script> [args…]` spawn
// (~80-300ms measured — NOTES-PLATFORM.md). Errors are classified so
// the daemon can react per-kind:
//   permission-denied  — TCC Automation deny, stderr "(-1743)". A cached
//                        deny is SILENT and instant; doctor documents
//                        the recovery path.
//   not-found          — note deleted mid-flight, stderr "(-1728)".
//   timeout            — osascript hung (Notes beachball); process killed.
//   osascript-failed   — anything else (script bug, parse error).

import { spawn } from 'node:child_process';
import * as path from 'node:path';

export type BridgeErrorKind =
  | 'permission-denied'
  | 'not-found'
  | 'timeout'
  | 'osascript-failed';

export type BridgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: BridgeErrorKind; detail: string };

export interface RunOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Injectable for tests — no real osascript in CI. */
export type Runner = (
  scriptPath: string,
  args: readonly string[],
  stdinData: string | undefined,
  timeoutMs: number,
) => Promise<RunOutcome>;

export function classifyError(outcome: RunOutcome): BridgeErrorKind {
  if (outcome.timedOut) return 'timeout';
  if (outcome.stderr.includes('-1743')) return 'permission-denied';
  if (outcome.stderr.includes('-1728')) return 'not-found';
  return 'osascript-failed';
}

const defaultRunner: Runner = (scriptPath, args, stdinData, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn('osascript', ['-l', 'JavaScript', scriptPath, ...args], {
      stdio: [stdinData !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    if (stdinData !== undefined && child.stdin) {
      child.stdin.write(stdinData);
      child.stdin.end();
    }
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(err), timedOut });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });

export interface NoteMeta { id: string; mod: string | null }
export interface FetchedNote { id: string; mod?: string; plaintext?: string; error?: string }
export interface ReadNote { id: string; name: string; mod: string; plaintext: string; body: string }
export type FillOutcome = { ok: true; plaintext: string } | { ok: false; conflict: string };

export class NotesBridge {
  constructor(
    private readonly jxaDir: string,
    private readonly runner: Runner = defaultRunner,
    // 6s (was 15s): a wedged osascript BLOCKS the whole poll loop for
    // the full timeout — during a Notes stall the animation freezes for
    // exactly this long. Normal ops are 30-830ms; 6s is still deeply
    // abnormal, and recovery is 2.5x faster.
    private readonly timeoutMs = 6000,
    // Central wedge-evidence hook: EVERY bridge call rides the same
    // Apple Events queue, so any timeout — status, enumeration, fetch,
    // read, or fill — is evidence for the daemon's wedge detector
    // (tick.ts). One hook here beats per-call-site bookkeeping.
    private readonly onTimeout?: () => void,
  ) {}

  private async run<T>(script: string, args: readonly string[] = [], stdinData?: string): Promise<BridgeResult<T>> {
    const scriptPath = path.join(this.jxaDir, script);
    const outcome = await this.runner(scriptPath, args, stdinData, this.timeoutMs);
    if (outcome.code !== 0 || outcome.timedOut) {
      const kind = classifyError(outcome);
      if (kind === 'timeout') this.onTimeout?.();
      return { ok: false, kind, detail: outcome.stderr.trim() || `exit ${outcome.code}` };
    }
    try {
      return { ok: true, value: JSON.parse(outcome.stdout.trim()) as T };
    } catch {
      return { ok: false, kind: 'osascript-failed', detail: `unparseable stdout: ${outcome.stdout.slice(0, 200)}` };
    }
  }

  status(): Promise<BridgeResult<{ running: boolean }>> {
    return this.run('status.js');
  }
  /** `notes` = LIVE notes only — Recently Deleted is excluded at the
   *  source, inside the same osascript call (see jxa/list-notes.js).
   *  `deleted` is returned solely for the daemon's changed-while-
   *  deleted visibility warn; nothing downstream tracks those ids. */
  listNotes(): Promise<BridgeResult<{ notes: NoteMeta[]; deleted?: NoteMeta[] }>> {
    return this.run('list-notes.js');
  }
  fetchPlaintexts(ids: readonly string[]): Promise<BridgeResult<{ notes: FetchedNote[] }>> {
    return this.run('fetch-plaintexts.js', [JSON.stringify(ids)]);
  }
  readNote(id: string): Promise<BridgeResult<ReadNote>> {
    return this.run('read-note.js', [id]);
  }
  fillNote(payload: { noteId: string; expectedBody: string; newBody: string }): Promise<BridgeResult<FillOutcome>> {
    return this.run('fill-note.js', [], JSON.stringify(payload));
  }
  probePermission(): Promise<BridgeResult<{ ok: boolean; running: boolean; folders: number }>> {
    return this.run('probe-permission.js');
  }
}
