// Catches the class of bug that broke `opencues install gemini-cli`
// after the security push: dot access on `process.env.X` compiled
// fine in the @opencues/runtime build (loose tsconfig) but failed
// TS4111 ("must be accessed with ['X']") in the gemini-cli fork
// build (strict tsconfig — `noPropertyAccessFromIndexSignature: true`).
//
// Bootstrap files are unique in our build pipeline: they ship in this
// repo as `.ts` source AND get re-type-checked by each host fork's
// tsc at install time. The strictest fork governs — anything any host
// will reject must be rejected here too.
//
// Two layers of defence:
//
//   1. Targeted pattern scan (this file). Cheap + fast — catches the
//      specific anti-patterns we've seen surface in real installs.
//      Fails on a regex hit; reports the file + matched text.
//
//   2. Full `tsc --noEmit` against a strict-superset tsconfig would be
//      more thorough but needs import-resolution wiring (the bootstrap
//      imports `@opencues/runtime` which needs to be built first).
//      Deferred until we see a strict-mode bug class the regex doesn't
//      cover.
//
// When you add a new bootstrap file or hit a new strict-mode error
// during a fork install, add a regex here. Each pattern should have a
// comment naming the TS error code + a one-line repro.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const BOOTSTRAPS = [
  // The patched source that gets copied into each fork. Type-checked by
  // the fork's tsc on `npm run build` at install time. Bootstrap source
  // = TS that gets COMPILED, so TS strictness applies.
  'integrations/gemini-cli/patches/opencuesBootstrap.ts',
  'integrations/opencode/patches/opencuesBootstrap.ts',
  // CC's `opencuesRuntime.ts` is intentionally EXCLUDED. It's not a
  // bootstrap that gets compiled — it's a TS generator that emits
  // JavaScript strings (backtick templates) that tweakcc injects
  // verbatim into cli.js. The embedded JS runs in plain Node with no
  // TS strictness applied. Lint-style checks against the templates
  // would surface false positives (every `process.env.X` inside a
  // backtick template is fine at runtime; TS never sees it). The
  // generator file itself has no problematic patterns outside the
  // strings — covered by the TS compile of `@opencues/runtime`
  // already.
];

// Each rule = { pattern, errorCode, fix, rationale }.
// `pattern` MUST be /g so .matchAll captures every occurrence; the test
// reports the line + matched text for each hit.
const RULES: ReadonlyArray<{
  pattern: RegExp;
  errorCode: string;
  description: string;
  fix: string;
}> = [
  {
    // Gemini-CLI's tsconfig sets noPropertyAccessFromIndexSignature: true.
    // process.env is typed as Record<string, string | undefined>, so
    // accessing arbitrary env-var names via dot is a TS4111 error.
    // Repro: `if (process.env.OPENCUES_HOME) {...}` in gemini bootstrap
    // produced "Property 'OPENCUES_HOME' comes from an index signature".
    pattern: /process\.env\.[A-Z][A-Z0-9_]*/g,
    errorCode: 'TS4111',
    description: 'dot access on process.env under noPropertyAccessFromIndexSignature',
    fix: "use bracket notation: `process.env['OPENCUES_HOME']` not `process.env.OPENCUES_HOME`",
  },
  // Future rules added here when new strict-mode bug classes surface.
  // Examples that would belong:
  //   - dot access on any Record<...>  index-signature type
  //   - unused locals (noUnusedLocals: true)
  //   - implicit any in catch (useUnknownInCatchVariables: true)
];

describe('host bootstrap files — strict-mode patterns', () => {
  for (const rel of BOOTSTRAPS) {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) {
      // A bootstrap file went missing — fail loudly so the list above
      // doesn't silently stop covering a real source path.
      it(`${rel} exists`, () => { expect(fs.existsSync(abs), `missing: ${abs}`).toBe(true); });
      continue;
    }
    const content = fs.readFileSync(abs, 'utf8');
    const lines = content.split('\n');

    for (const rule of RULES) {
      it(`${rel} — no ${rule.errorCode} (${rule.description})`, () => {
        const hits: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const matches = line.match(rule.pattern);
          if (matches) {
            for (const m of matches) {
              hits.push(`${rel}:${i + 1}  ${m}  in: ${line.trim()}`);
            }
          }
        }
        expect(
          hits,
          hits.length === 0
            ? ''
            : `${rule.errorCode} pattern found.\n` +
              `Fix: ${rule.fix}\n` +
              `Occurrences:\n  ${hits.join('\n  ')}`,
        ).toEqual([]);
      });
    }
  }
});
