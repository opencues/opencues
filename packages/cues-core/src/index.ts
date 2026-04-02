/**
 * cues-core
 *
 * Core cues system - pure TypeScript with no I/O dependencies.
 * Platform-specific functionality is provided via adapters.
 */

// Types
export * from './types';

// Resolver
export { CueResolver, createResolver, type ResolverResult } from './resolver';

// Sources
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

export {
  LLMSourceBase,
  GroqSource,
  GeminiSource,
  type LLMSourceConfig,
  type LLMResponse,
  type LLMWordResponse,
  type LLMMode,
} from './sources/llm-base';

// Prompts
export {
  CLASSIFIER_PROMPT,
  MATH_PROMPT,
  FACTUAL_PROMPT,
  GRAMMAR_PROMPT,
  BLANK_GRAMMAR_PROMPT,
} from './prompts';

// Classifier
export {
  ModeClassifier,
  looksLikeMath,
  looksLikeFactual,
  type CueMode,
  type ClassifierConfig,
  type ClassifierResult,
} from './classifier';

// Math Source
export {
  MathSource,
  evaluateMath,
  type MathSourceConfig,
} from './sources/math-source';

// Factual Source
export {
  FactualSource,
  type FactualSourceConfig,
} from './sources/factual-source';

// Grammar Source
export {
  GrammarSource,
  type GrammarSourceConfig,
} from './sources/grammar-source';
