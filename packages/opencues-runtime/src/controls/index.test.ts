import { describe, it, expect, vi } from 'vitest';
import { createControlInvoke } from './index';
import type { Control } from './types';

function mockControl(impl: Partial<Control>): Control {
  return {
    name: impl.name ?? 'test',
    readOnly: impl.readOnly ?? false,
    get: impl.get ?? (async () => ''),
    set: impl.set,
    up: impl.up,
    down: impl.down,
  };
}

describe('createControlInvoke', () => {
  it('returns null when controlName not in registry', () => {
    const invoke = createControlInvoke(new Map());
    const handle = invoke({ controlName: 'unknown', action: 'get', args: [] });
    expect(handle).toBeNull();
  });

  it("dispatches 'get' with keyword + context to ctl.get", async () => {
    const get = vi.fn(async () => '$201.66');
    const ctl = mockControl({ name: 'stocks', readOnly: true, get });
    const invoke = createControlInvoke(new Map([['stocks', ctl]]));
    const handle = invoke({ controlName: 'stocks', action: 'get', args: ['AAPL', 'extra', 'context'] });
    expect(handle).not.toBeNull();
    const result = await handle!.result;
    expect(get).toHaveBeenCalledWith('AAPL', ['extra', 'context']);
    expect(result.stdout).toBe('$201.66');
    expect(result.exitCode).toBe(0);
  });

  it("dispatches 'set' with two args, returns empty stdout", async () => {
    const set = vi.fn(async () => undefined);
    const ctl = mockControl({ name: 'volume', readOnly: false, set });
    const invoke = createControlInvoke(new Map([['volume', ctl]]));
    const handle = invoke({ controlName: 'volume', action: 'set', args: ['50%', 'volume'] });
    const result = await handle!.result;
    expect(set).toHaveBeenCalledWith('50%', 'volume');
    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it("dispatches 'up' returning new value as stdout", async () => {
    const up = vi.fn(async () => '60%');
    const ctl = mockControl({ name: 'volume', up });
    const invoke = createControlInvoke(new Map([['volume', ctl]]));
    const result = await invoke({ controlName: 'volume', action: 'up', args: [] })!.result;
    expect(up).toHaveBeenCalled();
    expect(result.stdout).toBe('60%');
  });

  it("dispatches 'down' returning new value as stdout", async () => {
    const down = vi.fn(async () => '40%');
    const ctl = mockControl({ name: 'volume', down });
    const invoke = createControlInvoke(new Map([['volume', ctl]]));
    const result = await invoke({ controlName: 'volume', action: 'down', args: [] })!.result;
    expect(down).toHaveBeenCalled();
    expect(result.stdout).toBe('40%');
  });

  it('captures thrown errors as exitCode=1 stderr', async () => {
    const ctl = mockControl({ get: async () => { throw new Error('boom'); } });
    const invoke = createControlInvoke(new Map([['x', ctl]]));
    const result = await invoke({ controlName: 'x', action: 'get', args: [] })!.result;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('boom');
  });

  it('exposes a no-op kill so callers can ignore process lifecycle', () => {
    const ctl = mockControl({});
    const invoke = createControlInvoke(new Map([['x', ctl]]));
    const handle = invoke({ controlName: 'x', action: 'get', args: [] });
    expect(handle!.kill).toBeInstanceOf(Function);
    expect(() => handle!.kill()).not.toThrow();
  });
});
