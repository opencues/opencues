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
