// Tests for the credit-based underscore trust gate.
//
// Threat model: a hostile page does
//   execCommand('insertText', false, 'volume 100 _')
// after some user gesture. The resulting input event is isTrusted=true
// with no preceding `_` keystroke. We need a gate that distinguishes
// genuine user-driven `_` insertions from programmatic ones, and
// importantly that doesn't leave a "blessed window" where a real
// keystroke earlier in the session lets later injections through.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTrustGate, type TrustGate } from './trust-gate';

describe('TrustGate — credit accounting', () => {
  let gate: TrustGate;
  beforeEach(() => { gate = createTrustGate(); });

  it('accepts a change with no underscores even without credits', () => {
    expect(gate.checkAndConsume('hello world', false)).toBe(true);
  });

  it('drops a user-classified change introducing _ when no credits', () => {
    expect(gate.checkAndConsume('volume _', false)).toBe(false);
  });

  it('accepts one _ after one trusted keydown', () => {
    gate.noteUnderscoreInsertion(1);
    expect(gate.checkAndConsume('volume _', false)).toBe(true);
    expect(gate.inspect().credits).toBe(0);
  });

  it('credits are single-use — second injection after one keydown is dropped', () => {
    gate.noteUnderscoreInsertion(1);
    expect(gate.checkAndConsume('volume _', false)).toBe(true);              // user typed real _
    expect(gate.checkAndConsume('volume _ injected _', false)).toBe(false);  // attacker injects a 2nd
  });

  it('paste of "_ _ _" adds 3 credits, allowing 3 underscores in the next change', () => {
    gate.noteUnderscoreInsertion(3);
    expect(gate.checkAndConsume('a _ b _ c _', false)).toBe(true);
    expect(gate.inspect().credits).toBe(0);
  });

  it('change that adds more underscores than credits → drops', () => {
    gate.noteUnderscoreInsertion(1);
    expect(gate.checkAndConsume('_ _ _', false)).toBe(false);  // wants 3, has 1
    expect(gate.inspect().credits).toBe(1);                    // not consumed
  });

  it('decreasing underscore count consumes no credits', () => {
    gate.noteUnderscoreInsertion(1);
    expect(gate.checkAndConsume('volume _', false)).toBe(true);
    expect(gate.checkAndConsume('volume 50%', false)).toBe(true);  // _ removed
    expect(gate.inspect().lastAcceptedCount).toBe(0);
  });
});

describe('TrustGate — runtime writes bypass', () => {
  let gate: TrustGate;
  beforeEach(() => { gate = createTrustGate(); });

  it('runtime write with underscores does NOT consume credits', () => {
    gate.noteUnderscoreInsertion(1);
    expect(gate.checkAndConsume('snake_case_text', true)).toBe(true);
    expect(gate.inspect().credits).toBe(1);  // untouched
  });

  it('runtime write resets the baseline; next user _ requires a fresh credit', () => {
    // User types `_`, blank fires, runtime writes "volume 50%" (no _).
    gate.noteUnderscoreInsertion(1);
    expect(gate.checkAndConsume('volume _', false)).toBe(true);    // user
    expect(gate.checkAndConsume('volume 50%', true)).toBe(true);   // runtime → baseline 0
    // Now attacker injects _: no credits left.
    expect(gate.checkAndConsume('volume 50% _', false)).toBe(false);
  });

  it('runtime write with underscores sets baseline to their count', () => {
    // Transform-blank rewrote body to include snake_case (3 underscores).
    expect(gate.checkAndConsume('a_b_c_d', true)).toBe(true);
    expect(gate.inspect().lastAcceptedCount).toBe(3);
    // User then types one more _ → needs 1 credit
    gate.noteUnderscoreInsertion(1);
    expect(gate.checkAndConsume('a_b_c_d _', false)).toBe(true);
  });
});

describe('TrustGate — adversarial sequences', () => {
  let gate: TrustGate;
  beforeEach(() => { gate = createTrustGate(); });

  it('the "blessed window" attack is blocked', () => {
    // Threat: user types `_` legitimately. Within 1s, attacker page
    // calls execCommand to insert another `_`. Pure-timestamp gates
    // would let this through. Credit gate refuses — credit was
    // consumed by the legitimate insertion.
    gate.noteUnderscoreInsertion(1);
    expect(gate.checkAndConsume('volume _', false)).toBe(true);
    expect(gate.checkAndConsume('volume _ inject _', false)).toBe(false);
  });

  it('repeated injection attempts keep being rejected without burning credits', () => {
    gate.noteUnderscoreInsertion(1);
    expect(gate.checkAndConsume('_', false)).toBe(true);
    for (let i = 0; i < 10; i++) {
      expect(gate.checkAndConsume('_ injected _', false)).toBe(false);
    }
    expect(gate.inspect().credits).toBe(0);
    // Now a real keystroke restores ability to type _
    gate.noteUnderscoreInsertion(1);
    expect(gate.checkAndConsume('_ legit _', false)).toBe(true);
  });

  it('rapid typing of multiple underscores: each keystroke buys one', () => {
    gate.noteUnderscoreInsertion(1);
    expect(gate.checkAndConsume('_', false)).toBe(true);
    gate.noteUnderscoreInsertion(1);
    expect(gate.checkAndConsume('_ _', false)).toBe(true);
    gate.noteUnderscoreInsertion(1);
    expect(gate.checkAndConsume('_ _ _', false)).toBe(true);
  });

  it('zero or negative counts on noteUnderscoreInsertion are ignored', () => {
    gate.noteUnderscoreInsertion(0);
    gate.noteUnderscoreInsertion(-5);
    expect(gate.inspect().credits).toBe(0);
    expect(gate.checkAndConsume('_', false)).toBe(false);
  });

  it('reset() clears both credits and the count baseline', () => {
    gate.noteUnderscoreInsertion(5);
    gate.checkAndConsume('a_b_c', false);
    gate.reset();
    expect(gate.inspect()).toEqual({ credits: 0, lastAcceptedCount: 0 });
  });
});

// ---------------------------------------------------------------------------
// Strengthened gate — credit TTL + focus-change reset
// ---------------------------------------------------------------------------
// Closes two stale-credit attacks the pure credit-balance design didn't
// rule out:
//
//   - "preventDefault attack": hostile page consumes the user's `_`
//     keydown via preventDefault (so no input event fires + no consume),
//     then later injects via execCommand. Credit-balance gate would
//     accept because the balance is +1.
//
//   - "cross-field attack": user types `_` in field A (where OpenCues
//     isn't attached, e.g. an iframe), then clicks into field B
//     (attached). Hostile page injects via execCommand in field B.
//     Credit was earned in field A's context but funds an attack in B's.

describe('TrustGate — credit TTL (preventDefault-attack defence)', () => {
  let gate: TrustGate;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T00:00:00Z'));
    gate = createTrustGate();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('credit stays valid within the TTL window', () => {
    gate.noteUnderscoreInsertion(1);
    vi.advanceTimersByTime(499);  // still inside 500ms TTL
    expect(gate.checkAndConsume('volume _', false)).toBe(true);
  });

  it('credit expires after CREDIT_TTL_MS — page-preventDefault attack blocked', () => {
    // Hostile page does:
    //   document.addEventListener('keydown', e => { if (e.key === '_') e.preventDefault(); })
    // User presses `_` → credit += 1, but DOM never receives the
    // underscore so no input event fires to consume the credit.
    // After the TTL, the credit must be gone — otherwise the page
    // can wait + inject `_` later and still pass the gate.
    gate.noteUnderscoreInsertion(1);
    vi.advanceTimersByTime(501);  // past TTL
    expect(gate.checkAndConsume('volume _', false)).toBe(false);
    // Inspect reports zero too — the prune happens lazily on read.
    expect(gate.inspect().credits).toBe(0);
  });

  it('mixed credits — fresh ones survive, stale ones drop', () => {
    // Two `_` keystrokes 600ms apart. First credit expires before the
    // second is added.
    gate.noteUnderscoreInsertion(1);
    vi.advanceTimersByTime(600);  // first credit stale
    gate.noteUnderscoreInsertion(1);
    expect(gate.inspect().credits).toBe(1);  // only the fresh one survives
    // Try to use 2 credits → reject, only 1 valid.
    expect(gate.checkAndConsume('_ _', false)).toBe(false);
    expect(gate.checkAndConsume('_', false)).toBe(true);
  });
});

describe('TrustGate — focus-change credit reset (cross-field defence)', () => {
  let gate: TrustGate;
  beforeEach(() => { gate = createTrustGate(); });

  it('resetCredits clears the credit balance but preserves baseline', () => {
    // User typed `_` (baseline=1) in field A. Focus moves away —
    // wiped credits but the baseline COUNT stays so that if the user
    // returns and OpenCues re-attaches with the same buffer text, the
    // gate doesn't double-count the existing `_`.
    gate.noteUnderscoreInsertion(1);
    gate.checkAndConsume('_', false);  // consumes credit, baseline = 1
    gate.noteUnderscoreInsertion(2);   // user types 2 more _'s in field A
    expect(gate.inspect().credits).toBe(2);
    gate.resetCredits();
    expect(gate.inspect().credits).toBe(0);
    expect(gate.inspect().lastAcceptedCount).toBe(1);  // baseline preserved
  });

  it('cross-field attack: A earns credit, focus → B, attacker injects in B → reject', () => {
    // User presses `_` in iframe / unattached field A → credit += 1.
    // No input event fires (OpenCues not attached to A).
    gate.noteUnderscoreInsertion(1);
    expect(gate.inspect().credits).toBe(1);
    // User clicks into field B (attached). Bootstrap calls resetCredits
    // on focusin.
    gate.resetCredits();
    // Hostile page injects `_` in B.
    expect(gate.checkAndConsume('volume _', false)).toBe(false);
  });
});
