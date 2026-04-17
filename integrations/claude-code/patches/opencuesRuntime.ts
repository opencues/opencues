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

  // Single absolute path — boot.js handles all internal wiring.
  const bootPath = `(process.env.HOME||"~")+"/.claude/node_modules/opencues-runtime/dist/adapters/claude-code/v2.1/boot.js"`;

  // S1 injection: lazy-init __oc on first dispatch, then run the dispatch.
  const s1Bootstrap =
    `try{` +
    `if(!globalThis.__oc){` +
    `try{globalThis.__oc=${requireFn}(${bootPath}).boot({` +
    `hostVersion:"2.1.x",cwd:process.cwd(),` +
    `getText:function(){return ${iz}.text;},` +
    `getCursorOffset:function(){return ${iz}.offset;},` +
    `log:function(l,m,d){if(process.env.DEBUG_OPENCUES)console.error("[opencues]["+l+"] "+m,d||"");}` +
    `});}` +
    `catch(__ocBe){console.error("[opencues] boot failed:",__ocBe&&__ocBe.stack||__ocBe);globalThis.__oc={failed:true};}` +
    `}` +
    `if(globalThis.__oc&&!globalThis.__oc.failed){` +
    `if(globalThis.__oc.dispatchKey(${ev},${iz}.text,${iz}.offset)){` +
    `if(globalThis.__oc.consumePendingRender()){` +
    `try{return ${izClass}.fromText(globalThis.__oc.toggleRenderText(${iz}.text),${cols},${iz}.offset);}` +
    `catch(__ocRe){return ${iz};}` +
    `}` +
    `return ${iz};` +
    `}` +
    `}` +
    `}catch(__ocOe){console.error("[opencues] dispatch error:",__ocOe&&__ocOe.stack||__ocOe);}`;

  // S3 injection: wrap renderedValue. Guarded — passes through until __oc ready.
  const s3Wrapper =
    `(globalThis.__oc&&globalThis.__oc.applyRender` +
    `?globalThis.__oc.applyRender(${s3!.expression},${iz}.text,${iz}.offset)` +
    `:${s3!.expression})`;

  // Apply S3 first (later position, so S1 indices remain valid).
  let out = oldFile;
  out = out.slice(0, s3!.startIndex) + s3Wrapper + out.slice(s3!.endIndex);
  out = out.slice(0, s1!.startIndex) + s1Bootstrap + out.slice(s1!.endIndex);
  return out;
}
