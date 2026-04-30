// Statusline — exports a JSON snapshot of the runtime state on every render
// for an external consumer (e.g. integrations/claude-code/patches/highlight-statusline.sh).
//
// The shape mirrors what v1's wordHighlight.ts wrote to
// /tmp/opencues-highlight-state-<pid>.json so the existing shell consumer
// keeps working unchanged. Phase 4 covers the navigation+cycling subset of
// fields; LLM/blank fields land as their modules ship.
//
// Writes are deduped by content — only fires when the JSON actually changes,
// so a busy render loop doesn't spam the disk.

import type { HostAdapter, RenderContext, Unsubscribe } from '../adapter';
import type { HighlightState } from '../state/highlight-state';
import type { DynDefs } from '../state/dyn-defs';
import type { ConfigLoader } from './config-loader';
import type { SpanFillState } from '../state/span-fill';
import type { SelectorSatelliteState } from '../state/selector-satellite';
import { splitWords } from './navigation';

export interface StatuslineOptions {
  /**
   * Absolute path. Typically /tmp/opencues-highlight-state-<pid>.json.
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
     * blankTip wins over cueMap lookup (which would miss filled words
     * like "13.9°C" or "Reddit"). Phase F.b.
     */
    private spanFillState?: SpanFillState,
    /**
     * Optional. Selector/satellite tip routing (Step 35 / Phase G.b):
     * selector word shows the setting's `tip`; satellite shows the
     * per-value tip from opencues.md `settings:` block.
     */
    private selectorSatelliteState?: SelectorSatelliteState,
  ) {}

  subscribe(): void {
    this._unsub = this.adapter.onRender(ctx => {
      this.maybeWrite(ctx);
      return null;
    });
  }

  unsubscribe(): void {
    if (this._unsub) { this._unsub(); this._unsub = null; }
  }

  /** Exposed for testing — build the payload from current state + render ctx. */
  buildPayload(ctx: RenderContext): StatuslinePayload {
    if (!this.hlState.active || this.hlState.wordIndex === null) {
      return { active: false, timestamp: Date.now() };
    }
    // tips-mode: off → still expose word + alts but suppress tip text.
    const tipsHidden = this.configLoader?.opencuesState.tipsMode === 'off';
    const wordIndex = this.hlState.wordIndex;
    const def = this.dynDefs.get(wordIndex);
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

    // Phase G.b — selector/satellite takes priority over both span and
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

    // Phase F.b — span fill takes priority. When the highlight is on
    // any word inside an active span, render the blank's blankTip
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
        cueTip: tipsHidden ? null : span.blankTip ?? null,
        altCueTips: null,
        cueBlank: true,
        wordCount: words.filter(w => clean(w.word).length > 0).length,
        timestamp: Date.now(),
      };
    }

    // Phase I.8 — blank-attributed DynDef (volume/brightness blank
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
    };
  }

  private maybeWrite(ctx: RenderContext): void {
    if (!this.adapter.capabilities.includes('file-write')) return;
    const payload = this.buildPayload(ctx);
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
    this.adapter.writeFile(this.options.exportPath, json)
      .then(() => {
        if (this.options.refreshHook) {
          try { this.options.refreshHook(); } catch (err) {
            this.adapter.log('error', 'Statusline refreshHook threw', err);
          }
        }
      })
      .catch(err => {
        this.adapter.log('error', 'Statusline writeFile failed', err);
      });
  }
}
