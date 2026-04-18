/**
 * Per-control "current value" cache for statusline tips on script-
 * backed controls (volume, brightness). Statusline reads cached
 * stdout from `script get`. Cycling marks the cache stale after
 * `script up/down`; Statusline keeps showing the previous value
 * while a refetch runs in the background, then updates.
 */
export interface ControlValueEntry {
  readonly value: string;
  /** Wall-clock timestamp of the last successful fetch. */
  readonly at: number;
  /** True when Cycling marked the value stale; Statusline refetches. */
  stale: boolean;
}

export class ControlValuesCache {
  private _values = new Map<string, ControlValueEntry>();

  get(controlName: string): ControlValueEntry | undefined {
    return this._values.get(controlName);
  }

  set(controlName: string, value: string): void {
    this._values.set(controlName, { value, at: Date.now(), stale: false });
  }

  /**
   * Mark the cache stale without dropping the value. Statusline returns
   * the previous value while triggering a background refetch.
   */
  invalidate(controlName: string): void {
    const cur = this._values.get(controlName);
    if (cur) this._values.set(controlName, { ...cur, stale: true });
  }

  clear(): void {
    this._values.clear();
  }
}
