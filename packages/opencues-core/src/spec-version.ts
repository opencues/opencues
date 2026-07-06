/**
 * Cues spec version + parse/compare helpers.
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
 *
 * ## Runtime enforcement
 *
 * The spec MANDATES that a conforming reader refuse to parse files
 * declaring a `spec:` higher than the reader's pinned `SPEC_VERSION`
 * (and refuse cross-major-with-stable-reader files post-1.0). The
 * helpers below implement that comparison; the parsers in
 * `cues-md.ts` call `isSpecCompatible` on every file's frontmatter
 * before producing a config. Files that fail land as empty configs
 * with a populated `specError` field — callers log + skip.
 *
 * Files omitting `spec:` are treated as `SPEC_OMIT_DEFAULT` (a
 * permanent rule — old unannotated files keep working forever; the
 * default never moves forward).
 */
export const SPEC_VERSION = '0.6' as const;

export type SpecVersion = typeof SPEC_VERSION;

/**
 * Default spec target for files that omit a `spec:` frontmatter pin.
 * Permanent — never moves forward when SPEC_VERSION bumps.
 *
 * Reasoning: pre-existing unannotated files were authored against
 * `0.1-alpha` semantics. Moving the default forward would silently
 * misinterpret them. New files SHOULD declare their target version
 * explicitly. See CLAUDE.md § Spec-omit-default is permanent.
 */
export const SPEC_OMIT_DEFAULT = 'opencues/0.1-alpha' as const;

/**
 * Parsed spec pin: a `spec: opencues/<major>.<minor>[-<pre>]` string
 * decomposed into structured parts.
 *
 * Pre-release suffixes (`-alpha`, `-beta`, `-rc1`, …) are captured
 * but DO NOT participate in compatibility comparisons — `0.2-alpha`
 * and `0.2` are treated as the same version for refusal purposes.
 * (Pre-release semantics are draft-stage signalling; once a runtime
 * supports a minor, it supports every pre-release of it.)
 */
export interface SpecPin {
  readonly major: number;
  readonly minor: number;
  /** Pre-release tag without leading dash, or undefined. Informational only. */
  readonly pre?: string;
  /** The original string for logging. */
  readonly raw: string;
}

/**
 * Parse a `spec:` frontmatter value. Accepts:
 *
 *   - `opencues/0.1`
 *   - `opencues/0.1-alpha`
 *   - `opencues/1.0-rc1`
 *   - `opencues/2.5`
 *
 * Returns null on unparseable input (caller treats as a hard refusal
 * — an unparseable pin is not safe to ignore).
 */
export function parseSpecPin(declared: string): SpecPin | null {
  const m = declared.match(/^opencues\/(\d+)\.(\d+)(?:-([A-Za-z0-9.-]+))?$/);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || major < 0 || minor < 0) return null;
  return { major, minor, pre: m[3], raw: declared };
}

/**
 * Result of comparing a file's declared `spec:` against this build's
 * `SPEC_VERSION`. On refusal, `reason` is a one-line human-readable
 * string that callers SHOULD log verbatim.
 */
export interface SpecCompatResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Decide whether a file declaring `declared` may be parsed by this
 * runtime. Implements the spec's "MUST refuse newer" rule plus the
 * forward-looking semver rule for post-stable releases (major
 * mismatch = breaking, refuse).
 *
 * Algorithm:
 *
 *   1. Omitted or empty `declared` → treat as `SPEC_OMIT_DEFAULT`
 *      (always accepted as long as the default itself is <= reader).
 *   2. Unparseable `declared` → refuse (defensive).
 *   3. file.major > reader.major → refuse (newer major).
 *   4. file.major < reader.major AND reader.major >= 1 → refuse
 *      (stable reader cannot read a pre-major-bump file — major
 *      bumps are breaking by definition). For `0.x` readers this
 *      branch never fires; everyone's on major 0 in draft.
 *   5. file.major == reader.major AND file.minor > reader.minor →
 *      refuse (newer minor on the same major).
 *   6. Otherwise → accept.
 *
 * The pre-release suffix is informational — `0.2-alpha` and `0.2`
 * compare equal.
 *
 * Mutation testing tip: this function MUST stay total (every input
 * branch returns). The conformance suite + `spec-version.test.ts`
 * pin every branch.
 */
export function isSpecCompatible(declared: string | undefined | null): SpecCompatResult {
  const effective = (declared == null || declared === '') ? SPEC_OMIT_DEFAULT : declared;

  const filePin = parseSpecPin(effective);
  if (filePin === null) {
    return {
      ok: false,
      reason: `unparseable spec: "${effective}" — expected "opencues/<major>.<minor>[-<pre>]"`,
    };
  }

  const readerPin = parseSpecPin(`opencues/${SPEC_VERSION}`);
  // Invariant: SPEC_VERSION is built from the same regex, so this
  // never returns null. Belt + braces — the assertion is for
  // future-readers; a malformed SPEC_VERSION would be a build error
  // long before this path runs.
  if (readerPin === null) {
    return { ok: false, reason: `internal: SPEC_VERSION "${SPEC_VERSION}" is malformed` };
  }

  if (filePin.major > readerPin.major) {
    return {
      ok: false,
      reason: `spec "${filePin.raw}" newer than runtime's "opencues/${SPEC_VERSION}" (major ${filePin.major} > ${readerPin.major})`,
    };
  }

  if (filePin.major < readerPin.major && readerPin.major >= 1) {
    return {
      ok: false,
      reason: `spec "${filePin.raw}" is pre-major-bump (file major ${filePin.major} < runtime major ${readerPin.major}) — stable runtimes refuse files from prior major versions`,
    };
  }

  if (filePin.major === readerPin.major && filePin.minor > readerPin.minor) {
    return {
      ok: false,
      reason: `spec "${filePin.raw}" newer than runtime's "opencues/${SPEC_VERSION}" (minor ${filePin.minor} > ${readerPin.minor})`,
    };
  }

  return { ok: true };
}
