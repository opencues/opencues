// popup-client.ts — thin client that hands off the popup PTY to the
// daemon's warm worker.
//
// Lifecycle (one popup):
//   1. tmux runs this script with stdin/stdout/stderr = popup PTY.
//   2. We connect to $OPENCUES_OCEDITD_SOCK and ask for a worker
//      (`BORROW_WORKER` → `{ sockPath, pid }`).
//   3. We connect to the worker's socket and sendmsg() our own fd
//      0/1/2 plus an initial-text payload. The kernel dup's those
//      fds into the worker; the worker dup2's them onto its own
//      0/1/2 and renders into the popup PTY.
//   4. We sit on the worker socket waiting for the result frame
//      ({ ok, buffer, exitCode }). The worker's process.exit fires
//      after sending it.
//   5. We write buffer to --out (mimicking oc-edit's contract) and
//      exit with exitCode.
//
// On ANY failure (no daemon socket, no worker, FD-passing errors,
// timeout) we exit non-zero so the parent script (oc-popup) can fall
// back to spawning oc-edit directly. Same buffer-handling protocol
// downstream — the popup-paste path doesn't change.

import * as net from 'node:net';
import * as fs from 'node:fs';
import { sendFds, setBlocking, restoreFlags } from './scm-rights';

interface Args {
  outputPath: string | null;
  initialText: string;
}

function parseArgs(argv: string[]): Args {
  let outputPath: string | null = null;
  let initialText = '';
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '-o') { outputPath = argv[++i] ?? null; }
    else if (a === '--initial' || a === '-i') { initialText = argv[++i] ?? ''; }
  }
  return { outputPath, initialText };
}

function writeFrame(sockFd: number, obj: unknown): void {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  const out = Buffer.concat([head, body]);
  fs.writeSync(sockFd, out, 0, out.length);
}

function readFrame(sock: net.Socket, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let needed = -1;
    let received = 0;
    const timer = setTimeout(() => { cleanup(); reject(new Error('read timeout')); }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      received += chunk.length;
      if (needed < 0 && received >= 4) {
        const head = Buffer.concat(chunks);
        needed = head.readUInt32BE(0);
        if (needed < 0 || needed > 32 * 1024 * 1024) {
          cleanup(); reject(new Error(`bad frame size ${needed}`)); return;
        }
      }
      if (needed >= 0 && received >= needed + 4) {
        const all = Buffer.concat(chunks);
        const body = all.slice(4, 4 + needed).toString('utf8');
        cleanup();
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      }
    };
    const onErr = (e: Error): void => { cleanup(); reject(e); };
    const onEnd = (): void => { cleanup(); reject(new Error('socket closed')); };
    const cleanup = (): void => {
      clearTimeout(timer);
      sock.off('data', onData);
      sock.off('error', onErr);
      sock.off('end', onEnd);
    };
    sock.on('data', onData);
    sock.on('error', onErr);
    sock.on('end', onEnd);
  });
}

async function rpcDaemon(daemonSock: string, msg: unknown, timeoutMs = 1500): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(daemonSock);
    const t = setTimeout(() => { try { sock.destroy(); } catch {}; reject(new Error('daemon timeout')); }, timeoutMs);
    sock.once('error', (e) => { clearTimeout(t); reject(e); });
    sock.once('connect', async () => {
      try {
        const body = Buffer.from(JSON.stringify(msg), 'utf8');
        const head = Buffer.alloc(4);
        head.writeUInt32BE(body.length, 0);
        sock.write(head); sock.write(body);
        const reply = await readFrame(sock, timeoutMs);
        clearTimeout(t);
        try { sock.end(); } catch {}
        resolve(reply);
      } catch (e) { clearTimeout(t); reject(e); }
    });
  });
}

function getSocketFd(sock: net.Socket): number {
  const handle: any = (sock as any)._handle;
  const fd = handle?.fd;
  if (typeof fd !== 'number') throw new Error('no _handle.fd on socket');
  return fd;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const daemonSock = process.env.OPENCUES_OCEDITD_SOCK;
  if (!daemonSock) { process.exit(2); }  // signal: no daemon, parent should fallback

  // 1. Borrow a worker.
  const reply = await rpcDaemon(daemonSock, { cmd: 'BORROW_WORKER' }) as
    { ok?: boolean; sockPath?: string; error?: string };
  if (!reply.ok || !reply.sockPath) {
    process.stderr.write(`[oc-popup-client] borrow failed: ${reply.error ?? 'unknown'}\n`);
    process.exit(3);
  }

  // 2. Connect to worker + send our fd 0/1/2 + initial-text payload.
  const worker = net.createConnection(reply.sockPath);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('worker connect timeout')), 1500);
    worker.once('connect', () => { clearTimeout(t); resolve(); });
    worker.once('error', (e) => { clearTimeout(t); reject(e); });
  });
  const workerFd = getSocketFd(worker);
  worker.pause();

  const payload = JSON.stringify({
    initialText: args.initialText,
    cwd: process.cwd(),
  });
  sendFds(workerFd, [0, 1, 2], new TextEncoder().encode(payload));

  // 3. Block-read the result frame. Worker's onSubmit writes a single
  //    framed JSON object then exits.
  const prevFlags = setBlocking(workerFd);
  try {
    // Read the 4-byte length header first.
    const head = Buffer.alloc(4);
    let off = 0;
    while (off < 4) {
      const n = fs.readSync(workerFd, head, off, 4 - off, null);
      if (n === 0) throw new Error('worker closed before header');
      off += n;
    }
    const needed = head.readUInt32BE(0);
    if (needed > 32 * 1024 * 1024) throw new Error(`bad frame size ${needed}`);
    const body = Buffer.alloc(needed);
    off = 0;
    while (off < needed) {
      const n = fs.readSync(workerFd, body, off, needed - off, null);
      if (n === 0) throw new Error('worker closed before body');
      off += n;
    }
    restoreFlags(workerFd, prevFlags);
    const reply2 = JSON.parse(body.toString('utf8')) as { ok?: boolean; buffer?: string; exitCode?: number; error?: string };
    try { worker.destroy(); } catch {}

    if (!reply2.ok) {
      process.stderr.write(`[oc-popup-client] worker error: ${reply2.error ?? 'unknown'}\n`);
      process.exit(4);
    }
    if (args.outputPath && reply2.buffer) {
      fs.writeFileSync(args.outputPath, reply2.buffer);
    } else if (reply2.buffer) {
      process.stdout.write(reply2.buffer + '\n');
    }
    process.exit(reply2.exitCode ?? 0);
  } catch (e) {
    restoreFlags(workerFd, prevFlags);
    process.stderr.write(`[oc-popup-client] read failed: ${(e as Error).message}\n`);
    process.exit(5);
  }
}

main().catch((err) => {
  process.stderr.write(`[oc-popup-client] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
