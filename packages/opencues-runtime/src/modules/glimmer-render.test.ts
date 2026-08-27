import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  GlimmerRender,
  scrambleText,
  glimmerStream,
  parseGlimmerTransitionMs,
  GLIMMER_FRAME_MS,
  GLIMMER_BLINK_MS,
} from './glimmer-render';
import type { HostAdapter } from '../adapter';

// Minimal HostAdapter stub — only the bits the glimmer touches. setText is
// instrumented so tests can assert the RENDER-ONLY contract: the transition
// must never write the buffer, only ask the host to repaint.
function makeAdapter(): {
  adapter: HostAdapter;
  setTextCalls: string[];
  forceRenderCount: () => number;
} {
  const setTextCalls: string[] = [];
  let renders = 0;
  const adapter: Partial<HostAdapter> = {
    getText: () => '',
    setText: (s: string) => { setTextCalls.push(s); },
    forceRender: () => { renders++; },
  };
  return {
    adapter: adapter as HostAdapter,
    setTextCalls,
    forceRenderCount: () => renders,
  };
}

function makeGlimmer(durationMs: number, adapterBits = makeAdapter()) {
  const glimmer = new GlimmerRender({
    adapter: adapterBits.adapter,
    durationMs: () => durationMs,
    rand: glimmerStream(42),
  });
  return { glimmer, ...adapterBits };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('scrambleText', () => {
  it('preserves length exactly (the 1:1 override contract)', () => {
    const input = 'zephyr ALT-ONE\nsecond line';
    for (const density of [0, 0.45, 1]) {
      expect(scrambleText(input, density, glimmerStream(7))).toHaveLength(input.length);
    }
  });
  it('density 0 is the identity', () => {
    expect(scrambleText('zephyr ALT-ONE', 0, glimmerStream(7))).toBe('zephyr ALT-ONE');
  });
  it('passes through characters outside every group (newlines, spaces, CJK)', () => {
    const out = scrambleText('\n 何 \n', 1, glimmerStream(7));
    expect(out).toBe('\n 何 \n');
  });
  it('at density 1 every poolable char swaps within its own group', () => {
    const out = scrambleText('zzzz', 1, glimmerStream(7));
    expect(out).not.toBe('zzzz');
    // 'z' lives in the '-szJkvxy7' confusable group — swaps stay inside it.
    for (const ch of out) expect('-szJkvxy7').toContain(ch);
  });
  it('is deterministic under a seeded stream', () => {
    expect(scrambleText('zephyr', 0.45, glimmerStream(9)))
      .toBe(scrambleText('zephyr', 0.45, glimmerStream(9)));
  });
});

describe('parseGlimmerTransitionMs', () => {
  it('absent → registry default 300', () => {
    expect(parseGlimmerTransitionMs(undefined)).toBe(300);
  });
  it('off / 0 → disabled', () => {
    expect(parseGlimmerTransitionMs('off')).toBe(0);
    expect(parseGlimmerTransitionMs('0')).toBe(0);
  });
  it('recognised values parse', () => {
    expect(parseGlimmerTransitionMs('300')).toBe(300);
    expect(parseGlimmerTransitionMs('600')).toBe(600);
    expect(parseGlimmerTransitionMs('900')).toBe(900);
  });
  it('junk falls back to the default, never NaN', () => {
    expect(parseGlimmerTransitionMs('banana')).toBe(300);
    expect(parseGlimmerTransitionMs('450')).toBe(300);
  });
});

describe('GlimmerRender — lifecycle', () => {
  it('scalar off (durationMs 0) → start() is a no-op', () => {
    const { glimmer } = makeGlimmer(0);
    glimmer.start(0, 'ALT-ONE');
    expect(glimmer.active).toBe(false);
    expect(glimmer.getTextOverride('ALT-ONE here')).toBeNull();
  });

  it('blink phase paints the span as blanks, newlines preserved', () => {
    vi.useFakeTimers();
    const { glimmer } = makeGlimmer(300);
    glimmer.start(4, 'AL\nT1');
    const override = glimmer.getTextOverride('pre AL\nT1 post');
    expect(override).toBe('pre   \n   post');
  });

  it('churn phase scrambles ONLY the span; length always 1:1', () => {
    vi.useFakeTimers();
    const { glimmer } = makeGlimmer(600);
    const ctx = 'keep zephyr keep';
    glimmer.start(5, 'zephyr');
    // Advance past the blink into full-density churn.
    vi.advanceTimersByTime(GLIMMER_BLINK_MS + GLIMMER_FRAME_MS);
    const override = glimmer.getTextOverride(ctx);
    expect(override).not.toBeNull();
    expect(override).toHaveLength(ctx.length);
    expect(override!.startsWith('keep ')).toBe(true);
    expect(override!.endsWith(' keep')).toBe(true);
    expect(override!.slice(5, 11)).not.toBe('zephyr');
  });

  it('settles clean after blink + duration and repaints once more', () => {
    vi.useFakeTimers();
    const { glimmer, forceRenderCount } = makeGlimmer(300);
    glimmer.start(0, 'zephyr');
    vi.advanceTimersByTime(GLIMMER_BLINK_MS + 300 + GLIMMER_FRAME_MS);
    expect(glimmer.active).toBe(false);
    expect(glimmer.getTextOverride('zephyr')).toBeNull();
    expect(forceRenderCount()).toBeGreaterThan(2);
  });

  it('NEVER calls setText — the render-only contract', () => {
    vi.useFakeTimers();
    const { glimmer, setTextCalls } = makeGlimmer(900);
    glimmer.start(0, 'zephyr ALT-ONE');
    vi.advanceTimersByTime(GLIMMER_BLINK_MS + 900 + GLIMMER_FRAME_MS * 2);
    glimmer.getTextOverride('zephyr ALT-ONE');
    expect(setTextCalls).toEqual([]);
  });

  it('self-cancels when the span vanishes from the buffer (user edit wins)', () => {
    vi.useFakeTimers();
    const { glimmer } = makeGlimmer(600);
    glimmer.start(0, 'zephyr');
    vi.advanceTimersByTime(GLIMMER_BLINK_MS + GLIMMER_FRAME_MS);
    expect(glimmer.getTextOverride('completely different')).toBeNull();
    expect(glimmer.active).toBe(false);
    // And stays cancelled — later frames paint nothing.
    expect(glimmer.getTextOverride('zephyr')).toBeNull();
  });

  it('tolerates offset drift by relocating the span (ZWS strips shift indices)', () => {
    vi.useFakeTimers();
    const { glimmer } = makeGlimmer(600);
    glimmer.start(10, 'zephyr');
    vi.advanceTimersByTime(GLIMMER_BLINK_MS + GLIMMER_FRAME_MS);
    // Span actually sits at 9 — one char left of the recorded offset.
    const override = glimmer.getTextOverride('lead-in: zephyr');
    expect(override).not.toBeNull();
    expect(override!.slice(0, 9)).toBe('lead-in: ');
  });

  it('a second start() replaces the first', () => {
    vi.useFakeTimers();
    const { glimmer } = makeGlimmer(600);
    glimmer.start(0, 'zephyr');
    glimmer.start(0, 'ALT-TWO');
    vi.advanceTimersByTime(GLIMMER_BLINK_MS + GLIMMER_FRAME_MS);
    const override = glimmer.getTextOverride('ALT-TWO tail');
    expect(override).not.toBeNull();
    expect(override).toHaveLength('ALT-TWO tail'.length);
  });

  it('blank/whitespace-only answers never animate', () => {
    const { glimmer } = makeGlimmer(600);
    glimmer.start(0, '   ');
    expect(glimmer.active).toBe(false);
  });

  it('dispose() stops the timer and clears state', () => {
    vi.useFakeTimers();
    const { glimmer, forceRenderCount } = makeGlimmer(900);
    glimmer.start(0, 'zephyr');
    glimmer.dispose();
    const renders = forceRenderCount();
    vi.advanceTimersByTime(2000);
    expect(forceRenderCount()).toBe(renders);
    expect(glimmer.active).toBe(false);
  });
});
