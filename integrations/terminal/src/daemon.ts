// oc-editd — partial daemon for the oc-shell terminal integration.
//
// Background process spawned by `bin/oc-shell`. Pre-reads every config
// file the runtime would otherwise hit per popup (~/.cues/OPENCUES.md,
// USER.md, CUES.md, BLANKS.md, AUDITORS.md, cues/**, blanks/**,
// auditors/**) and serves them over a unix socket. The popup's
// bootstrap consults the snapshot before falling through to the real
// filesystem, so the popup pays no file-I/O cost on the hot path and
// — once the snapshot is in memory — no syscall per read.
//
// This is "Option B" from DAEMON-PLAN.md: no FD passing. @opentui/core
// (~300ms) still loads per popup; we save the file-I/O + parsing-misc
// budget but not the JS module load. See DAEMON-PLAN.md § "What was
// tried and ruled out" #7 for the trade-off.
//
// Lifecycle:
//   - Spawned by bin/oc-shell before the tmux session starts.
//   - Listens on $OPENCUES_OCEDITD_SOCK (also passed to popups via env).
//   - Watches ~/.cues/ + (if it exists) <user-cwd>/.cues/ for changes;
//     re-reads on debounce. The popup sees fresh data on every fetch.
//   - SIGTERM (from oc-shell's EXIT trap) → unlink socket + exit.
//
// Protocol: length-prefixed JSON. Each message is `<4-byte BE u32 length>
// <utf8 JSON body>`. v1 commands: `HELLO`, `GET_SNAPSHOT`. Future commands
// (parsed-state shipping, FD passing) can be layered on without breaking
// existing clients — the popup falls back to direct fs reads on any
// protocol error.

import * as net from 'node:net';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

interface Snapshot {
  /** Absolute path → file content (or null if missing). */
  files: Record<string, string | null>;
  /** Absolute dir path → entries (name + isDirectory). null = unreadable. */
  dirs: Record<string, ReadonlyArray<{ name: string; isDirectory: boolean }> | null>;
  /** Monotonic version — popup can detect mid-flight changes if needed. */
  version: number;
  /** When the snapshot was built (ms since epoch). */
  builtAt: number;
}

// ─── Parse args ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
let sockPath = process.env.OPENCUES_OCEDITD_SOCK ?? '';
let userCwd = process.env.OPENCUES_USER_CWD ?? process.cwd();
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--socket' && args[i + 1]) { sockPath = args[++i]!; }
  else if (args[i] === '--cwd' && args[i + 1]) { userCwd = args[++i]!; }
}
if (!sockPath) {
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
  sockPath = path.join(runtimeDir, `oc-editd-${process.pid}.sock`);
}

const HOME = process.env.HOME ?? os.homedir();
const SEARCH_PATHS: string[] = [];
if (process.env.OPENCUES_HOME) SEARCH_PATHS.push(process.env.OPENCUES_HOME);
SEARCH_PATHS.push(path.join(userCwd, '.cues'));
SEARCH_PATHS.push(path.join(HOME, '.cues'));

const SETTINGS_FILE = process.env.OPENCUES_HOME
  ? path.join(process.env.OPENCUES_HOME, 'OPENCUES.md')
  : path.join(HOME, '.cues', 'OPENCUES.md');
const USER_MD = path.join(path.dirname(SETTINGS_FILE), 'USER.md');

const LOG_PATH = '/tmp/oc-editd.log';
function logLine(msg: string): void {
  try {
    const ts = new Date().toISOString();
    fs.appendFileSync(LOG_PATH, `[${ts}] ${msg}\n`);
  } catch { /* swallow */ }
}

// ─── Snapshot builder ──────────────────────────────────────────────────

let snapshotVersion = 0;

async function safeReadFile(p: string): Promise<string | null> {
  try { return await fsp.readFile(p, 'utf8'); } catch { return null; }
}

async function safeReadDir(p: string): Promise<ReadonlyArray<{ name: string; isDirectory: boolean }> | null> {
  try {
    const entries = await fsp.readdir(p, { withFileTypes: true });
    return entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() }));
  } catch { return null; }
}

async function walkConfigTree(base: string, files: Record<string, string | null>, dirs: Record<string, ReadonlyArray<{ name: string; isDirectory: boolean }> | null>, depth = 0): Promise<void> {
  if (depth > 4) return;
  const entries = await safeReadDir(base);
  dirs[base] = entries;
  if (!entries) return;
  for (const e of entries) {
    const full = path.join(base, e.name);
    if (e.isDirectory) {
      await walkConfigTree(full, files, dirs, depth + 1);
    } else if (e.name.endsWith('.md')) {
      files[full] = await safeReadFile(full);
    }
  }
}

async function buildSnapshot(): Promise<Snapshot> {
  const files: Record<string, string | null> = {};
  const dirs: Record<string, ReadonlyArray<{ name: string; isDirectory: boolean }> | null> = {};

  // Top-level files the ConfigLoader reads directly.
  files[SETTINGS_FILE] = await safeReadFile(SETTINGS_FILE);
  files[USER_MD] = await safeReadFile(USER_MD);
  for (const p of SEARCH_PATHS) {
    files[path.join(p, 'CUES.md')] = await safeReadFile(path.join(p, 'CUES.md'));
    files[path.join(p, 'BLANKS.md')] = await safeReadFile(path.join(p, 'BLANKS.md'));
    files[path.join(p, 'AUDITORS.md')] = await safeReadFile(path.join(p, 'AUDITORS.md'));
  }

  // Folder-walk every subdir ConfigLoader._discoverFolders touches +
  // every dir bootstrap.ts's user-blank discovery walks.
  for (const p of SEARCH_PATHS) {
    for (const sub of ['cues', 'blanks', 'auditors']) {
      const dirPath = path.join(p, sub);
      await walkConfigTree(dirPath, files, dirs, 0);
    }
  }

  snapshotVersion += 1;
  return { files, dirs, version: snapshotVersion, builtAt: Date.now() };
}

let currentSnapshot: Snapshot = { files: {}, dirs: {}, version: 0, builtAt: 0 };
let buildInFlight: Promise<void> | null = null;

async function refreshSnapshot(): Promise<void> {
  if (buildInFlight) return buildInFlight;
  buildInFlight = (async () => {
    try {
      const built = await buildSnapshot();
      currentSnapshot = built;
      lastRefreshAt = Date.now();
      logLine(`snapshot refreshed v${built.version} (${Object.keys(built.files).length} files, ${Object.keys(built.dirs).length} dirs)`);
    } catch (err) {
      logLine(`snapshot refresh failed: ${(err as Error).message}`);
    } finally {
      buildInFlight = null;
    }
  })();
  return buildInFlight;
}

// ─── File watcher ──────────────────────────────────────────────────────

const watchers: fs.FSWatcher[] = [];
let debounceTimer: NodeJS.Timeout | null = null;
let lastRefreshAt = 0;

function scheduleRefresh(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  // Two-stage rate limit: (1) coalesce bursty inotify events within
  // 150ms; (2) on Linux fs.watch(recursive:true) keeps draining queued
  // events for ~tens of ms after each refresh completes, so also
  // enforce a 250ms minimum interval between refreshes.
  const now = Date.now();
  const minWait = Math.max(150, 250 - (now - lastRefreshAt));
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    refreshSnapshot().catch(() => { /* logged */ });
  }, minWait);
}

function startWatchers(): void {
  for (const p of SEARCH_PATHS) {
    if (!fs.existsSync(p)) continue;
    try {
      const w = fs.watch(p, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        if (typeof filename === 'string' && filename.endsWith('.md')) {
          scheduleRefresh();
        }
      });
      watchers.push(w);
      logLine(`watching ${p}`);
    } catch (err) {
      logLine(`watch failed for ${p}: ${(err as Error).message}`);
    }
  }
}

// ─── Unix socket server ────────────────────────────────────────────────

function readMessage(sock: net.Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let needed = -1;
    let received = 0;
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      received += chunk.length;
      if (needed < 0 && received >= 4) {
        const head = Buffer.concat(chunks);
        needed = head.readUInt32BE(0);
        if (needed < 0 || needed > 32 * 1024 * 1024) {
          cleanup();
          reject(new Error(`oversized frame: ${needed}`));
          return;
        }
      }
      if (needed >= 0 && received >= needed + 4) {
        const all = Buffer.concat(chunks);
        const body = all.slice(4, 4 + needed).toString('utf8');
        cleanup();
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      }
    };
    const onErr = (e: Error): void => { cleanup(); reject(e); };
    const onEnd = (): void => { cleanup(); reject(new Error('socket closed before frame complete')); };
    const cleanup = (): void => {
      sock.off('data', onData);
      sock.off('error', onErr);
      sock.off('end', onEnd);
    };
    sock.on('data', onData);
    sock.on('error', onErr);
    sock.on('end', onEnd);
  });
}

function writeMessage(sock: net.Socket, obj: unknown): void {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  sock.write(head);
  sock.write(body);
}

async function handleConnection(sock: net.Socket): Promise<void> {
  sock.on('error', () => { /* client may bail */ });
  try {
    const msg = await readMessage(sock) as { cmd?: string };
    if (msg.cmd === 'HELLO') {
      writeMessage(sock, {
        ok: true,
        version: snapshotVersion,
        builtAt: currentSnapshot.builtAt,
        pid: process.pid,
        workerReady: warmWorker?.state === 'ready',
      });
    } else if (msg.cmd === 'GET_SNAPSHOT') {
      if (currentSnapshot.version === 0) {
        await refreshSnapshot();
      }
      writeMessage(sock, { ok: true, snapshot: currentSnapshot });
    } else if (msg.cmd === 'BORROW_WORKER') {
      // Hand out the warm worker's socket path; spawn a replacement
      // immediately so the next popup also gets a warm one.
      const w = warmWorker;
      if (!w || w.state !== 'ready') {
        writeMessage(sock, { ok: false, error: 'no warm worker available' });
      } else {
        warmWorker = null;
        spawnWarmWorker();  // background — fills the slot for next popup
        writeMessage(sock, { ok: true, sockPath: w.sockPath, pid: w.pid });
      }
    } else {
      writeMessage(sock, { ok: false, error: `unknown cmd: ${msg.cmd}` });
    }
  } catch (err) {
    try { writeMessage(sock, { ok: false, error: (err as Error).message }); } catch { /* drop */ }
  } finally {
    sock.end();
  }
}

// ─── Warm worker pool (single slot) ───────────────────────────────────

interface WarmWorker {
  child: ChildProcess;
  pid: number;
  sockPath: string;
  state: 'spawning' | 'ready' | 'used';
  spawnedAt: number;
}

let warmWorker: WarmWorker | null = null;

function workerEntryPath(): string {
  // daemon.ts and render-worker.ts live in the same src/ dir. When
  // bundled (dist/), both live in the same dist/ dir. Either way the
  // worker is one directory over from this module.
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Prefer dist/ when present (matches bin/oc-edit's dist-first
  // fallback).
  const distWorker = path.join(here, '..', 'dist', 'render-worker.js');
  if (fs.existsSync(distWorker)) return distWorker;
  return path.join(here, 'render-worker.ts');
}

function spawnWarmWorker(): void {
  if (warmWorker) return;
  const sockPath = path.join(
    process.env.XDG_RUNTIME_DIR ?? os.tmpdir(),
    `oc-worker-${process.pid}-${Date.now()}.sock`,
  );
  const entry = workerEntryPath();
  const childEnv = { ...process.env, OPENCUES_WORKER_SOCK: sockPath };
  // The bash shim oc-editd already cd'd into integrations/terminal/
  // for bunfig discovery. Inherit cwd from the daemon so the worker's
  // bunfig + preload resolution is identical.
  // stderr inherits — worker's log() also writes to /tmp/oc-editd.log,
  // but anything else (FFI errors, etc.) lands on the daemon's stderr.
  // stdio[3] = pipe is our IPC channel for the worker's "ready" signal.
  // We can't use stdout — opentui's preload writes alt-screen escape
  // codes to fd 1 at module load, which would garble any JSON line we
  // tried to multiplex through. stderr is also no good (we inherit it
  // so log noise reaches the user). fd 3 is unused by opentui/runtime.
  const child = spawn(
    'bun',
    ['--preload', '@opentui/solid/preload', entry],
    { env: childEnv, stdio: ['ignore', 'ignore', 'inherit', 'pipe'] },
  );
  const slot: WarmWorker = {
    child,
    pid: child.pid ?? -1,
    sockPath,
    state: 'spawning',
    spawnedAt: Date.now(),
  };
  warmWorker = slot;
  logLine(`worker spawning pid=${child.pid} sock=${sockPath}`);

  // Read ready signal from worker's fd 3.
  const readyPipe = child.stdio[3] as NodeJS.ReadableStream | null;
  if (!readyPipe) {
    logLine(`worker spawn: no fd-3 pipe — readiness will never fire`);
  } else {
    let lineBuf = '';
    readyPipe.setEncoding!('utf8');
    readyPipe.on('data', (chunk: string) => {
      lineBuf += chunk;
      let nl: number;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj?.ready && obj?.sockPath === sockPath && slot.state === 'spawning') {
            slot.state = 'ready';
            logLine(`worker ready pid=${slot.pid} (${Date.now() - slot.spawnedAt}ms warmup)`);
          }
        } catch (e) {
          logLine(`worker ready-pipe parse failed: ${(e as Error).message}`);
        }
      }
    });
  }

  child.on('exit', (code, signal) => {
    logLine(`worker pid=${slot.pid} exited code=${code} signal=${signal} state=${slot.state}`);
    if (warmWorker === slot) {
      warmWorker = null;
      // If the worker died without being used, respawn so the slot
      // stays filled. If it was used (popup completed), let it die —
      // BORROW_WORKER already triggered the next spawn.
      if (slot.state !== 'used') {
        setTimeout(() => spawnWarmWorker(), 1000);
      }
    }
    try { fs.unlinkSync(slot.sockPath); } catch {}
  });
}

// ─── Startup ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Stale socket from a previous run (e.g. oc-shell killed -9).
  try { fs.unlinkSync(sockPath); } catch { /* fine if absent */ }

  // Build the first snapshot in parallel with socket setup.
  const firstBuild = refreshSnapshot();
  startWatchers();

  const server = net.createServer(handleConnection);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => resolve());
  });
  try { fs.chmodSync(sockPath, 0o600); } catch { /* best effort */ }
  logLine(`listening on ${sockPath} (pid=${process.pid})`);

  await firstBuild;
  logLine('ready');

  // Kick off the first warm worker. It runs in parallel with whatever
  // the user does next — by the time they hit Ctrl+Alt+S, the worker
  // has finished loading @opentui + @opencues/runtime.
  spawnWarmWorker();

  const cleanup = (sig: string): void => {
    logLine(`received ${sig}, shutting down`);
    for (const w of watchers) { try { w.close(); } catch {} }
    try { server.close(); } catch {}
    try { fs.unlinkSync(sockPath); } catch {}
    if (warmWorker?.child && !warmWorker.child.killed) {
      try { warmWorker.child.kill('SIGTERM'); } catch {}
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('SIGHUP', () => cleanup('SIGHUP'));
}

main().catch((err) => {
  logLine(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
