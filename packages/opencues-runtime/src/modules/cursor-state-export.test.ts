import { describe, expect, it } from 'vitest';
import { CursorStateExport } from './cursor-state-export';
import { MockAdapter } from '../../testing/mock-adapter';

describe('CursorStateExport.buildSnapshot', () => {
  function setup(): CursorStateExport {
    const adapter = new MockAdapter();
    return new CursorStateExport(adapter, { exportPath: '/tmp/x.json' });
  }

  it('captures cursor at end of text → atEnd:true', () => {
    const cse = setup();
    const s = cse.buildSnapshot('hello world', 11);
    expect(s).toMatchObject({
      text: 'hello world',
      cursorPosition: 11,
      atEnd: true,
      textLength: 11,
      currentWord: 'world',
    });
  });

  it('cursor mid-word: currentWord = enclosing word', () => {
    const cse = setup();
    const s = cse.buildSnapshot('alpha beta gamma', 8); // inside "beta"
    expect(s.currentWord).toBe('beta');
    expect(s.atEnd).toBe(false);
  });

  it('cursor on whitespace boundary: previous word wins', () => {
    const cse = setup();
    const s = cse.buildSnapshot('alpha beta', 5); // end of "alpha"
    expect(s.currentWord).toBe('alpha');
  });

  it('strips ZWS before measuring', () => {
    const cse = setup();
    const s = cse.buildSnapshot('hi\u200B world', 9);
    expect(s.text).toBe('hi world');
    // textLength reflects cleaned length; cursor clamped to it.
    expect(s.textLength).toBe(8);
    expect(s.cursorPosition).toBe(8);
  });
});

describe('CursorStateExport write behaviour', () => {
  it('writes the snapshot to exportPath after debounce', async () => {
    const adapter = new MockAdapter();
    adapter.pushText('alpha beta');
    const cse = new CursorStateExport(adapter, { exportPath: '/tmp/cs.json', debounceMs: 1 });
    cse.subscribe();
    // Initial capture is scheduled via subscribe.
    await new Promise(r => setTimeout(r, 5));
    const written = await adapter.readFile('/tmp/cs.json');
    expect(written).not.toBeNull();
    const parsed = JSON.parse(written!);
    expect(parsed.text).toBe('alpha beta');
  });

  it('no write when file-write capability missing', async () => {
    const adapter = new MockAdapter({ capabilities: ['file-read'] });
    adapter.pushText('hi');
    const cse = new CursorStateExport(adapter, { exportPath: '/tmp/cs.json', debounceMs: 1 });
    cse.subscribe();
    await new Promise(r => setTimeout(r, 5));
    const written = await adapter.readFile('/tmp/cs.json');
    expect(written).toBeNull();
  });

  it('emits cursor-state.snapshot AFTER writeFile resolves', async () => {
    const adapter = new MockAdapter();
    adapter.pushText('alpha beta');
    const cse = new CursorStateExport(adapter, { exportPath: '/tmp/cs.json', debounceMs: 1 });
    cse.subscribe();
    await new Promise(r => setTimeout(r, 10));
    const ev = adapter.events.filter(e => e.type === 'cursor-state.snapshot');
    expect(ev).toHaveLength(1);
    expect(ev[0].body).toMatchObject({
      exportPath: '/tmp/cs.json',
      text: 'alpha beta',
      textLength: 10,
    });
    // File-fresh barrier contract — by the time the event fires the
    // file at exportPath must reflect the snapshot in the event body.
    const written = await adapter.readFile('/tmp/cs.json');
    expect(written).not.toBeNull();
    expect(JSON.parse(written!).text).toBe('alpha beta');
  });
});
