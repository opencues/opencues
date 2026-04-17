// Seam predicates for Claude Code v2.1.x — see refactor.md §4.
//
// Phase 1 covers S1 (KeyDispatcher) and S2 (InputStateHandler). Later phases add
// S3–S8. Predicates try a regex first (fast, matches the shape that's stayed
// stable through current reintegration) and fall back to an acorn AST walk so
// a renamed identifier doesn't break the match.
//
// Each predicate returns a SeamMatch on success, or null on miss. The installer
// aggregates misses into a fail-loud report per §8.3.

import { parse } from 'acorn';
import { simple as walkSimple } from 'acorn-walk';
import type { Node } from 'acorn';

export interface SeamMatch {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly bindings: Readonly<Record<string, string>>;
  readonly method: 'regex' | 'ast';
}

// ─── S1: KeyDispatcher ────────────────────────────────────────────────────
//
// Shape: function NAME(EVENT, ?){ switch (EVENT.key) { case "escape": ... } }
// Injection point: just after the opening { of the function body, before the
// switch. We capture (funcName, eventParam, keyParam).

const KEY_DISPATCHER_REGEX =
  /function ([$\w]+)\(([$\w]+),([$\w]+)\)\{switch\(\2\.key\)\{case"escape":/;

export function findKeyDispatcher(source: string): SeamMatch | null {
  const m = source.match(KEY_DISPATCHER_REGEX);
  if (m && m.index !== undefined) {
    const bodyStart = m.index + `function ${m[1]}(${m[2]},${m[3]}){`.length;
    return {
      startIndex: bodyStart,
      endIndex: bodyStart,
      bindings: { funcName: m[1], eventParam: m[2], keyParam: m[3] },
      method: 'regex',
    };
  }
  return astFindKeyDispatcher(source);
}

function astFindKeyDispatcher(source: string): SeamMatch | null {
  let ast: Node;
  try {
    ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true }) as unknown as Node;
  } catch {
    return null;
  }
  let found: SeamMatch | null = null;
  walkSimple(ast as Parameters<typeof walkSimple>[0], {
    FunctionDeclaration(node: unknown) {
      if (found) return;
      const fn = node as {
        id?: { name: string };
        params: Array<{ type: string; name?: string }>;
        body: {
          type: string;
          start: number;
          end: number;
          body: Array<{ type: string; discriminant?: { type: string; object?: { name?: string }; property?: { name?: string } }; cases?: Array<{ test?: { type: string; value?: unknown } }> }>;
        };
      };
      if (!fn.id || fn.params.length < 1) return;
      const eventParam = fn.params[0];
      const secondParam = fn.params[1];
      if (eventParam.type !== 'Identifier' || !eventParam.name) return;
      const firstStmt = fn.body.body[0];
      if (!firstStmt || firstStmt.type !== 'SwitchStatement') return;
      const disc = firstStmt.discriminant;
      if (!disc || disc.type !== 'MemberExpression') return;
      if (disc.object?.name !== eventParam.name) return;
      if (disc.property?.name !== 'key') return;
      const hasEscape = firstStmt.cases?.some(c =>
        c.test?.type === 'Literal' && c.test.value === 'escape',
      );
      if (!hasEscape) return;
      const bodyStart = fn.body.start + 1; // position just after `{`
      found = {
        startIndex: bodyStart,
        endIndex: bodyStart,
        bindings: {
          funcName: fn.id.name,
          eventParam: eventParam.name,
          keyParam: secondParam?.name ?? '',
        },
        method: 'ast',
      };
    },
  });
  return found;
}

// ─── S2: InputStateHandler ────────────────────────────────────────────────
//
// Shape: function NAME({value:V, onChange:OC, ...externalOffset:EO, onOffsetChange:OOC, ...})
//          { ... let X=EO, Y=OOC, Z=CLASS.fromText(V, COLS, X) ... return { handleKeyDown:HKD, renderedValue:... } ... }
//
// Injection points include both the IIFE area (before the return) and the
// return object itself (for rendered-value wrapping). Phase 1 only needs the
// bindings; later phases pick the exact anchor.

const INPUT_STATE_REGEX =
  /function ([$\w]+)\(\{value:([$\w]+),onChange:([$\w]+),[^}]+externalOffset:([$\w]+),onOffsetChange:([$\w]+)[^}]+\}\)\{[^}]*let ([$\w]+)=\4,([$\w]+)=\5,([$\w]+)=([$\w]+)\.fromText\(\2,([$\w]+),\6\)/;

const RETURN_REGEX = /return\{handleKeyDown:([$\w]+),renderedValue:/;

export function findInputStateHandler(source: string): SeamMatch | null {
  const m = source.match(INPUT_STATE_REGEX);
  if (!m || m.index === undefined) return null;
  const funcStart = m.index;
  // Same 60k window rationale as the current patch: successive injections grow the body.
  const tail = source.slice(funcStart, funcStart + 60000);
  const rm = tail.match(RETURN_REGEX);
  if (!rm || rm.index === undefined) return null;
  return {
    startIndex: funcStart + rm.index,
    endIndex: funcStart + rm.index,
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
    method: 'regex',
  };
}

// ─── S3: RenderedValue ────────────────────────────────────────────────────
//
// Shape: renderedValue:VAR.render(args...)  inside the InputStateHandler return.
// In v2.1.110 the call is `m.render(X,H,M,j6,G)` — 5 args. v2.1.x earlier
// minor bumps shipped 4-arg or 3-arg variants. After Rainbow input wraps,
// the shape becomes `renderedValue:(function(){ ... var _rv=m.render(...); ... })()`.
// We capture the entire expression (positions only) so the patch can wrap
// it in an applyRender() call.

const RENDERED_VALUE_RAINBOW = /renderedValue:\(function\(\)\{/;
const RENDERED_VALUE_5 = /renderedValue:([$\w]+)\.render\(([$\w]+,[$\w]+,[$\w]+,[$\w]+,[$\w]+)\)/;
const RENDERED_VALUE_4 = /renderedValue:([$\w]+)\.render\(([$\w]+,[$\w]+,[$\w]+,[$\w]+)\)/;
const RENDERED_VALUE_3 = /renderedValue:([$\w]+)\.render\(([$\w]+,[$\w]+,[$\w]+)\)/;

export function findRenderedValue(source: string): SeamMatch | null {
  // 1) Rainbow-wrapped IIFE — paren-balanced scan to find the matching `)()`.
  const rw = source.match(RENDERED_VALUE_RAINBOW);
  if (rw && rw.index !== undefined) {
    const exprStart = rw.index + 'renderedValue:'.length;
    let depth = 0;
    let i = exprStart;
    for (; i < source.length; i += 1) {
      const c = source.charAt(i);
      if (c === '(') depth += 1;
      else if (c === ')') {
        depth -= 1;
        if (depth === 0) {
          let endIdx = i + 1;
          if (source.charAt(i + 1) === '(' && source.charAt(i + 2) === ')') endIdx = i + 3;
          return {
            startIndex: exprStart,
            endIndex: endIdx,
            bindings: { kind: 'rainbow', expression: source.slice(exprStart, endIdx) },
            method: 'regex',
          };
        }
      }
    }
    return null; // unbalanced
  }

  // 2) Plain VAR.render(...) variants. Try most-args first.
  for (const [pat, kind] of [
    [RENDERED_VALUE_5, 'render-5'],
    [RENDERED_VALUE_4, 'render-4'],
    [RENDERED_VALUE_3, 'render-3'],
  ] as const) {
    const m = source.match(pat);
    if (m && m.index !== undefined) {
      const exprStart = m.index + 'renderedValue:'.length;
      const exprEnd = m.index + m[0].length;
      return {
        startIndex: exprStart,
        endIndex: exprEnd,
        bindings: {
          kind,
          renderVar: m[1],
          renderArgs: m[2],
          expression: source.slice(exprStart, exprEnd),
        },
        method: 'regex',
      };
    }
  }
  return null;
}

// ─── S6: StatusLineRefreshDebounce ────────────────────────────────────────
//
// Shape: a `useCallback` inside the React component that owns the statusline
// refresh. It clears any pending timer and sets a 300ms timeout that calls
// the actual refresh function.
//
// In v2.1.110:
//   k=F$.useCallback(()=>{
//     if(Z.current!==void 0)clearTimeout(Z.current);
//     Z.current=setTimeout((m,h)=>{m.current=void 0,h()},300,Z,V)
//   },[V])
//
// Capturing `k` lets us imperatively trigger a statusline refresh from
// runtime code (Statusline writes its export, then calls k() to make CC
// re-run the statusLine command). Without this, the consumer relies on
// CC's own infrequent refresh schedule or the `refreshInterval` polling
// workaround.

const STATUSLINE_REFRESH_REGEX =
  /([$\w]+)=([$\w]+)\.useCallback\(\(\)=>\{if\(([$\w]+)\.current!==void 0\)clearTimeout\(\3\.current\);\3\.current=setTimeout\(\([^)]+\)=>\{[^}]+\},300,\3,([$\w]+)\)\},\[\4\]\)/;

export function findStatusLineRefresh(source: string): SeamMatch | null {
  const m = source.match(STATUSLINE_REFRESH_REGEX);
  if (!m || m.index === undefined) return null;
  const endIndex = m.index + m[0].length;
  return {
    startIndex: m.index,
    endIndex,
    bindings: {
      callbackVar: m[1],
      reactNs: m[2],
      timerRef: m[3],
      refreshFn: m[4],
    },
    method: 'regex',
  };
}

// ─── Assertion helper — installer aggregates misses ───────────────────────

export interface SeamResult {
  readonly id: string;
  readonly match: SeamMatch | null;
}

export function runSeams(source: string, seams: Array<[string, (s: string) => SeamMatch | null]>): SeamResult[] {
  return seams.map(([id, fn]) => ({ id, match: fn(source) }));
}

export function assertAllFound(results: readonly SeamResult[]): void {
  const missing = results.filter(r => r.match === null).map(r => r.id);
  if (missing.length > 0) {
    throw new Error(
      `OpenCues v2 installer: FAILED to find ${missing.length} critical seam(s):\n` +
        missing.map(id => `  - ${id}`).join('\n') +
        `\nLikely cause: unsupported Claude Code version. Add a matching adapter band under ` +
        `packages/opencues-runtime/adapters/claude-code/ or pin claude-cues to a supported version.`,
    );
  }
}
