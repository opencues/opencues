// TTS — speaks the cue tip when the highlight lands on a `speak: true` word.
//
// Subscribes onRender (the only "something changed" signal we have without
// adding a new event type). Dedups by (originalWord, displayedWord) so a
// single nav-then-cycle sequence speaks at most once per (word, alt) pair.
// Fire-and-forget via adapter.spawnProcess({detached: true}) — we don't wait.
//
// Mirrors v1's behaviour (dynamicHighlight.ts:643): TTS only fires when the
// cue lookup has speak:true, the word has a tip, and the spawn-process
// capability is available. No-op otherwise.

import type { HostAdapter, RenderContext, Unsubscribe } from '../adapter';
import type { HighlightState } from '../state/highlight-state';
import type { DynDefs } from '../state/dyn-defs';
import type { ConfigLoader } from './config-loader';
import type { SpanFillState } from '../state/span-fill';
import type { SelectorSatelliteState } from '../state/selector-satellite';
import { splitWords } from './navigation';

export interface TTSOptions {
  /** Absolute path to the TTS script. Typically ~/.claude/actions/speak.sh. */
  readonly scriptPath: string;
  /** Rate passed as 2nd arg. Defaults to '2'. */
  readonly rate?: string;
}

export class TTS {
  private _unsub: Unsubscribe | null = null;
  private _lastSpoken: string | null = null;

  constructor(
    private adapter: HostAdapter,
    private hlState: HighlightState,
    private dynDefs: DynDefs,
    private configLoader: ConfigLoader,
    private options: TTSOptions,
    /** Optional. When the highlight is in a span fill, speak the span's blankTip. */
    private spanFillState?: SpanFillState,
    /** Optional. When the highlight is on a selector/satellite, speak the setting/value tip. */
    private selectorSatelliteState?: SelectorSatelliteState,
  ) {}

  subscribe(): void {
    this._unsub = this.adapter.onRender(ctx => {
      this.maybeSpeak(ctx);
      return null;
    });
  }

  unsubscribe(): void {
    if (this._unsub) { this._unsub(); this._unsub = null; }
  }

  /** Exposed for unit tests. Returns the spoken text (or null if no spawn). */
  maybeSpeak(ctx: RenderContext): string | null {
    if (!this.hlState.active || this.hlState.wordIndex === null) {
      this._lastSpoken = null;
      return null;
    }
    if (!this.adapter.capabilities.includes('spawn-process')) return null;
    // voice-mode: inactive → silence TTS globally (matches v1 Step 16).
    if (this.configLoader.opencuesState.voiceMode === 'inactive') return null;

    const wordIndex = this.hlState.wordIndex;
    const def = this.dynDefs.get(wordIndex);
    const words = splitWords(ctx.text);
    const target = words[wordIndex];

    const clean = (s: string): string => s.replace(/[\u200B\u200C]/g, '');
    const displayed = clean(def?.alternatives[def.currentIndex] ?? target?.word ?? '');
    const original = clean(def?.originalWord ?? displayed);
    if (!displayed) return null;

    // Span/selector-satellite tip wins over per-word cueMap lookup.
    // Without this, highlighting "display mode" speaks "screen
    // brightness" because cueMap has an entry for "display" that's
    // unrelated to the selector context.
    let tip: string | undefined;
    let dedupKey: string;
    const span = this.spanFillState?.current ?? null;
    const ss = this.selectorSatelliteState?.current ?? null;
    const ssSelEnd = ss ? ss.selectorIndex + Math.max(1, ss.selectorLength) - 1 : 0;
    const ssSatEnd = ss ? ss.satelliteIndex + Math.max(1, ss.satelliteLength) - 1 : 0;
    const inSpan = span !== null && wordIndex >= span.index
      && wordIndex < span.index + Math.max(1, span.spanLength);
    const onSelector = ss !== null && wordIndex >= ss.selectorIndex && wordIndex <= ssSelEnd;
    const inSatellite = ss !== null && wordIndex >= ss.satelliteIndex && wordIndex <= ssSatEnd;

    if (onSelector || inSatellite) {
      const ctrl = this.configLoader.controls.get(ss!.controlName);
      if (!ctrl || !(ctrl as { speak?: boolean }).speak) return null;
      const sdef = this.configLoader.opencuesState.definitions.get(ss!.currentSetting);
      tip = onSelector ? sdef?.tip : sdef?.valueTips.get(ss!.currentValue);
      dedupKey = `ss::${ss!.currentSetting}::${onSelector ? '_sel' : ss!.currentValue}`;
    } else if (inSpan) {
      // Span TTS gated on the originating control's `speak`. Without
      // that gate, every multi-word fill would announce its blankTip
      // on each cycle (affirmations, prompt improver, etc.) regardless
      // of the user's voice preference for that control.
      // controlName isn't on SpanFillEntry today; look up by tip match
      // — works for now since blankTip is unique per control.
      // Also suppress when current alt is `_` (dismissed).
      const curAlt = span!.alternatives[span!.currentAltIndex];
      if (curAlt === '_') {
        this._lastSpoken = `span::${span!.index}::dismissed`;
        return null;
      }
      // Find the originating control by blankTip match.
      let speakOK = false;
      for (const ctrl of this.configLoader.controls.values()) {
        const cAny = ctrl as { speak?: boolean; tip?: string; blankTip?: string };
        if ((cAny.blankTip ?? cAny.tip) === span!.blankTip) {
          speakOK = !!cAny.speak;
          break;
        }
      }
      if (!speakOK) return null;
      tip = span!.blankTip;
      dedupKey = `span::${span!.index}::${span!.currentAltIndex}`;
    } else {
      const lookup = this.configLoader.lookup(original);
      if (!lookup || !lookup.speak) {
        this._lastSpoken = `${original}::${displayed}`;
        return null;
      }
      tip = lookup.altCueTips?.[displayed] ?? lookup.cueTip;
      dedupKey = `${original}::${displayed}`;
    }

    if (dedupKey === this._lastSpoken) return null;
    this._lastSpoken = dedupKey;
    if (!tip) return null;

    try {
      this.adapter.spawnProcess({
        command: 'bash',
        args: [this.options.scriptPath, tip, this.options.rate ?? '2'],
        detached: true,
      });
    } catch (err) {
      this.adapter.log('error', 'TTS spawnProcess threw', err);
      return null;
    }
    return tip;
  }
}
