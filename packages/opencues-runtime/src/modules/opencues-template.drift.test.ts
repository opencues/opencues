// Drift test: the SHIPPED defaults/OPENCUES.md template must actually
// parse through the runtime's parseOpenCuesMd. The scalar unit tests in
// config-loader.test.ts exercise the parser with inline strings; nothing
// pinned the real template file, so a malformed edit (a comment block
// that breaks the frontmatter, a typo'd scalar name, a value outside the
// registry enum) would seed cleanly and fail silently at runtime.
// Born from the nav-keymap addition: the scalar existed in the FEATURES
// registry for weeks but the template never carried a line for it, and
// when the line + preset-options comment block were added there was no
// test proving the template still parsed.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FEATURES, MENU_TUNABLES } from '@opencues/core';
import { parseOpenCuesMd } from './config-loader';

const TEMPLATE_PATH = resolve(__dirname, '../../../../defaults/OPENCUES.md');
const template = readFileSync(TEMPLATE_PATH, 'utf8');

/** Scalar lines in the template's frontmatter (comments excluded). */
function templateScalars(source: string): Map<string, string> {
  const fm = source.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const out = new Map<string, string>();
  for (const line of fm.split('\n')) {
    const m = line.match(/^([a-z][\w-]*):[ \t]*(\S+)[ \t]*$/);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

describe('shipped defaults/OPENCUES.md template', () => {
  const shipped = templateScalars(template);

  it('has a parseable frontmatter with scalars in it', () => {
    // Guards the other assertions against going vacuous if the template
    // is restructured (e.g. frontmatter delimiters removed).
    expect(shipped.size).toBeGreaterThan(0);
  });

  it('parses through parseOpenCuesMd and lands nav-keymap in typed state', () => {
    const state = parseOpenCuesMd(template);
    // The new line, through the full parser (comment block included).
    expect(state.navKeymap).toBe('auto');
    // Neighbouring scalars still land — the comment block broke nothing.
    expect(state.cursorNavigate).toBe('inactive');
    expect(state.tipsMode).toBe('on');
    // The raw settings map carries the line verbatim.
    expect(state.settings.get('nav-keymap')).toBe('auto');
  });

  it('every template scalar is a known registry scalar', () => {
    // Free-text scalars: consumed from the raw settings map (see
    // blank-loading.ts), deliberately NOT in the registry because they
    // have no enumerable values to cycle — hand-edited only. Anything
    // added here must have a consumer reading `state.settings` directly.
    const FREE_TEXT_SCALARS = [
      'blank-loading-frames',
      'blank-loading-colors-rgb',
      'blank-loading-colors-ansi',
    ];
    const known = new Set<string>([
      ...FEATURES.map(f => f.scalar),
      ...MENU_TUNABLES.map(t => t.scalar),
      ...FREE_TEXT_SCALARS,
    ]);
    const unknown = [...shipped.keys()].filter(s => !known.has(s));
    expect(unknown,
      `template ships scalars the registry doesn't declare (typo, or add to FEATURES/MENU_TUNABLES): ${unknown.join(', ')}`,
    ).toEqual([]);
  });

  it('every template FEATURES value is a declared value id', () => {
    const mismatches: string[] = [];
    for (const f of FEATURES) {
      if (!shipped.has(f.scalar)) continue;       // absent = registry default, fine
      if (f.valuesProvider) continue;             // dynamic range (llm models) — not enumerable here
      const ids = f.values.map(v => v.id);
      const v = shipped.get(f.scalar)!;
      if (!ids.includes(v)) mismatches.push(`${f.scalar}: template ships '${v}' but declared values are [${ids.join(', ')}]`);
    }
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });
});
