import { describe, expect, it } from 'vitest';
import { UndoJournal, diffSplice, fillSplice, type UndoEntry } from './undo-journal';

/** Simulate the applier's anchor relocation for a buffer-splice entry.
 *  undo: find afterSlice, swap in beforeSlice. redo: the reverse. */
function applyBufferSplice(entry: UndoEntry, dir: 'undo' | 'redo', text: string): string {
  if (entry.kind !== 'buffer-splice') throw new Error('not a buffer-splice');
  const anchor = dir === 'undo' ? entry.afterSlice : entry.beforeSlice;
  const replacement = dir === 'undo' ? entry.beforeSlice : entry.afterSlice;
  if (anchor === '') return text.trim() === '' ? replacement : text;
  const i = text.indexOf(anchor);
  if (i < 0 || text.indexOf(anchor, i + 1) >= 0) return text; // not-found / ambiguous
  return text.slice(0, i) + replacement + text.slice(i + anchor.length);
}

function bufferEntry(before: string, after: string, epoch = 0): UndoEntry {
  return { kind: 'buffer-splice', beforeSlice: before, afterSlice: after, bufferEpoch: epoch };
}

function scalarEntry(key: string, prev: string | undefined, next: string): UndoEntry {
  return { kind: 'scalar-write', key, prevValue: prev, newValue: next };
}

function osEntry(blank: string, prev: string, next: string): UndoEntry {
  return { kind: 'os-set', blankName: blank, prevValue: prev, newValue: next };
}

describe('UndoJournal — recording basics', () => {
  it('records transactions and reports depth', () => {
    const j = new UndoJournal();
    j.record({ label: 'a', entries: [bufferEntry('x', 'y')] });
    j.record({ label: 'b', entries: [bufferEntry('y', 'z')] });
    expect(j.undoDepth).toBe(2);
    expect(j.redoDepth).toBe(0);
  });

  it('drops empty transactions', () => {
    const j = new UndoJournal();
    j.record({ label: 'empty', entries: [] });
    expect(j.undoDepth).toBe(0);
  });

  it('caps at MAX_DEPTH, dropping oldest', () => {
    const j = new UndoJournal();
    for (let i = 0; i < UndoJournal.MAX_DEPTH + 10; i++) {
      j.record({ label: `t${i}`, entries: [bufferEntry(`b${i}`, `a${i}`)] });
    }
    expect(j.undoDepth).toBe(UndoJournal.MAX_DEPTH);
    // Oldest remaining is t10 (t0..t9 dropped).
    const all = j.peekUndo(UndoJournal.MAX_DEPTH);
    expect(all[all.length - 1]!.label).toBe('t10');
    expect(all[0]!.label).toBe(`t${UndoJournal.MAX_DEPTH + 9}`);
  });

  it('peekUndo returns newest-first and clamps count to depth', () => {
    const j = new UndoJournal();
    j.record({ label: 'first', entries: [bufferEntry('1', '2')] });
    j.record({ label: 'second', entries: [bufferEntry('2', '3')] });
    const peeked = j.peekUndo(99);
    expect(peeked.map(t => t.label)).toEqual(['second', 'first']);
    // Peek does not pop.
    expect(j.undoDepth).toBe(2);
  });
});

describe('UndoJournal — undo/redo stack semantics', () => {
  it('confirmUndo moves a transaction to the redo stack', () => {
    const j = new UndoJournal();
    j.record({ label: 'a', entries: [bufferEntry('x', 'y')] });
    const [tx] = j.peekUndo(1);
    j.confirmUndo(tx!);
    expect(j.undoDepth).toBe(0);
    expect(j.redoDepth).toBe(1);
  });

  it('confirmRedo moves it back without wiping the remaining redo stack', () => {
    const j = new UndoJournal();
    j.record({ label: 'a', entries: [bufferEntry('1', '2')] });
    j.record({ label: 'b', entries: [bufferEntry('2', '3')] });
    for (const tx of j.peekUndo(2)) j.confirmUndo(tx);
    expect(j.redoDepth).toBe(2);
    // Redo just one (the more recent undo, i.e. 'a'... redo order is
    // newest-undone-first = 'a' was undone last? peekUndo returned
    // [b, a], confirmed in that order, so redo stack is [b, a] with
    // 'a' on top. peekRedo(1) must return ['a'].
    const [redoTx] = j.peekRedo(1);
    expect(redoTx!.label).toBe('a');
    j.confirmRedo(redoTx!);
    expect(j.undoDepth).toBe(1);
    expect(j.redoDepth).toBe(1);
  });

  it('a fresh record clears the redo stack (new timeline branch)', () => {
    const j = new UndoJournal();
    j.record({ label: 'a', entries: [bufferEntry('x', 'y')] });
    const [tx] = j.peekUndo(1);
    j.confirmUndo(tx!);
    expect(j.redoDepth).toBe(1);
    j.record({ label: 'b', entries: [bufferEntry('x', 'z')] });
    expect(j.redoDepth).toBe(0);
  });
});

describe('UndoJournal — reentrancy guard', () => {
  it('record() during runApply is a no-op (undo never journals itself)', async () => {
    const j = new UndoJournal();
    j.record({ label: 'a', entries: [bufferEntry('x', 'y')] });
    await j.runApply(async () => {
      j.record({ label: 'self', entries: [bufferEntry('y', 'x')] });
    });
    expect(j.undoDepth).toBe(1);
    expect(j.peekUndo(1)[0]!.label).toBe('a');
  });

  it('applying flag resets even when the apply throws', async () => {
    const j = new UndoJournal();
    await expect(j.runApply(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(j.applying).toBe(false);
    j.record({ label: 'after', entries: [bufferEntry('x', 'y')] });
    expect(j.undoDepth).toBe(1);
  });
});

describe('UndoJournal — coalescing', () => {
  it('merges consecutive same-key transactions, keeping first before-state and last after-state', () => {
    const j = new UndoJournal();
    // Volume stepping ×3: 40 → 46 → 52 → 58.
    j.record({ label: 'volume step', coalesceKey: 'blank-step:volume:2', entries: [bufferEntry('40%', '46%'), osEntry('volume', '40', '46')] });
    j.record({ label: 'volume step', coalesceKey: 'blank-step:volume:2', entries: [bufferEntry('46%', '52%'), osEntry('volume', '46', '52')] });
    j.record({ label: 'volume step', coalesceKey: 'blank-step:volume:2', entries: [bufferEntry('52%', '58%'), osEntry('volume', '52', '58')] });
    expect(j.undoDepth).toBe(1);
    const [tx] = j.peekUndo(1);
    const buf = tx!.entries.find(e => e.kind === 'buffer-splice');
    const os = tx!.entries.find(e => e.kind === 'os-set');
    expect(buf).toMatchObject({ beforeSlice: '40%', afterSlice: '58%' });
    expect(os).toMatchObject({ prevValue: '40', newValue: '58' });
  });

  it('does not coalesce across different keys', () => {
    const j = new UndoJournal();
    j.record({ label: 'vol', coalesceKey: 'blank-step:volume:2', entries: [osEntry('volume', '40', '46')] });
    j.record({ label: 'bright', coalesceKey: 'blank-step:brightness:5', entries: [osEntry('brightness', '70', '76')] });
    expect(j.undoDepth).toBe(2);
  });

  it('does not coalesce when an unkeyed transaction intervenes', () => {
    const j = new UndoJournal();
    j.record({ label: 'vol', coalesceKey: 'k', entries: [osEntry('volume', '40', '46')] });
    j.record({ label: 'fill', entries: [bufferEntry('q', 'a')] });
    j.record({ label: 'vol', coalesceKey: 'k', entries: [osEntry('volume', '46', '52')] });
    expect(j.undoDepth).toBe(3);
  });

  it('a coalesced record still clears the redo stack', () => {
    const j = new UndoJournal();
    j.record({ label: 'x', entries: [bufferEntry('a', 'b')] });
    const [tx] = j.peekUndo(1);
    j.confirmUndo(tx!);
    expect(j.redoDepth).toBe(1);
    j.record({ label: 'vol', coalesceKey: 'k', entries: [osEntry('volume', '40', '46')] });
    j.record({ label: 'vol', coalesceKey: 'k', entries: [osEntry('volume', '46', '52')] });
    expect(j.redoDepth).toBe(0);
  });

  it('scalar entries coalesce per-key within the transaction (satellite value cycling)', () => {
    const j = new UndoJournal();
    j.record({ label: 'cycle', coalesceKey: 'sel-sat:value:3:voice-mode', entries: [scalarEntry('voice-mode', 'inactive', 'active')] });
    j.record({ label: 'cycle', coalesceKey: 'sel-sat:value:3:voice-mode', entries: [scalarEntry('voice-mode', 'active', 'inactive')] });
    const [tx] = j.peekUndo(1);
    expect(j.undoDepth).toBe(1);
    expect(tx!.entries).toHaveLength(1);
    expect(tx!.entries[0]).toMatchObject({ key: 'voice-mode', prevValue: 'inactive', newValue: 'inactive' });
  });
});

describe('UndoJournal — epochs', () => {
  it('noteBufferReset bumps the epoch without touching the stacks', () => {
    const j = new UndoJournal();
    j.record({ label: 'a', entries: [bufferEntry('x', 'y', j.currentEpoch), scalarEntry('voice-mode', 'inactive', 'active')] });
    expect(j.currentEpoch).toBe(0);
    j.noteBufferReset();
    expect(j.currentEpoch).toBe(1);
    expect(j.undoDepth).toBe(1);
    // The stale buffer entry is still THERE — skipping it is the
    // applier's judgement (epoch comparison), not the journal's.
    const [tx] = j.peekUndo(1);
    expect(tx!.entries[0]).toMatchObject({ kind: 'buffer-splice', bufferEpoch: 0 });
  });
});

describe('UndoJournal — two-phase begin/commit', () => {
  it('commit routes through record (coalescing + redo-clear apply)', () => {
    const j = new UndoJournal();
    const pending = j.begin('settings change');
    pending.add(scalarEntry('debug-mode', 'off', 'on'));
    pending.add(bufferEntry('enable debug logging _', 'debug-mode on', 0));
    expect(j.undoDepth).toBe(0); // nothing until commit
    pending.commit();
    expect(j.undoDepth).toBe(1);
    expect(j.peekUndo(1)[0]!.entries).toHaveLength(2);
  });

  it('commit with only scalar entries is legal (race-bailed splice)', () => {
    const j = new UndoJournal();
    const pending = j.begin('settings change');
    pending.add(scalarEntry('voice-mode', 'active', 'inactive'));
    pending.commit();
    expect(j.undoDepth).toBe(1);
  });

  it('abort discards; add/commit after abort are no-ops', () => {
    const j = new UndoJournal();
    const pending = j.begin('x');
    pending.add(scalarEntry('a', 'b', 'c'));
    pending.abort();
    pending.add(scalarEntry('d', 'e', 'f'));
    pending.commit();
    expect(j.undoDepth).toBe(0);
  });

  it('double commit records once', () => {
    const j = new UndoJournal();
    const pending = j.begin('x');
    pending.add(scalarEntry('a', undefined, 'c'));
    pending.commit();
    pending.commit();
    expect(j.undoDepth).toBe(1);
  });

  it('empty pending commit is a no-op', () => {
    const j = new UndoJournal();
    j.begin('nothing').commit();
    expect(j.undoDepth).toBe(0);
  });
});

describe('UndoJournal — coalesce frame guard', () => {
  it('merges only frame-consistent buffer entries (prior.after === next.before)', () => {
    const j = new UndoJournal();
    j.record({ label: 'c', coalesceKey: 'k', entries: [bufferEntry('attorney', 'lawyer')] });
    j.record({ label: 'c', coalesceKey: 'k', entries: [bufferEntry('lawyer', 'legal eagle')] });
    const [tx] = j.peekUndo(1);
    expect(tx!.entries).toHaveLength(1);
    expect(tx!.entries[0]).toMatchObject({ beforeSlice: 'attorney', afterSlice: 'legal eagle' });
  });

  it('APPENDS instead of merging when frames break (the diff-trim corruption class)', () => {
    const j = new UndoJournal();
    // Simulates the bug this guard exists for: a second entry recorded
    // in a DIFFERENT frame ('awyer' is a trimmed fragment of 'lawyer').
    // Overwrite-merging would produce {before: 'attorney', after:
    // 'egal eagle'} — anchoring inside 'legal eagle' and splicing
    // 'attorney' over a partial word. Appending keeps both reversible.
    j.record({ label: 'c', coalesceKey: 'k', entries: [bufferEntry('attorney', 'lawyer')] });
    j.record({ label: 'c', coalesceKey: 'k', entries: [bufferEntry('awyer', 'egal eagle')] });
    const [tx] = j.peekUndo(1);
    expect(j.undoDepth).toBe(1);
    expect(tx!.entries).toHaveLength(2);
    expect(tx!.entries[0]).toMatchObject({ beforeSlice: 'attorney', afterSlice: 'lawyer' });
    expect(tx!.entries[1]).toMatchObject({ beforeSlice: 'awyer', afterSlice: 'egal eagle' });
  });

  it('scalar frame guard: prior.newValue must equal next.prevValue', () => {
    const j = new UndoJournal();
    j.record({ label: 'c', coalesceKey: 'k', entries: [scalarEntry('voice-mode', 'inactive', 'active')] });
    // Frame break: something else changed the scalar mid-burst.
    j.record({ label: 'c', coalesceKey: 'k', entries: [scalarEntry('voice-mode', 'muted', 'inactive')] });
    const [tx] = j.peekUndo(1);
    expect(tx!.entries).toHaveLength(2);
  });
});

describe('fillSplice — undo of a fill drops the re-firing trigger `_`', () => {
  it('records the undo direction WITHOUT the `_` (no re-fire loop)', () => {
    const entry = fillSplice('capital of france _', 'capital of france Paris', 0)!;
    expect(entry.kind).toBe('buffer-splice');
    if (entry.kind !== 'buffer-splice') return;
    // Anchor is the preceding WORD only (no trailing separator — the
    // command-wipe eats trailing whitespace, so it must not be load-bearing).
    expect(entry.beforeSlice).toBe('france');
    expect(entry.afterSlice).toBe('france Paris');
    // The restored (undo) text must NOT contain the trigger.
    expect(entry.beforeSlice).not.toContain('_');
  });

  it('round-trips: undo gives back the query text with no `_`, redo re-applies the value', () => {
    const before = 'capital of france _';
    const after = 'capital of france Paris';
    const entry = fillSplice(before, after, 0)!;
    const undone = applyBufferSplice(entry, 'undo', after);
    expect(undone).toBe('capital of france'); // trigger + dangling separator gone
    expect(undone).not.toContain('_');
    const redone = applyBufferSplice(entry, 'redo', undone);
    expect(redone).toBe(after); // value back
  });

  it('a fill at the very start of the buffer degrades to the empty-anchor form', () => {
    const entry = fillSplice('_', 'Paris', 0)!;
    if (entry.kind !== 'buffer-splice') throw new Error('expected buffer-splice');
    expect(entry.beforeSlice).toBe('');       // no preceding word to anchor on
    expect(entry.afterSlice).toBe('Paris');
    // undo empties the buffer; redo restores onto the (now empty) buffer.
    const undone = applyBufferSplice(entry, 'undo', 'Paris');
    expect(undone).toBe('');
    expect(applyBufferSplice(entry, 'redo', undone)).toBe('Paris');
  });

  it('falls back to plain diffSplice when the changed region is NOT a lone `_`', () => {
    // A word-cue swap (attorney → lawyer) has no trigger to strip.
    const before = 'the attorney filed';
    const after = 'the lawyer filed';
    expect(fillSplice(before, after, 0)).toEqual(diffSplice(before, after, 0));
  });

  it('preserves a leading pending query when a later `_` is filled', () => {
    // `capital of france _ weather _` → the weather `_` fills; undo must
    // not touch (or re-arm) the earlier `capital of france _`.
    const before = 'capital of france _ weather _';
    const after = 'capital of france _ weather sunny';
    const entry = fillSplice(before, after, 0)!;
    if (entry.kind !== 'buffer-splice') throw new Error('expected buffer-splice');
    expect(entry.beforeSlice).toBe('weather');
    const undone = applyBufferSplice(entry, 'undo', after);
    expect(undone).toBe('capital of france _ weather'); // leading `_` preserved, weather `_` gone
  });
});
