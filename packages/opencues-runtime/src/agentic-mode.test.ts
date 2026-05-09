import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { startAgenticHarness } from './agentic-mode';
import type { HostAdapter, KeyEvent } from './adapter';
import { HOST_ADAPTER_INTERFACE_VERSION } from './adapter';

/**
 * Build a minimal stub HostAdapter that records setText/setCursor/forceRender
 * calls and serves text/cursor reads from internal state. Sufficient for
 * driving the inject loop.
 */
function makeStubAdapter(initial = { text: '', cursor: 0 }): HostAdapter & {
  setTextCalls: string[];
  setCursorCalls: number[];
  forceRenderCalls: number;
} {
  let text = initial.text;
  let cursor = initial.cursor;
  const setTextCalls: string[] = [];
  const setCursorCalls: number[] = [];
  let forceRenderCalls = 0;
  return {
    interfaceVersion: HOST_ADAPTER_INTERFACE_VERSION,
    hostName: 'stub-host',
    hostVersion: '0.0.0',
    cwd: '/tmp',
    capabilities: ['file-read', 'file-write', 'force-render', 'render-override'],
    getText: () => text,
    getCursorOffset: () => cursor,
    getSelection: () => null,
    setText: (t) => { text = t; setTextCalls.push(t); },
    setCursorOffset: (c) => { cursor = c; setCursorCalls.push(c); },
    forceRender: () => { forceRenderCalls += 1; },
    onKey: () => () => {},
    onTextChange: () => () => {},
    onCursorChange: () => () => {},
    onRender: () => () => {},
    readFile: async () => null,
    readDir: async () => null,
    writeFile: async () => {},
    spawnProcess: () => { throw new Error('not supported'); },
    blankInvoke: () => null,
    pushText: () => {},
    log: () => {},
    dispose: () => {},
    get setTextCalls() { return setTextCalls; },
    get setCursorCalls() { return setCursorCalls; },
    get forceRenderCalls() { return forceRenderCalls; },
  } as any;
}

const PID_INJECT = `/tmp/opencues-inject-${process.pid}.txt`;
const PID_DUMP = `/tmp/opencues-agentic-dump-${process.pid}.json`;
const PID_FILE = '/tmp/opencues-agentic.pid';

function cleanupFiles(): void {
  for (const p of [PID_INJECT, PID_DUMP, PID_FILE]) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
  delete process.env.OPENCUES_AGENTIC_PID_FILE;
}

describe('agentic harness — startAgenticHarness', () => {
  beforeEach(cleanupFiles);
  afterEach(cleanupFiles);

  it('returns a handle with stop() + poll() + paths', () => {
    const adapter = makeStubAdapter();
    const dispatchKey = vi.fn(() => false);
    const h = startAgenticHarness({ adapter, dispatchKey, state: {} });
    expect(typeof h.stop).toBe('function');
    expect(typeof h.poll).toBe('function');
    expect(h.paths.inject).toBe(PID_INJECT);
    expect(h.paths.dump).toBe(PID_DUMP);
    h.stop();
  });

  it('poll() is a no-op when no inject file exists', () => {
    const adapter = makeStubAdapter();
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    h.poll();
    expect(adapter.setTextCalls).toEqual([]);
    h.stop();
  });

  it('text:<s> calls adapter.setText + forceRender, then deletes the inject file', () => {
    const adapter = makeStubAdapter();
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    fs.writeFileSync(PID_INJECT, 'text:hello world');
    h.poll();
    expect(adapter.setTextCalls).toEqual(['hello world']);
    expect(adapter.forceRenderCalls).toBe(1);
    expect(fs.existsSync(PID_INJECT)).toBe(false);
    h.stop();
  });

  it('cursor:<n> calls adapter.setCursorOffset', () => {
    const adapter = makeStubAdapter({ text: 'hello', cursor: 0 });
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    fs.writeFileSync(PID_INJECT, 'cursor:3');
    h.poll();
    expect(adapter.setCursorCalls).toEqual([3]);
    h.stop();
  });

  it('cursor: ignores non-numeric / negative values', () => {
    const adapter = makeStubAdapter();
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    fs.writeFileSync(PID_INJECT, 'cursor:abc\ncursor:-5');
    h.poll();
    expect(adapter.setCursorCalls).toEqual([]);
    h.stop();
  });

  it('key:<name>:<mods> dispatches a KeyEvent with the right modifiers + sampled text/cursor', () => {
    const adapter = makeStubAdapter({ text: 'the lawyer filed', cursor: 8 });
    const dispatched: KeyEvent[] = [];
    const dispatchKey = (e: KeyEvent): boolean => {
      dispatched.push(e);
      return true;
    };
    const h = startAgenticHarness({ adapter, dispatchKey, state: {} });
    fs.writeFileSync(PID_INJECT, 'key:up:ctrl+alt');
    h.poll();
    expect(dispatched).toEqual([{
      key: 'up',
      modifiers: { ctrl: true, alt: true, shift: false, meta: false },
      text: 'the lawyer filed',
      cursorOffset: 8,
    }]);
    h.stop();
  });

  it('key without mods works (escape, bare arrow, etc.)', () => {
    const adapter = makeStubAdapter();
    const dispatched: KeyEvent[] = [];
    const h = startAgenticHarness({
      adapter,
      dispatchKey: (e) => { dispatched.push(e); return false; },
      state: {},
    });
    fs.writeFileSync(PID_INJECT, 'key:escape');
    h.poll();
    expect(dispatched.length).toBe(1);
    expect(dispatched[0].key).toBe('escape');
    expect(dispatched[0].modifiers).toEqual({ ctrl: false, alt: false, shift: false, meta: false });
    h.stop();
  });

  it('clear empties the buffer + resets cursor', () => {
    const adapter = makeStubAdapter({ text: 'something', cursor: 5 });
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    fs.writeFileSync(PID_INJECT, 'clear');
    h.poll();
    expect(adapter.setTextCalls).toEqual(['']);
    expect(adapter.setCursorCalls).toEqual([0]);
    h.stop();
  });

  it('dump writes a JSON file with the canonical shape', () => {
    const adapter = makeStubAdapter({ text: 'the lawyer', cursor: 4 });
    const fakeHl = { active: true, wordIndex: 1, text: 'the lawyer' };
    const fakeAgent = { armed: true, taskId: 'tsk_1', prompt: 'fix typos' };
    const h = startAgenticHarness({
      adapter,
      dispatchKey: () => false,
      state: { hlState: fakeHl, agentTaskState: fakeAgent },
    });
    fs.writeFileSync(PID_INJECT, 'dump');
    h.poll();
    expect(fs.existsSync(PID_DUMP)).toBe(true);
    const dump = JSON.parse(fs.readFileSync(PID_DUMP, 'utf8'));
    expect(dump.text).toBe('the lawyer');
    expect(dump.cursor).toBe(4);
    expect(dump.host).toBe('stub-host');
    expect(dump.hostVersion).toBe('0.0.0');
    expect(dump.highlight).toMatchObject({ active: true, wordIndex: 1 });
    expect(dump.agentTask).toMatchObject({ armed: true, taskId: 'tsk_1', prompt: 'fix typos' });
    expect(typeof dump.timestamp).toBe('string');
    expect(dump.pid).toBe(process.pid);
    h.stop();
  });

  it('multi-line scripts run sequentially in declaration order', () => {
    const adapter = makeStubAdapter();
    const log: string[] = [];
    const h = startAgenticHarness({
      adapter,
      dispatchKey: (e) => { log.push(`key:${e.key}`); return true; },
      state: {},
    });
    fs.writeFileSync(PID_INJECT, [
      'text:hello',
      'cursor:3',
      'key:left:ctrl+alt',
      'clear',
    ].join('\n'));
    h.poll();
    expect(adapter.setTextCalls).toEqual(['hello', '']);
    expect(adapter.setCursorCalls).toEqual([3, 0]);
    expect(log).toEqual(['key:left']);
    h.stop();
  });

  it('blank lines + whitespace-only lines are tolerated', () => {
    const adapter = makeStubAdapter();
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    fs.writeFileSync(PID_INJECT, 'text:abc\n\n   \ntext:def\n');
    h.poll();
    expect(adapter.setTextCalls).toEqual(['abc', 'def']);
    h.stop();
  });

  it('unknown commands are logged + ignored, do not abort the script', () => {
    const adapter = makeStubAdapter();
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    fs.writeFileSync(PID_INJECT, 'totally-unknown:foo\ntext:after-unknown');
    h.poll();
    expect(adapter.setTextCalls).toEqual(['after-unknown']);
    h.stop();
  });

  it('a thrown command does not abort subsequent commands', () => {
    const adapter = makeStubAdapter();
    let dispatchCalls = 0;
    const h = startAgenticHarness({
      adapter,
      dispatchKey: () => {
        dispatchCalls += 1;
        if (dispatchCalls === 1) throw new Error('first dispatch crashes');
        return true;
      },
      state: {},
    });
    fs.writeFileSync(PID_INJECT, 'key:left:ctrl+alt\nkey:right:ctrl+alt');
    h.poll();
    expect(dispatchCalls).toBe(2);  // both attempted
    h.stop();
  });

  it('text-keep-hl is recognised + treated like text (alias)', () => {
    const adapter = makeStubAdapter();
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    fs.writeFileSync(PID_INJECT, 'text-keep-hl:keep me');
    h.poll();
    expect(adapter.setTextCalls).toEqual(['keep me']);
    h.stop();
  });

  it('wait:<ms> is a no-op marker', () => {
    const adapter = makeStubAdapter();
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    fs.writeFileSync(PID_INJECT, 'wait:500\ntext:after-wait');
    h.poll();
    expect(adapter.setTextCalls).toEqual(['after-wait']);
    h.stop();
  });

  it('inject file is deleted before commands run (atomic consume — crash-safe)', () => {
    const adapter = makeStubAdapter();
    const h = startAgenticHarness({
      adapter,
      dispatchKey: () => {
        // Inject file should already be gone by the time a command runs.
        expect(fs.existsSync(PID_INJECT)).toBe(false);
        return true;
      },
      state: {},
    });
    fs.writeFileSync(PID_INJECT, 'key:up:ctrl+alt');
    h.poll();
    h.stop();
  });

  it('stop() halts the polling timer; subsequent file writes are not processed', async () => {
    const adapter = makeStubAdapter();
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    h.stop();
    fs.writeFileSync(PID_INJECT, 'text:should-not-process');
    // Wait one polling interval to be sure no poll runs.
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(adapter.setTextCalls).toEqual([]);
    expect(fs.existsSync(PID_INJECT)).toBe(true);
    cleanupFiles();
  });

  it('paths reflect the current pid', () => {
    const adapter = makeStubAdapter();
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    expect(h.paths.inject).toBe(`/tmp/opencues-inject-${process.pid}.txt`);
    expect(h.paths.dump).toBe(`/tmp/opencues-agentic-dump-${process.pid}.json`);
    expect(h.paths.pid).toBe('/tmp/opencues-agentic.pid');
    h.stop();
  });

  it('writes the pidfile on arm + deletes it on stop', () => {
    const adapter = makeStubAdapter();
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    expect(fs.existsSync(PID_FILE)).toBe(true);
    expect(fs.readFileSync(PID_FILE, 'utf8').trim()).toBe(String(process.pid));
    h.stop();
    expect(fs.existsSync(PID_FILE)).toBe(false);
  });

  it('OPENCUES_AGENTIC_PID_FILE overrides the pidfile path', () => {
    const customPath = '/tmp/opencues-agentic-test-override.pid';
    process.env.OPENCUES_AGENTIC_PID_FILE = customPath;
    try {
      const adapter = makeStubAdapter();
      const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
      expect(h.paths.pid).toBe(customPath);
      expect(fs.existsSync(customPath)).toBe(true);
      expect(fs.readFileSync(customPath, 'utf8').trim()).toBe(String(process.pid));
      h.stop();
      expect(fs.existsSync(customPath)).toBe(false);
    } finally {
      try { fs.unlinkSync(customPath); } catch { /* ignore */ }
    }
  });

  it('stop() does not delete a pidfile owned by a different (newer) pid', () => {
    const adapter = makeStubAdapter();
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    // Simulate a newer host having claimed the pidfile.
    fs.writeFileSync(PID_FILE, '99999999');
    h.stop();
    // The newer host's pidfile must survive.
    expect(fs.existsSync(PID_FILE)).toBe(true);
    expect(fs.readFileSync(PID_FILE, 'utf8').trim()).toBe('99999999');
  });
});
