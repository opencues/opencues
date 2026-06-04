// SentinelBlank — keyword-bound write surface for IDENTITY.md.
//
// Triggered by:
//   set sentinel <key> <value> _        → add or update
//   remove sentinel <key> _             → delete
//
// Every write goes through the single chokepoint `validateSentinelWrite`
// in @opencues/core. The validator enforces:
//   - KEY SHAPE      `[A-Za-z][A-Za-z0-9_-]*` (no path traversal,
//                    no shell metacharacters, no Unicode tricks)
//   - VALUE SHAPE    rejects NUL + C0/C1 control chars (defence-in-
//                    depth against YAML/raw-mode prompt smuggling)
//   - VALUE LENGTH   256-char cap (DEFAULT_SENTINEL_CAPS)
//   - CAPACITY       64-field cap (refuses unbounded growth)
//   - COLLISION      rejects keys that derive to a token already in
//                    use under a different key name
//
// Errors are NEVER silent — the blank's return value is what gets
// painted into the buffer, so a capacity-exceeded write produces a
// visible `[err] IDENTITY.md is full — ...` pair the user can read and
// react to.
//
// Security model — full review at docs/architecture/security-audit.md
// row #24. Key invariants:
//
//   1. KEYWORD-BOUND ONLY. No LLM classification routes here (cf. the
//      explicit refusal in fluid-config to extend ConfigIntent to
//      IDENTITY.md writes). User must type the literal `set sentinel`
//      / `remove sentinel` phrase before `_`.
//   2. TRUST-GATE PROTECTED. The `_` keystroke is policed by the
//      credit-based trust gate (security-audit row #13); a hostile
//      page can't synthesize the trigger.
//   3. NO AMBIENT CONTEXT. The blank ignores ambient field metadata
//      (placeholder/aria/page title). Page text cannot influence the
//      key or value.
//   4. PACK-SHADOW DEFENDED. Built-in `sentinel` is registered in
//      BUILTIN_BLANKS before any user pack; first-wins at
//      user-blanks/registry.ts:145.
//   5. VALIDATOR IS THE ONLY WRITE PATH. The shell-script fallback
//      (defaults/blanks/sentinel/sentinel-blank.sh) routes back to
//      the same validator via `opencues identity set`. Adding a
//      second site that writes IDENTITY.md without going through
//      validateSentinelWrite is an audit-row-worthy regression.

import type { Blank } from './types';
import {
  parseIdentityMd,
  validateSentinelWrite,
  DEFAULT_SENTINEL_CAPS,
  deriveToken,
  type SentinelCaps,
  type SentinelField,
} from '@opencues/core';

export interface SentinelBlankOptions {
  /** Read IDENTITY.md content. Returns null when missing. */
  readonly readFile: () => Promise<string | null>;
  /** Write IDENTITY.md (atomic replace). */
  readonly writeFile: (content: string) => Promise<void>;
  /** Override default caps (64 × 256). Used by tests + future per-host policy. */
  readonly caps?: SentinelCaps;
}

export class SentinelBlank implements Blank {
  readonly name = 'sentinel';
  readonly readOnly = false;
  private readonly _read: () => Promise<string | null>;
  private readonly _write: (content: string) => Promise<void>;
  private readonly _caps: SentinelCaps;

  constructor(opts: SentinelBlankOptions) {
    this._read = opts.readFile;
    this._write = opts.writeFile;
    this._caps = opts.caps ?? DEFAULT_SENTINEL_CAPS;
  }

  /**
   * Dispatch — `keyword` is the matched phrase ("set sentinel" /
   * "remove sentinel"), `context` is everything between the keyword
   * and `_`.
   *
   * Return string is what the runtime substitutes for `_` in the
   * buffer. Successful writes return the visible `key = value` pair
   * (or `[removed key]`); failures return `[err] <detail>` so the
   * user sees what went wrong without leaving the buffer.
   */
  async get(keyword?: string, context?: readonly string[]): Promise<string> {
    const args = (context ?? []).filter(w => w.length > 0);
    const isRemove = /^remove\s+sentinel$/i.test(keyword ?? '');
    const isSet = /^set\s+sentinel$/i.test(keyword ?? '');
    if (!isSet && !isRemove) {
      return formatError(`unknown keyword "${keyword ?? ''}"`);
    }

    // Parse current state. Empty file is fine (validator handles []).
    const text = (await this._read()) ?? '';
    // Drop derived fields (token, description) — validator only needs
    // {key, value}. Type-narrowing satisfies the SentinelField shape.
    const currentFields: readonly SentinelField[] = parseIdentityMd(text).fields
      .map(f => ({ key: f.key, value: f.value }));

    if (isRemove) {
      const key = args[0];
      if (!key) return formatError('remove sentinel: usage is `remove sentinel <key> _`');
      const r = validateSentinelWrite(currentFields, { op: 'remove', key }, this._caps);
      if (!r.ok) return formatError(r.detail);
      await this._write(serialiseFrontmatter(r.fields, text));
      return `[removed ${key}]`;
    }

    // SET path. context = [key, ...valueWords]. Value can be multi-word.
    const key = args[0];
    const value = args.slice(1).join(' ');
    if (!key) return formatError('set sentinel: usage is `set sentinel <key> <value> _`');
    if (!value) return formatError(`set sentinel: missing value for "${key}"`);
    const r = validateSentinelWrite(currentFields, { op: 'set', key, value }, this._caps);
    if (!r.ok) return formatError(r.detail);
    if (r.action === 'noop') {
      // Same key, same value — no write, but show confirmation.
      return `${key} = ${value}`;
    }
    await this._write(serialiseFrontmatter(r.fields, text));
    // Visual confirmation: derived token + value so the user sees what
    // the LLM will substitute later.
    const token = deriveToken(key);
    return `${token} = ${value}`;
  }
}

/**
 * Re-emit the YAML frontmatter from the validated post-write fields
 * while PRESERVING the body (notes/docstring) of the original file.
 *
 * We don't re-use the CLI's writer because the runtime can't pull a
 * CJS helper from packages/opencues-cli. The shape stays identical:
 * `<key>: <value>` lines, aligned colons for readability, quoted
 * values when YAML-special starters / booleans appear.
 */
function serialiseFrontmatter(fields: readonly SentinelField[], existing: string): string {
  const bodyMatch = existing.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  const body = bodyMatch ? bodyMatch[1] : '';
  const longestKey = fields.reduce((m, f) => Math.max(m, f.key.length), 0);
  const lines = fields.map(f => {
    const v = needsQuoting(f.value) ? `"${f.value.replace(/"/g, '\\"')}"` : f.value;
    return `${f.key}:${' '.repeat(longestKey - f.key.length + 4)}${v}`;
  });
  const bodySep = body.length === 0 ? '' : (body.startsWith('\n') ? body : '\n' + body);
  return `---\n${lines.join('\n')}\n---${bodySep}`;
}

function needsQuoting(value: string): boolean {
  if (/^[#@&*!|>'"%-]/.test(value)) return true;
  if (/^(yes|no|true|false|null|on|off)$/i.test(value)) return true;
  if (/\s#/.test(value)) return true;
  if (/^\s|\s$/.test(value)) return true;
  return false;
}

function formatError(detail: string): string {
  // `[err] ...` prefix is the marker BlankFill / cycling code uses to
  // know not to register satellite-cycling state on the result. Keeps
  // the error visible but inert.
  return `[err] ${detail}`;
}
