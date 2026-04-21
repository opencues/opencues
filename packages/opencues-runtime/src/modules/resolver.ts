// Resolver — debounced LLM-backed cycle population.
//
// Subscribes onTextChange (user-source only). After a quiet period
// (debounceMs, default 500), builds a CueContext from the current text
// and calls opencues-core's resolver with merged sources from cuesConfig +
// blanksConfig. Resolved results populate DynDefs so Cycling can rotate
// LLM-suggested alternatives on Ctrl+Alt+Up/Down.
//
// In-flight cancellation: a generation counter is bumped on every
// scheduleResolve. Resolved batches whose generation no longer matches
// the latest are dropped — prevents stale alts overwriting newer state.
//
// User mid-cycle protection: if a DynDef entry has currentIndex > 0
// (user has cycled past the original), the resolver leaves it alone.

import type { HostAdapter, TextChangeEvent, Unsubscribe } from '../adapter';
import type { ConfigLoader } from './config-loader';
import type { DynDefs, WordDef } from '../state/dyn-defs';
import type { HighlightState } from '../state/highlight-state';
import type { SpanFillState } from '../state/span-fill';
import { splitWords } from './navigation';

export interface ResolverOptions {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly defaultModel: string;
  /** Default 500ms — same as v1's auto-submit debounce. */
  readonly debounceMs?: number;
  /** Optional injection seam for tests. When set, runtime uses this instead
   *  of constructing a NodeHttpAdapter. Should expose at least .post(). */
  readonly httpAdapter?: unknown;
  /** Same — inject the resolver build directly (mostly for testing). */
  readonly resolverFactory?: (cuesConfig: unknown, blanksConfig: unknown, opts: unknown) => unknown;
}

interface CuesCoreLike {
  buildSourcesFromConfig(c: unknown, b: unknown, o: unknown): unknown[];
  createResolver(sources: unknown[], opts: unknown): { resolve(ctx: unknown): Promise<{ results: CueResultLike[] }> };
}

interface CueResultLike {
  wordIndex: number;
  word: string;
  alternatives: string[];
  cueTip?: string;
  altCueTips?: Record<string, string>;
}

export class Resolver {
  private _resolver: { resolve(ctx: unknown): Promise<{ results: CueResultLike[] }> } | null = null;
  private _httpAdapter: unknown = null;
  private _unsubText: Unsubscribe | null = null;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _generation = 0;

  constructor(
    private adapter: HostAdapter,
    private hlState: HighlightState,
    private dynDefs: DynDefs,
    private configLoader: ConfigLoader,
    private options: ResolverOptions,
    private spanFillState?: SpanFillState,
  ) {}

  subscribe(): void {
    this.rebuildResolver();
    this._unsubText = this.adapter.onTextChange(e => this.onTextChange(e));
  }

  unsubscribe(): void {
    if (this._unsubText) { this._unsubText(); this._unsubText = null; }
    if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }
  }

  /** Rebuild sources + resolver from current configLoader state. Call after
   *  configLoader.load() resolves and on hot-reload. */
  rebuildResolver(): void {
    // Use merged configs (cwd .md + folder cues/* + folder blanks/*) so the
    // resolver sees prompt sources from both layers in one CueResolver.
    const cuesConfig = this.configLoader.mergedCuesConfig ?? this.configLoader.cuesConfig;
    const blanksConfig = this.configLoader.mergedBlanksConfig ?? this.configLoader.blanksConfig;
    if (!cuesConfig && !blanksConfig) {
      this.adapter.log('info', 'Resolver: no cuesConfig/blanksConfig, skipping build');
      return;
    }

    if (!this._httpAdapter) {
      if (this.options.httpAdapter !== undefined) {
        this._httpAdapter = this.options.httpAdapter;
      } else {
        try {
          // Lazy require so tests without opencues-core/node-http-adapter still load.
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { NodeHttpAdapter } = require('@opencues/core/node-http-adapter');
          this._httpAdapter = new NodeHttpAdapter({ maxSockets: 2, timeout: 30000 });
        } catch (err) {
          this.adapter.log('error', 'Resolver: NodeHttpAdapter load failed', err);
          return;
        }
      }
    }

    let cuesCore: CuesCoreLike;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      cuesCore = require('@opencues/core');
    } catch (err) {
      this.adapter.log('error', 'Resolver: opencues-core load failed', err);
      return;
    }

    // Endpoint + model precedence: opencues.md `llm-endpoint:` /
    // `llm-model:` > host-supplied default. Lets users switch providers
    // without re-applying the patch.
    const settings = this.configLoader.opencuesState.settings;
    const buildOpts = {
      httpAdapter: this._httpAdapter,
      endpoint: settings.get('llm-endpoint') ?? this.options.endpoint,
      apiKey: this.options.apiKey,
      defaultModel: settings.get('llm-model') ?? this.options.defaultModel,
      controls: this.configLoader.folderConfigs?.controlOverrides ?? {},
    };
    let sources: unknown[];
    try {
      sources = (this.options.resolverFactory ?? cuesCore.buildSourcesFromConfig)(
        cuesConfig, blanksConfig, buildOpts,
      ) as unknown[];
    } catch (err) {
      this.adapter.log('error', 'Resolver: buildSourcesFromConfig failed', err);
      return;
    }

    this._resolver = cuesCore.createResolver(sources, {
      parallel: false,
      timeout: 30000,
      continueOnError: true,
    });
    this.adapter.log('info', `Resolver: built with ${sources.length} sources`);
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private onTextChange(e: TextChangeEvent): void {
    if (e.source !== 'user') return; // ignore our own setText echoes
    if (!this._resolver) return;
    this.scheduleResolve(e.text);
  }

  private scheduleResolve(text: string): void {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    const delay = this.options.debounceMs ?? 500;
    this._debounceTimer = setTimeout(() => {
      void this.resolveAndApply(text);
    }, delay);
  }

  /** Exposed for tests. */
  async resolveAndApply(text: string): Promise<void> {
    if (!this._resolver) return;
    const generation = ++this._generation;

    const wordSpans = splitWords(text);
    // Skip words we've already resolved. Empty strings get filtered out
    // by RoutedWordSourceGroup + every other CueSource — no LLM call.
    // Rules:
    //   - Blanks (`_`) always re-resolve — their context determines the
    //     answer and may have changed.
    //   - Words inside an active span-fill (static-alt or blank-fill)
    //     are owned by cycling; re-querying would waste tokens and risk
    //     clobbering the cached alts.
    //   - A DynDef with matching originalWord means alts are already
    //     cached for this position. Re-querying produces alts the cache
    //     throws away (see line 197 below), so skipping the call is pure
    //     win.
    const span = this.spanFillState?.current;
    const cleanWords = wordSpans.map((w, i) => {
      const cleaned = w.word.replace(/[\u200B\u200C]/g, '');
      if (cleaned === '_') return cleaned;
      if (span && i >= span.index && i < span.index + span.spanLength) return '';
      const existing = this.dynDefs.get(i);
      if (existing && existing.originalWord === cleaned && existing.alternatives.length > 1) {
        return '';
      }
      return cleaned;
    });

    let result;
    try {
      result = await this._resolver.resolve({
        text,
        words: cleanWords,
        domain: 'claude-code',
      });
    } catch (err) {
      this.adapter.log('error', 'Resolver.resolve threw', err);
      return;
    }

    // Stale check — a newer scheduleResolve might have run in between.
    if (generation !== this._generation) return;

    let wrote = 0;
    for (const r of result.results) {
      const target = wordSpans[r.wordIndex];
      if (!target) continue;
      const existing = this.dynDefs.get(r.wordIndex);
      // Don't clobber a user mid-cycle on this word.
      if (existing && existing.currentIndex > 0) continue;
      // Don't clobber control-attributed entries (volume/brightness blank
      // fills, satellite cycles, etc.) — those route through their own
      // cycling path and have a script set/get protocol the LLM alts
      // would silently break.
      if (existing && existing.controlName) continue;
      // Already resolved — same word at the same index, fresh from a
      // prior LLM pass. Without this, every subsequent text-change
      // (typing the next word, adding a space) clobbers the existing
      // DynDef with a new LLM result. Alts can differ slightly across
      // runs, and each write triggers a forceRender → repaint flash.
      // Only re-resolve if the word at this index actually changed
      // (user deleted/replaced the word).
      if (existing && existing.originalWord === target.word) continue;
      // Tip-having words own their own alternatives via the cueMap
      // (claude-code-tips.json's hand-curated `alts` array). The LLM
      // returning grammar synonyms for `ultrathink` etc. would silently
      // override the curated list. Mirrors the legacy CC cue-engine's
      // `skipFn: word => tipsMap.has(word)` filter on the LLM source.
      const cueMapEntry = this.configLoader.lookup(target.word);
      if (cueMapEntry && cueMapEntry.alternatives && cueMapEntry.alternatives.length > 1) continue;
      const alts = (r.alternatives ?? []).filter(a => a && a !== target.word);
      if (alts.length === 0) continue;
      const def: WordDef = {
        originalWord: target.word,
        alternatives: [target.word, ...alts],
        currentIndex: 0,
        spanStart: target.start,
        spanEnd: target.end,
      };
      this.dynDefs.set(r.wordIndex, def);
      wrote++;
    }
    // Force a paint so DimRender/Statusline pick up the new alts without
    // waiting for the user's next keystroke. Hosts with no idle render
    // loop (e.g. OpenCode's onContentChange-only path) need this.
    if (wrote > 0) this.adapter.forceRender();
  }
}
