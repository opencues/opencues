/**
 * `$HOME`, or `~` where there is no process.
 *
 * Browser hosts have no `process`, and a bare `process.env.HOME` throws
 * `ReferenceError: process is not defined` there. Both call sites sit
 * inside handlers — BlankFill's text-change handler and Cycling's
 * script-set path — so the throw does not fail one blank, it takes the
 * whole handler down: every script-backed blank silently stops working
 * and the only symptom is "nothing happens".
 *
 * Found on DeepSeek Harness, where stocks / weather / hackernews were dead
 * while dictionary (which reaches no script path) worked. Chrome had been
 * masking it by `define`-ing `process.env.HOME` in its own esbuild config,
 * which is why the browser-safe lint exempted the name — an exemption that
 * silently required every future browser host to replicate chrome's define
 * list. Guarding here instead makes the runtime correct for any host.
 */
export function homeDir(): string {
  return (typeof process !== 'undefined' && process.env?.HOME) ? process.env.HOME : '~';
}
