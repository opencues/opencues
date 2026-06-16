// Single entry point for the Gemini CLI v0.41 host bootstrap (Phase G.1).
//
// The Gemini-side patch's only job:
//   1. Build a GeminiBindings object from its React/Ink primitives
//      (TextBuffer, useKeypress priority bus, useInputState).
//   2. Call boot(host) once on AppContainer mount.
//   3. Forward KeypressContext events to the returned BootResult.dispatchKey.
//   4. Wrap each InputPrompt visual line through BootResult.decorateLine
//      so dim/highlight ANSI is layered on Ink's per-segment rendering.
//
// Mirrors the OpenCode v1.4 + Claude Code v2.1 patterns; everything else
// lives in the host-agnostic `opencues-runtime` modules.

import { Runtime } from '../../../src/runtime';
import { GeminiV041Adapter, type GeminiBindings } from './adapter';
import { Statusline } from '../../../src/modules/statusline';
import { Resolver } from '../../../src/modules/resolver';
import { AgentRewrite } from '../../../src/modules/agent-rewrite';
import { TTS } from '../../../src/modules/tts';
import { CursorStateExport } from '../../../src/modules/cursor-state-export';
import { ConfigLoader } from '../../../src/modules/config-loader';
import { applyDirectives } from '../../../src/render-directives';
import { buildSharedRuntime, createLogFunction, buildAgentLLMResolver, buildBlankContextProvider, resetSharedBufferState, NATIVE_HOST_MISSING_KEY_MESSAGE, nativeHostFormatLLMError } from '../../../src/boot-common';
import { startEventBridge } from '../../../src/event-bridge';
import { EventEmitter } from '../../../src/lib/event-emitter';
import type {
  CommonHostInfo,
  KeyEvent,
  RenderContext,
  RenderDirectives,
  TextChangeEvent,
} from '../../../src/adapter';

/** Gemini host info — CommonHostInfo plus the spawn-based extensions
 *  that don't apply to sandboxed hosts (chrome). */
export interface HostInfo extends CommonHostInfo {
  /** node:child_process.spawn shim — gemini-cli supplies the real thing,
   *  the runtime's spawnProcess capability check is gated on its
   *  presence in the bindings. */
  spawnProcess?(spec: unknown): unknown;
  /** Optional: TTS script path. spawn-process must be available. */
  ttsScriptPath?: string;
  /**
   * Optional host-native blank dispatch. Same shape as chrome's
   * blankInvoke — BlankFill + Cycling try this BEFORE spawnProcess so
   * shared TS blanks (HackerNewsBlank, etc.) win over the legacy
   * shell scripts in blanks/. Returns null when the blankName
   * isn't in the host's registry; runtime then falls through to
   * spawnProcess (still works for OS blanks like volume/brightness).
   */
  blankInvoke?(spec: import('../../../src/adapter').BlankInvokeSpec):
    import('../../../src/adapter').ProcessHandle | null;
}

export interface BootResult {
  /** Call from a KeypressContext subscriber. Returns true if OpenCues consumed the event. */
  dispatchKey(event: KeyEvent): boolean;
  /** Call when the prompt input value changes (from buffer state observation). */
  notifyTextChange(text: string, cursorOffset: number, source: 'user' | 'runtime'): void;
  /** Call when the cursor moves WITHOUT the text changing (mouse click,
   *  arrow keys, focus). The patched InputPrompt watches its
   *  cursor offset and fires this when it changes alone. Idempotent —
   *  no-op when the offset matches the last-seen value. */
  notifyCursorChange(text: string, cursorOffset: number, source: 'user' | 'runtime'): void;
  /**
   * G.4 — collect render directives from all subscribed handlers
   * (DimRender + future modules). The patch uses these via decorateLine
   * to insert ANSI dim/highlight escapes per visual line.
   */
  collectRenderDirectives(text: string, cursor: number): RenderDirectives[];
  /**
   * G.4 — decorate a single visual-line of the prompt with dim/highlight
   * ANSI escapes that intersect that line's offset range.
   *
   * `lineText` is the visible (no ANSI, no cursor inverse) text of the
   * visual line being rendered. `lineStart` is the absolute offset of
   * that line's first char inside the full buffer text. `lineEnd` is
   * the absolute offset of the last char + 1.
   *
   * Returns the line text wrapped with `\x1b[2m…\x1b[22m` / `\x1b[97m…\x1b[39m`
   * around the visible offsets that fall inside the line, OR the
   * unchanged lineText when no directives intersect (cheap pass-through).
   * Ink renders ANSI escapes inside `<Text>` correctly — the InputPrompt
   * patch swaps the per-segment renderedLine for a single
   * `<Text>{decorated}</Text>` only when this returns a non-equal string.
   */
  decorateLine(lineText: string, fullText: string, cursor: number, lineStart: number, lineEnd: number): string;
  /**
   * Return the dim/highlight ranges that intersect a visual line, in
   * line-relative coordinates. Used by the InputPrompt patch to decide
   * whether each per-segment <Text> should get Ink's `dimColor` or
   * `inverse` prop — keeping the per-segment React structure intact
   * (preserving cursor + syntax highlight) instead of replacing the
   * whole renderedLine with an ANSI-decorated single Text. Returns
   * empty arrays / null when nothing intersects.
   */
  getDirectiveRangesForLine(
    fullText: string,
    cursor: number,
    lineStart: number,
    lineEnd: number,
  ): { dimRanges: { start: number; end: number }[]; highlight: { start: number; end: number } | null };
  /**
   * Pull-model render gate, mirrors CC's pattern. Runtime modules call
   * adapter.setText / setCursorOffset / forceRender which only SET
   * pending flags — they don't write to the host buffer immediately.
   * The host's render path calls this each render cycle: if any
   * pending change exists, returns the new text + cursor for the host
   * to apply (which triggers another render → another consume → until
   * stable). Returns null when nothing's pending. ZWS toggle on the
   * current text fires only when forceRender was set without text /
   * cursor changes (forces React to re-render even though content
   * "looks the same").
   */
  consumePendingRender(currentText: string, currentCursor: number): { text: string; cursor: number } | null;
  /**
   * Wipe per-buffer runtime state (DynDefs, HighlightState, SpanFill,
   * SelectorSatellite). Fire whenever an external mutation has invalidated
   * the runtime's tracked spans — terminal paste, host-level undo, any
   * write that bypasses the runtime's setText pipeline. Idempotent.
   * See `resetSharedBufferState` in `src/boot-common.ts` for the full
   * rationale + state objects deliberately NOT wiped.
   */
  resetBufferState(): void;
  /** Call to dispose the runtime (e.g. on AppContainer unmount). */
  dispose(): void;
}

export function boot(host: HostInfo): BootResult {
  // configLoader is constructed below; isDebugEnabled reads it lazily
  // so OPENCUES.md `debug-mode: on/off` hot-reloads without restart.
  // DEBUG_OPENCUES env is a bootstrap fallback for logs fired before
  // ConfigLoader.load resolves.
  let configLoaderRef: ConfigLoader | null = null;
  const log = createLogFunction({
    sink: (level, msg, data) => host.log?.(level, msg, data),
    isDebugEnabled: () => configLoaderRef?.loaded === true
      ? configLoaderRef.opencuesState.debugMode === 'on'
      : !!process.env.DEBUG_OPENCUES,
  });

  const keyEvents = new EventEmitter<KeyEvent, boolean>();
  const textEvents = new EventEmitter<TextChangeEvent>();
  const cursorEvents = new EventEmitter<import('../../../src/adapter').CursorChangeEvent>();
  const renderEvents = new EventEmitter<RenderContext, RenderDirectives | null>();
  // Module-emitted structured events. ConfigLoader / Resolver / Cycling
  // emit lifecycle events (config.reloaded, resolver.completed,
  // blank.substituted, …) through adapter.emitEvent; the agentic
  // harness's event-bridge subscribes via adapter.onEvent. Without
  // this emitter the bridge never sees the events and scenarios time
  // out waiting for highlight.activated / config.reloaded.
  const moduleEvents = new EventEmitter<{ type: string; body?: Record<string, unknown> }>();

  // Text observation tracking — same rationale as the OC band: do NOT
  // synthesise textChange events when collectRenderDirectives sees drift,
  // because the bootstrap can't reliably tell user-typed drift apart from
  // a runtime-initiated setText/pushText that hasn't yet flowed through
  // React's reconciliation (Cycling.cycleBlank → setText → forceRender
  // run synchronously, before useEffect on buffer.text fires). Synthesising
  // 'user' there clears the highlight.
  let lastSeenText: string | null = null;
  let lastSeenCursor = 0;
  // Strip the trailing ZWS / ZWNJ chars our forceRender toggle adds
  // before exposing text to the runtime — modules expect clean text
  // and word-tokenisation can split weirdly on ZW chars otherwise.
  const stripZw = (s: string): string => s.replace(/[\u200B\u200C]+$/, '');
  // In headless mode (OPENCUES_BRIDGE=1) the React UI never mounts so
  // adapter.onRender never fires. We need every text/cursor mutation
  // to drive a render-event collect so Statusline / DimRender / etc.
  // see fresh state. headlessTrigger is set by the OPENCUES_BRIDGE
  // block below; non-headless interactive runs leave it null and the
  // host's own React reactivity drives renders.
  let headlessTrigger: (() => void) | null = null;
  const fireTextChange = (text: string, cursor: number, source: 'user' | 'runtime'): void => {
    const clean = stripZw(text);
    textEvents.emit(
      { text: clean, cursorOffset: cursor, previousText: stripZw(lastSeenText ?? ''), source },
      err => log('error', 'text handler threw', err),
    );
    lastSeenText = clean;
    lastSeenCursor = cursor;
    headlessTrigger?.();
  };

  const fireCursorChange = (text: string, cursor: number, source: 'user' | 'runtime'): void => {
    const clean = stripZw(text);
    if (cursor === lastSeenCursor && clean === lastSeenText) return;
    cursorEvents.emit(
      { text: clean, cursorOffset: cursor, source },
      err => log('error', 'cursor handler threw', err),
    );
    lastSeenCursor = cursor;
    lastSeenText = clean;
    headlessTrigger?.();
  };

  // Pull-model state — mirrors CC's pattern. Runtime calls
  // setText/setCursorOffset/forceRender which only set these flags;
  // the host's render path calls consumePendingRender to pull the
  // pending state and apply it to the actual buffer. ZWS toggle for
  // forceRender-without-text-change happens inside consumePending.
  let pendingText: string | null = null;
  let pendingCursor: number | null = null;
  let pendingRender = false;

  // Read-only getters — fall back to bridge-tracked lastSeenText
  // when the React buffer isn't populated (headless / no UI mount).
  // Strip trailing ZWS / ZWNJ chars (the ones our forceRender ZWS-
  // toggle adds to nudge React) so the runtime modules see "logical"
  // text. The actual buffer keeps the ZWS char — it's invisible to
  // the user and serves only as React's "string changed" signal.
  const stripTrailingZw = (s: string): string => s.replace(/[\u200B\u200C]+$/, '');
  // Prefer pendingText/pendingCursor when set so synchronous code that
  // writes-then-reads in the same React tick (e.g. resolver runs
  // stopAllAnimations → setText("_") → reads getText() to decide
  // whether to substitute) sees what we JUST wrote rather than React's
  // pre-drain buffer. Without this, "write a poem about love _" hits
  // the FluidBlank "_ already substituted" guard because the React
  // buffer is still the braille loading char from the animator.
  const wrappedGetText = (): string => {
    if (pendingText !== null) return stripTrailingZw(pendingText);
    const live = host.getText();
    if (live) return stripTrailingZw(live);
    return stripTrailingZw(lastSeenText ?? '');
  };
  const wrappedGetCursor = (): number => {
    if (pendingCursor !== null) return pendingCursor;
    const live = host.getCursorOffset();
    return live > 0 ? live : lastSeenCursor;
  };
  // Setters → queue + nudge headless drain.
  //
  // In interactive Gemini, the React render loop calls
  // consumePendingRender each cycle and applies the result. In
  // headless there's no React loop, so the bridge's
  // drainPendingAndRender is the consumer — we kick it after every
  // pending-state mutation. headlessTrigger is only set when
  // OPENCUES_BRIDGE=1; in interactive it's null and the runtime
  // waits for the host to pull. drainPendingAndRender has its own
  // re-entry guard so calling it from a fireTextChange that's
  // ALREADY inside drain doesn't recurse.
  // In headless mode, headlessTrigger drains immediately. In
  // interactive React mode, host.forceRender is the React render-kick
  // (state-bumper); calling it schedules a re-render whose useEffect
  // drains pending state via consumePendingRender. Without the kick,
  // pendingText/Cursor/Render queue forever until the user happens to
  // type or move the cursor.
  const wrappedSetText = (text: string): void => {
    pendingText = text;
    headlessTrigger?.();
    host.forceRender?.();
  };
  const wrappedSetCursorOffset = (offset: number): void => {
    pendingCursor = offset;
    headlessTrigger?.();
    host.forceRender?.();
  };
  const wrappedPushText = (text: string, cursor?: number): void => {
    pendingText = text;
    if (typeof cursor === 'number') pendingCursor = cursor;
    headlessTrigger?.();
    host.forceRender?.();
  };
  const wrappedForceRender = (): void => {
    pendingRender = true;
    headlessTrigger?.();
    host.forceRender?.();
  };

  function toggleZeroWidth(text: string): string {
    const stripped = text.replace(/[\u200B\u200C]+$/, '');
    const endedWithZws = text.length > stripped.length
      && text.charCodeAt(stripped.length) === 0x200b;
    return stripped + (endedWithZws ? '\u200c' : '\u200b');
  }

  function consumePendingRenderImpl(currentText: string, currentCursor: number): { text: string; cursor: number } | null {
    if (!pendingRender && pendingText === null && pendingCursor === null) return null;
    pendingRender = false;
    let result: { text: string; cursor: number };
    if (pendingText !== null || pendingCursor !== null) {
      result = {
        text: pendingText ?? currentText,
        cursor: pendingCursor ?? currentCursor,
      };
      pendingText = null;
      pendingCursor = null;
    } else {
      // forceRender only — nudge React via ZWS toggle.
      result = { text: toggleZeroWidth(currentText), cursor: currentCursor };
    }
    return result;
  }

  const bindings: GeminiBindings = {
    hostVersion: host.hostVersion,
    cwd: host.cwd,
    getText: wrappedGetText,
    getCursorOffset: wrappedGetCursor,
    setText: wrappedSetText,
    setCursorOffset: wrappedSetCursorOffset,
    forceRender: wrappedForceRender,
    registerKeyHandler: cb => keyEvents.subscribe(cb),
    registerTextChangeHandler: cb => textEvents.subscribe(cb),
    registerCursorChangeHandler: cb => cursorEvents.subscribe(cb),
    registerRenderHandler: cb => renderEvents.subscribe(cb),
    readFile: host.readFile,
    readDir: host.readDir,
    writeFile: host.writeFile,
    spawnProcess: host.spawnProcess as GeminiBindings['spawnProcess'],
    blankInvoke: host.blankInvoke,
    pushText: wrappedPushText,
    log,
    emitEvent: (type, body) => moduleEvents.emit(
      { type, body },
      err => log('error', 'event handler threw', err),
    ),
    registerEventHandler: cb => moduleEvents.subscribe(({ type, body }) => cb(type, body)),
  };

  const adapter = new GeminiV041Adapter(bindings);
  Runtime.create(adapter).catch(err => log('error', 'Runtime.create failed', err));

  // Universal state + ConfigLoader + Navigation/DimRender/Cycling/BlankFill
  // all live in boot-common.ts so the chrome / opencode / gemini bands
  // can't drift on subscription order or constructor args.
  const HOME = process.env.HOME ?? '~';
  const configSearchPaths = [
    ...(process.env.OPENCUES_HOME ? [process.env.OPENCUES_HOME] : []),
    `${host.cwd}/.cues`,
    `${HOME}/.cues`,
  ];
  const settingsFile = process.env.OPENCUES_HOME
    ? `${process.env.OPENCUES_HOME}/OPENCUES.md`
    : `${HOME}/.cues/OPENCUES.md`;
  // Build the multi-provider key bag here so Cycling's satellite
  // filter sees the same bag the Resolver dispatches against below.
  const apiKeys: Record<string, string | undefined> = { ...(host.llmApiKeys ?? {}) };
  if (host.llmApiKey && !apiKeys.GROQ_API_KEY) apiKeys.GROQ_API_KEY = host.llmApiKey;
  const shared = buildSharedRuntime(adapter, {
    log, configSearchPaths, settingsFile,
    getApiKeys: () => apiKeys,
  });
  configLoaderRef = shared.configLoader;

  const {
    configLoader, hlState, dynDefs,
    spanFillState, selectorSatelliteState, agentTaskState,
  } = shared;

  // Phase G.7 — Statusline (file-based) + in-process snapshot hook so
  // the Gemini Footer can render the tip natively. Both sinks are
  // opt-in; either or both can be wired.
  if (host.statusFilePath || host.statusSnapshotHook) {
    const statusline = new Statusline(adapter, hlState, dynDefs, {
      exportPath: host.statusFilePath ?? '',
      onSnapshot: host.statusSnapshotHook
        ? (payload) => host.statusSnapshotHook!(payload)
        : undefined,
    }, configLoader, spanFillState, selectorSatelliteState, agentTaskState);
    statusline.subscribe();
  }

  // CursorStateExport — opt-in. The opencues-auto test harness reads
  // the export to drive automated runs; no in-tree consumer.
  if (host.cursorStatePath && adapter.capabilities.includes('file-write')) {
    const cse = new CursorStateExport(adapter, { exportPath: host.cursorStatePath });
    cse.subscribe();
  }

  // Phase G.7 — TTS. Opt-in via host.ttsScriptPath + spawn-process cap.
  if (host.ttsScriptPath && adapter.capabilities.includes('spawn-process')) {
    const tts = new TTS(adapter, hlState, dynDefs, configLoader, {
      scriptPath: host.ttsScriptPath,
      rate: host.ttsRate !== undefined ? String(host.ttsRate) : undefined,
    }, spanFillState, selectorSatelliteState);
    tts.subscribe();
  }

  // Phase G.7 — LLM Resolver + AgentRewrite. Same wiring as OC band.
  // `apiKeys` is built above (before buildSharedRuntime) so Cycling's
  // satellite filter sees the same bag.
  const hasAnyKey = Object.values(apiKeys).some(Boolean);
  // Resolver constructed even with no keys so MissingKeyFallbackSource
  // surfaces a visible in-buffer hint on `_` instead of silent no-op.
  const resolver = new Resolver(adapter, hlState, dynDefs, configLoader, {
    endpoint: host.llmEndpoint ?? 'https://api.groq.com/openai/v1/chat/completions',
    apiKey: host.llmApiKey ?? apiKeys.GROQ_API_KEY ?? '',
    defaultModel: host.llmDefaultModel ?? 'openai/gpt-oss-120b',
    apiKeys,
    debounceMs: host.llmDebounceMs ?? 500,
    missingKeyFallbackMessage: hasAnyKey ? undefined : NATIVE_HOST_MISSING_KEY_MESSAGE,
    formatLLMErrorAsSubstitute: nativeHostFormatLLMError,
    keywordBoundSlotIndices: (text: string) => shared.blankFill.scan(text).map(s => s.index),
    runIntegration: shared.integrationRunner ?? undefined,
    runTokenIntegration: shared.tokenIntegrationRunner ?? undefined,
    runRewritePolish: shared.rewritePolishRunner ?? undefined,
  }, spanFillState, agentTaskState, shared.blankLoading, shared.markdownRender, selectorSatelliteState,
  buildBlankContextProvider(configLoader, host.blanks, log));
  // Subscribe AFTER ConfigLoader.load — otherwise rebuildResolver sees
  // no cuesConfig/blanksConfig and bails.
  configLoader.load().then(() => resolver.subscribe()).catch(() => { /* logged by ConfigLoader */ });

  if (hasAnyKey) {

    const agentRewrite = new AgentRewrite(adapter, dynDefs, agentTaskState, {
      endpoint: host.llmEndpoint ?? 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: host.llmApiKey ?? apiKeys.GROQ_API_KEY ?? '',
      defaultModel: host.llmDefaultModel ?? 'openai/gpt-oss-120b',
      resolveLLM: () => buildAgentLLMResolver(configLoader, apiKeys),
      windowWords: () => parseInt(configLoader.opencuesState.settings.get('agent-window-words') ?? '0', 10) || 0,
      cadenceMs: () => parseInt(configLoader.opencuesState.settings.get('agent-debounce-ms') ?? '', 10),
      auditorPrompts: () => configLoader.composeAuditorPrompts(),
      maxConcurrentAuditors: () => parseInt(configLoader.opencuesState.settings.get('max-concurrent-auditors') ?? '', 10) || 0,
    });
    agentRewrite.start();
  }

  log('info', 'OpenCues runtime starting (Gemini CLI v0.41)', {
    host: 'gemini-cli',
    hostVersion: host.hostVersion,
    capabilities: adapter.capabilities,
  });

  // Internal event-bridge — opt-in via OPENCUES_BRIDGE=1. Polls a
  // synthetic-input file and forwards module events to a JSONL stream
  // for off-process tooling (the agentic harness in tests/agentic/
  // launches a host with this flag set, then drives it from outside).
  //
  // notifyTextChange / notifyCursorChange wire through to the same
  // emitters the BootResult exposes, so synthetic injects reach the
  // Resolver / Statusline / CursorStateExport pipeline directly.
  // Without this, Gemini's TextBuffer-mutation path skips the runtime
  // notify and the resolver never sees the buffer change.
  if (process.env.OPENCUES_BRIDGE === '1') {
    // Headless render driver. In interactive Gemini the React render
    // path calls consumePendingRender each cycle and writes back to
    // the buffer. In headless there's no React loop, so the bridge
    // does the same job: after every key/text event, drain pending
    // changes from the runtime (consume + apply + fire textEvents +
    // re-consume) until stable, then collect renderEvents (so
    // Statusline / DimRender pick up the new state).
    let inDrain = false;
    const drainPendingAndRender = (): void => {
      // Re-entry guard. fireTextChange below calls headlessTrigger
      // (this function) recursively when a subscriber's reaction
      // queues more pending state. The outer loop already iterates,
      // so just no-op the inner call and let the loop pick it up.
      if (inDrain) return;
      inDrain = true;
      try {
        let iterations = 0;
        while (iterations < 16) {
          const pending = consumePendingRenderImpl(lastSeenText ?? '', lastSeenCursor);
          if (!pending) break;
          // Apply pending state via fire*Change so subscribers
          // (Resolver / Statusline / Cycling / Navigation) react and
          // may queue more pending — the loop catches that on next
          // iteration.
          if (pending.text !== lastSeenText) {
            fireTextChange(pending.text, pending.cursor, 'runtime');
          } else if (pending.cursor !== lastSeenCursor) {
            fireCursorChange(pending.text, pending.cursor, 'runtime');
          }
          iterations++;
        }
        // Render with the settled state.
        const ctx: RenderContext = { text: lastSeenText ?? '', cursor: lastSeenCursor, externalHighlights: [] };
        try { renderEvents.collect(ctx, err => log('error', 'render handler threw', err)); }
        catch (err) { log('error', 'drainPendingAndRender threw', err); }
      } finally {
        inDrain = false;
      }
    };
    // Wire fireTextChange / fireCursorChange to also kick the drain
    // loop — covers any path that fires text events directly.
    headlessTrigger = drainPendingAndRender;
    startEventBridge({
      adapter,
      dispatchKey: (e) => {
        const consumed = keyEvents.emitUntilConsumed(e, err => log('error', 'key handler threw', err));
        drainPendingAndRender();
        return consumed;
      },
      notifyTextChange: (text, cursor, source) => {
        fireTextChange(text, cursor, source);
        drainPendingAndRender();
      },
      notifyCursorChange: (text, cursor, source) => {
        fireCursorChange(text, cursor, source);
        drainPendingAndRender();
      },
      state: { hlState, dynDefs, spanFillState, selectorSatelliteState, agentTaskState },
    });
  }

  return {
    dispatchKey(event) {
      return keyEvents.emitUntilConsumed(event, err => log('error', 'key handler threw', err));
    },
    notifyTextChange(text, cursorOffset, source) {
      fireTextChange(text, cursorOffset, source);
    },
    notifyCursorChange(text, cursorOffset, source) {
      fireCursorChange(text, cursorOffset, source);
    },
    collectRenderDirectives(text, cursor) {
      // Observe-only — never synthesise textChange here. Cycling.cycleBlank +
      // forceRender race the React buffer-watcher and would otherwise look
      // like user drift.
      lastSeenText = text;
      lastSeenCursor = cursor;
      const ctx: RenderContext = { text, cursor, externalHighlights: [] };
      return renderEvents.collect(ctx, err => log('error', 'render handler threw', err));
    },
    decorateLine(lineText, fullText, cursor, lineStart, lineEnd) {
      // Pass-through fast path: no handlers subscribed → nothing to layer on.
      if (renderEvents.size === 0) return lineText;
      const ctx: RenderContext = { text: fullText, cursor, externalHighlights: [] };
      const directiveSets = renderEvents.collect(ctx, err => log('error', 'render handler threw', err));

      // Clip every directive's ranges to [lineStart, lineEnd) and shift
      // to be relative to lineStart so applyDirectives walks a string
      // whose visible offset 0 is the line's first char.
      const clipped: RenderDirectives = { dimRanges: [] };
      const dim: { start: number; end: number }[] = [];
      const bold: { start: number; end: number }[] = [];
      const italic: { start: number; end: number }[] = [];
      const code: { start: number; end: number }[] = [];
      const strike: { start: number; end: number }[] = [];
      const heading: { start: number; end: number }[] = [];
      const list: { start: number; end: number }[] = [];
      // BlankLoadingAnimator emits coloredRanges per tick — each
      // carries its own ansi token, so unlike the kind-based ranges
      // they can't share a single bucket. Clip independently and
      // hand the full list to applyDirectives.
      const colored: Array<{ start: number; end: number; ansi?: string; rgb?: string }> = [];
      const clip = (ranges: readonly { start: number; end: number }[] | undefined, dest: { start: number; end: number }[]): void => {
        if (!ranges) return;
        for (const r of ranges) {
          const s = Math.max(r.start, lineStart);
          const e = Math.min(r.end, lineEnd);
          if (s < e) dest.push({ start: s - lineStart, end: e - lineStart });
        }
      };
      for (const d of directiveSets) {
        if (d.textOverride !== undefined) {
          return d.textOverride.slice(lineStart, lineEnd);
        }
        clip(d.dimRanges, dim);
        clip(d.boldRanges, bold);
        clip(d.italicRanges, italic);
        clip(d.codeRanges, code);
        clip(d.strikeRanges, strike);
        clip(d.headingRanges, heading);
        clip(d.listRanges, list);
        if (d.highlight) {
          const s = Math.max(d.highlight.start, lineStart);
          const e = Math.min(d.highlight.end, lineEnd);
          if (s < e) clipped.highlight = { start: s - lineStart, end: e - lineStart };
        }
        const cr = (d as { coloredRanges?: readonly { start: number; end: number; ansi?: string; rgb?: string }[] }).coloredRanges;
        if (cr) {
          for (const r of cr) {
            const s = Math.max(r.start, lineStart);
            const e = Math.min(r.end, lineEnd);
            if (s < e) colored.push({ start: s - lineStart, end: e - lineStart, ansi: r.ansi, rgb: r.rgb });
          }
        }
      }
      clipped.dimRanges = dim;
      clipped.boldRanges = bold;
      clipped.italicRanges = italic;
      clipped.codeRanges = code;
      clipped.strikeRanges = strike;
      clipped.headingRanges = heading;
      clipped.listRanges = list;
      clipped.coloredRanges = colored;

      // No intersecting directives → return the line unchanged so the
      // InputPrompt patch keeps its per-segment <Text> rendering (preserves
      // syntax highlighting + cursor inverse for non-cued lines).
      if (
        dim.length === 0 && bold.length === 0 && italic.length === 0 &&
        code.length === 0 && strike.length === 0 && heading.length === 0 &&
        list.length === 0 && colored.length === 0 && !clipped.highlight
      ) return lineText;

      return applyDirectives(lineText, clipped);
    },
    getDirectiveRangesForLine(fullText, cursor, lineStart, lineEnd) {
      // Mirrors decorateLine's collect+clip logic but returns the
      // raw clipped ranges instead of an ANSI-decorated string. The
      // InputPrompt patch uses these to apply Ink's dimColor / inverse
      // props per existing segment (preserving React/cursor structure)
      // rather than replacing the whole renderedLine.
      if (renderEvents.size === 0) return { dimRanges: [], highlight: null };
      const ctx: RenderContext = { text: fullText, cursor, externalHighlights: [] };
      const directiveSets = renderEvents.collect(ctx, err => log('error', 'render handler threw', err));
      const dimRanges: { start: number; end: number }[] = [];
      let highlight: { start: number; end: number } | null = null;
      for (const d of directiveSets) {
        if (d.dimRanges) {
          for (const r of d.dimRanges) {
            const s = Math.max(r.start, lineStart);
            const e = Math.min(r.end, lineEnd);
            if (s < e) dimRanges.push({ start: s - lineStart, end: e - lineStart });
          }
        }
        if (d.highlight) {
          const s = Math.max(d.highlight.start, lineStart);
          const e = Math.min(d.highlight.end, lineEnd);
          if (s < e) highlight = { start: s - lineStart, end: e - lineStart };
        }
      }
      return { dimRanges, highlight };
    },
    consumePendingRender(currentText, currentCursor) {
      return consumePendingRenderImpl(currentText, currentCursor);
    },
    resetBufferState() {
      resetSharedBufferState(shared);
    },
    dispose() {
      adapter.dispose();
      keyEvents.clear();
      textEvents.clear();
      cursorEvents.clear();
      renderEvents.clear();
    },
  };
}
