// CursorStateExport — Step 1.
//
// Mirrors the original CC patch:
// writes a JSON snapshot to a host-supplied path on every text/cursor
// change, debounced ~100ms so a key-mash doesn't hammer the disk.
//
// The agentic test harness (tests/agentic/) reads this file to know what's in the
// input box and where the cursor lives — without it, automated test
// runs can't observe the editor state. No in-tree consumer; opt-in via
// host.cursorStatePath in boot.ts.

import type { HostAdapter, TextChangeEvent, Unsubscribe } from '../adapter';

export interface CursorStateExportOptions {
  /** Absolute path. Typically /tmp/opencues-cursor-state.json. */
  readonly exportPath: string;
  /** Debounce in ms (default 100). */
  readonly debounceMs?: number;
}

export interface CursorStateSnapshot {
  text: string;
  cursorPosition: number;
  currentWord: string;
  atEnd: boolean;
  textLength: number;
  timestamp: number;
}

export class CursorStateExport {
  private _unsub: Unsubscribe | null = null;
  private _timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private adapter: HostAdapter,
    private options: CursorStateExportOptions,
  ) {}

  subscribe(): void {
    this._unsub = this.adapter.onTextChange(e => this.onChange(e));
    // Capture the initial state too so the harness has something to read
    // before the user types anything.
    this.schedule(this.adapter.getText(), this.adapter.getCursorOffset());
  }

  unsubscribe(): void {
    if (this._unsub) { this._unsub(); this._unsub = null; }
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  private onChange(e: TextChangeEvent): void {
    this.schedule(e.text, e.cursorOffset);
  }

  private schedule(text: string, cursor: number): void {
    if (this._timer) clearTimeout(this._timer);
    const debounce = this.options.debounceMs ?? 100;
    this._timer = setTimeout(() => {
      this._timer = null;
      void this.write(text, cursor);
    }, debounce);
  }

  /** Exposed for testing. */
  buildSnapshot(text: string, cursor: number): CursorStateSnapshot {
    const clean = text.replace(/[\u200B\u200C]/g, '');
    const offset = Math.max(0, Math.min(cursor, clean.length));
    let currentWord = '';
    let pos = 0;
    for (const w of clean.split(/\s+/)) {
      const wEnd = pos + w.length;
      if (offset >= pos && offset <= wEnd) { currentWord = w; break; }
      pos = wEnd + 1;
    }
    return {
      text: clean,
      cursorPosition: offset,
      currentWord,
      atEnd: offset >= clean.length,
      textLength: clean.length,
      timestamp: Date.now(),
    };
  }

  private async write(text: string, cursor: number): Promise<void> {
    if (!this.adapter.capabilities.includes('file-write')) return;
    try {
      const snap = this.buildSnapshot(text, cursor);
      await this.adapter.writeFile(this.options.exportPath, JSON.stringify(snap));
      // Emit AFTER the writeFile resolves so any event-bridge consumer
      // can treat it as a barrier — subsequent reads of `exportPath`
      // see fresh content. Mirrors the statusline snapshot pattern;
      // eliminates the same race for cursor-state.
      try {
        this.adapter.emitEvent?.('cursor-state.snapshot', { ...snap, exportPath: this.options.exportPath });
      } catch (err) {
        this.adapter.log('error', 'CursorStateExport emitEvent threw', err);
      }
    } catch (err) {
      this.adapter.log('error', 'CursorStateExport: write failed', err);
    }
  }
}
