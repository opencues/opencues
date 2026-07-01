// Drift-prevention: the selector-satellite cycling menu is derived
// from FEATURES + MENU_TUNABLES via getMenuDefinitions(). This test
// pins that derivation so a future change to FEATURES (or to the
// merge logic in getMenuDefinitions) doesn't silently break menu
// behaviour.
//
// Post-May-2026: defaults/OPENCUES.md no longer ships a `settings:`
// block; the registry IS the menu schema. The previous "menu vs
// OPENCUES.md" drift class doesn't exist anymore. This test pins the
// new contract:
//
//   1. Every cyclable feature (values.length >= 2 with at least one
//      exposeInMenu !== false value) appears in getMenuDefinitions().
//   2. Every MENU_TUNABLE appears in getMenuDefinitions().
//   3. Values flagged exposeInMenu: false are absent from the menu's
//      valueOrder (so they aren't reachable via cycling).
//   4. defaults/OPENCUES.md has NO `settings:` block (the registry
//      is canonical).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FEATURES,
  MENU_TUNABLES,
  getMenuDefinitions,
  getCyclableValues,
  SETTINGS_GROUP_ORDER,
} from './feature-registry';

const OPENCUES_MD = resolve(__dirname, '../../../defaults/OPENCUES.md');

describe('menu definitions ↔ FEATURES + MENU_TUNABLES', () => {
  const menu = getMenuDefinitions();

  it('every cyclable feature appears in the menu', () => {
    const missing: string[] = [];
    for (const f of FEATURES) {
      if (getCyclableValues(f).length < 2) continue;  // not cyclable
      if (!menu.has(f.scalar)) missing.push(f.scalar);
    }
    expect(missing,
      `FEATURES has cyclable scalars not in getMenuDefinitions() output: ${missing.join(', ')}. ` +
      `Check getMenuDefinitions() in feature-registry.ts.`,
    ).toEqual([]);
  });

  it('every MENU_TUNABLE appears in the menu', () => {
    const missing: string[] = [];
    for (const t of MENU_TUNABLES) {
      if (!menu.has(t.scalar)) missing.push(t.scalar);
    }
    expect(missing).toEqual([]);
  });

  it('hidden values (exposeInMenu: false) are absent from valueOrder', () => {
    for (const f of FEATURES) {
      const def = menu.get(f.scalar);
      if (!def) continue;
      const hiddenIds = f.values.filter(v => v.exposeInMenu === false).map(v => v.id);
      for (const hidden of hiddenIds) {
        expect(def.valueOrder.includes(hidden),
          `${f.scalar}: value '${hidden}' is exposeInMenu: false but appears in menu.valueOrder`,
        ).toBe(false);
      }
    }
  });

  it('identity-context-mode hides `raw` from the menu', () => {
    // Pin the specific case the exposeInMenu flag was added for.
    // (Renamed June 2026 from sentinels-mode → identity-context-mode.)  // LEGACY-NAME-ALLOW: historical narrative
    const def = menu.get('identity-context-mode');
    expect(def?.valueOrder).toEqual(['off', 'safe']);
    expect(def?.valueOrder.includes('raw')).toBe(false);
  });

  it('every menu entry has a non-empty valueOrder', () => {
    // A setting with no values can't cycle — would crash the satellite.
    for (const [scalar, def] of menu) {
      expect(def.valueOrder.length, `${scalar} has empty valueOrder`).toBeGreaterThan(0);
    }
  });

  it('every menu entry has a tip', () => {
    for (const [scalar, def] of menu) {
      expect(def.tip, `${scalar} missing tip`).toBeTruthy();
    }
  });

  it('every menu valueOrder entry has a matching valueTip', () => {
    for (const [scalar, def] of menu) {
      for (const v of def.valueOrder) {
        expect(def.valueTips.has(v),
          `${scalar}: value '${v}' in valueOrder but missing from valueTips`,
        ).toBe(true);
      }
    }
  });

  // Group coverage — `opencues config` renders sections from each scalar's
  // `group:`; an ungrouped or off-order scalar would land in the "More"
  // catch-all. Pin that every menu scalar has a group listed in
  // SETTINGS_GROUP_ORDER so adding a feature can't silently drop it there.
  it('every menu entry declares a group', () => {
    const missing: string[] = [];
    for (const [scalar, def] of menu) {
      if (!def.group) missing.push(scalar);
    }
    expect(missing,
      `these menu scalars have no group: (add group: to their FEATURES/MENU_TUNABLES entry): ${missing.join(', ')}`,
    ).toEqual([]);
  });

  // A MENU_TUNABLE's first value IS its default (menu's initial render), and
  // `opencues config` uses valueOrder[0] as the "default" it dims / compares
  // against. Pin that it matches what defaults/OPENCUES.md ships, so a fresh
  // user's tunable never shows as "changed from default" (the agent-debounce-ms
  // 150-vs-1000 bug). FEATURES are excluded on purpose: their registry default
  // is the CONSERVATIVE code fallback (absent → off), while the shipped seed
  // may deliberately opt the user into `on`/`safe` — that divergence is intended.
  it('MENU_TUNABLE defaults (valueOrder[0]) match defaults/OPENCUES.md', () => {
    const source = readFileSync(OPENCUES_MD, 'utf8');
    const fm = source.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? source;
    const shipped = new Map<string, string>();
    for (const line of fm.split('\n')) {
      const m = line.match(/^([a-z][\w-]*):[ \t]*(\S+)[ \t]*$/);
      if (m) shipped.set(m[1], m[2]);
    }
    const tunables = new Set(MENU_TUNABLES.map(t => t.scalar));
    const mismatches: string[] = [];
    for (const [scalar, def] of menu) {
      if (!tunables.has(scalar) || !shipped.has(scalar)) continue;
      if (def.valueOrder[0] !== shipped.get(scalar)) {
        mismatches.push(`${scalar}: OPENCUES.md ships '${shipped.get(scalar)}' but registry default is '${def.valueOrder[0]}'`);
      }
    }
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });

  it('every menu group is listed in SETTINGS_GROUP_ORDER', () => {
    const order = new Set(SETTINGS_GROUP_ORDER);
    const stray = [...menu.values()]
      .map(d => d.group)
      .filter((g): g is string => !!g && !order.has(g));
    expect([...new Set(stray)],
      `groups used by a scalar but missing from SETTINGS_GROUP_ORDER: ${[...new Set(stray)].join(', ')}`,
    ).toEqual([]);
  });
});

describe('defaults/OPENCUES.md does NOT ship a settings: block', () => {
  // Post-May-2026: the registry is the source of truth. If
  // defaults/OPENCUES.md ever re-grows a settings: block, the
  // file-driven path overrides the registry, re-introducing the drift
  // class this whole refactor exists to prevent. Fail loud.
  it('frontmatter contains no top-level `settings:` key', () => {
    const source = readFileSync(OPENCUES_MD, 'utf8');
    const fmMatch = source.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).toBeTruthy();
    const fm = fmMatch![1];
    // Top-level `settings:` (zero indent). Indented mentions inside
    // descriptions / comments don't count.
    expect(fm,
      `defaults/OPENCUES.md re-introduced a top-level settings: block. ` +
      `The registry (FEATURES + MENU_TUNABLES) is the source of truth; ` +
      `removing the block was deliberate.`,
    ).not.toMatch(/^settings:/m);
  });
});
