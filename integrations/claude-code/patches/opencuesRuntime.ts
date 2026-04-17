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
// adapters/claude-code/v2.1/boot.ts. This file is intentionally minimal:
// it knows the require var (host-specific), the boot.js path, and the
// S1/S2/S3 binding names. That's it.
//
// NOTE: Seam regexes below are a build-time vendored copy of
// `packages/opencues-runtime/adapters/claude-code/v2.1/seams.ts`. Source of
// truth is the runtime package; mirror both when bumping.

import { getRequireFuncName } from './helpers';

interface SeamMatch {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly bindings: Readonly<Record<string, string>>;
}

// ─── S1: KeyDispatcher ─────────────────────────────────────────────────
const KEY_DISPATCHER_REGEX =
  /function ([$\w]+)\(([$\w]+),([$\w]+)\)\{switch\(\2\.key\)\{case"escape":/;

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

// ─── S3: RenderedValue ─────────────────────────────────────────────────
const RV_RAINBOW = /renderedValue:\(function\(\)\{/;
const RV_5 = /renderedValue:([$\w]+)\.render\(([$\w]+,[$\w]+,[$\w]+,[$\w]+,[$\w]+)\)/;
const RV_4 = /renderedValue:([$\w]+)\.render\(([$\w]+,[$\w]+,[$\w]+,[$\w]+)\)/;
const RV_3 = /renderedValue:([$\w]+)\.render\(([$\w]+,[$\w]+,[$\w]+)\)/;

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
  for (const pat of [RV_5, RV_4, RV_3]) {
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
        `packages/opencues-runtime/adapters/claude-code/ for a matching adapter ` +
        `band or pin claude-cues to a supported version.`,
    );
    return null;
  }

  // cli.js is ESM-converted; bare `require` isn't defined. Use the
  // createRequire-derived var that v1 patches also rely on.
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

  // Single absolute path — boot.js handles all internal wiring.
  const bootPath = `(process.env.HOME||"~")+"/.claude/node_modules/opencues-runtime/dist/adapters/claude-code/v2.1/boot.js"`;

  // S1 injection: lazy-init __oc on first dispatch, then run the dispatch.
  // readFile uses fs from createRequire — needed by ConfigLoader for tips JSON.
  const s1Bootstrap =
    `try{` +
    `if(!globalThis.__oc){` +
    `try{globalThis.__oc=${requireFn}(${bootPath}).boot({` +
    `hostVersion:"2.1.x",cwd:process.cwd(),` +
    `getText:function(){return ${iz}.text;},` +
    `getCursorOffset:function(){return ${iz}.offset;},` +
    `readFile:function(p){return new Promise(function(res){try{${requireFn}("fs").readFile(p,"utf8",function(err,data){res(err?null:data);});}catch(__ocFe){res(null);}});},` +
    `writeFile:function(p,c){return new Promise(function(res,rej){try{${requireFn}("fs").writeFile(p,c,"utf8",function(err){err?rej(err):res();});}catch(__ocWe){rej(__ocWe);}});},` +
    // child_process-backed spawnProcess for fire-and-forget TTS etc. Returns
    // a ProcessHandle whose .result resolves on exit (or never, if detached).
    `spawnProcess:function(spec){var __ocCp=${requireFn}("child_process");var __ocOpts={detached:!!spec.detached,stdio:"ignore",env:spec.env,cwd:spec.cwd};` +
    `var __ocResolve;var __ocReject;var __ocP=new Promise(function(r,rj){__ocResolve=r;__ocReject=rj;});` +
    `try{var __ocCh=__ocCp.spawn(spec.command,Array.from(spec.args||[]),__ocOpts);if(spec.detached)__ocCh.unref();` +
    `if(!spec.detached){__ocCh.on("exit",function(code){__ocResolve({stdout:"",stderr:"",exitCode:code||0,timedOut:false});});__ocCh.on("error",__ocReject);}` +
    `return{result:__ocP,kill:function(sig){try{__ocCh.kill(sig||"SIGTERM");}catch(_e){}}};}` +
    `catch(__ocSpawnErr){return{result:Promise.reject(__ocSpawnErr),kill:function(){}};}},` +
    // Statusline export path. Per-PID so two CC instances don't collide.
    // Matches v1's path so the existing highlight-statusline.sh keeps working.
    `statusFilePath:"/tmp/claude-highlight-state-"+process.pid+".json",` +
    // TTS: speak.sh is the same script v1 used. ttsRate matches v1's default.
    `ttsScriptPath:(process.env.HOME||"~")+"/.claude/actions/speak.sh",` +
    `ttsRate:2,` +
    // refreshStatusline calls the captured S6 useCallback (set by the
    // injection below) to trigger an immediate statusline re-render. Safe
    // no-op until S6 has run (which happens on the first React render of
    // the component owning the callback).
    `refreshStatusline:function(){try{if(globalThis.__oc_refreshHostStatusline)globalThis.__oc_refreshHostStatusline();}catch(__ocSe){}},` +
    // TUI swallows stderr — write to a file so debug output is recoverable.
    // tail -f /tmp/opencues.log in a separate shell while reproducing.
    `log:function(l,m,d){if(process.env.DEBUG_OPENCUES){try{${requireFn}("fs").appendFileSync("/tmp/opencues.log","["+new Date().toISOString().slice(11,23)+"]["+l+"] "+m+" "+(d?JSON.stringify(d).slice(0,400):"")+"\\n");}catch(__ocLe){}}}` +
    `});}` +
    `catch(__ocBe){console.error("[opencues] boot failed:",__ocBe&&__ocBe.stack||__ocBe);globalThis.__oc={failed:true};}` +
    `}` +
    `if(globalThis.__oc&&!globalThis.__oc.failed){` +
    `if(process.env.DEBUG_OPENCUES&&globalThis.__oc.adapter)globalThis.__oc.adapter.log("debug","dispatch in",{key:${ev}.key,ctrl:!!${ev}.ctrl,alt:!!${ev}.alt,meta:!!${ev}.meta,option:!!${ev}.option,shift:!!${ev}.shift,mtext:${iz}.text,moff:${iz}.offset});` +
    `if(globalThis.__oc.dispatchKey(${ev},${iz}.text,${iz}.offset)){` +
    // Pass fresh m.text/m.offset to consumePendingRender — the closure in
    // boot's bindings.getText is stale across React re-renders (it captures
    // m from a long-gone Dy8 invocation), so the runtime cannot read the
    // current state on its own. The dispatch site always has fresh values.
    `var __ocP=globalThis.__oc.consumePendingRender(${iz}.text,${iz}.offset);` +
    `if(process.env.DEBUG_OPENCUES&&globalThis.__oc.adapter)globalThis.__oc.adapter.log("debug","consumed, pending",__ocP);` +
    `if(__ocP){` +
    `try{var __ocIZ=${izClass}.fromText(__ocP.text,${cols},__ocP.cursor);` +
    `if(process.env.DEBUG_OPENCUES&&globalThis.__oc.adapter)globalThis.__oc.adapter.log("debug","returning IZ",{text:__ocIZ.text,offset:__ocIZ.offset});` +
    `return __ocIZ;}` +
    `catch(__ocRe){if(globalThis.__oc.adapter)globalThis.__oc.adapter.log("error","IZ build err",__ocRe&&__ocRe.message||__ocRe);return ${iz};}` +
    `}` +
    `return ${iz};` +
    `}` +
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

  // Apply in descending position order so each application leaves earlier
  // indices valid. S6 > S3 > S1 in v2.1.110.
  let out = oldFile;
  if (s6 && s6Replacement) {
    out = out.slice(0, s6.startIndex) + s6Replacement + out.slice(s6.endIndex);
  }
  out = out.slice(0, s3!.startIndex) + s3Wrapper + out.slice(s3!.endIndex);
  out = out.slice(0, s1!.startIndex) + s1Bootstrap + out.slice(s1!.endIndex);
  return out;
}
