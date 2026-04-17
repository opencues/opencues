export class HighlightState {
  private _wordIndex: number | null = null;
  private _active = false;
  private _text = '';

  get wordIndex(): number | null { return this._wordIndex; }
  get active(): boolean { return this._active; }
  get text(): string { return this._text; }

  activate(wordIndex: number, text: string): void {
    this._active = true;
    this._wordIndex = wordIndex;
    this._text = text;
  }

  deactivate(): void {
    this._active = false;
    this._wordIndex = null;
  }

  setWordIndex(wordIndex: number | null): void {
    this._wordIndex = wordIndex;
  }

  setText(text: string): void {
    this._text = text;
  }
}
