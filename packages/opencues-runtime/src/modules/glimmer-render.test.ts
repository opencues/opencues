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

// Write-mode adapter stub: a REAL mutable buffer (setText actually mutates
// it, getText reads it back) plus cursor tracking — the shape write-mode
// glimmer needs, since it locates the span by reading the buffer back on
// every tick rather than being handed ctxText by a render handler.
function makeWriteAdapter(initialText: string, initialCursor = 0): {
  adapter: HostAdapter;
  setTextCalls: string[];
  getBuffer: () => string;
  getCursor: () => number;
} {
  let text = initialText;
  let cursor = initialCursor;
  const setTextCalls: string[] = [];
  const adapter: Partial<HostAdapter> = {
    getText: () => text,
    setText: (s: string) => { setTextCalls.push(s); text = s; },
    getCursorOffset: () => cursor,
    setCursorOffset: (n: number) => { cursor = n; },
  };
  return {
    adapter: adapter as HostAdapter,
    setTextCalls,
    getBuffer: () => text,
    getCursor: () => cursor,
  };
}

function makeWriteGlimmer(durationMs: number, initialText: string, initialCursor = 0) {
  const adapterBits = makeWriteAdapter(initialText, initialCursor);
  const markedWrites: string[] = [];
  const glimmer = new GlimmerRender({
    adapter: adapterBits.adapter,
    durationMs: () => durationMs,
    rand: glimmerStream(42),
    realWrite: { markRuntimeWrite: (t: string) => markedWrites.push(t) },
  });
  return { glimmer, markedWrites, ...adapterBits };
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
    expect(parseGlimmerTransitionMs('1500')).toBe(1500);
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

// Write mode — OpenCode / shell / chrome (renderers that don't consume
// textOverride). Same scramble/blink/splice logic as render-only, but every
// frame is a REAL adapter.setText call against a real mutable buffer.
describe('GlimmerRender — write mode (realWrite)', () => {
  it('writes the blink frame into the real buffer immediately on start()', () => {
    vi.useFakeTimers();
    const { glimmer, getBuffer } = makeWriteGlimmer(300, 'pre zephyr post', 0);
    glimmer.start(4, 'zephyr');
    expect(getBuffer()).toBe('pre        post');
  });

  it('marks every write via the reclassifier BEFORE calling setText', () => {
    vi.useFakeTimers();
    const { glimmer, markedWrites, setTextCalls } = makeWriteGlimmer(300, 'zephyr', 0);
    glimmer.start(0, 'zephyr');
    expect(markedWrites).toEqual(setTextCalls);
    expect(markedWrites.length).toBeGreaterThan(0);
  });

  it('each tick anchors on the PREVIOUS frame, not the long-gone finalText — the bug a naive port would hit', () => {
    vi.useFakeTimers();
    const { glimmer, getBuffer } = makeWriteGlimmer(600, 'keep zephyr keep', 5);
    glimmer.start(5, 'zephyr');
    // After the first write, the buffer no longer contains "zephyr" — it
    // contains the blink frame. A `locate()` that (incorrectly) always
    // searched for `finalText` would find nothing on every subsequent
    // tick and self-cancel after one frame. Confirm it doesn't:
    // multiple ticks in, the animation is still active and still writing.
    vi.advanceTimersByTime(GLIMMER_FRAME_MS * 3);
    expect(glimmer.active).toBe(true);
    const mid = getBuffer();
    expect(mid).toHaveLength('keep zephyr keep'.length);
    expect(mid.startsWith('keep ')).toBe(true);
    expect(mid.endsWith(' keep')).toBe(true);
  });

  it('settles by writing the clean final text back — the buffer is dirty until this point', () => {
    vi.useFakeTimers();
    const { glimmer, getBuffer, setTextCalls } = makeWriteGlimmer(300, 'zephyr', 0);
    glimmer.start(0, 'zephyr');
    vi.advanceTimersByTime(GLIMMER_BLINK_MS + 300 + GLIMMER_FRAME_MS);
    expect(glimmer.active).toBe(false);
    expect(getBuffer()).toBe('zephyr');
    expect(setTextCalls.at(-1)).toBe('zephyr');
  });

  it('preserves cursor position across every write', () => {
    vi.useFakeTimers();
    const { glimmer, getCursor } = makeWriteGlimmer(600, 'keep zephyr keep', 2);
    glimmer.start(5, 'zephyr');
    expect(getCursor()).toBe(2);
    vi.advanceTimersByTime(GLIMMER_FRAME_MS * 3);
    expect(getCursor()).toBe(2);
    vi.advanceTimersByTime(GLIMMER_BLINK_MS + 600 + GLIMMER_FRAME_MS * 2);
    expect(getCursor()).toBe(2);
  });

  it('self-cancels and stops writing when the user edits the span mid-animation', () => {
    vi.useFakeTimers();
    const { glimmer, adapter, setTextCalls } = makeWriteGlimmer(600, 'zephyr', 0);
    glimmer.start(0, 'zephyr');
    vi.advanceTimersByTime(GLIMMER_FRAME_MS);
    expect(glimmer.active).toBe(true);
    // User types over the animated span — the buffer is the truth now.
    adapter.setText('totally different text');
    const callsBeforeMoreTicks = setTextCalls.length;
    vi.advanceTimersByTime(GLIMMER_FRAME_MS * 3);
    expect(glimmer.active).toBe(false);
    // No further writes past the user's own edit (which itself is in
    // setTextCalls once, from the line above — nothing new after it).
    expect(setTextCalls.length).toBe(callsBeforeMoreTicks);
  });

  it('a fast re-summon restores the FIRST animation\'s buffer before starting the second — no orphaned scramble', () => {
    vi.useFakeTimers();
    const { glimmer, getBuffer } = makeWriteGlimmer(600, 'zephyr other-span', 0);
    glimmer.start(0, 'zephyr');
    vi.advanceTimersByTime(GLIMMER_FRAME_MS * 2);
    // Mid-scramble — the buffer does NOT currently contain "zephyr".
    expect(getBuffer().slice(0, 6)).not.toBe('zephyr');
    // A second, unrelated substitution re-summons before the first settled.
    glimmer.start(7, 'other-span');
    // The first span was restored to its clean final text — not left
    // scrambled — before the second animation's own writes began.
    expect(getBuffer().startsWith('zephyr ')).toBe(true);
  });

  it('off (durationMs 0) never writes or marks anything', () => {
    const { glimmer, setTextCalls, markedWrites } = makeWriteGlimmer(0, 'zephyr', 0);
    glimmer.start(0, 'zephyr');
    expect(setTextCalls).toEqual([]);
    expect(markedWrites).toEqual([]);
  });

  it('dispose() mid-animation restores the clean text rather than abandoning a scrambled buffer', () => {
    vi.useFakeTimers();
    const { glimmer, getBuffer } = makeWriteGlimmer(900, 'zephyr', 0);
    glimmer.start(0, 'zephyr');
    vi.advanceTimersByTime(GLIMMER_FRAME_MS * 2);
    expect(getBuffer()).not.toBe('zephyr'); // mid-scramble, buffer is dirty
    glimmer.dispose();
    expect(getBuffer()).toBe('zephyr'); // restored, not abandoned
  });
});

describe('GlimmerRender — host-owned animation (playHostAnimation)', () => {
  function makeHostAnimGlimmer(durationMs = 900) {
    const adapterBits = makeAdapter();
    const specs: { startOffset: number; finalText: string; durationMs: number }[] = [];
    let cancels = 0;
    let settleResolve: (() => void) | null = null;
    const glimmer = new GlimmerRender({
      adapter: adapterBits.adapter,
      durationMs: () => durationMs,
      rand: glimmerStream(42),
      playHostAnimation: (spec) => {
        specs.push(spec);
        return {
          cancel: () => { cancels++; },
          settled: new Promise<void>((res) => { settleResolve = res; }),
        };
      },
    });
    return { glimmer, specs, getCancels: () => cancels, settle: () => settleResolve?.(), ...adapterBits };
  }

  it('delegates the whole transition: hook called with the spec, no timer, no writes, no renders', () => {
    vi.useFakeTimers();
    const { glimmer, specs, setTextCalls, forceRenderCount } = makeHostAnimGlimmer(600);
    glimmer.start(7, 'ALT-ONE');
    expect(specs).toEqual([{ startOffset: 7, finalText: 'ALT-ONE', durationMs: 600 }]);
    expect(glimmer.active).toBe(true);
    // Advance well past every frame the runtime-owned modes would emit —
    // host mode must produce ZERO runtime activity.
    vi.advanceTimersByTime(5000);
    expect(setTextCalls).toEqual([]);
    expect(forceRenderCount()).toBe(0);
    expect(glimmer.getTextOverride('anything ALT-ONE anything')).toBeNull();
  });

  it('cancel() forwards to the host handle exactly once and clears active', () => {
    const { glimmer, getCancels } = makeHostAnimGlimmer();
    glimmer.start(0, 'ALT-ONE');
    glimmer.cancel(true);
    glimmer.cancel(true); // idempotent — the handle must not be re-cancelled
    expect(getCancels()).toBe(1);
    expect(glimmer.active).toBe(false);
  });

  it('a second start() cancels the first host animation before delegating again', () => {
    const { glimmer, specs, getCancels } = makeHostAnimGlimmer();
    glimmer.start(0, 'ALT-ONE');
    glimmer.start(4, 'ALT-TWO');
    expect(getCancels()).toBe(1);
    expect(specs.map((s) => s.finalText)).toEqual(['ALT-ONE', 'ALT-TWO']);
    expect(glimmer.active).toBe(true);
  });

  it('natural completion (settled resolves) clears active without cancelling', async () => {
    const { glimmer, settle, getCancels } = makeHostAnimGlimmer();
    glimmer.start(0, 'ALT-ONE');
    settle();
    await Promise.resolve(); // let the .then chain run
    expect(glimmer.active).toBe(false);
    expect(getCancels()).toBe(0);
  });

  it('a throwing host hook is swallowed — the substitution is already committed, only the cosmetic is lost', () => {
    const adapterBits = makeAdapter();
    const glimmer = new GlimmerRender({
      adapter: adapterBits.adapter,
      durationMs: () => 900,
      playHostAnimation: () => { throw new Error('host mid-teardown'); },
    });
    expect(() => glimmer.start(0, 'ALT-ONE')).not.toThrow();
    expect(glimmer.active).toBe(false);
  });

  it('scalar off (durationMs <= 0) never calls the host hook', () => {
    const { glimmer, specs } = makeHostAnimGlimmer(0);
    glimmer.start(0, 'ALT-ONE');
    expect(specs).toEqual([]);
  });
});
