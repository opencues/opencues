// Tests for daemon.ts — the oc-editd pre-load daemon.
//
// daemon.ts is a standalone script: it parses argv/env at module
// load, then calls `main()` UNCONDITIONALLY at the bottom of the
// file (no `if (require.main === module)` guard). Importing it for
// real would start a real unix-socket server, a real fs.watch tree,
// and real file I/O. To make it safe to import under vitest, every
// I/O surface it touches (`node:net`, `node:fs`, `node:fs/promises`)
// is mocked below against an in-memory virtual filesystem (stashed on
// globalThis so the mock factories — which vitest hoists above this
// file's own top-level statements — can read/write it without a TDZ
// problem). This also lets us verify buildSnapshot/walkConfigTree
// indirectly by inspecting what the served GET_SNAPSHOT payload
// contains, since none of the daemon's internal functions are
// exported (it's a script, not a library module).
//
// We do NOT exercise main()'s SIGTERM/SIGINT/SIGHUP cleanup path (it
// calls process.exit, which would kill the vitest worker) — those
// handlers get registered but are never invoked here.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';

// The factory below must not reference the outer `EventEmitter`
// import directly — vitest hoists vi.mock() calls above every
// top-level import in the file, so any imported binding it closes
// over is still in the TDZ when the (lazily-invoked) factory runs.
// Importing node:events fresh inside the async factory sidesteps that.
vi.mock('node:net', async () => {
  const { EventEmitter: FactoryEventEmitter } = await import('node:events');
  class FakeServer extends FactoryEventEmitter {
    listen(_path: string, cb: () => void) {
      queueMicrotask(cb);
      return this;
    }
    close() { /* no-op */ }
  }
  return {
    createServer: (handler: (sock: any) => void) => {
      (globalThis as any).__ocEditdCapturedHandler = handler;
      const srv = new FakeServer();
      (globalThis as any).__ocEditdCapturedServer = srv;
      return srv;
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false), // never start a real fs.watch
    unlinkSync: vi.fn(() => { /* no-op: no real socket file to remove */ }),
    chmodSync: vi.fn(() => { /* no-op */ }),
    appendFileSync: vi.fn(() => { /* swallow log writes */ }),
    watch: vi.fn(() => ({ close: vi.fn() })),
  };
});

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    const state = (globalThis as any).__ocEditdFsState ?? { files: {}, dirs: {} };
    if (Object.prototype.hasOwnProperty.call(state.files, p)) return state.files[p];
    const err: any = new Error(`ENOENT: ${p}`);
    err.code = 'ENOENT';
    throw err;
  }),
  readdir: vi.fn(async (p: string, _opts: unknown) => {
    const state = (globalThis as any).__ocEditdFsState ?? { files: {}, dirs: {} };
    const names: string[] | undefined = state.dirs[p];
    if (!names) {
      const err: any = new Error(`ENOENT: ${p}`);
      err.code = 'ENOENT';
      throw err;
    }
    const dirNames: Set<string> = state.dirNames ?? new Set();
    return names.map((name) => ({ name, isDirectory: () => dirNames.has(name) }));
  }),
}));

// Directory entries are named plainly (no trailing-slash marker —
// path.join() on Windows PRESERVES a trailing slash, e.g.
// path.join('a','legal/') -> 'a\\legal\\', which would silently
// diverge from a same-looking 'a\\legal' dirs-map key). Instead,
// `dirNames` explicitly lists which entries in a given directory are
// themselves directories.
type VirtualFs = { files: Record<string, string>; dirs: Record<string, string[]>; dirNames?: Set<string> };

function setVirtualFs(state: VirtualFs): void {
  (globalThis as any).__ocEditdFsState = state;
}

function frame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

class FakeSocket extends EventEmitter {
  written: Buffer[] = [];
  write(chunk: Buffer): boolean { this.written.push(chunk); return true; }
  end(): void { /* no-op */ }
  writtenObjects(): unknown[] {
    const all = Buffer.concat(this.written);
    const out: unknown[] = [];
    let offset = 0;
    while (offset < all.length) {
      const len = all.readUInt32BE(offset);
      const body = all.slice(offset + 4, offset + 4 + len).toString('utf8');
      out.push(JSON.parse(body));
      offset += 4 + len;
    }
    return out;
  }
}

/** Boots daemon.ts fresh against a virtual filesystem and returns the
 *  captured net.createServer connection handler once main() has
 *  progressed far enough to register it. */
async function bootDaemon(state: VirtualFs): Promise<(sock: any) => void> {
  setVirtualFs(state);
  delete (globalThis as any).__ocEditdCapturedHandler;
  delete (globalThis as any).__ocEditdCapturedServer;
  vi.resetModules();
  await import('./daemon');
  for (let i = 0; i < 40; i++) {
    if ((globalThis as any).__ocEditdCapturedHandler) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  const handler = (globalThis as any).__ocEditdCapturedHandler as (sock: any) => void;
  expect(handler).toBeTypeOf('function');
  return handler;
}

describe('daemon.ts — HELLO / GET_SNAPSHOT / unknown-cmd protocol', () => {
  const ORIGINAL_ENV = { ...process.env };
  let openCuesHome: string;

  beforeEach(() => {
    openCuesHome = path.join(require('node:os').tmpdir(), 'virtual-cues-home');
    process.env['OPENCUES_HOME'] = openCuesHome;
    process.env['OPENCUES_USER_CWD'] = path.join(require('node:os').tmpdir(), 'virtual-cwd');
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it('replies ok:true with pid + version on HELLO', async () => {
    const handler = await bootDaemon({ files: {}, dirs: {} });
    const sock = new FakeSocket();
    handler(sock);
    sock.emit('data', frame({ cmd: 'HELLO' }));
    await new Promise((r) => setTimeout(r, 10));
    const [reply] = sock.writtenObjects() as any[];
    expect(reply.ok).toBe(true);
    expect(typeof reply.pid).toBe('number');
  });

  it('serves the built snapshot on GET_SNAPSHOT, reflecting mocked OPENCUES.md content', async () => {
    const openCuesPath = path.join(openCuesHome, 'OPENCUES.md');
    const handler = await bootDaemon({
      files: { [openCuesPath]: 'voice-mode: off\n' },
      dirs: {},
    });
    const sock = new FakeSocket();
    handler(sock);
    sock.emit('data', frame({ cmd: 'GET_SNAPSHOT' }));
    await new Promise((r) => setTimeout(r, 20));
    const [reply] = sock.writtenObjects() as any[];
    expect(reply.ok).toBe(true);
    expect(reply.snapshot.files[openCuesPath]).toBe('voice-mode: off\n');
    expect(reply.snapshot.version).toBeGreaterThan(0);
  });

  it('reports a null file entry for a config file that does not exist (walked, not omitted)', async () => {
    const handler = await bootDaemon({ files: {}, dirs: {} });
    const sock = new FakeSocket();
    handler(sock);
    sock.emit('data', frame({ cmd: 'GET_SNAPSHOT' }));
    await new Promise((r) => setTimeout(r, 20));
    const [reply] = sock.writtenObjects() as any[];
    const openCuesPath = path.join(openCuesHome, 'OPENCUES.md');
    expect(reply.snapshot.files[openCuesPath]).toBeNull();
  });

  it('replies ok:false for an unknown command', async () => {
    const handler = await bootDaemon({ files: {}, dirs: {} });
    const sock = new FakeSocket();
    handler(sock);
    sock.emit('data', frame({ cmd: 'NOT_A_REAL_COMMAND' }));
    await new Promise((r) => setTimeout(r, 10));
    const [reply] = sock.writtenObjects() as any[];
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('unknown cmd');
  });

  it('replies ok:false (not a thrown/unhandled error) for a malformed frame body', async () => {
    const handler = await bootDaemon({ files: {}, dirs: {} });
    const sock = new FakeSocket();
    handler(sock);
    const badBody = Buffer.from('not json', 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32BE(badBody.length, 0);
    sock.emit('data', Buffer.concat([head, badBody]));
    await new Promise((r) => setTimeout(r, 10));
    const [reply] = sock.writtenObjects() as any[];
    expect(reply.ok).toBe(false);
  });

  it('walks nested cues/ subdirectories into the snapshot', async () => {
    const cuesSubdir = path.join(openCuesHome, 'cues');
    const packDir = path.join(cuesSubdir, 'concise');
    const cueMdPath = path.join(packDir, 'CUE.md');
    const handler = await bootDaemon({
      files: { [cueMdPath]: '---\nname: concise\n---\n' },
      dirs: {
        [cuesSubdir]: ['concise'],
        [packDir]: ['CUE.md'],
      },
      dirNames: new Set(['concise']),
    });
    const sock = new FakeSocket();
    handler(sock);
    sock.emit('data', frame({ cmd: 'GET_SNAPSHOT' }));
    await new Promise((r) => setTimeout(r, 20));
    const [reply] = sock.writtenObjects() as any[];
    expect(reply.snapshot.files[cueMdPath]).toBe('---\nname: concise\n---\n');
    expect(reply.snapshot.dirs[cuesSubdir]).toEqual([{ name: 'concise', isDirectory: true }]);
  });

  it('two concurrent connections both get correctly-framed independent replies', async () => {
    const handler = await bootDaemon({ files: {}, dirs: {} });
    const sockA = new FakeSocket();
    const sockB = new FakeSocket();
    handler(sockA);
    handler(sockB);
    sockA.emit('data', frame({ cmd: 'HELLO' }));
    sockB.emit('data', frame({ cmd: 'NOT_A_REAL_COMMAND' }));
    await new Promise((r) => setTimeout(r, 10));
    expect((sockA.writtenObjects()[0] as any).ok).toBe(true);
    expect((sockB.writtenObjects()[0] as any).ok).toBe(false);
  });
});
