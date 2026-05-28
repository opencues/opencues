/**
 * opencues-core
 *
 * Core OpenCues library - pure TypeScript with no I/O dependencies.
 * Platform-specific functionality is provided via adapters.
 */

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
  determineReplaceMode,
  resolveReplaceMode,
  type FluidBlankSourceConfig,
  type FluidBlankEvent,
  type EffectiveReplaceMode,
  type BlankReplaceFlags,
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
  type ConfigIntentSourceConfig,
  type ConfigIntentEvent,
  type ConfigIntentVerdict,
} from './sources/config-intent-source';

export {
  SentenceCueSource,
  segmentSentences,
  parseSentenceAltOutput,
  SENTENCE_ALT_FORMAT_SPEC,
  type SentenceCueSourceConfig,
  type SentenceCueEvent,
  type SentenceSpan,
  type SentenceAltBlock,
} from './sources/sentence-cue-source';

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
  getProvider,
  listProviders,
  buildProviderRequest,
  parseProviderResponse,
  dispatchChat,
  resolveLLM,
  validateEndpoint,
  withFallback,
  useStrictJson,
  buildJsonResponseFormat,
  type EndpointValidation,
  type ProviderId,
  type ProviderAdapter,
  type ChatRequest,
  type BuiltRequest,
  type ResolveLLMOptions,
  type ResolvedLLM,
  type HttpAdapterShape,
  type ResponseFormat,
} from './llm-provider';

// Host-compat: which integrations a cue or blank runs on
export {
  inferHostCompat,
  inferSiteCompat,
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

// User-context (sentinel-mode personal data): parser, catalog
// renderer, post-processor. Consumed by FluidBlankSource when
// `user-context-mode` is on in OPENCUES.md.
export {
  parseUserMd,
  deriveToken,
  renderUserCatalog,
  postProcessUserContext,
  type UserContext,
  type UserContextField,
  type UserContextMode,
  type PostProcessOptions as UserContextPostProcessOptions,
  type PostProcessResult as UserContextPostProcessResult,
  type PostProcessReport as UserContextPostProcessReport,
} from './user-context';

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

