// Pin the source-reclassification + log-factory contracts so any host
// regression (chrome's writeText forgetting to markRuntimeWrite, opencode
// dropping the debug gate, etc.) trips here instead of being discovered
// via "wait, why are my fills getting overwritten by Resolver?" in live
// testing.

import { describe, it, expect, vi } from 'vitest';
import { createSourceReclassifier, createLogFunction } from './boot-common';

describe('createSourceReclassifier', () => {
  it('returns the proposed source when no runtime write was marked', () => {
    const r = createSourceReclassifier();
    expect(r.reclassify('hello', 'user')).toBe('user');
    expect(r.reclassify('hello', 'runtime')).toBe('runtime');
  });

  it("flips proposed='user' to 'runtime' when text matches the marked write", () => {
    const r = createSourceReclassifier();
    r.markRuntimeWrite('hello world');
    expect(r.reclassify('hello world', 'user')).toBe('runtime');
  });

  it('clears the stash after one match (subsequent identical user text stays user)', () => {
    const r = createSourceReclassifier();
    r.markRuntimeWrite('hello');
    expect(r.reclassify('hello', 'user')).toBe('runtime');
    // Second time with same text — stash already cleared, treat as user edit.
    expect(r.reclassify('hello', 'user')).toBe('user');
  });

  it('keeps proposed source when text does not match marked write', () => {
    const r = createSourceReclassifier();
    r.markRuntimeWrite('runtime wrote this');
    expect(r.reclassify('user typed this', 'user')).toBe('user');
    // Stash NOT cleared on miss — runtime write is still pending.
    expect(r.reclassify('runtime wrote this', 'user')).toBe('runtime');
  });

  it('overwrites the stash when markRuntimeWrite is called twice', () => {
    const r = createSourceReclassifier();
    r.markRuntimeWrite('first');
    r.markRuntimeWrite('second');
    // Only the latest write is matched.
    expect(r.reclassify('first', 'user')).toBe('user');
    expect(r.reclassify('second', 'user')).toBe('runtime');
  });
});

describe('createLogFunction', () => {
  it('forwards every level to the sink when no gate is supplied', () => {
    const sink = vi.fn();
    const log = createLogFunction({ sink });
    log('info', 'hello');
    log('warn', 'careful');
    log('error', 'broken');
    log('debug', 'noisy');
    expect(sink).toHaveBeenCalledTimes(4);
  });

  it('drops debug-level when isDebugEnabled returns false', () => {
    const sink = vi.fn();
    const log = createLogFunction({ sink, isDebugEnabled: () => false });
    log('debug', 'should not fire');
    log('info', 'should fire');
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith('info', 'should fire', undefined);
  });

  it('forwards debug-level when isDebugEnabled returns true', () => {
    const sink = vi.fn();
    const log = createLogFunction({ sink, isDebugEnabled: () => true });
    log('debug', 'noisy', { extra: 1 });
    expect(sink).toHaveBeenCalledWith('debug', 'noisy', { extra: 1 });
  });

  it('re-evaluates isDebugEnabled on every call (lazy gate)', () => {
    const sink = vi.fn();
    let enabled = false;
    const log = createLogFunction({ sink, isDebugEnabled: () => enabled });
    log('debug', 'pre-flip'); // dropped
    enabled = true;
    log('debug', 'post-flip'); // kept
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith('debug', 'post-flip', undefined);
  });

  it('swallows sink throws so logging never crashes the runtime', () => {
    const sink = vi.fn(() => { throw new Error('disk full'); });
    const log = createLogFunction({ sink });
    expect(() => log('error', 'normal')).not.toThrow();
    expect(sink).toHaveBeenCalledOnce();
  });
});
