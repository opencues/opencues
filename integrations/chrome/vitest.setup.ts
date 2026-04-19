// Vitest setup — runs BEFORE test modules import the code under test.
// runtime-renderer.ts evaluates `typeof CSS !== 'undefined' && 'highlights'
// in CSS` at module-load time and stashes the result in `hasHighlightAPI`.
// We need the shim in place before that evaluation, so set it up here.

(globalThis as unknown as { Highlight: unknown }).Highlight =
  class { constructor(..._r: unknown[]) { /* shim — ranges ignored */ } };

if (!(globalThis as unknown as { CSS?: unknown }).CSS) {
  (globalThis as unknown as { CSS: unknown }).CSS = {};
}
(globalThis as unknown as { CSS: { highlights: Map<string, unknown> } }).CSS.highlights =
  new Map<string, unknown>();
