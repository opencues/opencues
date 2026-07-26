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
  /** Present only on a host with a render surface; absent ⇒ no overlay pump. */
  collectRenderDirectives?(text: string, cursor: number): unknown[];
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
  /** `OPENCUES_AX_CYCLING` — `off` disables chord capture entirely (the
   *  bridge never consumes Ctrl+Alt+arrows and every cycleable cue stays
   *  pruned, i.e. exactly the pre-cycling behaviour). Injected, not read. */
  cyclingEnv?(): string | undefined;
  /** Coalesce a repaint to once per tick. Injected so tests can run it
   *  synchronously — the real daemon passes setImmediate. */
  scheduleRepaint?(fn: () => void): void;
  /** Flatten RenderDirectives[] → { dim, hl }. Injected so the platform-free
   *  core never imports @opencues/runtime (the daemon passes the shared
   *  mergeRenderDirectives). */
  mergeRender?(dirs: unknown[]): { dim: ReadonlyArray<readonly [number, number]>; hl: readonly [number, number] | null };
  /** Called when the bridge reports the Accessibility grant is missing
   *  (prod: log the fix instructions + process.exit(1)). */
  onUntrusted(): void;
}

export interface Focused { value: string; cursor: number; app: string; bundle: string; fieldId: string }

export class DaemonCore {
  focused: Focused | null = null;
  private lastAckMethod: string | null = null;
  private writeId = 0;
  private readonly ring = new WriteRing();
  /** Mirrors the bridge's chord-consumption state (see setCapture). */
  private captureOn = false;
  private repaintQueued = false;
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

  /** Chord capture is only worth enabling where the runtime will act on it:
   *  a live, non-denied text element. Off elsewhere so the bridge passes
   *  Ctrl+Alt+arrows through to whatever app the user is in — the deny list
   *  is daemon-side, so the tap cannot make this call itself. */
  private setCapture(on: boolean): void {
    const want = on && this.cyclingAllowed();
    if (want === this.captureOn) return;
    this.captureOn = want;
    this.deps.send({ cmd: 'capture', on: want });
  }

  private cyclingAllowed(): boolean {
    return (this.deps.cyclingEnv?.() ?? '').trim().toLowerCase() !== 'off';
  }

  /**
   * Can this HOST deliver cycling chords at all? Deliberately NOT per-focus.
   *
   * The resolver's build key includes supportsCycling, so a value that
   * flapped with focus rebuilt the entire source set on every blur/focus —
   * observed live 2026-07-26: sentence-cues registered, were pruned 9s later
   * as "no cycling surface", then re-registered, each rebuild discarding the
   * variant pools and LRU caches the fresh source instances start empty.
   *
   * Chord DELIVERY is focus-scoped (setCapture, so we never swallow keys in
   * an app we aren't attached to), but the host's CAPABILITY is not: the tap
   * is armed for the process lifetime. With nothing focused the buffer is
   * empty anyway, so advertising true costs nothing.
   */
  supportsCycling(): boolean {
    return this.cyclingAllowed();
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

  /**
   * Ship the runtime's dim/highlight spans to the bridge's overlay.
   *
   * Debounced to ONE collect per tick: every text change, focus, chord and the
   * runtime's own forceRender kick funnels through here, exactly like the other
   * bands' repaint paths. An EMPTY push clears the overlay — and is logged,
   * because "the marks vanished" and "no push happened" are otherwise
   * indistinguishable in the log (the lesson the windows pump records).
   */
  pushRender(): void {
    const rt = this.runtime;
    if (!rt?.collectRenderDirectives || !this.deps.mergeRender) return;
    if (this.repaintQueued) return;
    this.repaintQueued = true;
    const run = (): void => {
      this.repaintQueued = false;
      if (!this.focused) { this.deps.send({ cmd: 'render', dim: [], hl: null }); return; }
      let dirs: unknown[] = [];
      try { dirs = rt.collectRenderDirectives!(this.focused.value, this.focused.cursor); }
      catch (err) { this.deps.log('warn', `collectRenderDirectives failed: ${(err as Error).message}`); }
      const wire = this.deps.mergeRender!(dirs);
      this.deps.send({ cmd: 'render', dim: wire.dim.map(r => [r[0], r[1]]), hl: wire.hl ? [wire.hl[0], wire.hl[1]] : null });
      this.deps.log('debug', wire.dim.length || wire.hl
        ? `render push: dim=${wire.dim.length} hl=${wire.hl ? 1 : 0} textLen=${this.focused.value.length}`
        : `render push: EMPTY textLen=${this.focused.value.length}`);
    };
    if (this.deps.scheduleRepaint) this.deps.scheduleRepaint(run); else run();
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
      case 'key': {
        // A cycling/nav chord the bridge captured and SWALLOWED for us. It
        // carries no text of its own — the runtime needs the current buffer +
        // caret to resolve which word the chord applies to.
        if (!this.focused) { this.deps.log('debug', 'chord with no focused element — dropped'); break; }
        const key = String(ev['key'] ?? '');
        const m = (ev['modifiers'] ?? {}) as Record<string, unknown>;
        if (!key) break;
        const consumed = rt.dispatchKey({
          key,
          modifiers: {
            ctrl: m['ctrl'] === true, alt: m['alt'] === true,
            shift: m['shift'] === true, meta: m['meta'] === true,
          },
          text: this.focused.value,
          cursorOffset: this.focused.cursor,
        });
        this.deps.log('debug', `chord ${key} → runtime (consumed=${consumed})`);
        // Navigation moves the highlight and cycling swaps a word — both change
        // what the overlay should show, and neither goes through setText.
        if (consumed) this.pushRender();
        break;
      }
      case 'chordIgnored':
        // The tap SAW the chord but capture was closed — so the key channel
        // works and the gate is the thing to look at (focus lost? denied app?
        // OPENCUES_AX_CYCLING=off?). Silence here means the tap never saw it.
        this.deps.log('debug', `chord ${String(ev['key'] ?? '?')} seen but capture is off (focused=${this.focused !== null}, cyclingAllowed=${this.cyclingAllowed()})`);
        break;
      case 'tapArmed':
        this.deps.log('info', 'chord tap armed — Ctrl+Alt+arrows reach the runtime on attachable fields');
        break;
      case 'tapFailed':
        this.deps.log('warn', `chord tap unavailable (${String(ev['reason'] ?? '?')}) — cycling stays off; blank fills unaffected`);
        break;
      case 'focus': {
        const bundle = String(ev['bundle'] ?? '');
        if (this.deps.deniedBundles().has(bundle)) {
          this.focused = null;
          this.setCapture(false);   // never swallow chords in a denied app
          rt.resetBufferState();
          break;
        }
        const fieldId = String(ev['fieldId'] ?? '');
        // SAME-FIELD RESUME. Several apps re-fire focus for the element you are
        // already editing (TextEdit does it mid-typing: focus at 11 chars, then
        // at 49). Treating that as a buffer switch calls resetBufferState,
        // which wipes every DynDef — so a cue would register and vanish before
        // it could be cycled, and cycling could never work in those apps.
        // Same element ⇒ same buffer: update value/cursor and leave runtime
        // state alone. The runtime validates its own spans against the live
        // text before applying, so a changed value needs no reset here.
        // Mirrors the windows shim's fieldId resume (integrations/windows/protocol.md).
        const resume = fieldId !== '' && this.focused !== null && this.focused.fieldId === fieldId;
        this.focused = {
          value: String(ev['value'] ?? ''),
          cursor: Number(ev['cursor'] ?? 0),
          app: String(ev['app'] ?? '?'),
          bundle,
          fieldId,
        };
        this.lastAckMethod = null;
        this.setCapture(true);
        if (resume) {
          // Echo ring stays: our own in-flight writes are still ours.
          this.deps.log('debug', `same-field refocus (${this.focused.app}) — runtime state preserved`);
          break;
        }
        this.ring.clear();
        rt.resetBufferState();
        // Baseline: focus content is context, never a trigger — source
        // 'runtime' seeds the buffer without waking the resolver (a
        // 'user'-sourced focus with previousText='' reads as "a marker
        // appeared" and auto-resolved a pre-existing `_` the moment the
        // field was focused — observed live in TextEdit 2026-07-12).
        // A `_` arms only when the user TYPES one (freshMarkerAtCursor).
        rt.notifyTextChange(this.focused.value, this.focused.cursor, 'runtime');
        this.pushRender();
        this.deps.log('info', 'focus', { app: this.focused.app, chars: this.focused.value.length });
        break;
      }
      case 'blur':
        // LOG IT. A silent blur is indistinguishable from "nothing happened",
        // and since blur wipes runtime state (destroying cue spans) that
        // silence sent two debugging rounds down the wrong path on
        // 2026-07-26. The bridge names one of five causes.
        this.deps.log('debug', `blur (${String(ev['reason'] ?? 'unspecified')}) — buffer state reset, capture off`);
        // Off even when we had no focused element: a tap left armed after a
        // missed focus event would eat the user's chords in an app we aren't
        // even attached to.
        this.setCapture(false);
        if (this.focused) {
          this.focused = null;
          this.ring.clear();
          rt.resetBufferState();
        }
        // Clear unconditionally: stale rects over a field we no longer track are
        // worse than no overlay at all.
        this.pushRender();
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
          this.pushRender();   // our own substitution moved every span
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
        this.pushRender();
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
