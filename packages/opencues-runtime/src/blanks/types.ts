// Shared Blank interface — every blank (script-replaceable or runtime-class)
// across hosts (chrome, opencode, claude-code, gemini-cli) implements this same
// shape. Hosts wire instances into a registry that BlankFill + Cycling
// reach via adapter.blankInvoke.
//
// Lift-and-shift pattern:
//   - get(keyword?, context?) → current display value (e.g. "50%", "$186.43")
//   - set?(value, keyword?)   → apply specific value (no-op for readOnly)
//   - up?()                   → increment (no-op for readOnly)
//   - down?()                 → decrement (no-op for readOnly)
//
// Blank implementations live in this folder when their I/O is portable
// (HTTP fetch, pure logic, static lists). OS-level blanks (volume,
// brightness) stay per-host because they need shell-spawn (Node) or
// platform APIs (Web Audio).

export interface Blank {
  readonly name: string;
  readonly readOnly: boolean;

  get(keyword?: string, context?: string[]): Promise<string>;
  set?(value: string, keyword?: string): Promise<void>;
  up?(): Promise<string>;
  down?(): Promise<string>;
  /**
   * Drain the inverse of the last successful FILE WRITE this blank
   * performed (one-shot: returns it once, then null until the next
   * write). Implemented by the file-writing blanks (sentinel, note) so
   * `createBlankInvoke` can attach it to the ProcessResult and the
   * undo journal can revert the write later — by replaying `inverseOp`
   * through this same blank, i.e. back through its validator.
   */
  consumeLastWriteInverse?(): import('../adapter').BlankWriteInverse | null;
}
