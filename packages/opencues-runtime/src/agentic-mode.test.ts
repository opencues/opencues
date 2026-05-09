import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { startAgenticHarness, AGENTIC_EVENT_SCHEMA_VERSION } from './agentic-mode';
import type { AgenticEvent, AgenticEventBody } from './agentic-mode';
import type { CursorChangeEvent, HostAdapter, KeyEvent, TextChangeEvent } from './adapter';
import { HOST_ADAPTER_INTERFACE_VERSION } from './adapter';

// ─── Test fixtures ───────────────────────────────────────────────────────

interface StubAdapterHandle {
  adapter: HostAdapter;
  setTextCalls: string[];
  setCursorCalls: number[];
  forceRenderCalls: () => number;
  /** Emit a synthetic textChange event through onTextChange subscribers. */
  fireText: (e: TextChangeEvent) => void;
  fireCursor: (e: CursorChangeEvent) => void;
}

function makeStubAdapter(initial = { text: '', cursor: 0 }): StubAdapterHandle {
  let text = initial.text;
  let cursor = initial.cursor;
  const setTextCalls: string[] = [];
  const setCursorCalls: number[] = [];
  let forceRenderCalls = 0;
  const textHandlers: Array<(e: TextChangeEvent) => void> = [];
  const cursorHandlers: Array<(e: CursorChangeEvent) => void> = [];

  const adapter: HostAdapter = {
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
    onTextChange: (h) => { textHandlers.push(h); return () => { const i = textHandlers.indexOf(h); if (i >= 0) textHandlers.splice(i, 1); }; },
    onCursorChange: (h) => { cursorHandlers.push(h); return () => { const i = cursorHandlers.indexOf(h); if (i >= 0) cursorHandlers.splice(i, 1); }; },
    onRender: () => () => {},
    readFile: async () => null,
    readDir: async () => null,
    writeFile: async () => {},
    spawnProcess: () => { throw new Error('not supported'); },
    blankInvoke: () => null,
    pushText: () => {},
    log: () => {},
    dispose: () => {},
  };

  return {
    adapter,
    setTextCalls,
    setCursorCalls,
    forceRenderCalls: () => forceRenderCalls,
    fireText: (e) => { for (const h of textHandlers) h(e); },
    fireCursor: (e) => { for (const h of cursorHandlers) h(e); },
  };
}

const PID_INJECT = `/tmp/opencues-inject-${process.pid}.txt`;
const PID_DUMP = `/tmp/opencues-agentic-dump-${process.pid}.json`;
const PID_FILE = '/tmp/opencues-agentic.pid';
const PID_EVENTS = `/tmp/opencues-events-${process.pid}.jsonl`;

function cleanupFiles(): void {
  for (const p of [PID_INJECT, PID_DUMP, PID_FILE, PID_EVENTS]) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
  delete process.env.OPENCUES_AGENTIC_PID_FILE;
  delete process.env.OPENCUES_AGENTIC_EVENTS_FILE;
}

/** Read the events file as an array of EventEnvelopes. */
function readEvents(path: string = PID_EVENTS): AgenticEvent[] {
  if (!fs.existsSync(path)) return [];
  return fs.readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as AgenticEvent);
}

/** Filter events by tagged-union type. */
function eventsOfType<T extends AgenticEventBody['type']>(
  events: AgenticEvent[],
  type: T,
): Extract<AgenticEventBody, { type: T }>[] {
  return events
    .filter(e => e.body.type === type)
    .map(e => e.body) as Extract<AgenticEventBody, { type: T }>[];
}

// ─── Suite ───────────────────────────────────────────────────────────────

describe('agentic harness — startAgenticHarness', () => {
  beforeEach(cleanupFiles);
  afterEach(cleanupFiles);

  // ── Lifecycle ──

  it('returns a handle with stop() + poll() + paths (inject, dump, pid, events)', () => {
    const { adapter } = makeStubAdapter();
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    expect(typeof h.stop).toBe('function');
    expect(typeof h.poll).toBe('function');
    expect(h.paths.inject).toBe(PID_INJECT);
    expect(h.paths.dump).toBe(PID_DUMP);
    expect(h.paths.pid).toBe(PID_FILE);
    expect(h.paths.events).toBe(PID_EVENTS);
    h.stop();
  });

  it('writes pidfile + events file on arm; cleans pidfile on stop', () => {
    const { adapter } = makeStubAdapter();
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    expect(fs.existsSync(PID_FILE)).toBe(true);
    expect(fs.readFileSync(PID_FILE, 'utf8').trim()).toBe(String(process.pid));
    expect(fs.existsSync(PID_EVENTS)).toBe(true);
    h.stop();
    expect(fs.existsSync(PID_FILE)).toBe(false);
  });

  it('emits harness.armed with host + capabilities on arm', () => {
    const { adapter } = makeStubAdapter();
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    const events = readEvents();
    const armed = eventsOfType(events, 'harness.armed');
    expect(armed).toHaveLength(1);
    expect(armed[0]).toMatchObject({
      type: 'harness.armed',
      host: 'stub-host',
      hostVersion: '0.0.0',
    });
    expect(armed[0].capabilities).toContain('file-read');
    h.stop();
  });

  it('emits harness.stopped on stop + closes the events stream', () => {
    const { adapter } = makeStubAdapter();
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    h.stop();
    const events = readEvents();
    const stopped = eventsOfType(events, 'harness.stopped');
    expect(stopped).toHaveLength(1);
  });

  it('every event carries the schema version + pid + monotonic ts', () => {
    const { adapter } = makeStubAdapter();
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    fs.writeFileSync(PID_INJECT, 'text:hello');
    h.poll();
    const events = readEvents();
    expect(events.length).toBeGreaterThan(1);
    for (const e of events) {
      expect(e.v).toBe(AGENTIC_EVENT_SCHEMA_VERSION);
      expect(e.pid).toBe(process.pid);
      expect(typeof e.ts).toBe('number');
    }
    // Monotonic non-decreasing within the file
    for (let i = 1; i < events.length; i++) {
      expect(events[i].ts).toBeGreaterThanOrEqual(events[i - 1].ts);
    }
    h.stop();
  });

  it('OPENCUES_AGENTIC_EVENTS_FILE overrides the events path', () => {
    const customPath = '/tmp/opencues-events-test-override.jsonl';
    process.env.OPENCUES_AGENTIC_EVENTS_FILE = customPath;
    try {
      const { adapter } = makeStubAdapter();
      const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
      expect(h.paths.events).toBe(customPath);
      expect(fs.existsSync(customPath)).toBe(true);
      h.stop();
    } finally {
      try { fs.unlinkSync('/tmp/opencues-events-test-override.jsonl'); } catch { /* ignore */ }
    }
  });

  it('OPENCUES_AGENTIC_PID_FILE overrides the pidfile path; stop deletes it', () => {
    const customPath = '/tmp/opencues-agentic-test-override.pid';
    process.env.OPENCUES_AGENTIC_PID_FILE = customPath;
    try {
      const { adapter } = makeStubAdapter();
      const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
      expect(h.paths.pid).toBe(customPath);
      expect(fs.existsSync(customPath)).toBe(true);
      expect(fs.readFileSync(customPath, 'utf8').trim()).toBe(String(process.pid));
      h.stop();
      expect(fs.existsSync(customPath)).toBe(false);
    } finally {
      try { fs.unlinkSync('/tmp/opencues-agentic-test-override.pid'); } catch { /* ignore */ }
    }
  });

  it('stop() does NOT delete a pidfile owned by a different (newer) pid', () => {
    const { adapter } = makeStubAdapter();
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    fs.writeFileSync(PID_FILE, '99999999');
    h.stop();
    expect(fs.existsSync(PID_FILE)).toBe(true);
    expect(fs.readFileSync(PID_FILE, 'utf8').trim()).toBe('99999999');
  });

  it('stop() is idempotent', () => {
    const { adapter } = makeStubAdapter();
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    h.stop();
    expect(() => h.stop()).not.toThrow();
  });

  // ── Inject command flow ──

  it('text:<s> calls setText + forceRender + emits text.injected (source=user)', () => {
    const { adapter, setTextCalls, forceRenderCalls } = makeStubAdapter();
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    fs.writeFileSync(PID_INJECT, 'text:hello world');
    h.poll();
    expect(setTextCalls).toEqual(['hello world']);
    expect(forceRenderCalls()).toBe(1);
    expect(fs.existsSync(PID_INJECT)).toBe(false);

    const injects = eventsOfType(readEvents(), 'text.injected');
    expect(injects).toEqual([{ type: 'text.injected', text: 'hello world', source: 'user', cursor: 0 }]);
    h.stop();
  });

  it('text-keep-hl:<s> emits text.injected with source=runtime', () => {
    const { adapter } = makeStubAdapter();
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    fs.writeFileSync(PID_INJECT, 'text-keep-hl:agent rewrote this');
    h.poll();
    const injects = eventsOfType(readEvents(), 'text.injected');
    expect(injects[0].source).toBe('runtime');
    expect(injects[0].text).toBe('agent rewrote this');
    h.stop();
  });

  it('text:<s> fires notifyTextChange when host wired it', () => {
    const { adapter } = makeStubAdapter();
    const textChangeCalls: Array<[string, number, string]> = [];
    const h = startAgenticHarness({
      adapter,
      dispatchKey: () => false,
      notifyTextChange: (t, c, s) => textChangeCalls.push([t, c, s]),
      state: {},
    });
    fs.writeFileSync(PID_INJECT, 'text:the lawyer filed today');
    h.poll();
    expect(textChangeCalls).toEqual([['the lawyer filed today', 0, 'user']]);
    h.stop();
  });

  it('cursor:<n> calls setCursorOffset + emits cursor.injected', () => {
    const { adapter, setCursorCalls } = makeStubAdapter({ text: 'hello', cursor: 0 });
    const cursorChangeCalls: Array<[string, number, string]> = [];
    const h = startAgenticHarness({
      adapter,
      dispatchKey: () => false,
      notifyCursorChange: (t, c, s) => cursorChangeCalls.push([t, c, s]),
      state: {},
    });
    fs.writeFileSync(PID_INJECT, 'cursor:3');
    h.poll();
    expect(setCursorCalls).toEqual([3]);
    expect(cursorChangeCalls).toEqual([['hello', 3, 'user']]);
    expect(eventsOfType(readEvents(), 'cursor.injected')).toEqual([{ type: 'cursor.injected', cursor: 3 }]);
    h.stop();
  });

  it('cursor: ignores non-numeric / negative values and emits command.error', () => {
    const { adapter, setCursorCalls } = makeStubAdapter();
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    fs.writeFileSync(PID_INJECT, 'cursor:abc\ncursor:-5');
    h.poll();
    expect(setCursorCalls).toEqual([]);
    const errors = eventsOfType(readEvents(), 'command.error');
    expect(errors).toHaveLength(2);
    h.stop();
  });

  it('key:<name>:<mods> dispatches a KeyEvent + emits key.dispatched', () => {
    const { adapter } = makeStubAdapter({ text: 'the lawyer filed', cursor: 8 });
    const dispatched: KeyEvent[] = [];
    const dispatchKey = (e: KeyEvent): boolean => { dispatched.push(e); return true; };
    const h = startAgenticHarness({ adapter, dispatchKey, state: {} });
    fs.writeFileSync(PID_INJECT, 'key:up:ctrl+alt');
    h.poll();
    expect(dispatched).toEqual([{
      key: 'up',
      modifiers: { ctrl: true, alt: true, shift: false, meta: false },
      text: 'the lawyer filed',
      cursorOffset: 8,
    }]);
    const keyEvents = eventsOfType(readEvents(), 'key.dispatched');
    expect(keyEvents).toEqual([{
      type: 'key.dispatched',
      key: 'up',
      modifiers: { ctrl: true, alt: true, shift: false, meta: false },
      consumed: true,
    }]);
    h.stop();
  });

  it('key without mods works (escape, bare arrow)', () => {
    const { adapter } = makeStubAdapter();
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

  it('clear empties buffer + cursor + emits cleared', () => {
    const { adapter, setTextCalls, setCursorCalls } = makeStubAdapter({ text: 'something', cursor: 5 });
    const textChangeCalls: Array<[string, number, string]> = [];
    const h = startAgenticHarness({
      adapter,
      dispatchKey: () => false,
      notifyTextChange: (t, c, s) => textChangeCalls.push([t, c, s]),
      state: {},
    });
    fs.writeFileSync(PID_INJECT, 'clear');
    h.poll();
    expect(setTextCalls).toEqual(['']);
    expect(setCursorCalls).toEqual([0]);
    expect(textChangeCalls).toEqual([['', 0, 'user']]);
    expect(eventsOfType(readEvents(), 'cleared')).toEqual([{ type: 'cleared' }]);
    h.stop();
  });

  it('dump writes a JSON file with the canonical shape + emits dump.written', () => {
    const { adapter } = makeStubAdapter({ text: 'the lawyer', cursor: 4 });
    const fakeHl = { active: true, wordIndex: 1, text: 'the lawyer' };
    const h = startAgenticHarness({
      adapter,
      dispatchKey: () => false,
      state: { hlState: fakeHl },
    });
    fs.writeFileSync(PID_INJECT, 'dump');
    h.poll();
    expect(fs.existsSync(PID_DUMP)).toBe(true);
    const dump = JSON.parse(fs.readFileSync(PID_DUMP, 'utf8'));
    expect(dump.text).toBe('the lawyer');
    expect(dump.cursor).toBe(4);
    expect(dump.host).toBe('stub-host');
    expect(dump.highlight).toMatchObject({ active: true, wordIndex: 1 });
    expect(dump.v).toBe(AGENTIC_EVENT_SCHEMA_VERSION);
    expect(eventsOfType(readEvents(), 'dump.written')).toEqual([{ type: 'dump.written', path: PID_DUMP }]);
    h.stop();
  });

  it('multi-line scripts run sequentially + each command emits its own event', () => {
    const { adapter, setTextCalls, setCursorCalls } = makeStubAdapter();
    const h = startAgenticHarness({
      adapter,
      dispatchKey: (e) => e.key === 'left',
      state: {},
    });
    fs.writeFileSync(PID_INJECT, [
      'text:hello',
      'cursor:3',
      'key:left:ctrl+alt',
      'clear',
    ].join('\n'));
    h.poll();
    expect(setTextCalls).toEqual(['hello', '']);
    expect(setCursorCalls).toEqual([3, 0]);
    const events = readEvents();
    expect(eventsOfType(events, 'command').map(e => e.cmd)).toEqual(['text', 'cursor', 'key', 'clear']);
    h.stop();
  });

  it('blank lines + whitespace-only lines are tolerated', () => {
    const { adapter, setTextCalls } = makeStubAdapter();
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    fs.writeFileSync(PID_INJECT, 'text:abc\n\n   \ntext:def\n');
    h.poll();
    expect(setTextCalls).toEqual(['abc', 'def']);
    h.stop();
  });

  it('unknown commands emit command.unknown and do not abort the script', () => {
    const { adapter, setTextCalls } = makeStubAdapter();
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    fs.writeFileSync(PID_INJECT, 'totally-unknown:foo\ntext:after-unknown');
    h.poll();
    expect(setTextCalls).toEqual(['after-unknown']);
    expect(eventsOfType(readEvents(), 'command.unknown')).toHaveLength(1);
    h.stop();
  });

  it('a thrown command emits command.error + does NOT abort subsequent commands', () => {
    const { adapter } = makeStubAdapter();
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
    expect(dispatchCalls).toBe(2);
    const errors = eventsOfType(readEvents(), 'command.error');
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('first dispatch crashes');
    h.stop();
  });

  it('wait:<ms> is a no-op marker (no setText/setCursor/etc.)', () => {
    const { adapter, setTextCalls } = makeStubAdapter();
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    fs.writeFileSync(PID_INJECT, 'wait:500\ntext:after-wait');
    h.poll();
    expect(setTextCalls).toEqual(['after-wait']);
    h.stop();
  });

  it('inject file is deleted before commands run (atomic consume)', () => {
    const { adapter } = makeStubAdapter();
    const h = startAgenticHarness({
      adapter,
      dispatchKey: () => {
        expect(fs.existsSync(PID_INJECT)).toBe(false);
        return true;
      },
      state: {},
    });
    fs.writeFileSync(PID_INJECT, 'key:up:ctrl+alt');
    h.poll();
    h.stop();
  });

  // ── Adapter event subscriptions ──

  it('subscribes to adapter.onTextChange + emits text.changed for each event', () => {
    const stub = makeStubAdapter();
    const h = startAgenticHarness({ adapter: stub.adapter, dispatchKey: () => false, state: {} });
    stub.fireText({ text: 'hello', cursorOffset: 5, source: 'user', previousText: '' });
    stub.fireText({ text: 'hello world', cursorOffset: 11, source: 'user', previousText: 'hello' });
    const changes = eventsOfType(readEvents(), 'text.changed');
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({ text: 'hello', cursor: 5, source: 'user', previousText: '' });
    expect(changes[1]).toMatchObject({ text: 'hello world', cursor: 11 });
    h.stop();
  });

  it('subscribes to adapter.onCursorChange + emits cursor.changed', () => {
    const stub = makeStubAdapter();
    const h = startAgenticHarness({ adapter: stub.adapter, dispatchKey: () => false, state: {} });
    stub.fireCursor({ text: 'hello', cursorOffset: 3, source: 'user' });
    const changes = eventsOfType(readEvents(), 'cursor.changed');
    expect(changes).toEqual([{ type: 'cursor.changed', text: 'hello', cursor: 3, source: 'user' }]);
    h.stop();
  });

  it('after stop(), adapter events stop emitting', () => {
    const stub = makeStubAdapter();
    const h = startAgenticHarness({ adapter: stub.adapter, dispatchKey: () => false, state: {} });
    h.stop();
    stub.fireText({ text: 'should-not-appear', cursorOffset: 0, source: 'user', previousText: '' });
    const changes = eventsOfType(readEvents(), 'text.changed');
    expect(changes).toEqual([]);
  });

  // ── State probe transitions ──

  it('emits highlight.activated when hlState transitions inactive → active', () => {
    const { adapter } = makeStubAdapter({ text: 'the lawyer filed today', cursor: 0 });
    const hlState = { active: false, wordIndex: null as number | null, text: 'the lawyer filed today' };
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: { hlState } });
    h.poll();
    hlState.active = true;
    hlState.wordIndex = 1;
    h.poll();
    const activated = eventsOfType(readEvents(), 'highlight.activated');
    expect(activated).toEqual([{ type: 'highlight.activated', wordIndex: 1, word: 'lawyer' }]);
    h.stop();
  });

  it('emits highlight.deactivated when hlState transitions active → inactive', () => {
    const { adapter } = makeStubAdapter();
    const hlState = { active: true, wordIndex: 0, text: 'foo' };
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: { hlState } });
    h.poll();
    hlState.active = false;
    h.poll();
    expect(eventsOfType(readEvents(), 'highlight.deactivated')).toHaveLength(1);
    h.stop();
  });

  it('emits highlight.word-changed when wordIndex moves while active', () => {
    const { adapter } = makeStubAdapter();
    const hlState = { active: true, wordIndex: 0, text: 'alpha beta gamma' };
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: { hlState } });
    h.poll();
    hlState.wordIndex = 2;
    h.poll();
    const changes = eventsOfType(readEvents(), 'highlight.word-changed');
    expect(changes).toEqual([{
      type: 'highlight.word-changed',
      wordIndex: 2,
      word: 'gamma',
      previousWordIndex: 0,
    }]);
    h.stop();
  });

  it('does NOT emit highlight events when state is unchanged across ticks', () => {
    const { adapter } = makeStubAdapter();
    const hlState = { active: true, wordIndex: 1, text: 'foo bar' };
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: { hlState } });
    h.poll();
    h.poll();
    h.poll();
    const events = readEvents();
    const hlEvents = events.filter(e => e.body.type.startsWith('highlight.'));
    // exactly one — the initial probe captures activation
    expect(hlEvents).toHaveLength(1);
    h.stop();
  });

  it('emits agent-task.armed when AgentTaskState transitions disarmed → armed', () => {
    const { adapter } = makeStubAdapter();
    const agentTaskState = { armed: false, taskId: null as string | null, prompt: '', armedAt: 0 };
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: { agentTaskState } });
    h.poll();
    agentTaskState.armed = true;
    agentTaskState.taskId = 'tsk_abc';
    agentTaskState.prompt = 'fix typos';
    h.poll();
    expect(eventsOfType(readEvents(), 'agent-task.armed')).toEqual([{
      type: 'agent-task.armed',
      taskId: 'tsk_abc',
      prompt: 'fix typos',
    }]);
    h.stop();
  });

  it('emits agent-task.stopped when AgentTaskState transitions armed → disarmed', () => {
    const { adapter } = makeStubAdapter();
    const agentTaskState = { armed: true, taskId: 'tsk_abc', prompt: 'fix typos', armedAt: 1 };
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: { agentTaskState } });
    h.poll();
    agentTaskState.armed = false;
    agentTaskState.taskId = null;
    h.poll();
    expect(eventsOfType(readEvents(), 'agent-task.stopped')).toHaveLength(1);
    h.stop();
  });

  it('emits span-fill.started when SpanFillState gets a current entry', () => {
    const { adapter } = makeStubAdapter();
    const spanFillState = { current: null as unknown, lastFilledText: '' };
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: { spanFillState } });
    h.poll();
    spanFillState.current = { kind: 'transform-blank', blankName: 'transform' };
    h.poll();
    const started = eventsOfType(readEvents(), 'span-fill.started');
    expect(started).toHaveLength(1);
    h.stop();
  });

  it('emits span-fill.completed when SpanFillState clears its current entry', () => {
    const { adapter } = makeStubAdapter();
    const spanFillState = { current: { kind: 'a' } as unknown, lastFilledText: 'old' };
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: { spanFillState } });
    h.poll();
    spanFillState.current = null;
    spanFillState.lastFilledText = 'fresh result';
    h.poll();
    expect(eventsOfType(readEvents(), 'span-fill.completed')).toEqual([{
      type: 'span-fill.completed',
      lastFilledText: 'fresh result',
    }]);
    h.stop();
  });

  it('emits dyn-defs.size-changed when DynDefs size moves', () => {
    const { adapter } = makeStubAdapter();
    const dynDefs = { size: 0 };
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: { dynDefs } });
    h.poll();
    dynDefs.size = 3;
    h.poll();
    expect(eventsOfType(readEvents(), 'dyn-defs.size-changed')).toEqual([
      { type: 'dyn-defs.size-changed', size: 3, previousSize: 0 },
    ]);
    h.stop();
  });

  // ── Dump shape ──

  it('dump serializes DynDefs._defs Map as array of {wordIndex, ...def}', () => {
    const { adapter } = makeStubAdapter({ text: 'the lawyer filed today', cursor: 0 });
    const def = {
      originalWord: 'lawyer',
      alternatives: ['lawyer', 'attorney'],
      currentIndex: 0,
    };
    const dynDefs = { _defs: new Map([[1, def]]), size: 1 };
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: { dynDefs } });
    fs.writeFileSync(PID_INJECT, 'dump');
    h.poll();
    const dump = JSON.parse(fs.readFileSync(PID_DUMP, 'utf8'));
    expect(dump.dynDefs.defs).toEqual([{
      wordIndex: 1,
      originalWord: 'lawyer',
      alternatives: ['lawyer', 'attorney'],
      currentIndex: 0,
    }]);
    expect(dump.dynDefs.size).toBe(1);
    h.stop();
  });

  it('dump strips private _-prefixed fields from state class snapshots', () => {
    const { adapter } = makeStubAdapter();
    // Plain object that mimics HighlightState's private fields.
    const hlState = {
      active: true, wordIndex: 1, text: 'foo bar',
      _active: 'STALE', _wordIndex: 99, _text: 'STALE',
    };
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: { hlState } });
    fs.writeFileSync(PID_INJECT, 'dump');
    h.poll();
    const dump = JSON.parse(fs.readFileSync(PID_DUMP, 'utf8'));
    expect(dump.highlight._active).toBeUndefined();
    expect(dump.highlight._wordIndex).toBeUndefined();
    expect(dump.highlight._text).toBeUndefined();
    expect(dump.highlight.active).toBe(true);
    expect(dump.highlight.wordIndex).toBe(1);
    h.stop();
  });

  // ── Polling ──

  it('poll() is a no-op when no inject file exists', () => {
    const { adapter, setTextCalls } = makeStubAdapter();
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    h.poll();
    expect(setTextCalls).toEqual([]);
    h.stop();
  });

  it('stop() halts the polling timer; subsequent file writes are not processed', async () => {
    const { adapter, setTextCalls } = makeStubAdapter();
    const h = startAgenticHarness({ adapter, dispatchKey: () => false, state: {} });
    h.stop();
    fs.writeFileSync(PID_INJECT, 'text:should-not-process');
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(setTextCalls).toEqual([]);
    expect(fs.existsSync(PID_INJECT)).toBe(true);
  });

  // ── Schema version exposed ──

  it('AGENTIC_EVENT_SCHEMA_VERSION is a positive integer', () => {
    expect(AGENTIC_EVENT_SCHEMA_VERSION).toBe(1);
    expect(Number.isInteger(AGENTIC_EVENT_SCHEMA_VERSION)).toBe(true);
  });
});
