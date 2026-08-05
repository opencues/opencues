/**
 * opencues-core/sources/build-sources.ts
 *
 * Factory that creates CueSource[] from parsed .md configs.
 * Single entry point — replaces manual source construction in integrations.
 *
 * ## How sources are assembled
 *
 * **Word cues (per-word routing)**: Word-cue prompts (spelling, custom
 * vocabularies, …) live
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
import { MissingKeyFallbackSource } from './missing-key-fallback-source';
import { TransformBlankSource, type TransformBlankSourceConfig } from './transform-blank-source';
import { ConfigIntentSource, type ConfigIntentSourceConfig } from './config-intent-source';
import { SentenceCueSource, type SentenceCueSourceConfig } from './sentence-cue-source';
import { ContradictionLlmSource } from '../contradiction/contradiction-llm-source';
import { BankHolidayProvider } from '../contradiction/bank-holidays';
import { WeatherProvider } from '../contradiction/weather';
import { TflProvider } from '../contradiction/tfl';
import { RedditRulesProvider } from '../contradiction/reddit-rules';

// World-data caches for contradiction cues, PERSISTED across resolver rebuilds
// (buildSourcesFromConfig is called on every config reload; a fresh provider
// per call would reset the async-fetched cache before the verify ever reads it,
// so the data-backed cues could never fire). Bank holidays are location-
// independent (one singleton); weather providers are keyed by location scalar.
let _bankHolidayProvider: BankHolidayProvider | null = null;
const _weatherProviders = new Map<string, WeatherProvider>();
let _tflProvider: TflProvider | null = null;
let _redditRulesProvider: RedditRulesProvider | null = null;

/** Test hook — drop the persisted world-data providers so a suite starts clean. */
export function _resetContradictionProvidersForTesting(): void {
  _bankHolidayProvider = null;
  _weatherProviders.clear();
  _tflProvider = null;
  _redditRulesProvider = null;
}
import { resolveLLM, getProvider, withFallback, withFreePool, type ResolvedLLM } from '../llm-provider';
import { probeProviderReachable } from '../provider-probe';
import { collapseBucketTier } from '../effective-routing';

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
  /** Per-feature max-tokens override (e.g. `fluid-blank-max-tokens: 1024`
   *  in OPENCUES.md). Source class uses its own bench-tuned default
   *  when absent. */
  readonly maxTokens?: number;
  /** Per-feature temperature override (e.g. `fluid-blank-temperature: 0.5`).
   *  Source class uses its own default when absent. */
  readonly temperature?: number;
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
  /**
   * Per-bucket provider/model/endpoint routing — the three-bucket
   * simplification. Surfaces resolve in this precedence order:
   *
   *   per-source frontmatter > per-feature scalar > bucket scalar > globalProvider
   *
   * Two buckets are wired here (auditors run in a separate code path
   * via boot-common's `buildAgentLLMResolver`):
   *
   *   - `cuesBucket*`   — applies to cue-class sources (ConfigSource
   *                       word-cues, SentenceCueSource). Refuses providers
   *                       with `trainsOnInput: true` via the cue-class
   *                       safety guard in `resolveFor`.
   *   - `blanksBucket*` — applies to blank-class sources (FluidBlank,
   *                       TransformBlank, ConfigIntent, keyword
   *                       BlankSource). Accepts opencode-zen when the
   *                       user explicitly opts in.
   *
   * Set from OPENCUES.md `cues-llm-provider:` / `blanks-llm-provider:`
   * (and the matching `-model:` / `-endpoint:` scalars). `'inherit'`
   * (the default) collapses to undefined — falls through to
   * `globalProvider`. The runtime is responsible for that collapse
   * before passing values down.
   *
   * Structural rule: NEVER let cue-class sources resolve to a provider
   * with `trainsOnInput: true` (today: opencode-zen). Enforced two
   * ways: (1) build-sources reads `blanksBucket*` only at blank-class
   * call sites; (2) `resolveFor`'s trainsOnInput guard refuses
   * cue-class sources resolving to a training-pool provider via any
   * path (per-feature, bucket, global).
   */
  cuesBucketProvider?: string;
  cuesBucketModel?: string;
  cuesBucketEndpoint?: string;
  blanksBucketProvider?: string;
  blanksBucketModel?: string;
  blanksBucketEndpoint?: string;
  /** Per-feature defaults read from OPENCUES.md root frontmatter. */
  wordCues?: FeatureLLMSetting;
  fluidBlank?: FeatureLLMSetting;
  transformBlank?: FeatureLLMSetting;
  configIntent?: FeatureLLMSetting;
  sentenceCues?: FeatureLLMSetting;
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
   * Enable the transform-blank source — a single-call FUSED handler
   * for IMPERATIVE instructions placed next to `_`. Where
   * fluid-blank handles "capital of france _", transform-blank handles
   * "hey can u send me that report make this formal _". Priority 93 — sits ABOVE
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
   * Enable ACTION (undo/redo) verdicts on the config-intent classifier
   * (`undo-mode`). Independent of `enableConfigIntent`: either flag
   * constructs the source, and each gates its own verdict kinds
   * (verdict-level gating — the prompt stays byte-stable for prefix
   * caching). Action verdicts carry NO emit-time side effect; the
   * runtime's undo journal applies them. Defaults to false.
   */
  enableUndoActions?: boolean;
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
  /**
   * Enable the calendar-context catalog (`calendar-context-mode: on`). Set
   * independently of `enableSentenceCues` so the shipped calendar-conflict cue
   * (`uses-calendar-context: true`, `scope: sentence`) is AUTO-IMPLIED by
   * turning calendar context on — a user who enables calendar reasoning
   * shouldn't also have to discover the separately-named `sentence-cues-mode`
   * toggle to get conflict warnings. The source still self-inerts when no
   * calendar feed is present, so this only surfaces cues when there's data.
   * Other (non-calendar) sentence cues stay behind `enableSentenceCues`.
   */
  enableCalendarContext?: boolean;
  /** Enable the deterministic contradiction-cue layer (Tier 0: weekday-date
   *  mismatch, split-the-bill math — buffer + clock only, no LLM/network).
   *  Defaults to false; flip on via OPENCUES.md `contradiction-cues-mode: on`. */
  enableContradictionCues?: boolean;
  /** Host-provided GET for the contradiction world-data caches (bank holidays,
   *  weather). Chrome passes a service-worker-routed fetch (a content-script
   *  fetch is blocked by the host page's CSP); native hosts omit it → global fetch. */
  worldDataFetch?: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
  /** Tier 5 — optional weather-location override (the `weather-location` scalar):
   *  a city name ("Manchester") OR "lat,lon". Omitted → auto-detected from the
   *  host timezone. A city name is geocoded by the provider. */
  weatherLocation?: string;
  /** Tier 5d — live page-location getter (origin + pathname) for page-scoped
   *  community-rules lookups (subreddit rules). Chrome's content script passes
   *  `location`; native hosts have no page → omit → tier silent. The provider's
   *  fetch is deliberately the content-script GLOBAL fetch, not worldDataFetch:
   *  on a reddit page it's a same-origin request riding the page session
   *  (allowed by reddit's `connect-src 'self'` CSP — no SW hop needed). */
  pageLocation?: () => { origin: string; pathname: string } | null;
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
   * Host-specific text shown in the buffer when the user types `_` AND
   * no LLM source could be wired (zero working API keys). Host overrides
   * — chrome says "open the extension popup", native hosts (CC/OC) say
   * "set CEREBRAS_API_KEY in ~/.cues/.env or your shell env". When
   * omitted, the fallback source is NOT wired and the silent-no-op
   * regression returns. Pass an empty string to suppress.
   */
  missingKeyFallbackMessage?: string;
  /**
   * Host-specific formatter for USER-ACTIONABLE LLM call failures
   * (401, 404, 429, network unreachable). Returns the in-buffer
   * substitute text. Empty return suppresses the substitute (silent
   * — useful when the host has another error surface, e.g. native
   * hosts with a statusline). LLM-internal issues (malformed JSON,
   * no-span) stay silent regardless — those aren't actionable.
   */
  formatLLMErrorAsSubstitute?: (
    reason: 'invalid-api-key' | 'network' | 'rate-limit' | 'endpoint-not-found' | 'model-not-found' | 'insufficient-credits' | 'bad-request',
    err?: Error,
    // Provider context lets the formatter give provider-specific guidance
    // (e.g. local `ollama` → "run `ollama pull <model>`" / "start
    // `ollama serve`" instead of the cloud-centric API-key/connectivity hints).
    ctx?: { provider?: string; model?: string; endpoint?: string },
  ) => string;
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
  /** Subscriber for `TransformBlankSource` (fused pipeline). */
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

  /**
   * Host id (chrome / claude-code / …). Used to host-scope the
   * config-intent classifier's feature list so a chrome-only FEATURE
   * (e.g. `statusbar-position`) never appears on another host's prompt.
   * Runtime wires `adapter.hostName`.
   */
  hostName?: string;
  /**
   * OPENCUES.md `max-thinking` toggle. `true` (default) lets each
   * reasoning-capable model think up to its per-model ceiling (the
   * pre-feature behaviour); `false` drops it to the model's reduced
   * level for faster, cheaper cues/blanks. Threaded into every LLM
   * source's dispatch ctx → resolved per-model in
   * `@opencues/core/model-thinking.ts`'s `resolveReasoningEffort`.
   *
   * Set from OPENCUES.md `max-thinking: on | off` by the runtime
   * (resolver.ts). The config-intent classifier is unaffected — it
   * pins reasoning to `low` regardless.
   */
  maxThinking?: boolean;
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
 *   FluidBlankSource (always-on base layer; no mode scalar).
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
  // Bucket override tiers, collapsed onto resolveLLM's global tier by
  // the SHARED walk (effective-routing.ts) — the same collapse doctor
  // and the `model` blank display, so dispatch and "what's my model?"
  // cannot drift. Handles inherit/empty/unknown bucket scalars, model
  // sentinels (`default`/`inherit`), the pinned-bucket unpairing of the
  // global llm-model, AND honors a bucket model against an inherited
  // provider (the July 2026 silently-inert menu-pick fix).
  const cuesTier = collapseBucketTier({
    bucketProvider: options.cuesBucketProvider,
    bucketModel: options.cuesBucketModel,
    globalProvider,
    globalModel,
  });
  const blanksTier = collapseBucketTier({
    bucketProvider: options.blanksBucketProvider,
    bucketModel: options.blanksBucketModel,
    globalProvider,
    globalModel,
  });
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
   *
   * `isBlankClass: true` routes the source through the blanks bucket
   * tier (`blanksBucket*`); false/omitted routes through the cues
   * bucket tier (`cuesBucket*`). Auditors / agent-rewrite resolve
   * elsewhere (boot-common's buildAgentLLMResolver) and never reach
   * this path.
   */
  function resolveFor(featureSetting: FeatureLLMSetting | undefined, perSource?: SourceConfig, isBlankClass?: boolean): ResolvedLLM | null {
    // Pick the collapsed bucket tier this source belongs to (pairing
    // rules live in collapseBucketTier — see its doc comment).
    const tier = isBlankClass ? blanksTier : cuesTier;
    const resolved = resolveLLM({
      providerOverride: perSource?.provider,
      modelOverride: perSource?.model,
      endpointOverride: perSource?.endpoint,
      featureProvider: featureSetting?.provider,
      featureModel: featureSetting?.model,
      globalProvider: tier.globalProvider,
      globalModel: tier.globalModel,
      apiKeys,
    });

    // Prose-source safety guard: refuse to wire a cue-class source
    // through a provider whose ToS lets the operator train on submitted
    // inputs (today: opencode-zen). Cues run on the user's actual buffer
    // text — leaking prose to a training pool is the failure mode this
    // flag exists to prevent. Blanks are user-opt-in (`_` keystroke =
    // consent) and may use such providers.
    //
    // Belt-and-braces in addition to the structural design that
    // blank-class call sites set isBlankClass=true: if a user (or
    // future feature) routed a cue through `<feature>-llm-provider:
    // opencode-zen` per-feature, this fires.
    if (resolved && !isBlankClass && resolved.provider.trainsOnInput) {
      options.log?.(
        `buildSources: refusing to wire cue source through ${resolved.provider.id} — provider trains on input. ` +
        `Set the per-feature provider explicitly, or remove the override.`,
      );
      return null;
    }
    return resolved;
  }

  // Contradiction cues (validator class) — a built-in source, not driven by any
  // CUE.md. Robust engine: the LLM PARSES each sentence into a grounded claim;
  // the deterministic verifiers JUDGE it (checks.ts). LLM-ONLY — like every
  // other cue. The old pure-regex ContradictionCueSource fallback was removed
  // (July 2026): it silently ran a dumb checker that needed a literal `$` + an
  // explicit headcount, so "250 between 4 that's 55 each" produced nothing and
  // masked the fact that the LLM engine wasn't wired. If no LLM resolves (only
  // the trainsOnInput-refusal / no-provider edge — resolveLLM otherwise
  // hardcodes cerebras) the cue simply doesn't run, exactly like more-formal.
  //
  // MUST come after apiKeys / cuesTier / blanksTier / resolveFor are defined —
  // resolveFor closes over cuesTier, so calling it earlier hits a temporal-dead-
  // zone (ReferenceError in native Node; a silent null under esbuild's const→var
  // lowering in chrome). See resolveFor + the tier block above.
  if (options.enableContradictionCues) {
    const cxLlm = resolveFor(options.sentenceCues);
    if (cxLlm) {
      options.log?.(`buildSources: contradiction-cues → LLM engine (${cxLlm.provider.id}/${cxLlm.model})`);
      // Keyless world-data caches, refreshed fire-and-forget by the source, read
      // synchronously by the verifiers. `worldDataFetch` is the host's GET
      // (chrome routes it through the SW to dodge page CSP; native hosts omit it
      // → global fetch). PERSISTED across rebuilds (module singletons) — the
      // resolver rebuilds sources on every config reload, and a fresh provider
      // would reset the cache to empty every time, so the async-fetched forecast
      // would never survive to the verify (the weather cue would never fire).
      // Tier 0.5 — GOV.UK bank holidays (location-independent → one singleton).
      const bankHolidays = (_bankHolidayProvider ??= new BankHolidayProvider({ fetchImpl: options.worldDataFetch, log: (m) => options.log?.(m) }));
      // Tier 5 — open-meteo forecast. Location auto-detected from the host
      // timezone; the `weather-location` override is a city name OR "lat,lon".
      // Keyed by location so changing the scalar makes a fresh provider.
      const wl = options.weatherLocation?.trim();
      const wlKey = wl || 'auto';
      let weather = _weatherProviders.get(wlKey);
      if (!weather) {
        const latlon = wl && /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(wl)
          ? wl.split(',').map(s => Number(s.trim())) : null;
        weather = new WeatherProvider({
          latitude: latlon ? latlon[0] : undefined,
          longitude: latlon ? latlon[1] : undefined,
          locationName: latlon ? undefined : (wl || undefined),
          fetchImpl: options.worldDataFetch,
          log: (m) => options.log?.(m),
        });
        _weatherProviders.set(wlKey, weather);
      }
      // Tier 5b — TfL line-disruption status (London; location-independent).
      const tfl = (_tflProvider ??= new TflProvider({ fetchImpl: options.worldDataFetch, log: (m) => options.log?.(m) }));
      // Tier 5d — reddit community rules, keyed off the LIVE page location
      // (only constructed when the host has a page — chrome). Default fetch on
      // purpose: same-origin content-script GET, not the SW-routed worldDataFetch.
      const communityRules = options.pageLocation
        ? (_redditRulesProvider ??= new RedditRulesProvider({ getLocation: options.pageLocation, log: (m) => options.log?.(m) }))
        : undefined;
      sources.push(new ContradictionLlmSource({
        httpAdapter: withFallback(options.httpAdapter, cxLlm.fallback),
        provider: cxLlm.provider,
        endpoint: cxLlm.endpoint,
        apiKey: cxLlm.apiKey,
        model: cxLlm.model,
        bankHolidays,
        weather,
        tfl,
        communityRules,                           // Tier 5d — page-scoped subreddit rules
        worldDataFetch: options.worldDataFetch,   // Tier 5c — per-query journey geocoding
        log: (m) => options.log?.(m),
      }));
    } else {
      options.log?.('buildSources: contradiction-cues → SKIPPED (no LLM resolvable — no key / trainsOnInput provider)');
    }
  }

  /**
   * Pick the right HTTP-adapter wrapper for a resolved blank-class
   * source. When the resolved provider is `opencode-zen` AND the user
   * explicitly set model=`free`, wrap with `withFreePool` so transient
   * failures walk the free-pool model list (and sticky auth/quota
   * errors bubble up for ProviderHealth).
   *
   * The explicit `model: free` is the user's consent gate for routing
   * blank text through a training-pool provider. Without it (provider
   * picked but model left at default/unset), we still use the free
   * pool because opencode-zen has no other entry point today, but log
   * once at build time so the user knows what's happening.
   *
   * Other providers get the standard `withFallback` (groq↔cerebras).
   */
  function wrapAdapterForBlank(resolved: ResolvedLLM) {
    if (resolved.provider.id === 'opencode-zen') {
      if (resolved.model !== 'free') {
        options.log?.(
          `buildSources: blank-class source routed to opencode-zen with model='${resolved.model}' — ` +
          `opencode-zen only serves a free pool today. Set \`<feature>-llm-model: free\` to ` +
          `acknowledge the privacy trade-off explicitly (provider trains on input).`,
        );
      }
      return withFreePool(options.httpAdapter);
    }
    return withFallback(options.httpAdapter, resolved.fallback);
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
        // The calendar-conflict cue (uses-calendar-context) is auto-implied by
        // calendar-context-mode — it fires even when the general
        // sentence-cues-mode toggle is off, because a user who turned on
        // calendar reasoning expects conflict warnings without hunting for a
        // second, differently-named toggle. It self-inerts with no feed
        // (supports() returns false when calendarContext is empty), so no LLM
        // call fires unless there's real calendar data. Every OTHER
        // sentence-scope cue stays gated behind sentence-cues-mode.
        const calendarImplied = srcCfg.usesCalendarContext && options.enableCalendarContext;
        if (!options.enableSentenceCues && !calendarImplied) continue;
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
          maxThinking: options.maxThinking,
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
          maxThinking: options.maxThinking,
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
          maxThinking: options.maxThinking,
        }));
      }
    }

    if (wordCueSources.length > 0) {
      sources.push(new RoutedWordSourceGroup({ sources: wordCueSources, log: options.log }));
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
  // ConfigSource entry shipped at `defaults/cues/spelling/CUE.md` (a
  // word-scope cue with `match: .*`, priority 10, parser
  // alternatives). It loads through the same path as any word cue.

  // Config-intent: settings-change classifier (priority 94). Routes
  // `_` to an OPENCUES.md scalar flip when the surrounding text
  // semantically asks for one — runs BEFORE transform-blank (93) and
  // fluid-blank (92). Settings-only — never user blanks. Cedes to
  // keyword-bound BlankSource when a registered blank would claim
  // the slot. See config-intent-source.ts for the bench-validated
  // prompt + trust boundary.
  if (options.enableConfigIntent || options.enableUndoActions) {
    const resolved = resolveFor(options.configIntent, undefined, true);
    // Settings verdicts need the applyOpencuesScalar callback; action
    // verdicts don't (no emit-time side effect — the runtime's undo
    // journal applies them). Construct the source whenever at least
    // one verdict kind can actually be honoured; each kind is gated
    // verdict-level inside the source (prompt stays byte-stable).
    const allowConfigVerdicts = !!options.enableConfigIntent && !!options.applyOpencuesScalar;
    const allowActionVerdicts = !!options.enableUndoActions;
    if (options.enableConfigIntent && !options.applyOpencuesScalar) {
      options.log?.('buildSources: config-intent settings verdicts disabled — no applyOpencuesScalar callback provided');
    }
    if (!resolved) {
      fallbackForLog('config-intent', options.configIntent?.provider || blanksTier.globalProvider || 'groq');
    } else if (allowConfigVerdicts || allowActionVerdicts) {
      sources.push(new ConfigIntentSource({
        httpAdapter: wrapAdapterForBlank(resolved),
        provider: resolved.provider,
        endpoint: resolved.endpoint,
        apiKey: resolved.apiKey,
        model: resolved.model,
        maxTokens: options.configIntent?.maxTokens,
        temperature: options.configIntent?.temperature,
        applyScalar: options.applyOpencuesScalar ?? (() => { /* settings verdicts gated off */ }),
        // Pre-switch liveness gate — ping the TARGET provider before a
        // provider verdict writes the scalar; stay put + inline-error on
        // failure. Pings default endpoint + the live key bag; no cascade.
        probeProvider: (providerId, model) =>
          probeProviderReachable(providerId, model, {
            apiKeys,
            httpAdapter: options.httpAdapter,
          }),
        blanks: options.blanks ?? {},
        log: options.log,
        onEvent: options.onConfigIntentEvent,
        formatErrorAsSubstitute: options.formatLLMErrorAsSubstitute,
        hostName: options.hostName,
        allowConfigVerdicts,
        allowActionVerdicts,
      }));
    }
  }

  // Fluid-blank: free-form `_` lookup handler (P1 SEGMENT + P3 ANSWER).
  // Cedes to keyword-bound BlankSource when a registered blank would
  // claim the slot (shape match, or keyword on the same line as `_`).
  if (options.enableFluidBlank) {
    const resolved = resolveFor(options.fluidBlank, undefined, true);
    if (!resolved) {
      fallbackForLog('fluid-blank', options.fluidBlank?.provider || blanksTier.globalProvider || 'groq');
    } else {
      sources.push(new FluidBlankSource({
        httpAdapter: wrapAdapterForBlank(resolved),
        provider: resolved.provider,
        endpoint: resolved.endpoint,
        apiKey: resolved.apiKey,
        model: resolved.model,
        maxTokens: options.fluidBlank?.maxTokens,
        temperature: options.fluidBlank?.temperature,
        maxThinking: options.maxThinking,
        blanks: options.blanks ?? {},
        onEvent: options.onFluidBlankEvent,
        log: options.log,
        logInfo: options.logInfo,
        formatErrorAsSubstitute: options.formatLLMErrorAsSubstitute,
      }));
    }
  }

  // Transform-blank: IMPERATIVE-instruction handler (EXTRACT + APPLY +
  // VERIFY). Priority 93 — sits ABOVE fluid-blank (92), so an
  // imperative-shaped input ("... make this formal _") routes here
  // instead of being treated as a lookup. Cedes to keyword-bound
  // BlankSource if applicable AND only claims when the surrounding text
  // starts with an imperative verb (heuristic in supports()).
  if (options.enableTransformBlank) {
    const resolved = resolveFor(options.transformBlank, undefined, true);
    if (!resolved) {
      fallbackForLog('transform-blank', options.transformBlank?.provider || blanksTier.globalProvider || 'groq');
    } else {
      sources.push(new TransformBlankSource({
        httpAdapter: wrapAdapterForBlank(resolved),
        provider: resolved.provider,
        endpoint: resolved.endpoint,
        apiKey: resolved.apiKey,
        model: resolved.model,
        maxTokens: options.transformBlank?.maxTokens,
        temperature: options.transformBlank?.temperature,
        maxThinking: options.maxThinking,
        blanks: options.blanks ?? {},
        log: options.log,
        onEvent: options.onTransformBlankEvent,
        formatErrorAsSubstitute: options.formatLLMErrorAsSubstitute,
      }));
    }
  }

  // Smart-failure fallback. If NO LLM-backed blank source was wired
  // (zero working API keys), the user types `_` and gets nothing —
  // a silent failure that looks identical to a broken extension. Wire
  // a MissingKeyFallbackSource at the bottom so the next `_` substitutes
  // with a visible, host-specific hint telling the user where to set
  // a key. The runtime treats it as a regular substitute — cycling
  // back to `_` dismisses the message.
  if (options.missingKeyFallbackMessage && options.missingKeyFallbackMessage.length > 0) {
    const hasLLMSource = sources.some(s => s.id === 'fluid-blank' || s.id === 'transform-blank' || s.id === 'config-intent');
    if (!hasLLMSource) {
      options.log?.(`buildSources: no LLM-backed source wired — installing MissingKeyFallbackSource (msg="${options.missingKeyFallbackMessage}")`);
      sources.push(new MissingKeyFallbackSource({ message: options.missingKeyFallbackMessage }));
    }
  }

  return sources;
}
