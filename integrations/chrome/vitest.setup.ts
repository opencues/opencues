// Vitest setup — runs BEFORE test modules import the code under test.
// runtime-renderer.ts evaluates `typeof CSS !== 'undefined' && 'highlights'
// in CSS` at module-load time and stashes the result in `hasHighlightAPI`.
// We need the shim in place before that evaluation, so set it up here.

// esbuild defines these at build time; tests need stand-ins so files
// that read them at module-load (types.ts) don't ReferenceError.
(globalThis as Record<string, unknown>).__GROQ_API_KEY__ ??= '';
(globalThis as Record<string, unknown>).__FINNHUB_API_KEY__ ??= '';

(globalThis as unknown as { Highlight: unknown }).Highlight =
  class { constructor(..._r: unknown[]) { /* shim — ranges ignored */ } };

if (!(globalThis as unknown as { CSS?: unknown }).CSS) {
  (globalThis as unknown as { CSS: unknown }).CSS = {};
}
(globalThis as unknown as { CSS: { highlights: Map<string, unknown> } }).CSS.highlights =
  new Map<string, unknown>();
