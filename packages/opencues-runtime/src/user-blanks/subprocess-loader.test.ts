// Tests for the user-blank subprocess loader. Verifies the IPC protocol +
// lifecycle that lets Bun-based hosts (opencode, shell) run user-pack JS
// blanks via a spawned Node helper, since `isolated-vm` can't load
// in-process there. The runner script is real isolated-vm in a child
// Node process; tests spawn it directly from src/ so we don't need the
// install path to have run.
//
// Coverage:
//   1. Lifecycle — spawn, ready, load, get, set, shutdown.
//   2. Capability bridge — ctx.fetch round-trips through the host handler
//      (which is where the allow-list + secret-binding checks live).
//   3. Capability gating — fetch without `network: [...]` is rejected.
//   4. Multiplexing — two blanks in the same runner don't see each other.
//   5. Crash recovery — kill subprocess mid-invoke; pending promises
//      reject; next invoke respawns and succeeds.
//   6. ESM rewrite is reused — `export default { ... }` works.
//   7. Synchronous load API — loader returns immediately; first invoke
//      awaits the background load.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SubprocessIsolateRunner,
  loadUserBlankSubprocess,
} from './subprocess-loader';

// Resolve the runner script next to this test file. We spawn it directly
// (not through the installed ~/.opencues/vendor/ path) so the test is
// self-contained.
const RUNNER_PATH = path.join(__dirname, 'subprocess-runner.cjs');
// Walk upward from this file to find the workspace's node_modules with
// isolated-vm. Tests run from src/ in development, dist/ in CI.
function findIvmNodePath(): string {
  let dir = __dirname;
  while (dir !== path.dirname(dir)) {
    const nm = path.join(dir, 'node_modules');
    if (fs.existsSync(path.join(nm, 'isolated-vm'))) return nm;
    dir = path.dirname(dir);
  }
  // Fall back to the repo root.
  return path.join(process.cwd(), 'node_modules');
}
const NODE_PATH = findIvmNodePath();

let runner: SubprocessIsolateRunner;
let workdir: string;

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-subproc-test-'));
  runner = new SubprocessIsolateRunner({
    runnerPath: RUNNER_PATH,
    nodePath: NODE_PATH,
    reapMs: 30 * 1000,
    log: () => { /* silent */ },
  });
});

afterEach(async () => {
  try { await runner.shutdown(); } catch { /* */ }
  try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* */ }
});

function writeBlank(name: string, source: string): string {
  const p = path.join(workdir, `${name}.js`);
  fs.writeFileSync(p, source);
  return p;
}

describe('subprocess-loader — lifecycle', () => {
  it('loads + invokes a minimal blank', async () => {
    const p = writeBlank('hello', `export default { async get(ctx, args) { return 'hello ' + (args[0] || ''); } };`);
    const blank = loadUserBlankSubprocess(p, 'hello', {
      capabilities: {},
      runner,
    });
    const out = await blank.module.get({} as never, ['world']);
    expect(out).toBe('hello world');
  });

  it('returns empty string for null/undefined returns', async () => {
    const p = writeBlank('nuller', `export default { async get(ctx, args) { return null; } };`);
    const blank = loadUserBlankSubprocess(p, 'nuller', { capabilities: {}, runner });
    const out = await blank.module.get({} as never, []);
    expect(out).toBe('');
  });

  it('surfaces parse errors synchronously on load', () => {
    const p = writeBlank('broken', `export default { async get(ctx, args) { return @@@; } };`);
    expect(() => loadUserBlankSubprocess(p, 'broken', { capabilities: {}, runner })).toThrow(/parse/);
  });

  it('surfaces dynamic-import as a rewrite warning at load time', () => {
    const p = writeBlank('dyn', `const m = await import('http'); export default { async get() { return 'no'; } };`);
    expect(() => loadUserBlankSubprocess(p, 'dyn', { capabilities: {}, runner })).toThrow(/dynamic.*import/);
  });
});

describe('subprocess-loader — capability bridge', () => {
  it('ctx.fetch is undefined when network is not declared', async () => {
    const p = writeBlank('nofetch', `
      export default { async get(ctx, args) {
        return ctx.fetch ? 'has-fetch' : 'no-fetch';
      } };
    `);
    const blank = loadUserBlankSubprocess(p, 'nofetch', { capabilities: {}, runner });
    const out = await blank.module.get({} as never, []);
    expect(out).toBe('no-fetch');
  });

  it('ctx.fetch routes through the host handler (allow-list enforced)', async () => {
    let hostFetchCalled = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string) => {
      hostFetchCalled++;
      return new Response(JSON.stringify({ v: 42 }), { status: 200 });
    }) as typeof fetch;

    try {
      const p = writeBlank('fetcher', `
        export default { async get(ctx, args) {
          const r = await ctx.fetch('https://api.example.com/x');
          const j = await r.json();
          return 'v=' + j.v;
        } };
      `);
      const blank = loadUserBlankSubprocess(p, 'fetcher', {
        capabilities: { network: ['api.example.com'] },
        runner,
      });
      const out = await blank.module.get({} as never, []);
      expect(out).toBe('v=42');
      expect(hostFetchCalled).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('blocks fetch to hostname outside the allow-list', async () => {
    const p = writeBlank('blocked', `
      export default { async get(ctx, args) {
        try { await ctx.fetch('https://evil.example.com/x'); return 'leaked'; }
        catch (e) { return 'blocked'; }
      } };
    `);
    const blank = loadUserBlankSubprocess(p, 'blocked', {
      capabilities: { network: ['api.example.com'] },
      runner,
    });
    const out = await blank.module.get({} as never, []);
    expect(out).toBe('blocked');
  });
});

describe('subprocess-loader — multiplexing', () => {
  it('loads two blanks in the same runner; they don\'t see each other', async () => {
    const a = writeBlank('a', `export default { async get(ctx, args) { return 'A:' + (args[0] || ''); } };`);
    const b = writeBlank('b', `export default { async get(ctx, args) { return 'B:' + (args[0] || ''); } };`);
    const blankA = loadUserBlankSubprocess(a, 'a', { capabilities: {}, runner });
    const blankB = loadUserBlankSubprocess(b, 'b', { capabilities: {}, runner });
    const [outA, outB] = await Promise.all([
      blankA.module.get({} as never, ['x']),
      blankB.module.get({} as never, ['y']),
    ]);
    expect(outA).toBe('A:x');
    expect(outB).toBe('B:y');
  });
});

describe('subprocess-loader — crash recovery', () => {
  it('rejects pending invokes when subprocess dies, respawns on next', async () => {
    const p = writeBlank('crashy', `
      export default { async get(ctx, args) {
        if (args[0] === 'sleep') { await new Promise(r => setTimeout(r, 10000)); return 'done'; }
        return 'fast:' + args[0];
      } };
    `);
    const blank = loadUserBlankSubprocess(p, 'crashy', { capabilities: {}, runner });

    // Prime — establish the runner is up.
    const fast1 = await blank.module.get({} as never, ['1']);
    expect(fast1).toBe('fast:1');

    // Now start a long invoke + kill the subprocess.
    const sleeping = blank.module.get({} as never, ['sleep']);
    // Reach into the runner; this is a test-only escape hatch.
    const proc = (runner as unknown as { proc: { kill: (s: string) => void } | null }).proc;
    expect(proc).not.toBeNull();
    proc!.kill('SIGKILL');

    await expect(sleeping).rejects.toThrow();

    // Reload + invoke must succeed (new subprocess).
    const blank2 = loadUserBlankSubprocess(p, 'crashy', { capabilities: {}, runner });
    const fast2 = await blank2.module.get({} as never, ['2']);
    expect(fast2).toBe('fast:2');
  }, 15000);
});

describe('subprocess-loader — set + secrets', () => {
  it('passes secrets only for declared env-var names', async () => {
    const p = writeBlank('secretreader', `
      export default { async get(ctx, args) {
        return JSON.stringify({
          has_A: !!ctx.secrets?.WANTED,
          has_B: !!ctx.secrets?.NOT_WANTED,
        });
      } };
    `);
    const blank = loadUserBlankSubprocess(p, 'secretreader', {
      capabilities: { secrets: ['WANTED'] },
      secrets: { WANTED: 'visible', NOT_WANTED: 'shouldnt-see' },
      runner,
    });
    const out = await blank.module.get({} as never, []);
    const parsed = JSON.parse(out);
    expect(parsed.has_A).toBe(true);
    expect(parsed.has_B).toBe(false);
  });

  it('set is wired through', async () => {
    const p = writeBlank('settable', `
      let stash = '';
      export default {
        async get(ctx, args) { return stash; },
        async set(ctx, value, args) { stash = '[' + value + ']'; },
      };
    `);
    const blank = loadUserBlankSubprocess(p, 'settable', { capabilities: {}, runner });
    await blank.module.set!({} as never, 'hi', []);
    const out = await blank.module.get({} as never, []);
    expect(out).toBe('[hi]');
  });
});
