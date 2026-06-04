#!/usr/bin/env node
// check-cc-patch-boot.cjs — verify the CC patch's emitted JS evaluates
// without ReferenceError when run as a CC keystroke handler would run it.
//
// WHY THIS EXISTS
//
// The CC integration patches a minified `cli.js` by injecting a JS
// string at the body of the keystroke handler `wH`. The patch source
// (`integrations/claude-code/patches/opencuesRuntime.ts`) emits that
// string. The emitted string is *syntactically* valid JS — the file
// parses fine — but it can have *scope errors* that only fire at
// runtime when the boot args object literal is evaluated.
//
// June 2026: commit cc38ab8 added `blanks: __ocReg,` to the boot args,
// but `__ocReg` was declared inside the `blankInvoke:(function(){...})()`
// IIFE — local-scoped, undefined outside it. Every keystroke after
// install raised `ReferenceError: __ocReg is not defined`, the outer
// catch set `globalThis.__oc.failed = true`, and OpenCues silently
// stopped working on every CC user's machine. No test caught it because:
//   - Source code typechecks (the patch is just a JS string)
//   - The patch APPLY step succeeds (the regex anchors hit)
//   - The bundled cli.js parses fine
//   - Runtime tests run the runtime directly, not via the patched cli.js
//
// THIS SCRIPT closes that gap. It:
//   1. Builds a synthetic cli.js that matches all 3 required seam
//      regexes (S1 KeyDispatcher, S2 InputStateHandler, S3 RenderedValue).
//   2. Calls writeOpenCuesRuntimeV2 to produce the patched cli.js.
//   3. Extracts the s1 bootstrap injection (the part inside wH's body).
//   4. Evaluates it in a Node `vm` sandbox with:
//        - cli.js identifiers stubbed (U, X, $, x, b4)
//        - @opencues/runtime require() stubbed to return mock module
//        - All async/Promise paths short-circuited
//   5. Asserts `globalThis.__oc` is defined and `failed !== true`.
//
// Exits 0 if the bootstrap evaluates cleanly, 1 otherwise. The failure
// message names the throwing identifier so the fix is obvious.

const path = require('path');
const fs = require('fs');
const vm = require('vm');
const Module = require('module');

const REPO_ROOT = path.join(__dirname, '..');
const PATCH_SRC = path.join(REPO_ROOT, 'integrations/claude-code/patches/opencuesRuntime.ts');

if (!fs.existsSync(PATCH_SRC)) {
  console.error(`✗ patch source not found at ${PATCH_SRC}`);
  process.exit(1);
}

// Load the patch source. esbuild (in repo dev-deps) transforms TS → JS
// in-memory; we then load the resulting module with a stubbed `./helpers`
// import. The real `./helpers` lives at
// `integrations/claude-code/tweakcc/src/patches/helpers.ts` and is only
// present after the installer clones tweakcc — we don't need its body,
// only the one export (`getRequireFuncName`) the patch uses. Stub returns
// 'require' (the Bun-shape default), which is what the native-binary
// patch path emits anyway.
let writeOpenCuesRuntimeV2;
try {
  const esbuild = require('esbuild');
  const src = fs.readFileSync(PATCH_SRC, 'utf8');
  const { code } = esbuild.transformSync(src, {
    loader: 'ts',
    format: 'cjs',
    target: 'node18',
  });
  const m = { exports: {} };
  // Intercept the `./helpers` require with a minimal stub. We only need
  // getRequireFuncName for native-binary shape; chalk/loader helpers are
  // unused by writeOpenCuesRuntimeV2.
  function patchRequire(p) {
    if (p === './helpers') return { getRequireFuncName: () => 'require' };
    return require(p);
  }
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', '__filename', '__dirname', code)(
    m, m.exports, patchRequire, PATCH_SRC, path.dirname(PATCH_SRC),
  );
  writeOpenCuesRuntimeV2 = m.exports.writeOpenCuesRuntimeV2;
  if (typeof writeOpenCuesRuntimeV2 !== 'function') {
    throw new Error('writeOpenCuesRuntimeV2 export missing or not a function');
  }
} catch (err) {
  console.error(`✗ could not load patch source: ${err.message}`);
  process.exit(1);
}

// ── Build a synthetic minimal cli.js matching all 3 required seams ──
//
// Each seam regex captures specific identifier names from the cli.js;
// the patch then references those captured names in the injected JS.
// The fixture MUST be minified — the seam regexes assume no whitespace
// inside function bodies (real cli.js is minified). Adding readable
// whitespace breaks the match.
//
// Identifiers chosen here to match what the regex captures:
//   S1: wH(WH,EH)  → captures funcName=wH, eventParam=WH, keyParam=EH
//   S2: PH({value:V,onChange:OC,...externalOffset:EO,onOffsetChange:OOC,...}){let O=EO,OC2=OOC,IZ=b4.fromText(V,X,O)...return{handleKeyDown:wH,renderedValue:...
//   S3: renderedValue:IZ.render(D,j,J,NH,W,R,C)  → captures expression
const FAKE_CLI_JS = [
  // S1: function wH(WH,EH){switch(WH.key){case"escape": ...
  `function wH(WH,EH){switch(WH.key){case"escape":return;case"left":return U.left();default:return U;}}`,
  // S2: input-state handler — destructured props with externalOffset +
  // onOffsetChange + downstream `let O=EO,OC2=OOC,IZ=b4.fromText(V,X,O)`
  // ...followed by `return{handleKeyDown:wH,renderedValue:IZ.render(...)`
  `function PH({value:V,onChange:OC,disableEscapeDoublePress:G,maxVisibleLines:W,externalOffset:EO,onOffsetChange:OOC,inputFilter:F}){let O=EO,OC2=OOC,IZ=b4.fromText(V,X,O);let D=0,j=0,J=0,NH=0,R=0,C=0;return{handleKeyDown:wH,renderedValue:IZ.render(D,j,J,NH,W,R,C),offset:O,setOffset:OC2,cursorLine:0,cursorColumn:0,viewportCharOffset:0,viewportCharEnd:0}}`,
  // Globals the bootstrap references after lazy-init
  `var X=80;function $(t){U=b4.fromText(t,X,U.offset)}function x(o){U=b4.fromText(U.text,X,o)}`,
  `class b4{constructor(t,c,o){this.text=t;this.cols=c;this.offset=o}static fromText(t,c,o){return new b4(t,c,o)}render(D,j,J,NH,W,R,C){return""}get(p){return""}equals(o){return o&&o.text===this.text&&o.offset===this.offset}left(){return this}right(){return this}down(){return this}downLogicalLine(){return this}getPosition(){return{line:0,column:0}}getViewportStartLine(){return 0}getViewportCharOffset(){return 0}getViewportCharEnd(){return 0}}`,
  `var U=b4.fromText("",80,0);`,
].join('\n');

// ── Apply the patch ───────────────────────────────────────────────
let patched;
try {
  patched = writeOpenCuesRuntimeV2(FAKE_CLI_JS);
} catch (err) {
  console.error(`✗ writeOpenCuesRuntimeV2 threw: ${err.message}`);
  process.exit(1);
}
if (patched == null) {
  console.error('✗ writeOpenCuesRuntimeV2 returned null — seam regexes did not match the fixture');
  console.error('  Check S1/S2/S3 regex shapes against the fake cli.js if the patch source changed seams.');
  process.exit(1);
}

// ── Extract the s1 bootstrap injection ────────────────────────────
//
// The injection starts with `try{if(!globalThis.__oc){` (the S1 lazy-
// init guard) and ends with the matching `}catch(__ocOe){...}` that
// closes the dispatch try block.
const BOOT_START = 'try{if(!globalThis.__oc){';
const startIdx = patched.indexOf(BOOT_START);
if (startIdx < 0) {
  console.error('✗ could not locate bootstrap start marker in patched output');
  process.exit(1);
}
// The bootstrap ends right before the original switch statement of wH.
// We walk balanced braces from the start to find the end of the
// surrounding `try{ ... }catch(__ocOe){ ... }` block.
const switchIdx = patched.indexOf('switch(WH.key)', startIdx);
if (switchIdx < 0) {
  console.error('✗ could not locate original switch statement after bootstrap');
  process.exit(1);
}
const bootstrap = patched.slice(startIdx, switchIdx);

// ── Build the sandbox + stubs ─────────────────────────────────────
//
// The bootstrap calls require('@opencues/runtime/dist/adapters/cc/v2.1/boot.js')
// and other @opencues paths via the embedded `__oc_req` helper. We
// hook Node's module resolver to return mock objects for any
// @opencues/* path. The mock `boot` function verifies the args were
// constructed (caught the ReferenceError bug) and returns a minimal
// BootResult.

const stubBootArgs = { received: null };
function mockBoot(args) {
  stubBootArgs.received = args;
  return {
    adapter: { log: () => {}, getText: () => '', getCursorOffset: () => 0 },
    hlState: {},
    dynDefs: {},
    failed: false,
    dispatchKey: () => false,
    consumePendingRender: () => null,
    resetBufferState: () => {},
    applyRender: (x) => x,
  };
}

// Prefer the REAL built @opencues/runtime + @opencues/core when their
// dist/ exists — that way an API drift between the patch and the runtime
// (renamed field, new required arg to createDefaultBlanksRegistry, etc.)
// fails the smoke. Stubs are the fallback for fresh-clone environments
// where the runtime hasn't been built yet.
const RUNTIME_DIST = path.join(REPO_ROOT, 'packages/opencues-runtime/dist');
const CORE_DIST = path.join(REPO_ROOT, 'packages/opencues-core/dist');

let realRuntime = null;
let realCore = null;
let usingRealRuntime = false;
if (fs.existsSync(RUNTIME_DIST) && fs.existsSync(CORE_DIST)) {
  try {
    realRuntime = require(path.join(RUNTIME_DIST, 'src/blanks/index.js'));
    realCore = require(path.join(CORE_DIST, 'index.js'));
    usingRealRuntime = true;
  } catch (err) {
    // dist exists but won't load — log and fall back to stubs.
    console.error(`  (warn) real runtime exists at ${RUNTIME_DIST} but failed to load: ${err.message}`);
    console.error('  (warn) falling back to stubs — API-drift detection disabled for this run');
  }
}

const stubRuntime = {
  boot: mockBoot,
  createDefaultBlanksRegistry: () => new Map([['sentinel', {}], ['opencues', {}]]),
  createBlankInvoke: () => () => null,
  buildUserBlankRegistry: () => new Map(),
  createNativeLlmAdapter: () => null,
  // security paths
  validateScriptPath: () => ({ ok: true }),
  appendAuditLog: () => {},
  wrapWithBwrap: () => null,
};

const stubCore = {
  parseSingleCueMd: () => ({ blanks: {} }),
};

// Compose: when the real runtime is loaded, take its public functions
// (createDefaultBlanksRegistry etc.) BUT override `boot` to our recorder.
// Same for core. Stubs fill any path the real module doesn't expose.
function composeRuntime() {
  if (!usingRealRuntime) return stubRuntime;
  return new Proxy({}, {
    get(_, prop) {
      if (prop === 'boot') return mockBoot;
      if (prop in realRuntime) return realRuntime[prop];
      // Subpaths like security/spawn-sandbox.js come in as require() with
      // a deeper specifier — those resolve separately in sandboxRequire.
      return stubRuntime[prop];
    },
  });
}

function composeCore() {
  if (!usingRealRuntime) return stubCore;
  return new Proxy({}, {
    get(_, prop) {
      if (prop in realCore) return realCore[prop];
      return stubCore[prop];
    },
  });
}

const opencuesRuntimeMock = composeRuntime();
const opencuesCoreMock = composeCore();

// Intercept require() calls inside the sandbox to return our stubs.
function sandboxRequire(p) {
  if (typeof p !== 'string') return require(p);
  if (p.startsWith('@opencues/core')) return opencuesCoreMock;
  if (p.startsWith('@opencues/runtime')) {
    // Specific subpaths: route to the real dist file when available.
    // `dist/src/blanks/index.js`, `dist/src/security/spawn-sandbox.js`,
    // `dist/adapters/cc/v2.1/boot.js`, etc.
    if (usingRealRuntime) {
      const subpath = p.replace(/^@opencues\/runtime\//, '');
      const realPath = path.join(RUNTIME_DIST, subpath.replace(/^dist\//, ''));
      if (fs.existsSync(realPath)) {
        try {
          const mod = require(realPath);
          // Wrap boot so it goes through our recorder (only relevant for boot.js)
          if (mod && typeof mod.boot === 'function') {
            return new Proxy(mod, {
              get: (target, key) => (key === 'boot' ? mockBoot : target[key]),
            });
          }
          return mod;
        } catch { /* fall through to composed runtime */ }
      }
    }
    return opencuesRuntimeMock;
  }
  // Real Node built-ins (fs, path, child_process, os) flow through.
  if (['fs', 'path', 'child_process', 'os'].includes(p)) {
    return require(p);
  }
  return {};
}

// Wrap the bootstrap in a function we can call as if it were wH(WH, EH).
const sandbox = {
  globalThis: {},
  process,
  Promise,
  Date,
  Map,
  Array,
  Object,
  String,
  Number,
  Boolean,
  JSON,
  setTimeout,
  clearTimeout,
  console,
  require: sandboxRequire,
  __filename,
  __dirname,
  // cli.js identifiers used by the bootstrap (matches the seam captures
  // for the fake cli.js above):
  WH: { name: 'a', key: 'a', ctrl: false, alt: false, meta: false, option: false, shift: false },
  EH: 'a',
  U: { text: '', offset: 0, render: () => '', getPosition: () => ({ line: 0, column: 0 }) },
  X: 80,
  $: () => {},
  x: () => {},
  b4: {
    fromText: (t, c, o) => ({ text: t, offset: o, render: () => '', equals: () => true }),
  },
};
sandbox.globalThis = sandbox; // self-reference, mirrors browser/Node behaviour

vm.createContext(sandbox);

// ── Run the bootstrap and assert ──────────────────────────────────
//
// We don't care about the OUTER try/catch in the bootstrap proper —
// we want to see if the BOOT args evaluation throws. The patch wraps
// boot() in its own try/catch and sets globalThis.__oc.failed=true on
// throw. So we just need to check the final state of globalThis.__oc.
//
// Wrap the bootstrap in `function wH(WH, EH) {...}` so `return` is
// legal — the patch's injected code lives inside the real cli.js's
// wH function body and includes early-return paths.
const wrapped = `function wH(WH,EH){${bootstrap}}wH({key:"a",name:"a",ctrl:false,alt:false,meta:false,option:false,shift:false},"a");`;
try {
  vm.runInContext(wrapped, sandbox, { timeout: 5000 });
} catch (err) {
  console.error(`✗ bootstrap evaluation threw: ${err.message}`);
  console.error('  This is a syntax/parse error or an unhandled throw OUTSIDE the patch\'s own try/catch.');
  process.exit(1);
}

if (!sandbox.globalThis.__oc) {
  console.error('✗ bootstrap completed but globalThis.__oc was never set');
  console.error('  The S1 injection may have a logic bug (does !globalThis.__oc gate ever fire?).');
  process.exit(1);
}

if (sandbox.globalThis.__oc.failed === true) {
  console.error('✗ globalThis.__oc.failed === true after bootstrap evaluation');
  console.error('');
  console.error('  This is the bug class lint-legacy-names cannot catch:');
  console.error('  the patch emits syntactically valid JS that ReferenceErrors at');
  console.error('  runtime when the boot args object literal is evaluated. The patch\'s');
  console.error('  own try/catch swallows the error and sets failed=true — OpenCues');
  console.error('  stops dispatching on every CC user\'s machine.');
  console.error('');
  console.error('  Diagnostic: look at the boot args constructed in writeOpenCuesRuntimeV2');
  console.error('  (integrations/claude-code/patches/opencuesRuntime.ts). Any identifier');
  console.error('  referenced in the args object literal MUST be declared in the s1Bootstrap');
  console.error('  scope (not inside an IIFE in the args themselves).');
  process.exit(1);
}

if (!stubBootArgs.received) {
  console.error('✗ boot() was never called — bootstrap fell into an unexpected branch');
  process.exit(1);
}

// Verify the structural contract — these fields are what the runtime
// reads. If any go missing, the runtime degrades silently in different
// ways. Adding a row here means the smoke catches that regression too.
const required = ['blankInvoke', 'blanks', 'spawnProcess', 'readFile', 'writeFile', 'log', 'statusFilePath', 'cursorStatePath'];
const missing = required.filter(k => !(k in stubBootArgs.received));
if (missing.length) {
  console.error(`✗ boot() args missing fields: ${missing.join(', ')}`);
  console.error('  These are the contract between the CC patch and @opencues/runtime\'s');
  console.error('  CC v2.1 adapter. Removing a field silently breaks features (sentinel,');
  console.error('  blank-as-context, status export, etc.).');
  process.exit(1);
}

// Verify blankInvoke + blanks are non-null shapes — the June 2026 bug
// would have produced `blanks: undefined` (or thrown earlier).
if (typeof stubBootArgs.received.blankInvoke !== 'function') {
  console.error(`✗ boot args.blankInvoke is not a function (got ${typeof stubBootArgs.received.blankInvoke})`);
  process.exit(1);
}
if (!stubBootArgs.received.blanks || typeof stubBootArgs.received.blanks.get !== 'function') {
  console.error(`✗ boot args.blanks is not a Map (got ${stubBootArgs.received.blanks})`);
  console.error('  Most likely cause: __ocReg was declared inside an IIFE in the boot args');
  console.error('  and is undefined in the outer scope where `blanks: __ocReg` is evaluated.');
  console.error('  See the June 2026 cc38ab8 bug fix in opencuesRuntime.ts for the structural pattern.');
  process.exit(1);
}

// When running against the real @opencues/runtime, verify the built-in
// blanks the patch is supposed to wire actually got registered. This
// catches API-drift bugs where the patch sends a stale option name —
// the real createDefaultBlanksRegistry silently ignores unknown keys
// instead of throwing (it's lenient by design — host bootstraps may
// omit blanks they don't need). Without this check, a typo like
// `sentinelsMdIO` (legacy) vs `identityMdIO` (current) would not fire
// the smoke even though the user-visible feature would be silently
// broken on every CC install.
//
// The list below is the SUBSET of BUILTIN_BLANKS that depend on host-
// supplied IO/llm bindings the CC patch provides:
//   - sentinel  → needs identityMdIO (set sentinel _ blank)
//   - opencues  → needs opencuesMdIO (settings cycler blank)
// Adding a new IO-binding-dependent built-in? Add it here too.
if (usingRealRuntime) {
  const registered = stubBootArgs.received.blanks;
  const expectedBlanks = ['sentinel', 'opencues'];
  const missingBlanks = expectedBlanks.filter(name => !registered.has(name));
  if (missingBlanks.length) {
    console.error(`✗ CC patch's blanks registry is missing built-ins: ${missingBlanks.join(', ')}`);
    console.error('');
    console.error('  The real @opencues/runtime\'s createDefaultBlanksRegistry was called with');
    console.error('  options the patch constructed, but at least one expected blank failed to');
    console.error('  register. Most likely cause: the patch is sending a stale option name');
    console.error('  that the runtime no longer recognises (e.g. an old field renamed in a');
    console.error('  recent runtime release without a matching patch update).');
    console.error('');
    console.error('  Check `BuiltinBlankContext` in packages/opencues-runtime/src/blanks/index.ts');
    console.error('  against the field names emitted by the patch in opencuesRuntime.ts (search for');
    console.error('  `Md IO` in the args object). Field names must match exactly.');
    process.exit(1);
  }
}

console.log('✓ CC patch boot smoke clean — boot args constructed without ReferenceError');
console.log(`  boot called with ${required.length} required fields; __ocReg + __ocBI both in scope`);
if (usingRealRuntime) {
  console.log('  mode: real @opencues/runtime + @opencues/core dist (API drift would fail here)');
} else {
  console.log('  mode: stubs only (no dist found — API-drift detection disabled this run)');
  console.log('  hint: run `pnpm build` first to enable the real-runtime path');
}
process.exit(0);
