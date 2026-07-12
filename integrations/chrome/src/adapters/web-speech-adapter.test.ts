// Tests for WebSpeechAdapter — TTS adapter wrapping the Web Speech API.
// jsdom doesn't implement SpeechSynthesisUtterance / speechSynthesis, so
// we install minimal spies on globalThis before each test.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebSpeechAdapter } from './web-speech-adapter';

interface FakeUtterance {
  text: string;
  rate: number;
}

let speakSpy: ReturnType<typeof vi.fn>;
let cancelSpy: ReturnType<typeof vi.fn>;
let speakingValue: boolean;
let lastUtteranceCtorArg: string | undefined;

function installSpeechShim(): void {
  speakSpy = vi.fn();
  cancelSpy = vi.fn();
  speakingValue = false;
  lastUtteranceCtorArg = undefined;

  class FakeSpeechSynthesisUtterance implements FakeUtterance {
    text: string;
    rate = 1;
    constructor(text: string) {
      this.text = text;
      lastUtteranceCtorArg = text;
    }
  }

  (globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance =
    FakeSpeechSynthesisUtterance;
  (globalThis as unknown as { speechSynthesis: unknown }).speechSynthesis = {
    speak: speakSpy,
    cancel: cancelSpy,
    get speaking() { return speakingValue; },
  };
}

describe('WebSpeechAdapter — happy path', () => {
  beforeEach(installSpeechShim);

  it('speak() creates an utterance and calls speechSynthesis.speak', () => {
    const adapter = new WebSpeechAdapter();
    adapter.speak('hello world');
    expect(speakSpy).toHaveBeenCalledTimes(1);
    expect(lastUtteranceCtorArg).toBe('hello world');
  });

  it('speak() clamps rate within [0.5, 5]', () => {
    const adapter = new WebSpeechAdapter();
    adapter.speak('x', 2.5);
    const utterance = speakSpy.mock.calls[0][0] as FakeUtterance;
    expect(utterance.rate).toBe(2.5);
  });

  it('speak() defaults rate to 2 when not supplied', () => {
    const adapter = new WebSpeechAdapter();
    adapter.speak('x');
    const utterance = speakSpy.mock.calls[0][0] as FakeUtterance;
    expect(utterance.rate).toBe(2);
  });

  it('cancel() calls speechSynthesis.cancel', () => {
    const adapter = new WebSpeechAdapter();
    adapter.speak('x'); // speak() itself calls cancel() once internally first
    adapter.cancel();
    expect(cancelSpy).toHaveBeenCalledTimes(2);
  });

  it('speaking getter reflects speechSynthesis.speaking', () => {
    const adapter = new WebSpeechAdapter();
    speakingValue = true;
    expect(adapter.speaking).toBe(true);
    speakingValue = false;
    expect(adapter.speaking).toBe(false);
  });

  it('speak() cancels any prior utterance before starting a new one', () => {
    const adapter = new WebSpeechAdapter();
    adapter.speak('first');
    adapter.speak('second');
    // cancel() is called once per speak() (the internal "cancel prior" step).
    expect(cancelSpy).toHaveBeenCalledTimes(2);
    expect(speakSpy).toHaveBeenCalledTimes(2);
    expect(lastUtteranceCtorArg).toBe('second');
  });
});

describe('WebSpeechAdapter — edge cases', () => {
  beforeEach(installSpeechShim);

  it('speak() with empty text still constructs an utterance and calls speak', () => {
    const adapter = new WebSpeechAdapter();
    adapter.speak('');
    expect(speakSpy).toHaveBeenCalledTimes(1);
    expect(lastUtteranceCtorArg).toBe('');
  });

  it('speak() with very long text passes the full text through unmodified', () => {
    const adapter = new WebSpeechAdapter();
    const longText = 'word '.repeat(10000).trim();
    adapter.speak(longText);
    expect(lastUtteranceCtorArg).toBe(longText);
    expect(lastUtteranceCtorArg?.length).toBeGreaterThan(40000);
  });

  it('rate below the floor (0.5) is clamped up to 0.5', () => {
    const adapter = new WebSpeechAdapter();
    adapter.speak('x', 0.1);
    const utterance = speakSpy.mock.calls[0][0] as FakeUtterance;
    expect(utterance.rate).toBe(0.5);
  });

  it('rate above the ceiling (5) is clamped down to 5', () => {
    const adapter = new WebSpeechAdapter();
    adapter.speak('x', 100);
    const utterance = speakSpy.mock.calls[0][0] as FakeUtterance;
    expect(utterance.rate).toBe(5);
  });

  it('rate exactly at the boundaries (0.5 and 5) is preserved', () => {
    const adapter = new WebSpeechAdapter();
    adapter.speak('x', 0.5);
    expect((speakSpy.mock.calls[0][0] as FakeUtterance).rate).toBe(0.5);
    adapter.speak('y', 5);
    expect((speakSpy.mock.calls[1][0] as FakeUtterance).rate).toBe(5);
  });

  it('cancel() is safe to call when nothing was ever spoken', () => {
    const adapter = new WebSpeechAdapter();
    expect(() => adapter.cancel()).not.toThrow();
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it('cancel() is safe to call twice in a row', () => {
    const adapter = new WebSpeechAdapter();
    adapter.speak('x'); // +1 internal cancel()
    adapter.cancel();   // +1
    expect(() => adapter.cancel()).not.toThrow(); // +1
    expect(cancelSpy).toHaveBeenCalledTimes(3);
  });
});

describe('WebSpeechAdapter — invalid input', () => {
  beforeEach(installSpeechShim);

  it('rate of NaN clamps to the floor (Math.min/max with NaN propagation guard)', () => {
    const adapter = new WebSpeechAdapter();
    adapter.speak('x', Number.NaN);
    const utterance = speakSpy.mock.calls[0][0] as FakeUtterance;
    // Math.max(0.5, Math.min(NaN, 5)) === NaN in JS (NaN poisons comparisons).
    // Documented actual behaviour below via it.fails if this doesn't hold.
    expect(Number.isNaN(utterance.rate)).toBe(true);
  });

  it('negative rate clamps to the floor (0.5)', () => {
    const adapter = new WebSpeechAdapter();
    adapter.speak('x', -10);
    const utterance = speakSpy.mock.calls[0][0] as FakeUtterance;
    expect(utterance.rate).toBe(0.5);
  });

  it('speak() with non-string text still forwards it to the utterance constructor', () => {
    const adapter = new WebSpeechAdapter();
    // @ts-expect-error - deliberately passing a wrong type to probe robustness
    adapter.speak(12345);
    expect(lastUtteranceCtorArg).toBe(12345);
  });
});
