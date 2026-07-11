// Ambient stub for @opencode-ai/plugin's types.
//
// The real package is only present inside an installed OpenCode fork
// (patches/setup.sh clones sst/opencode and its own package.json
// brings in @opencode-ai/plugin as a fork-local dependency) — it is
// NOT an npm dependency of this integration package, so `tsc` run
// from here can't resolve it. This stub gives the type checker a
// minimal shape for `Plugin` so `plugin/cues.ts` can typecheck in
// isolation; it intentionally does not attempt to mirror the full
// real API surface (only what cues.ts's `import type { Plugin }`
// needs to resolve).
declare module '@opencode-ai/plugin' {
  export type Plugin = (input: any) => Promise<Record<string, (...args: any[]) => any>>;
}
