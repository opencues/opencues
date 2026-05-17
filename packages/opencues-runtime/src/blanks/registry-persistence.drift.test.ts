// Drift-prevention: every cyclable scalar in @opencues/core's
// FEATURES + MENU_TUNABLES registry MUST persist correctly through
// OpenCuesSettingsBlank.set() against an OPENCUES.md that doesn't
// already contain a line for that scalar.
//
// Why this matters: the registry pattern's contract is "adding a
// feature is one PR appending one entry." For that to be true, the
// runtime persistence layer must handle "scalar not yet in file"
// gracefully — otherwise cycling the new feature for the first time
// silently fails to persist and the in-memory state snaps back when
// ConfigLoader hot-reloads.
//
// Pre-May-2026 every shipped scalar had its line baked into
// defaults/OPENCUES.md's `settings:` block, so rewriteSetting's
// "match existing line" assumption always held. The May 2026
// registry refactor made the file ship WITHOUT a settings: block,
// so the first registry-only scalar (`blank-trigger-mode`) hit the
// silent-skip bug live. This test would have caught it pre-ship.

import { describe, it, expect } from 'vitest';
import { FEATURES, MENU_TUNABLES, getCyclableValues } from '@opencues/core';
import { OpenCuesSettingsBlank } from './opencues-settings';

// A bare-minimum OPENCUES.md: frontmatter delimiters + one unrelated
// scalar to anchor parsing. NO settings: block, NO pre-existing
// lines for the scalars we cycle.
const BARE_OPENCUES_MD = '---\nfluid-blank-mode: on\n---\n\nbody\n';

interface Ctx {
  ctl: OpenCuesSettingsBlank;
  read(): string;
  writeCount(): number;
}

function makeCtx(initial: string): Ctx {
  let storage = initial;
  let writes = 0;
  const ctl = new OpenCuesSettingsBlank({
    readFile: async () => storage,
    writeFile: async (s: string) => { storage = s; writes++; },
  });
  return {
    ctl,
    read: () => storage,
    writeCount: () => writes,
  };
}

describe('every cyclable registry scalar round-trips through set()', () => {
  // Build the list of (scalar, value) pairs to test. For each
  // cyclable feature/tunable, pick the NON-default value so even an
  // already-defaulted file would force a write.
  type Pair = { scalar: string; value: string; source: 'FEATURE' | 'TUNABLE' };
  const pairs: Pair[] = [];
  for (const f of FEATURES) {
    const cyclable = getCyclableValues(f);
    if (cyclable.length < 2) continue;
    pairs.push({ scalar: f.scalar, value: cyclable[1].id, source: 'FEATURE' });
  }
  for (const t of MENU_TUNABLES) {
    if (t.values.length < 2) continue;
    pairs.push({ scalar: t.scalar, value: t.values[1].id, source: 'TUNABLE' });
  }

  for (const { scalar, value, source } of pairs) {
    it(`[${source}] ${scalar} → ${value} persists to a file with no existing line`, async () => {
      const ctx = makeCtx(BARE_OPENCUES_MD);
      await ctx.ctl.set(scalar, value);
      expect(ctx.writeCount(),
        `set(${scalar}, ${value}) skipped the write — ` +
        `OpenCuesSettingsBlank.rewriteSetting probably failed to handle "line doesn't exist yet" ` +
        `for this scalar. The registry contract requires this to succeed: adding the scalar to ` +
        `FEATURES/MENU_TUNABLES is supposed to be enough, and the persistence path must round-trip ` +
        `without the scalar pre-existing in defaults/OPENCUES.md.`,
      ).toBe(1);
      const re = new RegExp(`^${scalar}: ${value}$`, 'm');
      expect(ctx.read()).toMatch(re);
    });

    it(`[${source}] ${scalar} → ${value} second set() rewrites in place (idempotent, no duplicates)`, async () => {
      const ctx = makeCtx(BARE_OPENCUES_MD);
      await ctx.ctl.set(scalar, value);
      // Re-cycle to a different value (or back to a different valid value)
      await ctx.ctl.set(scalar, value);  // same value again
      const matches = ctx.read().match(new RegExp(`^${scalar}:`, 'gm')) ?? [];
      expect(matches,
        `set(${scalar}) called twice produced ${matches.length} lines; expected 1. ` +
        `Append-path is not idempotent — second cycle should REWRITE the line, not append a duplicate.`,
      ).toHaveLength(1);
    });
  }
});

describe('registry round-trip contract pins the shape', () => {
  it('every cyclable feature has at least two values (so cycling is meaningful)', () => {
    for (const f of FEATURES) {
      const cyclable = getCyclableValues(f);
      if (cyclable.length === 0) continue;  // not cyclable at all — fine
      expect(cyclable.length,
        `${f.scalar} declares only one cyclable value — the menu can't cycle anywhere. ` +
        `Either give it 2+ exposed values, or remove all values + skip cycling.`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('every tunable has 2+ values (otherwise it isn\'t a tunable)', () => {
    for (const t of MENU_TUNABLES) {
      expect(t.values.length, `${t.scalar} tunable has < 2 values`).toBeGreaterThanOrEqual(2);
    }
  });
});
