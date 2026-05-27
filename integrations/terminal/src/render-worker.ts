// render-worker.ts — pre-warmed bun process that renders ONE popup.
//
// Daemon (oc-editd) spawns one of these eagerly so a warm process is
// always ready. When a popup connects, the worker:
//
//   1. accept() the popup's connection (over its own per-worker socket)
//   2. recvmsg() to extract popup's stdin/stdout/stderr fds + the
//      initial-text JSON payload (SCM_RIGHTS)
//   3. dup2() the popup's fds onto our own 0/1/2 — opentui now sees
//      the popup PTY as if it owned it
//   4. render(<App />) — same component oc-edit runs, but with an
//      onSubmit callback that sends the committed buffer back over
//      the connection socket instead of writing to stdout/file
//   5. process.exit() — daemon has already spawned a replacement
//
// All slow work (@opentui/core, @opencues/runtime, ConfigLoader, blanks
// registry, daemon snapshot fetch) happens at module load BEFORE the
// popup arrives. The popup pays only socket round-trip + dup2 + render
// initialisation (~50-150ms target).

// IMPORTANT: imports stay at the top so heavy modules load
// during worker spawn, not when the popup connects.
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, render } from './app';
import { recvFds, setBlocking, restoreFlags, dup2 as ffiDup2, closeFd } from './scm-rights';

// Importing bootstrap.ts also runs its top-level await (daemon snapshot
// fetch). It does NOT render — startOpenCues() is called inside <App>
// on mount. So this is warm setup only.
import './bootstrap';

interface HandoffPayload {
  initialText?: string;
  /** User's calling cwd — bootstrap.ts already reads OPENCUES_USER_CWD
   *  at module load, but a popup may pass an override (e.g. when the
   *  shell cwd has changed since the worker was spawned). */
  cwd?: string;
}

// ─── Worker startup ────────────────────────────────────────────────────

const runtimeDir = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
const sockPath = process.env.OPENCUES_WORKER_SOCK
  ?? path.join(runtimeDir, `oc-worker-${process.pid}.sock`);

const LOG_PATH = '/tmp/oc-editd.log';
function log(msg: string): void {
  try { fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}][worker ${process.pid}] ${msg}\n`); } catch {}
}

function getSocketFd(sock: net.Socket): number {
  const handle: any = (sock as any)._handle;
  const fd = handle?.fd;
  if (typeof fd !== 'number') throw new Error('no _handle.fd on socket');
  return fd;
}

function writeFrame(sockFd: number, obj: unknown): void {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  // Combine into one write — Linux send returns after copying to
  // kernel buffer; an interleaved partial write here would be ours
  // to handle, but for <64KB messages it's effectively atomic.
  const out = Buffer.concat([head, body]);
  fs.writeSync(sockFd, out, 0, out.length);
}

// Module-scope so runRender (called from inside the connection handler)
// can see the popup connection fd via closure on the next tick.
let popupConnFd: number = -1;

async function main(): Promise<void> {
  // Clean any stale socket from a previous worker that crashed.
  try { fs.unlinkSync(sockPath); } catch {}

  let handled = false;

  const server = net.createServer((conn) => {
    if (handled) {
      try { conn.destroy(); } catch {}
      return;
    }
    handled = true;
    try {
      popupConnFd = getSocketFd(conn);
      conn.pause();
      const prevFlags = setBlocking(popupConnFd);
      const r = recvFds(popupConnFd, 4, 8192);
      restoreFlags(popupConnFd, prevFlags);
      if (!r) throw new Error('recvFds returned null (peer closed)');
      log(`received ${r.fds.length} fds, payload=${r.payload.length} bytes`);
      if (r.fds.length < 3) throw new Error(`expected 3 fds, got ${r.fds.length}`);

      // Parse initial-text payload.
      let payload: HandoffPayload = {};
      try {
        const txt = new TextDecoder().decode(r.payload);
        payload = JSON.parse(txt);
      } catch (e) { log(`payload parse failed: ${(e as Error).message}`); }

      // Take over the popup's PTY. SCM_RIGHTS gave us NEW fds (kernel
      // dup'd the open file descriptions); dup2 these onto our own
      // 0/1/2 so anything that uses stdio (opentui, console, etc.) now
      // hits the popup PTY.
      const [popStdin, popStdout, popStderr] = r.fds;
      ffiDup2(popStdin!, 0);
      ffiDup2(popStdout!, 1);
      ffiDup2(popStderr!, 2);
      // Now safe to close the originals — kernel keeps the open file
      // description alive as long as 0/1/2 reference it.
      closeFd(popStdin!);
      closeFd(popStdout!);
      closeFd(popStderr!);
      log('dup2 complete, launching render');

      // We're now writing into the popup PTY. Kick off the render.
      // The onSubmit callback sends the buffer back over the popup
      // connection socket (popupConnFd) — NOT through stdout, which
      // is now the popup PTY.
      runRender(payload.initialText ?? '');
    } catch (e) {
      const err = e as Error;
      log(`fatal in connection handler: ${err.message}`);
      try {
        if (popupConnFd >= 0) {
          writeFrame(popupConnFd, { ok: false, error: err.message });
        }
      } catch {}
      try { conn.destroy(); } catch {}
      setTimeout(() => process.exit(1), 50);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => resolve());
  });
  try { fs.chmodSync(sockPath, 0o600); } catch {}
  log(`listening on ${sockPath}`);

  // Signal readiness on fd 3 (daemon set up a pipe there at spawn).
  // stdout is unusable for IPC — opentui's preload writes alt-screen
  // sequences to it at module load. fd 3 is clean.
  try {
    const readyMsg = JSON.stringify({ ready: true, sockPath, pid: process.pid }) + '\n';
    fs.writeSync(3, Buffer.from(readyMsg, 'utf8'));
  } catch (e) {
    log(`failed to signal ready on fd 3: ${(e as Error).message}`);
  }

  // Lifecycle cleanup.
  const cleanup = (): void => {
    try { server.close(); } catch {}
    try { fs.unlinkSync(sockPath); } catch {}
  };
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('exit', cleanup);
}

function runRender(initialText: string): void {
  // Render the same App that oc-edit uses. The onSubmit callback fires
  // on Ctrl+Alt+S / Ctrl+Alt+Q and supplies the final buffer.
  const handleSubmit = (text: string, exitCode: number): void => {
    log(`submit (exitCode=${exitCode}, ${text.length} chars)`);
    try {
      if (popupConnFd >= 0) {
        writeFrame(popupConnFd, { ok: true, buffer: text, exitCode });
      }
    } catch (e) {
      log(`send buffer failed: ${(e as Error).message}`);
    }
    // Give the kernel a tick to flush the write before we exit.
    setTimeout(() => process.exit(0), 20);
  };

  // render() is async (resolves when the renderer is destroyed).
  render(() => App({ initialText, outputPath: null, onSubmit: handleSubmit })).catch((err: unknown) => {
    log(`render error: ${(err as Error).message}`);
    process.exit(1);
  });
}

main().catch((err) => {
  log(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
