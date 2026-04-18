/**
 * State for the selector/satellite "settings" pattern (Step 35). When a
 * control with `blankSatellite: true` fills via a tab-separated script
 * output, the runtime spawns TWO words instead of one:
 *
 *   - selector  (e.g. "voice-mode")  — cycles through the names of all
 *     known settings; each cycle calls `script get <newName>` to fetch
 *     the corresponding satellite value.
 *   - satellite (e.g. "active")      — cycles through the configured
 *     values for the current setting; each cycle calls `script set
 *     <setting> <newValue>` to write back to opencues.md.
 *
 * Cycling is span-fill-flavoured but two-headed, so a dedicated state
 * class makes the contract explicit. `lastFilledText` follows the same
 * invalidation pattern as SpanFillState.
 */
export interface SelectorSatelliteEntry {
  /** Lowercased control name (e.g. "opencues"). */
  readonly controlName: string;
  /** Absolute path to the control's blankScript (already ~-expanded). */
  readonly scriptPath: string;
  /** Word index of the selector token in the host text. */
  selectorIndex: number;
  /** Word index of the satellite token (typically selectorIndex + 1). */
  satelliteIndex: number;
  /** Currently-displayed setting name. */
  currentSetting: string;
  /** Currently-displayed value for that setting. */
  currentValue: string;
  /** Separator string between selector and satellite (default ' '). */
  readonly separator: string;
  /** From control config — true means edits to either word remove the pair. */
  readonly clearOnEdit: boolean;
}

export class SelectorSatelliteState {
  private _entry: SelectorSatelliteEntry | null = null;
  private _lastFilledText = '';

  get current(): SelectorSatelliteEntry | null { return this._entry; }
  get lastFilledText(): string { return this._lastFilledText; }

  set(entry: SelectorSatelliteEntry | null, filledText?: string): void {
    this._entry = entry;
    if (entry === null) {
      this._lastFilledText = '';
    } else if (filledText !== undefined) {
      this._lastFilledText = filledText;
    }
  }

  clear(): void {
    this._entry = null;
    this._lastFilledText = '';
  }
}
