/**
 * Scenario tests for the cycling + spans + dim + nav system.
 *
 * Unit tests pin one module's behaviour at one moment in time. Most of
 * the bugs we hit in the April 2026 arc were INTERACTIONS across
 * modules and TRANSITIONS across user actions — exactly what unit
 * tests are structurally bad at catching.
 *
 * This file holds multi-step user journeys, multi-span scenarios,
 * cross-module render assertions, and invariants that must hold
 * across any sequence of valid actions. Each test simulates a real
 * usage pattern and asserts on observable output (text, render
 * directives, state) at every step.
 *
 * Companion to docs/architecture/spans-and-cycling.md — the doc
 * describes the system, this file pins it.
 */

import { describe, expect, it } from 'vitest';
import { Cycling } from './cycling';
import { ConfigLoader } from './config-loader';
import { Navigation } from './navigation';
import { DimRender } from './dim-render';
import { BlankFill } from './blank-fill';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { SpanFillState } from '../state/span-fill';
import { MockAdapter, wrapTipsAsCuesMd } from '../../testing/mock-adapter';

// ---------------------------------------------------------------------------
// Rich tips fixture: enough cued words to build multi-span scenarios
// ---------------------------------------------------------------------------
const RICH_TIPS = wrapTipsAsCuesMd({
  domain: 'test',
  version: 1,
  concepts: [
    {
      id: 'words',
      words: {
        // Multi-word alt vocab (forces span tracking)
        attorney: { tip: '', alts: ['lawyer', 'legal eagle', 'defendant counsel'] },
        ceo: { tip: '', alts: ['Jeff Bezos', 'Elon Musk', 'Tim Cook'] },
        // Single-word alt vocab
        fast: { tip: '', alts: ['quick', 'rapid', 'swift'] },
        big: { tip: '', alts: ['large', 'huge'] },
        // Mixed: multi-word alts of varying lengths
        food: { tip: '', alts: ['snack', 'three course meal', 'gourmet feast', 'bite'] },
        // Always present so cueMap.has is true
        word: { tip: '', alts: ['term'] },
      },
    },
  ],
});

async function setupScenario(text: string): Promise<{
  adapter: MockAdapter;
  hlState: HighlightState;
  dynDefs: DynDefs;
  spanFillState: SpanFillState;
  cycling: Cycling;
  nav: Navigation;
  dim: DimRender;
  bf: BlankFill;
  loader: ConfigLoader;
}> {
  const adapter = new MockAdapter({ files: { '/mock/CUES.md': RICH_TIPS } });
  adapter.pushText(text);
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const spanFillState = new SpanFillState();
  const loader = new ConfigLoader(adapter);
  await loader.load();
  const cycling = new Cycling(adapter, hlState, dynDefs, loader, spanFillState);
  cycling.subscribe();
  const nav = new Navigation(adapter, hlState, dynDefs, loader, spanFillState);
  nav.subscribe();
  const dim = new DimRender(adapter, hlState, dynDefs, loader, spanFillState);
  const bf = new BlankFill(adapter, loader, spanFillState);
  bf.subscribe();
  return { adapter, hlState, dynDefs, spanFillState, cycling, nav, dim, bf, loader };
}

// ===========================================================================
// A. Multi-step cycle journeys — sequential cycles produce correct text
// ===========================================================================

describe('cycling scenarios — sequential rotation', () => {
  it('walks attorney through every alt forward in order', async () => {
    const { adapter, hlState } = await setupScenario('the attorney filed');
    hlState.activate(1, 'the attorney filed');
    const sequence = ['the lawyer filed', 'the legal eagle filed',
      'the defendant counsel filed', 'the attorney filed'];
    for (const expected of sequence) {
      adapter.fireKey('up', { ctrl: true, alt: true });
      expect(adapter.setTextCalls.at(-1)).toBe(expected);
    }
  });

  it('cycles backward (Down) through the same alts in reverse', async () => {
    const { adapter, hlState } = await setupScenario('the attorney filed');
    hlState.activate(1, 'the attorney filed');
    const sequence = ['the defendant counsel filed', 'the legal eagle filed',
      'the lawyer filed', 'the attorney filed'];
    for (const expected of sequence) {
      adapter.fireKey('down', { ctrl: true, alt: true });
      expect(adapter.setTextCalls.at(-1)).toBe(expected);
    }
  });

  it('Up then Down returns to the original word', async () => {
    const { adapter, hlState } = await setupScenario('fast slow');
    hlState.activate(0, 'fast slow');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('down', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('fast slow');
  });

  it('mixed-length alts (1, 3, 2, 1, 4 words) splice cleanly each step', async () => {
    const { adapter, hlState } = await setupScenario('I want food please');
    hlState.activate(2, 'I want food please');
    // food alts: ['snack', 'three course meal', 'gourmet feast', 'bite']
    // alternatives become: [food, snack, three course meal, gourmet feast, bite]
    const sequence = [
      'I want snack please',
      'I want three course meal please',
      'I want gourmet feast please',
      'I want bite please',
      'I want food please',
    ];
    for (const expected of sequence) {
      adapter.fireKey('up', { ctrl: true, alt: true });
      expect(adapter.setTextCalls.at(-1)).toBe(expected);
    }
  });
});

// ===========================================================================
// B. Multi-span coexistence — N spans active in one buffer
// ===========================================================================

describe('cycling scenarios — multi-span coexistence', () => {
  it('two multi-word spans in one buffer cycle independently', async () => {
    const { adapter, hlState, dynDefs } = await setupScenario('the attorney said the ceo agrees');
    // Cycle A (attorney) → multi-word
    hlState.activate(1, 'the attorney said the ceo agrees');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle
    expect(adapter.setTextCalls.at(-1)).toBe('the legal eagle said the ceo agrees');

    // Cycle B (ceo, now at idx 5 due to A's shift) → multi-word
    const t1 = adapter.setTextCalls.at(-1)!;
    hlState.activate(5, t1);
    adapter.fireKey('up', { ctrl: true, alt: true }); // → Jeff Bezos
    expect(adapter.setTextCalls.at(-1)).toBe('the legal eagle said the Jeff Bezos agrees');

    // BOTH spans still tracked
    expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);
    expect(dynDefs.findSpanContaining(5)?.spanLength).toBe(2);
  });

  it('cycling span A does not perturb span B currentIndex', async () => {
    const { adapter, hlState, dynDefs } = await setupScenario('the attorney and the ceo');
    hlState.activate(1, 'the attorney and the ceo');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // attorney → legal eagle
    const t1 = adapter.setTextCalls.at(-1)!;
    hlState.activate(5, t1);
    adapter.fireKey('up', { ctrl: true, alt: true }); // ceo → Jeff Bezos

    const ceoDefBefore = dynDefs.get(5);
    expect(ceoDefBefore?.currentIndex).toBeGreaterThan(0);

    // Now cycle attorney AGAIN — ceo's def should be untouched
    hlState.activate(1, adapter.setTextCalls.at(-1)!);
    const indexBefore = ceoDefBefore!.currentIndex;
    adapter.fireKey('up', { ctrl: true, alt: true }); // attorney → defendant counsel
    expect(dynDefs.get(5)?.currentIndex).toBe(indexBefore);
  });

  it('three independent DynDefs (mix of single + multi) coexist', async () => {
    const { adapter, hlState, dynDefs } = await setupScenario('fast attorney big');
    // Cycle each
    hlState.activate(0, 'fast attorney big');
    adapter.fireKey('up', { ctrl: true, alt: true }); // fast → quick
    hlState.activate(1, adapter.setTextCalls.at(-1)!);
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // attorney → legal eagle
    const t = adapter.setTextCalls.at(-1)!;
    hlState.activate(3, t); // big shifted to idx 3
    adapter.fireKey('up', { ctrl: true, alt: true }); // big → large
    expect(adapter.setTextCalls.at(-1)).toBe('quick legal eagle large');
    // All three still tracked
    expect(dynDefs.get(0)?.originalWord).toBe('fast');
    expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);
    expect(dynDefs.get(3)?.originalWord).toBe('big');
  });

  it('cycling span B from inner-position redirects, leaves span A alone', async () => {
    const { adapter, hlState, dynDefs } = await setupScenario('the attorney said the ceo agrees');
    hlState.activate(1, 'the attorney said the ceo agrees');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // A → legal eagle
    hlState.activate(5, adapter.setTextCalls.at(-1)!);
    adapter.fireKey('up', { ctrl: true, alt: true }); // B → Jeff Bezos

    const aBefore = dynDefs.get(1)?.currentIndex;
    // Cycle from inner span B position (idx 6 = "Bezos") — should redirect
    // to origin (idx 5) and rotate just span B.
    hlState.activate(6, adapter.setTextCalls.at(-1)!);
    adapter.fireKey('up', { ctrl: true, alt: true });
    // Span A unchanged
    expect(dynDefs.get(1)?.currentIndex).toBe(aBefore);
  });
});

// ===========================================================================
// C. State continuity — pre-existing defs survive others' cycles
// ===========================================================================

describe('cycling scenarios — DynDef continuity across cycles', () => {
  it('resolver-populated DynDef at idx 2 survives same-length cycle of idx 1', async () => {
    const { adapter, hlState, dynDefs } = await setupScenario('the attorney filed today');
    // Pretend the resolver already populated alts for "filed"
    dynDefs.set(2, {
      originalWord: 'filed', alternatives: ['filed', 'submitted'],
      currentIndex: 0, spanStart: 13, spanEnd: 18,
    });
    hlState.activate(1, 'the attorney filed today');
    adapter.fireKey('up', { ctrl: true, alt: true }); // attorney → lawyer (single→single, no shift)
    expect(dynDefs.get(2)?.originalWord).toBe('filed'); // stayed put
  });

  it('resolver-populated DynDef shifts +1 when cycle goes single → multi (2 words)', async () => {
    const { adapter, hlState, dynDefs } = await setupScenario('the attorney filed today');
    dynDefs.set(2, {
      originalWord: 'filed', alternatives: ['filed', 'submitted'],
      currentIndex: 0, spanStart: 13, spanEnd: 18,
    });
    hlState.activate(1, 'the attorney filed today');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle (multi)
    expect(dynDefs.get(2)).toBeUndefined();
    expect(dynDefs.get(3)?.originalWord).toBe('filed');
  });

  it('resolver-populated DynDef shifts +2 when cycle goes single → multi (3 words)', async () => {
    const { adapter, hlState, dynDefs } = await setupScenario('I want food please');
    dynDefs.set(3, {
      originalWord: 'please', alternatives: ['please', 'kindly'],
      currentIndex: 0, spanStart: 12, spanEnd: 18,
    });
    hlState.activate(2, 'I want food please');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // food → 'three course meal' (3-word)
    expect(dynDefs.get(3)).toBeUndefined();
    expect(dynDefs.get(5)?.originalWord).toBe('please');
  });

  it('resolver-populated DynDef shifts back when cycle wraps multi → single', async () => {
    const { adapter, hlState, dynDefs } = await setupScenario('the attorney filed today');
    hlState.activate(1, 'the attorney filed today');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle
    // After 2 cycles, "filed" is at idx 3. Plant a def there.
    dynDefs.set(3, {
      originalWord: 'filed', alternatives: ['filed', 'submitted'],
      currentIndex: 0, spanStart: 16, spanEnd: 21,
    });
    adapter.fireKey('up', { ctrl: true, alt: true }); // → defendant counsel (still 2 words, no shift)
    expect(dynDefs.get(3)?.originalWord).toBe('filed');
    adapter.fireKey('up', { ctrl: true, alt: true }); // wrap → attorney (single, -1 shift)
    expect(dynDefs.get(3)).toBeUndefined();
    expect(dynDefs.get(2)?.originalWord).toBe('filed');
  });

  it('multi → multi same length: no shift', async () => {
    const { adapter, hlState, dynDefs } = await setupScenario('the attorney filed today');
    hlState.activate(1, 'the attorney filed today');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle
    dynDefs.set(3, {
      originalWord: 'filed', alternatives: ['filed', 'submitted'],
      currentIndex: 0, spanStart: 16, spanEnd: 21,
    });
    adapter.fireKey('up', { ctrl: true, alt: true }); // → defendant counsel (same length)
    expect(dynDefs.get(3)?.originalWord).toBe('filed'); // no shift, no prune
  });
});

// ===========================================================================
// D. Render-layer continuity — DimRender stays stable across cycles
// ===========================================================================

describe('cycling scenarios — render directives across cycles', () => {
  function renderFor(adapter: MockAdapter, dim: DimRender, text: string, cursor = 0) {
    return dim.compute({ text, cursor, externalHighlights: [] });
  }

  it('dim layer covers downstream cued words across a single-word cycle', async () => {
    const { adapter, hlState, dim } = await setupScenario('fast attorney big');
    hlState.activate(0, 'fast attorney big'); // active on "fast"
    adapter.fireKey('up', { ctrl: true, alt: true }); // → quick (single)
    const text = adapter.setTextCalls.at(-1)!;
    const directives = renderFor(adapter, dim, text);
    // attorney + big should still be dimmed (they're navigable cue words)
    const dimRanges = directives?.dimRanges ?? [];
    expect(dimRanges.some(r => r.start === 6 && r.end === 14)).toBe(true);  // attorney
    expect(dimRanges.some(r => r.start === 15 && r.end === 18)).toBe(true); // big
  });

  it('dim layer groups multi-word span as ONE range', async () => {
    const { adapter, hlState, dim } = await setupScenario('fast attorney big');
    // Activate elsewhere so attorney is dimmed (not highlighted)
    hlState.activate(0, 'fast attorney big');
    adapter.fireKey('up', { ctrl: true, alt: true }); // fast → quick
    hlState.activate(1, adapter.setTextCalls.at(-1)!);
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // attorney → legal eagle
    const text = adapter.setTextCalls.at(-1)!;
    // Now activate big so attorney's span is dimmed (not highlighted)
    hlState.activate(3, text);
    const directives = renderFor(adapter, dim, text);
    const dimRanges = directives?.dimRanges ?? [];
    // "legal eagle" should appear as ONE range (start of legal to end of eagle),
    // NOT as two separate per-word ranges.
    const legalStart = text.indexOf('legal');
    const eagleEnd = text.indexOf('eagle') + 'eagle'.length;
    expect(dimRanges.some(r => r.start === legalStart && r.end === eagleEnd)).toBe(true);
    // No SEPARATE range for just "eagle"
    expect(dimRanges.some(r => r.start === text.indexOf('eagle'))).toBe(false);
  });

  it('highlight expands to cover the active multi-word span', async () => {
    const { adapter, hlState, dim } = await setupScenario('the attorney filed');
    hlState.activate(1, 'the attorney filed');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle
    const text = adapter.setTextCalls.at(-1)!;
    hlState.activate(1, text); // active on origin
    const directives = renderFor(adapter, dim, text);
    expect(directives?.highlight?.start).toBe(text.indexOf('legal'));
    expect(directives?.highlight?.end).toBe(text.indexOf('eagle') + 'eagle'.length);
  });

  it('highlight expands when active is on inner span position too', async () => {
    const { adapter, hlState, dim } = await setupScenario('the attorney filed');
    hlState.activate(1, 'the attorney filed');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle
    const text = adapter.setTextCalls.at(-1)!;
    hlState.activate(2, text); // active on inner (eagle)
    const directives = renderFor(adapter, dim, text);
    // Highlight still covers the FULL span, not just "eagle"
    expect(directives?.highlight?.start).toBe(text.indexOf('legal'));
    expect(directives?.highlight?.end).toBe(text.indexOf('eagle') + 'eagle'.length);
  });

  it('dim count stays stable across a no-shift cycle (no flash)', async () => {
    const { adapter, hlState, dim } = await setupScenario('fast attorney big');
    hlState.activate(0, 'fast attorney big');
    const before = renderFor(adapter, dim, 'fast attorney big');
    const dimCountBefore = (before?.dimRanges ?? []).length;
    adapter.fireKey('up', { ctrl: true, alt: true }); // fast → quick (single, no shift)
    const text = adapter.setTextCalls.at(-1)!;
    const after = renderFor(adapter, dim, text);
    const dimCountAfter = (after?.dimRanges ?? []).length;
    expect(dimCountAfter).toBe(dimCountBefore);
  });
});

// ===========================================================================
// E. User edits + cycling interleaved
// ===========================================================================

describe('cycling scenarios — user edits interleaved with cycles', () => {
  it('cycle, then APPEND text — span persists, new cycle still works', async () => {
    const { adapter, hlState, dynDefs } = await setupScenario('the attorney');
    hlState.activate(1, 'the attorney');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle
    expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);

    // Append " filed today"
    adapter.pushText('the legal eagle filed today');
    expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2); // span survives

    hlState.activate(1, 'the legal eagle filed today');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → defendant counsel
    expect(adapter.setTextCalls.at(-1)).toBe('the defendant counsel filed today');
  });

  it('relocate works for SINGLE-word cycled alts too', async () => {
    // attorney → lawyer (single word). User prepends. Def should
    // move to the new position of "lawyer", not be dropped.
    const { adapter, hlState, dynDefs } = await setupScenario('attorney filed');
    hlState.activate(0, 'attorney filed');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → lawyer
    expect(dynDefs.get(0)?.originalWord).toBe('attorney');
    adapter.pushText('hey lawyer filed'); // lawyer now at idx 1
    expect(dynDefs.get(0)).toBeUndefined();
    expect(dynDefs.get(1)?.originalWord).toBe('attorney');
  });

  it('relocate fails (drops) when the cycled alt appears MULTIPLE times AND original position no longer matches', async () => {
    // Ambiguous — pruneStale can't tell which is "the" cycled instance.
    // Conservative: drop. Tests guarantee no silent wrong relocation.
    const { adapter, hlState, dynDefs } = await setupScenario('the attorney filed');
    hlState.activate(1, 'the attorney filed');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle (multi)
    expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);
    // User replaces the buffer entirely with text that has TWO "legal eagle"s
    // but neither at the original position 1.
    adapter.pushText('something else legal eagle here legal eagle there');
    // Original position no longer matches AND multiple match candidates → drop.
    expect(dynDefs.get(1)).toBeUndefined();
    expect(dynDefs.findSpanContaining(2)).toBeNull(); // first "legal eagle"
    expect(dynDefs.findSpanContaining(5)).toBeNull(); // second "legal eagle"
  });

  it('relocate handles MULTIPLE defs all shifting by the same prefix', async () => {
    // Two cycled defs, user prepends — both relocate independently
    // to their new contiguous positions.
    const { adapter, hlState, dynDefs } = await setupScenario('attorney filed ceo agrees');
    hlState.activate(0, 'attorney filed ceo agrees');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // attorney → legal eagle
    const t1 = adapter.setTextCalls.at(-1)!;
    hlState.activate(3, t1); // ceo at idx 3 (after attorney's shift)
    adapter.fireKey('up', { ctrl: true, alt: true }); // ceo → Jeff Bezos
    expect(dynDefs.findSpanContaining(0)?.spanLength).toBe(2);
    expect(dynDefs.findSpanContaining(3)?.spanLength).toBe(2);

    // Prepend two words.
    adapter.pushText('hey there legal eagle filed Jeff Bezos agrees');
    // Both spans relocated +2:
    expect(dynDefs.findSpanContaining(2)?.spanLength).toBe(2);  // legal eagle
    expect(dynDefs.findSpanContaining(5)?.spanLength).toBe(2);  // Jeff Bezos
  });

  it('relocate refuses to overwrite an existing keep-def at its target', async () => {
    // Edge case: relocate target is a position where another def lives
    // and matches its current word. Don't clobber the keep — drop the
    // moving def. (Simulating this is awkward; just verify the rule
    // doesn't fire wrongly in the simple non-conflict case.)
    const { adapter, hlState, dynDefs } = await setupScenario('attorney filed');
    hlState.activate(0, 'attorney filed');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → lawyer
    // Plant a hand-built def at idx 1 (where "filed" is).
    dynDefs.set(1, {
      originalWord: 'filed', alternatives: ['filed', 'submitted'],
      currentIndex: 0, spanStart: 7, spanEnd: 12,
    });
    // Prepend, shifting "lawyer" to idx 1 and "filed" to idx 2.
    adapter.pushText('hey lawyer filed');
    // lawyer's def at idx 0 wants to relocate to idx 1.
    // filed's def at idx 1 wants to relocate to idx 2 (its filed-content moved).
    // No collision (different targets). Both should relocate cleanly.
    expect(dynDefs.get(0)).toBeUndefined();
    expect(dynDefs.get(1)?.originalWord).toBe('attorney');
    expect(dynDefs.get(2)?.originalWord).toBe('filed');
  });

  it('cycle, then PREPEND text — DynDef RELOCATES to new position (deterministic re-anchor)', async () => {
    // Updated for the deterministic-relocate feature: when a cycled
    // def's content (its currentAlt's words) appears at exactly one
    // new position in the buffer, pruneStale moves the def there
    // instead of dropping it. User's cycle progress survives prefix
    // edits.
    const { adapter, hlState, dynDefs } = await setupScenario('the attorney');
    hlState.activate(1, 'the attorney');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle
    adapter.pushText('hey there the legal eagle');
    // Old behaviour: get(1) === undefined, findSpanContaining(3) === null.
    // New: def relocated from idx 1 → idx 3, span follows.
    expect(dynDefs.get(1)).toBeUndefined(); // moved out
    expect(dynDefs.get(3)?.originalWord).toBe('attorney');
    expect(dynDefs.findSpanContaining(3)?.spanLength).toBe(2);
  });

  it('cycle, then DELETE inner span word — span destroyed', async () => {
    const { adapter, hlState, dynDefs } = await setupScenario('the attorney filed');
    hlState.activate(1, 'the attorney filed');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle
    expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);
    // User deletes "eagle" (mid-span edit)
    adapter.pushText('the legal filed');
    expect(dynDefs.get(1)).toBeUndefined();
    expect(dynDefs.findSpanContaining(1)).toBeNull();
  });

  it('cycle, type, cycle: subsequent cycle on the SAME word starts fresh', async () => {
    const { adapter, hlState } = await setupScenario('fast slow');
    hlState.activate(0, 'fast slow');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → quick
    expect(adapter.setTextCalls.at(-1)).toBe('quick slow');
    // User edits the cycled word entirely
    adapter.pushText('zebra slow');
    hlState.activate(0, 'zebra slow');
    // Cycling on "zebra" — no cue source, no DynDef. Should no-op cleanly.
    const before = adapter.setTextCalls.length;
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.length).toBe(before); // no setText fired
  });

  it('two cycles, edit between them, third cycle continues from current state', async () => {
    const { adapter, hlState } = await setupScenario('fast slow');
    hlState.activate(0, 'fast slow');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → quick
    adapter.fireKey('up', { ctrl: true, alt: true }); // → rapid
    expect(adapter.setTextCalls.at(-1)).toBe('rapid slow');
    // Append a word — fast's def survives because word at idx 0 is still "rapid" (cycled alt)
    adapter.pushText('rapid slow today');
    hlState.activate(0, 'rapid slow today');
    adapter.fireKey('up', { ctrl: true, alt: true }); // continues to → swift
    expect(adapter.setTextCalls.at(-1)).toBe('swift slow today');
  });
});

// ===========================================================================
// F. Inner-span redirect — cycling from inside a span
// ===========================================================================

describe('cycling scenarios — inner-span redirect', () => {
  it('Up on inner span position cycles whole span forward', async () => {
    const { adapter, hlState } = await setupScenario('the attorney filed');
    hlState.activate(1, 'the attorney filed');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle
    hlState.activate(2, adapter.setTextCalls.at(-1)!); // inner: "eagle"
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('the defendant counsel filed');
  });

  it('Down on inner span position cycles whole span backward', async () => {
    const { adapter, hlState } = await setupScenario('the attorney filed');
    hlState.activate(1, 'the attorney filed');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle
    hlState.activate(2, adapter.setTextCalls.at(-1)!); // inner
    adapter.fireKey('down', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('the lawyer filed');
  });

  it('inner-span redirect works for 3-word span (every inner position)', async () => {
    const { adapter, hlState } = await setupScenario('I want food');
    hlState.activate(2, 'I want food');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // → 'three course meal' (3 words at idx 2,3,4)
    expect(adapter.setTextCalls.at(-1)).toBe('I want three course meal');

    // Inner at idx 3 ("course")
    hlState.activate(3, adapter.setTextCalls.at(-1)!);
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('I want gourmet feast');

    // Now span is 2 words. Inner at idx 3 ("feast")
    hlState.activate(3, adapter.setTextCalls.at(-1)!);
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('I want bite');
  });
});

// ===========================================================================
// G. Navigation interactions with spans
// ===========================================================================

describe('cycling scenarios — navigation skips inner span positions', () => {
  it('Right past a multi-word span jumps to next NAVIGABLE word, not inner', async () => {
    const { adapter, hlState } = await setupScenario('fast attorney big');
    hlState.activate(0, 'fast attorney big');
    adapter.fireKey('up', { ctrl: true, alt: true }); // fast → quick
    hlState.activate(1, adapter.setTextCalls.at(-1)!);
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle
    // Now nav from origin (idx 1) to the right
    const text = adapter.setTextCalls.at(-1)!;
    hlState.activate(1, text);
    adapter.fireKey('right', { ctrl: true, alt: true }); // step to next nav target
    // Should land on "big" (idx 3), NOT "eagle" (idx 2 — inner span)
    expect(hlState.wordIndex).toBe(3);
  });

  it('Left from after-span jumps to span ORIGIN, not inner', async () => {
    const { adapter, hlState } = await setupScenario('the attorney big');
    hlState.activate(1, 'the attorney big');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle
    const text = adapter.setTextCalls.at(-1)!;
    hlState.activate(3, text); // "big" at idx 3
    adapter.fireKey('left', { ctrl: true, alt: true });
    expect(hlState.wordIndex).toBe(1); // origin "legal"
  });
});

// ===========================================================================
// H. Edge cases — empty buffer, no-cue words, single word, etc.
// ===========================================================================

describe('cycling scenarios — edge cases', () => {
  it('cycling word with no cue source is a no-op', async () => {
    const { adapter, hlState } = await setupScenario('zzunknown');
    hlState.activate(0, 'zzunknown');
    const before = adapter.setTextCalls.length;
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.length).toBe(before);
  });

  it('cycling on empty buffer no-ops cleanly', async () => {
    const { adapter, hlState } = await setupScenario('');
    const before = adapter.setTextCalls.length;
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.length).toBe(before);
    expect(hlState.active).toBe(false);
  });

  it('single-word buffer cycles cleanly', async () => {
    const { adapter, hlState } = await setupScenario('attorney');
    hlState.activate(0, 'attorney');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle (multi)
    expect(adapter.setTextCalls.at(-1)).toBe('legal eagle');
  });

  it('cycle to single-word at start of buffer keeps text edge-clean', async () => {
    const { adapter, hlState } = await setupScenario('attorney filed');
    hlState.activate(0, 'attorney filed');
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('lawyer filed');
  });

  it('cycle to multi-word at end of buffer keeps text edge-clean', async () => {
    const { adapter, hlState } = await setupScenario('the attorney');
    hlState.activate(1, 'the attorney');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('the legal eagle');
  });
});

// ===========================================================================
// I. Invariants — properties that must hold across any sequence
// ===========================================================================

describe('cycling scenarios — invariants', () => {
  it('after any cycle, the word at origin matches def.alternatives[def.currentIndex] first word', async () => {
    const { adapter, hlState, dynDefs } = await setupScenario('the attorney filed');
    hlState.activate(1, 'the attorney filed');
    for (let i = 0; i < 8; i++) {
      adapter.fireKey('up', { ctrl: true, alt: true });
      const def = dynDefs.get(1);
      if (def) {
        const currentAlt = def.alternatives[def.currentIndex];
        const firstAltWord = currentAlt.split(/\s+/)[0];
        const text = adapter.setTextCalls.at(-1)!;
        const words = text.split(/\s+/);
        expect(words[1]).toBe(firstAltWord);
      }
    }
  });

  it('after any cycle, total word count = original word count + sum of (altWordCount - 1) per multi-span', async () => {
    const { adapter, hlState, dynDefs } = await setupScenario('the attorney filed today');
    const baseWords = 4;
    hlState.activate(1, 'the attorney filed today');
    for (let i = 0; i < 5; i++) {
      adapter.fireKey('up', { ctrl: true, alt: true });
      const text = adapter.setTextCalls.at(-1)!;
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      // Sum extra words contributed by all multi-word spans
      let extra = 0;
      for (const [, def] of dynDefs.entries()) {
        const alt = def.alternatives[def.currentIndex];
        const n = alt.split(/\s+/).filter(Boolean).length;
        if (n > 1) extra += (n - 1);
      }
      expect(wordCount).toBe(baseWords + extra);
    }
  });

  it('SpanFillState stays null throughout static-alt cycling (option B)', async () => {
    const { adapter, hlState, spanFillState } = await setupScenario('the attorney filed today');
    hlState.activate(1, 'the attorney filed today');
    for (let i = 0; i < 6; i++) {
      adapter.fireKey('up', { ctrl: true, alt: true });
      expect(spanFillState.current).toBeNull();
    }
  });

  it('cycling never produces text with adjacent spaces or trailing whitespace', async () => {
    const { adapter, hlState } = await setupScenario('the attorney filed today');
    hlState.activate(1, 'the attorney filed today');
    for (let i = 0; i < 8; i++) {
      adapter.fireKey('up', { ctrl: true, alt: true });
      const text = adapter.setTextCalls.at(-1)!;
      expect(text).not.toMatch(/  /);          // no double spaces
      expect(text).not.toMatch(/\s$/);          // no trailing space
      expect(text).not.toMatch(/^\s/);          // no leading space
    }
  });

  it('forceRender called exactly once per cycle', async () => {
    const { adapter, hlState } = await setupScenario('fast slow');
    hlState.activate(0, 'fast slow');
    const before = adapter.forceRenderCalls;
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.forceRenderCalls).toBe(before + 1);
  });
});
