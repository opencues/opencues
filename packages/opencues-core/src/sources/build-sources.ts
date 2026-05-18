/**
 * opencues-core/sources/build-sources.ts
 *
 * Factory that creates CueSource[] from parsed .md configs.
 * Single entry point — replaces manual source construction in integrations.
 *
 * ## How sources are assembled
 *
 * **Word cues (per-word routing)**: Domain prompts (legal, medical, …) live
 * as `### alternatives` sections in `CUES.md` (or folder-based
 * `cues/<name>/CUE.md`). They get wrapped in ONE RoutedWordSourceGroup that
 * dispatches each highlighted word to one source via match/keywords.
 *
 * **Blanks (`_`-gated)**: Two paths:
 *   - Keyword-bound blanks (`blankKeywords:` in a folder CUE.md / BLANK.md) flow through
 *     BlankSource — fast, deterministic, no LLM needed.
 *   - Free-form lookups go through FluidBlankSource (P1 SEGMENT + P3 ANSWER
 *     LLM pipeline). It cedes when a keyword-bound blank would claim the slot.
 */

import { CueSource, HttpAdapter } from '../types';
import { CuesMdConfig, SourceConfig, BlankConfig } from '../cues-md';
import { ConfigSource } from './config-source';
import { RoutedWordSourceGroup } from './routed-word-source-group';
import { BlankSource, isBlankConfigCycleable } from './blank-source';
import { FluidBlankSource, type FluidBlankSourceConfig } from './fluid-blank-source';
import { TransformBlankSource, type TransformBlankSourceConfig } from './transform-blank-source';
import { ConfigIntentSource, type ConfigIntentSourceConfig } from './config-intent-source';
import { SentenceCueSource, type SentenceCueSourceConfig } from './sentence-cue-source';
import { resolveLLM, getProvider, withFallback, type ResolvedLLM } from '../llm-provider';

/**
 * Per-feature provider/model/endpoint trio. Each LLM-driven source
 * (word cues, fluid blank, transform blank, agent) reads its own
 * settings from OPENCUES.md root frontmatter; the caller flattens
 * those into this struct before calling buildSourcesFromConfig.
 *
 * Example mapping in the boot layer (OPENCUES.md frontmatter → here):
 *   word-cues-provider:    → wordCues.provider
 *   word-cues-model:       → wordCues.model
 *   word-cues-endpoint:    → wordCues.endpoint
 *   …same for fluid-blank and transform-blank.
 *
 * Spelling is NOT here — it's a regular config-driven cue (see
 * `defaults/cues/spelling.md`) and inherits per-cue / per-feature
 * (`word-cues-*`) / global routing through the standard ConfigSource
 * path. The dedicated `SpellingSource` class was retired in May 2026
 * because it duplicated ConfigSource behavior with a hardcoded prompt.
 */
export interface FeatureLLMSetting {
  readonly provider?: string;
  readonly model?: string;
  readonly endpoint?: string;
}

export interface BuildSourcesOptions {
  httpAdapter: HttpAdapter;
  /**
   * API keys keyed by env-var name (GROQ_API_KEY, OPENROUTER_API_KEY,
   * GEMINI_API_KEY, OPENAI_API_KEY). Boot populates from process.env;
   * the runtime picks the right one based on the resolved provider.
   */
  apiKeys?: Readonly<Record<string, string | undefined>>;
  /**
   * Global llm-provider/model/endpoint defaults from OPENCUES.md
   * root frontmatter. The least-specific tier — overridden by
   * per-feature and per-cue settings.
   */
  globalProvider?: string;
  globalModel?: string;
  globalEndpoint?: string;
  /** Per-feature defaults read from OPENCUES.md root frontmatter. */
  wordCues?: FeatureLLMSetting;
  fluidBlank?: FeatureLLMSetting;
  transformBlank?: FeatureLLMSetting;
  configIntent?: FeatureLLMSetting;
  sentenceCues?: FeatureLLMSetting;
  /**
   * Pipeline mode for TransformBlank. `'auto'` (default) picks per
   * provider — groq → 3-pass, everyone else → fused — via
   * `pickTransformBlankMode`. `'3-pass'` and `'fused'` force the mode
   * regardless of provider. Read from OPENCUES.md's `transform-blank-mode:`
   * frontmatter scalar by the runtime/resolver before passing here.
   * See `transform-blank-source.ts` for the dispatch logic.
   */
  transformBlankMode?: string;
  /** Merged blank configs */
  blanks?: Record<string, BlankConfig>;
  /** I/O adapter: calls blankScript get to read current live blank value (raw string).
   * May return synchronously or as a Promise — async implementations avoid blocking the event loop. */
  readBlankState?: (blankName: string, matchedKeyword?: string, contextWords?: string[]) => string | null | Promise<string | null>;
  /**
   * Enable the fluid-blank source — a single-call FUSED handler that
   * segments + answers free-form lookup queries embedded in casual prose.
   * See fluid-blank-source.ts and tests/benchmarks/fluid-blank/BUILD-LOG.md.
   * Defaults to false; flip on per-integration.
   */
  enableFluidBlank?: boolean;
  /**
   * Enable the transform-blank source — a 3-pass (EXTRACT + APPLY + VERIFY)
   * handler for IMPERATIVE instructions placed next to `_`. Where
   * fluid-blank handles "capital of france _", transform-blank handles
   * "change boy to girl _ the boy ran fast". Priority 93 — sits ABOVE
   * fluid-blank (92) and only claims when the surrounding text starts
   * with an imperative verb. See transform-blank-source.ts and
   * tests/benchmarks/transform-blank/.
   * Defaults to false; flip on per-integration.
   */
  enableTransformBlank?: boolean;
  /**
   * Enable the config-intent source — a single-call LLM classifier
   * that routes `_` to an OPENCUES.md settings change ("stop showing
   * tips _" → tips-mode=off) when no keyword matched. Priority 94 —
   * sits ABOVE transform-blank (93) so settings phrasings beat
   * imperative-rewrite interpretation. Settings-only (never user
   * blanks) — see config-intent-source.ts for the trust-boundary rationale.
   * Defaults to false; flip on via OPENCUES.md `fluid-config-mode: on`.
   */
  enableConfigIntent?: boolean;
  /**
   * Side-effect callback invoked by ConfigIntentSource to write the
   * inferred (setting, value) into OPENCUES.md. Runtime wires
   * `ConfigLoader.applyOpenCuesScalar` here — it writes the file AND
   * updates in-memory state with the write-race suppression guard.
   * Required when `enableConfigIntent: true`; omitting it skips the
   * source instantiation.
   */
  applyOpencuesScalar?: (setting: string, value: string) => void | Promise<void>;
  /**
   * Enable sentence-scope cues. When false, every CUES.md / CUE.md
   * entry with `scope: sentence` is silently filtered at build time —
   * no LLM calls fire and no cues surface. Defaults to false; flip on
   * via OPENCUES.md `sentence-cues-mode: on`. Mirrors `enableWordCues`
   * shape — global kill-switch on top of per-cue declaration.
   */
  enableSentenceCues?: boolean;
  /** Enable RoutedWordSourceGroup (word-cues on plain text). When false,
   * NO word-cue LLM calls fire — words are not navigable as alternatives.
   * Domain blanks/fluid-blank still work. Defaults to false;
   * flip on via OPENCUES.md `word-cues-mode: on`. */
  enableWordCues?: boolean;
  /**
   * Source ids subtracted from this layer's composition. Mirrors
   * AUDITORS.md `disable:` for cues and blanks: a name listed here is
   * skipped at source-construction time, so editing CUES.md /
   * BLANKS.md `disable: [...]` flips a source on/off without touching
   * the source folders themselves. Project-level lists are merged
   * upstream by ConfigLoader (UNION across layers).
   */
  disableCues?: ReadonlyArray<string>;
  disableBlanks?: ReadonlyArray<string>;
  /**
   * Optional debug-log sink. Currently consumed by TransformBlankSource
   * to emit per-pipeline-stage traces (P1 EXTRACT verdict, P2 APPLY
   * step results, P3 VERIFY decision). Wire to the host's debug log
   * (e.g. `(msg) => adapter.log('debug', msg)`) so `debug-mode: on` in
   * OPENCUES.md surfaces the trace. Silent when omitted.
   */
  log?: (msg: string) => void;
  /**
   * Optional info-level log sink. Used by FluidBlankSource for lines
   * that should land in chrome's default DevTools console (which
   * hides debug behind the Verbose filter) — once-per-substitution
   * security-relevant logs like the ambient-context injection
   * decision. Wire to `(msg) => adapter.log('info', msg)`. Falls
   * back to `log` if omitted.
   */
  logInfo?: (msg: string) => void;
  // ─── Per-source event subscribers ─────────────────────────────────────
  //
  // Uniform pattern: each instrumented source defines its own
  // `<Name>Event` typed tagged union (started / pass-completed /
  // completed / bailed) and exposes a `config.onEvent` callback in
  // its config interface. `BuildSourcesOptions` exposes one
  // `on<Name>Event` per source — each typed against the source's
  // own event union. Sources without meaningful pipeline phases
  // (LocalCueSource, BlankSource) stay uninstrumented; add a
  // typed callback here when their lifecycle becomes worth observing.
  //
  // Runtime consumers namespace these events when adapting to their
  // own event-stream format — core owns the names + body shapes;
  // consumers adapt.
  /** Subscriber for `TransformBlankSource` (3-pass pipeline). */
  onTransformBlankEvent?: TransformBlankSourceConfig['onEvent'];
  /** Subscriber for `FluidBlankSource` (2-pass pipeline). */
  onFluidBlankEvent?: FluidBlankSourceConfig['onEvent'];
  /** Subscriber for `ConfigIntentSource` (single-call settings classifier). */
  onConfigIntentEvent?: ConfigIntentSourceConfig['onEvent'];
  /** Subscriber for `SentenceCueSource` (one batch call per cue per buffer). */
  onSentenceCueEvent?: SentenceCueSourceConfig['onEvent'];
  /**
   * Whether the host advertises a CYCLING SURFACE — i.e. it can
   * intercept Ctrl+Alt+arrow keys AND render visual feedback for
   * the user to pick between alternatives. Terminal hosts and
   * chrome's contenteditable branch advertise true; chrome's normal
   * `<input>` / `<textarea>` branch advertises false (no overlay,
   * no key dispatch — "Universal Integration" profile).
   *
   * When false: every CueSource whose `isCycleable` is true is
   * pruned at construction time, and cycleable individual BlankConfig
   * entries are pruned from the blanks map BEFORE BlankSource sees
   * them. Word-cues, selector/satellite blanks, list blanks,
   * script-backed cycling blanks (volume, brightness) — all dropped.
   *
   * FluidBlankSource and TransformBlankSource (single-answer) plus
   * compute blanks (weather/stocks/answer/etc.) survive.
   *
   * Defaults to `true` for back-compat — every existing host that
   * has cycling continues to register everything.
   */
  supportsCycling?: boolean;
}

/**
 * @deprecated Removed in favour of RoutedWordSourceGroup (per-word
 * routing instead of "combine all into one prompt"). The combine model
 * had two structural problems: (1) cross-contamination — a sloppy or
 * hijacking prompt poisoned all other sources; (2) it scaled poorly
 * past 5+ sources as the combined prompt grew and confused the LLM.
 *
 * Kept as a no-op export only so external callers don't fail to
 * import. New code should not use it.
 */
export function combineWordSources(srcs: SourceConfig[]): SourceConfig {
  // Trivial degenerate behaviour for any holdout caller — concat the
  // prompts, append the format spec, and return. Same shape the old
  // function emitted but no longer used by buildSourcesFromConfig.
  const parts = srcs.map(s => s.promptText ?? '');
  parts.push('\nOutput ONLY index:alternatives format (e.g. 1:alt1,alt2,alt3).');
  return {
    name: 'grammar',
    scope: 'words',
    parser: 'alternatives',
    priority: Math.max(...srcs.map(s => s.priority ?? 50)),
    promptText: parts.join('\n'),
  };
}

/**
 * Build CueSource[] from parsed CUES.md and BLANKS.md configs.
 *
 * - CUES.md word-scoped alternatives ### sections → one ConfigSource
 *   each, all wrapped in ONE RoutedWordSourceGroup. The group routes
 *   each highlighted word to one child source via match/keywords/
 *   priority and dispatches one LLM call per source group (parallel).
 *   See routed-word-source-group.ts for the full rules.
 * - CUES.md other ### sections (non-default scope/parser) → individual
 *   ConfigSource instances (not routed; called directly by the resolver).
 * - blanks: keyword-bound entries → BlankSource. Free-form `_` →
 *   FluidBlankSource (opt-in via `fluid-blank-mode: on`).
 */
export function buildSourcesFromConfig(
  cuesConfig: CuesMdConfig | undefined,
  _blanksConfig: CuesMdConfig | undefined,
  options: BuildSourcesOptions,
): CueSource[] {
  const sources: CueSource[] = [];

  const apiKeys = options.apiKeys ?? {};
  const globalProvider = options.globalProvider;
  const globalModel = options.globalModel;
  // Universal-Integration profile: when the host can't cycle (chrome's
  // normal `<input>` / `<textarea>` branch), drop everything that
  // presents alternatives the user picks between. Default true keeps
  // every existing host running unchanged.
  const supportsCycling = options.supportsCycling !== false;
  // globalEndpoint reserved for future per-call resolution; resolveLLM
  // currently sources endpoint from the resolved provider's default.

  /**
   * Resolve the provider/model/endpoint/key tuple for one source given
   * its per-source override (frontmatter) and a per-feature default.
   * Returns null when no api key is available — caller skips the source.
   */
  function resolveFor(featureSetting: FeatureLLMSetting | undefined, perSource?: SourceConfig): ResolvedLLM | null {
    return resolveLLM({
      providerOverride: perSource?.provider,
      modelOverride: perSource?.model,
      endpointOverride: perSource?.endpoint,
      featureProvider: featureSetting?.provider,
      featureModel: featureSetting?.model,
      globalProvider,
      globalModel,
      apiKeys,
    });
  }

  function fallbackForLog(label: string, providerName: string): void {
    const p = getProvider(providerName);
    options.log?.(`buildSources: skipping ${label} — no API key for provider '${providerName}' (env ${p?.envKeyName ?? '?'} unset)`);
  }


  // From CUES.md: collect all word-scope alternatives sources into one
  // RoutedWordSourceGroup. Other sources (different scope/parser) stay
  // individual ConfigSource instances.
  // Gate the entire word-cue block on enableWordCues. Non-word-cue
  // sources (different scope/parser) still pass through — they're not
  // the per-word surface, so they obey their own enable flag in CUE.md / BLANK.md
  // frontmatter as before.
  const cueDisableSet = new Set(options.disableCues ?? []);
  const blankDisableSet = new Set(options.disableBlanks ?? []);

  if (cuesConfig?.promptConfig?.sources) {
    const wordCueSources: ConfigSource[] = [];

    for (const [, srcCfg] of Object.entries(cuesConfig.promptConfig.sources)) {
      if (srcCfg.enabled === false || !srcCfg.promptText) continue;
      if (cueDisableSet.has(srcCfg.name)) continue;
      const scope = srcCfg.scope ?? 'words';
      const parser = srcCfg.parser ?? 'alternatives';

      // Sentence-scope cues — one SentenceCueSource per CUE.md entry.
      // Gated independently from word-cues (sentence-cues-mode scalar
      // in OPENCUES.md). The source segments the buffer, batches one
      // LLM call per cue per resolve, and emits one CueResult per
      // sentence (alternatives = [original, ...rewrites], char-range
      // spanStart/spanEnd). Priority defaults to 85 — higher than
      // word-cues so an overlapping word-cue gets suppressed in the
      // resolver (design decision: sentence wins outright).
      if (scope === 'sentence') {
        if (!options.enableSentenceCues) continue;
        if (!supportsCycling) {
          options.log?.(`buildSources: skipping sentence-cue '${srcCfg.name}' — host has no cycling surface`);
          continue;
        }
        if (!srcCfg.promptText) continue;
        const resolved = resolveFor(options.sentenceCues, srcCfg);
        if (!resolved) {
          fallbackForLog(`sentence-cue '${srcCfg.name}'`, srcCfg.provider || options.sentenceCues?.provider || globalProvider || 'groq');
          continue;
        }
        sources.push(new SentenceCueSource({
          httpAdapter: withFallback(options.httpAdapter, resolved.fallback),
          provider: resolved.provider,
          endpoint: resolved.endpoint,
          apiKey: resolved.apiKey,
          model: resolved.model,
          sourceConfig: srcCfg,
          log: options.log,
          onEvent: options.onSentenceCueEvent,
        }));
        continue;
      }
      if (scope === 'words' && parser === 'alternatives') {
        if (!options.enableWordCues) continue;
        // Universal-Integration filter: word-cues are cycleable by
        // definition (they surface alternatives). Skip when host has
        // no cycling surface so we don't burn LLM tokens producing
        // output that can't be presented to the user.
        if (!supportsCycling) {
          options.log?.(`buildSources: skipping word-cue '${srcCfg.name}' — host has no cycling surface`);
          continue;
        }
        // Every word-cue source must declare what it cares about via
        // match: or keywords:. Catch-all "default" sources were removed —
        // an explicit `match: .*` is required if the user really wants
        // a fall-through cue.
        if (!srcCfg.match && !srcCfg.keywords) continue;
        const resolved = resolveFor(options.wordCues, srcCfg);
        if (!resolved) {
          fallbackForLog(`word-cue '${srcCfg.name}'`, srcCfg.provider || options.wordCues?.provider || globalProvider || 'groq');
          continue;
        }
        wordCueSources.push(new ConfigSource({
          sourceConfig: { ...srcCfg, scope },
          // Wrap the http adapter with auto-fallback so transient errors
          // (429 / 5xx / network) on the resolved provider re-issue
          // against the wire-compatible peer (groq ↔ cerebras when both
          // keys are configured). No-op for providers without a peer.
          httpAdapter: withFallback(options.httpAdapter, resolved.fallback),
          provider: resolved.provider,
          endpoint: resolved.endpoint,
          apiKey: resolved.apiKey,
          model: resolved.model,
        }));
      } else {
        // Non-routable sources (different scope or parser) stay direct.
        const resolved = resolveFor(options.wordCues, srcCfg);
        if (!resolved) {
          fallbackForLog(`source '${srcCfg.name}'`, srcCfg.provider || options.wordCues?.provider || globalProvider || 'groq');
          continue;
        }
        sources.push(new ConfigSource({
          sourceConfig: { ...srcCfg, scope },
          httpAdapter: withFallback(options.httpAdapter, resolved.fallback),
          provider: resolved.provider,
          endpoint: resolved.endpoint,
          apiKey: resolved.apiKey,
          model: resolved.model,
        }));
      }
    }

    if (wordCueSources.length > 0) {
      sources.push(new RoutedWordSourceGroup({ sources: wordCueSources }));
    }
  }

  // Keyword-bound blanks: blanks with blankKeywords get a BlankSource.
  // Names in disableBlanks are skipped at this layer (BLANKS.md disable:).
  if (options.blanks && options.readBlankState) {
    const keywordBlanks: Record<string, BlankConfig> = {};
    for (const [name, blk] of Object.entries(options.blanks)) {
      if (blankDisableSet.has(name)) continue;
      if (!blk.blankKeywords?.length) continue;
      // Universal-Integration filter: skip cycleable blank defs (volume,
      // brightness, opencues-settings, list blanks with stepValues) when
      // host has no cycling surface. Single-shot compute blanks (weather,
      // stocks, dictionary, etc.) survive — they're impl-based with no
      // cycling signals on their BlankConfig.
      if (!supportsCycling && isBlankConfigCycleable(blk)) {
        options.log?.(`buildSources: skipping cycleable blank '${name}' — host has no cycling surface`);
        continue;
      }
      keywordBlanks[name] = blk;
    }
    if (Object.keys(keywordBlanks).length > 0) {
      sources.push(new BlankSource({
        blanks: keywordBlanks,
        readState: options.readBlankState,
      }));
    }
  }

  // Spelling has no dedicated source class anymore — it's a regular
  // ConfigSource entry shipped at `defaults/cues/spelling.md` (a
  // word-scope cue with `match: .*`, priority 80, parser
  // alternatives). It loads through the same path as legal/medical/etc.

  // Config-intent: settings-change classifier (priority 94). Routes
  // `_` to an OPENCUES.md scalar flip when the surrounding text
  // semantically asks for one — runs BEFORE transform-blank (93) and
  // fluid-blank (92). Settings-only — never user blanks. Cedes to
  // keyword-bound BlankSource when a registered blank would claim
  // the slot. See config-intent-source.ts for the bench-validated
  // prompt + trust boundary.
  if (options.enableConfigIntent) {
    const resolved = resolveFor(options.configIntent);
    if (!resolved) {
      fallbackForLog('config-intent', options.configIntent?.provider || globalProvider || 'groq');
    } else if (!options.applyOpencuesScalar) {
      options.log?.('buildSources: skipping config-intent — no applyOpencuesScalar callback provided');
    } else {
      sources.push(new ConfigIntentSource({
        httpAdapter: withFallback(options.httpAdapter, resolved.fallback),
        provider: resolved.provider,
        endpoint: resolved.endpoint,
        apiKey: resolved.apiKey,
        model: resolved.model,
        applyScalar: options.applyOpencuesScalar,
        blanks: options.blanks ?? {},
        log: options.log,
        onEvent: options.onConfigIntentEvent,
      }));
    }
  }

  // Fluid-blank: free-form `_` lookup handler (P1 SEGMENT + P3 ANSWER).
  // Cedes to keyword-bound BlankSource when a registered blank would
  // claim the slot (keyword within blankProximity of the `_`).
  if (options.enableFluidBlank) {
    const resolved = resolveFor(options.fluidBlank);
    if (!resolved) {
      fallbackForLog('fluid-blank', options.fluidBlank?.provider || globalProvider || 'groq');
    } else {
      sources.push(new FluidBlankSource({
        httpAdapter: withFallback(options.httpAdapter, resolved.fallback),
        provider: resolved.provider,
        endpoint: resolved.endpoint,
        apiKey: resolved.apiKey,
        model: resolved.model,
        blanks: options.blanks ?? {},
        onEvent: options.onFluidBlankEvent,
        log: options.log,
        logInfo: options.logInfo,
      }));
    }
  }

  // Transform-blank: IMPERATIVE-instruction handler (EXTRACT + APPLY +
  // VERIFY). Priority 93 — sits ABOVE fluid-blank (92), so an
  // imperative-shaped input ("change boy to girl _ ...") routes here
  // instead of being treated as a lookup. Cedes to keyword-bound
  // BlankSource if applicable AND only claims when the surrounding text
  // starts with an imperative verb (heuristic in supports()).
  if (options.enableTransformBlank) {
    const resolved = resolveFor(options.transformBlank);
    if (!resolved) {
      fallbackForLog('transform-blank', options.transformBlank?.provider || globalProvider || 'groq');
    } else {
      sources.push(new TransformBlankSource({
        httpAdapter: withFallback(options.httpAdapter, resolved.fallback),
        provider: resolved.provider,
        endpoint: resolved.endpoint,
        apiKey: resolved.apiKey,
        model: resolved.model,
        blanks: options.blanks ?? {},
        log: options.log,
        onEvent: options.onTransformBlankEvent,
        mode: options.transformBlankMode as ('auto' | '3-pass' | 'fused' | undefined),
      }));
    }
  }

  return sources;
}
