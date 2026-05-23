// Pin the source-reclassification + log-factory contracts so any host
// regression (chrome's writeText forgetting to markRuntimeWrite, opencode
// dropping the debug gate, etc.) trips here instead of being discovered
// via "wait, why are my fills getting overwritten by Resolver?" in live
// testing.

import { describe, it, expect, vi } from 'vitest';
import { createSourceReclassifier, createLogFunction, RUNTIME_WRITE_TTL_MS } from './boot-common';

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

  // MULTI-SHOT contract — the May 2026 runaway-loop regression fix.
  //
  // Old one-shot semantics: only the FIRST echo input event after a
  // runtime write was reclassified. The 2nd-Nth echoes (Gmail/Lexical/
  // ProseMirror reconcilers fire 2-4 input events per programmatic
  // write) got tagged 'user' and reached the Resolver, which then
  // fired the `_`-pipeline on the runtime's own substituted buffer.
  // If the LLM had left a `_` in its rewrite (translation prompts
  // commonly do — `translate to japanese _` preserves the `_` as a
  // non-translatable glyph), this re-fired ConfigIntent + TransformBlank
  // + FluidBlank. Observed: one user `_ trigger` → 4 full cycles in
  // 7 seconds on chrome (12 LLM calls instead of 3).
  it('multi-shot: every echo within TTL of one write reclassifies to runtime', () => {
    const r = createSourceReclassifier();
    r.markRuntimeWrite('rewrite');
    expect(r.reclassify('rewrite', 'user')).toBe('runtime');
    // 2nd-4th echo from the same write (DOM reconciler re-fires).
    expect(r.reclassify('rewrite', 'user')).toBe('runtime');
    expect(r.reclassify('rewrite', 'user')).toBe('runtime');
    expect(r.reclassify('rewrite', 'user')).toBe('runtime');
  });

  it('echo events past TTL stop reclassifying', () => {
    let now = 1_000_000;
    const r = createSourceReclassifier(() => now);
    r.markRuntimeWrite('rewrite');
    now += RUNTIME_WRITE_TTL_MS - 1;
    expect(r.reclassify('rewrite', 'user')).toBe('runtime');
    now += 2;  // now past TTL
    expect(r.reclassify('rewrite', 'user')).toBe('user');
  });

  it('keeps proposed source when text does not match any marked write', () => {
    const r = createSourceReclassifier();
    r.markRuntimeWrite('runtime wrote this');
    expect(r.reclassify('user typed this', 'user')).toBe('user');
    // Stash still has the original — matching text still reclassifies.
    expect(r.reclassify('runtime wrote this', 'user')).toBe('runtime');
  });

  it('remembers multiple recent writes (back-to-back substitutes)', () => {
    let now = 1_000_000;
    const r = createSourceReclassifier(() => now);
    r.markRuntimeWrite('first');
    now += 50;  // well within TTL
    r.markRuntimeWrite('second');
    // BOTH writes are remembered — echoes from either reclassify.
    expect(r.reclassify('first', 'user')).toBe('runtime');
    expect(r.reclassify('second', 'user')).toBe('runtime');
    // Identical text echoed multiple times stays runtime within window.
    expect(r.reclassify('first', 'user')).toBe('runtime');
  });

  it('a user keystroke after TTL is correctly classified', () => {
    let now = 1_000_000;
    const r = createSourceReclassifier(() => now);
    r.markRuntimeWrite('the same text');
    now += RUNTIME_WRITE_TTL_MS + 100;
    // User happens to type the same text moments later — past TTL,
    // so genuine user input is preserved.
    expect(r.reclassify('the same text', 'user')).toBe('user');
  });

  it('runtime-proposed source stays runtime even on a miss', () => {
    const r = createSourceReclassifier();
    r.markRuntimeWrite('runtime wrote A');
    // A miss returns the proposed source — proposed='runtime' should pass through.
    expect(r.reclassify('different text', 'runtime')).toBe('runtime');
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
