export interface ConsumeAllEntry {
  readonly keyword: string;
  readonly alternatives: readonly string[];
  readonly spanStart: number;
  readonly spanEnd: number;
}

export class ConsumeAllState {
  private _entry: ConsumeAllEntry | null = null;

  get current(): ConsumeAllEntry | null { return this._entry; }

  set(entry: ConsumeAllEntry | null): void {
    this._entry = entry;
  }

  clear(): void {
    this._entry = null;
  }
}
