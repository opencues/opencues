/**
 * Agentic test harness — file-based IPC for driving the runtime without a
 * human at the keyboard.
 *
 * Armed by setting `OPENCUES_AGENTIC=1` before launching any host. The
 * runtime then polls `/tmp/opencues-inject-<pid>.txt` every 100 ms; each
 * non-empty line is one command:
 *
 *     text:<s>           — adapter.setText(s) + forceRender (clears highlight)
 *     text-keep-hl:<s>   — same, but the highlight survives (programmatic-write semantics)
 *     cursor:<n>         — adapter.setCursorOffset(n) + forceRender
 *     key:<name>:<mods>  — synthesise a KeyEvent + dispatch through the host pipeline.
 *                          mods is a `+`-joined subset of {ctrl, alt, shift, meta}.
 *                          example:  key:up:ctrl+alt
 *     dump               — write full runtime state to /tmp/opencues-agentic-dump-<pid>.json
 *     clear              — empty the buffer + reset cursor
 *     wait:<ms>          — no-op marker (the file is consumed in one cycle; this exists
 *                          for self-documenting multi-line scripts)
 *
 * Reads (Claude / a test runner consumes these):
 *
 *     /tmp/opencues-status-<pid>.json          Statusline export (already wired)
 *     /tmp/opencues-cursor-state-<pid>.json    CursorStateExport (already wired)
 *     /tmp/opencues-agentic-dump-<pid>.json    Full state — written on demand by `dump`
 *     /tmp/opencues.log                        Runtime debug log (already wired)
 *
 * Mounted from each host's boot.ts at the very end:
 *
 *     if (process.env.OPENCUES_AGENTIC === '1') {
 *       startAgenticHarness({ adapter, dispatchKey, state: shared, hostName, hostVersion });
 *     }
 *
 * Returns a handle with `stop()` (clearInterval) and `poll()` (manual cycle —
 * lets unit tests drive the loop without timing dependence).
 */

import * as fs from 'node:fs';
import type { HostAdapter, KeyEvent } from './adapter';

export interface AgenticState {
  /** Runtime state classes — anything serializable goes into the dump. */
  readonly hlState?: unknown;
  readonly dynDefs?: unknown;
  readonly spanFillState?: unknown;
  readonly dismissedBlanks?: unknown;
  readonly selectorSatelliteState?: unknown;
  readonly agentTaskState?: unknown;
}

export interface AgenticBindings {
  readonly adapter: HostAdapter;
  /**
   * Host-specific callback that runs a synthetic KeyEvent through the
   * same key pipeline real keystrokes use. CC v2.1's bootResult.dispatchKey
   * takes (rawEvent, text, cursor); OC + Gemini take just (KeyEvent). Each
   * host wraps its own bootResult to match this single signature.
   */
  dispatchKey(event: KeyEvent): boolean;
  /**
   * Fire a synthetic textChange event after a setText, so the Resolver,
   * Statusline, CursorStateExport — anything that subscribes to
   * `adapter.onTextChange` — picks up the change.
   *
   * Why this is needed: the OC + Gemini hosts wire textChange via their
   * input component's `onContentChange` callback, which only fires for
   * real keystrokes (insertChar/deleteChar). OpenTUI's `replaceText` —
   * which is what `adapter.setText` lands on — does NOT fire
   * onContentChange. So programmatic writes from the harness silently
   * skip the event chain unless we re-emit here.
   *
   * Optional — if the host doesn't supply it, the harness skips the
   * notify (CC v2.1 in particular tracks drift through applyRender
   * instead of textChange events; its harness wiring leaves this null).
   */
  notifyTextChange?(text: string, cursor: number, source: 'user' | 'runtime'): void;
  /** Same shape, for cursor-only moves. Optional. */
  notifyCursorChange?(text: string, cursor: number, source: 'user' | 'runtime'): void;
  readonly state: AgenticState;
}

export interface AgenticHarnessHandle {
  /** Stop the polling interval. Idempotent. */
  stop(): void;
  /**
   * Manually run one poll cycle (consume the inject file if present).
   * For unit tests — bypasses the 100 ms timer.
   */
  poll(): void;
  /** Paths of the IPC files this harness is reading/writing. */
  readonly paths: {
    readonly inject: string;
    readonly dump: string;
    /** Single canonical pidfile — `cat $pid` to learn the host's PID. */
    readonly pid: string;
  };
}

const POLL_INTERVAL_MS = 100;

/**
 * Arm the agentic test harness. No-op + warning if OPENCUES_AGENTIC isn't '1'
 * — callers gate on the env var themselves so tests can mount it explicitly.
 */
export function startAgenticHarness(b: AgenticBindings): AgenticHarnessHandle {
  const pid = process.pid;
  const injectFile = `/tmp/opencues-inject-${pid}.txt`;
  const dumpFile = `/tmp/opencues-agentic-dump-${pid}.json`;
  // Single canonical pidfile so callers don't have to grep the log or
  // glob /tmp/opencues-status-*.json. Last-writer-wins (one armed host
  // per pidfile path); per-host scoping comes for free via the
  // OPENCUES_AGENTIC_PID_FILE env override (e.g. set it to
  // `/tmp/opencues-agentic-cc.pid` when running CC alongside OC).
  const pidFile = process.env.OPENCUES_AGENTIC_PID_FILE
    ?? `/tmp/opencues-agentic.pid`;

  const log = (msg: string, data?: unknown): void => {
    try { b.adapter.log('info', `[agentic] ${msg}`, data); } catch { /* swallow */ }
  };

  // Write the pidfile up front. The agentic harness lives inside the
  // host process, so process.pid IS the pid that owns
  // /tmp/opencues-inject-<pid>.txt + the dump file. A test runner can
  // do `PID=$(cat /tmp/opencues-agentic.pid)` instead of discovery.
  try {
    fs.writeFileSync(pidFile, String(pid));
  } catch (err) {
    log('pidfile write failed', { pidFile, err: String(err) });
  }

  log('harness armed', { pid, injectFile, dumpFile, pidFile });

  function runCommands(text: string): void {
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      try { runOneCommand(line); } catch (err) {
        log('command error', { line: line.slice(0, 100), err: String(err) });
      }
    }
  }

  function runOneCommand(line: string): void {
    const colonIdx = line.indexOf(':');
    const cmd = colonIdx >= 0 ? line.slice(0, colonIdx) : line;
    const arg = colonIdx >= 0 ? line.slice(colonIdx + 1) : '';

    log('command', { cmd, arg: arg.slice(0, 120) });

    switch (cmd) {
      case 'text':
      case 'text-keep-hl': {
        // Two-step write: (1) put the text in the buffer; (2) fire a
        // synthetic textChange event so the Resolver / Statusline /
        // CursorStateExport actually see it. Step 2 is needed because
        // OpenTUI's `replaceText` (what setText lands on for OC/Gemini)
        // doesn't fire onContentChange — only real keystrokes do.
        // `text:` claims user-typing semantics (Navigation will clear
        // any existing highlight); `text-keep-hl:` claims runtime-write
        // semantics (highlight survives, mirrors the bootstrap's
        // sourceReclassifier path).
        b.adapter.setText(arg);
        const source: 'user' | 'runtime' = cmd === 'text-keep-hl' ? 'runtime' : 'user';
        b.notifyTextChange?.(arg, b.adapter.getCursorOffset(), source);
        b.adapter.forceRender();
        break;
      }
      case 'cursor': {
        const offset = parseInt(arg, 10);
        if (Number.isFinite(offset) && offset >= 0) {
          b.adapter.setCursorOffset(offset);
          b.notifyCursorChange?.(b.adapter.getText(), offset, 'user');
          b.adapter.forceRender();
        } else {
          log('cursor: bad offset', { arg });
        }
        break;
      }
      case 'key': {
        const event = parseKeyArg(arg, b.adapter);
        const consumed = b.dispatchKey(event);
        log('key dispatched', { key: event.key, mods: event.modifiers, consumed });
        break;
      }
      case 'clear': {
        b.adapter.setText('');
        b.adapter.setCursorOffset(0);
        b.notifyTextChange?.('', 0, 'user');
        b.adapter.forceRender();
        break;
      }
      case 'dump': {
        writeDump();
        break;
      }
      case 'wait': {
        // Documentation-only — see the file-header note.
        break;
      }
      default:
        log('unknown command', { line: line.slice(0, 100) });
    }
  }

  function writeDump(): void {
    try {
      const dump = {
        text: safeCall(() => b.adapter.getText()),
        cursor: safeCall(() => b.adapter.getCursorOffset()),
        highlight: serializeHighlight(b.state.hlState),
        dynDefs: serializeDynDefs(b.state.dynDefs),
        spanFill: serializeOpaque(b.state.spanFillState),
        dismissedBlanks: serializeOpaque(b.state.dismissedBlanks),
        selectorSatellite: serializeOpaque(b.state.selectorSatelliteState),
        agentTask: serializeAgentTask(b.state.agentTaskState),
        capabilities: b.adapter.capabilities,
        pid,
        host: b.adapter.hostName,
        hostVersion: b.adapter.hostVersion,
        timestamp: new Date().toISOString(),
      };
      fs.writeFileSync(dumpFile, JSON.stringify(dump, null, 2));
      log('dump written', { dumpFile, bytes: 0 });
    } catch (err) {
      log('dump failed', { err: String(err) });
    }
  }

  let active = true;

  function poll(): void {
    if (!active) return;
    let raw: string | null = null;
    try {
      if (!fs.existsSync(injectFile)) return;
      raw = fs.readFileSync(injectFile, 'utf8');
      // Atomic consume: delete BEFORE running commands so a crash
      // mid-execution doesn't replay the same script next tick.
      fs.unlinkSync(injectFile);
    } catch (err) {
      log('poll read failed', { err: String(err) });
      return;
    }
    if (raw == null || raw === '') return;
    runCommands(raw);
  }

  const interval = setInterval(poll, POLL_INTERVAL_MS);

  return {
    stop() {
      if (!active) return;
      active = false;
      clearInterval(interval);
      // Best-effort pidfile cleanup. Only delete if the file's contents
      // still match THIS process — avoids racing with a newer host
      // instance that already overwrote the pidfile (we'd otherwise
      // leave the new host with a missing pidfile).
      try {
        if (fs.existsSync(pidFile)) {
          const owner = fs.readFileSync(pidFile, 'utf8').trim();
          if (owner === String(pid)) fs.unlinkSync(pidFile);
        }
      } catch { /* swallow */ }
      log('harness stopped', { pid });
    },
    poll,
    paths: { inject: injectFile, dump: dumpFile, pid: pidFile },
  };
}

// ─── Key parsing ────────────────────────────────────────────────────────

/**
 * Parse a `key:` argument string into a KeyEvent.
 *
 * Format:  <name>:<mods>
 *   name:  the canonical key name (left, right, up, down, escape, return, ...)
 *   mods:  `+`-joined subset of {ctrl, alt, shift, meta}, or empty for none
 *
 * Examples:
 *   "up:ctrl+alt"      → Ctrl+Alt+Up
 *   "left:"            → bare Left arrow
 *   "escape"           → Escape (no mods)
 *
 * The KeyEvent's text + cursorOffset are sampled from the adapter at
 * dispatch time so the synthesised event matches what a real keystroke
 * would carry.
 */
function parseKeyArg(arg: string, adapter: HostAdapter): KeyEvent {
  const colon = arg.indexOf(':');
  const name = (colon >= 0 ? arg.slice(0, colon) : arg).trim().toLowerCase();
  const modsRaw = colon >= 0 ? arg.slice(colon + 1).trim() : '';
  const mods = modsRaw.split('+').map(m => m.trim()).filter(Boolean);
  return {
    key: name,
    modifiers: {
      ctrl: mods.includes('ctrl'),
      alt: mods.includes('alt'),
      shift: mods.includes('shift'),
      meta: mods.includes('meta'),
    },
    text: safeCall(() => adapter.getText()) ?? '',
    cursorOffset: safeCall(() => adapter.getCursorOffset()) ?? 0,
  };
}

// ─── Serialization helpers ──────────────────────────────────────────────

function safeCall<T>(fn: () => T): T | null {
  try { return fn(); } catch { return null; }
}

/**
 * Best-effort serialization of an opaque state object: enumerate own
 * properties + simple getters, skip functions, replace anything that
 * fails JSON.stringify (circular refs, weak refs) with a sentinel.
 */
function serializeOpaque(obj: unknown): unknown {
  if (obj == null) return null;
  if (typeof obj !== 'object') return obj;
  const out: Record<string, unknown> = {};
  // Own enumerable keys
  for (const k of Object.keys(obj as object)) {
    try {
      const v = (obj as Record<string, unknown>)[k];
      if (typeof v === 'function') continue;
      JSON.stringify(v);
      out[k] = v;
    } catch {
      out[k] = '<unserializable>';
    }
  }
  // Simple getters on the prototype (HighlightState, DynDefs, etc. expose
  // their state via getters, not direct fields).
  const proto = Object.getPrototypeOf(obj as object);
  if (proto) {
    for (const k of Object.getOwnPropertyNames(proto)) {
      if (k === 'constructor' || k in out) continue;
      const desc = Object.getOwnPropertyDescriptor(proto, k);
      if (!desc?.get) continue;
      try {
        const v = (obj as Record<string, unknown>)[k];
        if (typeof v === 'function') continue;
        JSON.stringify(v);
        out[k] = v;
      } catch {
        out[k] = '<unserializable>';
      }
    }
  }
  return out;
}

/**
 * HighlightState-aware view: surfaces the public read shape the v1
 * harness assertions all relied on (active / wordIndex / text), plus
 * any other getter the class exposes.
 */
function serializeHighlight(hl: unknown): unknown {
  if (hl == null) return { active: false };
  const opaque = serializeOpaque(hl) as Record<string, unknown>;
  // Always normalise the canonical fields even if the class shape evolves.
  return {
    active: !!opaque.active,
    wordIndex: opaque.wordIndex ?? null,
    text: opaque.text ?? '',
    ...opaque,
  };
}

/**
 * DynDefs-aware view: dumps the defs array (each def serialized
 * opaquely) plus any other public getters.
 */
function serializeDynDefs(dd: unknown): unknown {
  if (dd == null) return null;
  const view = serializeOpaque(dd) as Record<string, unknown>;
  // DynDefs typically tracks defs as an internal Map — try common shapes.
  const internal = dd as { defs?: unknown[]; size?: number; _defs?: unknown[] };
  let defs: unknown[] | undefined;
  if (Array.isArray(internal.defs)) defs = internal.defs;
  else if (Array.isArray(internal._defs)) defs = internal._defs;
  if (defs) view.defs = defs.map(d => serializeOpaque(d));
  return view;
}

/**
 * AgentTaskState-aware view: armed / taskId / prompt are the keys the
 * statusline + tests inspect.
 */
function serializeAgentTask(ats: unknown): unknown {
  if (ats == null) return null;
  return serializeOpaque(ats);
}
