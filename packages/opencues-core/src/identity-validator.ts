/**
 * IDENTITY.md write-validator — the load-bearing safety check for ANY
 * code path that mutates `~/.cues/IDENTITY.md`.
 *
 * Today's call sites:
 *   - `opencues identity set <key> <value>` (CLI)
 *   - The interactive interview in the same CLI command
 *
 *   - The keyword-bound `set sentinel <key> <value> _` blank
 *     (packages/opencues-runtime/src/blanks/sentinel.ts; threat model in
 *     docs/architecture/security-audit.md row #24).
 *
 * Validator concerns — enforced uniformly across every site:
 *   1. KEY SHAPE — `[A-Za-z][A-Za-z0-9_-]*`. Anything else corrupts
 *      the YAML or the derived sentinel token.
 *   2. TOKEN COLLISION — `firstName` and `first_name` both derive to
 *      `[FIRST NAME]`. The parser drops the second silently
 *      (first-wins); the validator refuses up-front so the write
 *      doesn't appear to succeed.
 *   3. CAPACITY — hard caps on field count and value length. Without
 *      these, a hostile or buggy write loop could balloon IDENTITY.md.
 *   4. VALUE SHAPE — reject control chars / NUL / very-long values.
 *      Defence-in-depth for the YAML parser; keeps `raw` mode from
 *      smuggling control sequences into LLM prompts.
 *
 * The validator is PURE — no I/O, no side effects. Callers feed it the
 * current fields and the proposed change; it emits a discriminated
 * result the call site can render (CLI: stderr; blank: error painted
 * into the satellite pair so it's visible in the buffer).
 *
 * Security note: the validator is the ONLY layer between user-typed
 * (or blank-script-passed) input and the IDENTITY.md write. Any future
 * call site MUST go through `validateSentinelWrite` — adding a second
 * site that writes IDENTITY.md directly is an audit-table-row-worthy
 * regression (rebuts Row #24's "validator is the single chokepoint"
 * defence).
 */

import { deriveToken } from './identity-context';

/** Default capacity caps — defence-in-depth bound for IDENTITY.md size.
 *  Tuned generously enough that a heavy real user (50 sentinels with
 *  long signOff blocks) sits well under, while a runaway write loop
 *  hits the wall fast. Override per call site via `validateSentinelWrite`'s
 *  `caps` option. */
export const DEFAULT_SENTINEL_CAPS = {
  /** Maximum number of fields in IDENTITY.md. */
  maxFields: 64,
  /** Maximum length (UTF-16 code units) of a single value. */
  maxValueLength: 256,
} as const;

export interface SentinelCaps {
  readonly maxFields: number;
  readonly maxValueLength: number;
}

/** The proposed change — one of three shapes the validator needs to
 *  reason about. `set` covers both add and update. */
export type SentinelWriteOp =
  | { op: 'set'; key: string; value: string }
  | { op: 'remove'; key: string };

/** Minimal field shape — matches the public `IdentityField` but
 *  takes only `key` + `value` so callers (CLI, blank) don't need to
 *  pre-derive the token. */
export interface SentinelField {
  readonly key: string;
  readonly value: string;
}

/** Discriminated result type. `ok: true` means the validation passed
 *  and `fields` is the post-write array the caller should serialise.
 *  `ok: false` carries an `error` code + `detail` message a UI can
 *  render verbatim. */
export type SentinelValidationResult =
  | { ok: true; fields: readonly SentinelField[]; action: 'added' | 'updated' | 'removed' | 'noop' }
  | {
      ok: false;
      /** Machine-readable failure code — match on this in UI code. */
      error: 'invalid-key' | 'collision' | 'capacity-exceeded' | 'value-too-long' | 'value-invalid' | 'not-found';
      /** Human-readable message for stderr / in-buffer painting. */
      detail: string;
      /** For `collision`: the existing key that owns the same token.
       *  For `capacity-exceeded`: the current field count. */
      context?: Record<string, string | number>;
    };

const KEY_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
// NUL + C0/C1 control chars (except tab/newline) corrupt YAML and
// smuggle control sequences into LLM prompts in raw mode.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_VALUE_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

/**
 * Validate a proposed write against the current fields + caps.
 *
 * `currentFields` is the parsed state of IDENTITY.md just before this
 * write (call sites get this from `parseIdentityMd(readUserMd())`).
 * Returns the post-write field array on success — the caller writes
 * that verbatim to disk.
 */
export function validateSentinelWrite(
  currentFields: readonly SentinelField[],
  proposed: SentinelWriteOp,
  caps: SentinelCaps = DEFAULT_SENTINEL_CAPS,
): SentinelValidationResult {
  if (proposed.op === 'remove') {
    const idx = currentFields.findIndex(f => f.key === proposed.key);
    if (idx === -1) {
      return {
        ok: false,
        error: 'not-found',
        detail: `no sentinel with key "${proposed.key}" — nothing to remove`,
      };
    }
    return {
      ok: true,
      fields: currentFields.filter((_, i) => i !== idx),
      action: 'removed',
    };
  }

  const { key, value } = proposed;

  // 1. KEY SHAPE
  if (!KEY_RE.test(key)) {
    return {
      ok: false,
      error: 'invalid-key',
      detail: `key "${key}" must match [A-Za-z][A-Za-z0-9_-]* — letters/digits/underscore/hyphen only, must start with a letter`,
    };
  }

  // 2. VALUE SHAPE
  if (typeof value !== 'string') {
    return {
      ok: false,
      error: 'value-invalid',
      detail: `value for "${key}" must be a string`,
    };
  }
  if (FORBIDDEN_VALUE_CHARS.test(value)) {
    return {
      ok: false,
      error: 'value-invalid',
      detail: `value for "${key}" contains forbidden control characters`,
    };
  }
  if (value.length > caps.maxValueLength) {
    return {
      ok: false,
      error: 'value-too-long',
      detail: `value for "${key}" exceeds ${caps.maxValueLength}-char cap (got ${value.length})`,
      context: { maxValueLength: caps.maxValueLength, actual: value.length },
    };
  }

  // 3. TOKEN COLLISION — does some OTHER key derive to the same
  //    canonical token? `firstName` and `first_name` both → [FIRST
  //    NAME]; parser keeps first, drops second silently. Refuse here.
  const token = deriveToken(key);
  const collision = currentFields.find(
    f => f.key !== key && deriveToken(f.key) === token,
  );
  if (collision) {
    return {
      ok: false,
      error: 'collision',
      detail: `key "${key}" derives to ${token} — same token as existing "${collision.key}"`,
      context: { token, conflictingKey: collision.key },
    };
  }

  // 4. CAPACITY — only enforced on ADD. Updates of an existing key
  //    don't grow the field count, so capacity is irrelevant.
  const existingIdx = currentFields.findIndex(f => f.key === key);
  const isAdd = existingIdx === -1;
  if (isAdd && currentFields.length >= caps.maxFields) {
    return {
      ok: false,
      error: 'capacity-exceeded',
      detail: `IDENTITY.md is full — ${currentFields.length}/${caps.maxFields} fields defined. Remove unused ones with \`opencues identity remove <key>\`.`,
      context: { maxFields: caps.maxFields, current: currentFields.length },
    };
  }

  // No-op detection: same key, same value. Surface to caller (CLI
  // can skip the write; blank can avoid a useless satellite pair).
  if (!isAdd && currentFields[existingIdx].value === value) {
    return {
      ok: true,
      fields: currentFields,
      action: 'noop',
    };
  }

  // Build post-write array.
  const next: SentinelField[] = isAdd
    ? [...currentFields, { key, value }]
    : currentFields.map((f, i) => (i === existingIdx ? { key, value } : f));

  return {
    ok: true,
    fields: next,
    action: isAdd ? 'added' : 'updated',
  };
}
