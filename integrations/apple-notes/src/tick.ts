// Pure poll-loop state machine for the apple-notes daemon.
//
// The daemon's main loop is thin I/O around these functions so every
// behavioural rule (echo suppression, active-note selection, adaptive
// cadence, skip guards, line diffing) is unit-testable without
// osascript. No imports from the runtime — plain data in, events out.

export const MAX_NOTE_CHARS = 30000;
export const FLUSH_SETTLE_MS = 50;
export const FLUSH_MAX_WAIT_MS = 150;

/**
 * Debounce-with-max-wait for the virtual-buffer flush, tuned for the
 * STANDARD OpenCues loading animation: the blank-loading animator
 * ticks every ~150ms, and each frame should reach the note as soon as
 * it's painted — same UX as every other host. The tiny settle window
 * merges micro-bursts (setText+cursor pairs) into one write; the
 * max-wait guarantees a streaming animation flushes every frame
 * interval rather than deferring forever. Writes remain serialized
 * (one CAS in flight, latest frame wins), so the effective rate
 * self-throttles to the osascript round-trip (~3-6fps) — the queue
 * can never back up, and every write is still splice-only + CAS-
 * verified. History: an early build wrote frames with none of those
 * guards and corrupted a fill (see CLAUDE.md § virtual buffer); the
 * guards, not frame suppression, are the load-bearing fix.
 */
export function flushDelayMs(now: number, firstPendingAt: number): number {
  const settleDeadline = now + FLUSH_SETTLE_MS;
  const maxDeadline = firstPendingAt + FLUSH_MAX_WAIT_MS;
  return Math.max(0, Math.min(settleDeadline, maxDeadline) - now);
}
export const ACTIVE_WINDOW_MS = 60_000;
// Cadence tuning (2026-07-07): match the standard OpenCues hosts.
// Every event-driven host reacts to a keystroke immediately and the
// resolver debounces 500ms — so on this polled channel the active poll
// is 500ms, making detection latency ≈ the standard debounce. Idle
// polls at 2s, the repo-wide "~2 seconds" hot-reload standard. Cost:
// one idle enumeration is ~100-190ms of osascript (~8% duty at 2s);
// active polling runs near back-to-back only while the user is
// actually editing, and enumeration (~90ms bulk fetch at 335 notes)
// self-throttles the loop — the sleep starts AFTER each tick's work.
//
// HOT tier (2026-07-08, "the ping needs to be instant"): for a short
// window after any content change, poll near back-to-back (150ms).
// AppleEvents reads return Notes' LIVE document text — no autosave /
// FSEvents dependency — so during typing and during a blank's loading
// animation (whose frame echoes are content changes, keeping the
// window refreshed) detection and echo lag drop to ~one enumeration.
// The osascript duty cycle is high (~40%) but only within the window;
// it decays to the 500ms active tier the moment content stops moving.
export const POLL_HOT_MS = 150;
export const HOT_WINDOW_MS = 5_000;
export const POLL_ACTIVE_MS = 500;
export const POLL_IDLE_MS = 2_000;
export const POLL_PAUSED_MS = 10_000;

export interface TrackedNote {
  id: string;
  mod: string;
  /** Normalized plaintext snapshot — the runtime buffer when active. */
  plaintext: string;
  /**
   * Daemon-observed time of the last USER-sourced content change (0 =
   * never; e.g. tracked only via the echo exception). The active-note
   * election key: on every other host the buffer IS the editor the
   * user is focused in, so the polled equivalent is "the note the
   * user last typed in" — NOT max(modificationDate), which iCloud
   * sync, deletions, and our own fill echoes can bump. The mod-date
   * election let a background bump steal the active buffer
   * mid-resolution and reset it (observed live 2026-07-08).
   */
  userEditAt: number;
}

export interface DaemonState {
  /** id → last seen modificationDate ISO, for change detection. */
  known: Map<string, string>;
  /** Notes containing a blank marker — fill candidates. */
  tracked: Map<string, TrackedNote>;
  activeId: string | null;
  /**
   * id → hashes of RECENT plaintexts we wrote (intended + as-landed).
   * A poll delivering content matching ANY of them is our own write
   * echoing back → source 'runtime', never re-resolved. A single
   * last-hash raced streaming animation writes: a poll reading the
   * note between a CAS landing and its hash being recorded classified
   * our own frame as a user edit, untracked the note, and aborted the
   * in-flight LLM call. modificationDate can't discriminate (AN-4).
   */
  lastWriteHash: Map<string, Set<string>>;
  lastActivityAt: number;
}

export function initialState(now: number): DaemonState {
  return {
    known: new Map(),
    tracked: new Map(),
    activeId: null,
    lastWriteHash: new Map(),
    lastActivityAt: now,
  };
}

/**
 * Canonical buffer form: Notes plaintext ALWAYS ends with `\n`, so
 * every runtime-side write must too. Live failure this pins: a
 * TransformBlank whole-buffer rewrite came back WITHOUT the trailing
 * newline; the one fill that landed poisoned the tracked snapshot with
 * the 1-char-short text, and every later fill (including the real
 * answer) self-dropped on the "note changed since resolution" guard —
 * permanently, until restart. Applied at the requestWrite boundary so
 * buffer, snapshot, and note can never disagree on the terminator.
 */
export function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : s + '\n';
}

/**
 * Record a write hash for echo classification (capped ring per note).
 * Accepted residual: a CAS-conflicted fill leaves its intended-text
 * hash in the ring (entries only leave by cap eviction or untrack), so
 * a user later producing byte-identical text would be misclassified as
 * our echo. Requires reproducing one of ≤16 exact full-note plaintexts
 * — vanishingly unlikely; not worth per-write conflict bookkeeping.
 */
export function recordWriteHash(state: DaemonState, id: string, h: string): void {
  let set = state.lastWriteHash.get(id);
  if (!set) { set = new Set(); state.lastWriteHash.set(id, set); }
  set.add(h);
  while (set.size > 16) set.delete(set.values().next().value as string);
}

/** A standalone `_` (the blank marker), not snake_case underscores. */
export function containsBlankMarker(text: string): boolean {
  return /(^|\s)_(?=$|[\s.,;:!?)\]])/m.test(text);
}

const MARKER_RE = /(^|\s)_(?=$|[\s.,;:!?)\]])/gm;

/** Offsets just past every standalone blank marker in the text. */
export function markerCursors(text: string): number[] {
  const out: number[] = [];
  MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(text)) !== null) {
    out.push(m.index + m[1].length + 1);
  }
  return out;
}

/**
 * Synthesized cursor: just after the blank marker, else text end.
 * With MULTIPLE markers the LAST one wins — notes grow downward, so
 * the bottom marker is almost always the cue just typed. (The first-
 * marker heuristic mis-routed a real two-cue note: the answer to the
 * bottom cue got spliced into the top line's `_`.)
 */
export function synthCursor(text: string): number {
  const cursors = markerCursors(text);
  return cursors.length ? cursors[cursors.length - 1] : text.length;
}

/**
 * Cursor for a text-change event: the marker nearest the region that
 * actually changed vs `prevText` — that's where the user is typing.
 * Falls back to `synthCursor` (last marker) when there's no usable
 * diff or no marker near it.
 */
export function synthCursorNear(text: string, prevText: string | undefined): number {
  const cursors = markerCursors(text);
  if (cursors.length === 0) return text.length;
  if (cursors.length === 1 || prevText === undefined) return cursors[cursors.length - 1];
  const diff = diffLines(prevText, text);
  if (!diff) return cursors[cursors.length - 1];
  // Char offset of the changed region in the NEW text.
  const lines = text.split('\n');
  let regionStart = 0;
  for (let i = 0; i < diff.start && i < lines.length; i++) regionStart += lines[i].length + 1;
  const regionEnd = regionStart + diff.newLines.join('\n').length;
  let best = cursors[cursors.length - 1];
  let bestDist = Infinity;
  for (const c of cursors) {
    const dist = c < regionStart ? regionStart - c : c > regionEnd ? c - regionEnd : 0;
    if (dist < bestDist) { bestDist = dist; best = c; }
  }
  return best;
}

/** Which enumerated notes need a plaintext fetch this tick. */
export function selectChanged(state: DaemonState, notes: readonly { id: string; mod: string | null }[]): string[] {
  const changed: string[] = [];
  for (const n of notes) {
    if (n.mod === null) continue;
    if (state.known.get(n.id) !== n.mod) changed.push(n.id);
  }
  return changed;
}

/**
 * Seed the first enumeration as a BASELINE without acting on it.
 * Without this, daemon startup treats every pre-existing note containing
 * a `_` as a fresh cue and retro-edits notes the user wrote weeks ago
 * (observed live on first e2e: a fill was attempted against an old
 * project note at boot). "Any note" scope means any note edited from
 * now on — a pre-existing cue becomes eligible the moment the note is
 * touched again.
 */
export function seedBaseline(state: DaemonState, notes: readonly { id: string; mod: string | null }[]): void {
  for (const n of notes) {
    if (n.mod !== null) state.known.set(n.id, n.mod);
  }
}

export type PollEvent =
  | { type: 'switch-active'; id: string; text: string; cursor: number; source: 'user' | 'runtime'; armAt: number | null }
  | { type: 'text-change'; id: string; text: string; cursor: number; source: 'user' | 'runtime'; armAt: number | null }
  | { type: 'active-gone' }
  | { type: 'untracked'; id: string; reason: 'oversize' | 'deleted' | 'no-marker' | 'fetch-error' }
  /**
   * The note's identity changed but the note itself didn't: Notes
   * enumerates a freshly UI-created note under a TEMPORARY CoreData id
   * (`…/ICNote/tXXXX…`) and swaps it for the permanent id (`…/pNNN`)
   * a moment later. Before this event existed, the swap read as
   * delete + new-note: the in-flight fill CAS failed (-1728 "Can't get
   * object"), tracking dropped, resetBufferState() killed the
   * resolution — the daemon broke on exactly the natural flow (⌘N,
   * type a cue) while AppleScript-created probes (permanent id at
   * birth) always passed. The daemon must migrate every id-keyed map
   * (body cache, echo pending, redispatch dedupe, virtual-buffer id) —
   * the runtime is deliberately never told.
   */
  | { type: 'id-remapped'; from: string; to: string };

/**
 * Index of the standalone marker the daemon should ARM this event for,
 * or null. The resolver's explicit-`_` gate needs keystroke-shaped
 * evidence that a `_` is fresh; on a polled channel the daemon supplies
 * it by dispatching a synthetic standalone-`_` KeyEvent (see
 * adapters/apple-notes/v1/apple-notes.scenarios.test.ts). Fresh means:
 * the marker sits inside the region that changed vs `prevText` (a user
 * edit elsewhere must NOT re-arm a stale cue). With no prior snapshot,
 * the last marker is fresh by definition (newly tracked note).
 */
export function freshMarkerIndex(text: string, prevText: string | undefined): number | null {
  const cursors = markerCursors(text);
  if (cursors.length === 0) return null;
  if (prevText === undefined) return cursors[cursors.length - 1] - 1;
  const diff = diffLines(prevText, text);
  if (!diff) return null;
  const lines = text.split('\n');
  let regionStart = 0;
  for (let i = 0; i < diff.start && i < lines.length; i++) regionStart += lines[i].length + 1;
  const regionEnd = regionStart + diff.newLines.join('\n').length;
  for (let k = cursors.length - 1; k >= 0; k--) {
    const idx = cursors[k] - 1; // cursor is just past the marker char
    if (idx >= regionStart && idx <= regionEnd) return idx;
  }
  return null;
}

/**
 * Fold an enumeration + the fetched plaintexts into the state.
 * Mutates `state` (daemon-owned); returns the events the daemon must
 * relay to the runtime, in order.
 */
export function applyPoll(
  state: DaemonState,
  enumerated: readonly { id: string; mod: string | null }[],
  fetched: readonly { id: string; mod?: string; plaintext?: string; error?: string }[],
  hash: (s: string) => string,
  now: number,
): PollEvent[] {
  const events: PollEvent[] = [];
  const alive = new Set(enumerated.map(n => n.id));

  // Temp→permanent id continuity (see the 'id-remapped' event): a
  // TRACKED id vanished this tick while a never-seen id appeared whose
  // fetched text matches the vanished snapshot — exact, or one a prefix
  // of the other (the user may have kept typing through the swap
  // window; typing appends). Migrate identity instead of treating it
  // as delete + new note.
  const remapSilentIds = new Set<string>();
  for (const [oldId, trackedNote] of [...state.tracked.entries()]) {
    if (alive.has(oldId)) continue;
    const candidate = fetched.find(f => {
      if (f.plaintext === undefined || f.error !== undefined) return false;
      if (!alive.has(f.id) || state.known.has(f.id) || state.tracked.has(f.id)) return false;
      const t = f.plaintext.replace(/\r\n?/g, '\n');
      if (t === trackedNote.plaintext) return true;
      // OUR OWN WRITE under the new id is the strongest identity proof:
      // a fill's CAS can land in Notes even when the osascript errors
      // because the id swapped mid-script — the new note then contains
      // an animation frame ("Draft an email •") while the tracked
      // snapshot still says "_", so content comparison fails by exactly
      // one character and the swap read as deletion, freezing the frame
      // in the note forever (observed live 2026-07-09 13:44). The
      // write-hash ring already holds every text we wrote or intended.
      if (state.lastWriteHash.get(oldId)?.has(hash(t))) return true;
      // Prefix comparison ignores the canonical trailing '\n' — typing
      // appends BEFORE it ("q _\n" grows to "q _ more\n", which is not
      // a string-prefix of the old text without stripping it).
      const bare = (s: string): string => (s.endsWith('\n') ? s.slice(0, -1) : s);
      const tB = bare(t);
      const oldB = bare(trackedNote.plaintext);
      return tB.startsWith(oldB) || oldB.startsWith(tB);
    });
    if (!candidate) continue;
    if (candidate.plaintext!.replace(/\r\n?/g, '\n') === trackedNote.plaintext) {
      // Pure identity swap, zero content change — the same-tick fetch
      // must not read as an edit (no event, no dropVirtual downstream).
      remapSilentIds.add(candidate.id);
    }
    state.tracked.delete(oldId);
    state.tracked.set(candidate.id, { ...trackedNote, id: candidate.id });
    const hashes = state.lastWriteHash.get(oldId);
    if (hashes) {
      state.lastWriteHash.set(candidate.id, hashes);
      state.lastWriteHash.delete(oldId);
    }
    if (state.activeId === oldId) state.activeId = candidate.id;
    events.push({ type: 'id-remapped', from: oldId, to: candidate.id });
  }

  // Deleted notes drop out of every map silently (AN-3 mid-flight rule).
  for (const id of [...state.known.keys()]) {
    if (!alive.has(id)) state.known.delete(id);
  }
  for (const id of [...state.tracked.keys()]) {
    if (!alive.has(id)) {
      state.tracked.delete(id);
      state.lastWriteHash.delete(id);
      events.push({ type: 'untracked', id, reason: 'deleted' });
    }
  }

  let contentChanged = false;
  const prevTexts = new Map<string, string>();
  for (const f of fetched) {
    if (f.error !== undefined || f.plaintext === undefined || f.mod === undefined) {
      if (state.tracked.delete(f.id)) events.push({ type: 'untracked', id: f.id, reason: 'fetch-error' });
      continue;
    }
    const text = f.plaintext.replace(/\r\n?/g, '\n');
    const prev = state.tracked.get(f.id);
    if (prev) prevTexts.set(f.id, prev.plaintext);
    if (prev?.plaintext !== text) contentChanged = true;

    // Election stamp: a USER-sourced content change bumps userEditAt;
    // echoes of our own writes and mod-only bumps carry the prior stamp.
    const isEcho = state.lastWriteHash.get(f.id)?.has(hash(text)) === true;
    const noteChanged = prev === undefined || prev.plaintext !== text;
    const userEditAt = noteChanged && !isEcho ? now : (prev?.userEditAt ?? 0);

    if (text.length > MAX_NOTE_CHARS) {
      if (state.tracked.delete(f.id)) events.push({ type: 'untracked', id: f.id, reason: 'oversize' });
    } else if (containsBlankMarker(text)) {
      state.tracked.set(f.id, { id: f.id, mod: f.mod, plaintext: text, userEditAt });
    } else if (prev) {
      // Marker gone (user finished / erased) — keep tracking briefly? No:
      // untrack; the note re-enters the moment a marker reappears.
      // EXCEPTION: our own fill removes the marker — the note must stay
      // the active buffer so the runtime sees the filled text, not a
      // buffer swap. Echoes stay tracked; user deletions untrack.
      if (isEcho) {
        state.tracked.set(f.id, { id: f.id, mod: f.mod, plaintext: text, userEditAt });
      } else {
        state.tracked.delete(f.id);
        events.push({ type: 'untracked', id: f.id, reason: 'no-marker' });
      }
    }
  }
  for (const n of enumerated) {
    if (n.mod !== null) state.known.set(n.id, n.mod);
  }
  if (contentChanged) state.lastActivityAt = now;

  // Active note = the note the USER last typed in (userEditAt), sticky
  // on ties — the polled equivalent of "the buffer is the editor the
  // user is focused in" on every other host. Never elected: notes the
  // user hasn't edited this session (userEditAt 0) — background mod
  // bumps and our own echoes must not steal the buffer (see TrackedNote).
  let best: TrackedNote | null = null;
  for (const t of state.tracked.values()) {
    if (t.userEditAt === 0) continue;
    if (!best || t.userEditAt > best.userEditAt || (t.userEditAt === best.userEditAt && t.id === state.activeId)) best = t;
  }

  const prevActive = state.activeId;
  if (!best) {
    if (prevActive !== null) {
      state.activeId = null;
      events.push({ type: 'active-gone' });
    }
    return events;
  }

  const source: 'user' | 'runtime' =
    state.lastWriteHash.get(best.id)?.has(hash(best.plaintext)) ? 'runtime' : 'user';

  const prevText = prevTexts.get(best.id);
  const cursor = synthCursorNear(best.plaintext, prevText);
  // Never arm on our own echo — 'runtime' events must not re-trigger.
  const armAt = source === 'user' ? freshMarkerIndex(best.plaintext, prevText) : null;
  if (best.id !== prevActive) {
    state.activeId = best.id;
    events.push({ type: 'switch-active', id: best.id, text: best.plaintext, cursor, source, armAt });
  } else {
    const wasFetched = fetched.some(f => f.id === best!.id && f.error === undefined)
      && !remapSilentIds.has(best.id);
    if (wasFetched) {
      events.push({ type: 'text-change', id: best.id, text: best.plaintext, cursor, source, armAt });
    }
  }
  return events;
}

/** Adaptive cadence: 150ms right after a content change (typing /
 *  loading-animation frames — "instant" detection via live AppleEvents
 *  reads), 500ms while notes are changing (≈ the standard resolver
 *  debounce), 2s idle (the hot-reload standard), 10s paused. */
export function pollDelayMs(state: DaemonState, notesRunning: boolean, now: number): number {
  if (!notesRunning) return POLL_PAUSED_MS;
  const sinceActivity = now - state.lastActivityAt;
  if (sinceActivity < HOT_WINDOW_MS) return POLL_HOT_MS;
  return sinceActivity < ACTIVE_WINDOW_MS ? POLL_ACTIVE_MS : POLL_IDLE_MS;
}

export interface LineDiff {
  /** 0-based index of the first differing line in the old text. */
  start: number;
  oldLines: string[];
  newLines: string[];
}

/**
 * Contiguous line-level diff between the buffer the runtime resolved
 * against and the text it wants written. Returns null when identical.
 * When the changed region is a pure insertion/deletion, the region is
 * widened by one anchor line so the HTML splice always has a non-empty
 * old run to locate.
 */
export function diffLines(oldText: string, newText: string): LineDiff | null {
  if (oldText === newText) return null;
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (
    s < a.length - p && s < b.length - p &&
    a[a.length - 1 - s] === b[b.length - 1 - s]
  ) s++;
  let start = p;
  let oldEnd = a.length - s;
  let newEnd = b.length - s;
  if (oldEnd <= start) {
    // pure insertion — widen with an anchor line
    if (start > 0) start--;
    else if (oldEnd < a.length) oldEnd++;
    newEnd = b.length - (a.length - oldEnd);
  }
  return {
    start,
    oldLines: a.slice(start, oldEnd),
    newLines: b.slice(start, newEnd),
  };
}
