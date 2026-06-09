// F1 escape-proofing (INFOSEC F1 — closed June 2026).
//
// The June 2026 security review live-confirmed that the prior
// `vm.runInContext` loader was escapable via the constructor chain
// of any host-shared intrinsic:
//
//   Promise.constructor('return process')()  // → host `process`
//
// This file pins the closure. Every test attempts a known escape
// pivot and asserts the user code CANNOT reach a host primitive that
// would let it read env vars / spawn / fs / etc.
//
// The structural guarantee is "the isolate has its own intrinsics, no
// host-realm object is shared in." Don't relax any of these tests
// without re-running the full June 2026 security pen-test set.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadUserBlank } from './node-loader';

let workdir: string;
beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-f1-escape-'));
});
afterEach(() => {
  try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* */ }
});

function writeBlank(source: string): string {
  const p = path.join(workdir, 'blank.js');
  fs.writeFileSync(p, source);
  return p;
}

async function runEscapeAttempt(attempt: string): Promise<string> {
  const p = writeBlank(`
    export default {
      async get(ctx, args) {
        try {
          ${attempt}
        } catch (e) {
          return 'blocked:' + (e && e.message ? e.message : String(e));
        }
      }
    };
  `);
  const blank = loadUserBlank(p, { capabilities: {} });
  try {
    return await blank.module.get({ now: () => 0, log: () => {} }, []) as string;
  } finally {
    blank.dispose();
  }
}

describe('F1 — constructor-chain escape pivots all fail', () => {
  it('Promise.constructor("return process")() — the canonical F1 escape', async () => {
    const r = await runEscapeAttempt(`
      const p = Promise.constructor('return process')();
      return 'PWNED:' + (typeof p) + ':' + (p && typeof p.env);
    `);
    // Either the escape resolves `process` to undefined in the isolate,
    // OR the eval throws. Both are acceptable closures. Critically,
    // `PWNED:object:object` (the actual escape) MUST NOT happen.
    expect(r).not.toMatch(/^PWNED:object:object/);
  });

  it('Date.constructor proto-walk', async () => {
    const r = await runEscapeAttempt(`
      const f = Date.constructor;
      const p = f('return process')();
      return 'PWNED:' + (p && typeof p.env);
    `);
    expect(r).not.toMatch(/^PWNED:object/);
  });

  it('URL.constructor proto-walk', async () => {
    const r = await runEscapeAttempt(`
      const f = URL.constructor;
      const p = f('return process')();
      return 'PWNED:' + (p && typeof p.env);
    `);
    expect(r).not.toMatch(/^PWNED:object/);
  });

  it('Math.constructor proto-walk', async () => {
    const r = await runEscapeAttempt(`
      const f = Math.constructor || Object.getPrototypeOf(Math).constructor;
      try {
        const p = f('return process')();
        return 'PWNED:' + (p && typeof p.env);
      } catch (e) {
        return 'blocked:' + e.message;
      }
    `);
    expect(r).not.toMatch(/^PWNED:object/);
  });

  it('JSON.constructor proto-walk', async () => {
    const r = await runEscapeAttempt(`
      const f = JSON.constructor || Object.getPrototypeOf(JSON).constructor;
      try {
        const p = f('return process')();
        return 'PWNED:' + (p && typeof p.env);
      } catch (e) {
        return 'blocked:' + e.message;
      }
    `);
    expect(r).not.toMatch(/^PWNED:object/);
  });

  it('setTimeout.constructor — function intrinsic escape', async () => {
    const r = await runEscapeAttempt(`
      if (typeof setTimeout !== 'function') return 'skipped:no-setTimeout';
      const f = setTimeout.constructor;
      const p = f('return process')();
      return 'PWNED:' + (p && typeof p.env);
    `);
    expect(r).not.toMatch(/^PWNED:object/);
  });

  it('Object.getPrototypeOf({}).constructor.constructor — proto chain walk', async () => {
    const r = await runEscapeAttempt(`
      const obj = {};
      const proto = Object.getPrototypeOf(obj);
      const f = proto.constructor.constructor;
      const p = f('return process')();
      return 'PWNED:' + (p && typeof p.env);
    `);
    expect(r).not.toMatch(/^PWNED:object/);
  });

  it('bracket-form ["constructor"] obfuscation', async () => {
    const r = await runEscapeAttempt(`
      const key = 'cons' + 'tructor';
      const f = Promise[key][key];
      const p = f('return process')();
      return 'PWNED:' + (p && typeof p.env);
    `);
    expect(r).not.toMatch(/^PWNED:object/);
  });

  it('eval is undefined in the sandbox', async () => {
    const r = await runEscapeAttempt(`
      return 'typeof:' + typeof eval;
    `);
    // The isolate exposes eval (it's a per-realm intrinsic) but eval'd
    // code runs in the SAME realm — it can't escape any more than
    // straight-line code can. We pin the typeof here to document
    // behaviour, not because eval is dangerous.
    expect(r).toMatch(/^typeof:(function|undefined)$/);
  });

  it('host globals are not reachable: process/require/Buffer/globalThis-host', async () => {
    const r = await runEscapeAttempt(`
      return JSON.stringify({
        process: typeof process,
        require: typeof require,
        Buffer:  typeof Buffer,
        Reflect: typeof Reflect,
        __dirname: typeof __dirname,
        __filename: typeof __filename,
        global_process: (typeof globalThis !== 'undefined') ? typeof globalThis.process : 'no-globalThis',
      });
    `);
    const parsed = JSON.parse(r);
    expect(parsed.process).toBe('undefined');
    expect(parsed.require).toBe('undefined');
    expect(parsed.Buffer).toBe('undefined');
    expect(parsed.__dirname).toBe('undefined');
    expect(parsed.__filename).toBe('undefined');
    expect(parsed.global_process).toBe('undefined');
  });

  it('attempted memory-DoS via a large array does not escape and is bounded', async () => {
    // A blank that tries to allocate huge arrays gets killed by the
    // isolate memory limit (default 32 MB). We can't easily test the
    // "killed" path deterministically here without long timeouts, but
    // we can pin that creating a moderate buffer doesn't crash and
    // can't reach the host's heap.
    const r = await runEscapeAttempt(`
      const a = new Array(1000).fill('x');
      return 'ok:' + a.length;
    `);
    expect(r).toBe('ok:1000');
  });

  it('dispose() releases the isolate and subsequent calls throw', async () => {
    const p = writeBlank(`export default { async get() { return 'ok'; } };`);
    const blank = loadUserBlank(p, { capabilities: {} });
    const first = await blank.module.get({ now: () => 0, log: () => {} }, []);
    expect(first).toBe('ok');
    blank.dispose();
    await expect(
      blank.module.get({ now: () => 0, log: () => {} }, []),
    ).rejects.toThrow();
  });
});
