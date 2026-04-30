// Shared Blank interface — every blank (script-replaceable control)
// across hosts (chrome, opencode, claude-code) implements this same
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
}
