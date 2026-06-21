// Bundle-time stub for node:fs / node:path in the PLAYWRIGHT harness
// bundles. boot-common's checkRuntimeDrift (PR #47) does
// `await import('node:fs')` + `node:path` for a direct-launch advisory
// that's meaningless in a browser. The production chrome build marks
// them `external` (esbuild.config.mjs) and relies on the dynamic-import
// THROWING at runtime, caught by boot-common's own try/catch.
//
// In the test harness that rejection surfaced as an unhandled module
// failure during the Draft.js/React harness init, so `window.__OC`
// never got set and the page-load wait timed out. Resolving the import
// to this empty stub instead means the dynamic import succeeds, the
// advisory finds no usable fs/path methods, and its try/catch
// silent-skips — same end state, no rejection noise.
export default {};
