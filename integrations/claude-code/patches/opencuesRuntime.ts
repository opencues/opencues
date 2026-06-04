// OpenCues v2 runtime patch — see refactor.md §10, §11.
//
// When opencuesRuntime === 'v2', this patch:
//   1. Runs three seam predicates (S1 KeyDispatcher, S2 InputStateHandler,
//      S3 RenderedValue). Fails loud if any miss — cli.js stays unmodified.
//   2. Injects two anchors:
//      a) S1 body-start: a tiny bootstrap that lazily require()s the v2.1
//         adapter's boot.js and stores the result on globalThis.__oc.
//         On every key dispatch, calls __oc.dispatchKey(...) and, if
//         consumed + pending render, returns a rebuilt InputZone.
//      b) S3 renderedValue expression: wraps the host's render output with
//         __oc.applyRender(...) (guarded; falls through until __oc exists).
//
// All wiring (adapter construction, module subscription, error capture,
// ZWS toggle logic, applyDirectives) lives in opencues-runtime's
// adapters/cc/v2.1/boot.ts. This file is intentionally minimal:
// it knows the require var (host-specific), the boot.js path, and the
// S1/S2/S3 binding names. That's it.
//
// NOTE: Seam regexes below are a build-time vendored copy of
// `packages/opencues-runtime/adapters/cc/v2.1/seams.ts`. Source of
// truth is the runtime package; mirror both when bumping.

import { getRequireFuncName } from './helpers';

interface SeamMatch {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly bindings: Readonly<Record<string, string>>;
}

// ─── S1: KeyDispatcher ─────────────────────────────────────────────────
// 2.1.110 uses event.key; 2.1.150 refactored to event.name. Both still exist
// on the event object, so we just widen the regex.
const KEY_DISPATCHER_REGEX =
  /function ([$\w]+)\(([$\w]+),([$\w]+)\)\{switch\(\2\.(?:key|name)\)\{case"escape":/;

function findKeyDispatcher(source: string): SeamMatch | null {
  const m = source.match(KEY_DISPATCHER_REGEX);
  if (!m || m.index === undefined) return null;
  const bodyStart = m.index + `function ${m[1]}(${m[2]},${m[3]}){`.length;
  return {
    startIndex: bodyStart,
    endIndex: bodyStart,
    bindings: { funcName: m[1], eventParam: m[2], keyParam: m[3] },
  };
}

// ─── S2: InputStateHandler ─────────────────────────────────────────────
const INPUT_STATE_REGEX =
  /function ([$\w]+)\(\{value:([$\w]+),onChange:([$\w]+),[^}]+externalOffset:([$\w]+),onOffsetChange:([$\w]+)[^}]+\}\)\{[^}]*let ([$\w]+)=\4,([$\w]+)=\5,([$\w]+)=([$\w]+)\.fromText\(\2,([$\w]+),\6\)/;
const RETURN_REGEX = /return\{handleKeyDown:([$\w]+),renderedValue:/;

function findInputStateHandler(source: string): SeamMatch | null {
  const m = source.match(INPUT_STATE_REGEX);
  if (!m || m.index === undefined) return null;
  const tail = source.slice(m.index, m.index + 60000);
  const rm = tail.match(RETURN_REGEX);
  if (!rm || rm.index === undefined) return null;
  return {
    startIndex: m.index + rm.index,
    endIndex: m.index + rm.index,
    bindings: {
      funcName: m[1],
      valueParam: m[2],
      onChangeParam: m[3],
      externalOffsetParam: m[4],
      onOffsetChangeParam: m[5],
      offsetVar: m[6],
      onOffsetChangeVar: m[7],
      inputZoneVar: m[8],
      inputZoneClass: m[9],
      columnsVar: m[10],
      handleKeyDownName: rm[1],
    },
  };
}

// ─── S6: StatusLineRefreshDebounce ─────────────────────────────────────
// Captures the React useCallback that triggers CC's debounced statusline
// refresh. We append an assignment to the same `let` so the callback is
// reachable from globalThis and the runtime can imperatively trigger a
// refresh after every state-export write.
const STATUSLINE_REFRESH_REGEX =
  /([$\w]+)=([$\w]+)\.useCallback\(\(\)=>\{if\(([$\w]+)\.current!==void 0\)clearTimeout\(\3\.current\);\3\.current=setTimeout\(\([^)]+\)=>\{[^}]+\},300,\3,([$\w]+)\)\},\[\4\]\)/;

interface StatusLineRefreshMatch {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly callbackVar: string;
}

function findStatusLineRefresh(source: string): StatusLineRefreshMatch | null {
  const m = source.match(STATUSLINE_REFRESH_REGEX);
  if (!m || m.index === undefined) return null;
  return {
    startIndex: m.index,
    endIndex: m.index + m[0].length,
    callbackVar: m[1],
  };
}

// ─── S7: RenderKick ────────────────────────────────────────────────────
// Captures the InputZone GRANDPARENT component — the one that CALLS the S2
// handler (`D69`-equivalent) to produce `inputState`, which it then passes
// down to J68 (`function J68({inputState:H, ...})`). The renderedValue
// (which wraps Q.render with applyRender) is computed inside the S2
// handler; for our kick to re-evaluate it, the COMPONENT THAT CALLS the
// S2 handler must re-render. Bumping useState in J68 (the consumer) is
// insufficient — J68 just receives the already-computed inputState as a
// prop and re-rendering J68 doesn't re-invoke D69.
//
// Pattern in 2.1.150:
//   function I8q(H){
//     let[$]=d7(),q=v3(),K=rRH.useMemo(H9H,[]);
//     c88(q,!!H.onImagePaste);
//     let _=D69({value:H.value,onChange:H.onChange,...});  // ← S2 callsite
//     ...
//     return <J68 inputState={_} ... />
//   }
// Injection point: just inside `I8q(H){` — adds `var s7=ns.useState(0)[1]`
// and exposes setter as `globalThis.__oc_kickRender`.
//
// S7 is OPTIONAL — if missing, `__oc_pushHostText` falls back to the ZWS
// toggle path. The patch logs a warning but doesn't fail.
//
// Capture groups: (1) full match through the opening `{` of the function
// body, (2) function name, (3) the React namespace local used inside the
// body (first `X.useMemo|useRef|useState|useEffect` we see).
const RENDER_KICK_REGEX =
  /(function ([$\w]+)\([$\w]+\)\{)[\s\S]{0,500}?([$\w]+)\.(?:useMemo|useRef|useState|useEffect)\([\s\S]{0,3000}?(?:let|const|var)\s+[$\w]+\s*=\s*[$\w]+\(\{value:[^,]+,onChange:/;

interface RenderKickMatch {
  readonly injectAt: number;     // position AFTER the opening `{` of the function body
  readonly funcName: string;
  readonly reactNs: string;
}

function findRenderKick(source: string): RenderKickMatch | null {
  const m = source.match(RENDER_KICK_REGEX);
  if (!m || m.index === undefined) return null;
  return {
    injectAt: m.index + m[1].length,
    funcName: m[2],
    reactNs: m[3],
  };
}

// ─── S3: RenderedValue ─────────────────────────────────────────────────
const RV_RAINBOW = /renderedValue:\(function\(\)\{/;
const RV_5 = /renderedValue:([$\w]+)\.render\(([$\w]+,[$\w]+,[$\w]+,[$\w]+,[$\w]+)\)/;
const RV_4 = /renderedValue:([$\w]+)\.render\(([$\w]+,[$\w]+,[$\w]+,[$\w]+)\)/;
const RV_3 = /renderedValue:([$\w]+)\.render\(([$\w]+,[$\w]+,[$\w]+)\)/;
// 2.1.150 ships a 7-arg call with a `??`-expression as one arg
// (e.g. `Q.render(D,j,J,VH,W,C??void 0,I)`). Generic catch-all matches any
// argument list that doesn't contain a nested paren — covers all shapes.
const RV_GENERIC = /renderedValue:([$\w]+)\.render\(([^()]+)\)/;

interface RenderedValueMatch {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly expression: string;
}

function findRenderedValue(source: string): RenderedValueMatch | null {
  const rw = source.match(RV_RAINBOW);
  if (rw && rw.index !== undefined) {
    const exprStart = rw.index + 'renderedValue:'.length;
    let depth = 0;
    for (let i = exprStart; i < source.length; i += 1) {
      const c = source.charAt(i);
      if (c === '(') depth += 1;
      else if (c === ')') {
        depth -= 1;
        if (depth === 0) {
          let endIdx = i + 1;
          if (source.charAt(i + 1) === '(' && source.charAt(i + 2) === ')') endIdx = i + 3;
          return { startIndex: exprStart, endIndex: endIdx, expression: source.slice(exprStart, endIdx) };
        }
      }
    }
    return null;
  }
  for (const pat of [RV_5, RV_4, RV_3, RV_GENERIC]) {
    const m = source.match(pat);
    if (m && m.index !== undefined) {
      const exprStart = m.index + 'renderedValue:'.length;
      const exprEnd = m.index + m[0].length;
      return { startIndex: exprStart, endIndex: exprEnd, expression: source.slice(exprStart, exprEnd) };
    }
  }
  return null;
}

/**
 * Apply the v2 patch. Returns patched content on success, null on miss.
 */
export function writeOpenCuesRuntimeV2(oldFile: string): string | null {
  const s1 = findKeyDispatcher(oldFile);
  const s2 = findInputStateHandler(oldFile);
  const s3 = findRenderedValue(oldFile);

  const missing: string[] = [];
  if (!s1) missing.push('S1 KeyDispatcher');
  if (!s2) missing.push('S2 InputStateHandler');
  if (!s3) missing.push('S3 RenderedValue');
  if (missing.length > 0) {
    console.error(
      `OpenCues v2 installer: FAILED to find ${missing.length} critical seam(s):\n` +
        missing.map(id => `  - ${id}`).join('\n') +
        `\nLikely cause: unsupported Claude Code version. Check ` +
        `packages/opencues-runtime/adapters/cc/ for a matching adapter ` +
        `band or pin claude-cues to a supported version.`,
    );
    return null;
  }

  // cli.js is ESM-converted; bare `require` isn't defined. Use the
  // createRequire-derived var.
  const requireFn = getRequireFuncName(oldFile);
  if (!requireFn) {
    console.error('OpenCues v2 installer: failed to find createRequire function in cli.js. Aborting v2 patch.');
    return null;
  }

  const ev = s1!.bindings.eventParam;
  const iz = s2!.bindings.inputZoneVar;
  const izClass = s2!.bindings.inputZoneClass;
  const cols = s2!.bindings.columnsVar;

  // S6 is OPTIONAL — if missing, statusline still works as long as the user's
  // ~/.claude/settings.json sets statusLine.refreshInterval. We log and
  // continue rather than failing the whole patch.
  const s6 = findStatusLineRefresh(oldFile);
  if (!s6) {
    console.warn(
      'OpenCues v2 installer: S6 (StatusLineRefresh) not found. ' +
      'Statusline will rely on settings.json statusLine.refreshInterval polling. ' +
      'Update the regex to restore event-driven refresh on this CC version.',
    );
  }

  // S7 is OPTIONAL — if missing, host.forceRender becomes a no-op and
  // __oc_pushHostText falls back to the ZWS-toggle path. With S7 found,
  // we inject a useState bumper into the InputZone-parent component and
  // expose its setter as globalThis.__oc_kickRender — Gemini-style.
  const s7 = findRenderKick(oldFile);
  if (!s7) {
    console.warn(
      'OpenCues v2 installer: S7 (RenderKick) not found. ' +
      '__oc_pushHostText falls back to ZWS toggling. ' +
      'Update RENDER_KICK_REGEX to restore explicit render-kick on this CC version.',
    );
  }

  // Bare specifiers — Node's CJS resolver walks up from cli.js
  // (~/claude-code-cues/node_modules/@anthropic-ai/claude-code/cli.js)
  // and finds @opencues/{runtime,core} in the fork's own
  // node_modules/ where setup.sh installs them. Mirrors OpenCode's
  // approach. Robust by design — no path drama, no symlinks, no
  // bundling needed. Uninstalling claude-cues cleans these up too.
  //
  // 2.1.150+ ships as a bun-compile native binary. From inside the
  // bunfs vfs, bare-specifier resolution doesn't reach the host
  // filesystem. `__oc_req` below tries bare-specifier first (works on
  // npm cli.js installs), falls back to a manual upward walk from
  // process.execPath looking for node_modules/<spec> (works on native
  // binary installs). One bootstrap, both flavours.
  const bootPath = `"@opencues/runtime/dist/adapters/cc/v2.1/boot.js"`;
  // Hoisted blank classes (HackerNews / Stocks / Weather / Answer /
  // PromptImprover / OpenCuesSettings) live in the runtime's blanks
  // module. Lazy require inside the bootstrap so older runtime installs
  // (without blanks/) still load — blankInvoke just stays null in
  // that case and BlankFill falls back to spawnProcess.
  const blanksPath = `"@opencues/runtime/dist/src/blanks/index.js"`;
  // Path-sandbox + audit-log helpers for spawnProcess. Same module is
  // imported directly by the other native hosts (OC/gemini); CC requires
  // it at runtime since this file is stringified into cli.js.
  const securityPath = `"@opencues/runtime/dist/src/security/spawn-sandbox.js"`;
  // OS-level sandbox wrapper. Same module is imported directly by
  // OC / gemini-cli; CC requires at runtime since this is a string-
  // template injected into cli.js.
  const sandboxPath = `"@opencues/runtime/dist/src/security/sandbox-runner.js"`;
  // User-blank registry builder + parser. Discovers `impl: ./blank.js`
  // BLANK.md files at boot and registers them alongside the built-in
  // runtime classes.
  const userBlanksPath = `"@opencues/runtime/dist/src/user-blanks/registry.js"`;
  const corePath = `"@opencues/core"`;
  // OPENCUES.md is system-wide, user-level only. Schema is runtime-owned;
  // no project override. Resolved at call time so an OPENCUES_HOME flip
  // after boot is still honoured.
  const opencuesMdPathExpr =
    `(process.env.OPENCUES_HOME?(process.env.OPENCUES_HOME+"/OPENCUES.md"):` +
    `((process.env.HOME||"~")+"/.cues/OPENCUES.md"))`;
  const sentinelsMdPathExpr =
    `(process.env.OPENCUES_HOME?(process.env.OPENCUES_HOME+"/SENTINELS.md"):` +
    `((process.env.HOME||"~")+"/.cues/SENTINELS.md"))`;
  // CUES roots for the sandbox + audit log. First entry is where the
  // log lands. Mirrors OC/gemini.
  const cuesRootsExpr =
    `(function(){var __ocPth=${requireFn}("path");var __ocOs=${requireFn}("os");` +
    `var __ocR=[];if(process.env.OPENCUES_HOME)__ocR.push(process.env.OPENCUES_HOME);` +
    `__ocR.push(__ocPth.join(process.cwd(),".cues"));` +
    `__ocR.push(__ocPth.join(__ocOs.homedir(),".cues"));return __ocR;})()`;

  // Resolver helper — bare-spec first (npm cli.js install), then upward
  // walk from execPath looking for node_modules/<spec> (native binary).
  // Defined once at the start of the bootstrap; used for every @opencues/*
  // require below.
  const reqHelper =
    `function __oc_req(s){try{return ${requireFn}(s);}catch(__ocReqE){` +
    `var __ocRP=${requireFn}("path"),__ocRF=${requireFn}("fs"),__ocRD=__ocRP.dirname(process.execPath);` +
    `while(__ocRD.length>1){var __ocRC=__ocRP.join(__ocRD,"node_modules",s);` +
    `if(__ocRF.existsSync(__ocRC))return ${requireFn}(__ocRC);__ocRD=__ocRP.dirname(__ocRD);}` +
    `throw __ocReqE;}}`;

  // S1 injection: lazy-init __oc on first dispatch, then run the dispatch.
  // readFile uses fs from createRequire — needed by ConfigLoader for tips JSON.
  const s1Bootstrap =
    `try{` +
    `if(!globalThis.__oc){` +
    reqHelper +
    `try{globalThis.__oc=__oc_req(${bootPath}).boot({` +
    `hostVersion:"2.1.x",cwd:process.cwd(),` +
    `getText:function(){return ${iz}.text;},` +
    `getCursorOffset:function(){return ${iz}.offset;},` +
    `readFile:function(p){return new Promise(function(res){try{${requireFn}("fs").readFile(p,"utf8",function(err,data){res(err?null:data);});}catch(__ocFe){res(null);}});},` +
    `readDir:function(p){return new Promise(function(res){try{${requireFn}("fs").readdir(p,{withFileTypes:true},function(err,entries){if(err){res(null);return;}res(entries.map(function(e){return{name:e.name,isDirectory:e.isDirectory()};}));});}catch(__ocDe){res(null);}});},` +
    // Synchronous writeFile. The Promise-returning shape keeps the runtime
    // contract (HostInfo.writeFile? returns Promise<void>) but the actual
    // write happens INSIDE the call, not on a microtask. Closes the
    // race between Statusline.maybeWrite (called from onRender during
    // dispatch) and the harness's `expect` poll after waitForEvent. On
    // CC, where applyRender is called sync from the patched renderedValue,
    // the sync write means by the time the runtime emits highlight.activated
    // the status JSON file is already current on disk.
    `writeFile:function(p,c){try{${requireFn}("fs").writeFileSync(p,c,"utf8");return Promise.resolve();}catch(__ocWe){return Promise.reject(__ocWe);}},` +
    // child_process-backed spawnProcess for fire-and-forget TTS etc. Returns
    // a ProcessHandle whose .result resolves on exit (or never, if detached).
    `pushText:function(t,c){try{if(globalThis.__oc_pushHostText)globalThis.__oc_pushHostText(t,c);}catch(__ocXe){}},` +
    // Render-kick. Delegates to __oc_pushHostText with no args so both
    // refresh paths (S7 kickRender on 2.1.150+, ZWS-toggle fallback on
    // 2.1.110) flow through the same plumbing. The function reads the
    // last clean text from globalThis and routes to the right path based
    // on whether S7 was wired at install time.
    `forceRender:function(){try{if(globalThis.__oc_pushHostText)globalThis.__oc_pushHostText();}catch(__ocFRe){}},` +
    // Sandbox + audit log via the shared @opencues/runtime helpers.
    // Path-validate every arg against the CUES roots, refuse on
    // escape, append to <root>/.opencues-log on every exit.
    `spawnProcess:function(spec){` +
    `var __ocSec=__oc_req(${securityPath});var __ocRoots=${cuesRootsExpr};` +
    `var __ocRaw=Array.from(spec.args||[]);var __ocSafeArgs=[];` +
    `for(var __ocI=0;__ocI<__ocRaw.length;__ocI++){var __ocV=__ocSec.validateScriptPath(String(__ocRaw[__ocI]),__ocRoots);` +
    `if(!__ocV.ok){__ocSec.appendAuditLog("claude-code",spec,{exitCode:126},__ocRoots);` +
    `return{result:Promise.resolve({exitCode:126,stdout:"",stderr:__ocV.reason||"path outside CUES roots",timedOut:false}),kill:function(){}};}` +
    `__ocSafeArgs.push(__ocV.resolved!=null?__ocV.resolved:__ocRaw[__ocI]);}` +
    // OS-level sandbox: wrap with bwrap when blank declared
    // `sandbox: strict` AND bwrap is available. Returns null for
    // off / unavailable — we run the spec unwrapped (path sandbox +
    // audit log still apply).
    `var __ocSb=__oc_req(${sandboxPath});` +
    `var __ocWrap=__ocSb.wrapWithBwrap(spec.command,__ocSafeArgs,spec.sandbox,__ocRoots);` +
    `var __ocFinalCmd=__ocWrap?__ocWrap.command:spec.command;` +
    `var __ocFinalArgs=__ocWrap?__ocWrap.args:__ocSafeArgs;` +
    `var __ocStartedAt=Date.now();` +
    `var __ocCp=${requireFn}("child_process");var __ocOpts={detached:!!spec.detached,stdio:spec.detached?"ignore":["ignore","pipe","pipe"],env:spec.env,cwd:spec.cwd};` +
    `var __ocResolve;var __ocReject;var __ocP=new Promise(function(r,rj){__ocResolve=r;__ocReject=rj;});` +
    `try{var __ocCh=__ocCp.spawn(__ocFinalCmd,__ocFinalArgs,__ocOpts);if(spec.detached)__ocCh.unref();` +
    `if(!spec.detached){var __ocStdout="";var __ocStderr="";var __ocTimedOut=false;var __ocTimeoutId=null;` +
    `if(spec.timeoutMs){__ocTimeoutId=setTimeout(function(){__ocTimedOut=true;try{__ocCh.kill("SIGTERM");}catch(_e){}},spec.timeoutMs);}` +
    `if(__ocCh.stdout)__ocCh.stdout.on("data",function(d){__ocStdout+=d.toString();});` +
    `if(__ocCh.stderr)__ocCh.stderr.on("data",function(d){__ocStderr+=d.toString();});` +
    `__ocCh.on("exit",function(code){if(__ocTimeoutId)clearTimeout(__ocTimeoutId);var __ocExit=code||0;` +
    `__ocSec.appendAuditLog("claude-code",spec,{exitCode:__ocExit,timedOut:__ocTimedOut},__ocRoots,Date.now()-__ocStartedAt);` +
    `__ocResolve({stdout:__ocStdout,stderr:__ocStderr,exitCode:__ocExit,timedOut:__ocTimedOut});});` +
    `__ocCh.on("error",__ocReject);}` +
    `return{result:__ocP,kill:function(sig){try{__ocCh.kill(sig||"SIGTERM");}catch(_e){}}};}` +
    `catch(__ocSpawnErr){__ocSec.appendAuditLog("claude-code",spec,{exitCode:127},__ocRoots);return{result:Promise.reject(__ocSpawnErr),kill:function(){}};}},` +
    // blankInvoke routes BlankFill / Cycling blank dispatches to the
    // hoisted runtime classes. Wrapped in try/catch so a missing blanks
    // module on legacy installs degrades gracefully (BlankFill falls back
    // to spawnProcess for that name). Lazily-built registry — avoid
    // constructing classes that need API keys we don't have.
    `blankInvoke:(function(){try{` +
    // Built-in blanks come from @opencues/runtime's BUILTIN_BLANKS
    // registry — single source of truth across CC / OC / chrome /
    // gemini-cli. Previously this list was missing 'claude-status'
    // (silent feature gap on CC). Adding a new built-in is one
    // entry in packages/opencues-runtime/src/blanks/index.ts; this
    // bootstrap picks it up automatically via createDefaultBlanksRegistry.
    `var __ocCtl=__oc_req(${blanksPath});` +
    `var __ocFs=${requireFn}("fs");var __ocOcMd=${opencuesMdPathExpr};` +
    `var __ocSentMd=${sentinelsMdPathExpr};` +
    `var __ocGroq=process.env.GROQ_API_KEY;` +
    `var __ocReg=__ocCtl.createDefaultBlanksRegistry({` +
    `llmConfig:__ocGroq?{apiKey:__ocGroq}:undefined,` +
    `finnhubApiKey:process.env.FINNHUB_API_KEY,` +
    `opencuesMdIO:{` +
    `readFile:function(){return new Promise(function(r){__ocFs.readFile(__ocOcMd,"utf8",function(e,d){r(e?null:d);});});},` +
    `writeFile:function(c){return new Promise(function(r,j){__ocFs.writeFile(__ocOcMd,c,"utf8",function(e){e?j(e):r();});});}` +
    `},` +
    // Sentinel-write blank — keyword-bound `set sentinel _` /
    // `remove sentinel _`. Validator runs INSIDE SentinelBlank before
    // writeFile is invoked; do not add a parallel write path. See
    // docs/architecture/security-audit.md row #24.
    `sentinelsMdIO:{` +
    `readFile:function(){return new Promise(function(r){__ocFs.readFile(__ocSentMd,"utf8",function(e,d){r(e?null:d);});});},` +
    `writeFile:function(c){return new Promise(function(r,j){__ocFs.writeFile(__ocSentMd,c,"utf8",function(e){e?j(e):r();});});}` +
    `}` +
    `});` +
    // User-shipped JS blanks: walk every .cues/blanks/<name>/BLANK.md,
    // parse, register each impl: ./xxx.js entry. Wrapped in try/catch
    // so older runtime installs (without user-blanks support) degrade
    // silently — built-in blanks keep working.
    `try{` +
    `var __ocUbReg=__oc_req(${userBlanksPath});` +
    `var __ocCore=__oc_req(${corePath});` +
    `var __ocPath=${requireFn}("path");var __ocOs=${requireFn}("os");` +
    `var __ocRoots2=[];if(process.env.OPENCUES_HOME)__ocRoots2.push(process.env.OPENCUES_HOME);` +
    `__ocRoots2.push(__ocPath.join(process.cwd(),".cues"));` +
    `__ocRoots2.push(__ocPath.join(__ocOs.homedir(),".cues"));` +
    `var __ocUserCfgs=[];` +
    `for(var __ocRi=0;__ocRi<__ocRoots2.length;__ocRi++){` +
    `var __ocBd=__ocPath.join(__ocRoots2[__ocRi],"blanks");` +
    `if(!__ocFs.existsSync(__ocBd))continue;` +
    `var __ocEs=__ocFs.readdirSync(__ocBd,{withFileTypes:true});` +
    `for(var __ocEi=0;__ocEi<__ocEs.length;__ocEi++){` +
    `if(!__ocEs[__ocEi].isDirectory())continue;` +
    `var __ocBM=__ocPath.join(__ocBd,__ocEs[__ocEi].name,"BLANK.md");` +
    `if(!__ocFs.existsSync(__ocBM))continue;` +
    `try{` +
    `var __ocC=__ocFs.readFileSync(__ocBM,"utf8");` +
    `var __ocPr=__ocCore.parseSingleCueMd(__ocC,__ocPath.dirname(__ocBM));` +
    `var __ocBlk=__ocPr.blanks&&__ocPr.blanks[__ocEs[__ocEi].name];` +
    `if(__ocBlk&&__ocBlk.impl&&__ocBlk.impl.indexOf("/")>=0)__ocUserCfgs.push(__ocBlk);` +
    `}catch(__ocBe){}` +
    `}` +
    `}` +
    `var __ocUm=__ocUbReg.buildUserBlankRegistry(__ocUserCfgs,{storageRoot:__ocRoots2[__ocRoots2.length-1],secrets:process.env,llm:__ocUbReg.createNativeLlmAdapter(process.env),log:function(){}});` +
    `__ocUm.forEach(function(b,n){__ocReg.set(n,b);});` +
    `}catch(__ocUbE){` +
    `if(globalThis.__oc&&globalThis.__oc.adapter)globalThis.__oc.adapter.log("warn","user-blank discovery failed",{err:String(__ocUbE)});` +
    `}` +
    `return __ocCtl.createBlankInvoke(__ocReg);` +
    `}catch(__ocCe){if(globalThis.__oc&&globalThis.__oc.adapter)globalThis.__oc.adapter.log("warn","blankInvoke unavailable",{err:String(__ocCe)});return function(){return null;};}})(),` +
    // Blank-as-context: hand the same registry to the runtime as a
    // Map<name, Blank> so the Resolver can snapshot context-eligible
    // blanks (those with `as-context: safe|raw` in BLANK.md). Without
    // this, `blank-context-mode: safe` in OPENCUES.md is inert.
    `blanks:__ocReg,` +
    // Statusline + cursor-state export paths. Per-PID, canonical names
    // shared across every host adapter so the agentic harness (oc-state,
    // scenario-runner, /tmp/opencues-status-<pid>.json contract in
    // tests/agentic/README.md) reads CC the same way it reads OC,
    // Gemini, Terminal, etc. The CC statusline script
    // (highlight-statusline.sh) ALSO reads /tmp/opencues-status-<pid>.json
    // — both consumers share one filename.
    `statusFilePath:"/tmp/opencues-status-"+process.pid+".json",` +
    `cursorStatePath:"/tmp/opencues-cursor-state-"+process.pid+".json",` +
    // TTS: speak.sh + SpeakCtl.exe live at user-level (~/.cues/scripts/),
    // shared with OpenCode. seed-configs ships them there + compiles
    // SpeakCtl.cs colocated. Honors OPENCUES_HOME for env-driven overrides.
    `ttsScriptPath:(process.env.OPENCUES_HOME||((process.env.HOME||"~")+"/.cues"))+"/scripts/speak.sh",` +
    `ttsRate:2,` +
    // LLM resolver. Resolver only constructs if AT LEAST ONE provider
    // key is available. Default endpoint + model are Groq; when a
    // non-Groq provider is selected via CUES.md `llm-provider:`, the
    // runtime substitutes that provider's defaults.
    `llmApiKey:process.env.GROQ_API_KEY||undefined,` +
    `llmEndpoint:process.env.OPENCUES_LLM_ENDPOINT||"https://api.groq.com/openai/v1/chat/completions",` +
    `llmDefaultModel:process.env.OPENCUES_LLM_MODEL||"openai/gpt-oss-120b",` +
    // Multi-provider key bag. Boot picks the right one per call based
    // on the active provider for that source/feature.
    `llmApiKeys:{` +
      `GROQ_API_KEY:process.env.GROQ_API_KEY,` +
      `OPENROUTER_API_KEY:process.env.OPENROUTER_API_KEY,` +
      `GEMINI_API_KEY:process.env.GEMINI_API_KEY,` +
      `OPENAI_API_KEY:process.env.OPENAI_API_KEY,` +
      `ANTHROPIC_API_KEY:process.env.ANTHROPIC_API_KEY,` +
      `CEREBRAS_API_KEY:process.env.CEREBRAS_API_KEY` +
    `},` +
    // refreshStatusline calls the captured S6 useCallback (set by the
    // injection below) to trigger an immediate statusline re-render. Safe
    // no-op until S6 has run (which happens on the first React render of
    // the component owning the callback).
    `refreshStatusline:function(){try{if(globalThis.__oc_refreshHostStatusline)globalThis.__oc_refreshHostStatusline();}catch(__ocSe){}},` +
    // TUI swallows stderr — write to a file so debug output is recoverable.
    // tail -f /tmp/opencues.log in a separate shell while reproducing.
    // Always-on log fn — runtime decides whether to emit (gated on env
    // OR OPENCUES.md `debug-mode: on`).
    `log:function(l,m,d){try{${requireFn}("fs").appendFile("/tmp/opencues.log","["+new Date().toISOString().slice(11,23)+"][cc]["+l+"] "+m+" "+(d?JSON.stringify(d).slice(0,400):"")+"\\n",function(){});}catch(__ocLe){}}` +
    `});}` +
    `catch(__ocBe){console.error("[opencues] boot failed:",__ocBe&&__ocBe.stack||__ocBe);globalThis.__oc={failed:true};}` +
    `}` +
    `if(globalThis.__oc&&!globalThis.__oc.failed){` +
    // Refresh global async-text-push handle each dispatch. Async modules
    // (BlankFill, Resolver) call this to commit text outside the dispatch
    // return path. onChangeParam = parent's onChange, onOffsetChangeVar =
    // local onOffsetChange handler — both captured fresh per-render via
    // closure scope.
    //
    // Prefer the kick path: if S7 wired a useState bumper, call the parent's
    // onChange with RAW text (no ZWS), then kick to force re-render even
    // if the text happens to equal the previous string. Falls back to the
    // ZWS toggle when S7 was not found (legacy CC versions / missed seam).
    `globalThis.__oc_pushHostText=function(__ocPt,__ocPc){try{` +
    // Kick-only mode: forceRender path passes undefined text. Three
    // possible sources of "current text", picked by precedence:
    //  1. WITHIN this dispatch we already pushed via setText (flagged
    //     by globalThis.__oc_dispatchPushed): use __oc_lastPushedText —
    //     the value WE just set. iz.text is STALE here because iz was
    //     captured at dispatch start (before our setText). Reading
    //     iz.text would revert our just-pushed value.
    //     Example: cycling.ts does setText(newText)→setCursorOffset→
    //     forceRender(). The forceRender must NOT undo setText.
    //  2. INSIDE dispatch but no setText yet (pure Navigation kick):
    //     iz.text is FRESH — it's the per-keystroke React state read.
    //  3. OUTSIDE dispatch (timer, async LLM substitute): iz.text from
    //     this function's closure is from the LAST dispatch — too
    //     stale. Read globalThis.__oc.adapter.getText() which returns
    //     boot.ts's `lastSeenText`, refreshed on every applyRender.
    `if(__ocPt===undefined||__ocPt===null){` +
      `if(globalThis.__oc_insideDispatch){` +
        `if(globalThis.__oc_dispatchPushed&&globalThis.__oc_lastPushedText!=null)__ocPt=globalThis.__oc_lastPushedText;` +
        `else __ocPt=${iz}.text;` +
      `}else{try{__ocPt=globalThis.__oc&&globalThis.__oc.adapter?globalThis.__oc.adapter.getText():${iz}.text;}catch(__ocGe){__ocPt=${iz}.text;}}` +
    `}` +
    `var __ocStripped=String(__ocPt).replace(/[\\u200B\\u200C]/g,"");` +
    // Two refresh paths, mutually exclusive — picked by which seam landed:
    //   1. kickRender (S7 wired, 2.1.150+ native binary): bump a useState
    //      in the I8q grandparent (the component that CALLS the S2 handler
    //      to produce inputState). I8q re-renders → S2 handler re-invoked
    //      → renderedValue recomputed via applyRender against the latest
    //      hlState/DynDefs → fresh ANSI flows down to J68 (consumer) →
    //      Ink repaints. Buffer stays CLEAN — no ZWS pollution.
    //      ⚠ S7 must inject into I8q (the GRANDPARENT, caller of D69),
    //      NOT J68 (the consumer that destructures inputState.*). Bumping
    //      useState in the consumer re-renders the consumer but doesn't
    //      re-invoke the upstream handler, so renderedValue stays stale.
    //      See seams.ts § S7 + UPGRADING.md § "S7 anchor".
    //   2. ZWS-toggle fallback (S7 missing, 2.1.110 cli.js): no kickRender
    //      available, so we bump the controlled-input value with a 1-char
    //      invisible trailing ZWS. Buffer carries the ZWS until the next
    //      push. boot.ts checkTextDrift strips ZWS before storing
    //      lastSeenText so the runtime's view stays clean.
    `if(globalThis.__oc_kickRender){` +
      `${s2!.bindings.onChangeParam}(__ocStripped);` +
      `globalThis.__oc_kickRender();` +
      `globalThis.__oc_lastPushedText=__ocStripped;` +
      `globalThis.__oc_lastPushedTextWire=__ocStripped;` +
    `}else{` +
      `var __ocPhasB=(globalThis.__oc_lastPushedTextWire||"").indexOf("\\u200B")>=0;` +
      `var __ocPtc=__ocPhasB?"\\u200C":"\\u200B";` +
      `var __ocWire=__ocStripped+__ocPtc;` +
      `${s2!.bindings.onChangeParam}(__ocWire);` +
      `globalThis.__oc_lastPushedText=__ocStripped;` +
      `globalThis.__oc_lastPushedTextWire=__ocWire;` +
    `}` +
    // Flag that this dispatch already pushed text — subsequent
    // forceRender() in the same dispatch must reuse this push value
    // rather than re-reading iz.text (which is the pre-dispatch value).
    // Only flip the flag for EXPLICIT pushes (text arg provided), not
    // for kick-only calls (forceRender → no-arg pushHostText).
    `if(arguments.length>0&&arguments[0]!=null)globalThis.__oc_dispatchPushed=true;` +
    `if(typeof __ocPc==="number"&&${s2!.bindings.onOffsetChangeVar})${s2!.bindings.onOffsetChangeVar}(__ocPc);` +
    `}catch(__ocPe){}};` +
    `if(globalThis.__oc.adapter)globalThis.__oc.adapter.log("debug","dispatch in",{key:${ev}.key,ctrl:!!${ev}.ctrl,alt:!!${ev}.alt,meta:!!${ev}.meta,option:!!${ev}.option,shift:!!${ev}.shift,mtext:${iz}.text,moff:${iz}.offset});` +
    // Set globalThis.__oc_insideDispatch around the dispatch call so
    // __oc_pushHostText knows whether iz.text is FRESH (in-dispatch,
    // reflects current React state) or STALE (timer-driven from outside
    // dispatch, falls back to __oc_lastPushedText). Also reset
    // __oc_dispatchPushed — set true by any explicit text-pushing
    // pushHostText call during this dispatch; signals the no-arg
    // (forceRender) path to reuse __oc_lastPushedText instead of iz.text
    // (which is the pre-dispatch snapshot, not the just-set value).
    `globalThis.__oc_insideDispatch=true;` +
    `globalThis.__oc_dispatchPushed=false;` +
    `try{` +
    `if(globalThis.__oc.dispatchKey(${ev},${iz}.text,${iz}.offset)){` +
    // Pass fresh m.text/m.offset to consumePendingRender — the closure in
    // boot's bindings.getText is stale across React re-renders (it captures
    // m from a long-gone Dy8 invocation), so the runtime cannot read the
    // current state on its own. The dispatch site always has fresh values.
    `var __ocP=globalThis.__oc.consumePendingRender(${iz}.text,${iz}.offset);` +
    `if(globalThis.__oc.adapter)globalThis.__oc.adapter.log("debug","consumed, pending",__ocP);` +
    `if(__ocP){` +
    `try{var __ocIZ=${izClass}.fromText(__ocP.text,${cols},__ocP.cursor);` +
    `if(globalThis.__oc.adapter)globalThis.__oc.adapter.log("debug","returning IZ",{text:__ocIZ.text,offset:__ocIZ.offset});` +
    `return __ocIZ;}` +
    `catch(__ocRe){if(globalThis.__oc.adapter)globalThis.__oc.adapter.log("error","IZ build err",__ocRe&&__ocRe.message||__ocRe);return ${iz};}` +
    `}` +
    `return ${iz};` +
    `}` +
    `}finally{globalThis.__oc_insideDispatch=false;}` +
    `}` +
    `}catch(__ocOe){if(globalThis.__oc&&globalThis.__oc.adapter)globalThis.__oc.adapter.log("error","dispatch error",__ocOe&&__ocOe.stack||__ocOe);}`;

  // S3 injection: wrap renderedValue. Guarded — passes through until __oc ready.
  const s3Wrapper =
    `(globalThis.__oc&&globalThis.__oc.applyRender` +
    `?globalThis.__oc.applyRender(${s3!.expression},${iz}.text,${iz}.offset)` +
    `:${s3!.expression})`;

  // S6 injection: append `,<sink>=(globalThis.__oc_refreshHostStatusline=<callbackVar>)`
  // to the same `let` declaration. This exposes CC's debounced statusline-
  // refresh callback so the runtime can call it after each Statusline write.
  // The original expression is preserved verbatim and the assignment runs as
  // a side-effect of the new declarator.
  const s6Replacement = s6
    ? `${oldFile.slice(s6.startIndex, s6.endIndex)},__oc_ts6=(globalThis.__oc_refreshHostStatusline=${s6.callbackVar})`
    : null;

  // S7 injection: prepend a useState bumper at the start of the InputZone
  // parent's body. Captures the setter as globalThis.__oc_kickRender so
  // the runtime can imperatively trigger a parent re-render. React
  // re-running through the same renderedValue path lets applyRender emit
  // fresh ANSI (with the latest hlState / dim ranges) without needing to
  // change the buffer text. Replaces the ZWS-toggle hack.
  const s7Injection = s7
    ? `var __ocS7=${s7.reactNs}.useState(0)[1];globalThis.__oc_kickRender=function(){try{__ocS7(function(n){return(n+1)|0;});}catch(__ocS7e){}};`
    : null;

  // Apply in descending position order so each application leaves earlier
  // indices valid. Positions in 2.1.150: S6 (~12M) > S3 (~3.97M) > S7 (~3.98M) > S1 (~3.97M),
  // but we compare dynamically since version-to-version drift can reorder.
  // Sort the available injection sites and apply right-to-left.
  type Edit = { start: number; end: number; replacement: string };
  const edits: Edit[] = [];
  if (s6 && s6Replacement) edits.push({ start: s6.startIndex, end: s6.endIndex, replacement: s6Replacement });
  if (s7 && s7Injection) edits.push({ start: s7.injectAt, end: s7.injectAt, replacement: s7Injection });
  edits.push({ start: s3!.startIndex, end: s3!.endIndex, replacement: s3Wrapper });
  edits.push({ start: s1!.startIndex, end: s1!.endIndex, replacement: s1Bootstrap });
  edits.sort((a, b) => b.start - a.start);
  let out = oldFile;
  for (const e of edits) {
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }
  return out;
}
