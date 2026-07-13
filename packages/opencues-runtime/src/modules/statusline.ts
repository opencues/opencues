// Statusline — exports a JSON snapshot of the runtime state on every render
// for an external consumer (e.g. integrations/claude-code/patches/highlight-statusline.sh).
//
// The shape mirrors what the original CC patch wrote to
// /tmp/opencues-status-<pid>.json so the existing shell consumer
// keeps working unchanged. The payload covers navigation, cycling,
// LLM-resolved alternatives, and blank-fill state.
//
// Writes are deduped by content — only fires when the JSON actually changes,
// so a busy render loop doesn't spam the disk.

import type { HostAdapter, RenderContext, Unsubscribe } from '../adapter';
import type { HighlightState } from '../state/highlight-state';
import type { DynDefs } from '../state/dyn-defs';
import type { ConfigLoader } from './config-loader';
import type { SpanFillState } from '../state/span-fill';
import type { SelectorSatelliteState } from '../state/selector-satellite';
import type { AgentTaskState } from '../state/agent-task';
import type { ProviderHealth, ProviderHealthEvent } from './provider-health';
import type { UndoApplyReport } from '../state/undo-journal';
import { splitWords } from './navigation';

export interface StatuslineOptions {
  /**
   * Absolute path. Typically /tmp/opencues-status-<pid>.json.
   * Empty string disables file export — useful when only onSnapshot is
   * wired (host renders the tip in-process).
   */
  readonly exportPath: string;
  /**
   * Optional. Called after each successful export write — host-specific
   * trigger to make the host re-read/redisplay the export immediately
   * (e.g. on Claude Code, this calls the captured statusline-refresh
   * useCallback). When absent, the host must poll on its own schedule.
   */
  readonly refreshHook?: () => void;
  /**
   * Optional. Called in-process with the freshly-built payload on every
   * state change (deduped). Lets a host render the tip natively without
   * having to tail the export file. Fires even when exportPath writes
   * succeed — both sinks are driven by the same maybeWrite pass.
   */
  readonly onSnapshot?: (payload: StatuslinePayload) => void;
  /**
   * Optional. Live kata-mode status feed (KataCoach.status).
   * When it returns non-null, the payload carries a `kata` block —
   * step counter + one coaching line — that consumers render as the
   * dominant statusline content while a kata is active.
   */
  readonly kataStatus?: () => {
    readonly name: string;
    readonly title: string;
    readonly step: number;
    readonly stepCount: number;
    readonly stepTitle: string;
    readonly coach: string | null;
    readonly coachSegments: ReadonlyArray<{ readonly text: string; readonly command: boolean }> | null;
    readonly offTrack: boolean;
  } | null;
  /**
   * Optional. Recent undo/redo apply report (UndoJournal.recentApply-
   * Report thunk, TTL-gated by the journal). Non-null → the payload
   * carries an `undo` block so consumers can surface partial-skip
   * honesty ("undid text; volume couldn't be restored") without the
   * buffer carrying the detail.
   */
  readonly undoStatus?: () => UndoApplyReport | null;
}

export interface StatuslinePayload {
  active: boolean;
  highlightedWordIndex?: number;
  highlightedWord?: string;
  currentAltIndex?: number;
  alts?: readonly string[];
  /** Tip for the currently-displayed word (alt-specific if available, else primary). */
  cueTip?: string | null;
  /** Per-alt tips. Mirrors v1's altCueTips for consumers that want to preview. */
  altCueTips?: Readonly<Record<string, string>> | null;
  cueBlank?: boolean;
  wordCount?: number;
  timestamp: number;
  /** Agent-task indicator. When armed, contains a truncated form of the
   *  current task prompt (last ~40 chars). null when no task is armed. */
  agentTask?: string | null;
  /**
   * Current ProviderHealth event, if any — sticky errors (auth /
   * quota / model-missing) stay until cleared; transient (rate-limit /
   * outage) auto-clear after the bus's TTL. The shell consumer renders
   * this as a prefix like `[opencues: bad / missing API key]` so the
   * user has visible feedback when LLM calls are silently failing.
   */
  providerError?: {
    readonly kind: ProviderHealthEvent['kind'];
    readonly message: string;
    readonly sticky: boolean;
    readonly provider?: string;
    readonly model?: string;
  } | null;
  /**
   * Kata-mode block. Non-null while a kata is active — step
   * counter + the live coaching line. Consumers should render this as
   * the dominant statusline content (kata mode overrides normal
   * cue/tip display). null / absent when no kata is running.
   */
  kata?: {
    readonly name: string;
    readonly title: string;
    readonly step: number;
    readonly stepCount: number;
    readonly stepTitle: string;
    readonly coach: string | null;
    readonly coachSegments: ReadonlyArray<{ readonly text: string; readonly command: boolean }> | null;
    readonly offTrack: boolean;
  } | null;
  /**
   * Recent undo/redo apply report — non-null for a short TTL after an
   * `undo _` / `redo _` fires. Carries applied/skipped counts + skip
   * reasons so hosts can render partial-failure honesty out-of-band.
   */
  undo?: UndoApplyReport | null;
}

export class Statusline {
  private _unsub: Unsubscribe | null = null;
  private _lastJson = '';

  constructor(
    private adapter: HostAdapter,
    private hlState: HighlightState,
    private dynDefs: DynDefs,
    private options: StatuslineOptions,
    /** Optional. When provided, cueTip + altCueTips are populated from the cue map. */
    private configLoader?: ConfigLoader,
    /**
     * Optional. When the highlight is on a span fill, the blank's
     * tip wins over cueMap lookup (which would miss filled words
     * like "13.9°C" or "Reddit").
     */
    private spanFillState?: SpanFillState,
    /**
     * Optional. Selector/satellite tip routing:
     * selector word shows the setting's `tip`; satellite shows the
     * per-value tip from OPENCUES.md `settings:` block.
     */
    private selectorSatelliteState?: SelectorSatelliteState,
    /**
     * Optional. When provided + armed, statusline payload includes
     * `agentTask: <truncated prompt>`. Lets the host display
     * `[task: ...]` so the user can see which agent is running.
     */
    private agentTaskState?: AgentTaskState,
    /**
     * Optional. When provided, the latest event from the bus is
     * mirrored into StatuslinePayload.providerError on every render.
     * Subscribing to the bus also triggers an immediate re-render so
     * sticky errors (auth/quota) appear without waiting for the user
     * to type — without this the user wouldn't see the error until
     * the next keystroke.
     */
    private providerHealth?: ProviderHealth,
  ) {}

  /** Unsub fn for the ProviderHealth bus. Null when no health bus wired. */
  private _phUnsub: (() => void) | null = null;
  /** Unsub fn for the hlState change bus. */
  private _hlUnsub: (() => void) | null = null;

  subscribe(): void {
    this._unsub = this.adapter.onRender(ctx => {
      this.maybeWrite(ctx);
      return null;
    });
    // Subscribe to hlState changes too. The onRender path runs the FIRST
    // applyRender after the host re-renders, which on CC happens AFTER
    // React commits the state-bumper kick. The agentic harness's
    // `expect path:active equals true` polls the status file the same
    // tick the highlight.activated event is observed — without a
    // direct hlState subscription, the file is one React-render-cycle
    // behind. Subscribing here lets us flush the snapshot synchronously
    // when activate/deactivate fires.
    this._hlUnsub = this.hlState.onChange(() => {
      this.maybeWrite({ text: this.hlState.text, cursor: 0, externalHighlights: [] });
    });
    // Mirror ProviderHealth changes into the statusline immediately —
    // sticky errors should be visible without the user having to type.
    // The host adapter may not expose a synchronous redraw, so we just
    // ask for one via forceRender if available; otherwise the next
    // keystroke's onRender will pick up the new state.
    if (this.providerHealth) {
      this._phUnsub = this.providerHealth.subscribe(() => {
        try { this.adapter.forceRender?.(); } catch { /* host may not support force-render */ }
      });
    }
  }

  unsubscribe(): void {
    if (this._unsub) { this._unsub(); this._unsub = null; }
    if (this._phUnsub) { this._phUnsub(); this._phUnsub = null; }
    if (this._hlUnsub) { this._hlUnsub(); this._hlUnsub = null; }
  }

  /** Exposed for testing — build the payload from current state + render ctx. */
  buildPayload(ctx: RenderContext): StatuslinePayload {
    const agentTask = this.formatAgentTask();
    // `active` means "OpenCues has an interactive region the user
    // navigated onto and is acting on right now." A substituted span
    // (BlankFill / fluid-blank / transform-blank / agent-rewrite)
    // becomes cyclable as soon as it lands, but ONLY hlState.active
    // marks the user-acknowledged target.
    //
    // History: this branch used to elevate any live spanFillState to
    // active=true even when hlState was inactive — the rationale was
    // that BlankFill scenarios polled `active === true` after a
    // substitute to assert "the run completed." Those scenarios moved
    // to `waitForEvent` on `blank.substituted` (the canonical
    // completion signal) and the one remaining waiter sits under
    // tests/agentic/scenarios/_flaky/. Removing the elevation gives
    // the no-tip-no-highlight UX every host needs: the user must
    // navigate onto the span (Tab / Ctrl+Alt+arrow) before the
    // statusline emits ANY tip or selection signal. Cycling continues
    // to work — Cycling.ts reads spanFillState directly and is not
    // gated on the statusline's active flag.
    if (!this.hlState.active || this.hlState.wordIndex === null) {
      return { active: false, timestamp: Date.now(), agentTask };
    }
    // tips-mode: off → still expose word + alts but suppress tip text.
    const tipsHidden = this.configLoader?.opencuesState.tipsMode === 'off';
    const wordIndex = this.hlState.wordIndex;
    // Direct lookup matches multi-word substitute DefAt the origin word
    // only. If the highlight is on word N>origin inside a multi-word span
    // (fluid/transform blank substitutes are always multi-word — the
    // LLM emits 2+ word answers), `dynDefs.get(wordIndex)` returns
    // undefined and the code falls through to the word-cue lookup at
    // the bottom of this function. That surfaces a word-cue tip for an
    // individual word in the LLM-substituted body (e.g. "email" inside a
    // draft) — confusing because the user didn't write that word, the
    // LLM did. Use `findSpanContaining` so any word inside a
    // blankName-attributed span (`fluid-blank`, `transform-blank`,
    // `agent-rewrite`) resolves to the originating def and goes through
    // the suppression branch below.
    let def = this.dynDefs.get(wordIndex);
    if (!def) {
      const span = this.dynDefs.findSpanContaining(wordIndex);
      if (span) def = span.def;
    }
    const words = splitWords(ctx.text);
    let highlightedWord: string;
    if (def) {
      highlightedWord = def.alternatives[def.currentIndex] ?? def.originalWord;
    } else {
      highlightedWord = words[wordIndex]?.word ?? '';
    }
    // Strip our zero-width-toggle noise so the consumer sees clean strings.
    const clean = (s: string): string => s.replace(/[\u200B\u200C]/g, '');
    const cleanHighlighted = clean(highlightedWord);

    // Selector/satellite takes priority over both span and
    // cue lookup. Selector word emits the setting's `tip`; satellite
    // emits the value-specific tip. cueBlank=true so the consumer
    // prints the tip alone.
    const ss = this.selectorSatelliteState?.current ?? null;
    const ssSelEnd = ss ? ss.selectorIndex + Math.max(1, ss.selectorLength) - 1 : 0;
    const ssSatEnd = ss ? ss.satelliteIndex + Math.max(1, ss.satelliteLength) - 1 : 0;
    const ssOnSelector = ss !== null && wordIndex >= ss.selectorIndex && wordIndex <= ssSelEnd;
    const ssInSatellite = ss !== null && wordIndex >= ss.satelliteIndex && wordIndex <= ssSatEnd;
    if (ss && (ssOnSelector || ssInSatellite)) {
      const def = this.configLoader?.opencuesState.definitions.get(ss.currentSetting);
      let ssTip: string | null = null;
      if (def) {
        ssTip = ssOnSelector
          ? def.tip ?? null
          : def.valueTips.get(ss.currentValue) ?? null;
      }
      return {
        active: true,
        highlightedWordIndex: wordIndex,
        highlightedWord: cleanHighlighted,
        currentAltIndex: 0,
        alts: [cleanHighlighted],
        cueTip: tipsHidden ? null : ssTip,
        altCueTips: null,
        cueBlank: true,
        wordCount: words.filter(w => clean(w.word).length > 0).length,
        timestamp: Date.now(),
      };
    }

    // Span fill takes priority. When the highlight is on
    // any word inside an active span, render the blank's tip
    // (e.g. "Daily affirmations", "Prompt improver") and treat the
    // span as a single cycleable unit (cueBlank=true so the shell
    // consumer prints just the tip instead of "(N/M) - tip").
    const span = this.spanFillState?.current ?? null;
    const inSpan = span !== null
      && wordIndex >= span.index
      && wordIndex < span.index + Math.max(1, span.spanLength);
    if (inSpan && span) {
      return {
        active: true,
        highlightedWordIndex: wordIndex,
        highlightedWord: cleanHighlighted,
        currentAltIndex: span.currentAltIndex,
        alts: span.alternatives.map(clean),
        cueTip: tipsHidden ? null : span.tip ?? null,
        altCueTips: null,
        cueBlank: true,
        wordCount: words.filter(w => clean(w.word).length > 0).length,
        timestamp: Date.now(),
      };
    }

    // Blank-attributed DynDef (volume/brightness blank
    // fill at "50%"): suppress the statusline tip entirely. The value
    // is already visible in the input ("50%") and the tip would be
    // redundant ("system volume blank 50%").
    if (def?.blankName) {
      return {
        active: true,
        highlightedWordIndex: wordIndex,
        highlightedWord: cleanHighlighted,
        currentAltIndex: 0,
        alts: [cleanHighlighted],
        cueTip: null,
        altCueTips: null,
        cueBlank: true,
        wordCount: words.filter(w => clean(w.word).length > 0).length,
        timestamp: Date.now(),
      };
    }

    // Cue lookup: primary key is the original word (stable across cycling).
    // For tip display, prefer altCueTips[currentDisplayedWord] over the
    // primary cueTip — mirrors v1's behaviour where each alt can have its
    // own tip text.
    const lookupKey = clean(def?.originalWord ?? highlightedWord);
    const lookup = this.configLoader?.lookup(lookupKey) ?? null;
    let cueTip: string | null = null;
    let altCueTips: Record<string, string> | null = null;
    if (lookup && !tipsHidden) {
      altCueTips = lookup.altCueTips ?? null;
      cueTip = lookup.altCueTips?.[cleanHighlighted] ?? lookup.cueTip ?? null;
    }

    // When the highlighted word is a blank or blankKeyword (volume,
    // brightness, etc.), the consumer should print "tip alone" rather
    // than "word (N/M) - tip". This mirrors v1's `cueBlank=true`
    // routing for blank words.
    const blkEntry = this.configLoader?.blanksByWord.get(lookupKey);
    const isBlankWord = blkEntry != null;

    return {
      active: true,
      highlightedWordIndex: wordIndex,
      highlightedWord: cleanHighlighted,
      currentAltIndex: def?.currentIndex ?? 0,
      alts: def ? def.alternatives.map(clean) : [cleanHighlighted],
      cueTip,
      altCueTips,
      cueBlank: isBlankWord,
      wordCount: words.filter(w => clean(w.word).length > 0).length,
      timestamp: Date.now(),
      agentTask,
    };
  }

  /**
   * Truncated form of the current agent task prompt — last ~40 chars
   * with `…` prefix when longer. Returns null when no task is armed.
   * Lets the consumer render `[task: <truncated>]` in the statusline.
   */
  private formatAgentTask(): string | null {
    if (!this.agentTaskState?.armed) return null;
    const prompt = this.agentTaskState.prompt;
    const MAX = 40;
    if (prompt.length <= MAX) return prompt;
    return '…' + prompt.slice(-MAX);
  }

  /** Snapshot the current ProviderHealth event into the payload shape. */
  private currentProviderError(): StatuslinePayload['providerError'] {
    if (!this.providerHealth) return undefined;
    const ev = this.providerHealth.current();
    if (!ev) return null;
    return {
      kind: ev.kind, message: ev.message, sticky: ev.sticky,
      provider: ev.provider, model: ev.model,
    };
  }

  private maybeWrite(ctx: RenderContext): void {
    if (!this.adapter.capabilities.includes('file-write')) return;
    // Always re-merge providerError so it appears even when buildPayload
    // returned an `active: false` early branch. Cleaner than threading
    // through every return — health is orthogonal to highlight state.
    const built = this.buildPayload(ctx);
    const providerError = this.currentProviderError();
    let payload: StatuslinePayload = providerError !== undefined ? { ...built, providerError } : built;
    // Kata block is orthogonal to highlight state (like providerError)
    // — merge here so it survives the `active: false` early branch too.
    if (this.options.kataStatus) {
      payload = { ...payload, kata: this.options.kataStatus() };
    }
    // Undo block — same orthogonal-merge treatment (TTL lives in the
    // journal's recentApplyReport, so it ages out on its own).
    if (this.options.undoStatus) {
      payload = { ...payload, undo: this.options.undoStatus() };
    }
    // Strip timestamp before content-comparison so identical-state renders
    // don't trigger writes purely because of clock change.
    const { timestamp: _t, ...stable } = payload;
    void _t;
    const stableJson = JSON.stringify(stable);
    if (stableJson === this._lastJson) return;
    this._lastJson = stableJson;
    if (this.options.onSnapshot) {
      try { this.options.onSnapshot(payload); } catch (err) {
        this.adapter.log('error', 'Statusline onSnapshot threw', err);
      }
    }
    if (!this.options.exportPath) return;
    const json = JSON.stringify(payload);
    const exportPath = this.options.exportPath;
    this.adapter.writeFile(exportPath, json)
      .then(() => {
        if (this.options.refreshHook) {
          try { this.options.refreshHook(); } catch (err) {
            this.adapter.log('error', 'Statusline refreshHook threw', err);
          }
        }
        // Emit the structured event AFTER the disk write resolves so
        // any event-bridge consumer can treat it as a barrier — any
        // subsequent read of `exportPath` sees fresh content. Without
        // this, a synchronous state-probe could emit `highlight.activated`
        // BEFORE the async writeFile lands, racing readers of the status
        // file right after the highlight event fires.
        try {
          this.adapter.emitEvent?.('statusline.snapshot', { ...payload, exportPath });
        } catch (err) {
          this.adapter.log('error', 'Statusline emitEvent threw', err);
        }
      })
      .catch(err => {
        this.adapter.log('error', 'Statusline writeFile failed', err);
      });
  }
}
