export class HighlightState {
  private _wordIndex: number | null = null;
  private _active = false;
  private _text = '';
  private _listeners: Array<() => void> = [];

  get wordIndex(): number | null { return this._wordIndex; }
  get active(): boolean { return this._active; }
  get text(): string { return this._text; }

  /**
   * Subscribe to state-change events. Listener fires synchronously
   * AFTER each mutation. Used by Statusline to write the snapshot
   * file the same tick the activate/deactivate happens, eliminating
   * the React-render-cycle gap on CC (otherwise `expect path:active
   * equals true` polls the file before the next render commits).
   * Returns an unsubscribe function.
   */
  onChange(listener: () => void): () => void {
    this._listeners.push(listener);
    return () => {
      const i = this._listeners.indexOf(listener);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  }

  private notifyChange(): void {
    for (const fn of this._listeners) {
      try { fn(); } catch { /* swallow */ }
    }
  }

  activate(wordIndex: number, text: string): void {
    this._active = true;
    this._wordIndex = wordIndex;
    this._text = text;
    this.notifyChange();
  }

  deactivate(): void {
    this._active = false;
    this._wordIndex = null;
    this.notifyChange();
  }

  setWordIndex(wordIndex: number | null): void {
    this._wordIndex = wordIndex;
    this.notifyChange();
  }

  setText(text: string): void {
    this._text = text;
    this.notifyChange();
  }
}
