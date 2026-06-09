// Test for the F1 stopgap warn-once mechanism (INFOSEC F1).
//
// Pins:
//   - First load of a blank emits a loud `console.warn` containing
//     "INFOSEC F1" + "full host privileges".
//   - Same blank loaded again is silent (warn-once per path).
//   - Different blank paths each warn once.
//   - `_resetF1WarnCache` clears the dedup set.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadUserBlank, _resetF1WarnCache } from './node-loader';

let workdir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-f1-warn-test-'));
  _resetF1WarnCache();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  _resetF1WarnCache();
  try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* */ }
});

function writeBlank(name: string): string {
  const p = path.join(workdir, name);
  fs.writeFileSync(p, `export default { async get() { return 'hello'; } };`);
  return p;
}

describe('F1 stopgap — loud warn at first load (INFOSEC F1)', () => {
  it('emits a loud console.warn on first load mentioning INFOSEC F1 + host privileges', () => {
    const p = writeBlank('a.js');
    loadUserBlank(p, { capabilities: {} });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0][0]);
    expect(msg).toMatch(/INFOSEC F1/);
    expect(msg).toMatch(/FULL host privileges/i);
    expect(msg).toMatch(/constructor-chain/i);
    expect(msg).toMatch(/opencues review/);
  });

  it('subsequent loads of the SAME blank path are silent (warn-once)', () => {
    const p = writeBlank('a.js');
    loadUserBlank(p, { capabilities: {} });
    loadUserBlank(p, { capabilities: {} });
    loadUserBlank(p, { capabilities: {} });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('different blank paths each warn once', () => {
    const a = writeBlank('a.js');
    const b = writeBlank('b.js');
    loadUserBlank(a, { capabilities: {} });
    loadUserBlank(b, { capabilities: {} });
    loadUserBlank(a, { capabilities: {} }); // already-warned
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('_resetF1WarnCache clears the dedup set', () => {
    const p = writeBlank('a.js');
    loadUserBlank(p, { capabilities: {} });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    _resetF1WarnCache();
    loadUserBlank(p, { capabilities: {} });
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('warn also flows through the supplied adapter log', () => {
    const logCalls: Array<{ lvl: string; msg: string }> = [];
    const p = writeBlank('a.js');
    loadUserBlank(p, {
      capabilities: {},
      log: (lvl, msg) => logCalls.push({ lvl, msg: String(msg) }),
    });
    const warnLog = logCalls.find(c => c.lvl === 'warn' && /INFOSEC F1/.test(c.msg));
    expect(warnLog).toBeDefined();
  });
});
