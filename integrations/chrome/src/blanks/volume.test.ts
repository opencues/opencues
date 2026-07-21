// Tests for VolumeBlank — tab-scoped Web Audio API gain control.
// Currently unregistered from createBlanks (see blanks/index.ts +
// integrations/chrome/CLAUDE.md), but the class remains in the source
// for a possible future `tab-volume` keyword, so it's still worth
// covering. Mocks the Web Audio API surface (AudioContext/GainNode)
// since jsdom doesn't implement it.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VolumeBlank } from './volume';

interface FakeGainNode {
  gain: { value: number };
  connect: ReturnType<typeof vi.fn>;
}

interface FakeAudioContext {
  createGain: () => FakeGainNode;
  createMediaElementSource: (el: unknown) => { connect: ReturnType<typeof vi.fn> };
  destination: object;
}

let createMediaElementSourceSpy: ReturnType<typeof vi.fn>;
let lastGainNode: FakeGainNode | undefined;
let createMediaElementSourceImpl: (el: unknown) => { connect: ReturnType<typeof vi.fn> };

function installAudioContextShim(): void {
  lastGainNode = undefined;
  createMediaElementSourceImpl = (_el: unknown) => ({ connect: vi.fn() });
  createMediaElementSourceSpy = vi.fn((el: unknown) => createMediaElementSourceImpl(el));

  class FakeAudioContextCtor implements FakeAudioContext {
    destination = {};
    createGain(): FakeGainNode {
      const node: FakeGainNode = { gain: { value: 1 }, connect: vi.fn() };
      lastGainNode = node;
      return node;
    }
    createMediaElementSource(el: unknown) {
      return createMediaElementSourceSpy(el);
    }
  }

  (globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContextCtor;
}

describe('VolumeBlank — happy path', () => {
  beforeEach(() => {
    installAudioContextShim();
    document.body.innerHTML = '';
  });

  it('get() reports 100% initially', async () => {
    const blank = new VolumeBlank();
    expect(await blank.get()).toBe('100%');
  });

  it('set("50%") updates get() and applies gain to the AudioContext', async () => {
    const blank = new VolumeBlank();
    await blank.set('50%');
    expect(await blank.get()).toBe('50%');
    expect(lastGainNode?.gain.value).toBe(0.5);
  });

  it('up() increases volume by 6 percentage points', async () => {
    const blank = new VolumeBlank();
    await blank.set('50%'); // starts at 100%, so drop first to have headroom
    const result = await blank.up();
    expect(result).toBe('56%');
    expect(await blank.get()).toBe('56%');
  });

  it('down() decreases volume by 6 percentage points', async () => {
    const blank = new VolumeBlank();
    const result = await blank.down();
    expect(result).toBe('94%');
  });

  it('name is "volume" and readOnly is false', () => {
    const blank = new VolumeBlank();
    expect(blank.name).toBe('volume');
    expect(blank.readOnly).toBe(false);
  });

  it('connects existing <audio>/<video> elements on the page when gain is first applied', async () => {
    const audio = document.createElement('audio');
    document.body.appendChild(audio);
    const blank = new VolumeBlank();
    await blank.set('80%');
    expect(createMediaElementSourceSpy).toHaveBeenCalledWith(audio);
  });
});

describe('VolumeBlank — edge cases', () => {
  beforeEach(() => {
    installAudioContextShim();
    document.body.innerHTML = '';
  });

  it('up() clamps at 100% (does not overshoot)', async () => {
    const blank = new VolumeBlank();
    for (let i = 0; i < 5; i++) await blank.up();
    expect(await blank.get()).toBe('100%');
  });

  it('down() clamps at 0% (does not go negative)', async () => {
    const blank = new VolumeBlank();
    for (let i = 0; i < 20; i++) await blank.down();
    expect(await blank.get()).toBe('0%');
  });

  it('set("0%") is accepted and clamps floor', async () => {
    const blank = new VolumeBlank();
    await blank.set('0%');
    expect(await blank.get()).toBe('0%');
  });

  it('set("100%") is accepted and clamps ceiling', async () => {
    const blank = new VolumeBlank();
    await blank.set('100%');
    expect(await blank.get()).toBe('100%');
  });

  it('set() beyond 100% clamps to 100%', async () => {
    const blank = new VolumeBlank();
    await blank.set('250%');
    expect(await blank.get()).toBe('100%');
  });

  it('set() with a negative number clamps to 0%', async () => {
    const blank = new VolumeBlank();
    await blank.set('-50%');
    expect(await blank.get()).toBe('0%');
  });

  it('set() accepts a bare number with no % suffix', async () => {
    const blank = new VolumeBlank();
    await blank.set('42');
    expect(await blank.get()).toBe('42%');
  });

  it('reuses the same AudioContext across multiple set() calls (lazy-init once)', async () => {
    const blank = new VolumeBlank();
    await blank.set('10%');
    const firstGainNode = lastGainNode;
    await blank.set('20%');
    // createGain only fires once per instance — same node instance reused.
    expect(lastGainNode).toBe(firstGainNode);
  });

  it('does not re-connect an already-connected media element on a second gain application', async () => {
    const audio = document.createElement('audio');
    document.body.appendChild(audio);
    const blank = new VolumeBlank();
    await blank.set('10%');
    await blank.set('20%');
    expect(createMediaElementSourceSpy).toHaveBeenCalledTimes(1);
  });

  it('swallows a createMediaElementSource failure (e.g. cross-origin / already-connected) without throwing', async () => {
    createMediaElementSourceImpl = () => { throw new Error('already connected'); };
    const audio = document.createElement('audio');
    document.body.appendChild(audio);
    const blank = new VolumeBlank();
    await expect(blank.set('30%')).resolves.toBeUndefined();
  });
});

describe('VolumeBlank — invalid input', () => {
  beforeEach(() => {
    installAudioContextShim();
    document.body.innerHTML = '';
  });

  it('set() with a non-numeric string is a silent no-op (gain unchanged)', async () => {
    const blank = new VolumeBlank();
    await blank.set('loud');
    expect(await blank.get()).toBe('100%');
  });

  it('set() with an empty string is a silent no-op', async () => {
    const blank = new VolumeBlank();
    await blank.set('');
    expect(await blank.get()).toBe('100%');
  });

  it('set() with whitespace-only input is a silent no-op', async () => {
    const blank = new VolumeBlank();
    await blank.set('   ');
    expect(await blank.get()).toBe('100%');
  });

  it('set() does not throw on garbage input', async () => {
    const blank = new VolumeBlank();
    await expect(blank.set('!!!not-a-number!!!')).resolves.toBeUndefined();
  });
});
