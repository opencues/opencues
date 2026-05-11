import { describe, it, expect } from 'vitest';
import { rewriteEsmToCjsShim } from './esm-rewrite';

describe('rewriteEsmToCjsShim', () => {
  it('rewrites `export default { ... }`', () => {
    const src = `export default { get(ctx, args) { return 'hi'; } };`;
    const { code, warnings } = rewriteEsmToCjsShim(src);
    expect(warnings).toEqual([]);
    expect(code).toContain('module.exports.default =');
    expect(code).toContain("return 'hi'");
  });

  it('rewrites `export default async function ...`', () => {
    const src = `export default async function (ctx) { return ctx.now(); }`;
    const { code } = rewriteEsmToCjsShim(src);
    expect(code).toContain('module.exports.default =');
    expect(code).toContain('async function');
  });

  it('strips top-level imports', () => {
    const src = `import foo from 'bar';\nexport default { x: 1 };`;
    const { code } = rewriteEsmToCjsShim(src);
    expect(code).not.toContain('import foo');
    expect(code).toContain('module.exports.default =');
  });

  it('demotes `export const`', () => {
    const src = `export const helper = 1;\nexport default { x: helper };`;
    const { code } = rewriteEsmToCjsShim(src);
    expect(code).toContain('const helper = 1');
    expect(code).not.toMatch(/^export const/m);
  });

  it('does NOT rewrite "export default" inside a string', () => {
    const src = `const note = 'export default is the keyword';\nexport default { note };`;
    const { code } = rewriteEsmToCjsShim(src);
    // The string literal must survive intact
    expect(code).toContain("'export default is the keyword'");
    // But the real export must be rewritten
    expect(code).toContain('module.exports.default =');
  });

  it('does NOT rewrite "export default" inside a template literal', () => {
    const src = 'const tpl = `export default x`;\nexport default { tpl };';
    const { code } = rewriteEsmToCjsShim(src);
    expect(code).toContain('`export default x`');
    expect(code).toContain('module.exports.default =');
  });

  it('does NOT rewrite "export default" inside a comment', () => {
    const src = `// export default fake\nexport default { real: true };`;
    const { code } = rewriteEsmToCjsShim(src);
    expect(code).toContain('// export default fake');
    expect(code).toContain('module.exports.default =');
  });

  it('warns on `export *` re-exports', () => {
    const src = `export * from 'somewhere';\nexport default { x: 1 };`;
    const { warnings } = rewriteEsmToCjsShim(src);
    expect(warnings.some(w => w.includes('export *'))).toBe(true);
  });

  it('warns on `export { foo } from "x"` re-exports', () => {
    const src = `export { foo } from 'x';\nexport default { x: 1 };`;
    const { warnings } = rewriteEsmToCjsShim(src);
    expect(warnings.some(w => w.includes('re-export'))).toBe(true);
  });

  it('warns on bare `export { foo }`', () => {
    const src = `const foo = 1;\nexport { foo };\nexport default { foo };`;
    const { warnings } = rewriteEsmToCjsShim(src);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('warns on dynamic `import()` expressions', () => {
    const src = `async function load() { return import('./other.js'); }\nexport default { load };`;
    const { warnings } = rewriteEsmToCjsShim(src);
    expect(warnings.some(w => w.includes('dynamic `import()`'))).toBe(true);
  });

  it('throws on syntax errors', () => {
    expect(() => rewriteEsmToCjsShim('export default {{{')).toThrow(/parse error/);
  });

  it('preserves line numbers (import → blanks)', () => {
    const src = `import foo from 'bar';\n\nexport default { x: 1 };`;
    const { code } = rewriteEsmToCjsShim(src);
    const lines = code.split('\n');
    // Line 1 is now blank-spaces, line 3 holds the rewritten export.
    expect(lines[2]).toContain('module.exports.default =');
  });
});
