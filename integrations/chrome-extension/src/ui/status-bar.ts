import type { WordDef } from 'cues-core';
import type { HighlightState } from '../types';

/**
 * Floating status bar showing cueTip and alternative info.
 * Replaces file-based JSON export + shell status line.
 */
export class StatusBar {
  private el: HTMLElement;
  private visible = false;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'oc-status-bar';
    this.el.setAttribute('aria-live', 'polite');
    document.body.appendChild(this.el);
  }

  /** Update the status bar content */
  update(hlState: HighlightState, wordDef?: WordDef, cueControlTip?: string | null): void {
    if (!hlState.active) {
      this.hide();
      return;
    }

    // Standalone cue-control word (e.g. "volume") — show live tip (overrides def tip)
    if (cueControlTip) {
      this.el.textContent = cueControlTip;
      this.show();
      return;
    }

    if (!wordDef) {
      this.hide();
      return;
    }

    const parts: string[] = [];

    // Word and alternative index (skip for control-blanks — they show tip only)
    if (wordDef.alts && wordDef.alts.length > 1 && !wordDef.metadata?.controlName) {
      const idx = (wordDef.currentAltIndex ?? 0) + 1;
      parts.push(`${idx}/${wordDef.alts.length}`);
    }

    // Cue tip
    if (wordDef.cueTip) {
      parts.push(wordDef.cueTip);
    } else if (wordDef.altCueTips) {
      const tipIdx = wordDef.currentAltIndex ?? 0;
      if (wordDef.altCueTips[tipIdx]) {
        parts.push(wordDef.altCueTips[tipIdx]);
      }
    }

    if (parts.length === 0) {
      this.hide();
      return;
    }

    this.el.textContent = parts.join(' \u2014 ');
    this.show();
  }

  private show(): void {
    if (this.visible) return;
    this.el.classList.add('oc-status-bar--visible');
    this.visible = true;
  }

  private hide(): void {
    if (!this.visible) return;
    this.el.classList.remove('oc-status-bar--visible');
    this.visible = false;
  }

  destroy(): void {
    this.el.remove();
  }
}
