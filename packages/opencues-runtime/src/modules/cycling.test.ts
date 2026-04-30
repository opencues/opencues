import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Cycling } from './cycling';
import { ConfigLoader } from './config-loader';
import { Navigation } from './navigation';
import { BlankFill } from './blank-fill';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { SpanFillState } from '../state/span-fill';
import { DismissedBlanks } from '../state/dismissed-blanks';
import { SelectorSatelliteState } from '../state/selector-satellite';
import { MockAdapter } from '../../testing/mock-adapter';

// Tips live inside cues.md's `## Tips` JSON block — no separate file.
// Wrap a tips-data object as a minimal cues.md so ConfigLoader's
// existing parser flow (parseCuesMd → cuesConfig.tips → cueMap) loads
// it just like a real config.
function wrapTipsAsCuesMd(tipsData: unknown): string {
  return `# tips fixture\n\n## Tips\n\`\`\`json\n${JSON.stringify(tipsData)}\n\`\`\`\n`;
}

const TIPS = wrapTipsAsCuesMd({
  domain: 'test',
  version: 1,
  concepts: [
    {
      id: 'words',
      words: {
        fast: { tip: '', alts: ['quick', 'rapid', 'swift'] },
        big: { tip: '', alts: ['large', 'huge'] },
      },
    },
  ],
});

async function setup(text: string) {
  const adapter = new MockAdapter({ files: { '/mock/cues.md': TIPS } });
  adapter.pushText(text);
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const loader = new ConfigLoader(adapter);
  await loader.load();
  const cycling = new Cycling(adapter, hlState, dynDefs, loader);
  cycling.subscribe();
  const nav = new Navigation(adapter, hlState, dynDefs);
  nav.subscribe();
  return { adapter, hlState, dynDefs, loader, cycling, nav };
}

describe('Cycling', () => {
  it('does nothing when highlight inactive', async () => {
    const { adapter } = await setup('fast slow');
    expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(false);
    expect(adapter.setTextCalls).toEqual([]);
  });

  it('Ctrl+Alt+Up replaces highlighted word with first alternative', async () => {
    const { adapter, hlState, dynDefs } = await setup('fast slow');
    hlState.activate(0, 'fast slow'); // fast
    expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(true);
    expect(adapter.setTextCalls.at(-1)).toBe('quick slow');
    const def = dynDefs.get(0);
    expect(def?.currentIndex).toBe(1); // alt 0 is original "fast", alt 1 is first cycle
    expect(def?.spanEnd).toBe(5); // "quick" is 5 chars
  });

  it('successive Up cycles through all alternatives and wraps', async () => {
    const { adapter, hlState } = await setup('fast');
    hlState.activate(0, 'fast');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → quick
    adapter.fireKey('up', { ctrl: true, alt: true }); // → rapid
    adapter.fireKey('up', { ctrl: true, alt: true }); // → swift
    adapter.fireKey('up', { ctrl: true, alt: true }); // → fast (wrap)
    expect(adapter.setTextCalls).toEqual(['quick', 'rapid', 'swift', 'fast']);
  });

  it('Ctrl+Alt+Down goes the other direction', async () => {
    const { adapter, hlState } = await setup('fast');
    hlState.activate(0, 'fast');
    adapter.fireKey('down', { ctrl: true, alt: true }); // → swift (last)
    expect(adapter.setTextCalls.at(-1)).toBe('swift');
  });

  it('returns false when word has no alternatives in cue map', async () => {
    const { adapter, hlState } = await setup('xyz unknown');
    hlState.activate(0, 'xyz unknown');
    expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(false);
  });

  it('cursor adjustment: cursor before word stays put', async () => {
    const { adapter, hlState } = await setup('fast slow');
    adapter.setCursorOffset(0);
    hlState.activate(0, 'fast slow');
    adapter.fireKey('up', { ctrl: true, alt: true }); // fast → quick (+1 char)
    expect(adapter.setCursorCalls.at(-1)).toBe(0); // cursor at 0 unchanged
  });

  it('cursor adjustment: cursor after word shifts by lenDiff', async () => {
    const { adapter, hlState } = await setup('fast slow');
    adapter.setCursorOffset(8); // after "fast slow"[start of slow + 'slo'] - past 'fast'
    hlState.activate(0, 'fast slow');
    adapter.fireKey('up', { ctrl: true, alt: true }); // fast (4) → quick (5), +1
    expect(adapter.setCursorCalls.at(-1)).toBe(9);
  });

  it('forceRender called after cycle', async () => {
    const { adapter, hlState } = await setup('fast');
    hlState.activate(0, 'fast');
    expect(adapter.forceRenderCalls).toBe(0);
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.forceRenderCalls).toBe(1);
  });

  it('Navigation + Cycling: Ctrl+Alt+Left then Up cycles the active word', async () => {
    const { adapter, hlState } = await setup('big fast');
    adapter.fireKey('left', { ctrl: true, alt: true }); // activate rightmost: fast (idx 1)
    expect(hlState.wordIndex).toBe(1);
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('big quick');
  });
});

describe('Cycling static-alt multi-word spans', () => {
  // Cue source returns an alt that contains a space (LLM legitimately
  // suggests "legal eagle" for "attorney", "Jeff Bezos" for "ceo", etc).
  // The runtime needs to register this as a span in SpanFillState so:
  //   - Navigation treats the N words as ONE stop (left/right skip inner)
  //   - DimRender highlights the whole group as a unit
  //   - Subsequent cycles go through cycleSpanFill (Path 0), keeping
  //     currentAltIndex + spanLength in sync
  const MW_TIPS = wrapTipsAsCuesMd({
    domain: 'test',
    version: 1,
    concepts: [
      {
        id: 'words',
        words: {
          attorney: { tip: '', alts: ['lawyer', 'legal eagle', 'defendant counsel'] },
          ceo: { tip: '', alts: ['Jeff Bezos', 'Elon Musk', 'Tim Cook'] },
        },
      },
    ],
  });

  async function setupMw(text: string) {
    const adapter = new MockAdapter({ files: { '/mock/cues.md': MW_TIPS } });
    adapter.pushText(text);
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const spanFillState = new SpanFillState();
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, spanFillState);
    cycling.subscribe();
    const nav = new Navigation(adapter, hlState, dynDefs, spanFillState);
    nav.subscribe();
    // BlankFill's onTextChange is where SpanFillState preservation runs.
    // Wire it up so typing-past-the-span tests exercise the real path.
    const bf = new BlankFill(adapter, loader, spanFillState);
    bf.subscribe();
    return { adapter, hlState, dynDefs, spanFillState, cycling, nav, bf };
  }

  it('cycling to a multi-word alt creates an implicit span via DynDefs', async () => {
    // After Apr 2026 (option B refactor) static-alt spans are tracked
    // implicitly by DynDefs — a span exists wherever a DynDef's
    // currentAlt has multiple words. SpanFillState stays untouched
    // (it's reserved for blank-fills, single-slot).
    const { adapter, hlState, dynDefs, spanFillState } = await setupMw('the attorney');
    hlState.activate(1, 'the attorney');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → lawyer (single)
    expect(dynDefs.findSpanContaining(1)).toBeNull();
    adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle (multi)
    const span = dynDefs.findSpanContaining(1);
    expect(span).not.toBeNull();
    expect(span!.originIdx).toBe(1);
    expect(span!.spanLength).toBe(2);
    expect(adapter.setTextCalls.at(-1)).toBe('the legal eagle');
    expect(spanFillState.current).toBeNull(); // SpanFillState left alone
  });

  it('cycling multi-word → multi-word keeps the span (DynDef updates)', async () => {
    const { adapter, hlState, dynDefs } = await setupMw('the attorney');
    hlState.activate(1, 'the attorney');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle
    expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);
    adapter.fireKey('up', { ctrl: true, alt: true }); // → defendant counsel
    expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);
    expect(adapter.setTextCalls.at(-1)).toBe('the defendant counsel');
  });

  it('cycling multi-word → single-word collapses the span', async () => {
    const { adapter, hlState, dynDefs } = await setupMw('the attorney');
    hlState.activate(1, 'the attorney');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);
    adapter.fireKey('up', { ctrl: true, alt: true }); // wraps to original (single)
    expect(adapter.setTextCalls.at(-1)).toBe('the attorney');
    expect(dynDefs.findSpanContaining(1)).toBeNull();
  });

  it('Ctrl+Alt+Up from inner span word redirects to origin and cycles whole span', async () => {
    const { adapter, hlState, dynDefs } = await setupMw('the ceo said');
    hlState.activate(1, 'the ceo said');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → Jeff Bezos (multi)
    expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);
    expect(adapter.setTextCalls.at(-1)).toBe('the Jeff Bezos said');

    const before = adapter.setTextCalls.length;
    const currentText = adapter.setTextCalls.at(-1)!;
    hlState.activate(2, currentText); // inner span word (Bezos)
    adapter.fireKey('up', { ctrl: true, alt: true }); // forward → next multi-word alt
    expect(adapter.setTextCalls.length).toBeGreaterThan(before);
    // Span persists — cycled from inner position to next multi-word alt.
    expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);
  });

  it('TWO concurrent multi-word spans coexist via DynDefs', async () => {
    // The bug option B exists to fix: SpanFillState held one slot,
    // so registering span B clobbered span A. With DynDefs as the
    // source, both spans live independently. Each span's origin DynDef
    // tracks its own alts + currentIndex.
    const { adapter, hlState, dynDefs } = await setupMw('the attorney said the ceo agrees');
    hlState.activate(1, 'the attorney said the ceo agrees');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // attorney → legal eagle
    expect(adapter.setTextCalls.at(-1)).toBe('the legal eagle said the ceo agrees');
    const spanA = dynDefs.findSpanContaining(1);
    expect(spanA?.spanLength).toBe(2);

    // After the cycle, "ceo" shifted from idx 4 to idx 5.
    const newText = adapter.setTextCalls.at(-1)!;
    hlState.activate(5, newText); // ceo at idx 5
    adapter.fireKey('up', { ctrl: true, alt: true }); // → Jeff Bezos
    expect(adapter.setTextCalls.at(-1)).toBe('the legal eagle said the Jeff Bezos agrees');
    // BOTH spans still active — no clobber.
    expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);
    expect(dynDefs.findSpanContaining(5)?.spanLength).toBe(2);
  });

  it('cycling single → multi-word SHIFTS downstream DynDefs (no dim flicker)', async () => {
    // Regression: "dimmed words beyond the span lose their dimness"
    // after a multi-word cycle. Cause: DynDefs at idx > origin used
    // to be PRUNED when their originalWord no longer matched the
    // word at their old index — but that word had just shifted by
    // `delta`. Now we shift the def to its new index FIRST, then
    // prune anything still mismatched. Resolved-but-unrelated words
    // keep their dim across the cycle without waiting for the
    // resolver's debounce.
    const { adapter, hlState, dynDefs } = await setupMw('the attorney filed today');
    dynDefs.set(2, {
      originalWord: 'filed',
      alternatives: ['filed', 'submitted', 'lodged'],
      currentIndex: 0,
      spanStart: 13, spanEnd: 18,
    });
    hlState.activate(1, 'the attorney filed today');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → lawyer (single, no shift)
    expect(dynDefs.get(2)?.originalWord).toBe('filed');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle (multi, +1 shift)
    // "filed" moved from idx 2 to idx 3. DynDef follows.
    expect(dynDefs.get(2)).toBeUndefined();
    expect(dynDefs.get(3)?.originalWord).toBe('filed');
  });

  it('cycling multi-word → single-word SHIFTS downstream DynDefs back', async () => {
    const { adapter, hlState, dynDefs } = await setupMw('the attorney filed today');
    hlState.activate(1, 'the attorney filed today');
    // Cycle attorney → lawyer → legal eagle so we're in multi-word state.
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true });
    // "filed" is now at idx 3 in "the legal eagle filed today".
    dynDefs.set(3, {
      originalWord: 'filed',
      alternatives: ['filed', 'submitted', 'lodged'],
      currentIndex: 0,
      spanStart: 16, spanEnd: 21,
    });
    // Cycle multi → multi (no shift), then back to single.
    adapter.fireKey('up', { ctrl: true, alt: true }); // → defendant counsel
    expect(dynDefs.get(3)?.originalWord).toBe('filed');
    adapter.fireKey('up', { ctrl: true, alt: true }); // wrap to attorney (single, -1 shift)
    expect(dynDefs.get(3)).toBeUndefined();
    expect(dynDefs.get(2)?.originalWord).toBe('filed'); // shifted left
  });

  it('swapping between multi-word alts splices at the correct char range', async () => {
    // Regression test for "SERIOUS bugs when we adjust spans …
    // positing words incorrectly when swapping out multiple word spans".
    // Root cause: applyAltCycle used to trust def.spanStart/spanEnd
    // which drifted across multi-word cycles. Now char range is
    // computed fresh from live word positions every cycle.
    const { adapter, hlState } = await setupMw('the attorney filed');
    hlState.activate(1, 'the attorney filed');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → lawyer
    expect(adapter.setTextCalls.at(-1)).toBe('the lawyer filed');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle (multi)
    expect(adapter.setTextCalls.at(-1)).toBe('the legal eagle filed');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → defendant counsel (multi)
    expect(adapter.setTextCalls.at(-1)).toBe('the defendant counsel filed');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → attorney (wrap, single)
    expect(adapter.setTextCalls.at(-1)).toBe('the attorney filed');
    // Cycle the whole rotation once more — same shape every step.
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('the lawyer filed');
  });

  it('cycle multi → multi → single → multi correctly shrinks/grows the range', async () => {
    const { adapter, hlState } = await setupMw('the ceo said');
    hlState.activate(1, 'the ceo said');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → Jeff Bezos
    expect(adapter.setTextCalls.at(-1)).toBe('the Jeff Bezos said');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → Elon Musk
    expect(adapter.setTextCalls.at(-1)).toBe('the Elon Musk said');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → Tim Cook
    expect(adapter.setTextCalls.at(-1)).toBe('the Tim Cook said');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → ceo (wrap, single)
    expect(adapter.setTextCalls.at(-1)).toBe('the ceo said');
  });

  it('typing OUTSIDE the span preserves the DynDef (span words still match)', async () => {
    // User cycles attorney → legal eagle, then appends ' today'.
    // Pruning checks the multi-word alt's words still appear at the
    // span's index — they do (idx 1 = "legal", idx 2 = "eagle"),
    // so the DynDef + its implicit span survive.
    const { adapter, hlState, dynDefs } = await setupMw('the attorney');
    hlState.activate(1, 'the attorney');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle
    expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);

    adapter.pushText('the legal eagle today');
    expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);
  });

  it('prepending text RELOCATES the def to its new contiguous position', async () => {
    // pruneStale runs deterministic relocate: when a stale def's
    // currentAlt's words still appear at exactly one new position,
    // the def MOVES instead of being dropped. User keeps their cycle
    // progress through prefix edits.
    const { adapter, hlState, dynDefs } = await setupMw('the attorney');
    hlState.activate(1, 'the attorney');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);

    adapter.pushText('hey there the legal eagle');
    // Def relocated from idx 1 → idx 3 (where "legal eagle" now lives).
    expect(dynDefs.get(1)).toBeUndefined();
    expect(dynDefs.get(3)?.originalWord).toBe('attorney');
    expect(dynDefs.findSpanContaining(3)?.spanLength).toBe(2);
  });

  it('destroying the span text drops the DynDef', async () => {
    const { adapter, hlState, dynDefs } = await setupMw('the attorney');
    hlState.activate(1, 'the attorney');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);

    adapter.pushText('the cat jumped');
    expect(dynDefs.get(1)).toBeUndefined();
    expect(dynDefs.findSpanContaining(1)).toBeNull();
  });
});

describe('Cycling consume-all (Step 31)', () => {
  async function setupCa(initialText: string) {
    const adapter = new MockAdapter({ files: { '/mock/cues.md': TIPS } });
    adapter.pushText(initialText);
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const consumeAll = new SpanFillState();
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, consumeAll);
    cycling.subscribe();
    return { adapter, hlState, consumeAll, cycling };
  }

  it('cycles forward through stashed alternatives', async () => {
    const { adapter, hlState, consumeAll } = await setupCa('Improved one');
    consumeAll.set({
      index: 0,
      alternatives: ['Improved one', 'Improved two version', 'Final three'],
      currentAltIndex: 0,
      spanLength: 2,
    }, 'Improved one');
    hlState.activate(0, 'Improved one');
    expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(true);
    expect(adapter.setTextCalls.at(-1)).toBe('Improved two version');
    expect(consumeAll.current?.currentAltIndex).toBe(1);
    expect(consumeAll.current?.spanLength).toBe(3);
  });

  it('cycles backward (Ctrl+Alt+Down)', async () => {
    const { adapter, hlState, consumeAll } = await setupCa('Improved one');
    consumeAll.set({
      index: 0,
      alternatives: ['Improved one', 'Improved two version', 'Final three'],
      currentAltIndex: 0,
      spanLength: 2,
    }, 'Improved one');
    hlState.activate(0, 'Improved one');
    expect(adapter.fireKey('down', { ctrl: true, alt: true })).toBe(true);
    // Wraps from 0 down to 2 (last alt)
    expect(adapter.setTextCalls.at(-1)).toBe('Final three');
    expect(consumeAll.current?.currentAltIndex).toBe(2);
  });

  it('only cycles when highlight is within the consumed span', async () => {
    const { adapter, hlState, consumeAll } = await setupCa('Improved one outside word');
    consumeAll.set({
      index: 0,
      alternatives: ['Improved one', 'Other version'],
      currentAltIndex: 0,
      spanLength: 2,
    }, 'Improved one outside word');
    // Word index 3 ("word") is outside the span [0, 2)
    hlState.activate(3, 'Improved one outside word');
    expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(false);
    expect(adapter.setTextCalls).toEqual([]);
  });

  it('updates lastFilledText so post-cycle text changes do not invalidate', async () => {
    const { adapter, hlState, consumeAll } = await setupCa('Improved one');
    consumeAll.set({
      index: 0,
      alternatives: ['Improved one', 'Other version'],
      currentAltIndex: 0,
      spanLength: 2,
    }, 'Improved one');
    hlState.activate(0, 'Improved one');
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(consumeAll.lastFilledText).toBe('Other version');
    expect(consumeAll.current).not.toBeNull();
  });

  it('Phase F.b: cycling to `_` adds slot to DismissedBlanks; cycling away removes it', async () => {
    const adapter = new MockAdapter({ files: { '/mock/cues.md': TIPS } });
    adapter.pushText('foo');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const span = new SpanFillState();
    const dismissed = new DismissedBlanks();
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, span, dismissed);
    cycling.subscribe();
    span.set({
      index: 0,
      alternatives: ['foo', 'bar', '_'],
      currentAltIndex: 0,
      spanLength: 1,
    }, 'foo');
    hlState.activate(0, 'foo');
    // Cycle 0→1: foo → bar (not `_`)
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(dismissed.has(0)).toBe(false);
    // Cycle 1→2: bar → `_`
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(dismissed.has(0)).toBe(true);
    // Cycle 2→0: `_` → foo
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(dismissed.has(0)).toBe(false);
  });

  it('Phase G.b: cycling selector rotates setting names + spawns get script', async () => {
    const OPENCUES_MD = `---
voice-mode: active
debug-mode: off
settings:
  voice-mode:
    tip: Gates TTS globally
    values:
      active: TTS reads tips aloud
      inactive: TTS silenced
  debug-mode:
    tip: Debug logging
    values:
      on: emit
      off: silent
---`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/cues.md': TIPS, '/proj/opencues.md': OPENCUES_MD },
    });
    adapter.pushText('voice-mode active');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const ss = new SelectorSatelliteState();
    ss.set({
      controlName: 'opencues',
      scriptPath: '/tmp/oc.sh',
      selectorIndex: 0,
      selectorLength: 1,
      satelliteIndex: 1,
      satelliteLength: 1,
      currentSetting: 'voice-mode',
      currentValue: 'active',
      separator: ' ',
      clearOnEdit: false,
    }, 'voice-mode active');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, undefined, undefined, ss);
    cycling.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: 'off\n', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    hlState.activate(0, 'voice-mode active'); // selector
    adapter.fireKey('up', { ctrl: true, alt: true });
    // Synchronous part: text now has the next setting name + first declared value.
    expect(adapter.setTextCalls.at(-1)).toBe('debug-mode on');
    expect(ss.current?.currentSetting).toBe('debug-mode');
    // Async script `get debug-mode` was spawned.
    expect(spawnSpy).toHaveBeenCalled();
    expect(spawnSpy.mock.calls[0][0].args).toEqual(['/tmp/oc.sh', 'get', 'debug-mode']);
  });

  it('Phase G.b: cycling satellite rotates values + spawns set script', async () => {
    const OPENCUES_MD = `---
voice-mode: active
settings:
  voice-mode:
    tip: t
    values:
      active: a
      inactive: i
---`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/cues.md': TIPS, '/proj/opencues.md': OPENCUES_MD },
    });
    adapter.pushText('voice-mode active');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const ss = new SelectorSatelliteState();
    ss.set({
      controlName: 'opencues',
      scriptPath: '/tmp/oc.sh',
      selectorIndex: 0,
      selectorLength: 1,
      satelliteIndex: 1,
      satelliteLength: 1,
      currentSetting: 'voice-mode',
      currentValue: 'active',
      separator: ' ',
      clearOnEdit: false,
    }, 'voice-mode active');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, undefined, undefined, ss);
    cycling.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    hlState.activate(1, 'voice-mode active'); // satellite
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('voice-mode inactive');
    expect(ss.current?.currentValue).toBe('inactive');
    expect(spawnSpy.mock.calls[0][0].args).toEqual(['/tmp/oc.sh', 'set', 'voice-mode', 'inactive']);
    expect(spawnSpy.mock.calls[0][0].detached).toBe(true);
  });

  it('Phase G.b: satellite cycle handles multi-word values (e.g. plain text → rich markdown)', async () => {
    const OPENCUES_MD = `---
output-format: plain text
settings:
  output-format:
    tip: Format
    values:
      plain text: a
      rich markdown: b
      structured json: c
---`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/cues.md': TIPS, '/proj/opencues.md': OPENCUES_MD },
    });
    adapter.pushText('output-format plain text');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const ss = new SelectorSatelliteState();
    ss.set({
      controlName: 'opencues',
      scriptPath: '/tmp/oc.sh',
      selectorIndex: 0,
      selectorLength: 1,
      satelliteIndex: 1,
      satelliteLength: 2,
      currentSetting: 'output-format',
      currentValue: 'plain text',
      separator: ' ',
      clearOnEdit: false,
    }, 'output-format plain text');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, undefined, undefined, ss);
    cycling.subscribe();
    vi.spyOn(adapter, 'spawnProcess');
    hlState.activate(1, 'output-format plain text'); // first satellite word
    adapter.fireKey('up', { ctrl: true, alt: true });
    // Should replace the WHOLE "plain text" with "rich markdown".
    expect(adapter.setTextCalls.at(-1)).toBe('output-format rich markdown');
    expect(ss.current?.currentValue).toBe('rich markdown');
    expect(ss.current?.satelliteLength).toBe(2);
  });

  it('Phase G.b: cycling from inside a multi-word satellite still triggers cycle', async () => {
    const OPENCUES_MD = `---
output-format: plain text
settings:
  output-format:
    tip: Format
    values:
      plain text: a
      structured json: b
---`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/cues.md': TIPS, '/proj/opencues.md': OPENCUES_MD },
    });
    adapter.pushText('output-format plain text');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const ss = new SelectorSatelliteState();
    ss.set({
      controlName: 'opencues',
      scriptPath: '',
      selectorIndex: 0,
      selectorLength: 1,
      satelliteIndex: 1,
      satelliteLength: 2,
      currentSetting: 'output-format',
      currentValue: 'plain text',
      separator: ' ',
      clearOnEdit: false,
    }, 'output-format plain text');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, undefined, undefined, ss);
    cycling.subscribe();
    hlState.activate(2, 'output-format plain text'); // SECOND satellite word ("text")
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('output-format structured json');
  });

  it('Phase G.b: multi-word selector + satellite cycle as units (display mode case)', async () => {
    const OPENCUES_MD = `---
display mode: split pane
settings:
  display mode:
    tip: Layout
    values:
      focus: f
      split pane: s
      zen: z
---`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/cues.md': TIPS, '/proj/opencues.md': OPENCUES_MD },
    });
    adapter.pushText('display mode split pane');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const ss = new SelectorSatelliteState();
    ss.set({
      controlName: 'opencues',
      scriptPath: '',
      selectorIndex: 0,
      selectorLength: 2,
      satelliteIndex: 2,
      satelliteLength: 2,
      currentSetting: 'display mode',
      currentValue: 'split pane',
      separator: ' ',
      clearOnEdit: false,
    }, 'display mode split pane');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, undefined, undefined, ss);
    cycling.subscribe();
    // Cycle satellite from "split pane" → "zen" (single word).
    hlState.activate(2, 'display mode split pane'); // first satellite word
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('display mode zen');
    expect(ss.current?.currentValue).toBe('zen');
    expect(ss.current?.satelliteLength).toBe(1);
    // Now satellite is single word; cycle again → "focus".
    hlState.activate(2, 'display mode zen');
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('display mode focus');
    expect(ss.current?.satelliteLength).toBe(1);
  });

  it('does nothing when there is only one alternative', async () => {
    const { adapter, hlState, consumeAll } = await setupCa('Lone version');
    consumeAll.set({
      index: 0,
      alternatives: ['Lone version'],
      currentAltIndex: 0,
      spanLength: 2,
    }, 'Lone version');
    hlState.activate(0, 'Lone version');
    expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(false);
  });
});

describe('Cycling controlInvoke (sandboxed-host path)', () => {
  it('selector cycle prefers controlInvoke when host implements it', async () => {
    const OPENCUES_MD = `---
voice-mode: active
debug-mode: off
settings:
  voice-mode:
    tip: Gates TTS globally
    values:
      active: TTS reads tips aloud
      inactive: TTS silenced
  debug-mode:
    tip: Debug logging
    values:
      on: emit
      off: silent
---`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/cues.md': TIPS, '/proj/opencues.md': OPENCUES_MD },
    });
    adapter.pushText('voice-mode active');
    // Host stubs controlInvoke for the selector get; spawn must NOT be hit.
    adapter.stubControlInvoke('opencues:get', 'off\n');
    const hlState = new HighlightState();
    const ss = new SelectorSatelliteState();
    ss.set({
      controlName: 'opencues',
      scriptPath: '/tmp/oc.sh',
      selectorIndex: 0,
      selectorLength: 1,
      satelliteIndex: 1,
      satelliteLength: 1,
      currentSetting: 'voice-mode',
      currentValue: 'active',
      separator: ' ',
      clearOnEdit: false,
    }, 'voice-mode active');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const cycling = new Cycling(adapter, hlState, new DynDefs(), loader, undefined, undefined, ss);
    cycling.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    hlState.activate(0, 'voice-mode active');
    adapter.fireKey('up', { ctrl: true, alt: true });
    // controlInvoke was called for the selector get; spawnProcess wasn't.
    const getCall = adapter.blankInvokeCalls.find(c => c.action === 'get');
    expect(getCall).toBeDefined();
    expect(getCall!.controlName).toBe('opencues');
    expect(getCall!.args).toEqual(['debug-mode']);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('falls through to spawnProcess when host returns null from controlInvoke', async () => {
    const OPENCUES_MD = `---
voice-mode: active
settings:
  voice-mode:
    tip: t
    values:
      active: a
      inactive: i
---`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/cues.md': TIPS, '/proj/opencues.md': OPENCUES_MD },
    });
    adapter.pushText('voice-mode active');
    // No stub registered → controlInvoke returns null → spawnProcess used.
    const hlState = new HighlightState();
    const ss = new SelectorSatelliteState();
    ss.set({
      controlName: 'opencues',
      scriptPath: '/tmp/oc.sh',
      selectorIndex: 0,
      selectorLength: 1,
      satelliteIndex: 1,
      satelliteLength: 1,
      currentSetting: 'voice-mode',
      currentValue: 'active',
      separator: ' ',
      clearOnEdit: false,
    }, 'voice-mode active');
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const cycling = new Cycling(adapter, hlState, new DynDefs(), loader, undefined, undefined, ss);
    cycling.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: 'a\n', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    hlState.activate(0, 'voice-mode active');
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(spawnSpy).toHaveBeenCalled();
  });
});
