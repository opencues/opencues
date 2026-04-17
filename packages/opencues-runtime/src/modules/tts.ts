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

    const def = this.dynDefs.get(this.hlState.wordIndex);
    const words = splitWords(ctx.text);
    const target = words[this.hlState.wordIndex];

    const clean = (s: string): string => s.replace(/[\u200B\u200C]/g, '');
    const displayed = clean(def?.alternatives[def.currentIndex] ?? target?.word ?? '');
    const original = clean(def?.originalWord ?? displayed);
    if (!displayed) return null;

    // Dedup key includes both so cycling triggers fresh speak per alt.
    const dedupKey = `${original}::${displayed}`;
    if (dedupKey === this._lastSpoken) return null;
    this._lastSpoken = dedupKey;

    const lookup = this.configLoader.lookup(original);
    if (!lookup || !lookup.speak) return null;

    const tip = lookup.altCueTips?.[displayed] ?? lookup.cueTip;
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
