// Platform-free core of the mac daemon — the ENTIRE bridge-event
// grammar (ready/focus/blur/change/cursor/writeAck) and the write path,
// with every platform edge injected (bridge stdin, logging, deny list,
// env, exit). daemon.ts is now only process glue: spawn the Swift
// bridge, wire stdio into this class, boot the runtime.
//
// WHY this split exists: the project maintainer has no mac. The Swift
// bridge can only compile/run on macOS, but every behaviour above it is
// line-JSON in / line-JSON out — so this core (and daemon-core.test.ts,
// which replays real bridge transcripts including the 2026-07-21
// Spotlight double-substitution regression) runs on ANY platform, in
// plain vitest, with no Accessibility grant, no swiftc, no darwin API.
// Keep it that way: no node:child_process, no fs, no @opencues/runtime
// imports (the runtime surface is a structural interface below).

import {
  utf16Diff,
  freshMarkerAtCursor,
  WriteRing,
  charBudgetForBundle,
  replaceQueryForBundle,
  shouldDropDuplicateChange,
} from './ax-host';

/** The slice of the runtime's BootResult the core drives — structural,
 *  so tests (and this module) never import @opencues/runtime. */
export interface RuntimeSurface {
  dispatchKey(event: {
    key: string;
    modifiers: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean };
    text: string;
    cursorOffset: number;
  }): boolean;
  notifyTextChange(text: string, cursorOffset: number, source: 'user' | 'runtime'): void;
  resetBufferState(): void;
}

export type CoreLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DaemonCoreDeps {
  /** Write one command object to the bridge's stdin. */
  send(cmd: Record<string, unknown>): void;
  log(level: CoreLogLevel, msg: string, data?: unknown): void;
  /** Bundles whose focus events are ignored (terminals, …). Re-read per
   *  focus so OPENCUES_AX_DENY edits apply without restart. */
  deniedBundles(): ReadonlySet<string>;
  /** `OPENCUES_AX_CHAR_BUDGET` — injected so tests don't touch env. */
  charBudgetEnv?(): string | undefined;
  /** `OPENCUES_AX_REPLACE_QUERY` — injected so tests don't touch env. */
  replaceQueryEnv?(): string | undefined;
  /** Called when the bridge reports the Accessibility grant is missing
   *  (prod: log the fix instructions + process.exit(1)). */
  onUntrusted(): void;
}

export interface Focused { value: string; cursor: number; app: string; bundle: string }

export class DaemonCore {
  focused: Focused | null = null;
  private lastAckMethod: string | null = null;
  private writeId = 0;
  private readonly ring = new WriteRing();
  private runtime: RuntimeSurface | null = null;

  constructor(private readonly deps: DaemonCoreDeps) {}

  /** The runtime boots AFTER the core exists (boot options read the
   *  core's accessors), so the surface arrives via setter. Events that
   *  land before attach are dropped with a warn — the bridge emits
   *  nothing user-relevant before boot completes in practice. */
  attachRuntime(rt: RuntimeSurface): void {
    this.runtime = rt;
  }

  // ── Boot-option accessors (the buffer IS the focused element) ──────
  getText(): string { return this.focused?.value ?? ''; }
  getCursorOffset(): number { return this.focused?.cursor ?? 0; }
  getAnswerCharBudget(): number | null {
    return this.focused
      ? charBudgetForBundle(this.focused.bundle, this.deps.charBudgetEnv?.())
      : null;
  }
  /** Spotlight-class fields hold a disposable query — the answer replaces
   *  it (there is no room for both). Every other app keeps FILL. */
  getAnswerReplacesQuery(): boolean {
    return this.focused
      ? replaceQueryForBundle(this.focused.bundle, this.deps.replaceQueryEnv?.())
      : false;
  }

  /**
   * Focused-field description for fluid-blank. We can name the owning
   * APPLICATION (the AX channel gives it on every focus event), which is
   * exactly what master's app-aware output steering consumes: with
   * `app: 'Finder'` a request for "my tax pdfs" answers `*.pdf` — a valid
   * file-search token — instead of prose. No label/placeholder: AX exposes
   * them inconsistently across toolkits and the steering only needs the app.
   *
   * Returns null with nothing focused. Gated upstream by
   * `ambient-context-mode`, so this is never called while that scalar is
   * off — and the app name is sanitized by the core renderer before it
   * reaches a prompt (it rides inside the UNTRUSTED block).
   */
  getAmbientContext(): { app: string } | null {
    const app = this.focused?.app;
    return app && app !== '?' ? { app } : null;
  }

  /** Runtime → element. One contiguous AX replace per text change;
   *  optimistic local update (the bridge serializes the ~1ms write on
   *  the app's main runloop; the runtime must read back its own bytes
   *  NOW), echo recorded for change-event classification. */
  requestWrite(text: string): void {
    if (!this.focused) { this.deps.log('warn', 'runtime write with no focused element — dropped'); return; }
    const d = utf16Diff(this.focused.value, text);
    if (!d) return;
    this.ring.record(text);
    this.focused.value = text;
    this.focused.cursor = d.start + d.text.length;
    this.deps.send({ cmd: 'replace', id: ++this.writeId, start: d.start, length: d.length, text: d.text });
  }

  /** One line of bridge stdout → one event. Malformed lines dropped. */
  handleLine(line: string): void {
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    this.handleEvent(ev);
  }

  handleEvent(ev: Record<string, unknown>): void {
    const rt = this.runtime;
    if (!rt) { this.deps.log('warn', 'bridge event before runtime attach — dropped', ev['type']); return; }
    switch (ev['type']) {
      case 'ready':
        if (!ev['trusted']) {
          this.deps.log('error', 'Accessibility permission missing. Fix: System Settings → Privacy & Security → Accessibility → enable your terminal (or the app launching this daemon), then restart the daemon.');
          this.deps.onUntrusted();
          break;
        }
        this.deps.log('info', 'ax-bridge ready — watching the focused text element in every app');
        break;
      case 'focus': {
        const bundle = String(ev['bundle'] ?? '');
        if (this.deps.deniedBundles().has(bundle)) {
          this.focused = null;
          rt.resetBufferState();
          break;
        }
        this.focused = {
          value: String(ev['value'] ?? ''),
          cursor: Number(ev['cursor'] ?? 0),
          app: String(ev['app'] ?? '?'),
          bundle,
        };
        this.ring.clear();
        this.lastAckMethod = null;
        rt.resetBufferState();
        // Baseline: focus content is context, never a trigger — source
        // 'runtime' seeds the buffer without waking the resolver (a
        // 'user'-sourced focus with previousText='' reads as "a marker
        // appeared" and auto-resolved a pre-existing `_` the moment the
        // field was focused — observed live in TextEdit 2026-07-12).
        // A `_` arms only when the user TYPES one (freshMarkerAtCursor).
        rt.notifyTextChange(this.focused.value, this.focused.cursor, 'runtime');
        this.deps.log('info', 'focus', { app: this.focused.app, chars: this.focused.value.length });
        break;
      }
      case 'blur':
        if (this.focused) {
          this.focused = null;
          this.ring.clear();
          rt.resetBufferState();
        }
        break;
      case 'change': {
        if (!this.focused) break;
        const value = String(ev['value'] ?? '');
        const cursor = Number(ev['cursor'] ?? 0);
        // Duplicate-notification guard (Spotlight fires 2-3 identical
        // AXValueChanged per keystroke) — see shouldDropDuplicateChange.
        if (shouldDropDuplicateChange(value, cursor, this.focused, this.ring.isEcho(value))) break;
        const prev = this.focused.value;
        this.focused.value = value;
        this.focused.cursor = cursor;
        if (this.ring.isEcho(value)) {
          rt.notifyTextChange(value, cursor, 'runtime');
          break;
        }
        // Not our write → the user owns the buffer now; stale echoes of
        // older frames must not masquerade as ours after this point.
        this.ring.clear();
        const arm = freshMarkerAtCursor(value, cursor, prev);
        if (arm !== null) {
          rt.dispatchKey({
            key: '_',
            modifiers: { ctrl: false, alt: false, shift: false, meta: false },
            text: value.slice(0, arm) + value.slice(arm + 1),
            cursorOffset: arm,
          });
        }
        rt.notifyTextChange(value, cursor, 'user');
        break;
      }
      case 'cursor':
        if (this.focused) this.focused.cursor = Number(ev['cursor'] ?? 0);
        break;
      case 'writeAck':
        if (!ev['ok']) {
          this.deps.log('warn', 'AX write failed — resyncing from the element', ev);
          this.deps.send({ cmd: 'read' });
        } else if (ev['method'] !== this.lastAckMethod) {
          // Once per focus: 'replace-attr' = atomic selection-free
          // (WebKit/Electron); 'selection' = save/restore transaction.
          this.lastAckMethod = String(ev['method'] ?? '?');
          this.deps.log('info', 'write path', { method: this.lastAckMethod, app: this.focused?.app });
        }
        break;
      default: break;
    }
  }
}
