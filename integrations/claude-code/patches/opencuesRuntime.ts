// OpenCues v2 runtime patch — see refactor.md §10, §11.
//
// When opencuesRuntime === 'v2', this patch:
//   1. Runs seam predicates against cli.js (S1 KeyDispatcher, S2 InputStateHandler,
//      S3 RenderedValue).
//   2. Fails loudly (returns null, caller logs) if any critical seam is missing.
//   3. Injects two anchors:
//      a) S1 body-start: a bootstrap that loads `opencues-runtime`, builds
//         HostBindings, constructs the v2.1 adapter, calls Runtime.create(),
//         subscribes Navigation + DimRender. Each key dispatch flows through
//         the runtime's onKey handlers; consumed keys early-return a
//         ZWS-toggled InputZone for re-render.
//      b) S3 renderedValue expression: wraps the host's render output with
//         applyRender(), which fires registered onRender handlers and applies
//         their RenderDirectives (highlight, dim, override) via the runtime's
//         applyDirectives helper.
//
// NOTE: The seam regexes below are a build-time vendored copy of
// `packages/opencues-runtime/adapters/claude-code/v2.1/seams.ts`. The runtime
// package is the source of truth. When bumping, mirror both files.
//
// The legacy v1 patch (wordHighlight.ts + dynamicHighlight.ts) is skipped
// when v2 is active — the caller in ./index.ts branches on the flag.

interface SeamMatch {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly bindings: Readonly<Record<string, string>>;
}

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
 * Apply the v2 bootstrap. Returns patched content on success, null on seam
 * miss. Caller logs; tweakcc's existing error path handles the rest.
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

  const b1 = s1!.bindings;
  const b2 = s2!.bindings;

  // Bootstrap: injected at the KeyDispatcher body-start (S1), which sits
  // inside the InputStateHandler closure (S2) — so b2's locals
  // (inputZoneVar, inputZoneClass, columnsVar) are in scope here.
  //
  // On first invocation: lazily require opencues-runtime, construct the v2.1
  // adapter + Navigation, create the Runtime.
  //
  // On every invocation: dispatch the current key event through registered
  // handlers. If a handler consumed AND forceRender was called, early-return
  // a rebuilt InputZone with a toggled zero-width-char suffix — same
  // mechanism as v1 — so React sees a changed value and re-renders.
  const bootstrap =
    `try{if(!globalThis.__oc){globalThis.__oc={keyHandlers:[],renderHandlers:[],textHandlers:[],pendingRender:false,failed:false};` +
    `try{` +
    `var __ocMod=require("opencues-runtime");` +
    `var __ocAdapterMod=require("opencues-runtime/dist/adapters/claude-code/v2.1/adapter");` +
    `var __ocNavMod=require("opencues-runtime/dist/src/modules/navigation");` +
    `var __ocDimMod=require("opencues-runtime/dist/src/modules/dim-render");` +
    `var __ocRdMod=require("opencues-runtime/dist/src/render-directives");` +
    `var __ocStateMod=require("opencues-runtime/dist/src/state/highlight-state");` +
    `var __ocDynDefsMod=require("opencues-runtime/dist/src/state/dyn-defs");` +
    `globalThis.__oc.adapterMod=__ocAdapterMod;` +
    `globalThis.__oc.rdMod=__ocRdMod;` +
    `var __ocBindings={hostVersion:"2.1.x",cwd:process.cwd(),` +
    `getText:function(){return globalThis.__oc._lastText||"";},` +
    `getCursorOffset:function(){return globalThis.__oc._lastOffset||0;},` +
    `setText:function(t){},setCursorOffset:function(o){},` +
    `forceRender:function(){globalThis.__oc.pendingRender=true;},` +
    `registerKeyHandler:function(cb){globalThis.__oc.keyHandlers.push(cb);return function(){var a=globalThis.__oc.keyHandlers;var i=a.indexOf(cb);if(i>=0)a.splice(i,1);};},` +
    `registerRenderHandler:function(cb){globalThis.__oc.renderHandlers.push(cb);return function(){var a=globalThis.__oc.renderHandlers;var i=a.indexOf(cb);if(i>=0)a.splice(i,1);};},` +
    `registerTextChangeHandler:function(cb){globalThis.__oc.textHandlers.push(cb);return function(){var a=globalThis.__oc.textHandlers;var i=a.indexOf(cb);if(i>=0)a.splice(i,1);};},` +
    `log:function(l,m,d){if(process.env.DEBUG_OPENCUES)console.error("[opencues]["+l+"] "+m,d||"");}` +
    `};` +
    `globalThis.__oc.adapter=new __ocAdapterMod.ClaudeCodeV21Adapter(__ocBindings);` +
    `globalThis.__oc.hlState=new __ocStateMod.HighlightState();` +
    `globalThis.__oc.dynDefs=new __ocDynDefsMod.DynDefs();` +
    `__ocMod.Runtime.create(globalThis.__oc.adapter).then(function(rt){` +
    `globalThis.__oc.runtime=rt;` +
    `var nav=new __ocNavMod.Navigation(globalThis.__oc.adapter,globalThis.__oc.hlState,globalThis.__oc.dynDefs);` +
    `nav.subscribe();globalThis.__oc.nav=nav;` +
    `var dim=new __ocDimMod.DimRender(globalThis.__oc.adapter,globalThis.__oc.hlState,globalThis.__oc.dynDefs);` +
    `dim.subscribe();globalThis.__oc.dim=dim;` +
    `globalThis.__oc.applyRender=function(rendered,text,offset){` +
    `if(typeof rendered!=="string")return rendered;` +
    `var ctx={text:text||"",cursor:offset||0,externalHighlights:[]};` +
    `var out=rendered;` +
    `var handlers=globalThis.__oc.renderHandlers;` +
    `for(var __ocRi=0;__ocRi<handlers.length;__ocRi++){` +
    `try{var d=handlers[__ocRi](ctx);if(d)out=globalThis.__oc.rdMod.applyDirectives(out,d);}catch(__ocRe){}` +
    `}` +
    `return out;` +
    `};` +
    `}).catch(function(e){console.error("[opencues] runtime init failed:",e);globalThis.__oc.failed=true;});` +
    `}catch(__ocBe){console.error("[opencues] bootstrap error:",__ocBe);globalThis.__oc.failed=true;}` +
    `}}catch(__ocOe){}` +
    // Dispatch the current key event through the runtime's key handlers.
    `try{if(globalThis.__oc&&!globalThis.__oc.failed&&globalThis.__oc.keyHandlers&&globalThis.__oc.keyHandlers.length){` +
    `globalThis.__oc._lastText=${b2.inputZoneVar}.text;` +
    `globalThis.__oc._lastOffset=${b2.inputZoneVar}.offset;` +
    `var __ocEv=${b1.eventParam};` +
    `var __ocMods={ctrl:!!__ocEv.ctrl,alt:!!(__ocEv.alt||__ocEv.meta||__ocEv.option),shift:!!__ocEv.shift,meta:!!__ocEv.super};` +
    `var __ocKeyEv={key:__ocEv.key,modifiers:__ocMods,text:${b2.inputZoneVar}.text,cursorOffset:${b2.inputZoneVar}.offset};` +
    `var __ocConsumed=false;` +
    `for(var __ocI=0;__ocI<globalThis.__oc.keyHandlers.length;__ocI++){` +
    `try{if(globalThis.__oc.keyHandlers[__ocI](__ocKeyEv)){__ocConsumed=true;break;}}catch(__ocHe){}` +
    `}` +
    `if(__ocConsumed){` +
    `if(globalThis.__oc.pendingRender&&globalThis.__oc.adapterMod){` +
    `globalThis.__oc.pendingRender=false;` +
    `try{var __ocNextText=globalThis.__oc.adapterMod.toggleZeroWidth(${b2.inputZoneVar}.text);` +
    `return ${b2.inputZoneClass}.fromText(__ocNextText,${b2.columnsVar},${b2.inputZoneVar}.offset);` +
    `}catch(__ocTe){return ${b2.inputZoneVar};}` +
    `}` +
    `return ${b2.inputZoneVar};` +
    `}` +
    `}}catch(__ocDe){}`;

  // S3 wrapper: replace `renderedValue:<EXPR>` with a guarded applyRender call.
  // applyRender is null until the runtime init promise resolves; the guard
  // means we transparently fall back to the original render until then.
  const s3Wrapper =
    `(globalThis.__oc&&globalThis.__oc.applyRender` +
    `?globalThis.__oc.applyRender(${s3!.expression},${s2!.bindings.inputZoneVar}.text,${s2!.bindings.inputZoneVar}.offset)` +
    `:${s3!.expression})`;

  // Apply both injections. S1 sits inside the function body (S1.startIndex < S3.startIndex
  // because S1 is body-start of handleKeyDown and S3 is later in the same closure).
  // Apply highest-position first so earlier indices remain valid.
  let out = oldFile;
  out = out.slice(0, s3!.startIndex) + s3Wrapper + out.slice(s3!.endIndex);
  out = out.slice(0, s1!.startIndex) + bootstrap + out.slice(s1!.endIndex);
  return out;
}
