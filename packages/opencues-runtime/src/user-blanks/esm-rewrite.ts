// AST-based ESM → CJS-shim rewriter for user-blank sources.
//
// User blanks are authored as ESM (`export default { ... }`) but
// executed in environments that don't parse ESM directly:
//   - Node loader: `vm.runInContext` runs classic script
//   - Chrome loader: Worker with embedded source (no `type=module`)
//
// Both need `export default X` → `module.exports.default = X`, plus
// `import` statements stripped (no module loading anyway) and bare
// `export const/let/...` demoted to top-level bindings.
//
// Previously this was a regex chain. Regex is structurally wrong
// because it can match inside strings/template literals/regexes/
// comments. An attacker can craft input where the wrong substring
// gets rewritten to escape the harness, and even non-malicious code
// can hit false positives (e.g. a string literal `'export default'`).
//
// This module uses acorn's parser to get an AST, then performs
// byte-range string surgery to rewrite ONLY the syntactically-real
// keywords. Line numbers + column offsets are preserved (replacements
// use spaces of equal length where possible) so error messages from
// the embedded source still point at the user's original line.

import { parse } from 'acorn';
import { simple as walkSimple } from 'acorn-walk';
import type { Node } from 'acorn';

interface AcornProgram extends Node {
  body: Node[];
}

interface RangeNode extends Node {
  start: number;
  end: number;
  type: string;
  declaration?: RangeNode;
  specifiers?: unknown[];
  source?: unknown;
}

export interface RewriteResult {
  /** Rewritten source ready to embed in a CJS-shim or Worker harness. */
  code: string;
  /** Set of features that were rejected — used by the loader to throw a
   *  more helpful error than "syntax error at line N". */
  warnings: string[];
}

export function rewriteEsmToCjsShim(source: string): RewriteResult {
  const warnings: string[] = [];
  let ast: AcornProgram;
  try {
    ast = parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: false,
      allowReturnOutsideFunction: false,
    }) as unknown as AcornProgram;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`user-blank source parse error: ${msg}`);
  }

  // Collect edits as (start, end, replacement) tuples. Apply in
  // reverse so earlier indices stay valid.
  const edits: { start: number; end: number; replacement: string }[] = [];

  for (const node of ast.body as RangeNode[]) {
    switch (node.type) {
      case 'ImportDeclaration': {
        // Replace the entire `import ... from '...';` with spaces of
        // equal length so line/column offsets are preserved. A trailing
        // semicolon (if any) is included in node.end.
        const len = node.end - node.start;
        edits.push({ start: node.start, end: node.end, replacement: ' '.repeat(len) });
        break;
      }
      case 'ExportDefaultDeclaration': {
        // `export default <expr>` → `module.exports.default = <expr>`
        // Replace the `export default ` prefix only; preserve the
        // expression body byte-for-byte (so any nested code keeps its
        // line/column positions).
        const decl = node.declaration;
        if (!decl) break;
        const prefixEnd = decl.start;
        const original = source.slice(node.start, prefixEnd);
        const replacement = 'module.exports.default = ';
        // Pad to preserve column offsets if our replacement is shorter
        // than the original (which it usually isn't — `export default `
        // is 15 chars vs 25 chars). Longer is fine, slightly shifts
        // columns on that one line.
        edits.push({
          start: node.start,
          end: prefixEnd,
          replacement: padToLen(replacement, original.length),
        });
        break;
      }
      case 'ExportNamedDeclaration': {
        // `export const x = ...` / `export function f() {}` etc. Drop
        // the `export ` keyword; the declaration becomes top-level.
        // Refuse `export { a, b }` and re-exports (`export ... from`)
        // because their bindings aren't available to the CJS shim.
        if (node.source) {
          warnings.push('re-export (`export ... from`) is not supported in user blanks');
          break;
        }
        if (!node.declaration) {
          warnings.push('bare `export { ... }` is not supported — use `export default` or `export const/function`');
          break;
        }
        const declStart = node.declaration.start;
        // Replace `export ` with spaces, leave the declaration intact.
        edits.push({
          start: node.start,
          end: declStart,
          replacement: ' '.repeat(declStart - node.start),
        });
        break;
      }
      case 'ExportAllDeclaration': {
        warnings.push('`export *` is not supported in user blanks');
        break;
      }
      default:
        // Non-export top-level statements are fine.
        break;
    }
  }

  // Walk the full tree for dynamic `import()` expressions. They'd
  // parse cleanly and pass through unchanged, then fail at runtime
  // when called (no module loader is wired in either sandbox). Catch
  // them at load time so the user gets a clear error instead of a
  // confusing "import is not a function" later.
  walkSimple(ast as unknown as Node, {
    ImportExpression() {
      warnings.push('dynamic `import()` is not supported in user blanks');
    },
  });

  // Apply edits right-to-left.
  edits.sort((a, b) => b.start - a.start);
  let out = source;
  for (const e of edits) {
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }

  return { code: out, warnings };
}

function padToLen(s: string, targetLen: number): string {
  if (s.length >= targetLen) return s;
  return s + ' '.repeat(targetLen - s.length);
}
