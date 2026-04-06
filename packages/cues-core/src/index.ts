/**
 * cues-core
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
  ClassifiedSourceGroup,
  type ClassifiedSourceGroupConfig,
} from './sources/classified-source-group';

export {
  ControlBlankSource,
  type ControlBlankSourceConfig,
} from './sources/control-blank-source';

export {
  buildSourcesFromConfig,
  type BuildSourcesOptions,
} from './sources/build-sources';

// Response parsers
export {
  parseCompute,
  parseAnswer,
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
  type ControlConfig,
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

