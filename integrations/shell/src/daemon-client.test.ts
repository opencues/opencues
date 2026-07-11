// Tests for daemon-client.ts — the oc-editd popup-side snapshot
// client used by bootstrap.ts. Runs under vitest/Node; nothing here
// touches a real unix socket — `node:net` is mocked so we can drive
// the connect/data/error/timeout paths deterministically.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:net', () => {
  return { createConnection: vi.fn() };
});

import * as net from 'node:net';
import { fetchSnapshot, SnapshotCache } from './daemon-client';

/** A minimal fake net.Socket: an EventEmitter with a spy-able write(). */
class FakeSocket extends EventEmitter {
  written: Buffer[] = [];
  destroyed = false;
  write(chunk: Buffer): boolean {
    this.written.push(chunk);
    return true;
  }
  destroy(): void {
    this.destroyed = true;
  }
  end(): void { /* no-op */ }
}

function frame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

describe('fetchSnapshot', () => {
  let sock: FakeSocket;

  beforeEach(() => {
    sock = new FakeSocket();
    (net.createConnection as any).mockReturnValue(sock);
  });

  it('resolves the snapshot on a well-formed GET_SNAPSHOT reply', async () => {
    const snapshot = { files: { '/a': 'A' }, dirs: {}, version: 3, builtAt: 123 };
    const promise = fetchSnapshot('/tmp/fake.sock', 1000);
    sock.emit('connect');
    // Allow the async 'connect' handler's writeFrame call to run.
    await Promise.resolve();
    sock.emit('data', frame({ ok: true, snapshot }));
    const result = await promise;
    expect(result).toEqual(snapshot);
  });

  it('writes a single GET_SNAPSHOT frame on connect', async () => {
    const promise = fetchSnapshot('/tmp/fake.sock', 1000);
    sock.emit('connect');
    await Promise.resolve();
    sock.emit('data', frame({ ok: true, snapshot: { files: {}, dirs: {}, version: 1, builtAt: 1 } }));
    await promise;
    expect(sock.written.length).toBeGreaterThan(0);
    // First 4 bytes are the length header; the rest should parse as
    // { cmd: 'GET_SNAPSHOT' }.
    const all = Buffer.concat(sock.written);
    const len = all.readUInt32BE(0);
    const body = JSON.parse(all.slice(4, 4 + len).toString('utf8'));
    expect(body).toEqual({ cmd: 'GET_SNAPSHOT' });
  });

  it('resolves null when the connection errors', async () => {
    const promise = fetchSnapshot('/tmp/fake.sock', 1000);
    sock.emit('error', new Error('ECONNREFUSED'));
    await expect(promise).resolves.toBeNull();
  });

  it('resolves null when the reply has ok:false', async () => {
    const promise = fetchSnapshot('/tmp/fake.sock', 1000);
    sock.emit('connect');
    await Promise.resolve();
    sock.emit('data', frame({ ok: false, error: 'nope' }));
    await expect(promise).resolves.toBeNull();
  });

  it('resolves null when the reply is missing the snapshot field', async () => {
    const promise = fetchSnapshot('/tmp/fake.sock', 1000);
    sock.emit('connect');
    await Promise.resolve();
    sock.emit('data', frame({ ok: true }));
    await expect(promise).resolves.toBeNull();
  });

  it('resolves null on a malformed (non-JSON) frame body', async () => {
    const promise = fetchSnapshot('/tmp/fake.sock', 1000);
    sock.emit('connect');
    await Promise.resolve();
    const bad = Buffer.from('not json', 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32BE(bad.length, 0);
    sock.emit('data', Buffer.concat([head, bad]));
    await expect(promise).resolves.toBeNull();
  });

  it('resolves null on an oversized frame (protects against a runaway length header)', async () => {
    const promise = fetchSnapshot('/tmp/fake.sock', 1000);
    sock.emit('connect');
    await Promise.resolve();
    const head = Buffer.alloc(4);
    head.writeUInt32BE(64 * 1024 * 1024, 0); // over the 32MB cap
    sock.emit('data', head);
    await expect(promise).resolves.toBeNull();
  });

  it('resolves null when the socket closes before a full frame arrives', async () => {
    const promise = fetchSnapshot('/tmp/fake.sock', 1000);
    sock.emit('connect');
    await Promise.resolve();
    sock.emit('end');
    await expect(promise).resolves.toBeNull();
  });

  it('assembles a frame delivered across multiple data chunks', async () => {
    const snapshot = { files: {}, dirs: {}, version: 7, builtAt: 999 };
    const full = frame({ ok: true, snapshot });
    const promise = fetchSnapshot('/tmp/fake.sock', 1000);
    sock.emit('connect');
    await Promise.resolve();
    // Split the frame awkwardly: 2 bytes of the length header, then
    // the rest, then the body in two pieces.
    sock.emit('data', full.slice(0, 2));
    sock.emit('data', full.slice(2, 6));
    sock.emit('data', full.slice(6, 10));
    sock.emit('data', full.slice(10));
    const result = await promise;
    expect(result).toEqual(snapshot);
  });

  it('resolves null on connect timeout (default 1500ms honoured, explicit timeout used here)', async () => {
    vi.useFakeTimers();
    try {
      const promise = fetchSnapshot('/tmp/fake.sock', 50);
      // Never emit 'connect' — let the connect timer fire.
      vi.advanceTimersByTime(60);
      await expect(promise).resolves.toBeNull();
      expect(sock.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves null on a post-connect read timeout', async () => {
    vi.useFakeTimers();
    try {
      const promise = fetchSnapshot('/tmp/fake.sock', 50);
      sock.emit('connect');
      // Never emit 'data' — readFrame's internal timer should fire.
      await vi.advanceTimersByTimeAsync(60);
      await expect(promise).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SnapshotCache', () => {
  const snap = {
    files: { '/a/b.md': 'content', '/a/missing.md': null },
    dirs: {
      '/a': [{ name: 'b.md', isDirectory: false }],
      '/a/empty': null,
    },
    version: 5,
    builtAt: 1700000000000,
  };

  it('readFile: hit with content', () => {
    const cache = new SnapshotCache(snap);
    expect(cache.readFile('/a/b.md')).toEqual({ hit: true, content: 'content' });
  });

  it('readFile: hit with null content (daemon checked and file was absent)', () => {
    const cache = new SnapshotCache(snap);
    expect(cache.readFile('/a/missing.md')).toEqual({ hit: true, content: null });
  });

  it('readFile: miss for a path the daemon never walked', () => {
    const cache = new SnapshotCache(snap);
    expect(cache.readFile('/never/walked')).toEqual({ hit: false });
  });

  it('readDir: hit with entries', () => {
    const cache = new SnapshotCache(snap);
    expect(cache.readDir('/a')).toEqual({ hit: true, entries: [{ name: 'b.md', isDirectory: false }] });
  });

  it('readDir: hit with null entries (unreadable dir)', () => {
    const cache = new SnapshotCache(snap);
    expect(cache.readDir('/a/empty')).toEqual({ hit: true, entries: null });
  });

  it('readDir: miss for an unknown path', () => {
    const cache = new SnapshotCache(snap);
    expect(cache.readDir('/nope')).toEqual({ hit: false });
  });

  it('exposes version and builtAt', () => {
    const cache = new SnapshotCache(snap);
    expect(cache.version).toBe(5);
    expect(cache.builtAt).toBe(1700000000000);
  });

  it('does not confuse Object.prototype properties with real snapshot keys', () => {
    const cache = new SnapshotCache(snap);
    // hasOwnProperty guard should mean 'toString' (inherited from
    // Object.prototype) is correctly reported as a miss.
    expect(cache.readFile('toString')).toEqual({ hit: false });
  });
});
