// Drift-prevention: every cycleable scalar that ships in OPENCUES.md's
// selector-satellite settings menu (`settings:` frontmatter section)
// MUST correspond to a FEATURES registry entry, and vice versa.
//
// Why: the menu is what users see when they cycle `opencues settings _`.
// A FEATURES entry without a menu entry means the user can't toggle the
// feature via the menu (only by editing the file directly). A menu entry
// without a FEATURES entry means the menu can flip a value the runtime
// doesn't recognise — selector-satellite picks the value, writes it to
// OPENCUES.md, but no code reads it.
//
// Caught during the May 2026 audit: transform-blank-mode existed in the
// menu but was missing from FEATURES — the runtime read its value from
// the settings Map directly, but doctor/help/seed didn't know it existed
// as a feature. Added to FEATURES with SETTINGS_MAP_ONLY allowlist entry
// on the runtime side.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FEATURES, findFeature } from './feature-registry';

const OPENCUES_MD = resolve(__dirname, '../../../defaults/OPENCUES.md');

// Numeric / non-cycleable settings that legitimately appear in the
// menu without a FEATURES entry — these are exposed for ergonomic
// cycling (e.g. step through debounce values) but aren't features
// in the OpenCues sense (they're tunables, not surface gates).
const NON_FEATURE_MENU_ENTRIES: ReadonlySet<string> = new Set([
  'agent-debounce-ms',           // numeric: AgentRewrite debounce window
  'blank-loading-interval-ms',   // numeric: braille-rotate animation tick
  'max-concurrent-auditors',     // numeric: parallel auditor cap
  'blank-loading-animation',     // enum: braille-rotate / spinner / etc.
  'blank-loading-colors-rgb',    // color palette tuple
  'blank-loading-colors-ansi',   // color palette tuple
]);

// Parse top-level keys under the `settings:` block in OPENCUES.md
// frontmatter. Simple regex — sufficient for this layout.
function extractMenuKeys(source: string): string[] {
  const fmMatch = source.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];
  const fm = fmMatch[1];
  const settingsIdx = fm.indexOf('\nsettings:');
  if (settingsIdx < 0) return [];
  const after = fm.slice(settingsIdx + 1);
  // Top-level (2-space-indented) keys directly under `settings:`.
  // Match `  ([a-z][a-z0-9-]*):` at indentation level 2, not deeper.
  const keys: string[] = [];
  for (const line of after.split('\n')) {
    const m = line.match(/^  ([a-z][a-z0-9-]*):\s*$/);
    if (m) keys.push(m[1]);
    // Stop at next top-level key (no indent)
    if (/^\S/.test(line) && line !== 'settings:') break;
  }
  return keys;
}

describe('OPENCUES.md settings menu ↔ FEATURES registry', () => {
  const source = readFileSync(OPENCUES_MD, 'utf8');
  const menuKeys = extractMenuKeys(source);

  it('the parser found menu entries', () => {
    expect(menuKeys.length).toBeGreaterThan(5);
  });

  it('every menu entry is either in FEATURES or in NON_FEATURE_MENU_ENTRIES', () => {
    const unmatched: string[] = [];
    for (const key of menuKeys) {
      if (NON_FEATURE_MENU_ENTRIES.has(key)) continue;
      if (findFeature(key)) continue;
      unmatched.push(key);
    }
    expect(unmatched,
      `Menu entries in defaults/OPENCUES.md have no matching FEATURES registry entry: ` +
      `${unmatched.join(', ')}. Either add to FEATURES (if it's a feature) or to ` +
      `NON_FEATURE_MENU_ENTRIES in this test (if it's a numeric tunable).`,
    ).toEqual([]);
  });

  it('every cycleable FEATURES scalar has a menu entry', () => {
    const menuSet = new Set(menuKeys);
    const missing: string[] = [];
    for (const f of FEATURES) {
      // Single-value features aren't cycleable — skip
      if (f.values.length < 2) continue;
      if (menuSet.has(f.scalar)) continue;
      missing.push(f.scalar);
    }
    expect(missing,
      `FEATURES has cycleable scalars without a menu entry: ${missing.join(', ')}. ` +
      `Add to the settings: section of defaults/OPENCUES.md so users can cycle them ` +
      `via \`opencues settings _\`.`,
    ).toEqual([]);
  });
});
