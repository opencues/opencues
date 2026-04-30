import { describe, it, expect, vi } from 'vitest';
import { createBlankInvoke } from './index';
import type { Blank } from './types';

function mockBlank(impl: Partial<Blank>): Blank {
  return {
    name: impl.name ?? 'test',
    readOnly: impl.readOnly ?? false,
    get: impl.get ?? (async () => ''),
    set: impl.set,
    up: impl.up,
    down: impl.down,
  };
}

describe('createBlankInvoke', () => {
  it('returns null when blankName not in registry', () => {
    const invoke = createBlankInvoke(new Map());
    const handle = invoke({ blankName: 'unknown', action: 'get', args: [] });
    expect(handle).toBeNull();
  });

  it("dispatches 'get' with keyword + context to ctl.get", async () => {
    const get = vi.fn(async () => '$201.66');
    const ctl = mockBlank({ name: 'stocks', readOnly: true, get });
    const invoke = createBlankInvoke(new Map([['stocks', ctl]]));
    const handle = invoke({ blankName: 'stocks', action: 'get', args: ['AAPL', 'extra', 'context'] });
    expect(handle).not.toBeNull();
    const result = await handle!.result;
    expect(get).toHaveBeenCalledWith('AAPL', ['extra', 'context']);
    expect(result.stdout).toBe('$201.66');
    expect(result.exitCode).toBe(0);
  });

  it("dispatches 'set' with two args, returns empty stdout", async () => {
    const set = vi.fn(async () => undefined);
    const ctl = mockBlank({ name: 'volume', readOnly: false, set });
    const invoke = createBlankInvoke(new Map([['volume', ctl]]));
    const handle = invoke({ blankName: 'volume', action: 'set', args: ['50%', 'volume'] });
    const result = await handle!.result;
    expect(set).toHaveBeenCalledWith('50%', 'volume');
    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it("dispatches 'up' returning new value as stdout", async () => {
    const up = vi.fn(async () => '60%');
    const ctl = mockBlank({ name: 'volume', up });
    const invoke = createBlankInvoke(new Map([['volume', ctl]]));
    const result = await invoke({ blankName: 'volume', action: 'up', args: [] })!.result;
    expect(up).toHaveBeenCalled();
    expect(result.stdout).toBe('60%');
  });

  it("dispatches 'down' returning new value as stdout", async () => {
    const down = vi.fn(async () => '40%');
    const ctl = mockBlank({ name: 'volume', down });
    const invoke = createBlankInvoke(new Map([['volume', ctl]]));
    const result = await invoke({ blankName: 'volume', action: 'down', args: [] })!.result;
    expect(down).toHaveBeenCalled();
    expect(result.stdout).toBe('40%');
  });

  it('captures thrown errors as exitCode=1 stderr', async () => {
    const ctl = mockBlank({ get: async () => { throw new Error('boom'); } });
    const invoke = createBlankInvoke(new Map([['x', ctl]]));
    const result = await invoke({ blankName: 'x', action: 'get', args: [] })!.result;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('boom');
  });

  it('exposes a no-op kill so callers can ignore process lifecycle', () => {
    const ctl = mockBlank({});
    const invoke = createBlankInvoke(new Map([['x', ctl]]));
    const handle = invoke({ blankName: 'x', action: 'get', args: [] });
    expect(handle!.kill).toBeInstanceOf(Function);
    expect(() => handle!.kill()).not.toThrow();
  });
});
