// CodexAdapter — synthetic HostAdapter for the codex daemon.
//
// Codex is a Rust TUI; @opencues/runtime can't load in-process. The
// daemon sits in a Node subprocess and talks to codex via JSON-RPC.
// This adapter is the daemon's bridge between the runtime modules
// (which expect a HostAdapter) and the JSON-RPC protocol that
// reaches the actual TUI.
//
// Capability split:
//
//   ▸ FS ops (readFile / readDir / writeFile / log) — real, via
//     node:fs/promises. The daemon process can do these directly;
//     no RPC roundtrip needed.
//
//   ▸ UI ops (getText / setText / onKey / onTextChange / onRender /
//     forceRender / pushText) — currently STUBS. The daemon receives
//     text events via the `text-change` RPC and dispatches keys via
//     the `key` RPC; that wiring lives in daemon.ts and feeds back
//     into this adapter through the test-friendly `notifyTextChange`
//     / `dispatchKey` / `collectRender` methods exposed below.
//
//   ▸ Process ops (spawnProcess / blankInvoke) — STUB. The bridge
//     can't easily tunnel subprocess stdio through JSON-RPC; codex's
//     blank-invoke story is RPC-based and lives in Tier 3.E.
//
// As Tier 3 progresses, the stubbed methods get filled in. Keep the
// stubs aligned with the OC adapter's pattern
// (`packages/opencues-runtime/adapters/oc/v1.4/adapter.ts`) — that's
// the structural reference.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type Capability,
  type BlankInvokeSpec,
  type DirEntry,
  type HostAdapter,
  type KeyEvent,
  type KeyFilter,
  type LogLevel,
  type ProcessHandle,
  type Range,
  type RenderContext,
  type RenderDirectives,
  type TextChangeEvent,
  type CursorChangeEvent,
  type Unsubscribe,
  HOST_ADAPTER_INTERFACE_VERSION,
} from '../../../src/adapter';
import type { SourceReclassifier } from '../../../src/boot-common';

export interface CodexAdapterOptions {
  readonly cwd: string;
  readonly hostVersion?: string;
  /** Where adapter-side log lines flow. The daemon's `log` notification
   *  handler is the obvious wire-up. */
  readonly log: (level: LogLevel, msg: string, data?: unknown) => void;
  /** Source reclassifier — the adapter calls `markRuntimeWrite(text)`
   *  inside `setText` / `pushText` so when the bridge echoes the text
   *  back via the next `text-change` RPC, the daemon's handler can
   *  flip its source from 'user' to 'runtime' (avoids feedback loops
   *  during cycling). Optional; without it, runtime writes look like
   *  user writes downstream. */
  readonly reclassifier?: SourceReclassifier;
  /** Host-native blank dispatch. When supplied, BlankFill +
   *  Cycling try this BEFORE spawnProcess for `blank-invoke`
   *  capability. Same shape as OC's binding — usually wired by
   *  passing `createBlankInvoke(blanksRegistry)`. */
  readonly blankInvoke?: (spec: BlankInvokeSpec) => ProcessHandle | null;
}

interface KeySub {
  filter: KeyFilter | null;
  handler: (e: KeyEvent) => boolean;
}
interface TextSub { handler: (e: TextChangeEvent) => void }
interface CursorSub { handler: (e: CursorChangeEvent) => void }
interface RenderSub { handler: (ctx: RenderContext) => RenderDirectives | null }

const CODEX_BASE_CAPABILITIES: readonly Capability[] = [
  'file-read',
  'file-write',
  'force-render',
  'render-override',
  'dim-ranges',
  'highlight-range',
  'change-source',
  // Mirrors OPENCODE_V14_CAPABILITIES (adapters/oc/v1.4/adapter.ts:73-80)
  // plus 'change-source' which both runtime modules use to emit
  // source-attributed text events from the bridge into the runtime.
  // 'blank-invoke' is added per-instance when bindings.blankInvoke
  // is supplied. 'spawn-process' stays off until Tier 3 wires a bridge
  // for spawning; codex's blanks are all hoisted to TS so the
  // shell-script fallback isn't load-bearing.
];

/**
 * Codex's HostAdapter. FS + log are real; UI methods are stubs that
 * track subscriptions in arrays for the daemon to fan out to once
 * the JSON-RPC routing lands (Tier 3.F-I).
 */
export class CodexAdapter implements HostAdapter {
  readonly interfaceVersion = HOST_ADAPTER_INTERFACE_VERSION;
  readonly hostName = 'codex';
  readonly hostVersion: string;
  readonly capabilities: readonly Capability[];
  readonly cwd: string;

  private _text = '';
  private _cursor = 0;
  private readonly _logFn: CodexAdapterOptions['log'];
  private readonly _reclassifier: SourceReclassifier | undefined;
  private readonly _blankInvoke: CodexAdapterOptions['blankInvoke'];

  // Subscriptions — populated by runtime modules in subscribe(). The
  // daemon's RPC handlers will fan into these once Tier 3.F-I lands.
  private readonly _keySubs: KeySub[] = [];
  private readonly _textSubs: TextSub[] = [];
  private readonly _cursorSubs: CursorSub[] = [];
  private readonly _renderSubs: RenderSub[] = [];

  constructor(opts: CodexAdapterOptions) {
    this.cwd = opts.cwd;
    this.hostVersion = opts.hostVersion ?? 'unknown';
    this._logFn = opts.log;
    this._reclassifier = opts.reclassifier;
    this._blankInvoke = opts.blankInvoke;
    // Conditional capability: 'blank-invoke' only when the binding
    // is supplied. Mirrors OC's per-instance capability list.
    const caps: Capability[] = [...CODEX_BASE_CAPABILITIES];
    if (opts.blankInvoke) caps.push('blank-invoke');
    this.capabilities = caps;
  }

  // ─── State reads ───────────────────────────────────────────────────

  getText(): string { return this._text; }
  getCursorOffset(): number { return this._cursor; }
  getSelection(): Range | null { return null; }

  // ─── State writes (stubs — Tier 3.F will wire `set-text` notification out) ──

  setText(text: string): void {
    // Tier 3.C: stash the text so the next text-change RPC's reclassify
    // call recognises it as a runtime write (not a user keystroke).
    this._reclassifier?.markRuntimeWrite(text);
    // TODO Tier 3.F: emit `set-text` notification back to the bridge.
    // The bridge then mutates codex's TextArea + sends back a
    // text-change with source='runtime'. Until then, runtime writes
    // never reach the actual TUI buffer.
  }
  setCursorOffset(_offset: number): void { /* TODO Tier 3.F */ }
  forceRender(): void { /* TODO Tier 3.I: emit `directives` notification */ }
  pushText(text: string, _cursor?: number): void {
    // Same Tier 3.C wiring as setText — pushText is the BlankFill /
    // async path that uses the same write channel.
    this._reclassifier?.markRuntimeWrite(text);
    // TODO Tier 3.F: emit `set-text` notification + cursor reposition.
  }

  // ─── Event subscriptions ───────────────────────────────────────────

  onKey(filter: KeyFilter | null, handler: (e: KeyEvent) => boolean): Unsubscribe {
    const sub: KeySub = { filter, handler };
    this._keySubs.push(sub);
    return () => {
      const i = this._keySubs.indexOf(sub);
      if (i >= 0) this._keySubs.splice(i, 1);
    };
  }

  onTextChange(handler: (e: TextChangeEvent) => void): Unsubscribe {
    const sub: TextSub = { handler };
    this._textSubs.push(sub);
    return () => {
      const i = this._textSubs.indexOf(sub);
      if (i >= 0) this._textSubs.splice(i, 1);
    };
  }

  onCursorChange(handler: (e: CursorChangeEvent) => void): Unsubscribe {
    const sub: CursorSub = { handler };
    this._cursorSubs.push(sub);
    return () => {
      const i = this._cursorSubs.indexOf(sub);
      if (i >= 0) this._cursorSubs.splice(i, 1);
    };
  }

  onRender(handler: (ctx: RenderContext) => RenderDirectives | null): Unsubscribe {
    const sub: RenderSub = { handler };
    this._renderSubs.push(sub);
    return () => {
      const i = this._renderSubs.indexOf(sub);
      if (i >= 0) this._renderSubs.splice(i, 1);
    };
  }

  // ─── Process / dispatch ─────────────────────────────────────────────

  /**
   * Codex's adapter doesn't currently bridge subprocess spawns to the
   * Rust side — `spawn-process` capability stays off in
   * CODEX_BASE_CAPABILITIES so most call sites bail before reaching
   * here. BlankFill's blankInvoke→spawnProcess fallthrough doesn't
   * gate on the capability though (it has its own `script` presence
   * check), so we'd land here when a `.sh`-backed blank like
   * `volume-blank.sh` falls through after our blank-invoke registry
   * misses it. Return a "command unavailable" handle instead of
   * throwing — modules treat non-zero exit as "skip this slot" and
   * stay alive. The proper fix lives in Tier 3 follow-up: either
   * hoist the remaining shell-script blanks (volume / brightness)
   * to TS, or add a spawn-process JSON-RPC method that tunnels
   * stdio through the bridge.
   */
  spawnProcess(_spec: import('../../../src/adapter').ProcessSpec): import('../../../src/adapter').ProcessHandle {
    this._logFn('warn', 'CodexAdapter.spawnProcess: no bridge wiring for subprocesses; treating as unavailable');
    return {
      result: Promise.resolve({
        stdout: '',
        stderr: 'CodexAdapter: spawnProcess not implemented (no spawn-process capability)',
        exitCode: 127,
        timedOut: false,
      }),
      kill: () => {},
    };
  }

  /** Forward to the host's blankInvoke binding when supplied. Same
   *  shape as OC's adapter — null fallthrough so BlankFill / Cycling
   *  drop to spawnProcess for shell-script blanks. */
  blankInvoke(spec: BlankInvokeSpec): ProcessHandle | null {
    return this._blankInvoke?.(spec) ?? null;
  }

  // ─── FS ops (real) ─────────────────────────────────────────────────

  async readFile(p: string): Promise<string | null> {
    try { return await fs.readFile(p, 'utf8'); }
    catch { return null; }
  }

  async readDir(p: string): Promise<readonly DirEntry[] | null> {
    try {
      const entries = await fs.readdir(p, { withFileTypes: true });
      return entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() }));
    } catch { return null; }
  }

  async writeFile(p: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, 'utf8');
  }

  // ─── Log ───────────────────────────────────────────────────────────

  log(level: LogLevel, msg: string, data?: unknown): void {
    this._logFn(level, msg, data);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  dispose(): void {
    this._keySubs.length = 0;
    this._textSubs.length = 0;
    this._renderSubs.length = 0;
  }

  // ─── Daemon-side bridge points (called by daemon's RPC handlers) ──
  //
  // Public so daemon.ts can fan JSON-RPC events into the runtime once
  // the routing lands. Not part of the HostAdapter interface — these
  // are codex-specific.

  /** Daemon received a `text-change` notification — flow it to subscribed handlers. */
  notifyTextChangeFromBridge(text: string, cursor: number, source: 'user' | 'runtime'): void {
    const previousText = this._text;
    this._text = text;
    this._cursor = cursor;
    for (const sub of this._textSubs) {
      sub.handler({ text, previousText, cursorOffset: cursor, source });
    }
  }

  /** Daemon received a `cursor-change` notification (cursor moved
   *  without text changing) — flow it to subscribed handlers. */
  notifyCursorChangeFromBridge(text: string, cursor: number, source: 'user' | 'runtime'): void {
    this._text = text;
    this._cursor = cursor;
    for (const sub of this._cursorSubs) {
      sub.handler({ text, cursorOffset: cursor, source });
    }
  }

  /** Daemon received a `key` request — fan to subscribed handlers,
   *  respect filters, return whether any handler consumed. */
  dispatchKeyFromBridge(event: KeyEvent): boolean {
    for (const sub of this._keySubs) {
      if (!keyEventMatches(sub.filter, event)) continue;
      if (sub.handler(event)) return true;
    }
    return false;
  }

  /** Collect the latest render directives from every subscribed
   *  handler. Called by the daemon's `force-render` handler before
   *  emitting a `directives` notification. */
  collectRenderDirectives(ctx?: Partial<RenderContext>): RenderDirectives[] {
    const fullCtx: RenderContext = {
      text: ctx?.text ?? this._text,
      cursor: ctx?.cursor ?? this._cursor,
      externalHighlights: ctx?.externalHighlights ?? [],
    };
    const out: RenderDirectives[] = [];
    for (const sub of this._renderSubs) {
      const d = sub.handler(fullCtx);
      if (d) out.push(d);
    }
    return out;
  }
}

function keyEventMatches(filter: KeyFilter | null, event: KeyEvent): boolean {
  if (!filter) return true;
  if (filter.keys && !filter.keys.includes(event.key)) return false;
  if (filter.requireModifiers) {
    for (const m of filter.requireModifiers) {
      if (!event.modifiers[m]) return false;
    }
  }
  if (filter.forbidModifiers) {
    for (const m of filter.forbidModifiers) {
      if (event.modifiers[m]) return false;
    }
  }
  return true;
}
