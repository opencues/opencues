#!/usr/bin/env node
// User-blank Node subprocess runner.
//
// Spawned by SubprocessIsolateRunner (subprocess-loader.ts) on Bun-based
// hosts (opencode, shell) where the in-process `isolated-vm` binding can't
// load against JavaScriptCore. The main process IPCs to this script over
// newline-delimited JSON on stdin/stdout. The script owns the isolated-vm
// sandboxes; capability calls (fetch / storage / llm / secrets) round-trip
// back to the main process so capability gating + quotas live on the
// main side exactly as they did when isolated-vm ran in-process.
//
// Threat model: same as the in-process loader (see node-loader.ts header).
// User code runs in a real V8 isolate with its own intrinsics; the only
// references it holds back to the host realm are the ctx capability shims,
// and each of those serializes through JSON before the main process sees it.
//
// Protocol — see subprocess-loader.ts for the typed shapes. Summary:
//   main → us:  { op: 'load' | 'get' | 'set' | 'shutdown' | 'cap-result', ... }
//   us → main:  { op: 'load-result' | 'get-result' | 'set-result' | 'log'
//                  | 'cap-fetch' | 'cap-storage-get' | 'cap-storage-set'
//                  | 'cap-llm' | 'cap-secret', ... }
//
// Capability calls work like this: when the user blank calls ctx.fetch(url),
// the isolate-side shim invokes a host Reference. The host Reference's body
// sends a `cap-fetch` message with a fresh `callbackId` over stdout, then
// awaits a Promise that resolves when a matching `cap-result` arrives on
// stdin. The main process executes the actual fetch (with allow-list +
// quota + secret-binding checks) and replies. Same shape for storage / llm.
//
// This file is shipped to ~/.opencues/vendor/user-blank-runner.cjs by the
// host installers (opencues install opencode / shell). It is plain CJS so
// it runs under any Node ≥ 20 without a build step.
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

// ─── isolated-vm load ────────────────────────────────────────────────────
// Same lazy-load posture as the in-process loader, but here we run on real
// Node so the binding MUST be present. If it's not, the runner can't do
// its job — exit cleanly with a recognisable error so the main process
// can fall back to "user-pack JS unavailable" instead of crashing.

let ivm;
try {
  ivm = require('isolated-vm');
} catch (e) {
  process.stderr.write(
    `[user-blank-runner] isolated-vm load failed: ${(e && e.message) || e}\n` +
    `  This Node install can't run user-pack JS blanks. Re-run\n` +
    `  \`opencues install <host>\` to reinstall the vendor dep, or\n` +
    `  set OPENCUES_DISABLE_USER_BLANK_JS=1 to silence the warning.\n`,
  );
  process.exit(2);
}

// ─── IPC framing ─────────────────────────────────────────────────────────

let stdinBuf = '';
// Top-level / non-cap messages serialize (load / get / set / shutdown) so a
// shutdown right after a get can't kill an in-flight invocation. `cap-result`
// bypasses the chain because it RESOLVES work already pending in pendingCaps —
// queueing it behind another invoke would deadlock when the cap reply arrives
// while we're awaiting it.
let dispatchChain = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk;
  let nl;
  while ((nl = stdinBuf.indexOf('\n')) >= 0) {
    const line = stdinBuf.slice(0, nl);
    stdinBuf = stdinBuf.slice(nl + 1);
    if (line.length === 0) continue;
    let msg;
    try { msg = JSON.parse(line); }
    catch (e) {
      writeOut({ op: 'log', level: 'error', message: `bad json from main: ${e.message}` });
      continue;
    }
    if (msg && msg.op === 'cap-result') {
      handleCapResult(msg);
      continue;
    }
    dispatchChain = dispatchChain.then(
      () => handleMessage(msg),
      () => handleMessage(msg),
    ).catch((e) => {
      writeOut({ op: 'log', level: 'error', message: `unhandled in handleMessage: ${(e && e.stack) || e}` });
    });
  }
});
process.stdin.on('end', () => {
  // Main closed stdin — drain in-flight work before exiting.
  dispatchChain.finally(() => { shutdownAll(); process.exit(0); });
});
process.on('SIGTERM', () => { shutdownAll(); process.exit(0); });
process.on('SIGINT',  () => { shutdownAll(); process.exit(0); });

function writeOut(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } catch (e) {
    process.stderr.write(`[user-blank-runner] writeOut failed: ${e.message}\n`);
  }
}

function logBack(level, message, extra) {
  const m = { op: 'log', level: level, message: String(message) };
  if (extra !== undefined) {
    try { m.data = JSON.parse(JSON.stringify(extra)); } catch { /* drop */ }
  }
  writeOut(m);
}

// ─── Per-blank state ─────────────────────────────────────────────────────
//
// One isolate + context per `load` op. Disposed on `shutdown` or when the
// main process exits. `blankName` is the registration key.

/** @type {Map<string, { isolate: any, context: any, defaultRef: any, timeoutMs: number }>} */
const blanks = new Map();

// Pending capability callbacks. Keyed by callbackId; main process echoes
// the same id back in `cap-result`. The resolve/reject pair is owned here
// in the runner; the main side just shuttles JSON.
/** @type {Map<string, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
const pendingCaps = new Map();
let nextCapId = 1;
function newCapId() { return 'c' + (nextCapId++); }

function awaitCap(req) {
  const callbackId = newCapId();
  return new Promise((resolve, reject) => {
    pendingCaps.set(callbackId, { resolve, reject });
    writeOut(Object.assign({ callbackId: callbackId }, req));
  });
}

// ─── Message dispatch ────────────────────────────────────────────────────

async function handleMessage(msg) {
  if (!msg || typeof msg.op !== 'string') return;
  switch (msg.op) {
    case 'load':     return handleLoad(msg);
    case 'get':      return handleInvoke(msg, 'get');
    case 'set':      return handleInvoke(msg, 'set');
    case 'shutdown': return handleShutdown();
    default:
      logBack('warn', `unknown op: ${msg.op}`);
  }
}

function handleCapResult(msg) {
  const cb = pendingCaps.get(msg.callbackId);
  if (!cb) {
    logBack('warn', `cap-result for unknown callbackId: ${msg.callbackId}`);
    return;
  }
  pendingCaps.delete(msg.callbackId);
  if (msg.ok) cb.resolve(msg.value);
  else cb.reject(new Error(msg.error || 'capability call failed'));
}

// ─── load ────────────────────────────────────────────────────────────────
//
// Main process has already done the ESM-rewrite + capability validation; we
// just instantiate the isolate, run the source, and stash the default export
// reference. Source is passed in as a string (`sourceCode`).

async function handleLoad(msg) {
  const id = msg.id;
  const blankName = msg.blankName;
  const sourceCode = msg.sourceCode;
  const modulePath = msg.modulePath || '<inline>';
  const timeoutMs = (msg.timeoutMs && Number.isFinite(msg.timeoutMs)) ? msg.timeoutMs : 8000;
  const memoryLimit = (msg.memoryLimitMb && Number.isFinite(msg.memoryLimitMb)) ? msg.memoryLimitMb : 32;

  try {
    if (blanks.has(blankName)) {
      // Replace prior load (e.g. fs.watch retriggered registry).
      try { blanks.get(blankName).isolate.dispose(); } catch { /* */ }
      blanks.delete(blankName);
    }

    const isolate = new ivm.Isolate({ memoryLimit: memoryLimit });
    const context = isolate.createContextSync();
    const jail = context.global;

    jail.setSync('global', jail.derefInto());
    jail.setSync('globalThis', jail.derefInto());

    // Console — same shape as the in-process loader. Routes back to main
    // via cap-log so the host's logger sees it. We use `cap-log` (a no-
    // wait cap) for these because they're fire-and-forget; alternatively
    // the existing top-level `log` op works fine.
    const consoleLog = new ivm.Reference((s) => logBack('info',  String(s)));
    const consoleWarn = new ivm.Reference((s) => logBack('warn',  String(s)));
    const consoleErr  = new ivm.Reference((s) => logBack('error', String(s)));
    jail.setSync('__oc_console_log',  consoleLog);
    jail.setSync('__oc_console_warn', consoleWarn);
    jail.setSync('__oc_console_err',  consoleErr);
    context.evalSync(
      'globalThis.console = {' +
      "  log:   (...a) => __oc_console_log.applyIgnored(undefined, [a.map(String).join(' ')])," +
      "  info:  (...a) => __oc_console_log.applyIgnored(undefined, [a.map(String).join(' ')])," +
      "  warn:  (...a) => __oc_console_warn.applyIgnored(undefined, [a.map(String).join(' ')])," +
      "  error: (...a) => __oc_console_err.applyIgnored(undefined, [a.map(String).join(' ')])," +
      "  debug: (...a) => __oc_console_log.applyIgnored(undefined, [a.map(String).join(' ')])," +
      '};'
    );

    // CJS shim — same as in-process. Main has already rewritten ESM →
    // module.exports.default assignment.
    context.evalSync(
      'globalThis.module = { exports: {} };' +
      'globalThis.exports = globalThis.module.exports;'
    );

    let script;
    try {
      script = isolate.compileScriptSync(sourceCode, { filename: modulePath });
    } catch (e) {
      isolate.dispose();
      writeOut({ op: 'load-result', id: id, ok: false, error: `compile failed: ${e.message}` });
      return;
    }
    try {
      script.runSync(context, { timeout: timeoutMs });
    } catch (e) {
      isolate.dispose();
      writeOut({ op: 'load-result', id: id, ok: false, error: `run failed: ${e.message}` });
      return;
    }

    const defaultRef = context.evalSync(
      'module.exports.default !== undefined ? module.exports.default : module.exports',
      { reference: true },
    );
    if (!defaultRef || defaultRef.typeof !== 'object') {
      isolate.dispose();
      writeOut({ op: 'load-result', id: id, ok: false, error: 'no default export object' });
      return;
    }

    blanks.set(blankName, {
      isolate: isolate,
      context: context,
      defaultRef: defaultRef,
      timeoutMs: timeoutMs,
      capsAvailable: msg.capsAvailable || {},
    });
    writeOut({ op: 'load-result', id: id, ok: true });
  } catch (e) {
    writeOut({ op: 'load-result', id: id, ok: false, error: `load threw: ${(e && e.stack) || e}` });
  }
}

// ─── invoke ──────────────────────────────────────────────────────────────
//
// `get` and `set` differ only in the method name + arg packing. The main
// process bundles call-time capability config in the message (network
// allow-list resolution + secrets is already done; ctx callbacks just
// send `cap-*` back).

async function handleInvoke(msg, opName) {
  const id = msg.id;
  const blankName = msg.blankName;
  const args = Array.isArray(msg.args) ? msg.args : [];
  const replyOp = opName + '-result';

  const slot = blanks.get(blankName);
  // Refresh per-invocation secrets if main provided them. Lets the host
  // rotate keys without re-loading the blank.
  if (slot && msg.secrets && typeof msg.secrets === 'object') {
    slot.secrets = msg.secrets;
  }
  if (!slot) {
    writeOut({ op: replyOp, id: id, ok: false, error: `blank "${blankName}" not loaded` });
    return;
  }

  try {
    const result = await invokeUserMethod(slot, opName, args, id);
    if (opName === 'set') {
      writeOut({ op: replyOp, id: id, ok: true });
    } else {
      writeOut({ op: replyOp, id: id, ok: true, value: result == null ? null : String(result) });
    }
  } catch (e) {
    writeOut({ op: replyOp, id: id, ok: false, error: (e && e.message) || String(e) });
  }
}

async function invokeUserMethod(slot, methodName, args, requestId) {
  const context = slot.context;
  const defaultRef = slot.defaultRef;
  const timeoutMs = slot.timeoutMs;

  // ctx callbacks all reach back to main via cap-* IPC. Each receives a
  // requestId in its outbound message so main can correlate the cap call
  // with the originating get/set (needed for per-blank quota tracking).

  const refNow   = new ivm.Reference(() => Date.now());
  const refLog   = new ivm.Reference((lvl, m, data) => logBack(String(lvl), String(m), data));
  const refFetch = new ivm.Reference(async (url, initStr) => {
    let init = undefined;
    if (initStr) {
      try { init = JSON.parse(initStr); }
      catch { throw new Error('ctx.fetch: bad init'); }
    }
    const raw = await awaitCap({
      op: 'cap-fetch', id: requestId, url: String(url), init: init,
    });
    return typeof raw === 'string' ? raw : JSON.stringify(raw);
  });
  const refLlm = new ivm.Reference(async (reqJson) => {
    const req = JSON.parse(reqJson);
    return awaitCap({ op: 'cap-llm', id: requestId, req: req });
  });
  const refStorageGet = new ivm.Reference(async (key) => {
    return awaitCap({ op: 'cap-storage-get', id: requestId, key: String(key) });
  });
  const refStorageSet = new ivm.Reference(async (key, value) => {
    return awaitCap({ op: 'cap-storage-set', id: requestId, key: String(key), value: String(value) });
  });

  // Secrets are passed in once per invocation. The main process decides
  // (based on the blank's BlankCapabilities) what subset to forward; the
  // user code sees them as a frozen object on ctx.secrets.
  const secretsJson = JSON.stringify(slot.secrets || null);

  // Build the ctx-shim INSIDE the isolate. ctx.fetch / ctx.llm /
  // ctx.storage are only attached when the host advertised them at load
  // time — keeps capability gating consistent with the in-process loader
  // (undeclared capability → `ctx.fetch === undefined` so user code can
  // feature-detect).
  const caps = slot.capsAvailable || {};
  const ctxShimBuilder = context.evalSync(
    '(function buildCtx(refNow, refLog, refFetch, refLlm, refStorageGet, refStorageSet, secretsJson) {' +
    '  const ctx = {};' +
    '  ctx.now = () => refNow.applySync();' +
    '  ctx.log = (lvl, msg, data) => refLog.applyIgnored(undefined, [lvl, msg, data], { arguments: { copy: true } });' +
    '  if (refFetch) ctx.fetch = async (url, init) => {' +
    '    const initStr = init === undefined ? undefined : JSON.stringify(init);' +
    '    const raw = await refFetch.apply(undefined, [url, initStr], {' +
    '      arguments: { copy: true },' +
    '      result: { promise: true, copy: true },' +
    '    });' +
    '    const r = JSON.parse(raw);' +
    '    return {' +
    '      ok: r.ok, status: r.status, statusText: r.statusText, headers: r.headers,' +
    '      text: async () => r.text,' +
    '      json: async () => JSON.parse(r.text),' +
    "      arrayBuffer: async () => { throw new Error('ctx.fetch: arrayBuffer not supported in user-blank subprocess'); }," +
    "      blob:    async () => { throw new Error('ctx.fetch: blob not supported in user-blank subprocess'); }," +
    '    };' +
    '  };' +
    '  if (refLlm) ctx.llm = async (req) => {' +
    '    const reqStr = JSON.stringify(req);' +
    '    return refLlm.apply(undefined, [reqStr], {' +
    '      arguments: { copy: true }, result: { promise: true, copy: true },' +
    '    });' +
    '  };' +
    '  if (refStorageGet && refStorageSet) ctx.storage = {' +
    '    get: async (k) => refStorageGet.apply(undefined, [k], {' +
    '      arguments: { copy: true }, result: { promise: true, copy: true },' +
    '    }),' +
    '    set: async (k, v) => refStorageSet.apply(undefined, [k, v], {' +
    '      arguments: { copy: true }, result: { promise: true, copy: true },' +
    '    }),' +
    '  };' +
    '  if (secretsJson) {' +
    '    const secrets = JSON.parse(secretsJson);' +
    '    if (secrets && typeof secrets === "object") ctx.secrets = Object.freeze(secrets);' +
    '  }' +
    '  return ctx;' +
    '})',
    { reference: true },
  );

  // null refs collapse to `null` on the isolate side (falsy in the if-guards).
  const ctxShim = await ctxShimBuilder.apply(undefined, [
    refNow,
    refLog,
    caps.fetch ? refFetch : null,
    caps.llm ? refLlm : null,
    caps.storage ? refStorageGet : null,
    caps.storage ? refStorageSet : null,
    secretsJson,
  ], { result: { reference: true } });

  const methodRef = defaultRef.getSync(methodName, { reference: true });
  if (!methodRef || methodRef.typeof !== 'function') {
    releaseAll([refNow, refLog, refFetch, refLlm, refStorageGet, refStorageSet, ctxShim]);
    throw new Error(`user-blank: method "${methodName}" is not a function`);
  }

  let result;
  try {
    if (methodName === 'set') {
      // set(ctx, value, args) — args[0] is the value, rest is args.
      const value = args.length > 0 ? args[0] : '';
      const rest = args.slice(1);
      result = await methodRef.apply(
        undefined,
        [ctxShim.derefInto(), value, new ivm.ExternalCopy(rest).copyInto()],
        { timeout: timeoutMs, result: { promise: true, copy: true } },
      );
    } else {
      // get(ctx, args) — args is the array.
      result = await methodRef.apply(
        undefined,
        [ctxShim.derefInto(), new ivm.ExternalCopy(args).copyInto()],
        { timeout: timeoutMs, result: { promise: true, copy: true } },
      );
    }
  } finally {
    releaseAll([refNow, refLog, refFetch, refLlm, refStorageGet, refStorageSet, ctxShim]);
  }
  return result;
}

function releaseAll(refs) {
  for (const r of refs) {
    if (r && typeof r.release === 'function') {
      try { r.release(); } catch { /* already released */ }
    }
  }
}

// ─── shutdown ────────────────────────────────────────────────────────────

function handleShutdown() {
  shutdownAll();
  process.exit(0);
}

function shutdownAll() {
  for (const slot of blanks.values()) {
    try { slot.isolate.dispose(); } catch { /* */ }
  }
  blanks.clear();
  for (const cb of pendingCaps.values()) {
    try { cb.reject(new Error('runner shutting down')); } catch { /* */ }
  }
  pendingCaps.clear();
}

// Tell main we're up. The main side waits for this before sending `load`.
writeOut({ op: 'ready', node: process.versions.node, ivm: (function () {
  try { return require('isolated-vm/package.json').version; } catch { return 'unknown'; }
})() });
