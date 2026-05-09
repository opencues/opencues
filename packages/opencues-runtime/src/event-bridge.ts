// Internal event bridge — file-based IPC channel for off-process
// observation of the runtime. Off by default; armed at boot when
// OPENCUES_BRIDGE=1. External tooling writes inject scripts and reads
// JSONL event streams; nothing in the runtime depends on it.
//
// ─── How it works ──────────────────────────────────────────────────────
//
// Armed by setting `OPENCUES_BRIDGE=1` before launching any host. Each
// host band (CC v2.1 / OC v1.4 / Gemini v0.41) calls `startEventBridge`
// at the end of its boot() sequence with bindings to the local adapter,
// dispatchKey closure, and shared state classes. The bridge then:
//
//   1. Polls /tmp/opencues-inject-<pid>.txt every 100 ms. Each non-empty
//      line is one command (see CommandRunner). Atomically consumed:
//      file deleted before commands run, so a crash mid-script can't
//      replay it.
//
//   2. Subscribes to adapter.onTextChange / .onCursorChange / .onKey to
//      observe what the runtime did in response (or what the user did,
//      when the bridge shares an instance with a live user).
//
//   3. Probes state classes (HighlightState, DynDefs, AgentTaskState,
//      SpanFillState, SelectorSatelliteState) on every tick. Transitions
//      since the previous tick emit structured events.
//
//   4. Writes every observation to /tmp/opencues-events-<pid>.jsonl as
//      append-only newline-delimited JSON. Consumers can stream-tail
//      this file or read it as a snapshot — same fields either way.
//
//   5. On the `dump` command, writes the full state snapshot to
//      /tmp/opencues-bridge-dump-<pid>.json (richer than what fits in
//      the event stream — the entire DynDefs Map, full SpanFill object,
//      capabilities, host metadata).
//
//   6. On arm, writes its own pid to /tmp/opencues-bridge.pid (or the
//      OPENCUES_BRIDGE_PID_FILE override) so callers can grab it
//      without grepping. Removed on stop.
//
// ─── Inject command grammar ────────────────────────────────────────────
//
//   text:<s>           → adapter.setText(s) + notifyTextChange(source=user)
//   text-keep-hl:<s>   → same, source=runtime (highlight survives)
//   cursor:<n>         → adapter.setCursorOffset(n) + notifyCursorChange
//   key:<name>:<mods>  → synthesise KeyEvent through dispatchKey.
//                        mods is `+`-joined: ctrl+alt+shift+meta
//   clear              → buffer:='', cursor:=0
//   dump               → write full state to dump file
//   wait:<ms>          → no-op marker (the file is consumed in one cycle;
//                        scripts split across multiple writes can sleep
//                        in the driver between writes)
//
// ─── Files written ─────────────────────────────────────────────────────
//
//   /tmp/opencues-bridge.pid              pidfile, OPENCUES_BRIDGE_PID_FILE override
//   /tmp/opencues-events-<pid>.jsonl      event stream, OPENCUES_BRIDGE_EVENTS_FILE override
//   /tmp/opencues-bridge-dump-<pid>.json  full state snapshot, on `dump` command
//
// ─── Files read ────────────────────────────────────────────────────────
//
//   /tmp/opencues-inject-<pid>.txt        consumed atomically every 100 ms
//
// ─── Why polling instead of inotify ────────────────────────────────────
//
// inotify is OS-specific and adds a binding dependency. The poll
// interval (100 ms) is well below the LLM round-trip (200-1500 ms), so
// any consumer's effective response time is dominated by host
// processing, not poll latency. This module deliberately has zero
// external dependencies — only node:fs.
//
// ─── Versioning ────────────────────────────────────────────────────────
//
// Every event carries v:1 (EVENT_BRIDGE_SCHEMA_VERSION). Future schema
// changes that aren't backwards-compatible bump the integer; consumers
// gate on it. Add new event TYPES freely (consumers ignore unknown
// types) — the version only changes when existing types' shape
// changes.

import * as fs from 'node:fs';
import type { HostAdapter, KeyEvent } from './adapter';

// ─── Public API types ────────────────────────────────────────────────────

export const EVENT_BRIDGE_SCHEMA_VERSION = 1;

/**
 * Every event the harness emits to the JSONL stream. Tagged union for
 * exhaustive consumer matching. Add new types freely (consumers must
 * tolerate unknown types); only modify existing shapes when bumping
 * EVENT_BRIDGE_SCHEMA_VERSION.
 */
export type BridgeEventBody =
  // Lifecycle
  | { type: 'harness.armed'; host: string; hostVersion: string; capabilities: readonly string[] }
  | { type: 'harness.stopped' }
  // Inject command flow
  | { type: 'command'; cmd: string; arg: string }
  | { type: 'command.error'; cmd: string; arg: string; error: string }
  | { type: 'command.unknown'; line: string }
  | { type: 'text.injected'; text: string; source: 'user' | 'runtime'; cursor: number }
  | { type: 'cursor.injected'; cursor: number }
  | { type: 'cleared' }
  | { type: 'key.dispatched'; key: string; modifiers: KeyEvent['modifiers']; consumed: boolean }
  | { type: 'dump.written'; path: string }
  // Adapter-observed text/cursor changes (synthetic AND real). Source
  // mirrors TextChangeEvent.source — widened beyond user|runtime so
  // future host-emitted or unknown-origin events flow through cleanly.
  | { type: 'text.changed'; text: string; cursor: number; source: 'user' | 'runtime' | 'host' | 'unknown'; previousText: string }
  | { type: 'cursor.changed'; text: string; cursor: number; source: 'user' | 'runtime' | 'host' | 'unknown' }
  // State-class transitions (poll-diff)
  | { type: 'highlight.activated'; wordIndex: number; word: string }
  | { type: 'highlight.deactivated' }
  | { type: 'highlight.word-changed'; wordIndex: number; word: string; previousWordIndex: number | null }
  | { type: 'dyn-defs.size-changed'; size: number; previousSize: number }
  | { type: 'agent-task.armed'; taskId: string; prompt: string }
  | { type: 'agent-task.stopped' }
  | { type: 'span-fill.started'; entry: unknown }
  | { type: 'span-fill.completed'; lastFilledText: string }
  | { type: 'selector-satellite.started'; entry: unknown }
  | { type: 'selector-satellite.completed' }
  // Module-emitted events (via adapter.emitEvent) — these flow through
  // unchanged from the modules, with whatever shape they emit. The
  // tagged-union entries below document the canonical shapes the
  // harness's reference modules produce; consumers should treat
  // `body` for these events as best-effort and tolerate missing fields.
  | { type: 'resolver.started'; text: string; textLen: number; generation: number }
  | { type: 'resolver.completed'; text: string; textLen: number; cleanWords: number; resultCount: number; latencyMs: number; generation: number; routing: ReadonlyArray<{ wordIndex: number; word: string; sourceId: string }>; skipped: ReadonlyArray<{ wordIndex: number; word: string }> }
  | { type: 'blank.invoked'; blankName: string; keyword: string; contextWords: readonly string[] }
  | { type: 'blank.substituted'; blankName: string; keyword: string; input: string; output: string; altCount: number; dismissible: boolean }
  | { type: 'agent-rewrite.round-started'; taskId: string | null; prompt: string; textLen: number; cursor: number }
  | { type: 'agent-rewrite.round-completed'; taskId: string | null; applied: number; dropped: number; userHunks: number; latencyMs: number }
  | { type: 'transform-blank.started'; textLen: number; blankIdx: number }
  | { type: 'transform-blank.pass-completed'; pass: 'P1' | 'P2' | 'P3'; latencyMs: number; verdict?: string; instruction?: string; target?: string; step?: number; totalSteps?: number }
  | { type: 'transform-blank.completed'; finalLen: number; finalPreview: string; latencyMs: number }
  | { type: 'transform-blank.bailed'; reason: string; latencyMs: number }
  | { type: 'fluid-blank.started'; textLen: number; blankIdx: number }
  | { type: 'fluid-blank.pass-completed'; pass: 'P1' | 'P3'; latencyMs: number; span?: string; context?: string; answer?: string }
  | { type: 'fluid-blank.completed'; span: string; answer: string; mode: string; latencyMs: number }
  | { type: 'fluid-blank.bailed'; reason: string; latencyMs: number }
  // Cycling — Ctrl+Alt+Up/Down landed on a successful cycle. `path`
  // names the dispatch branch in Cycling.step (static-alts, list-blank,
  // span-fill, blank-step, selector, satellite). Field set varies by
  // path: alt-index paths populate from/toAltIndex; numeric/selector
  // paths populate from/toText.
  | { type: 'cycling.cycled'; wordIndex: number; direction: 1 | -1; path: 'static-alts' | 'list-blank' | 'span-fill' | 'blank-step' | 'selector' | 'satellite'; fromAltIndex?: number; toAltIndex?: number; fromText?: string; toText?: string }
  // ConfigLoader finished a (re)load. Fires from both the initial
  // `load()` and every hot-reload `maybeReload()` round. `cueEntries`
  // is the size of the merged cueMap; `blankCount` is the configured
  // blank count.
  | { type: 'config.reloaded'; cueEntries: number; blankCount: number; voiceMode: string; tipsMode: string; debugMode: string; cursorNavigate: string }
  // TTS spoke a phrase. Fires once per (wordIndex, displayed) tuple,
  // after the spawnProcess / speakFn call has been initiated. `via`
  // distinguishes the dispatch path: spawnProcess (CC, OC) vs speakFn
  // (Chrome / Web Speech). `source` names which lookup produced the tip.
  | { type: 'tts.spoken'; phrase: string; rate: string; wordIndex: number; displayed: string; original: string; source: 'span' | 'selector' | 'satellite' | 'lookup'; via: 'speakFn' | 'spawnProcess' }
  // Statusline barrier — emitted AFTER the status file's writeFile
  // promise resolves, so consumers can treat it as "the file at
  // exportPath is now fresh." Eliminates races between the harness's
  // synchronous StateProbe events and Statusline's async file write.
  // Body is the full StatuslinePayload + the exportPath that was
  // written.
  | { type: 'statusline.snapshot'; exportPath: string; [k: string]: unknown }
  // Cursor-state barrier — emitted AFTER cursor-state-export's
  // writeFile resolves. Body is the full CursorStateSnapshot + the
  // exportPath that was written. Lets scenarios assert "the file at
  // exportPath now reflects this text/cursor pair" without racing the
  // 100ms write debounce.
  | { type: 'cursor-state.snapshot'; exportPath: string; text: string; cursorPosition: number; currentWord: string; atEnd: boolean; textLength: number; timestamp: number }
  // Catch-all for module-emitted types not yet promoted to the canonical list.
  | { type: string; [k: string]: unknown }
  ;

export interface BridgeEvent {
  /** ms since epoch (Date.now()). */
  readonly ts: number;
  /** EVENT_BRIDGE_SCHEMA_VERSION at time of emit. */
  readonly v: number;
  /** Host process pid. */
  readonly pid: number;
  /** Tagged-union body. */
  readonly body: BridgeEventBody;
}

export interface BridgeState {
  readonly hlState?: unknown;
  readonly dynDefs?: unknown;
  readonly spanFillState?: unknown;
  readonly dismissedBlanks?: unknown;
  readonly selectorSatelliteState?: unknown;
  readonly agentTaskState?: unknown;
}

export interface BridgeBindings {
  readonly adapter: HostAdapter;
  /**
   * Synthetic-key dispatch. CC v2.1 wraps bootResult.dispatchKey to
   * sample text/cursor at the dispatch site (its closures are stale
   * across React re-renders); OC + Gemini bind directly. Each host
   * normalises to this single signature.
   */
  dispatchKey(event: KeyEvent): boolean;
  /**
   * Fire a synthetic textChange after a setText. OpenTUI's `replaceText`
   * doesn't fire onContentChange — only real keystrokes do — so the
   * host's onTextChange chain skips programmatic writes unless we
   * re-emit here. Optional: CC tracks drift through applyRender so it
   * can leave this null.
   */
  notifyTextChange?(text: string, cursor: number, source: 'user' | 'runtime'): void;
  /** Same shape, for cursor-only injects. Optional. */
  notifyCursorChange?(text: string, cursor: number, source: 'user' | 'runtime'): void;
  /** Runtime state classes — observed each tick for transition events,
   *  serialized into the dump on demand. */
  readonly state: BridgeState;
}

export interface EventBridgeHandle {
  /** Stop the polling timer + flush + close the events stream. Idempotent. */
  stop(): void;
  /** Manually run one poll cycle (consume inject file + probe state).
   *  For unit tests — bypasses the 100 ms timer. */
  poll(): void;
  /** Paths of every file this harness reads or writes. */
  readonly paths: {
    readonly inject: string;
    readonly dump: string;
    readonly pid: string;
    readonly events: string;
  };
}

// ─── EventStream ─────────────────────────────────────────────────────────
//
// JSONL writer for /tmp/opencues-events-<pid>.jsonl. Append-only,
// truncated on arm so a fresh launch starts with a clean file. Closes
// cleanly on stop. Every emit is wrapped in try/catch — a flaky FS
// can't crash the runtime.

const POLL_INTERVAL_MS = 100;

class EventStream {
  private open = false;

  constructor(
    readonly path: string,
    private readonly pid: number,
  ) {
    // Truncate any previous run's events (so consumers don't have to
    // skip past stale data on start). Idempotent: if the file doesn't
    // exist, writeFileSync('') creates it.
    try { fs.writeFileSync(path, ''); this.open = true; } catch { /* swallow */ }
  }

  /**
   * Synchronous append — chosen over createWriteStream so a test runner
   * can read the events file synchronously right after issuing a
   * command. Cost is one open()/write()/close() per event (~100 µs on
   * Linux); event volume is at most ~10/s during interactive use, so
   * the overhead is negligible compared to the LLM round-trips that
   * dominate runtime latency. If event volume ever spikes (e.g. a
   * tight scripted loop), revisit by buffering + flushing on a timer.
   */
  emit(body: BridgeEventBody): void {
    if (!this.open) return;
    const evt: BridgeEvent = { ts: Date.now(), v: EVENT_BRIDGE_SCHEMA_VERSION, pid: this.pid, body };
    try { fs.appendFileSync(this.path, JSON.stringify(evt) + '\n'); } catch { /* swallow */ }
  }

  close(): void {
    this.open = false;
  }
}

// ─── StateProbe ──────────────────────────────────────────────────────────
//
// Read state-class snapshots each tick + diff against the previous
// snapshot. Emit a structured event for each transition. State classes
// expose getters (no observer pattern), so polling is the natural fit
// — and it costs O(state-class-count) per tick (~10 reads/100 ms).
//
// Why poll-diff vs subscribe-on-change: state classes are intentionally
// passive in the runtime (they don't emit; modules read them on render).
// Adding observers would mean wiring every mutation site in every state
// class. Polling stays out of the way.

interface HlSnap { active: boolean; wordIndex: number | null; word: string }
interface AgentSnap { armed: boolean; taskId: string | null; prompt: string }
interface SpanSnap { current: unknown; lastFilledText: string }
interface SelSnap { current: unknown }
interface DefsSnap { size: number }

class StateProbe {
  private hl: HlSnap | null = null;
  private agent: AgentSnap | null = null;
  private span: SpanSnap | null = null;
  private sel: SelSnap | null = null;
  private defs: DefsSnap | null = null;

  constructor(private readonly state: BridgeState, private readonly stream: EventStream) {}

  /** Probe + emit transitions for everything we track. Called each
   *  poll tick after the inject file is consumed. */
  tick(): void {
    this.tickHighlight();
    this.tickAgentTask();
    this.tickSpanFill();
    this.tickSelectorSatellite();
    this.tickDynDefs();
  }

  private tickHighlight(): void {
    const hl = this.state.hlState as
      | { active: boolean; wordIndex: number | null; text: string } | undefined;
    if (!hl) return;
    const wordIndex = hl.wordIndex;
    const word = wordIndex != null ? wordOfBuffer(hl.text, wordIndex) : '';
    const cur: HlSnap = { active: !!hl.active, wordIndex, word };
    const prev = this.hl;
    if (!prev || prev.active !== cur.active || prev.wordIndex !== cur.wordIndex) {
      if (cur.active && (!prev || !prev.active)) {
        this.stream.emit({ type: 'highlight.activated', wordIndex: cur.wordIndex ?? -1, word: cur.word });
      } else if (!cur.active && prev?.active) {
        this.stream.emit({ type: 'highlight.deactivated' });
      } else if (cur.active && prev?.active && prev.wordIndex !== cur.wordIndex) {
        this.stream.emit({
          type: 'highlight.word-changed',
          wordIndex: cur.wordIndex ?? -1,
          word: cur.word,
          previousWordIndex: prev.wordIndex,
        });
      }
    }
    this.hl = cur;
  }

  private tickAgentTask(): void {
    const at = this.state.agentTaskState as
      | { armed: boolean; taskId: string | null; prompt: string } | undefined;
    if (!at) return;
    const cur: AgentSnap = { armed: !!at.armed, taskId: at.taskId, prompt: at.prompt };
    const prev = this.agent;
    if (!prev || prev.armed !== cur.armed || prev.taskId !== cur.taskId) {
      if (cur.armed && (!prev || !prev.armed)) {
        this.stream.emit({ type: 'agent-task.armed', taskId: cur.taskId ?? '', prompt: cur.prompt });
      } else if (!cur.armed && prev?.armed) {
        this.stream.emit({ type: 'agent-task.stopped' });
      }
    }
    this.agent = cur;
  }

  private tickSpanFill(): void {
    const sf = this.state.spanFillState as
      | { current: unknown; lastFilledText: string } | undefined;
    if (!sf) return;
    const cur: SpanSnap = { current: sf.current ?? null, lastFilledText: sf.lastFilledText ?? '' };
    const prev = this.span;
    if (!prev || prev.current !== cur.current) {
      if (cur.current && (!prev || !prev.current)) {
        this.stream.emit({ type: 'span-fill.started', entry: cur.current });
      } else if (!cur.current && prev?.current) {
        this.stream.emit({ type: 'span-fill.completed', lastFilledText: cur.lastFilledText });
      }
    }
    this.span = cur;
  }

  private tickSelectorSatellite(): void {
    const ss = this.state.selectorSatelliteState as { current: unknown } | undefined;
    if (!ss) return;
    const cur: SelSnap = { current: ss.current ?? null };
    const prev = this.sel;
    if (!prev || prev.current !== cur.current) {
      if (cur.current && (!prev || !prev.current)) {
        this.stream.emit({ type: 'selector-satellite.started', entry: cur.current });
      } else if (!cur.current && prev?.current) {
        this.stream.emit({ type: 'selector-satellite.completed' });
      }
    }
    this.sel = cur;
  }

  private tickDynDefs(): void {
    const dd = this.state.dynDefs as { size?: number } | undefined;
    if (!dd) return;
    const size = typeof dd.size === 'number' ? dd.size : 0;
    const cur: DefsSnap = { size };
    const prev = this.defs;
    if (prev && prev.size !== cur.size) {
      this.stream.emit({ type: 'dyn-defs.size-changed', size: cur.size, previousSize: prev.size });
    }
    this.defs = cur;
  }
}

/** Pull the Nth word from a buffer (whitespace split). Used to
 *  enrich highlight events — knowing the wordIndex isn't useful
 *  without the actual word. */
function wordOfBuffer(text: string, wordIndex: number): string {
  if (wordIndex < 0) return '';
  // Match the splitWords contract used by Navigation: split on \s+,
  // drop empty tokens.
  const words = text.split(/\s+/).filter(Boolean);
  return words[wordIndex] ?? '';
}

// ─── CommandRunner ───────────────────────────────────────────────────────
//
// Parses one command line + executes it. Each command's effect is
// surfaced as one or more events. Errors per-line are caught and
// emitted as command.error so a single bad line doesn't abort the
// rest of a script.

class CommandRunner {
  constructor(
    private readonly bindings: BridgeBindings,
    private readonly stream: EventStream,
    private readonly writeDump: () => void,
  ) {}

  /** Run a multi-line script. Lines processed sequentially; failures
   *  per-line do not abort the script. */
  runScript(text: string): void {
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const { cmd, arg } = parseLine(line);
      this.stream.emit({ type: 'command', cmd, arg: arg.slice(0, 200) });
      try { this.runOne(cmd, arg); }
      catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        this.stream.emit({ type: 'command.error', cmd, arg: arg.slice(0, 200), error: msg });
      }
    }
  }

  private runOne(cmd: string, arg: string): void {
    const { adapter } = this.bindings;
    switch (cmd) {
      case 'text':
      case 'text-keep-hl': {
        // Two-step write: (1) buffer set; (2) synthetic textChange so
        // the resolver / statusline see the change. OpenTUI's
        // replaceText skips onContentChange for programmatic writes —
        // see the file-header note + bootstrap source-reclassifier.
        adapter.setText(arg);
        const source: 'user' | 'runtime' = cmd === 'text-keep-hl' ? 'runtime' : 'user';
        const cursor = adapter.getCursorOffset();
        this.bindings.notifyTextChange?.(arg, cursor, source);
        adapter.forceRender();
        this.stream.emit({ type: 'text.injected', text: arg, source, cursor });
        return;
      }
      case 'cursor': {
        const offset = parseInt(arg, 10);
        if (!Number.isFinite(offset) || offset < 0) {
          this.stream.emit({ type: 'command.error', cmd, arg, error: 'cursor: bad offset' });
          return;
        }
        adapter.setCursorOffset(offset);
        this.bindings.notifyCursorChange?.(adapter.getText(), offset, 'user');
        adapter.forceRender();
        this.stream.emit({ type: 'cursor.injected', cursor: offset });
        return;
      }
      case 'key': {
        const event = parseKeyArg(arg, adapter);
        const consumed = this.bindings.dispatchKey(event);
        this.stream.emit({
          type: 'key.dispatched',
          key: event.key,
          modifiers: event.modifiers,
          consumed,
        });
        return;
      }
      case 'clear': {
        adapter.setText('');
        adapter.setCursorOffset(0);
        this.bindings.notifyTextChange?.('', 0, 'user');
        adapter.forceRender();
        this.stream.emit({ type: 'cleared' });
        return;
      }
      case 'dump': {
        this.writeDump();
        return;
      }
      case 'wait': {
        // Documentation-only — the inject file is consumed in one
        // poll cycle, so wait gives the loop nothing to do. Scripts
        // split across multiple file writes can sleep in the driver.
        return;
      }
      default: {
        this.stream.emit({ type: 'command.unknown', line: `${cmd}:${arg.slice(0, 100)}` });
        return;
      }
    }
  }
}

/**
 * Split a single line of the inject script into `cmd` + `arg`.
 * Commands that take colon-bearing args (key:up:ctrl+alt) work
 * because we only split on the FIRST colon.
 */
function parseLine(line: string): { cmd: string; arg: string } {
  const idx = line.indexOf(':');
  if (idx < 0) return { cmd: line, arg: '' };
  return { cmd: line.slice(0, idx), arg: line.slice(idx + 1) };
}

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

// ─── SerializerKit ───────────────────────────────────────────────────────
//
// State classes expose their read shape via getters on the prototype
// (e.g. HighlightState.active is `get active() { return this._active }`).
// JSON.stringify ignores non-enumerable getters by default, so we walk
// the prototype + invoke each getter explicitly. Underscore-prefixed
// fields are private implementation detail and are always skipped —
// including them caused stale snapshots to leak (the public getter
// reads coherent state; the backing fields were captured at different
// moments).

function safeCall<T>(fn: () => T): T | null {
  try { return fn(); } catch { return null; }
}

function serializeOpaque(obj: unknown): unknown {
  if (obj == null) return null;
  if (typeof obj !== 'object') return obj;
  const out: Record<string, unknown> = {};
  // Public getters on the prototype — the canonical read shape.
  const proto = Object.getPrototypeOf(obj as object);
  if (proto) {
    for (const k of Object.getOwnPropertyNames(proto)) {
      if (k === 'constructor' || k.startsWith('_')) continue;
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
  // Own enumerable, non-private fields — covers plain-object stubs
  // (test fixtures) that don't use the getter pattern.
  for (const k of Object.keys(obj as object)) {
    if (k.startsWith('_') || k in out) continue;
    try {
      const v = (obj as Record<string, unknown>)[k];
      if (typeof v === 'function') continue;
      JSON.stringify(v);
      out[k] = v;
    } catch {
      out[k] = '<unserializable>';
    }
  }
  return out;
}

function serializeHighlight(hl: unknown): unknown {
  if (hl == null) return { active: false };
  const opaque = serializeOpaque(hl) as Record<string, unknown>;
  return {
    active: !!opaque.active,
    wordIndex: opaque.wordIndex ?? null,
    text: opaque.text ?? '',
    ...opaque,
  };
}

function serializeDynDefs(dd: unknown): unknown {
  if (dd == null) return null;
  const view = serializeOpaque(dd) as Record<string, unknown>;
  // DynDefs's defs are a private Map. We bypass the privacy boundary
  // intentionally — the dump's purpose is exposing all state for tests,
  // not respecting the public read API.
  const internal = dd as { _defs?: Map<number, unknown> };
  if (internal._defs instanceof Map) {
    view.defs = Array.from(internal._defs.entries()).map(([idx, def]) => ({
      wordIndex: idx,
      ...((def && typeof def === 'object') ? def as Record<string, unknown> : { value: def }),
    }));
    view.size = internal._defs.size;
  }
  return view;
}

// ─── Public entry point ──────────────────────────────────────────────────
//
// Each host's boot.ts mounts the harness if OPENCUES_BRIDGE=1. The
// harness owns its lifecycle from there: start polling, write events,
// stop on shutdown. Returns a handle for tests to drive directly
// (poll + stop) without depending on the timer.

export function startEventBridge(b: BridgeBindings): EventBridgeHandle {
  const pid = process.pid;
  const injectFile = `/tmp/opencues-inject-${pid}.txt`;
  const dumpFile = `/tmp/opencues-bridge-dump-${pid}.json`;
  const pidFile = process.env.OPENCUES_BRIDGE_PID_FILE
    ?? `/tmp/opencues-bridge.pid`;
  const eventsFile = process.env.OPENCUES_BRIDGE_EVENTS_FILE
    ?? `/tmp/opencues-events-${pid}.jsonl`;

  const log = (msg: string, data?: unknown): void => {
    try { b.adapter.log('info', `[bridge] ${msg}`, data); } catch { /* swallow */ }
  };

  // Pidfile: written up front so callers don't race the first poll.
  try { fs.writeFileSync(pidFile, String(pid)); } catch (err) {
    log('pidfile write failed', { pidFile, err: String(err) });
  }

  const stream = new EventStream(eventsFile, pid);
  stream.emit({
    type: 'harness.armed',
    host: b.adapter.hostName,
    hostVersion: b.adapter.hostVersion,
    capabilities: b.adapter.capabilities,
  });
  log('harness armed', { pid, injectFile, dumpFile, pidFile, eventsFile });

  // Subscribe to adapter-level events so synthetic AND real text/cursor
  // changes flow into the events stream uniformly. onCursorChange is
  // optional on HostAdapter (some hosts can't distinguish cursor-only
  // moves from typing — see adapter.ts), so we degrade gracefully when
  // it's not provided. Unsubscribed on stop.
  const unsubText = b.adapter.onTextChange(e => {
    stream.emit({
      type: 'text.changed',
      text: e.text,
      cursor: e.cursorOffset,
      source: e.source,
      previousText: e.previousText,
    });
  });
  const unsubCursor = b.adapter.onCursorChange?.(e => {
    stream.emit({
      type: 'cursor.changed',
      text: e.text,
      cursor: e.cursorOffset,
      source: e.source,
    });
  });
  // Subscribe to module-emitted events (resolver.completed,
  // blank.substituted, transform-blank.pass-completed, etc.). Modules
  // call adapter.emitEvent at lifecycle boundaries — see Resolver,
  // BlankFill, AgentRewrite, TransformBlankSource. The harness's stream
  // is the canonical sink. Optional onEvent — undefined when the host
  // band doesn't expose the event bus (older bands).
  const unsubModuleEvents = b.adapter.onEvent?.((type, body) => {
    // Pass through the type + body as a tagged-union body. The
    // catch-all branch in BridgeEventBody covers types not yet in the
    // canonical list.
    stream.emit({ type, ...(body ?? {}) } as BridgeEventBody);
  });

  function writeDump(): void {
    try {
      const dump = {
        v: EVENT_BRIDGE_SCHEMA_VERSION,
        text: safeCall(() => b.adapter.getText()),
        cursor: safeCall(() => b.adapter.getCursorOffset()),
        highlight: serializeHighlight(b.state.hlState),
        dynDefs: serializeDynDefs(b.state.dynDefs),
        spanFill: serializeOpaque(b.state.spanFillState),
        dismissedBlanks: serializeOpaque(b.state.dismissedBlanks),
        selectorSatellite: serializeOpaque(b.state.selectorSatelliteState),
        agentTask: serializeOpaque(b.state.agentTaskState),
        capabilities: b.adapter.capabilities,
        pid,
        host: b.adapter.hostName,
        hostVersion: b.adapter.hostVersion,
        timestamp: new Date().toISOString(),
      };
      fs.writeFileSync(dumpFile, JSON.stringify(dump, null, 2));
      stream.emit({ type: 'dump.written', path: dumpFile });
    } catch (err) {
      log('dump failed', { err: String(err) });
    }
  }

  const runner = new CommandRunner(b, stream, writeDump);
  const probe = new StateProbe(b.state, stream);

  let active = true;

  function poll(): void {
    if (!active) return;
    let raw: string | null = null;
    try {
      if (fs.existsSync(injectFile)) {
        raw = fs.readFileSync(injectFile, 'utf8');
        // Atomic consume: delete BEFORE running so a crash mid-script
        // doesn't replay it next tick.
        fs.unlinkSync(injectFile);
      }
    } catch (err) {
      log('poll read failed', { err: String(err) });
    }
    if (raw && raw.length > 0) {
      runner.runScript(raw);
    }
    // Probe state every tick — even if no inject ran, the runtime
    // could have transitioned (LLM resolver returning, agent rewrite
    // applying, blank-fill substituting).
    probe.tick();
  }

  const interval = setInterval(poll, POLL_INTERVAL_MS);

  return {
    stop() {
      if (!active) return;
      active = false;
      clearInterval(interval);
      try { unsubText(); } catch { /* swallow */ }
      try { unsubCursor?.(); } catch { /* swallow */ }
      try { unsubModuleEvents?.(); } catch { /* swallow */ }
      stream.emit({ type: 'harness.stopped' });
      stream.close();
      // Owner-checked pidfile cleanup: only delete if it still names us.
      // Avoids racing a newer host's arm.
      try {
        if (fs.existsSync(pidFile)) {
          const owner = fs.readFileSync(pidFile, 'utf8').trim();
          if (owner === String(pid)) fs.unlinkSync(pidFile);
        }
      } catch { /* swallow */ }
      log('harness stopped', { pid });
    },
    poll,
    paths: { inject: injectFile, dump: dumpFile, pid: pidFile, events: eventsFile },
  };
}
