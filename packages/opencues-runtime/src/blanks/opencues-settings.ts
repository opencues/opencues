// OpenCuesSettingsBlank — selector + satellite blank that reads/
// writes opencues.md. Triggered by `opencues settings _` / `config _`;
// spawns a "<setting> <value>" pair the user can cycle through.
//
//   get()                 → "<firstSettingName>\t<currentValue>"
//   get(name)             → "<currentValue>"   (name's current value, or "" if unknown)
//   set(name, value)      → rewrites the matching `name: value` line in opencues.md
//
// The blank receives async readFile + writeFile functions instead of a
// hard-wired path so each host can route through its own filesystem (Node
// fs on opencode, chrome.storage on chrome).
//
// Setting names + current values are parsed from opencues.md's top-level
// frontmatter. The first setting is whichever appears first under the
// `settings:` block (alphabetical isn't guaranteed — the file's order
// wins so users can pin their preferred default first setting).

import type { Blank } from './types';

export interface OpenCuesSettingsBlankOptions {
  /** Read the full opencues.md content. Returns null when missing. */
  readonly readFile: () => Promise<string | null>;
  /** Write the full opencues.md content (atomic replace). */
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

    if (keyword) {
      const v = lookupSetting(text, keyword);
      if (v !== null) return v;
      // Unknown / unset — fall through to first-setting probe so the
      // satellite spawns something sensible.
    }

    const first = firstSettingName(text);
    if (!first) return '';
    const value = lookupSetting(text, first) ?? '';
    return `${first}\t${value}`;
  }

  // NB: argument order intentionally differs from volume-like controls.
  // The runtime's selector/satellite cycling path (Cycling.ts) calls
  // `controlInvoke({action:'set', args:[setting, value]})` — setting
  // FIRST, mirroring the legacy bash `script set <setting> <value>`.
  // The Control interface lists `(value, keyword)` for the volume-like
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

/** Replace the value half of a top-level `name:` line, leaving any
 *  surrounding whitespace + comments intact. No-op when the line
 *  doesn't exist (so a typo'd setting name doesn't corrupt the file). */
function rewriteSetting(text: string, name: string, value: string): string {
  const re = new RegExp(`^(${escapeRegex(name)}:)[^\\n]*$`, 'm');
  return text.replace(re, `$1 ${value}`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
