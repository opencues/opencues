// MarkdownRender — overlays bold / italic / code / strike / heading /
// list styling onto buffer text written by an LLM. Display-only:
// the syntax markers (`**`, `*`, `` ` ``, etc.) stay in the buffer; the
// renderer just emits ANSI escapes (terminals) or per-site styling
// (chrome, Phase 2) at the marker boundaries.
//
// Triggering policy: parses only when an LLM-origin substitution lands.
// User keystrokes invalidate the cache so we don't waste cycles re-
// parsing on every text-change. Re-fires on the next substitution.
//
// Blank-slot suppression: when a `_` blank slot lives in the buffer
// (BlankFill recorded it), italic / code / strike ranges that overlap
// the slot are dropped. Bold (`**`) is two-character so its syntax
// never collides with a single `_`; passes through unfiltered.

import type { HostAdapter, RenderContext, RenderDirectives, Unsubscribe } from '../adapter';
import { parseMarkdown, type ParsedMarkdown, type Range } from './markdown-parse';
import type { BlankFill } from './blank-fill';

/** Events that trigger a markdown re-parse. Listed once so the
 *  subscription + module docs stay in lock-step. */
const TRIGGER_EVENTS: ReadonlyArray<string> = [
  'blank.substituted',
  'transform-blank.completed',
  'agent-rewrite.round-completed',
];

export class MarkdownRender {
  /** Last parsed result + the text it was parsed for. When the live
   *  text diverges from `_lastText`, the cache is stale and we either
   *  re-parse (if cause = LLM substitution) or clear (if cause = user
   *  typing). */
  private _lastText: string | null = null;
  private _ranges: ParsedMarkdown | null = null;
  private _unsubRender: Unsubscribe | null = null;
  private _unsubEvent: Unsubscribe | null = null;
  private _unsubText: Unsubscribe | null = null;

  constructor(
    private adapter: HostAdapter,
    /** Optional — used to derive blank-slot suppression ranges so
     *  `_` glyphs in the buffer don't get italicised. When absent,
     *  suppression is empty. */
    private blankFill?: BlankFill,
  ) {}

  subscribe(): void {
    this._unsubRender = this.adapter.onRender(ctx => this.compute(ctx));
    if (this.adapter.onEvent) {
      this._unsubEvent = this.adapter.onEvent((type: string) => {
        if (TRIGGER_EVENTS.includes(type)) {
          // Re-parse against the FRESH adapter text — the substitution
          // path called setText before emitting; reading now gets the
          // post-substitution buffer.
          this._reparse();
        }
      });
    }
    this._unsubText = this.adapter.onTextChange(e => {
      // User typing invalidates the cache — re-runs only on the next
      // LLM substitution event. Runtime writes (the substitution path
      // itself) reach us as source='runtime' and don't invalidate.
      if (e.source === 'user' && this._lastText !== null && e.text !== this._lastText) {
        this._ranges = null;
        this._lastText = null;
      }
    });
  }

  unsubscribe(): void {
    if (this._unsubRender) { this._unsubRender(); this._unsubRender = null; }
    if (this._unsubEvent) { this._unsubEvent(); this._unsubEvent = null; }
    if (this._unsubText) { this._unsubText(); this._unsubText = null; }
  }

  /** Force a re-parse against the host's current text. Exposed for
   *  tests; subscribe()'d event handlers call it on substitution. */
  forceReparse(): void { this._reparse(); }

  /**
   * Pure: takes a render context, returns directives or null. Exposed
   * for unit testing without the subscribe pipeline.
   *
   * Returns null when no markdown is cached (haven't seen an LLM
   * substitution yet, or user invalidated it). Returns directives
   * with markdown ranges populated when a parse is in cache and the
   * live text still matches.
   */
  compute(ctx: RenderContext): RenderDirectives | null {
    if (this._ranges === null) return null;
    // Cache validity — if the live text drifted from what we parsed,
    // drop the cache silently. The next substitution event will
    // re-parse against the fresh text.
    if (this._lastText !== null && ctx.text !== this._lastText) {
      this._ranges = null;
      this._lastText = null;
      return null;
    }
    return {
      boldRanges: this._ranges.bold,
      italicRanges: this._ranges.italic,
      codeRanges: this._ranges.code,
      strikeRanges: this._ranges.strike,
      headingRanges: this._ranges.heading,
      listRanges: this._ranges.list,
    };
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private _reparse(): void {
    const text = this.adapter.getText();
    this._lastText = text;
    this._ranges = parseMarkdown(text, { suppressRanges: this._blankSuppressRanges(text) });
  }

  /** Compute char-range coverage for every `_` blank slot in the buffer
   *  so italic / code / strike spans that overlap a slot are filtered
   *  out. Reads from BlankFill's `slots` getter when available. */
  private _blankSuppressRanges(text: string): readonly Range[] {
    if (!this.blankFill) return [];
    const slots = this.blankFill.slots;
    if (slots.length === 0) return [];
    // BlankFill's BlankSlot uses word indices. Convert to char ranges
    // by walking the buffer.
    const ranges: Range[] = [];
    const cleaned = text.replace(/[\u200B\u200C]/g, '');
    const wordRe = /\S+/g;
    let m: RegExpExecArray | null;
    let idx = 0;
    const targetIdxs = new Set(slots.map(s => s.index));
    while ((m = wordRe.exec(cleaned)) !== null) {
      if (targetIdxs.has(idx)) {
        ranges.push({ start: m.index, end: m.index + m[0].length });
      }
      idx++;
    }
    return ranges;
  }
}
