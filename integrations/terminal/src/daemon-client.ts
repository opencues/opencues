// daemon-client.ts — popup-side client for the oc-editd snapshot socket.
//
// Used by bootstrap.ts at startup. If $OPENCUES_OCEDITD_SOCK is set,
// connect + fetch the pre-built snapshot synchronously (via top-level
// await) before the runtime boots. The snapshot is then plumbed into
// the adapter's readFile/readDir overrides so ConfigLoader hits a
// hot cache instead of the disk.
//
// Failure is silent: any error here downgrades to the direct-fs path
// (which is what bootstrap.ts already does). The daemon is a perf
// feature, not a correctness one.

import * as net from 'node:net';

export interface DaemonSnapshot {
  files: Record<string, string | null>;
  dirs: Record<string, ReadonlyArray<{ name: string; isDirectory: boolean }> | null>;
  version: number;
  builtAt: number;
}

function writeFrame(sock: net.Socket, obj: unknown): void {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  sock.write(head);
  sock.write(body);
}

function readFrame(sock: net.Socket, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let needed = -1;
    let received = 0;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('daemon read timeout'));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      received += chunk.length;
      if (needed < 0 && received >= 4) {
        const head = Buffer.concat(chunks);
        needed = head.readUInt32BE(0);
        if (needed < 0 || needed > 32 * 1024 * 1024) {
          cleanup();
          reject(new Error(`daemon: oversized frame (${needed} bytes)`));
          return;
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
    const onEnd = (): void => { cleanup(); reject(new Error('daemon closed before frame complete')); };
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

/**
 * Connect to the daemon, request a snapshot, return it. Resolves null
 * on any failure — callers should treat that as "daemon unavailable,
 * use direct fs".
 */
export async function fetchSnapshot(sockPath: string, timeoutMs = 1500): Promise<DaemonSnapshot | null> {
  return new Promise((resolve) => {
    let settled = false;
    const sock = net.createConnection(sockPath);
    const connectTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      resolve(null);
    }, timeoutMs);

    sock.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      resolve(null);
    });

    sock.once('connect', async () => {
      clearTimeout(connectTimer);
      try {
        writeFrame(sock, { cmd: 'GET_SNAPSHOT' });
        const reply = await readFrame(sock, timeoutMs) as { ok?: boolean; snapshot?: DaemonSnapshot; error?: string };
        if (!settled) {
          settled = true;
          if (reply?.ok && reply.snapshot) resolve(reply.snapshot);
          else resolve(null);
        }
      } catch {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      } finally {
        try { sock.end(); } catch {}
      }
    });
  });
}

/**
 * In-memory accessor for a fetched snapshot. Returns hit/miss so the
 * caller can fall through to the real fs on a miss.
 */
export class SnapshotCache {
  constructor(private readonly snap: DaemonSnapshot) {}

  readFile(absPath: string): { hit: true; content: string | null } | { hit: false } {
    if (Object.prototype.hasOwnProperty.call(this.snap.files, absPath)) {
      return { hit: true, content: this.snap.files[absPath] ?? null };
    }
    return { hit: false };
  }

  readDir(absPath: string): { hit: true; entries: ReadonlyArray<{ name: string; isDirectory: boolean }> | null } | { hit: false } {
    if (Object.prototype.hasOwnProperty.call(this.snap.dirs, absPath)) {
      return { hit: true, entries: this.snap.dirs[absPath] ?? null };
    }
    return { hit: false };
  }

  get version(): number { return this.snap.version; }
  get builtAt(): number { return this.snap.builtAt; }
}
