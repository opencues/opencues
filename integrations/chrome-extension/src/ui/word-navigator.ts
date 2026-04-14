import type { CueEngine } from '../core/cue-engine';
import type { HighlightState } from '../types';
import { INITIAL_HIGHLIGHT_STATE } from '../types';
import { WebSpeechAdapter } from '../adapters/web-speech-adapter';

/**
 * Keyboard navigation and cycling handler.
 * Replaces wordHighlight.ts key dispatcher injection.
 *
 * Listens for Ctrl+Alt+Arrow on the target element:
 *   Left/Right — navigate between words with alternatives
 *   Up/Down    — cycle through alternatives / step numbers
 *   Escape     — clear highlight
 */
export class WordNavigator {
  private target: HTMLElement;
  private engine: CueEngine;
  private tts: WebSpeechAdapter;
  /** Called synchronously after text change to rebuild highlights before browser paints */
  onRender: (() => void) | null = null;
  private state: HighlightState = { ...INITIAL_HIGHLIGHT_STATE };
  private listeners: Array<(state: HighlightState, newText?: string) => void> = [];
  private lastText = '';

  /** True while a cycle is in progress — suppresses analysis re-trigger */
  cycling = false;

  constructor(target: HTMLElement, engine: CueEngine, ttsRate = 2) {
    this.target = target;
    this.engine = engine;
    this.tts = new WebSpeechAdapter();
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleInput = this.handleInput.bind(this);
    target.addEventListener('keydown', this.handleKeyDown);
    target.addEventListener('input', this.handleInput);
    this.lastText = this.getText();
  }

  /** Register listener for state changes */
  onChange(fn: (state: HighlightState, newText?: string) => void): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(l => l !== fn); };
  }

  private notify(newText?: string): void {
    for (const fn of this.listeners) fn(this.state, newText);
  }

  getState(): HighlightState { return this.state; }

  /** Clear highlight when user types (equivalent to clear-on-typing) */
  private handleInput(): void {
    const text = this.getText();
    if (text !== this.lastText && this.state.active) {
      this.state = { ...INITIAL_HIGHLIGHT_STATE };
      this.notify();
    }
    this.lastText = text;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.repeat) return; // ignore key-held repeats
    const isModified = e.ctrlKey && (e.altKey || e.metaKey);

    if (isModified && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      e.stopPropagation();
      this.navigate(e.key === 'ArrowRight' ? 1 : -1);
      return;
    }

    if (isModified && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      e.stopPropagation();
      this.cycle(e.key === 'ArrowUp' ? 1 : -1);
      return;
    }

    if (e.key === 'Escape' && this.state.active) {
      e.preventDefault();
      this.clear();
      return;
    }
  }

  /**
   * Navigate to next/previous navigable word.
   * A word is navigable if it has alternatives or matches a step pattern.
   */
  private navigate(direction: 1 | -1): void {
    // Always read from DOM — must match what the Highlight API renderer sees
    const text = this.getText();
    const words = text.split(/\s+/).filter(w => w);

    // Build list of navigable word indices
    const navigable: number[] = [];
    for (let i = 0; i < words.length; i++) {
      if (this.engine.isNavigable(words[i], i)) navigable.push(i);
    }

    if (navigable.length === 0) return;

    if (!this.state.active) {
      // Activate: right → first, left → last
      const idx = direction === 1 ? 0 : navigable.length - 1;
      this.state = { active: true, index: idx, wordIndex: navigable[idx] };
    } else {
      // Always recompute position from wordIndex (state.index can go stale after cycling)
      let currentNavIdx = navigable.indexOf(this.state.wordIndex!);
      if (currentNavIdx < 0) {
        // Word left navigable set after cycling — find nearest navigable word
        const wi = this.state.wordIndex!;
        let bestDist = Infinity;
        for (let i = 0; i < navigable.length; i++) {
          const dist = Math.abs(navigable[i] - wi);
          if (dist < bestDist) { bestDist = dist; currentNavIdx = i; }
        }
        if (currentNavIdx < 0) currentNavIdx = 0;
      }
      const newNavIdx = currentNavIdx + direction;

      if (newNavIdx < 0 || newNavIdx >= navigable.length) {
        this.clear();
        return;
      }

      this.state = { active: true, index: newNavIdx, wordIndex: navigable[newNavIdx] };
    }

    // Scroll active word into view
    this.scrollToWord(this.state.wordIndex!);

    this.speakTip();
    this.notify();
  }

  /** Scroll the target so the word at the given index is visible */
  private scrollToWord(wordIndex: number): void {
    const text = this.getText();
    const words = text.split(/\s+/).filter(w => w);
    if (wordIndex < 0 || wordIndex >= words.length) return;

    // Find character offset of this word
    let searchPos = 0;
    for (let i = 0; i < wordIndex; i++) {
      const pos = text.indexOf(words[i], searchPos);
      if (pos >= 0) searchPos = pos + words[i].length;
    }
    const wordStart = text.indexOf(words[wordIndex], searchPos);
    if (wordStart < 0) return;

    // Find the text node containing this word and scroll it into view
    const walker = document.createTreeWalker(this.target, NodeFilter.SHOW_TEXT);
    let charPos = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (charPos + node.length > wordStart) {
        const offset = wordStart - charPos;
        try {
          const range = document.createRange();
          range.setStart(node, offset);
          range.setEnd(node, Math.min(offset + words[wordIndex].length, node.length));
          const rect = range.getBoundingClientRect();
          const containerRect = this.target.getBoundingClientRect();

          // Scroll vertically if needed
          if (rect.bottom > containerRect.bottom) {
            this.target.scrollTop += rect.bottom - containerRect.bottom + 10;
          } else if (rect.top < containerRect.top) {
            this.target.scrollTop -= containerRect.top - rect.top + 10;
          }

          // Scroll horizontally if needed
          if (rect.right > containerRect.right) {
            this.target.scrollLeft += rect.right - containerRect.right + 10;
          } else if (rect.left < containerRect.left) {
            this.target.scrollLeft -= containerRect.left - rect.left + 10;
          }
        } catch { /* skip */ }
        return;
      }
      charPos += node.length;
    }
  }

  /**
   * Cycle the highlighted word.
   * Delegates to CueEngine which handles alts, linked words, spans, step numbers.
   */
  private async cycle(direction: 1 | -1): Promise<void> {
    if (!this.state.active || this.state.wordIndex == null) return;
    this.cycling = true;

    const text = this.getText();
    const words = text.split(/\s+/).filter(w => w);
    const highlightedWord = words[this.state.wordIndex!];
    const def = this.engine.getWordDef(this.state.wordIndex);
    console.log(`[OpenCues] CYCLE: hlIdx=${this.state.wordIndex}, hlWord="${highlightedWord}", defIdx=${def?.index}, defWord="${def?.word}", text="${text}"`);
    if (def?.metadata?.controlName && !(def.metadata as any).listControl && !(def.metadata as any).consumeAll) {
      const controlName = def.metadata.controlName as string;
      const tip = await this.engine.controlAction(controlName, direction);
      if (tip) this.tts.speak(tip);
      this.notify();
      return;
    }

    // Standard cycling: alts, step numbers, linked words
    const result = this.engine.cycle(this.state.wordIndex, direction, text);
    if (!result) return;

    // Save cursor BEFORE text change
    const cursorBefore = this.getCursorPosition();

    // Update lastText BEFORE text change
    this.lastText = result.newText;

    // Change text
    if (!(this.target instanceof HTMLTextAreaElement) && !(this.target instanceof HTMLInputElement)) {
      const textNode = this.target.firstChild as Text | null;
      if (textNode && textNode.nodeType === Node.TEXT_NODE) {
        textNode.data = result.newText;
      } else {
        this.target.textContent = result.newText;
      }
    } else {
      (this.target as HTMLInputElement).value = result.newText;
    }

    // Restore cursor — adjust for word length change
    if (cursorBefore >= 0) {
      const newCursorPos = cursorBefore > result.wStart
        ? cursorBefore + result.lenDiff
        : cursorBefore;
      this.setCursorPosition(Math.max(0, Math.min(newCursorPos, result.newText.length)));
    }

    // Defer highlight rebuild to after text change settles
    requestAnimationFrame(() => {
      if (this.onRender) this.onRender();
    });

    // Gotcha #10: if cycling changed word count, recompute navigable indices
    // so highlight doesn't drift to wrong word
    if (result.lenDiff !== 0 && this.state.wordIndex != null) {
      const newWords = result.newText.split(/\s+/).filter(w => w);
      const newNavigable: number[] = [];
      for (let i = 0; i < newWords.length; i++) {
        if (this.engine.isNavigable(newWords[i], i)) newNavigable.push(i);
      }
      // Find where our word ended up in the new navigable list
      const newNavIdx = newNavigable.indexOf(this.state.wordIndex);
      if (newNavIdx >= 0) {
        this.state = { ...this.state, index: newNavIdx };
      } else if (newNavigable.length > 0) {
        // Word left navigable set — move to nearest
        const nearest = newNavigable.reduce((best, idx) =>
          Math.abs(idx - this.state.wordIndex!) < Math.abs(best - this.state.wordIndex!) ? idx : best
        );
        this.state = { ...this.state, index: newNavigable.indexOf(nearest), wordIndex: nearest };
      }
    }

    this.scrollToWord(this.state.wordIndex!);
    this.speakTip();
    this.notify(result.newText);
    this.cycling = false;
  }

  /** Speak the cueTip for the currently highlighted word */
  private speakTip(): void {
    if (this.state.wordIndex == null) return;
    // Voice-mode gate (gotcha #26)
    if (this.engine.isVoiceMuted()) return;
    const def = this.engine.getWordDef(this.state.wordIndex);
    if (!def) {
      // Check step pattern tip
      const text = this.getText();
      const words = text.split(/\s+/).filter(w => w);
      const word = words[this.state.wordIndex];
      if (word) {
        for (const sp of this.engine.stepPatterns) {
          if (sp.re.test(word) && sp.ctrl.stepTip) {
            this.tts.speak(sp.ctrl.stepTip);
            return;
          }
        }
      }
      return;
    }

    if (def.speak && def.cueTip) {
      this.tts.speak(def.cueTip);
    } else if (def.speak && def.altCueTips) {
      const idx = def.currentAltIndex ?? 0;
      const alt = def.alts?.[idx];
      if (alt && def.altCueTips[alt]) {
        this.tts.speak(def.altCueTips[alt]);
      }
    }
  }

  clear(): void {
    this.state = { ...INITIAL_HIGHLIGHT_STATE };
    this.tts.cancel();
    this.notify();
  }

  /** Programmatically activate highlight on a specific word index */
  activateAt(wordIndex: number): void {
    this.state = { active: true, index: 0, wordIndex };
    this.notify();
  }

  /** Replace a specific word at a character offset without touching the rest of the DOM */
  private replaceWordAt(charOffset: number, oldWord: string, newWord: string): void {
    console.log(`[OpenCues] replaceWordAt: offset=${charOffset}, "${oldWord}" → "${newWord}"`);
    if (this.target instanceof HTMLTextAreaElement || this.target instanceof HTMLInputElement) {
      const val = this.target.value;
      this.target.value = val.slice(0, charOffset) + newWord + val.slice(charOffset + oldWord.length);
      this.target.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    // Walk text nodes to find the exact range
    const walker = document.createTreeWalker(this.target, NodeFilter.SHOW_TEXT);
    let pos = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (pos + node.length > charOffset) {
        const offset = charOffset - pos;
        try {
          const sel = window.getSelection();
          if (!sel) return;
          const range = document.createRange();
          range.setStart(node, offset);
          range.setEnd(node, offset + oldWord.length);
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('insertText', false, newWord);
        } catch { /* skip */ }
        return;
      }
      pos += node.length;
    }
  }

  /** Get current cursor position as character offset */
  private getCursorPosition(): number {
    if (this.target instanceof HTMLTextAreaElement || this.target instanceof HTMLInputElement) {
      return this.target.selectionStart ?? -1;
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return -1;
    const range = sel.getRangeAt(0);
    const preRange = document.createRange();
    preRange.selectNodeContents(this.target);
    preRange.setEnd(range.startContainer, range.startOffset);
    return preRange.toString().length;
  }

  /** Extract plain text from the target element */
  private getText(): string {
    if (this.target instanceof HTMLTextAreaElement || this.target instanceof HTMLInputElement) {
      return this.target.value;
    }
    // Use textContent (not innerText) — innerText can normalize whitespace
    // differently when the DOM has <span> wrappers from the renderer
    return this.target.textContent || '';
  }

  /**
   * Set text on the target element.
   * Uses execCommand('insertText') to preserve undo history in contenteditable.
   */
  private setText(text: string): void {
    // Textarea/input: set value directly
    if (this.target instanceof HTMLTextAreaElement || this.target instanceof HTMLInputElement) {
      this.target.value = text;
      this.target.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    // Contenteditable: select all content then replace
    const sel = window.getSelection();
    if (!sel) return;

    // Focus the element first
    this.target.focus();

    // Select all content
    const range = document.createRange();
    range.selectNodeContents(this.target);
    sel.removeAllRanges();
    sel.addRange(range);

    // Try execCommand first (preserves undo), fall back to direct assignment
    if (!document.execCommand('insertText', false, text)) {
      this.target.textContent = text;
      this.target.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  /** Set cursor position in the target element */
  private setCursorPosition(offset: number): void {
    // Textarea/input: use selectionStart
    if (this.target instanceof HTMLTextAreaElement || this.target instanceof HTMLInputElement) {
      this.target.selectionStart = this.target.selectionEnd = offset;
      return;
    }

    // Contenteditable: walk text nodes
    const sel = window.getSelection();
    if (!sel) return;

    const walker = document.createTreeWalker(this.target, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    let node: Text | null = null;

    while (walker.nextNode()) {
      const textNode = walker.currentNode as Text;
      if (remaining <= textNode.length) {
        node = textNode;
        break;
      }
      remaining -= textNode.length;
    }

    if (node) {
      const range = document.createRange();
      range.setStart(node, Math.min(remaining, node.length));
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  destroy(): void {
    this.target.removeEventListener('keydown', this.handleKeyDown);
    this.target.removeEventListener('input', this.handleInput);
    this.tts.cancel();
  }
}
