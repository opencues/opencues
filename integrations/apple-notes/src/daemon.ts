// OpenCues Apple Notes daemon.
//
// Polls Notes.app over JXA, feeds the active cue-bearing note into the
// OpenCues runtime as its buffer, and writes blank answers back with a
// compare-and-swap HTML splice. Launched by `opencues run apple-notes`.
//
// The behavioural rules live in ./tick.ts (pure, unit-tested); the
// HTML splice lives in the adapter band's html-text.ts. This file is
// only I/O glue.
//
// Scope: ANY unlocked note containing a standalone `_` blank marker
// (user decision 2026-07-06). Safety inside that scope: attachment-
// bearing notes are skipped, writes are splice-only (never a body
// rebuild), and every write is CAS-verified inside one osascript call.

import { boot, type BootResult } from '@opencues/runtime/dist/adapters/apple-notes/v1/boot';
import {
  spliceLinesIntoBody,
  bodyLooksAttachmentBearing,
} from '@opencues/runtime/dist/adapters/apple-notes/v1/html-text';
import type { LogLevel } from '@opencues/runtime/dist/src/adapter';
import { NotesBridge } from './notes-bridge';
import {
  applyPoll, canonicalizeForEcho, containsBlankMarker, diffLines, ensureTrailingNewline, flushDelayMs,
  freshMarkerIndex, initialState, isRecentWrite, markerCursors, pollDelayMs, recordWriteHash, seedBaseline, selectChanged, synthCursor, synthCursorNear,
  type DaemonState,
} from './tick';
import { buildBlanks, makeSpawnProcess } from './host-support';
import { createHash } from 'node:crypto';
import { appendFileSync, watch as fsWatch } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const LOG_PATH = process.env['OPENCUES_LOG'] ?? '/tmp/opencues.log';
const PERMISSION_RETRY_MS = 30_000;

function log(level: LogLevel, msg: string, data?: unknown): void {
  const line = `[apple-notes][${level}] ${new Date().toISOString()} ${msg}${data !== undefined ? ' ' + safeJson(data) : ''}\n`;
  try { appendFileSync(LOG_PATH, line); } catch { /* log path unwritable */ }
  if (level === 'error' || process.env['DEBUG_OPENCUES']) process.stderr.write(line);
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
// Echo-identity hash: typography-folded (see tick.ts canonicalizeForEcho).
// Splice/CAS paths keep raw bytes; ONLY write-identity uses this.
const echoHash = (s: string): string => sha(canonicalizeForEcho(s));

const PERMISSION_HELP =
  'Notes automation permission denied (TCC -1743). Fix: System Settings → Privacy & Security → ' +
  'Automation → enable Notes under your terminal app. If no prompt ever appeared, a deny is cached: ' +
  'run `tccutil reset AppleEvents <your-terminal-bundle-id>` and retry. See `opencues doctor`.';

// Single-instance lock. Duplicate daemons all write the SAME external
// resource (the user's notes) and treat each other's writes as foreign
// edits, cancelling every fill — bitten three times live (2026-07-06).
const LOCK_PATH = '/tmp/opencues-apple-notes.lock';

function acquireLockOrExit(): void {
  const fsSync = require('node:fs') as typeof import('node:fs');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fsSync.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
      const release = (): void => {
        try {
          if (fsSync.readFileSync(LOCK_PATH, 'utf8') === String(process.pid)) fsSync.unlinkSync(LOCK_PATH);
        } catch { /* already gone */ }
      };
      process.on('exit', release);
      for (const sig of ['SIGINT', 'SIGTERM'] as const) {
        process.on(sig, () => { release(); process.exit(130); });
      }
      return;
    } catch {
      let pid = NaN;
      try { pid = parseInt(fsSync.readFileSync(LOCK_PATH, 'utf8'), 10); } catch { /* unreadable */ }
      let alive = false;
      if (Number.isFinite(pid)) {
        try { process.kill(pid, 0); alive = true; }
        catch (err) {
          // EPERM = the pid exists but belongs to another user (multi-
          // user Mac) — that daemon is alive; only ESRCH means dead.
          alive = (err as NodeJS.ErrnoException)?.code === 'EPERM';
        }
      }
      if (alive) {
        console.error(`opencues apple-notes daemon already running (pid ${pid}) — refusing to start a duplicate.`);
        console.error('Stop it first (Ctrl+C in its terminal, or `kill ' + pid + '`).');
        process.exit(1);
      }
      try { fsSync.unlinkSync(LOCK_PATH); } catch { /* raced */ }
    }
  }
  console.error('could not acquire the apple-notes daemon lock — check ' + LOCK_PATH);
  process.exit(1);
}

export async function main(): Promise<void> {
  acquireLockOrExit();
  const jxaDir = path.join(__dirname, '..', 'jxa');
  const bridge = new NotesBridge(jxaDir);
  const state: DaemonState = initialState(Date.now());

  // Pre-flight: surface the silent-deny trap before booting anything.
  const probe = await bridge.probePermission();
  if (!probe.ok) {
    if (probe.kind === 'permission-denied') {
      log('error', PERMISSION_HELP);
      // Degraded wait — the user may grant the permission without restarting.
      let granted = false;
      while (!granted) {
        await sleep(PERMISSION_RETRY_MS);
        granted = (await bridge.probePermission()).ok;
      }
      log('info', 'Notes automation permission granted — starting.');
    } else {
      log('error', `Notes probe failed (${probe.kind}): ${probe.detail}`);
      process.exitCode = 1;
      return;
    }
  }

  const { registry, blankInvoke } = buildBlanks();

  let bootResult: BootResult;
  let fillChain: Promise<void> = Promise.resolve();

  const activeText = (): string =>
    (state.activeId && state.tracked.get(state.activeId)?.plaintext) || '';

  // Synthetic standalone-`_` arm for the resolver/BlankFill explicit-`_`
  // gate. Keystroke shape: `text` WITHOUT the marker char, cursor at the
  // marker's index — onUnderscoreKey re-inserts and standalone-checks it.
  // Pinned by adapters/apple-notes/v1/apple-notes.scenarios.test.ts.
  const armMarker = (text: string, markerIdx: number): void => {
    bootResult.dispatchKey({
      key: '_',
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      text: text.slice(0, markerIdx) + text.slice(markerIdx + 1),
      cursorOffset: markerIdx,
    });
  };

  // ── Circuit breaker (Windows integration fixes #3+#4, ported) ──────
  // Backstop for UNFORESEEN feedback loops: a real runaway arms the
  // SAME text repeatedly (an echo bouncing); genuine typing arms
  // different text every keystroke. So the breaker counts only
  // CONSECUTIVE same-text arms and resets the moment the text changes —
  // normal typing can never trip it; a true loop pauses resolution
  // triggers briefly instead of spinning forever, and the log names it.
  const ARM_BREAKER_LIMIT = 3;
  // Windows-integration tuning: repeats only count within a short
  // window (a real echo loop re-arms in milliseconds; identical
  // commands minutes apart are legitimate), the cooldown is short (a
  // false trip must not feel like an outage), and comparison is
  // typography-folded (Notes rewrites the armed text's quotes).
  const ARM_REPEAT_WINDOW_MS = 5_000;
  const ARM_BREAKER_COOLOFF_MS = 2_000;
  let lastArmText = '';
  let lastArmAt = 0;
  let armRepeat = 0;
  let breakerUntil = 0;
  // Interrupted-cue recovery (reliability gap: "some prompts work,
  // others don't"). A user edit ELSEWHERE in the note mid-resolution
  // aborts the resolution (their edit wins) — but freshMarkerIndex
  // deliberately never re-arms a marker outside the changed region, so
  // the cue stranded forever unless the user touched its own line. An
  // in-flight cue is NOT a stale cue: remember the armed cue's line;
  // if a marker-less-region edit arrives while that exact line still
  // exists verbatim and the arm was recent, re-arm it.
  const ARM_RECOVERY_MS = 30_000;
  let lastArm: { noteId: string; at: number; line: string } | null = null;
  /** Arm through the breaker. Returns false when suppressed. */
  const armGuarded = (id: string, text: string, armAt: number): boolean => {
    const now = Date.now();
    if (now < breakerUntil) {
      log('warn', 'circuit breaker open — arm suppressed', { id, remainingMs: breakerUntil - now });
      return false;
    }
    const canon = canonicalizeForEcho(text);
    if (canon === lastArmText && now - lastArmAt < ARM_REPEAT_WINDOW_MS) {
      armRepeat++;
    } else {
      lastArmText = canon;
      armRepeat = 1;
    }
    lastArmAt = now;
    if (armRepeat > ARM_BREAKER_LIMIT) {
      breakerUntil = now + ARM_BREAKER_COOLOFF_MS;
      armRepeat = 0;
      lastArmText = '';
      log('warn', `circuit breaker TRIPPED — ${ARM_BREAKER_LIMIT}+ consecutive same-text arms; pausing resolution triggers`, { id, cooloffMs: ARM_BREAKER_COOLOFF_MS });
      return false;
    }
    lastRedispatchText.set(id, text);
    const lineStart = text.lastIndexOf('\n', armAt) + 1;
    const lineEndIdx = text.indexOf('\n', armAt);
    lastArm = { noteId: id, at: now, line: text.slice(lineStart, lineEndIdx === -1 ? text.length : lineEndIdx) };
    armMarker(text, armAt);
    return true;
  };

  /** Re-arm a recently-armed cue whose line survived a user edit
   *  elsewhere in the note. Returns true when it re-armed. */
  const recoverInterruptedArm = (id: string, text: string): boolean => {
    if (!lastArm || lastArm.noteId !== id) return false;
    if (Date.now() - lastArm.at > ARM_RECOVERY_MS) return false;
    if (!containsBlankMarker(text)) return false;
    const lines = text.split('\n');
    // Fold-compare: Notes' typography pass rewrites the ARMED line
    // itself (straight → curly quotes on the user's typed text), so a
    // byte-verbatim match missed and the cue froze on its frame
    // (harness S5 2026-07-09). Same fold as echo identity.
    const target = canonicalizeForEcho(lastArm.line);
    const li = lines.findIndex(l => canonicalizeForEcho(l) === target);
    if (li < 0) return false;
    const lineStart = lines.slice(0, li).join('\n').length + (li > 0 ? 1 : 0);
    const cursorsInLine = markerCursors(lines[li]);
    if (cursorsInLine.length === 0) return false;
    const armAt = lineStart + cursorsInLine[cursorsInLine.length - 1] - 1;
    log('info', 'recovering interrupted cue — re-arming after an edit elsewhere', { id });
    return armGuarded(id, text, armAt);
  };

  // ── Virtual buffer + settle-debounced flush ─────────────────────────
  // The runtime writes eagerly: the blank-loading animator repaints the
  // `_` slot every ~150ms via setText, and blank-fill/resolver commit
  // real answers via pushText/setText. Writing each of those to Notes
  // would mean one osascript CAS per animation frame (observed live:
  // the note stuck on a spinner frame + the real answer dropped when
  // the frame-bearing poll untracked the note). Instead every runtime
  // write lands in an in-memory virtual buffer (served back through
  // getText, so the runtime stays consistent), and ONE CAS flush fires
  // on the short-fuse schedule in tick.ts flushDelayMs — animation
  // frames DO reach the note at frame cadence (see CLAUDE.md).
  let virtualText: string | null = null;
  let virtualNoteId: string | null = null;
  let flushTimer: NodeJS.Timeout | null = null;
  let firstPendingAt: number | null = null;
  // Transient-failure retry budget for the CURRENT virtual content;
  // reset whenever the runtime writes fresh bytes or the buffer drops.
  const FLUSH_RETRY_MAX = 6;
  const FLUSH_RETRY_DELAY_MS = 400;
  let flushRetries = 0;
  let lastFillLandedAt = 0;
  // Render-phase lag instrumentation. Each flush carries the timestamps
  // of its phase boundaries so `fill landed` can report the breakdown
  // (settleMs/queueMs/readMs/spliceMs/casMs/totalMs), mirroring the
  // resolver's totalMs= lines on the other hosts. `echoPending` closes
  // the loop: landed → the poll observing our own write back (echoMs).
  interface FlushTiming { firstPendingAt: number; timerFiredAt: number }
  const echoPending = new Map<string, number>();
  // Per-note redispatch dedupe (a single global string would suppress a
  // legitimately re-typed identical multi-cue text in another note).
  // Cleared on user edits so re-typing the same content can re-fire.
  const lastRedispatchText = new Map<string, string>();

  const dropVirtual = (): void => {
    virtualText = null;
    virtualNoteId = null;
    firstPendingAt = null;
    flushRetries = 0;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  };

  const requestWrite = (rawText: string): void => {
    const id = state.activeId ?? virtualNoteId;
    if (!id) { log('warn', 'runtime write with no active note — dropped'); return; }
    // Store the runtime's bytes EXACTLY — getText serves this back, and
    // the resolver's substitute-time race guard compares it against the
    // buffer it analyzed byte-for-byte. Normalizing here (an appended
    // trailing '\n') made the runtime read back a buffer one byte longer
    // than its own and abort its own substitution (live len=17 vs
    // original len=16, observed 2026-07-08 — whether a TransformBlank
    // answer landed was a race against the flush state). The trailing-
    // newline canonical form is a NOTE-side invariant, so it's applied
    // at flush time (see flushVirtual), not on the runtime's buffer.
    log('debug', 'requestWrite', { lines: rawText.split('\n').length, head: rawText.slice(0, 40) });
    virtualText = rawText;
    virtualNoteId = id;
    flushRetries = 0; // fresh content, fresh retry budget
    const now = Date.now();
    if (firstPendingAt === null) firstPendingAt = now;
    if (flushTimer) clearTimeout(flushTimer);
    // Settle-debounce with a max-wait: streaming animation frames flush
    // the LATEST frame ~once per FLUSH_MAX_WAIT_MS (visible pulse)
    // instead of never settling (frozen `_`) or per-frame (6 writes/s).
    flushTimer = setTimeout(() => {
      const timing: FlushTiming = { firstPendingAt: firstPendingAt ?? Date.now(), timerFiredAt: Date.now() };
      flushTimer = null;
      firstPendingAt = null;
      // Serialize flushes — one CAS in flight at a time.
      fillChain = fillChain.then(() => flushVirtual(timing)).catch(err => {
        log('error', 'fill failed', String(err));
      });
    }, flushDelayMs(now, firstPendingAt));
  };

  async function flushVirtual(timing: FlushTiming): Promise<void> {
    if (virtualText === null || virtualNoteId === null) {
      log('debug', 'flush skipped: virtual buffer empty');
      return;
    }
    const id = virtualNoteId;
    const raw = virtualText;
    // Canonical note form (trailing '\n') is applied HERE, not in
    // requestWrite — the virtual buffer must stay byte-identical to
    // what the runtime wrote (see requestWrite).
    const text = ensureTrailingNewline(raw);
    const snapshot = state.tracked.get(id);
    if (!snapshot) { log('debug', 'flush skipped: note untracked', { id }); dropVirtual(); return; }
    if (text === snapshot.plaintext) {
      // Nothing to write, but KEEP the virtual buffer: getText must go
      // on serving the runtime's own bytes. Dropping here made getText
      // fall back to the tracked snapshot — text NOTES re-serialized
      // (emoji variation selectors don't round-trip byte-identically),
      // i.e. bytes the runtime never wrote. That one-char drift
      // invalidated the transform guard mid-resolution ('live 363 vs
      // original 362'), forcing a discard + full re-resolution per
      // command (observed 2026-07-09 17:14 — 'slow, animations
      // unresponsive'). On every other host the buffer only changes
      // via the runtime's own writes or user keys; retention restores
      // that contract between flushes.
      log('debug', 'flush skipped: no change vs snapshot');
      return;
    }
    log('debug', 'flushing', { lines: text.split('\n').length, head: text.slice(0, 40) });
    const outcome = await doFill(id, snapshot, text, timing);
    // TRANSIENT failures keep the buffer and retry after the poll has
    // resynced the snapshot. Without this, an answer whose one-shot
    // write raced the user's typing was dropped forever ("resyncs next
    // poll" only ever applied to animation frames, which the animator
    // rewrites — the final answer is written exactly once; observed
    // live 2026-07-09: three computed translations, all lost). A user
    // edit still wins: their text-change event calls dropVirtual and
    // cancels the retry.
    if (outcome === 'retry' && virtualText === raw && flushRetries < FLUSH_RETRY_MAX) {
      flushRetries++;
      log('info', `fill retry ${flushRetries}/${FLUSH_RETRY_MAX} scheduled (waiting for snapshot resync)`, { id });
      flushTimer = setTimeout(() => {
        flushTimer = null;
        const retryTiming: FlushTiming = { firstPendingAt: timing.firstPendingAt, timerFiredAt: Date.now() };
        fillChain = fillChain.then(() => flushVirtual(retryTiming)).catch(err => {
          log('error', 'fill retry failed', String(err));
        });
      }, FLUSH_RETRY_DELAY_MS);
      return;
    }
    // Landed, superseded, noop, fatal, or retries exhausted. The buffer
    // is RETAINED either way (see the skip branch above: getText must
    // keep serving the runtime's own bytes; Notes-normalized echo text
    // must never leak into the runtime buffer). It clears only on a
    // genuine user change, a note switch, or active-gone.
    if (virtualText === raw && flushTimer === null) {
      firstPendingAt = null;
      flushRetries = 0;
    }
  }

  // Body cache for consecutive daemon-owned writes (animation frames):
  // skipping the pre-fill readNote halves per-frame latency (~340ms →
  // ~170ms → ~6fps). Safe because the CAS in fill-note.js still
  // byte-verifies the cached body before writing — a stale cache can
  // only produce a conflict, never a corrupting write. Invalidated on
  // any user-sourced poll event, conflict, or splice miss.
  const knownBody = new Map<string, string>();

  // Arm-time cache pre-warm: the FIRST loading frame otherwise pays a
  // cold readNote (~150-190ms) inside its flush. A resolution is
  // guaranteed to write within ~150ms of arming (the animator's first
  // frame), so fetch the body concurrently with the LLM dispatch. Seeded
  // only when the read's plaintext still matches the tracked snapshot;
  // a stale seed is CAS-rejected downstream anyway (never corrupting).
  const prewarmBody = (id: string): void => {
    if (knownBody.has(id)) return;
    void bridge.readNote(id).then(read => {
      if (!read.ok || bodyLooksAttachmentBearing(read.value.body)) return;
      const current = read.value.plaintext.replace(/\r\n?/g, '\n');
      if (state.tracked.get(id)?.plaintext === current && !knownBody.has(id)) {
        knownBody.set(id, read.value.body);
      }
    }).catch(() => { /* best-effort */ });
  };

  async function doFill(
    id: string,
    snapshot: { plaintext: string },
    newText: string,
    timing: FlushTiming,
    retried = false,
  ): Promise<'landed' | 'retry' | 'fatal' | 'noop'> {
    const fillStart = Date.now();
    let readMs = 0;
    let baseBody = knownBody.get(id) ?? null;
    if (baseBody === null) {
      const readStart = Date.now();
      const read = await bridge.readNote(id);
      readMs = Date.now() - readStart;
      if (!read.ok) {
        if (read.kind === 'not-found') {
          // Do NOT untrack here: a freshly UI-created note swaps its
          // temporary CoreData id for the permanent one mid-lifecycle
          // and reads as not-found under the old id. The next poll
          // either remaps the id ('id-remapped' — tracking survives,
          // the pending write retries under the new id) or confirms a
          // genuine deletion via enumeration.
          log('info', 'note not found under this id mid-fill — deferring to the next poll (id swap or deletion)', { id });
        } else {
          log('error', `read before fill failed (${read.kind})`, read.detail);
        }
        return 'retry';
      }
      const currentText = read.value.plaintext.replace(/\r\n?/g, '\n');
      if (bodyLooksAttachmentBearing(read.value.body)) {
        state.tracked.delete(id);
        log('warn', 'note has attachments — skipped to avoid destroying them', { id });
        return 'fatal';
      }
      if (currentText !== snapshot.plaintext) {
        let d = 0;
        while (d < currentText.length && d < snapshot.plaintext.length && currentText[d] === snapshot.plaintext[d]) d++;
        // The poll may NEVER resync this: modificationDate has 1-SECOND
        // resolution, so a keystroke landing in the same second as the
        // previously-fetched state is invisible to change detection
        // (observed live 2026-07-09 15:04: a trailing space typed after
        // `_` desynced the snapshot permanently — six retries dropped
        // and the answer died). We are HOLDING the authoritative fresh
        // text: resync the tracked snapshot ourselves.
        const trackedNow = state.tracked.get(id);
        const isOwnEcho = isRecentWrite(state, id, echoHash(currentText), Date.now());
        log('info', `note changed since resolution — ${isOwnEcho ? 'own echo, retrying against resynced snapshot' : 'user edit wins, re-dispatching'}`, {
          id,
          curLen: currentText.length,
          snapLen: snapshot.plaintext.length,
          firstDiff: d,
          cur: JSON.stringify(currentText.slice(Math.max(0, d - 12), d + 24)),
          snap: JSON.stringify(snapshot.plaintext.slice(Math.max(0, d - 12), d + 24)),
        });
        if (trackedNow) {
          state.tracked.set(id, {
            ...trackedNow,
            plaintext: currentText,
            userEditAt: isOwnEcho ? trackedNow.userEditAt : Date.now(),
          });
        }
        knownBody.set(id, read.value.body);
        if (isOwnEcho) return 'retry';
        // A real user edit mid-fill: their text wins — drop the pending
        // write and re-dispatch so the resolution re-runs against what
        // they actually typed. Identical semantics to a keystroke during
        // resolve on the event-driven hosts. The in-flight marker stays
        // armed: an edit AROUND a live `_` (the trailing-space case)
        // must not orphan it, so fall back to the marker nearest the
        // change when the edit itself doesn't contain one.
        dropVirtual();
        if (id === state.activeId) {
          const armAt = freshMarkerIndex(currentText, snapshot.plaintext)
            ?? (containsBlankMarker(currentText) ? synthCursorNear(currentText, snapshot.plaintext) - 1 : null);
          const cursor = synthCursorNear(currentText, snapshot.plaintext);
          if (armAt !== null) armGuarded(id, currentText, armAt);
          bootResult.notifyTextChange(currentText, cursor, 'user');
        }
        return 'fatal';
      }
      baseBody = read.value.body;
    }
    const spliceStart = Date.now();
    const diff = diffLines(snapshot.plaintext, newText);
    if (!diff) return 'noop';
    // diff.start disambiguates duplicate cue lines (plaintext lines map
    // 1:1 onto body divs — see spliceLinesIntoBody's expectedStart).
    const newBody = spliceLinesIntoBody(baseBody, diff.oldLines, diff.newLines, diff.start);
    const spliceMs = Date.now() - spliceStart;
    if (newBody === null) {
      if (knownBody.delete(id) && !retried) {
        // Cached body drifted (Notes re-serialization) — one fresh-read retry.
        return doFill(id, snapshot, newText, timing, true);
      }
      log('warn', 'could not locate a unique splice region — fill aborted', {
        id, oldLines: diff.oldLines.length,
      });
      return 'retry';
    }
    // Record the INTENDED text's hash before the CAS so a poll reading
    // the note in the write window still classifies it as our echo.
    recordWriteHash(state, id, echoHash(newText), Date.now());
    const casStart = Date.now();
    const fill = await bridge.fillNote({ noteId: id, expectedBody: baseBody, newBody });
    const casMs = Date.now() - casStart;
    if (!fill.ok) {
      knownBody.delete(id);
      log('error', `fill CAS failed (${fill.kind})`, fill.detail);
      return 'retry';
    }
    if (!fill.value.ok) {
      if (knownBody.delete(id) && !retried) {
        // Stale cache CAS-rejected — retry once against a fresh read.
        return doFill(id, snapshot, newText, timing, true);
      }
      log('info', 'fill CAS conflict — note changed under us, dropped', { id });
      return 'retry';
    }
    knownBody.set(id, newBody);
    // Ground-truth echo baseline: hash what Notes says the note NOW
    // contains (fill-note.js returns post-write plaintext), not what we
    // intended to write. Notes does not round-trip every character
    // byte-identically (live failure: the '‾' U+203E loading frame came
    // back altered → echo hash mismatched → our own write classified
    // as a user edit → note untracked → resetBufferState aborted the
    // in-flight LLM call, every time — resolution could never finish).
    const landed = ensureTrailingNewline(fill.value.plaintext.replace(/\r\n?/g, '\n'));
    recordWriteHash(state, id, echoHash(landed), Date.now());
    const tracked = state.tracked.get(id);
    if (tracked) state.tracked.set(id, { ...tracked, plaintext: landed });
    const landedAt = Date.now();
    lastFillLandedAt = landedAt;
    echoPending.set(id, landedAt);
    // Phase breakdown of this render, requestWrite → note updated:
    //   settleMs — flush debounce (frame batching, tick.ts flushDelayMs)
    //   queueMs  — wait behind the prior in-flight CAS (serialized chain)
    //   readMs   — pre-fill body read (0 = knownBody cache hit)
    //   spliceMs — line diff + HTML splice (pure CPU)
    //   casMs    — CAS-verified write, one osascript round-trip
    //   totalMs  — first pending runtime write → fill landed
    log('info', 'fill landed', {
      id,
      lines: diff.newLines.length,
      settleMs: timing.timerFiredAt - timing.firstPendingAt,
      queueMs: fillStart - timing.timerFiredAt,
      readMs,
      spliceMs,
      casMs,
      totalMs: landedAt - timing.firstPendingAt,
    });

    // Multi-cue notes: our own write echoes back as source 'runtime',
    // which the resolver rightly ignores — so any OTHER unanswered `_`
    // in the note would wait forever. Re-dispatch ONCE per distinct
    // filled text: if the resolver answers, the next fill consumes a
    // marker (terminates); if it declines, nothing changes and the
    // dedupe guard stops a loop.
    //
    // The dedupe map is seeded at every arm site (not just here): the
    // loading animation's REST frame restores the slot to `_`, making
    // the landed text byte-identical to the armed text — without the
    // seed, that frame re-dispatched a fake 'user' event mid-resolution,
    // the resolver's live-text guard killed its own in-flight LLM call,
    // and time-to-answer stretched to multiple aborted attempts
    // (observed live 2026-07-08: a draft-email fill took ~20s).
    // Only when the pipeline is DRAINED: the landed fill must be the
    // LATEST runtime write. A frame landing while a newer write (the
    // answer, or a fresher frame) is still pending must never spawn a
    // competing resolution — overlapping resolutions mutually
    // assassinate via the live-text guard (observed 2026-07-09 16:56:
    // typing during animation re-armed per keystroke, a frame fill
    // re-dispatched against stale text, and the sibling's landing
    // buffer change killed the real answer at 'live 151 vs 181').
    const pipelineDrained = virtualText === null || ensureTrailingNewline(virtualText) === newText;
    if (id === state.activeId && pipelineDrained && containsBlankMarker(newText) && newText !== lastRedispatchText.get(id)) {
      lastRedispatchText.set(id, newText);
      log('info', 'unanswered cue remains — re-dispatching', { id });
      const cursor = synthCursor(newText);
      armGuarded(id, newText, cursor - 1);
      bootResult.notifyTextChange(newText, cursor, 'user');
    }
    return 'landed';
  }

  bootResult = boot({
    hostVersion: require('../package.json').version as string,
    cwd: process.cwd(),
    getText: () => virtualText ?? activeText(),
    getCursorOffset: () => synthCursor(virtualText ?? activeText()),
    setText: (text: string) => requestWrite(text),
    setCursorOffset: () => { /* no cursor channel */ },
    forceRender: () => { /* no render surface */ },
    pushText: (text: string) => requestWrite(text),
    readFile: async (p: string) => {
      try { return await fs.readFile(p, 'utf8'); } catch { return null; }
    },
    readDir: async (p: string) => {
      try {
        const entries = await fs.readdir(p, { withFileTypes: true });
        return entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() }));
      } catch { return null; }
    },
    writeFile: async (p: string, c: string) => { await fs.writeFile(p, c); },
    spawnProcess: makeSpawnProcess(),
    blankInvoke,
    blanks: registry,
    // 150ms resolver debounce (default 500): on this POLLED channel the
    // typing stream is already quantized to poll cadence and armMarker
    // fires once per fresh marker — the standard keystroke debounce is
    // redundant and sat directly between `_` and the first animation
    // frame (the user waits it out in full, since typing stops at `_`).
    llmDebounceMs: 150,
    log,
    statusFilePath: `/tmp/opencues-status-${process.pid}.json`,
    llmApiKey: process.env['GROQ_API_KEY'],
    llmEndpoint: process.env['OPENCUES_LLM_ENDPOINT'],
    llmDefaultModel: process.env['OPENCUES_LLM_MODEL'],
    llmApiKeys: {
      GROQ_API_KEY: process.env['GROQ_API_KEY'],
      OPENROUTER_API_KEY: process.env['OPENROUTER_API_KEY'],
      GEMINI_API_KEY: process.env['GEMINI_API_KEY'],
      OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
      ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'],
      CEREBRAS_API_KEY: process.env['CEREBRAS_API_KEY'],
    },
  });

  // ── FSEvents wake — collapse detection lag to the poll's own cost ──
  // Notes.app offers no change-notification API, but every note write
  // (user autosave, cross-device iCloud sync, our own CAS fill) rewrites
  // indexer-state files in its group container within ~1ms (measured
  // 2026-07-08; our own osascript READS fire nothing, so polls can't
  // self-wake). Any container event short-circuits the poll sleep for
  // an immediate tick, so detection costs ~enumeration+fetch instead of
  // up to POLL_IDLE_MS — crucial for the loading-animation frames,
  // whose echo classification otherwise waits out a full sleep. The
  // timer cadence stays as the ground-truth fallback: FSEvents dropping
  // (or the container moving in a future macOS) degrades to today's
  // behaviour, never breaks it.
  let wakeQueued = false;
  let wakeResolve: (() => void) | null = null;
  const wakeNow = (): void => {
    if (wakeResolve) { const r = wakeResolve; wakeResolve = null; r(); }
    else wakeQueued = true;
  };
  const sleepOrWake = (ms: number): Promise<void> => {
    if (wakeQueued) { wakeQueued = false; return Promise.resolve(); }
    return new Promise(r => {
      const t = setTimeout(() => { wakeResolve = null; r(); }, ms);
      wakeResolve = (): void => { clearTimeout(t); r(); };
    });
  };
  const notesContainer = path.join(os.homedir(), 'Library', 'Group Containers', 'group.com.apple.notes');
  try {
    const watcher = fsWatch(notesContainer, { persistent: false }, () => wakeNow());
    process.on('exit', () => watcher.close());
    log('info', 'FSEvents wake enabled — note edits trigger an immediate poll', { dir: notesContainer });
  } catch (err) {
    log('warn', 'FSEvents watch unavailable — timer-only polling', String(err));
  }

  log('info', 'daemon started — watching all unlocked notes for blank markers');

  let permissionLost = false;
  let baselineSeeded = false;
  // Recently-Deleted exclusion set — deleted notes stay in the bulk
  // enumeration for ~30 days and (if tracked) keep competing for the
  // active slot whenever sync bumps their modificationDate, resetting
  // the buffer mid-resolution (observed live 2026-07-08: a deleted
  // note stole the active buffer and the pending answer was lost).
  // Refreshed every DELETED_REFRESH_MS (~90ms osascript, ~1% duty);
  // filtered notes read as "gone" so applyPoll untracks them cleanly.
  const DELETED_REFRESH_MS = 10_000;
  let deletedIds = new Set<string>();
  let deletedRefreshedAt = 0;
  const excludedMods = new Map<string, string>();
  // Poll heartbeat — one info line per HEARTBEAT_MS proving the loop is
  // alive and what it sees (a silent log otherwise can't distinguish
  // "nothing changed" from "poll loop wedged" — that ambiguity cost a
  // debugging session on 2026-07-09).
  const HEARTBEAT_MS = 60_000;
  let heartbeatAt = Date.now();
  let ticks = 0;
  for (;;) {
    const status = await bridge.status();
    const running = status.ok && status.value.running;
    if (running) {
      if (Date.now() - deletedRefreshedAt > DELETED_REFRESH_MS) {
        deletedRefreshedAt = Date.now();
        const del = await bridge.listDeletedIds();
        if (del.ok) deletedIds = new Set(del.value.ids);
      }
      const list = await bridge.listNotes();
      if (list.ok && deletedIds.size > 0) {
        // Visibility before filtering: an edit inside a Recently-Deleted
        // note is otherwise INVISIBLE silence — the user types into a
        // note they deleted earlier (or a recovered one mid-refresh) and
        // nothing happens with no trace (PLAN.md § 1.3).
        for (const n of list.value.notes) {
          if (n.mod !== null && deletedIds.has(n.id) && excludedMods.get(n.id) !== n.mod) {
            if (excludedMods.has(n.id)) {
              log('warn', 'edit detected in a Recently-Deleted note — ignored (recover the note to use cues in it)', { id: n.id });
            }
            excludedMods.set(n.id, n.mod);
          }
        }
        for (const id of [...excludedMods.keys()]) if (!deletedIds.has(id)) excludedMods.delete(id);
        list.value.notes = list.value.notes.filter(n => !deletedIds.has(n.id));
      }
      ticks++;
      if (Date.now() - heartbeatAt >= HEARTBEAT_MS) {
        heartbeatAt = Date.now();
        log('info', 'poll heartbeat', {
          ticks,
          notes: list.ok ? list.value.notes.length : -1,
          excluded: deletedIds.size,
          tracked: state.tracked.size,
          active: state.activeId !== null,
        });
        ticks = 0;
      }
      if (list.ok && !baselineSeeded) {
        // First enumeration = baseline only. Pre-existing cues become
        // eligible when their note is next edited (see seedBaseline).
        seedBaseline(state, list.value.notes);
        baselineSeeded = true;
        log('info', 'baseline seeded — watching for edits from now on (any pre-existing `_` cue is inert until its note is edited again)', { notes: list.value.notes.length });
        await sleepOrWake(pollDelayMs(state, running, Date.now()));
        continue;
      }
      if (!list.ok) {
        if (list.kind === 'permission-denied') {
          if (!permissionLost) {
            permissionLost = true;
            log('error', `permission revoked mid-run. ${PERMISSION_HELP}`);
          }
          await sleep(PERMISSION_RETRY_MS);
          continue;
        }
        log('warn', `enumeration failed (${list.kind})`, list.detail);
      } else {
        if (permissionLost) {
          permissionLost = false;
          log('info', 'permission restored — resuming.');
        }
        const changed = selectChanged(state, list.value.notes, Date.now());
        let fetched: { id: string; mod?: string; plaintext?: string; error?: string }[] = [];
        if (changed.length > 0) {
          const res = await bridge.fetchPlaintexts(changed);
          if (res.ok) fetched = res.value.notes;
          else log('warn', `plaintext fetch failed (${res.kind})`, res.detail);
        }
        // The underscore-count echo guard (marker-add vs mirror) may
        // only judge when the PIPELINE IS QUIET: during an active fill
        // cycle a STALE rest-frame echo (which legitimately contains
        // `_`) can arrive after the answer became the newest write —
        // ring-hit + adds-a-marker then misclassified our own frame as
        // a fresh user trigger and spuriously re-armed (observed live
        // 2026-07-09 20:32 on a slow-Notes fill). A genuine re-type can
        // only happen when nothing is in flight, so the guard loses
        // nothing by sleeping through fills.
        const pipelineQuiet = flushTimer === null && firstPendingAt === null
          && Date.now() - lastFillLandedAt > 3_000;
        const events = applyPoll(state, list.value.notes, fetched, echoHash, Date.now(), pipelineQuiet ? virtualText : null);
        for (const e of events) {
          // Final render phase: our own write observed back by the poll
          // (echo-classified → source 'runtime'). echoMs = landed → seen;
          // upper-bounded by the active poll cadence + osascript reads.
          if ((e.type === 'text-change' || e.type === 'switch-active') && e.source === 'runtime') {
            const landedAt = echoPending.get(e.id);
            if (landedAt !== undefined) {
              echoPending.delete(e.id);
              const echoMs = Date.now() - landedAt;
              // Stale entries (e.g. a note that sat in Recently Deleted
              // and re-matched minutes later) aren't render lag — drop.
              if (echoMs <= 10_000) log('info', 'fill echo observed', { id: e.id, echoMs });
            }
          }
          switch (e.type) {
            case 'switch-active':
              log('info', 'active note switched', { id: e.id });
              dropVirtual(); // real note state wins over any pending write
              knownBody.delete(e.id);
              bootResult.resetBufferState();
              if (e.armAt !== null) {
                if (armGuarded(e.id, e.text, e.armAt)) prewarmBody(e.id);
              }
              bootResult.notifyTextChange(e.text, e.cursor, e.source);
              break;
            case 'text-change':
              // A USER edit invalidates the virtual buffer (their text
              // wins) AND the cached body; our own echo does neither —
              // a flush may still be pending behind it.
              if (e.source === 'user') {
                dropVirtual();
                knownBody.delete(e.id);
                // Update (never clear) the redispatch dedupe to the
                // user's current text: the animator's rest frame equals
                // the CURRENT buffer with `_` restored, so after a mid-
                // load user edit a cleared seed let the next rest frame
                // re-dispatch a spurious resolution (observed 20:01 —
                // a second TransformBlank raced the landing answer).
                // Redispatch still fires for any landed text that
                // DIFFERS from the last user/armed text — i.e. answers.
                lastRedispatchText.set(e.id, e.text);
              }
              if (e.armAt !== null) {
                if (armGuarded(e.id, e.text, e.armAt)) prewarmBody(e.id);
              } else if (e.source === 'user' && recoverInterruptedArm(e.id, e.text)) {
                prewarmBody(e.id);
              }
              // "Only the newest write may echo" (Windows integration
              // §7): a runtime-classified echo of an OLDER frame, while
              // a newer write is pending, must not reach the runtime —
              // it would feed a stale buffer state into the event
              // stream. Tracked state is already updated (CAS needs the
              // note's real content); only the notification is dropped.
              if (
                e.source === 'runtime' && virtualText !== null &&
                ensureTrailingNewline(virtualText) !== e.text
              ) {
                log('debug', 'stale echo suppressed (newer write pending)', { id: e.id });
                break;
              }
              bootResult.notifyTextChange(e.text, e.cursor, e.source);
              break;
            case 'active-gone':
              dropVirtual();
              bootResult.resetBufferState();
              break;
            case 'untracked':
              echoPending.delete(e.id);
              // no-marker untracks are load-bearing evidence: they fire
              // when a marker-less poll text hash-MISSES the write ring
              // (i.e. our own answer was classified as a user edit).
              log('info', 'note untracked', { id: e.id, reason: e.reason });
              break;
            case 'id-remapped': {
              // Same note, new identity (temp → permanent CoreData id).
              // Migrate every id-keyed map; the runtime never notices.
              const migrate = <V>(m: Map<string, V>): void => {
                const v = m.get(e.from);
                if (v !== undefined) { m.set(e.to, v); m.delete(e.from); }
              };
              migrate(knownBody);
              migrate(echoPending);
              migrate(lastRedispatchText);
              if (virtualNoteId === e.from) virtualNoteId = e.to;
              log('info', 'note id remapped (temporary → permanent)', { from: e.from, to: e.to });
              break;
            }
          }
        }
      }
    }
    await sleepOrWake(pollDelayMs(state, running, Date.now()));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/* istanbul ignore next -- entrypoint */
if (require.main === module) {
  main().catch(err => {
    log('error', 'daemon crashed', String(err?.stack ?? err));
    process.exit(1);
  });
}
