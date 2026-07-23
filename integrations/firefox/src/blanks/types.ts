/**
 * Browser-native blank interface.
 * Replaces bash script spawning with web APIs.
 *
 * Each blank implements get/set/up/down:
 *   get()  → current display value (e.g. "50%", "$186.43")
 *   set(v) → apply a specific value
 *   up()   → increment
 *   down() → decrement
 */
export interface BrowserBlank {
  readonly name: string;
  readonly readOnly: boolean;

  /** Get current display value */
  get(keyword?: string, context?: string[]): Promise<string>;

  /** Set to specific value (no-op for readOnly) */
  set?(value: string, keyword?: string): Promise<void>;

  /** Increment (no-op for readOnly) */
  up?(): Promise<string>;

  /** Decrement (no-op for readOnly) */
  down?(): Promise<string>;
}
