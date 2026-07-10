// Known-bug pin for lib/compat.cjs's `matchesRange` — bounded "X - Y"
// ranges whose string literally ends in ".x" (the common authoring
// shape, e.g. "1.4.0 - 1.4.x") are never matched.
//
// matchesRange checks, in order:
//   1. ">=N" prefix
//   2. range.endsWith('.x')            <-- fires on the WHOLE compound
//                                          string, not just a bound
//   3. range.includes(' - ')           <-- never reached for case 2
//   4. exact string equality
//
// A range like "1.4.0 - 1.4.x" itself ends in ".x", so branch 2 fires
// first and treats the ENTIRE "1.4.0 - 1.4.x" string as a single glob
// prefix (slicing off just the trailing "x"), which no real version
// string will ever start with. The intended " - " bound-range handling
// in branch 3 (which the code comment explicitly says exists to "accept
// either bound's prefix") is unreachable whenever the range is authored
// with an ".x" upper bound — which is the natural way to write one.
//
// Expected: matchesRange('1.4.5', '1.4.0 - 1.4.x') is true (1.4.5 falls
// within the 1.4.x compat window the range describes).
// Actual: false — see src/lib/compat.test.cjs's
// "edge: 'X - Y' bound range where NEITHER bound is a glob never
// matches" test for the passing/documented sibling case, and its comment
// for the full detail on this file's scope split.
//
// Proposed fix direction: check `range.includes(' - ')` BEFORE the
// `endsWith('.x')` check, so a compound range is split into its two
// bounds first and each bound is matched individually (each bound's own
// `.x` suffix, if any, is then handled correctly by the existing glob
// branch on the recursive call).
//
// This is a vitest file (not node:test) specifically so `it.fails` can
// pin the bug — see init.knownbug.test.mjs / uninstall.knownbug.test.mjs
// for the established convention this follows. Not picked up by this
// package's `node --test src/lib/*.test.cjs` script (vitest cannot even
// be `require()`d from a .cjs file — confirmed empirically); run
// explicitly with `npx vitest run src/lib/compat.knownbug.test.mjs`.
//
// No HOME/filesystem hermeticity concerns here — matchesRange is a pure
// string function with no filesystem or environment reads.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { matchesRange } = require('./compat.cjs');

describe('known bug: compat.cjs matchesRange mishandles "X - Y" ranges ending in ".x"', () => {
  it.fails('a version within a "X.Y.Z - X.Y.x" bounded range should match', () => {
    expect(matchesRange('1.4.5', '1.4.0 - 1.4.x')).toBe(true);
  });
});
