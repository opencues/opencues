import type { BrowserControl } from './types';

/**
 * Tab audio volume control using Web Audio API.
 *
 * Controls the gain of all <audio>/<video> elements on the page
 * via an AudioContext GainNode. This is tab-scoped, not system volume.
 *
 * Step: 6% per press (matching bash volume.sh behavior).
 */
export class VolumeControl implements BrowserControl {
  readonly name = 'volume';
  readonly readOnly = false;
  private gain = 1.0; // 0.0 - 1.0
  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private connected = new WeakSet<HTMLMediaElement>();

  private ensureContext(): void {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.gainNode = this.ctx.createGain();
    this.gainNode.connect(this.ctx.destination);
    this.connectMediaElements();
  }

  /** Connect all media elements on the page to our gain node */
  private connectMediaElements(): void {
    if (!this.ctx || !this.gainNode) return;
    const elements = document.querySelectorAll<HTMLMediaElement>('audio, video');
    for (const el of elements) {
      if (this.connected.has(el)) continue;
      try {
        const source = this.ctx.createMediaElementSource(el);
        source.connect(this.gainNode);
        this.connected.add(el);
      } catch { /* already connected or cross-origin */ }
    }
  }

  async get(): Promise<string> {
    return `${Math.round(this.gain * 100)}%`;
  }

  async set(value: string): Promise<void> {
    const num = parseInt(value.replace('%', ''), 10);
    if (isNaN(num)) return;
    this.gain = Math.max(0, Math.min(1, num / 100));
    this.applyGain();
  }

  async up(): Promise<string> {
    this.gain = Math.min(1, this.gain + 0.06);
    this.applyGain();
    return this.get();
  }

  async down(): Promise<string> {
    this.gain = Math.max(0, this.gain - 0.06);
    this.applyGain();
    return this.get();
  }

  private applyGain(): void {
    this.ensureContext();
    if (this.gainNode) {
      this.gainNode.gain.value = this.gain;
    }
  }
}
