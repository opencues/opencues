import { describe, expect, it } from 'vitest';
import {
  ACTIVE_WINDOW_MS,
  MAX_NOTE_CHARS,
  HOT_WINDOW_MS,
  POLL_ACTIVE_MS,
  POLL_HOT_MS,
  POLL_IDLE_MS,
  POLL_PAUSED_MS,
  applyPoll,
  containsBlankMarker,
  diffLines,
  initialState,
  pollDelayMs,
  recordWriteHash,
  selectChanged,
  synthCursor,
} from './tick';

const hash = (s: string): string => `h:${s}`;
const T0 = 1_000_000;

const meta = (id: string, mod: string) => ({ id, mod });
const note = (id: string, mod: string, plaintext: string) => ({ id, mod, plaintext });

describe('containsBlankMarker', () => {
  it('matches a standalone underscore', () => {
    expect(containsBlankMarker('what is 2+2 _')).toBe(true);
    expect(containsBlankMarker('line one\ncapital of peru _\n')).toBe(true);
    expect(containsBlankMarker('translate _, please')).toBe(true);
  });
  it('ignores snake_case and identifiers', () => {
    expect(containsBlankMarker('use snake_case here')).toBe(false);
    expect(containsBlankMarker('the _private field')).toBe(false);
    expect(containsBlankMarker('no marker at all')).toBe(false);
  });
});

describe('synthCursor', () => {
  it('lands just after the marker', () => {
    const text = 'what is 2+2 _\n';
    expect(synthCursor(text)).toBe(text.indexOf('_') + 1);
  });
  it('falls back to text end', () => {
    expect(synthCursor('plain')).toBe(5);
  });
  it('with multiple markers, the LAST wins (notes grow downward)', () => {
    const text = 'add emojis _\n\ncapital of portugal _\n';
    expect(synthCursor(text)).toBe(text.lastIndexOf('_') + 1);
  });
});

describe('synthCursorNear', () => {
  it('targets the marker on the line the user just edited', async () => {
    const { synthCursorNear } = await import('./tick');
    // user edited the TOP line (added the marker there); bottom cue is old
    const prev = 'add emojis\n\ncapital of portugal _\n';
    const text = 'add emojis _\n\ncapital of portugal _\n';
    expect(synthCursorNear(text, prev)).toBe(text.indexOf('_') + 1);
  });
  it('falls back to the last marker with no prev text', async () => {
    const { synthCursorNear } = await import('./tick');
    const text = 'add emojis _\n\ncapital of portugal _\n';
    expect(synthCursorNear(text, undefined)).toBe(text.lastIndexOf('_') + 1);
  });
});

describe('seedBaseline', () => {
  it('pre-existing cue notes are NOT eligible until edited again', async () => {
    const { seedBaseline } = await import('./tick');
    const s = initialState(T0);
    seedBaseline(s, [meta('old', 'm1'), meta('other', 'm2')]);
    // same enumeration again → nothing to fetch, nothing tracked
    expect(selectChanged(s, [meta('old', 'm1'), meta('other', 'm2')])).toEqual([]);
    // the old cue note gets edited → becomes eligible
    expect(selectChanged(s, [meta('old', 'm9'), meta('other', 'm2')])).toEqual(['old']);
  });
});

describe('freshMarkerIndex', () => {
  it('arms the last marker on a newly tracked note (no prev)', async () => {
    const { freshMarkerIndex } = await import('./tick');
    const text = 'a _\n\nquestion _\n';
    expect(freshMarkerIndex(text, undefined)).toBe(text.lastIndexOf('_'));
  });
  it('arms the marker inside the changed region', async () => {
    const { freshMarkerIndex } = await import('./tick');
    const prev = 'old cue _\n\nnotes\n';
    const text = 'old cue _\n\nnotes\nnew cue _\n';
    expect(freshMarkerIndex(text, prev)).toBe(text.lastIndexOf('_'));
  });
  it('does NOT arm when the edit is away from every marker', async () => {
    const { freshMarkerIndex } = await import('./tick');
    const prev = 'stale cue _\n\nshopping list\n';
    const text = 'stale cue _\n\nshopping list\nmilk\n';
    expect(freshMarkerIndex(text, prev)).toBeNull();
  });
  it('returns null with no markers at all', async () => {
    const { freshMarkerIndex } = await import('./tick');
    expect(freshMarkerIndex('plain\n', 'plai\n')).toBeNull();
  });
});

describe('selectChanged', () => {
  it('flags new and modified notes only', () => {
    const s = initialState(T0);
    s.known.set('a', '2026-01-01');
    s.known.set('b', '2026-01-01');
    const changed = selectChanged(s, [
      meta('a', '2026-01-01'),   // unchanged
      meta('b', '2026-01-02'),   // modified
      meta('c', '2026-01-01'),   // new
    ]);
    expect(changed).toEqual(['b', 'c']);
  });
});

describe('applyPoll', () => {
  it('tracks a cue-bearing note and makes it active', () => {
    const s = initialState(T0);
    const events = applyPoll(
      s,
      [meta('a', 'm1')],
      [note('a', 'm1', 'capital of france _\n')],
      hash, T0,
    );
    expect(events).toEqual([
      expect.objectContaining({ type: 'switch-active', id: 'a', source: 'user' }),
    ]);
    expect(s.activeId).toBe('a');
  });

  it('ignores notes without a marker', () => {
    const s = initialState(T0);
    const events = applyPoll(s, [meta('a', 'm1')], [note('a', 'm1', 'groceries\n')], hash, T0);
    expect(events).toEqual([]);
    expect(s.tracked.size).toBe(0);
  });

  it('classifies our own write echo as source runtime (echo suppression)', () => {
    const s = initialState(T0);
    applyPoll(s, [meta('a', 'm1')], [note('a', 'm1', 'q _\n')], hash, T0);
    const filled = 'q answered\n';
    s.lastWriteHash.set('a', new Set([hash(filled)]));
    s.tracked.set('a', { id: 'a', mod: 'm1', plaintext: filled, userEditAt: T0 });
    // iCloud echoes the fill back with a bumped mod
    const events = applyPoll(s, [meta('a', 'm2')], [note('a', 'm2', filled)], hash, T0 + 1000);
    const change = events.find(e => e.type === 'text-change');
    expect(change).toMatchObject({ source: 'runtime' });
    // and the note stays tracked even though the marker is gone
    expect(s.tracked.has('a')).toBe(true);
  });

  it('untracks when the USER removes the marker', () => {
    const s = initialState(T0);
    applyPoll(s, [meta('a', 'm1')], [note('a', 'm1', 'q _\n')], hash, T0);
    const events = applyPoll(s, [meta('a', 'm2')], [note('a', 'm2', 'q done by hand\n')], hash, T0);
    expect(events).toContainEqual({ type: 'untracked', id: 'a', reason: 'no-marker' });
    expect(events).toContainEqual({ type: 'active-gone' });
    expect(s.activeId).toBeNull();
  });

  it('untracks oversized notes', () => {
    const s = initialState(T0);
    applyPoll(s, [meta('a', 'm1')], [note('a', 'm1', 'q _\n')], hash, T0);
    const big = 'x'.repeat(MAX_NOTE_CHARS + 1) + ' _\n';
    const events = applyPoll(s, [meta('a', 'm2')], [note('a', 'm2', big)], hash, T0);
    expect(events).toContainEqual({ type: 'untracked', id: 'a', reason: 'oversize' });
  });

  it('drops deleted notes from every map', () => {
    const s = initialState(T0);
    applyPoll(s, [meta('a', 'm1')], [note('a', 'm1', 'q _\n')], hash, T0);
    s.lastWriteHash.set('a', new Set(['zz']));
    const events = applyPoll(s, [], [], hash, T0);
    expect(events).toContainEqual({ type: 'untracked', id: 'a', reason: 'deleted' });
    expect(s.known.size).toBe(0);
    expect(s.lastWriteHash.size).toBe(0);
    expect(s.activeId).toBeNull();
  });

  it('the note the user last typed in wins active; switch resets buffer', () => {
    const s = initialState(T0);
    applyPoll(s, [meta('a', 'm1')], [note('a', 'm1', 'first _\n')], hash, T0);
    const events = applyPoll(
      s,
      [meta('a', 'm1'), meta('b', 'm9')],
      [note('b', 'm9', 'second _\n')],
      hash, T0 + 1000,
    );
    expect(events).toEqual([
      expect.objectContaining({ type: 'switch-active', id: 'b', text: 'second _\n' }),
    ]);
  });

  it('a mod-date bump WITHOUT a content change never steals the active buffer', () => {
    // iCloud sync / deletion bookkeeping bump modificationDate on notes
    // the user isn't touching; under mod-date election these stole the
    // buffer mid-resolution (live failure 2026-07-08).
    const s = initialState(T0);
    applyPoll(s, [meta('b', 'm1')], [note('b', 'm1', 'other _\n')], hash, T0);
    applyPoll(s, [meta('a', 'm2'), meta('b', 'm1')], [note('a', 'm2', 'mine _\n')], hash, T0 + 1000);
    expect(s.activeId).toBe('a');
    // b re-enumerates with a NEWER mod but byte-identical content
    const events = applyPoll(s, [meta('a', 'm2'), meta('b', 'm9')], [note('b', 'm9', 'other _\n')], hash, T0 + 2000);
    expect(s.activeId).toBe('a');
    expect(events.find(e => e.type === 'switch-active')).toBeUndefined();
  });

  it('our own fill echo on another note never steals the active buffer', () => {
    const s = initialState(T0);
    applyPoll(s, [meta('b', 'm1')], [note('b', 'm1', 'other _\n')], hash, T0);
    applyPoll(s, [meta('a', 'm2'), meta('b', 'm1')], [note('a', 'm2', 'mine _\n')], hash, T0 + 1000);
    expect(s.activeId).toBe('a');
    // our fill on b echoes back with a newer mod (marker consumed)
    const filled = 'other answered\n';
    s.lastWriteHash.set('b', new Set([hash(filled)]));
    const events = applyPoll(s, [meta('a', 'm2'), meta('b', 'm9')], [note('b', 'm9', filled)], hash, T0 + 2000);
    expect(s.activeId).toBe('a');
    expect(events.find(e => e.type === 'switch-active')).toBeUndefined();
    expect(s.tracked.has('b')).toBe(true); // echo exception still tracks it
  });

  it('temp→permanent id swap remaps silently — no untrack, no buffer reset', () => {
    // Notes enumerates a freshly UI-created note under a temporary
    // CoreData id and swaps it for the permanent id moments later.
    // Live failure (4 sessions, 2026-07-08/09): the swap read as
    // delete + new note and killed every in-flight resolution.
    const s = initialState(T0);
    applyPoll(s, [meta('tTEMP', 'm1')], [note('tTEMP', 'm1', 'Draft an email _\n')], hash, T0);
    expect(s.activeId).toBe('tTEMP');
    const events = applyPoll(s, [meta('pPERM', 'm2')], [note('pPERM', 'm2', 'Draft an email _\n')], hash, T0 + 1000);
    expect(events).toEqual([{ type: 'id-remapped', from: 'tTEMP', to: 'pPERM' }]);
    expect(s.activeId).toBe('pPERM');
    expect(s.tracked.get('pPERM')?.userEditAt).toBe(T0);
    expect(s.tracked.has('tTEMP')).toBe(false);
  });

  it('id swap while the user kept typing (prefix match) remaps then reports the edit', () => {
    const s = initialState(T0);
    applyPoll(s, [meta('tTEMP', 'm1')], [note('tTEMP', 'm1', 'Draft an email _\n')], hash, T0);
    expect(s.activeId).toBe('tTEMP');
    const events = applyPoll(s, [meta('pPERM', 'm2')], [note('pPERM', 'm2', 'Draft an email _ and cc bob\n')], hash, T0 + 1000);
    expect(events[0]).toEqual({ type: 'id-remapped', from: 'tTEMP', to: 'pPERM' });
    const change = events.find(e => e.type === 'text-change' || e.type === 'switch-active');
    expect(change).toMatchObject({ id: 'pPERM', source: 'user' });
  });

  it('id swap migrates the write-hash ring — echoes still classify as runtime', () => {
    const s = initialState(T0);
    applyPoll(s, [meta('tTEMP', 'm1')], [note('tTEMP', 'm1', 'q _\n')], hash, T0);
    recordWriteHash(s, 'tTEMP', hash('q answered\n'));
    applyPoll(s, [meta('pPERM', 'm2')], [note('pPERM', 'm2', 'q _\n')], hash, T0 + 1000);
    // our fill echoes back under the NEW id
    const events = applyPoll(s, [meta('pPERM', 'm3')], [note('pPERM', 'm3', 'q answered\n')], hash, T0 + 2000);
    expect(events.find(e => e.type === 'text-change')).toMatchObject({ source: 'runtime' });
    expect(s.tracked.has('pPERM')).toBe(true);
  });

  it('a genuine deletion (no content-matching new note) still untracks', () => {
    const s = initialState(T0);
    applyPoll(s, [meta('a', 'm1')], [note('a', 'm1', 'q _\n')], hash, T0);
    const events = applyPoll(s, [meta('b', 'm2')], [note('b', 'm2', 'completely different\n')], hash, T0 + 1000);
    expect(events.find(e => e.type === 'untracked')).toMatchObject({ id: 'a', reason: 'deleted' });
  });

  it('a note the user never edited (userEditAt 0) is never elected', () => {
    const s = initialState(T0);
    // echo-only track: hash matches a daemon write, user never typed
    const filled = 'ghost answered\n';
    s.lastWriteHash.set('g', new Set([hash(filled)]));
    s.tracked.set('g', { id: 'g', mod: 'm5', plaintext: filled, userEditAt: 0 });
    const events = applyPoll(s, [meta('g', 'm5')], [], hash, T0 + 1000);
    expect(s.activeId).toBeNull();
    expect(events.find(e => e.type === 'switch-active')).toBeUndefined();
  });

  it('active stays sticky on modificationDate ties', () => {
    const s = initialState(T0);
    applyPoll(s, [meta('a', 'm5'), meta('b', 'm5')],
      [note('a', 'm5', 'a _\n'), note('b', 'm5', 'b _\n')], hash, T0);
    const first = s.activeId;
    const events = applyPoll(s, [meta('a', 'm5'), meta('b', 'm5')], [], hash, T0);
    expect(s.activeId).toBe(first);
    expect(events).toEqual([]);
  });

  it('fetch-error notes are untracked without crashing the tick', () => {
    const s = initialState(T0);
    applyPoll(s, [meta('a', 'm1')], [note('a', 'm1', 'q _\n')], hash, T0);
    const events = applyPoll(s, [meta('a', 'm2')], [{ id: 'a', error: 'locked' }], hash, T0);
    expect(events).toContainEqual({ type: 'untracked', id: 'a', reason: 'fetch-error' });
  });
});

describe('ensureTrailingNewline (buffer canonicalization)', () => {
  it('appends the terminator LLM rewrites tend to omit', async () => {
    const { ensureTrailingNewline } = await import('./tick');
    expect(ensureTrailingNewline('Dear Hiring Manager,\n\nBody')).toBe('Dear Hiring Manager,\n\nBody\n');
    expect(ensureTrailingNewline('already fine\n')).toBe('already fine\n');
  });
});

describe('flushDelayMs (settle + max-wait)', () => {
  it('a lone write waits only the settle window', async () => {
    const { flushDelayMs, FLUSH_SETTLE_MS } = await import('./tick');
    expect(flushDelayMs(T0, T0)).toBe(FLUSH_SETTLE_MS);
  });
  it('streaming writes are capped by the max-wait deadline', async () => {
    const { flushDelayMs, FLUSH_SETTLE_MS, FLUSH_MAX_WAIT_MS } = await import('./tick');
    // a write arrives just before the max-wait deadline: the remaining
    // deadline wins over the settle window
    const firstAt = T0;
    const remaining = Math.min(FLUSH_SETTLE_MS, 10);
    const now = T0 + FLUSH_MAX_WAIT_MS - remaining;
    expect(flushDelayMs(now, firstAt)).toBe(remaining);
  });
  it('animation cadence: settle never delays a frame past the frame interval', async () => {
    const { flushDelayMs, FLUSH_SETTLE_MS, FLUSH_MAX_WAIT_MS } = await import('./tick');
    // The standard animator ticks ~150ms; a frame must flush within
    // one interval so the note animates like every other host.
    expect(FLUSH_SETTLE_MS + 0).toBeLessThanOrEqual(150);
    expect(FLUSH_MAX_WAIT_MS + 0).toBeLessThanOrEqual(150);
    expect(flushDelayMs(T0, T0)).toBeLessThanOrEqual(150);
  });
  it('never negative once the deadline has passed', async () => {
    const { flushDelayMs, FLUSH_MAX_WAIT_MS } = await import('./tick');
    expect(flushDelayMs(T0 + FLUSH_MAX_WAIT_MS + 500, T0)).toBe(0);
  });
});

describe('pollDelayMs (adaptive cadence)', () => {
  it('hot right after a change, active within the window, idle after, paused when Notes is closed', () => {
    const s = initialState(T0);
    expect(pollDelayMs(s, true, T0 + 1000)).toBe(POLL_HOT_MS);
    expect(pollDelayMs(s, true, T0 + HOT_WINDOW_MS + 1)).toBe(POLL_ACTIVE_MS);
    expect(pollDelayMs(s, true, T0 + ACTIVE_WINDOW_MS + 1)).toBe(POLL_IDLE_MS);
    expect(pollDelayMs(s, false, T0 + 1000)).toBe(POLL_PAUSED_MS);
  });
  it('a fresh content change re-enters the hot tier', () => {
    const s = initialState(T0);
    s.lastActivityAt = T0 + 30_000;
    expect(pollDelayMs(s, true, T0 + 30_100)).toBe(POLL_HOT_MS);
  });
});

describe('diffLines', () => {
  it('returns null on identical text', () => {
    expect(diffLines('a\nb\n', 'a\nb\n')).toBeNull();
  });
  it('isolates a single changed line', () => {
    expect(diffLines('a\nq _\nc\n', 'a\nq 42\nc\n')).toEqual({
      start: 1, oldLines: ['q _'], newLines: ['q 42'],
    });
  });
  it('handles one line becoming many', () => {
    expect(diffLines('a\ndraft _\nc\n', 'a\nDear,\n\nBye\nc\n')).toEqual({
      start: 1, oldLines: ['draft _'], newLines: ['Dear,', '', 'Bye'],
    });
  });
  it('widens pure insertions with an anchor line', () => {
    const d = diffLines('a\nb\n', 'a\nnew\nb\n');
    expect(d).not.toBeNull();
    expect(d!.oldLines.length).toBeGreaterThan(0);
    // applying old→new over the region reproduces the new text
    const a = 'a\nb\n'.split('\n');
    a.splice(d!.start, d!.oldLines.length, ...d!.newLines);
    expect(a.join('\n')).toBe('a\nnew\nb\n');
  });
});
