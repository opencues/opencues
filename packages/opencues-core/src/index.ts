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
  TransformBlankSource,
  type TransformBlankSourceConfig,
  type TransformBlankEvent,
} from './sources/transform-blank-source';

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
  getProvider,
  listProviders,
  buildProviderRequest,
  parseProviderResponse,
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

