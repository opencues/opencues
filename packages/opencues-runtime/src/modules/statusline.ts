// Statusline — exports a JSON snapshot of the runtime state on every render
// for an external consumer (e.g. integrations/claude-code/patches/highlight-statusline.sh).
//
// The shape mirrors what v1's wordHighlight.ts wrote to
// /tmp/claude-highlight-state-<pid>.json so the existing shell consumer
// keeps working unchanged. Phase 4 covers the navigation+cycling subset of
// fields; LLM/blank/control fields land as their modules ship.
//
// Writes are deduped by content — only fires when the JSON actually changes,
// so a busy render loop doesn't spam the disk.

import type { HostAdapter, RenderContext, Unsubscribe } from '../adapter';
import type { HighlightState } from '../state/highlight-state';
import type { DynDefs } from '../state/dyn-defs';
import type { ConfigLoader } from './config-loader';
import { splitWords } from './navigation';

export interface StatuslineOptions {
  /** Absolute path. Typically /tmp/claude-highlight-state-<pid>.json. */
  readonly exportPath: string;
  /**
   * Optional. Called after each successful export write — host-specific
   * trigger to make the host re-read/redisplay the export immediately
   * (e.g. on Claude Code, this calls the captured statusline-refresh
   * useCallback). When absent, the host must poll on its own schedule.
   */
  readonly refreshHook?: () => void;
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
  cueControl?: boolean;
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

    // Cue lookup: primary key is the original word (stable across cycling).
    // For tip display, prefer altCueTips[currentDisplayedWord] over the
    // primary cueTip — mirrors v1's behaviour where each alt can have its
    // own tip text.
    const lookupKey = clean(def?.originalWord ?? highlightedWord);
    const lookup = this.configLoader?.lookup(lookupKey) ?? null;
    let cueTip: string | null = null;
    let altCueTips: Record<string, string> | null = null;
    if (lookup) {
      altCueTips = lookup.altCueTips ?? null;
      cueTip = lookup.altCueTips?.[cleanHighlighted] ?? lookup.cueTip ?? null;
    }

    return {
      active: true,
      highlightedWordIndex: wordIndex,
      highlightedWord: cleanHighlighted,
      currentAltIndex: def?.currentIndex ?? 0,
      alts: def ? def.alternatives.map(clean) : [cleanHighlighted],
      cueTip,
      altCueTips,
      cueControl: false,    // future: from controls.md
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
