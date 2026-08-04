/**
 * opencues-core
 *
 * Core OpenCues library - pure TypeScript with no I/O dependencies.
 * Platform-specific functionality is provided via adapters.
 */

// Spec version
export {
  SPEC_VERSION,
  SPEC_OMIT_DEFAULT,
  parseSpecPin,
  isSpecCompatible,
  type SpecVersion,
  type SpecPin,
  type SpecCompatResult,
} from './spec-version';

// Types
export * from './types';

// Resolver
export { CueResolver, createResolver, type ResolverResult } from './resolver';

// Config-driven sources (primary API)
export {
  ConfigSource,
  type ConfigSourceOptions,
} from './sources/config-source';

export {
  BlankSource,
  isBlankConfigCycleable,
  type BlankSourceConfig,
} from './sources/blank-source';

export {
  FluidBlankSource,
  type FluidBlankSourceConfig,
  type FluidBlankEvent,
} from './sources/fluid-blank-source';

export {
  MissingKeyFallbackSource,
  type MissingKeyFallbackConfig,
} from './sources/missing-key-fallback-source';

export {
  TransformBlankSource,
  type TransformBlankSourceConfig,
  type TransformBlankEvent,
} from './sources/transform-blank-source';

export {
  ConfigIntentSource,
  parseConfigIntentOutput,
  validateAgainstRegistry,
  matchDeterministicAction,
  type DeterministicActionMatch,
  type ConfigIntentSourceConfig,
  type ConfigIntentEvent,
  type ConfigIntentVerdict,
  type ConfigIntentAction,
  type ActionVerdict,
} from './sources/config-intent-source';

export {
  keywordInWindow,
  keywordGap,
  lineOfWords,
  LINE_SCOPE_FALLBACK_PROXIMITY,
  type KeywordWindowOptions,
} from './keyword-window';

export {
  SentenceCueSource,
  segmentSentences,
  parseSingleSentenceAlts,
  SINGLE_SENTENCE_FORMAT_SPEC,
  estimateSentenceCueBudget,
  mapWithConcurrency,
  type SentenceCueSourceConfig,
  type SentenceCueEvent,
  type SentenceSpan,
  type SingleSentenceAlts,
} from './sources/sentence-cue-source';

export { ContradictionCueSource, type ContradictionCueSourceOptions } from './contradiction/contradiction-cue-source';
export { ContradictionLlmSource, parseClaims, CONTRADICTION_EXTRACT_SYSTEM, type ContradictionLlmSourceConfig } from './contradiction/contradiction-llm-source';
export { BankHolidayProvider, type BankHolidayProviderOptions, type BankHolidayRegion } from './contradiction/bank-holidays';
export { WeatherProvider, type WeatherProviderOptions } from './contradiction/weather';
export { TflProvider, type TflProviderOptions, normalizeLine } from './contradiction/tfl';
export { geocodePlace, haversineKm, estimateJourneyMinutes, type JourneyMode } from './contradiction/journey';
export {
  weekdayDateCheck,
  splitBillCheck,
  TIER0_CHECKS,
  verifyClaim,
  verifyJourneyClaim,
  safeEvalArithmetic,
  type Claim,
  type WorkdayOnHolidayClaim,
  type OutdoorPlanWeatherClaim,
  type TubeLinePlanClaim,
  type JourneyUnderestimateClaim,
  type VerifyContext,
  type VerifiedContradiction,
  type Contradiction,
  type ContradictionCheck,
  type ContradictionEnv,
} from './contradiction/checks';

export {
  buildSourcesFromConfig,
  type BuildSourcesOptions,
} from './sources/build-sources';

// Response parsers
export {
  parseAlternatives,
  parseRaw,
} from './sources/parsers';

// Local tips source
export {
  LocalCueSource,
  lookupWord,
  lookupWords,
  parseLocalCueFile,
  validateLocalCueData,
  buildLookupMap,
  lookupMultiple,
  formatAsWordDefs,
  mergeWordDefs,
  cleanAlternatives,
  convertCueResultsToWordDefs,
  type MergeWordDefsOptions,
  type LocalCueLookupResult,
} from './sources/local-cue-source';

// Re-export WordDef types for consumers
export type { WordDef, LookupMultipleResult } from './types';

// CUES.md parser
export {
  parseCuesMd,
  parseSingleCueMd,
  parseSingleAuditorMd,
  parseCuesMaster,
  parseBlanksMaster,
  parseAuditorsMaster,
  validateCuesMd,
  type CuesMdConfig,
  type CuesMdFrontmatter,
  type SingleCueFrontmatter,
  type PromptConfig,
  type SourceConfig,
  type BlankConfig,
  type BlankShape,
  type ActionConfig,
  type AuditorConfig,
  type BlankParser,
} from './cues-md';

// Folder-based config discovery
export {
  discoverFolderConfigs,
  mergeConfigs,
  type DiscoverOptions,
  type DiscoveredConfigs,
  type DirEntry,
} from './discover';

// LLM provider abstraction
export {
  PROVIDER_IDS,
  PROVIDER_AUTO_ORDER,
  SUBSCRIPTION_AUTO_FALLBACK,
  SUBSCRIPTION_CLI_BINARIES,
  pickAutoProvider,
  defaultCliAvailable,
  resetCliAvailabilityCacheForTests,
  setCliAvailabilityForTests,
  getProvider,
  isProviderValueCyclable,
  listProviders,
  buildProviderRequest,
  parseProviderResponse,
  dispatchChat,
  setOutboundDehydrationGuard,
  getOutboundDehydrationGuard,
  applyOutboundDehydrationFloor,
  resolveLLM,
  resolveLLMTuple,
  validateEndpoint,
  withFallback,
  useStrictJson,
  buildJsonResponseFormat,
  setCoreWarn,
  type EndpointValidation,
  type ProviderId,
  type ProviderAdapter,
  type ChatRequest,
  type BuiltRequest,
  type ResolveLLMOptions,
  type ResolvedLLM,
  type ResolvedLLMTuple,
  type HttpAdapterShape,
  type ResponseFormat,
} from './llm-provider';

// Pre-switch provider liveness probe — ping the provider a mode/provider
// change is about to land on; stay put + inline-error on failure.
export {
  probeProviderReachable,
  PROVIDER_PROBE_TIMEOUT_MS,
  type ProviderProbeResult,
  type ProviderProbeOptions,
} from './provider-probe';

// Effective LLM routing — the shared bucket→global→auto precedence walk
// used by dispatch (build-sources / boot-common via collapseBucketTier)
// AND every "what's my model?" display surface (doctor, the `model`
// blank, `opencues models`). See effective-routing.ts header.
export {
  LLM_BUCKETS,
  collapseBucketTier,
  normalizeBucketProviderScalar,
  normalizeModelScalar,
  resolveEffectiveRouting,
  type CollapseBucketTierOptions,
  type CollapsedBucketTier,
  type EffectiveBucketRouting,
  type EffectiveModelSource,
  type EffectiveProviderSource,
  type EffectiveRouting,
  type LlmBucket,
  type ResolveEffectiveRoutingOptions,
} from './effective-routing';

// Existing-key detection — boot-time API-key bag construction from
// host-passed keys + shell env + ~/.cues/.env (see env-keys.ts header)
export {
  buildBootApiKeys,
  augmentApiKeysFromEnv,
  detectProviderKeys,
  readCuesEnvFile,
  cuesEnvFilePath,
  parseEnvFileContent,
  type DetectedProviderKey,
  type KeySource,
} from './env-keys';

// Per-model thinking-budget resolution for the `max-thinking` setting
export {
  resolveReasoningEffort,
  lookupModelThinking,
  type ReasoningEffort,
  type ModelThinking,
  type ResolveReasoningArgs,
} from './model-thinking';

// Host-compat: which integrations a cue or blank runs on
export {
  inferHostCompat,
  inferSiteCompat,
  inferFieldCompat,
  fieldKindOf,
  structuralAmbientOnly,
  FIELD_KINDS,
  unknownHostNames,
  formatHostList,
  HOSTS,
  NATIVE_HOSTS,
  HOST_ALIASES,
  resolveHost,
  type Host,
  type HostCompatInput,
  type HostCompatResult,
  type SiteCompatContext,
} from './host-compat';

// Cursor sentinel: shared between TransformBlankSource (core) and
// AgentRewrite (runtime). Single source of truth for the [CURSOR]
// marker injected into LLM prompts at the user's caret position.
export {
  CURSOR_SENTINEL,
  stripCursorSentinel,
  injectCursorSentinel,
} from './cursor-sentinel';

// Identity-context — the user's personal-data catalog. Parser,
// prompt-block renderer, substitution post-processor. Consumed by
// FluidBlankSource when `identity-context-mode` is on in OPENCUES.md.
// (Renamed June 2026 from "sentinels". seed-configs migrates legacy
// file/scalar names; runtime only knows the canonical names.)
export {
  parseIdentityMd,
  renderIdentityContextCatalog,
  renderIdentityContextCatalogForTransform,
  postProcessContext,
  deriveToken,
} from './identity-context';
// Blank-as-context — ambient blank tokens (stocks/weather/crypto/…)
// surfaced as sentinel-style tokens for fluid-blank without typing
// the blank keyword. Same threat model as sentinels; same
// safe-tokens prompt shape. See docs/features/blank-as-context.md.
export {
  deriveBlankContextToken,
  planBlankContextSlots,
  renderBlankContextCatalog,
  mergeCatalogs,
} from './blank-context';
export type {
  BlankContextMode,
  BlankContextSlot,
  BlankContextSnapshot,
  ResolvedBlankContextField,
  PlanResult as BlankContextPlanResult,
} from './blank-context';

// Calendar-context — ingested life-data (calendar first) as a REASONING catalog
// for fluid-blank. Unlike the substitution catalogs (identity/blank/system),
// the model reasons over the event times; only titles are dehydrated tokens.
// Ingest-on-a-timer, never invoke-per-keystroke. See docs/architecture/calendar-context.md.
export {
  buildCalendarContextSnapshot,
  renderCalendarContextCatalog,
  renderCalendarContextForCue,
} from './calendar-context';
export type {
  CalendarContextMode,
  CalendarContextEvent,
  CalendarContextSnapshot,
} from './calendar-context';
export {
  syncCalendarFeeds,
  calendarSyncDue,
  readCalendarFeedUrls,
  calendarSnapshotAgeAnchor,
  CALENDAR_SYNC_TTL_MS,
  CALENDAR_FEEDS_BASENAME,
  CALENDAR_SNAPSHOT_BASENAME,
  type CalendarSyncDeps,
  type CalendarSyncResult,
} from './calendar-sync';

// iCalendar (.ics / webcal) parser — the first real calendar-context producer.
// Pure (no network); the host poller fetches the feed and passes the text.
// One parser covers Luma / Google / Outlook / Apple / any .ics feed.
export { parseIcs } from './ics';

// Session-commitments — a REASONING watchlist of CC-developer decisions
// distilled from the session transcript, matched against the draft in realtime
// by SessionContradictionSource. Ingest-on-a-timer (the `opencues
// extract-commitments` producer writes the snapshot), never per-keystroke.
// See docs/architecture/session-contradiction.md.
export {
  buildSessionCommitmentsSnapshot,
  parseExtractionResult,
  sessionCommitmentsKey,
  extractTranscriptTurns,
  extractGeminiTranscriptTurns,
  stripHarnessFraming,
  renderTranscriptForExtraction,
  renderSessionCommitmentsCatalog,
  renderSessionContextForAsk,
  mergeSessionCommitments,
  normalizeCommitmentStatement,
  parseSupersededResult,
  SESSION_COMMITMENTS_EXTRACT_SYSTEM,
  SESSION_COMMITMENTS_SUPERSEDE_SYSTEM,
  COMMITMENT_CATEGORIES,
  MAX_COMMITMENTS,
  MAX_STATEMENT_LEN,
} from './session-commitments';
export type {
  SessionContradictionMode,
  CommitmentCategory,
  SessionCommitment,
  SessionCommitmentsSnapshot,
  TranscriptTurn,
} from './session-commitments';

// Tool-prompt cues — populate cues from a well-known tool system-prompt
// (AskUserQuestion first): question → tip, options → cyclable alternatives on
// the selected span. A generic, pluggable primitive. See tool-prompt-source.ts.
export { SessionCueSource } from './sources/session-cue-source';
export type { SessionCueSourceConfig } from './sources/session-cue-source';
export {
  ToolPromptCueSource,
  parseToolQuestion,
  renderSingleLineTip,
  renderAmbientForAsk,
  SINGLE_LINE_TIP_MAX,
  ASK_USER_QUESTION_SYSTEM,
  TOOL_PROMPTS,
} from './sources/tool-prompt-source';
export type {
  ToolOption,
  ToolQuestion,
  ToolPrompt,
} from './sources/tool-prompt-source';
export type { IcsEvent, ParseIcsOptions } from './ics';

// IDENTITY.md write-validator — load-bearing safety check for any path
// that mutates `~/.cues/IDENTITY.md`. Used by the CLI's `identity` command
// today; will be used by a future keyword-bound sentinel blank.
// See docs/architecture/security-audit.md row #24.
export {
  validateSentinelWrite,
  DEFAULT_SENTINEL_CAPS,
  type SentinelCaps,
  type SentinelField,
  type SentinelWriteOp,
  type SentinelValidationResult,
} from './identity-validator';

// Identity-context type exports.
export {
  type Identity,
  type IdentityField,
  type ContextMode,
  type PostProcessOptions,
  type PostProcessResult,
  type PostProcessReport,
} from './identity-context';

// Dehydration — outbound value→token scrub (the inverse of the
// post-processor's hydration). In `identity-context-mode: safe`, every
// LLM-bound copy of buffer text is dehydrated before dispatch so PII
// the user TYPED never leaves the machine; the sources hydrate the
// response back via postProcessContext. Compiled matchers are cached
// per catalog-Map instance (fresh Map per config hot-reload).
// See docs/architecture/hydration-dehydration.md.
export {
  compileDehydrator,
  getDehydrator,
  type CompiledDehydrator,
  type DehydrationResult,
  type DehydrationSpan,
  type DehydrationSkip,
} from './dehydrate';

// Feature registry — single source of truth for the set of optional
// features OpenCues exposes via OPENCUES.md scalars. Consumed by
// ConfigLoader, doctor, host.cjs, and seed-configs to prevent the
// install-boundary drift class of bug. See feature-registry.ts for
// the "how to add a feature" contract.
export {
  CORE_CONFIG_FILES,
  CORE_SETTINGS_FILE,
  CORE_TEMPLATES,
  FEATURES,
  MENU_TUNABLES,
  findFeature,
  chromeHostFileList,
  allConfigFileBasenames,
  seedableOptionalFiles,
  getDefaultValue,
  getValueIds,
  getCyclableValues,
  getMenuDefinitions,
  type FeatureSpec,
  type ValueSpec,
  type MenuTunableSpec,
  type SeedableFile,
} from './feature-registry';

export { matchBlankShape, type BlankShapeMatch } from './blank-shapes';
export { segmentStart } from './segment';
