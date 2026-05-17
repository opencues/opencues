// OpenCuesSettingsBlank — selector + satellite blank that reads/
// writes OPENCUES.md. Triggered by `opencues settings _` / `config _`;
// spawns a "<setting> <value>" pair the user can cycle through.
//
//   get()                 → "<firstSettingName>\t<currentValue>"
//   get(name)             → "<currentValue>"   (name's current value, or "" if unknown)
//   set(name, value)      → rewrites the matching `name: value` line in OPENCUES.md
//
// The blank receives async readFile + writeFile functions instead of a
// hard-wired path so each host can route through its own filesystem (Node
// fs on opencode, chrome.storage on chrome).
//
// Setting names + current values are parsed from OPENCUES.md's top-level
// frontmatter. The first setting is whichever appears first under the
// `settings:` block (alphabetical isn't guaranteed — the file's order
// wins so users can pin their preferred default first setting).

import type { Blank } from './types';
import { getMenuDefinitions } from '@opencues/core';

export interface OpenCuesSettingsBlankOptions {
  /** Read the full OPENCUES.md content. Returns null when missing. */
  readonly readFile: () => Promise<string | null>;
  /** Write the full OPENCUES.md content (atomic replace). */
  readonly writeFile: (content: string) => Promise<void>;
}

export class OpenCuesSettingsBlank implements Blank {
  readonly name = 'opencues';
  readonly readOnly = false;
  private readonly _read: () => Promise<string | null>;
  private readonly _write: (content: string) => Promise<void>;

  constructor(opts: OpenCuesSettingsBlankOptions) {
    this._read = opts.readFile;
    this._write = opts.writeFile;
  }

  async get(keyword?: string): Promise<string> {
    const text = await this._read();
    if (!text) return '';

    // Menu schema: file overlay if present, else the @opencues/core
    // registry. Used both for the registry-driven default-value
    // fallback below AND the first-setting probe at the bottom.
    const menu = getMenuDefinitions();

    if (keyword) {
      const v = lookupSetting(text, keyword);
      if (v !== null) return v;
      // Keyword exists in the registry but not in the user's file →
      // return the registry default for THIS scalar. Don't fall
      // through to first-setting init: the caller (cycling.ts:218)
      // splices the result verbatim into the satellite, and a tab-
      // separated `<other>\t<v>` fallback would land a literal tab
      // in the buffer (rendered as multiple spaces in most hosts —
      // the canonical visible symptom of the pre-fix bug).
      const def = menu.get(keyword);
      if (def) return def.valueOrder[0] ?? '';
      // Genuinely-unknown keyword (e.g. a multi-word phrase that
      // BlankFill's keyword detection synthesised like
      // 'opencues settings') → fall through to first-setting init
      // so the satellite still spawns something sensible.
    }

    // No keyword → satellite initialisation. Find the first cyclable
    // setting name. Prefer the file's `settings:` block when present
    // (back-compat for users who ship a custom block); fall back to
    // @opencues/core's registry order since defaults/OPENCUES.md no
    // longer ships a settings: block.
    let first = firstSettingName(text);
    if (!first) {
      first = menu.keys().next().value ?? null;
    }
    if (!first) return '';
    const value = lookupSetting(text, first) ?? menu.get(first)?.valueOrder[0] ?? '';
    return `${first}\t${value}`;
  }

  // NB: argument order intentionally differs from volume-like blanks.
  // The runtime's selector/satellite cycling path (Cycling.ts) calls
  // `blankInvoke({action:'set', args:[setting, value]})` — setting
  // FIRST, mirroring the legacy bash `script set <setting> <value>`.
  // The Blank interface lists `(value, keyword)` for the volume-like
  // case; the labels here intentionally swap so the implementation
  // reads correctly even though the dispatcher passes args positionally.
  async set(settingName: string, value?: string): Promise<void> {
    if (!settingName || value === undefined) return;
    const text = await this._read();
    if (!text) return;
    const next = rewriteSetting(text, settingName, value);
    if (next !== text) await this._write(next);
  }
}

/** Pull the value for `name` from a top-level `name: value` line.
 *  Returns null when the line doesn't exist. */
function lookupSetting(text: string, name: string): string | null {
  const re = new RegExp(`^${escapeRegex(name)}:\\s*(.*)$`, 'm');
  const m = text.match(re);
  if (!m) return null;
  return m[1].trim();
}

/** Walk the indented `settings:` block and return the first key.
 *  Mirrors the awk in the legacy opencues-blank.sh:
 *    /^settings:/{f=1;next} f && /^  [a-z]/{print first key; exit}
 */
function firstSettingName(text: string): string | null {
  const lines = text.split('\n');
  let inBlock = false;
  for (const raw of lines) {
    if (!inBlock) {
      if (/^settings:\s*$/.test(raw)) inBlock = true;
      continue;
    }
    // Two-space-indent setting name (frontmatter format).
    const m = raw.match(/^ {2}([A-Za-z][A-Za-z0-9_\- ]*?):\s*$/);
    if (m) return m[1];
    // A zero-indent line ends the block before we found one.
    if (raw.length > 0 && !/^\s/.test(raw)) return null;
  }
  return null;
}

/** Replace the value half of a top-level `name:` line. If no such
 *  line exists, APPEND `name: value` inside the frontmatter (before
 *  the closing `---`). This matters for cycling scalars that aren't
 *  yet in the user's file — e.g. cycling `blank-trigger-mode` for
 *  the first time on a fresh install where defaults/OPENCUES.md
 *  ships without the line. Pre-fix: the rewrite regex didn't match,
 *  text was unchanged, write was skipped, and 2.5s later ConfigLoader
 *  hot-reloaded and reverted the in-memory state to the default.
 *  Symptom: cycling appears to work momentarily then snaps back. */
function rewriteSetting(text: string, name: string, value: string): string {
  const re = new RegExp(`^(${escapeRegex(name)}:)[^\\n]*$`, 'm');
  if (re.test(text)) {
    return text.replace(re, `$1 ${value}`);
  }
  // Line doesn't exist → append inside the closing frontmatter
  // delimiter. Match the LAST `---` standalone line that closes a
  // YAML frontmatter block (the first `---` opens it, the second
  // closes it). Insert `name: value` on its own line just before.
  // No frontmatter at all → bail (caller's set() already no-ops on
  // empty file; for malformed content we leave untouched rather
  // than risk corrupting it).
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return text;
  const fmEnd = (fmMatch.index ?? 0) + fmMatch[0].length;
  const fmStart = (fmMatch.index ?? 0) + '---\n'.length;
  const fmBody = text.slice(fmStart, fmEnd - '\n---'.length);
  const inserted = fmBody.endsWith('\n') || fmBody.length === 0
    ? `${fmBody}${name}: ${value}\n`
    : `${fmBody}\n${name}: ${value}\n`;
  return text.slice(0, fmStart) + inserted + text.slice(fmEnd - '\n---'.length);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
