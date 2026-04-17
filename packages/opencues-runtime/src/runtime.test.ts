import { describe, expect, it } from 'vitest';
import { Runtime } from './runtime';
import { HOST_ADAPTER_INTERFACE_VERSION } from './adapter';
import { MockAdapter } from '../testing/mock-adapter';
import { adapterConformanceSuite } from '../testing/conformance';

describe('MockAdapter', () => {
  adapterConformanceSuite(() => new MockAdapter());
});

describe('Runtime.create', () => {
  it('succeeds with a conforming adapter', async () => {
    const adapter = new MockAdapter();
    const runtime = await Runtime.create(adapter);
    expect(runtime).toBeInstanceOf(Runtime);
    expect(runtime.adapter).toBe(adapter);
    const startup = adapter.logs.find(l => l.msg === 'OpenCues runtime starting');
    expect(startup).toBeDefined();
    expect(startup?.level).toBe('info');
  });

  it('throws on interface version mismatch', async () => {
    const adapter = new MockAdapter();
    (adapter as unknown as { interfaceVersion: number }).interfaceVersion =
      HOST_ADAPTER_INTERFACE_VERSION + 1;
    await expect(Runtime.create(adapter)).rejects.toThrow(/interface version mismatch/);
  });

  it('throws when required capability missing', async () => {
    const adapter = new MockAdapter({ capabilities: [] });
    await expect(Runtime.create(adapter)).rejects.toThrow(/file-read/);
  });

  it('dispose is idempotent and unsubscribes handlers', async () => {
    const adapter = new MockAdapter();
    const runtime = await Runtime.create(adapter);
    let calls = 0;
    runtime._trackSubscription(() => { calls += 1; });
    await runtime.dispose();
    await runtime.dispose();
    expect(calls).toBe(1);
    expect(runtime.disposed).toBe(true);
  });
});
