// TEST-ONLY STUB — this file is NOT part of the production patch and is
// NEVER shipped to a user's machine.
//
// `opencuesRuntime.ts` imports `getRequireFuncName` from './helpers'
// because, once installed, `opencuesRuntime.ts` is copied ALONE into the
// cloned tweakcc tree (see `patches/setup.sh:281` —
// `cp "$SCRIPT_DIR/opencuesRuntime.ts" "$TWEAKCC_DIR/src/patches/"`) where
// tweakcc's own upstream `src/patches/helpers.ts` already lives. This repo
// does not vendor tweakcc's source, so `./helpers` has no real
// implementation checked in here — the only previous consumer that needed
// one (`scripts/check-cc-patch-boot.cjs`) worked around the gap by
// intercepting `require('./helpers')` at runtime via a custom require
// function rather than needing a file on disk.
//
// This file exists solely so `tsc --noEmit` and vitest can resolve
// `./helpers` when unit-testing `writeOpenCuesRuntimeV2` in isolation
// (see `opencuesRuntime.test.ts`). `setup.sh` never copies this file into
// the tweakcc clone, so it has zero effect on the shipped patch — the
// production `getRequireFuncName` implementation always comes from
// tweakcc's own vendored copy, not this one.
//
// The implementation below is a reasonable stand-in (finds the local
// variable bound to Node's `createRequire`), not a byte-for-byte port of
// tweakcc's real helper — the real one isn't vendored in this repo.

const CREATE_REQUIRE_REGEX = /(?:var|let|const)\s+([$\w]+)\s*=\s*[$\w.]*createRequire\([^)]*\)/;

export function getRequireFuncName(oldFile: string): string | null {
  const m = oldFile.match(CREATE_REQUIRE_REGEX);
  return m ? m[1] : null;
}
