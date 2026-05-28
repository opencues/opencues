/**
 * Cues spec version.
 *
 * The version of the Cues format spec this build of `@opencues/core`
 * implements. Hosts and third-party readers pin to this constant the
 * same way bundlers pin to ESM levels.
 *
 * Versioning policy lives in `SPEC.md` at the repo root.
 *
 * - `0.x` — draft. Incompatible format changes are allowed.
 * - `1.0` — first stable version. After that, additive = minor bump,
 *   breaking = major bump.
 */
export const SPEC_VERSION = '0.1' as const;

export type SpecVersion = typeof SPEC_VERSION;
