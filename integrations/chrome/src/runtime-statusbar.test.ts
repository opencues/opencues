// Tests for runtime-statusbar.ts — the floating status-bar renderer.
// Covers applyStatuslinePayload's word/tip/cycling/kata/agent-badge
// composition logic, position handling (setStatusbarPosition /
// setPositionResolver / the per-payload refreshPosition() re-read),
// the peek-through pointermove behaviour, and clearStatusbar teardown.
//
// Runs in jsdom (per vitest.config.ts). This module only creates one
// floating <div> and never touches a managed-editor surface, so it's
// in-scope for direct unit testing (unlike content.ts/opencues-bootstrap.ts).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  setStatusbarPosition,
  setPositionResolver,
  applyStatuslinePayload,
  clearStatusbar,
} from './runtime-statusbar';

function bar(): HTMLElement | null {
  return document.querySelector('.oc-status-bar');
}

function isVisible(el: HTMLElement | null): boolean {
  return !!el && el.classList.contains('oc-status-bar--visible');
}

beforeEach(() => {
  clearStatusbar();
  document.body.innerHTML = '';
  // Reset the module-level `position` back to the documented default so
  // tests don't leak position state into one another (setStatusbarPosition
  // is the only way to reach it — clearStatusbar only tears down the el).
  setStatusbarPosition('bottom');
});

describe('applyStatuslinePayload — happy paths', () => {
  it('inactive payload never creates the bar', () => {
    applyStatuslinePayload({ active: false });
    expect(bar()).toBeNull();
  });

  it('active payload with a tip and no alts shows the tip alone', () => {
    applyStatuslinePayload({ active: true, cueTip: 'A helpful tip' });
    expect(bar()!.textContent).toBe('A helpful tip');
    expect(isVisible(bar())).toBe(true);
  });

  it('cueBlank payload shows the tip alone (blank-mode formatting)', () => {
    applyStatuslinePayload({ active: true, cueBlank: true, cueTip: 'Blank tip' });
    expect(bar()!.textContent).toBe('Blank tip');
  });

  it('advisory renders as an ADDITIONAL line beneath the cue', () => {
    applyStatuslinePayload({ active: true, cueTip: 'more formal', advisory: '⚠ the 24th is a Friday, not Thursday' });
    expect(bar()!.querySelector('.oc-status-line')?.textContent).toBe('more formal');
    expect(bar()!.querySelector('.oc-advisory')?.textContent).toBe('⚠ the 24th is a Friday, not Thursday');
  });

  it('advisory shows on its own with no active cue', () => {
    applyStatuslinePayload({ active: false, advisory: '⚠ 250 ÷ 4 = $62.50, not $55' });
    expect(bar()!.querySelector('.oc-status-line')).toBeNull();
    expect(bar()!.querySelector('.oc-advisory')?.textContent).toBe('⚠ 250 ÷ 4 = $62.50, not $55');
  });

  it('cycling with >1 alt renders "<word> (N/M) - <tip>"', () => {
    applyStatuslinePayload({
      active: true,
      highlightedWord: 'foo',
      alts: ['foo', 'bar', 'baz'],
      currentAltIndex: 1,
      cueTip: 'meaning',
    });
    expect(bar()!.textContent).toBe('foo (2/3) - meaning');
  });

  it('cycling with >1 alt but no tip renders just "<word> (N/M)"', () => {
    applyStatuslinePayload({
      active: true,
      highlightedWord: 'foo',
      alts: ['foo', 'bar'],
      currentAltIndex: 0,
      cueTip: null,
    });
    expect(bar()!.textContent).toBe('foo (1/2)');
  });

  it('single-alt array (length<=1) falls back to tip-only formatting', () => {
    applyStatuslinePayload({
      active: true,
      highlightedWord: 'foo',
      alts: ['foo'],
      currentAltIndex: 0,
      cueTip: 'tip-only',
    });
    expect(bar()!.textContent).toBe('tip-only');
  });

  it('agentTask combines with wordPart as "<word> | [task: <task>]"', () => {
    applyStatuslinePayload({ active: true, cueTip: 'tip', agentTask: 'summarize' });
    expect(bar()!.textContent).toBe('tip | [task: summarize]');
  });

  it('agentTask alone (inactive word state) shows just the badge', () => {
    applyStatuslinePayload({ active: false, agentTask: 'summarize' });
    expect(bar()!.textContent).toBe('[task: summarize]');
  });

  it('kata mode overrides word/tip content entirely', () => {
    applyStatuslinePayload({
      active: true,
      cueTip: 'should be ignored',
      kata: { step: 2, stepCount: 5, coach: 'keep going' },
    });
    const el = bar()!;
    expect(el.classList.contains('oc-status-bar--kata')).toBe(true);
    expect(el.querySelector('.oc-kata-head')!.textContent).toBe('C_Kata 2/5');
    expect(el.querySelector('.oc-kata-body')!.textContent).toBe('keep going');
  });

  it('kata with stepCount 0 shows a bare "Kata" head (no counter)', () => {
    applyStatuslinePayload({ active: true, kata: { step: 0, stepCount: 0, coach: 'go' } });
    expect(bar()!.querySelector('.oc-kata-head')!.textContent).toBe('C_Kata');
  });

  it('kata with coachSegments (no coach) joins segment text for the body', () => {
    applyStatuslinePayload({
      active: true,
      kata: {
        step: 1,
        stepCount: 3,
        coach: null,
        coachSegments: [{ text: 'run ', command: false }, { text: 'npm test', command: true }],
      },
    });
    expect(bar()!.querySelector('.oc-kata-body')!.textContent).toBe('run npm test');
  });

  it('kata with neither coach nor coachSegments renders no body element', () => {
    applyStatuslinePayload({ active: true, kata: { step: 1, stepCount: 2, coach: null } });
    expect(bar()!.querySelector('.oc-kata-body')).toBeNull();
  });
});

describe('applyStatuslinePayload — edge cases', () => {
  it('empty/null cueTip with no alts and inactive-equivalent state hides the bar', () => {
    applyStatuslinePayload({ active: true, cueTip: null });
    expect(isVisible(bar())).toBe(false);
  });

  it('switching from an active payload to an inactive one hides (not removes) the bar', () => {
    applyStatuslinePayload({ active: true, cueTip: 'visible now' });
    expect(isVisible(bar())).toBe(true);
    applyStatuslinePayload({ active: false });
    // hide() only drops the --visible modifier; the div persists in the DOM.
    expect(bar()).not.toBeNull();
    expect(isVisible(bar())).toBe(false);
  });

  it('does not truncate very long tip text (no truncation logic present)', () => {
    const longTip = 'x'.repeat(2000);
    applyStatuslinePayload({ active: true, cueTip: longTip });
    expect(bar()!.textContent!.length).toBe(2000);
  });

  it('malformed/empty payload object (missing "active") degrades to hidden, not a crash', () => {
    expect(() => applyStatuslinePayload({} as unknown as Parameters<typeof applyStatuslinePayload>[0])).not.toThrow();
    expect(isVisible(bar())).toBe(false);
  });

  it('re-applying kata mode reuses/rewrites the same element rather than duplicating head/body', () => {
    applyStatuslinePayload({ active: true, kata: { step: 1, stepCount: 4, coach: 'first' } });
    applyStatuslinePayload({ active: true, kata: { step: 2, stepCount: 4, coach: 'second' } });
    const el = bar()!;
    expect(el.querySelectorAll('.oc-kata-head').length).toBe(1);
    expect(el.querySelectorAll('.oc-kata-body').length).toBe(1);
    expect(el.querySelector('.oc-kata-body')!.textContent).toBe('second');
  });

  it('switching from kata mode back to plain text mode removes the --kata modifier', () => {
    applyStatuslinePayload({ active: true, kata: { step: 1, stepCount: 2, coach: 'x' } });
    expect(bar()!.classList.contains('oc-status-bar--kata')).toBe(true);
    applyStatuslinePayload({ active: true, cueTip: 'plain text' });
    expect(bar()!.classList.contains('oc-status-bar--kata')).toBe(false);
    expect(bar()!.textContent).toBe('plain text');
  });
});

describe('position handling', () => {
  it('setStatusbarPosition applies the --pos-* class before the bar is ever shown', () => {
    setStatusbarPosition('right');
    applyStatuslinePayload({ active: true, cueTip: 'x' });
    expect(bar()!.classList.contains('oc-status-bar--pos-right')).toBe(true);
  });

  it('setStatusbarPosition swaps the class on an existing bar', () => {
    applyStatuslinePayload({ active: true, cueTip: 'x' });
    setStatusbarPosition('top');
    expect(bar()!.classList.contains('oc-status-bar--pos-top')).toBe(true);
    expect(bar()!.classList.contains('oc-status-bar--pos-bottom')).toBe(false);
  });

  it('setPositionResolver applies the resolver result immediately', () => {
    setPositionResolver(() => 'right');
    applyStatuslinePayload({ active: true, cueTip: 'x' });
    expect(bar()!.classList.contains('oc-status-bar--pos-right')).toBe(true);
  });

  it('applyStatuslinePayload re-reads the resolver on every call (live scalar-cycling)', () => {
    let current: 'right' | 'bottom' | 'top' = 'bottom';
    setPositionResolver(() => current);
    applyStatuslinePayload({ active: true, cueTip: 'first' });
    expect(bar()!.classList.contains('oc-status-bar--pos-bottom')).toBe(true);

    current = 'top';
    applyStatuslinePayload({ active: true, cueTip: 'second' });
    expect(bar()!.classList.contains('oc-status-bar--pos-top')).toBe(true);
  });
});

describe('peek-through pointermove behaviour', () => {
  function stubRect(el: HTMLElement, rect: { left: number; right: number; top: number; bottom: number }): void {
    el.getBoundingClientRect = () => ({
      left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      width: rect.right - rect.left, height: rect.bottom - rect.top,
      x: rect.left, y: rect.top, toJSON: () => ({}),
    });
  }

  it('pointer moving over a visible bar adds the --peek class', () => {
    applyStatuslinePayload({ active: true, cueTip: 'x' });
    const el = bar()!;
    stubRect(el, { left: 10, right: 100, top: 10, bottom: 40 });
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 50, clientY: 20 }));
    expect(el.classList.contains('oc-status-bar--peek')).toBe(true);
  });

  it('pointer moving away from the bar removes the --peek class', () => {
    applyStatuslinePayload({ active: true, cueTip: 'x' });
    const el = bar()!;
    stubRect(el, { left: 10, right: 100, top: 10, bottom: 40 });
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 50, clientY: 20 }));
    expect(el.classList.contains('oc-status-bar--peek')).toBe(true);
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 500, clientY: 500 }));
    expect(el.classList.contains('oc-status-bar--peek')).toBe(false);
  });

  it('pointer moving over a HIDDEN bar does not add --peek (and clears it if stale)', () => {
    applyStatuslinePayload({ active: true, cueTip: 'x' });
    const el = bar()!;
    stubRect(el, { left: 0, right: 100, top: 0, bottom: 40 });
    // Hide the bar, then move the pointer over its old (still-styled) rect.
    applyStatuslinePayload({ active: false });
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 50, clientY: 20 }));
    expect(el.classList.contains('oc-status-bar--peek')).toBe(false);
  });
});

describe('clearStatusbar', () => {
  it('removes the floating div from the DOM', () => {
    applyStatuslinePayload({ active: true, cueTip: 'x' });
    expect(bar()).not.toBeNull();
    clearStatusbar();
    expect(bar()).toBeNull();
  });

  it('is safe to call when no bar was ever created', () => {
    expect(() => clearStatusbar()).not.toThrow();
    expect(bar()).toBeNull();
  });

  it('a fresh bar can be created again after clearStatusbar (no stale singleton)', () => {
    applyStatuslinePayload({ active: true, cueTip: 'first' });
    clearStatusbar();
    applyStatuslinePayload({ active: true, cueTip: 'second' });
    expect(bar()!.textContent).toBe('second');
    // Only one bar should exist — not two stacked instances.
    expect(document.querySelectorAll('.oc-status-bar').length).toBe(1);
  });
});
