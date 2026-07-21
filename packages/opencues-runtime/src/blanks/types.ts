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
   * Optional SYNCHRONOUS validation of a shape-captured arg ("is this
   * something I can actually answer?" — countries: arg is in the
   * offline table). When declared, ConfigLoader stamps it onto the
   * blank's config as `argValidator`, and `matchBlankShape` refuses a
   * shape whose captured arg fails — the `_` is then never claimed by
   * this blank and falls to fluid-blank (the LLM answers the flawed
   * question instead of the blank substituting a not-found error).
   * MUST be pure + fast: it runs inside per-keystroke shape matching.
   * Only meaningful for blanks whose data is local/offline; a blank
   * that needs I/O to know cannot implement this.
   */
  validArg?(arg: string): boolean;
}
