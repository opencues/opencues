// scm-test.ts — isolated test harness for src/scm-rights.ts.
//
// Smallest possible test of FD-passing over a unix socket.
//
//   parent (listener):
//     1. Open a tmp file for writing → fd N
//     2. Listen on a unix socket
//     3. Spawn a child bun that connects + sendmsg's fd N (which the
//        parent has dup'd into the child via stdio inheritance)
//     4. On 'connection', flip the socket fd to blocking, recvmsg,
//        write "hello scm-rights\n" through the received fd, close
//   parent verifies:
//     The file contains "hello scm-rights\n"
//
// Two processes are required: blocking recvmsg in the same event loop
// as the corresponding sendmsg would deadlock (the listener never
// returns to the event loop, so the client's send never fires).

import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { sendFds, recvFds, closeFd, setBlocking, restoreFlags } from '../src/scm-rights';

const __filename = new URL(import.meta.url).pathname;
const __dirname = path.dirname(__filename);

// ─── Child mode ────────────────────────────────────────────────────────

if (process.argv[2] === '--child') {
  const sockPath = process.argv[3]!;
  // Parent passes the fd to send as stdio[3], so in the child's view
  // it's always fd 3 (Node convention).
  const fdNum = 3;
  const client = net.createConnection(sockPath);
  await new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('error', reject);
  });
  const handle: any = (client as any)._handle;
  const sockFd = handle.fd as number;
  client.pause();
  const sent = sendFds(sockFd, [fdNum], new TextEncoder().encode('HANDOFF'));
  console.error(`child: sent ${sent} bytes + fd=${fdNum} via sock=${sockFd}`);
  // Give the parent time to read before we exit (close would propagate
  // and racing recvmsg can see EOF).
  await new Promise((r) => setTimeout(r, 50));
  process.exit(0);
}

// ─── Parent mode ───────────────────────────────────────────────────────

const sockPath = `/tmp/scm-test-${process.pid}.sock`;
const filePath = `/tmp/scm-test-${process.pid}.out`;
try { fs.unlinkSync(sockPath); } catch {}
try { fs.unlinkSync(filePath); } catch {}

function getSocketFd(sock: net.Socket): number {
  const handle: any = (sock as any)._handle;
  const fd = handle?.fd;
  if (typeof fd !== 'number') throw new Error('no _handle.fd on socket');
  return fd;
}

async function main(): Promise<void> {
  const fileFd = fs.openSync(filePath, 'w');
  console.error(`parent: opened ${filePath} as fd=${fileFd}`);

  let listenerDone = false;
  let listenerError: Error | null = null;
  const server = net.createServer((conn) => {
    try {
      const connFd = getSocketFd(conn);
      conn.pause();
      const prevFlags = setBlocking(connFd);
      const r = recvFds(connFd, 4, 256);
      restoreFlags(connFd, prevFlags);
      if (!r) throw new Error('recvFds returned null (peer closed)');
      console.error(`parent: received ${r.fds.length} fds, payload="${new TextDecoder().decode(r.payload)}"`);
      if (r.fds.length !== 1) throw new Error(`expected 1 fd, got ${r.fds.length}`);
      const peerFd = r.fds[0]!;
      const buf = Buffer.from('hello scm-rights\n', 'utf8');
      const n = fs.writeSync(peerFd, buf, 0, buf.length);
      console.error(`parent: wrote ${n} bytes via received fd ${peerFd}`);
      closeFd(peerFd);
      conn.end();
    } catch (e) {
      listenerError = e as Error;
    } finally {
      listenerDone = true;
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => resolve());
  });
  console.error(`parent: listening on ${sockPath}`);

  // Spawn the child, inheriting fileFd. Bun gives us the same fd
  // number in the child via stdio: ['inherit', 'inherit', 'inherit', fileFd]
  const childPath = __filename;
  const child = spawn('bun', [childPath, '--child', sockPath], {
    stdio: ['inherit', 'inherit', 'inherit', fileFd],
  });
  child.on('error', (e) => { console.error('child spawn error:', e); });
  child.on('exit', (code) => { console.error(`child exited code=${code}`); });

  // Wait for listener to finish.
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      if (listenerDone) { clearInterval(poll); resolve(); }
    }, 5);
  });

  fs.closeSync(fileFd);
  server.close();
  try { fs.unlinkSync(sockPath); } catch {}

  if (listenerError) {
    console.error(`FAIL in listener: ${listenerError.message}`);
    try { fs.unlinkSync(filePath); } catch {}
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  try { fs.unlinkSync(filePath); } catch {}

  if (content === 'hello scm-rights\n') {
    console.error('PASS — fd-passing round trip verified');
    process.exit(0);
  } else {
    console.error(`FAIL — file content: ${JSON.stringify(content)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('main threw:', err);
  try { fs.unlinkSync(sockPath); } catch {}
  try { fs.unlinkSync(filePath); } catch {}
  process.exit(1);
});
