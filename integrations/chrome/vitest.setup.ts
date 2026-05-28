// Vitest setup — runs BEFORE test modules import the code under test.
// runtime-renderer.ts evaluates `typeof CSS !== 'undefined' && 'highlights'
// in CSS` at module-load time and stashes the result in `hasHighlightAPI`.
// We need the shim in place before that evaluation, so set it up here.

// esbuild defines these at build time; tests need stand-ins so files
// that read them at module-load (types.ts) don't ReferenceError.
(globalThis as Record<string, unknown>).__GROQ_API_KEY__ ??= '';

(globalThis as unknown as { Highlight: unknown }).Highlight =
  class { constructor(..._r: unknown[]) { /* shim — ranges ignored */ } };

if (!(globalThis as unknown as { CSS?: unknown }).CSS) {
  (globalThis as unknown as { CSS: unknown }).CSS = {};
}
(globalThis as unknown as { CSS: { highlights: Map<string, unknown> } }).CSS.highlights =
  new Map<string, unknown>();
// CSS.escape — used by the gatherer for `label[for="..."]` selector
// safety. jsdom doesn't ship it; minimal-correct shim matches the spec
// for the chars OpenCues' ID lookups produce (alphanumerics, hyphen,
// underscore, occasional uppercase). Doesn't need to be CSSOM-perfect.
if (typeof (globalThis as unknown as { CSS: { escape?: unknown } }).CSS.escape !== 'function') {
  (globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS.escape =
    (s: string) => String(s).replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
}

// Minimal `chrome` stub so modules that touch `chrome.storage` /
// `chrome.runtime` at top-level (bootstrap.ts, background.ts) don't
// throw ReferenceError during test imports. Tests that need real
// storage behaviour (e.g. chrome-storage-adapter.test.ts) override
// this with their own per-test stub.
if (!(globalThis as unknown as { chrome?: unknown }).chrome) {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
      onChanged: {
        addListener: () => { /* no-op */ },
        removeListener: () => { /* no-op */ },
      },
    },
    runtime: {
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener: () => { /* no-op */ } },
      connect: () => ({ postMessage: () => { /* no-op */ }, onMessage: { addListener: () => { /* no-op */ } }, onDisconnect: { addListener: () => { /* no-op */ } } }),
    },
  };
}
