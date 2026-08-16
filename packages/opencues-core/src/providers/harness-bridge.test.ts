import { describe, expect, it, afterEach } from 'vitest';
import {
  HARNESS,
  registerHarnessDispatch,
  isHarnessBridgeReady,
  harnessBridgeInfo,
} from './harness-bridge';
import { getProvider, PROVIDER_IDS, useStrictJson } from '../llm-provider';
import type { ChatRequest } from '../llm-provider';

const req = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'deepseek-v4-flash',
  messages: [
    { role: 'system', content: 'RULES' },
    { role: 'user', content: 'The capital of Iceland is _' },
  ],
  ...overrides,
});

let dispose: (() => void) | null = null;
afterEach(() => { dispose?.(); dispose = null; });

describe('harness bridge — registration', () => {
  it('is not ready until a host binds a dispatch', () => {
    expect(isHarnessBridgeReady()).toBe(false);
    expect(harnessBridgeInfo()).toBeNull();
  });

  it('reports the bound route for diagnostics', () => {
    dispose = registerHarnessDispatch(async () => 'x', { host: 'DeepSeek Harness', provider: 'deepseek-official', model: 'deepseek-v4-flash' });
    expect(isHarnessBridgeReady()).toBe(true);
    expect(harnessBridgeInfo()).toMatchObject({ host: 'DeepSeek Harness', model: 'deepseek-v4-flash' });
  });

  it('disposing unbinds', () => {
    const off = registerHarnessDispatch(async () => 'x');
    off();
    expect(isHarnessBridgeReady()).toBe(false);
  });

  it('a stale disposer does not unbind a newer registration', () => {
    // A host that re-registers on reload must not have its live binding
    // torn down when the previous fiber's disposer finally runs.
    const offOld = registerHarnessDispatch(async () => 'old');
    dispose = registerHarnessDispatch(async () => 'new');
    offOld();
    expect(isHarnessBridgeReady()).toBe(true);
  });
});

describe('harness bridge — dispatch', () => {
  it('passes the neutral ChatRequest through and returns the text', async () => {
    let seen: ChatRequest | null = null;
    dispose = registerHarnessDispatch(async r => { seen = r; return 'Reykjavík'; });
    const out = await HARNESS.invokeCli!(req(), { apiKey: '' });
    expect(out).toBe('Reykjavík');
    expect(seen!.model).toBe('deepseek-v4-flash');
    expect(seen!.messages).toHaveLength(2);
  });

  it('fails loudly when the provider is selected with no host bound', async () => {
    await expect(HARNESS.invokeCli!(req(), { apiKey: '' })).rejects.toThrow(/no host dispatch is registered/);
  });

  it('propagates a host failure rather than swallowing it', async () => {
    dispose = registerHarnessDispatch(async () => { throw new Error('MISSING_CREDENTIAL'); });
    await expect(HARNESS.invokeCli!(req(), { apiKey: '' })).rejects.toThrow(/MISSING_CREDENTIAL/);
  });
});

describe('harness bridge — provider registration', () => {
  it('is a known provider id', () => {
    expect(PROVIDER_IDS).toContain('harness');
    expect(getProvider('harness')?.id).toBe('harness');
  });

  it('uses the cli transport, so the HTTP path is never taken', () => {
    expect(HARNESS.transport).toBe('cli');
    expect(() => HARNESS.buildRequest(req(), { apiKey: '' })).toThrow(/not used/);
    expect(() => HARNESS.parseResponse('{}')).toThrow(/not used/);
  });

  it('needs no env key', () => {
    expect(HARNESS.envKeyName).toBe('');
  });

  it('does NOT claim strict JSON — sources take their prompt-based path', () => {
    // A host bridge cannot promise constrained decoding.
    expect(useStrictJson('harness', 'deepseek-v4-flash')).toBe(false);
  });
});

describe('harness bridge — zero-key auto-selection', () => {
  it('is NOT auto-picked when no host has bound a bridge', async () => {
    const { pickAutoProvider } = await import('../llm-provider');
    // No keys, no binding: nothing to route to. A host that never bound a
    // dispatch must not be handed traffic it cannot serve.
    expect(pickAutoProvider({}, { isCliAvailable: () => false })).toBeNull();
  });

  it('is auto-picked with zero keys once a host binds one', async () => {
    const { pickAutoProvider } = await import('../llm-provider');
    dispose = registerHarnessDispatch(async () => 'x');
    expect(pickAutoProvider({}, { isCliAvailable: () => false })).toBe('harness');
  });

  it('still loses to a real key — an explicit key is a stronger signal', async () => {
    const { pickAutoProvider } = await import('../llm-provider');
    dispose = registerHarnessDispatch(async () => 'x');
    expect(pickAutoProvider({ CEREBRAS_API_KEY: 'sk-x' }, { isCliAvailable: () => false })).toBe('cerebras');
  });
});
