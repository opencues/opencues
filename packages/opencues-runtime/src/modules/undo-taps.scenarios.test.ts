/**
 * Tap-assertion journeys: drive the REAL recording sites (Cycling's
 * five paths, BlankFill's fill pipeline, the real blanks registry via
 * createBlankInvoke) and assert the JOURNAL CONTENTS they produce —
 * then apply the undo with the real UndoApplier and assert the buffer
 * AND the side effects round-trip.
 *
 * undo.scenarios.test.ts covers the resolver ACTION branch with
 * pre-populated journals; THIS file exists because a tap that records
 * the wrong slice (or a coalesce key that doesn't fire) is invisible
 * there. Writing these caught a real bug: diff-trimmed slices from
 * successive cycles live in different frames ('attorney'→'lawyer'
 * then 'awyer'→'egal eagle'), so the coalesce overwrite-merge spliced
 * garbage — fixed by exact-range slices at the cycling taps + the
 * journal's framesCompose guard.
 */

import { describe, expect, it } from 'vitest';
import { BlankFill } from './blank-fill';
import { Cycling } from './cycling';
import { ConfigLoader } from './config-loader';
import { UndoApplier } from './undo';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { SpanFillState } from '../state/span-fill';
import { SelectorSatelliteState } from '../state/selector-satellite';
import { UndoJournal } from '../state/undo-journal';
import { MockAdapter, wrapTipsAsCuesMd } from '../../testing/mock-adapter';
import { createBlankInvoke, createDefaultBlanksRegistry, type Blank } from '../blanks';

const RICH_TIPS = wrapTipsAsCuesMd({
  domain: 'test',
  version: 1,
  concepts: [{
    id: 'words',
    words: {
      attorney: { tip: '', alts: ['lawyer', 'legal eagle', 'defendant counsel'] },
      fast: { tip: '', alts: ['quick', 'rapid', 'swift'] },
      word: { tip: '', alts: ['term'] },
    },
  }],
});

const EMPTY_TIPS = wrapTipsAsCuesMd({ concepts: [] });

const VOLUME_CUE = `---
type: blank
name: volume
blankKeywords: volume
blankStep: 6
blankSuffix: %
---
`;

const NOTE_CUE = `---
type: blank
name: note
blankKeywords: note
blankDismissible: true
blankClearKeywords: true
---
`;

const SENTINEL_CUE = `---
type: blank
name: sentinel
blankKeywords: set sentinel, remove sentinel
blankProximity: 16
blankClearKeywords: true
---
`;

const BLANK_INVOKE_CAPS = [
  'shimmer', 'render-override', 'dim-ranges', 'highlight-range',
  'selection', 'spawn-process', 'file-read', 'file-write',
  'force-render', 'change-source', 'blank-invoke',
] as const;

const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };

/** Apply an undo/redo with the real UndoApplier and push the result —
 *  the same two moves the resolver ACTION branch makes. */
async function applyUndo(
  s: { adapter: MockAdapter; loader: ConfigLoader; journal: UndoJournal },
  action: 'undo' | 'redo' = 'undo',
  count = 1,
) {
  const applier = new UndoApplier(s.adapter, s.loader, s.journal);
  const { text, report } = await applier.apply(action, count, s.adapter.getText());
  s.adapter.pushTextNoKeystroke(text);
  return report;
}

// ---------------------------------------------------------------------------
// A. Cycling — static-alt path (applyAltCycle tap)
// ---------------------------------------------------------------------------

describe('undo taps — alt-cycle records exact-range slices and coalesces', () => {
  async function setupCues(text: string) {
    const adapter = new MockAdapter({ files: { '/mock/CUES.md': RICH_TIPS } });
    adapter.pushText(text);
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const spanFillState = new SpanFillState();
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const journal = new UndoJournal();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, spanFillState,
      undefined, undefined, undefined, undefined, journal);
    cycling.subscribe();
    return { adapter, hlState, dynDefs, loader, journal, cycling };
  }

  it('two cycles on the same word coalesce into ONE frame-consistent transaction', async () => {
    const s = await setupCues('the attorney filed');
    s.hlState.activate(1, 'the attorney filed');
    s.adapter.fireKey('up', { ctrl: true, alt: true });   // → lawyer
    s.adapter.fireKey('up', { ctrl: true, alt: true });   // → legal eagle
    expect(s.adapter.getText()).toBe('the legal eagle filed');

    expect(s.journal.undoDepth).toBe(1);
    const [tx] = s.journal.peekUndo(1);
    expect(tx!.entries).toHaveLength(1);
    // The regression this file exists for: the merged pair must be the
    // FULL original word and the FULL final alt — not diff-trimmed
    // fragments from mismatched frames ('awyer' / 'egal eagle').
    expect(tx!.entries[0]).toMatchObject({
      kind: 'buffer-splice',
      beforeSlice: 'attorney',
      afterSlice: 'legal eagle',
    });
  });

  it('one undo reverts the whole burst; redo re-applies it', async () => {
    const s = await setupCues('the attorney filed');
    s.hlState.activate(1, 'the attorney filed');
    s.adapter.fireKey('up', { ctrl: true, alt: true });
    s.adapter.fireKey('up', { ctrl: true, alt: true });

    await applyUndo(s, 'undo');
    expect(s.adapter.getText()).toBe('the attorney filed');
    await applyUndo(s, 'redo');
    expect(s.adapter.getText()).toBe('the legal eagle filed');
  });

  it('cycles on DIFFERENT words are separate transactions', async () => {
    const s = await setupCues('fast attorney');
    s.hlState.activate(0, 'fast attorney');
    s.adapter.fireKey('up', { ctrl: true, alt: true });   // fast → quick
    s.hlState.activate(1, s.adapter.getText());
    s.adapter.fireKey('up', { ctrl: true, alt: true });   // attorney → lawyer
    expect(s.journal.undoDepth).toBe(2);

    await applyUndo(s, 'undo', 2);
    expect(s.adapter.getText()).toBe('fast attorney');
  });
});

// ---------------------------------------------------------------------------
// B. BlankFill fill + Cycling blank-step (volume: fill tap + os-set tap)
// ---------------------------------------------------------------------------

describe('undo taps — volume fill + step burst (real registry, real os-set capture)', () => {
  async function setupVolume(initialOsValue: number) {
    let osValue = initialOsValue;
    const volumeBlank: Blank = {
      name: 'volume',
      readOnly: false,
      get: async () => String(osValue),
      set: async (v: string) => { osValue = parseInt(v, 10); },
    };
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': EMPTY_TIPS, '/proj/blanks/volume/BLANK.md': VOLUME_CUE },
      capabilities: [...BLANK_INVOKE_CAPS],
    });
    const invoke = createBlankInvoke(new Map([['volume', volumeBlank]]));
    (adapter as unknown as { blankInvoke: typeof invoke }).blankInvoke = invoke;
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const spanFillState = new SpanFillState();
    const journal = new UndoJournal();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, spanFillState,
      undefined, undefined, undefined, undefined, journal);
    cycling.subscribe();
    const bf = new BlankFill(adapter, loader, spanFillState, undefined, undefined, dynDefs,
      undefined, undefined, journal);
    bf.subscribe();
    return { adapter, loader, hlState, dynDefs, journal, os: () => osValue };
  }

  it('fill tx + coalesced step tx; undo restores value via verify-then-set; second undo drops the trigger `_`', async () => {
    const s = await setupVolume(40);
    s.adapter.pushText('volume _');
    await flush();
    expect(s.adapter.getText()).toBe('volume 40%');
    expect(s.journal.undoDepth).toBe(1); // the fill

    // Step the volume ×3 through the REAL cycleBlankStep path.
    s.hlState.activate(1, s.adapter.getText());
    s.adapter.fireKey('up', { ctrl: true, alt: true });
    s.adapter.fireKey('up', { ctrl: true, alt: true });
    s.adapter.fireKey('up', { ctrl: true, alt: true });
    await flush();
    expect(s.adapter.getText()).toBe('volume 58%');
    expect(s.os()).toBe(58);

    // Journal: fill tx + ONE coalesced step tx with frame-consistent
    // buffer slice AND the os-set carrying the burst's ORIGIN value.
    expect(s.journal.undoDepth).toBe(2);
    const [stepTx] = s.journal.peekUndo(1);
    expect(stepTx!.entries.find(e => e.kind === 'buffer-splice')).toMatchObject({
      beforeSlice: '40%', afterSlice: '58%',
    });
    expect(stepTx!.entries.find(e => e.kind === 'os-set')).toMatchObject({
      blankName: 'volume', prevValue: '40', newValue: '58',
    });

    // Undo the burst: buffer back to 40%, OS value verified (get=58)
    // then restored (set 40) through the same registry.
    const report = await applyUndo(s, 'undo');
    expect(report.appliedEntries).toBe(2);
    expect(s.adapter.getText()).toBe('volume 40%');
    expect(s.os()).toBe(40);

    // Undo the fill itself: back to the typed command WITHOUT re-arming
    // the trigger `_` (fillSplice — a restored `volume _` would re-fire the
    // blank on the next keystroke).
    await applyUndo(s, 'undo');
    expect(s.adapter.getText()).toBe('volume');
    expect(s.adapter.getText()).not.toContain('_');
    expect(s.journal.undoDepth).toBe(0);
  });

  it('OS value drifted between step and undo → os-set skipped, buffer still reverts', async () => {
    const s = await setupVolume(40);
    s.adapter.pushText('volume _');
    await flush();
    s.hlState.activate(1, s.adapter.getText());
    s.adapter.fireKey('up', { ctrl: true, alt: true });
    await flush();
    expect(s.os()).toBe(46);

    // Another app moves the volume.
    await (async () => { const inv = (s.adapter as unknown as { blankInvoke: (spec: { blankName: string; action: string; args: readonly string[] }) => { result: Promise<unknown> } | null }).blankInvoke({ blankName: 'volume', action: 'set', args: ['99'] }); await inv?.result; })();
    expect(s.os()).toBe(99);

    const report = await applyUndo(s, 'undo');
    expect(s.adapter.getText()).toBe('volume 40%');
    expect(s.os()).toBe(99); // untouched — never clobber another writer
    expect(report.skipped[0]).toMatchObject({ reason: 'value-drifted' });
  });
});

// ---------------------------------------------------------------------------
// C. Cycling — selector/satellite settings path (scalar-write tap)
// ---------------------------------------------------------------------------

describe('undo taps — satellite cycle records scalar prevs; undo restores setting + pair', () => {
  async function setupSatellite(initialText: string, currentSetting: string, currentValue: string) {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': EMPTY_TIPS, '/proj/CUES.md': '---\nname: t\n---\n' },
    });
    adapter.pushText(initialText);
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    await loader.load();
    const ss = new SelectorSatelliteState();
    ss.set({
      blankName: 'opencues', scriptPath: '',
      selectorIndex: 0, selectorLength: 1, satelliteIndex: 1, satelliteLength: 1,
      currentSetting, currentValue, separator: ' ', clearOnEdit: false,
    }, initialText);
    const journal = new UndoJournal();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, undefined,
      undefined, ss, undefined, undefined, journal);
    cycling.subscribe();
    return { adapter, hlState, loader, ss, journal };
  }

  it('voice-mode satellite cycle: scalar-write with prev captured; undo restores it', async () => {
    const s = await setupSatellite('voice-mode inactive', 'voice-mode', 'inactive');
    s.loader.applyOpenCuesScalar('voice-mode', 'inactive');
    s.hlState.activate(1, 'voice-mode inactive');
    s.adapter.fireKey('up', { ctrl: true, alt: true });
    const cycledTo = s.loader.opencuesState.settings.get('voice-mode')!;
    expect(cycledTo).not.toBe('inactive');

    expect(s.journal.undoDepth).toBe(1);
    const [tx] = s.journal.peekUndo(1);
    expect(tx!.entries.find(e => e.kind === 'scalar-write')).toMatchObject({
      key: 'voice-mode', prevValue: 'inactive', newValue: cycledTo,
    });
    expect(tx!.entries.find(e => e.kind === 'buffer-splice')).toMatchObject({
      beforeSlice: 'voice-mode inactive',
      afterSlice: `voice-mode ${cycledTo}`,
    });

    const report = await applyUndo(s, 'undo');
    expect(report.appliedEntries).toBe(2);
    expect(s.adapter.getText()).toBe('voice-mode inactive');
    expect(s.loader.opencuesState.settings.get('voice-mode')).toBe('inactive');
  });

  it('satellite cycled ×2 coalesces; undo returns to the ORIGIN value, not the middle one', async () => {
    const s = await setupSatellite('voice-mode inactive', 'voice-mode', 'inactive');
    s.loader.applyOpenCuesScalar('voice-mode', 'inactive');
    s.hlState.activate(1, 'voice-mode inactive');
    s.adapter.fireKey('up', { ctrl: true, alt: true });
    s.adapter.fireKey('up', { ctrl: true, alt: true });
    expect(s.journal.undoDepth).toBe(1);

    await applyUndo(s, 'undo');
    expect(s.loader.opencuesState.settings.get('voice-mode')).toBe('inactive');
    expect(s.adapter.getText()).toBe('voice-mode inactive');
  });
});

// ---------------------------------------------------------------------------
// D. File-write round trips — real NoteBlank / SentinelBlank through the
//    real registry (ProcessResult.writeInverse → journal → validated undo)
// ---------------------------------------------------------------------------

describe('undo taps — note add round-trips through the real registry', () => {
  async function setupNote() {
    let notesFile: string | null = null;
    const notesMdIO = {
      readFile: async () => notesFile,
      writeFile: async (c: string) => { notesFile = c; },
    };
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': EMPTY_TIPS, '/proj/blanks/note/BLANK.md': NOTE_CUE },
      capabilities: [...BLANK_INVOKE_CAPS],
    });
    const invoke = createBlankInvoke(createDefaultBlanksRegistry({ notesMdIO }));
    (adapter as unknown as { blankInvoke: typeof invoke }).blankInvoke = invoke;
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const spanFillState = new SpanFillState();
    const dynDefs = new DynDefs();
    const journal = new UndoJournal();
    const bf = new BlankFill(adapter, loader, spanFillState, undefined, undefined, dynDefs,
      undefined, undefined, journal);
    bf.subscribe();
    return { adapter, loader, journal, notes: () => notesFile };
  }

  it('note add → journal carries the validated inverse → undo deletes the note AND restores the command', async () => {
    const s = await setupNote();
    s.adapter.pushText('note add standup: 9am tuesdays _');
    await flush();
    expect(s.adapter.getText()).toBe('[note saved: standup · 1 note]');
    expect(s.notes()).toContain('- standup: 9am tuesdays');

    // The tap journaled ONE transaction: buffer entry + the file-write
    // inverse the blank exposed through ProcessResult.writeInverse.
    expect(s.journal.undoDepth).toBe(1);
    const [tx] = s.journal.peekUndo(1);
    expect(tx!.entries.find(e => e.kind === 'file-write')).toMatchObject({
      file: 'NOTES.md',
      blankName: 'note',
      inverseOp: { keyword: 'note', args: ['delete', 'standup:', '9am', 'tuesdays'] },
    });

    // Undo replays the inverse through the SAME registry blank — the
    // note is deleted via NoteBlank's own validated delete path.
    const report = await applyUndo(s, 'undo');
    expect(report.appliedEntries).toBe(2);
    expect(s.notes()).not.toContain('standup');
    expect(s.adapter.getText()).toBe('note add standup: 9am tuesdays _');
  });
});

describe('undo taps — sentinel set round-trips through the real registry', () => {
  async function setupSentinel(initialIdentity: string | null = null) {
    let identityFile = initialIdentity;
    const identityMdIO = {
      readFile: async () => identityFile,
      writeFile: async (c: string) => { identityFile = c; },
    };
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': EMPTY_TIPS, '/proj/blanks/sentinel/BLANK.md': SENTINEL_CUE },
      capabilities: [...BLANK_INVOKE_CAPS],
    });
    const invoke = createBlankInvoke(createDefaultBlanksRegistry({ identityMdIO }));
    (adapter as unknown as { blankInvoke: typeof invoke }).blankInvoke = invoke;
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const spanFillState = new SpanFillState();
    const dynDefs = new DynDefs();
    const journal = new UndoJournal();
    const bf = new BlankFill(adapter, loader, spanFillState, undefined, undefined, dynDefs,
      undefined, undefined, journal);
    bf.subscribe();
    return { adapter, loader, journal, identity: () => identityFile };
  }

  it('new key: `set sentinel city oslo _` → undo removes the key via the validator path', async () => {
    const s = await setupSentinel();
    s.adapter.pushText('set sentinel city oslo _');
    await flush();
    expect(s.identity()).toContain('city');
    expect(s.identity()).toContain('oslo');

    const [tx] = s.journal.peekUndo(1);
    expect(tx!.entries.find(e => e.kind === 'file-write')).toMatchObject({
      file: 'IDENTITY.md',
      blankName: 'sentinel',
      inverseOp: { keyword: 'remove sentinel', args: ['city'] },
    });

    await applyUndo(s, 'undo');
    expect(s.identity()).not.toContain('oslo');
    expect(s.adapter.getText()).toBe('set sentinel city oslo _');
  });

  it('overwrite: undo restores the PRIOR value, not deletion', async () => {
    const s = await setupSentinel('---\ncity:    bergen\n---\n');
    s.adapter.pushText('set sentinel city oslo _');
    await flush();
    expect(s.identity()).toContain('oslo');

    const [tx] = s.journal.peekUndo(1);
    expect(tx!.entries.find(e => e.kind === 'file-write')).toMatchObject({
      inverseOp: { keyword: 'set sentinel', args: ['city', 'bergen'] },
    });

    await applyUndo(s, 'undo');
    expect(s.identity()).toContain('bergen');
    expect(s.identity()).not.toContain('oslo');
  });
});
