import { describe, expect, it, vi } from 'vitest';
import { createDaemon, type Frame } from './daemon';

/**
 * Build a fresh daemon with a recording `send` callback. Returns the
 * daemon handle plus a `frames` array that captures every emitted frame.
 */
function build() {
  const frames: Frame[] = [];
  const log = vi.fn<[string, string], void>();
  const daemon = createDaemon({
    send: (f) => { frames.push(f); },
    log,
  });
  return { daemon, frames, log };
}

describe('codex daemon — JSON-RPC handler', () => {
  it('ignores blank/whitespace lines (no frames emitted)', () => {
    const { daemon, frames } = build();
    daemon.handleLine('');
    daemon.handleLine('   ');
    daemon.handleLine('\t');
    expect(frames).toEqual([]);
  });

  it('returns parse error (-32700) with id:null on malformed JSON', () => {
    const { daemon, frames } = build();
    daemon.handleLine('not json');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32700 },
      id: null,
    });
    expect((frames[0] as { error: { message: string } }).error.message).toMatch(/parse error/);
  });

  it('returns invalid-request error (-32600) when jsonrpc !== "2.0"', () => {
    const { daemon, frames } = build();
    daemon.handleLine(JSON.stringify({ jsonrpc: '1.0', method: 'boot', id: 1 }));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32600 },
      id: 1,
    });
  });

  it('returns method-not-found error (-32601) for unknown methods', () => {
    const { daemon, frames } = build();
    daemon.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'wat', id: 7 }));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32601, message: 'unknown method: wat' },
      id: 7,
    });
  });

  it('responds to boot request with {ok: true} and flips booted state', () => {
    const { daemon, frames } = build();
    expect(daemon.booted).toBe(false);
    daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'boot',
      params: { hostVersion: 'test', cwd: '/proj' },
      id: 1,
    }));
    expect(daemon.booted).toBe(true);
    expect(frames[0]).toEqual({
      jsonrpc: '2.0',
      result: { ok: true },
      id: 1,
    });
  });

  it('logs the boot params (truncated to 200 chars) via the log callback', () => {
    const { daemon, log } = build();
    daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0', method: 'boot', params: { cwd: '/proj' }, id: 1,
    }));
    expect(log).toHaveBeenCalledWith('info', expect.stringMatching(/^daemon booted /));
  });

  it('responds to key request with {consumed: false} (scaffold; runtime modules TODO)', () => {
    const { daemon, frames } = build();
    daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'key',
      params: {
        key: 'ArrowUp',
        modifiers: { ctrl: true, alt: true, shift: false, meta: false },
        text: 'hello',
        cursorOffset: 5,
      },
      id: 42,
    }));
    expect(frames[0]).toEqual({
      jsonrpc: '2.0',
      result: { consumed: false },
      id: 42,
    });
  });

  it('text-change notification is handled silently (no response, no error)', () => {
    const { daemon, frames } = build();
    daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'text-change',
      params: { text: 'abc', cursorOffset: 1, source: 'user' },
      // no id → notification
    }));
    expect(frames).toEqual([]);
  });

  it('force-render notification is handled silently (no response yet — TODO directives emit)', () => {
    const { daemon, frames } = build();
    daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'force-render',
    }));
    expect(frames).toEqual([]);
  });

  it('boot-as-notification (no id) flips state but emits no response frame', () => {
    const { daemon, frames, log } = build();
    daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'boot',
      params: { cwd: '/proj' },
      // no id
    }));
    expect(daemon.booted).toBe(true);
    expect(frames).toEqual([]);
    expect(log).toHaveBeenCalled();
  });

  it('parse-error response always uses id:null (id is unknown when JSON is broken)', () => {
    const { daemon, frames } = build();
    daemon.handleLine('{"id":7, broken');
    expect(frames[0]).toMatchObject({ id: null, error: { code: -32700 } });
  });

  it('handles multiple frames in sequence with independent state', () => {
    const { daemon, frames } = build();
    daemon.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'boot', id: 1 }));
    daemon.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'key', params: {}, id: 2 }));
    daemon.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'unknown', id: 3 }));
    expect(frames).toHaveLength(3);
    expect((frames[0] as { id: number }).id).toBe(1);
    expect((frames[1] as { id: number }).id).toBe(2);
    expect((frames[2] as { id: number }).id).toBe(3);
  });
});
