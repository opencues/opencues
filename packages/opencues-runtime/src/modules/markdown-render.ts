// MarkdownRender — emits per-style RenderDirectives for an LLM
// substitution that arrived with markdown. The runtime now strips
// markers before writing to the host buffer (see markdown-substitute.ts),
// so the buffer contains the rendered form ("bold" not "**bold**").
// MarkdownRender's only job is to receive the strip metadata and
// surface it as a RenderDirective so the host can wrap the ranges in
// ANSI escapes (terminals) or per-site rich-write APIs (chrome).
//
// Lifecycle:
//
//   1. A substitution module calls applyMarkdownAwareSubstitution,
//      which strips, writes the stripped form, emits 'markdown.styled'
//      with the per-style ranges in stripped-text coords.
//
//   2. MarkdownRender listens for 'markdown.styled', caches the
//      payload keyed by the stripped text.
//
//   3. On render, if the live text === cached stripped text, emit
//      the per-style ranges as RenderDirectives. Otherwise drop the
//      cache silently (user typed, content drifted, etc.).
//
//   4. User text-change events with source='user' that diverge from
//      the cached text invalidate the cache. Runtime writes (cycling,
//      ZWS toggle) don't invalidate.

import type { HostAdapter, RenderContext, RenderDirectives, Unsubscribe } from '../adapter';
import type { Range } from './markdown-strip';

interface CachedStyles {
  readonly text: string;
  readonly bold: readonly Range[];
  readonly italic: readonly Range[];
  readonly code: readonly Range[];
  readonly strike: readonly Range[];
  readonly heading: readonly Range[];
  readonly list: readonly Range[];
}

/** Body slice of `cached.text` — everything up to the end of the last
 *  styled range. Anything past it is preserved separator/trailing the
 *  user can type over without invalidating the styling. */
function cachedBody(c: CachedStyles): string {
  const ends = [
    ...c.bold, ...c.italic, ...c.code, ...c.strike, ...c.heading, ...c.list,
  ].map(r => r.end);
  if (ends.length === 0) return c.text.replace(/\s+$/, '');
  return c.text.slice(0, Math.max(...ends));
}

export class MarkdownRender {
  private _cached: CachedStyles | null = null;
  private _unsubRender: Unsubscribe | null = null;
  private _unsubEvent: Unsubscribe | null = null;
  private _unsubText: Unsubscribe | null = null;

  constructor(private adapter: HostAdapter) {}

  subscribe(): void {
    this._unsubRender = this.adapter.onRender(ctx => this.compute(ctx));
    if (this.adapter.onEvent) {
      this._unsubEvent = this.adapter.onEvent((type, body) => {
        if (type !== 'markdown.styled') return;
        const p = body as unknown as CachedStyles | undefined;
        if (!p || typeof p.text !== 'string') return;
        this._cached = p;
      });
    }
    this._unsubText = this.adapter.onTextChange(e => {
      if (e.source !== 'user') return;
      // User typing keeps the cache as long as the STYLED BODY (text
      // up to the end of the last styled range) is intact at the
      // start of the buffer. Trailing whitespace / separators in
      // cached.text aren't load-bearing — the user often types over
      // them. Only invalidate when the styled body itself is mutated.
      if (this._cached !== null && !e.text.startsWith(cachedBody(this._cached))) {
        this._cached = null;
      }
    });
  }

  /** Exposes the last-cached styled payload (null when nothing cached
   *  or the cache was invalidated by user typing). Used by the
   *  resolver to re-inject markdown markers into rich-text input so
   *  EXTRACT/APPLY can preserve existing styling across transforms
   *  ("text is bold, now also make it caps"). */
  getCachedPayload(): CachedStyles | null { return this._cached; }

  unsubscribe(): void {
    if (this._unsubRender) { this._unsubRender(); this._unsubRender = null; }
    if (this._unsubEvent) { this._unsubEvent(); this._unsubEvent = null; }
    if (this._unsubText) { this._unsubText(); this._unsubText = null; }
  }

  /** Pure: takes a render context, returns directives or null. */
  compute(ctx: RenderContext): RenderDirectives | null {
    if (this._cached === null) return null;
    // Accept any text whose first chars match the cached styled BODY
    // (the prefix up to the end of the last styled range). Trailing
    // whitespace / separators in cached.text aren't load-bearing —
    // the user often types over them. Only drop when the styled body
    // itself is mutated.
    if (!ctx.text.startsWith(cachedBody(this._cached))) {
      this._cached = null;
      return null;
    }
    return {
      boldRanges: this._cached.bold,
      italicRanges: this._cached.italic,
      codeRanges: this._cached.code,
      strikeRanges: this._cached.strike,
      headingRanges: this._cached.heading,
      listRanges: this._cached.list,
    };
  }

  /** Test helper — inject a cache entry directly without going through
   *  the event bridge. */
  _setCacheForTesting(c: CachedStyles | null): void {
    this._cached = c;
  }
}
