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
  applyPoll, containsBlankMarker, diffLines, ensureTrailingNewline, flushDelayMs,
  initialState, pollDelayMs, recordWriteHash, seedBaseline, selectChanged, synthCursor,
  type DaemonState,
} from './tick';
import { buildBlanks, makeSpawnProcess } from './host-support';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
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
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  };

  const requestWrite = (rawText: string): void => {
    const id = state.activeId ?? virtualNoteId;
    if (!id) { log('warn', 'runtime write with no active note — dropped'); return; }
    const newText = ensureTrailingNewline(rawText);
    log('debug', 'requestWrite', { lines: newText.split('\n').length, head: newText.slice(0, 40) });
    virtualText = newText;
    virtualNoteId = id;
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
    const text = virtualText;
    const snapshot = state.tracked.get(id);
    if (!snapshot) { log('debug', 'flush skipped: note untracked', { id }); dropVirtual(); return; }
    if (text === snapshot.plaintext) { log('debug', 'flush skipped: no change vs snapshot'); dropVirtual(); return; }
    log('debug', 'flushing', { lines: text.split('\n').length, head: text.slice(0, 40) });
    await doFill(id, snapshot, text, timing);
    // Only clear if no newer write arrived while the CAS ran.
    if (virtualText === text) dropVirtual();
  }

  // Body cache for consecutive daemon-owned writes (animation frames):
  // skipping the pre-fill readNote halves per-frame latency (~340ms →
  // ~170ms → ~6fps). Safe because the CAS in fill-note.js still
  // byte-verifies the cached body before writing — a stale cache can
  // only produce a conflict, never a corrupting write. Invalidated on
  // any user-sourced poll event, conflict, or splice miss.
  const knownBody = new Map<string, string>();

  async function doFill(
    id: string,
    snapshot: { plaintext: string },
    newText: string,
    timing: FlushTiming,
    retried = false,
  ): Promise<void> {
    const fillStart = Date.now();
    let readMs = 0;
    let baseBody = knownBody.get(id) ?? null;
    if (baseBody === null) {
      const readStart = Date.now();
      const read = await bridge.readNote(id);
      readMs = Date.now() - readStart;
      if (!read.ok) {
        if (read.kind === 'not-found') {
          state.tracked.delete(id);
          log('info', 'note deleted mid-fill — dropped', { id });
        } else {
          log('error', `read before fill failed (${read.kind})`, read.detail);
        }
        return;
      }
      const currentText = read.value.plaintext.replace(/\r\n?/g, '\n');
      if (currentText !== snapshot.plaintext) {
        log('info', 'note changed since resolution — fill dropped (resyncs next poll)', { id });
        return;
      }
      if (bodyLooksAttachmentBearing(read.value.body)) {
        state.tracked.delete(id);
        log('warn', 'note has attachments — skipped to avoid destroying them', { id });
        return;
      }
      baseBody = read.value.body;
    }
    const spliceStart = Date.now();
    const diff = diffLines(snapshot.plaintext, newText);
    if (!diff) return;
    const newBody = spliceLinesIntoBody(baseBody, diff.oldLines, diff.newLines);
    const spliceMs = Date.now() - spliceStart;
    if (newBody === null) {
      if (knownBody.delete(id) && !retried) {
        // Cached body drifted (Notes re-serialization) — one fresh-read retry.
        return doFill(id, snapshot, newText, timing, true);
      }
      log('warn', 'could not locate a unique splice region — fill aborted', {
        id, oldLines: diff.oldLines.length,
      });
      return;
    }
    // Record the INTENDED text's hash before the CAS so a poll reading
    // the note in the write window still classifies it as our echo.
    recordWriteHash(state, id, sha(newText));
    const casStart = Date.now();
    const fill = await bridge.fillNote({ noteId: id, expectedBody: baseBody, newBody });
    const casMs = Date.now() - casStart;
    if (!fill.ok) {
      knownBody.delete(id);
      log('error', `fill CAS failed (${fill.kind})`, fill.detail);
      return;
    }
    if (!fill.value.ok) {
      if (knownBody.delete(id) && !retried) {
        // Stale cache CAS-rejected — retry once against a fresh read.
        return doFill(id, snapshot, newText, timing, true);
      }
      log('info', 'fill CAS conflict — note changed under us, dropped', { id });
      return;
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
    recordWriteHash(state, id, sha(landed));
    const tracked = state.tracked.get(id);
    if (tracked) state.tracked.set(id, { ...tracked, plaintext: landed });
    const landedAt = Date.now();
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
    if (id === state.activeId && containsBlankMarker(newText) && newText !== lastRedispatchText.get(id)) {
      lastRedispatchText.set(id, newText);
      log('info', 'unanswered cue remains — re-dispatching', { id });
      const cursor = synthCursor(newText);
      armMarker(newText, cursor - 1);
      bootResult.notifyTextChange(newText, cursor, 'user');
    }
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

  log('info', 'daemon started — watching all unlocked notes for blank markers');

  let permissionLost = false;
  let baselineSeeded = false;
  for (;;) {
    const status = await bridge.status();
    const running = status.ok && status.value.running;
    if (running) {
      const list = await bridge.listNotes();
      if (list.ok && !baselineSeeded) {
        // First enumeration = baseline only. Pre-existing cues become
        // eligible when their note is next edited (see seedBaseline).
        seedBaseline(state, list.value.notes);
        baselineSeeded = true;
        log('info', 'baseline seeded — watching for edits from now on', { notes: list.value.notes.length });
        await sleep(pollDelayMs(state, running, Date.now()));
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
        const changed = selectChanged(state, list.value.notes);
        let fetched: { id: string; mod?: string; plaintext?: string; error?: string }[] = [];
        if (changed.length > 0) {
          const res = await bridge.fetchPlaintexts(changed);
          if (res.ok) fetched = res.value.notes;
          else log('warn', `plaintext fetch failed (${res.kind})`, res.detail);
        }
        const events = applyPoll(state, list.value.notes, fetched, sha, Date.now());
        for (const e of events) {
          // Final render phase: our own write observed back by the poll
          // (echo-classified → source 'runtime'). echoMs = landed → seen;
          // upper-bounded by the active poll cadence + osascript reads.
          if ((e.type === 'text-change' || e.type === 'switch-active') && e.source === 'runtime') {
            const landedAt = echoPending.get(e.id);
            if (landedAt !== undefined) {
              echoPending.delete(e.id);
              log('info', 'fill echo observed', { id: e.id, echoMs: Date.now() - landedAt });
            }
          }
          switch (e.type) {
            case 'switch-active':
              log('info', 'active note switched', { id: e.id });
              dropVirtual(); // real note state wins over any pending write
              knownBody.delete(e.id);
              bootResult.resetBufferState();
              if (e.armAt !== null) armMarker(e.text, e.armAt);
              bootResult.notifyTextChange(e.text, e.cursor, e.source);
              break;
            case 'text-change':
              // A USER edit invalidates the virtual buffer (their text
              // wins) AND the cached body; our own echo does neither —
              // a flush may still be pending behind it.
              if (e.source === 'user') {
                dropVirtual();
                knownBody.delete(e.id);
                lastRedispatchText.delete(e.id);
              }
              if (e.armAt !== null) armMarker(e.text, e.armAt);
              bootResult.notifyTextChange(e.text, e.cursor, e.source);
              break;
            case 'active-gone':
              dropVirtual();
              bootResult.resetBufferState();
              break;
            case 'untracked':
              echoPending.delete(e.id);
              if (e.reason !== 'no-marker') log('info', 'note untracked', { id: e.id, reason: e.reason });
              break;
          }
        }
      }
    }
    await sleep(pollDelayMs(state, running, Date.now()));
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
