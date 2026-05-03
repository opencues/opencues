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
  type FluidBlankSourceConfig,
} from './sources/fluid-blank-source';

export {
  TransformBlankSource,
  type TransformBlankSourceConfig,
} from './sources/transform-blank-source';

export {
  SpellingSource,
  type SpellingSourceConfig,
} from './sources/spelling-source';

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

// cues.md parser
export {
  parseCuesMd,
  parseSingleCueMd,
  validateCuesMd,
  type CuesMdConfig,
  type CuesMdFrontmatter,
  type SingleCueFrontmatter,
  type PromptConfig,
  type SourceConfig,
  type BlankConfig,
  type ActionConfig,
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

// Host-compat: which integrations a cue or blank runs on
export {
  inferHostCompat,
  unknownHostNames,
  formatHostList,
  HOSTS,
  NATIVE_HOSTS,
  type Host,
  type HostCompatInput,
  type HostCompatResult,
} from './host-compat';

