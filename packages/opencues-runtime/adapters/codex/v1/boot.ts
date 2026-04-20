// Codex (codex-rs) v1 adapter band — pre-alpha placeholder.
//
// Unlike CC (which patches a JavaScript cli.js with embedded require)
// and OC (which is a TypeScript fork we patch directly), Codex is Rust.
// We can't load @opencues/runtime in-process. Instead the runtime is
// instantiated by a daemon (`./daemon.ts`) that the codex TUI spawns
// as a subprocess and talks to via JSON-RPC over stdio.
//
// This file is intentionally a thin re-export of the daemon entry +
// a HostInfo type so the rest of the runtime can refer to "codex
// adapter v1" symbolically. No boot() function — see daemon.ts.

export { startDaemon } from './daemon';
export type { CodexHostInfo } from './daemon';
