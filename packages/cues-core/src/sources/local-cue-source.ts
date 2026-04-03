/**
 * cues-core/sources/tips-file.ts
 *
 * Tips file source - loads cues from a JSON tips file.
 * This is a pure TypeScript implementation with no I/O dependencies.
 * The tips data is passed in at construction time.
 */

import {
  CueSource,
  CueContext,
  CueSourceResult,
  CueResult,
  LocalCueData,
  LocalCueSection,
  CueWordEntry,
  CueSynonymGroup,
  WordDef,
  LookupMultipleResult,
} from '../types';

/**
 * Result of looking up a single word in the tips data.
 */
export interface LocalCueLookupResult {
  word: string;
  cueTip: string;
  alternatives: string[];
  altCueTips?: Record<string, string>;
  source: 'tips';
}

/**
 * Look up a word in a synonym group.
 * Returns the group if the word matches any synonym.
 */
function findInGroups(
  word: string,
  groups: CueSynonymGroup[]
): CueSynonymGroup | null {
  const lowerWord = word.toLowerCase();
  for (const group of groups) {
    for (const synonym of group.synonyms) {
      if (synonym.toLowerCase() === lowerWord) {
        return group;
      }
    }
  }
  return null;
}

/**
 * Look up a word in the words map.
 * Returns the entry if found.
 */
function findInWords(
  word: string,
  words: Record<string, CueWordEntry>
): { key: string; entry: CueWordEntry } | null {
  const lowerWord = word.toLowerCase();
  for (const [key, entry] of Object.entries(words)) {
    if (key.toLowerCase() === lowerWord) {
      return { key, entry };
    }
  }
  return null;
}

/**
 * Look up a single word in the tips data.
 * This is a pure function - no I/O.
 *
 * @param word - The word to look up
 * @param data - The tips file data
 * @returns Lookup result or null if word not found
 */
export function lookupWord(word: string, data: LocalCueData): LocalCueLookupResult | null {
  if (!word || !data || !Array.isArray(data)) {
    return null;
  }

  // Search through all sections
  for (const section of data) {
    // Check groups first (new format, takes priority)
    if (section.groups) {
      const group = findInGroups(word, section.groups);
      if (group) {
        // Build alternatives: original word first, then alts (which point to other concepts)
        const alternatives = [word, ...group.alts];

        // Build per-alt tips by looking up each alternative
        const altCueTips: Record<string, string> = {};
        altCueTips[word] = group.tip;

        for (const alt of group.alts) {
          // Look up the alternative in all sections to get its tip
          const altGroup = findInGroupsAcrossSections(alt, data);
          if (altGroup) {
            altCueTips[alt] = altGroup.tip;
          } else {
            const altWord = findInWordsAcrossSections(alt, data);
            if (altWord) {
              altCueTips[alt] = altWord.entry.tip;
            }
          }
        }

        return {
          word,
          cueTip: group.tip,
          alternatives,
          altCueTips,
          source: 'tips',
        };
      }
    }

    // Check words map (old format)
    if (section.words) {
      const found = findInWords(word, section.words);
      if (found) {
        // Build alternatives: original word first, then alts
        const alternatives = [word, ...found.entry.alts];

        // Build per-alt tips
        const altCueTips: Record<string, string> = {};
        altCueTips[word] = found.entry.tip;

        for (const alt of found.entry.alts) {
          // Look up alternative to get its tip
          const altEntry = findInWordsAcrossSections(alt, data);
          if (altEntry) {
            altCueTips[alt] = altEntry.entry.tip;
          } else {
            const altGroup = findInGroupsAcrossSections(alt, data);
            if (altGroup) {
              altCueTips[alt] = altGroup.tip;
            }
          }
        }

        return {
          word,
          cueTip: found.entry.tip,
          alternatives,
          altCueTips,
          source: 'tips',
        };
      }
    }
  }

  return null;
}

/**
 * Find a word in groups across all sections.
 */
function findInGroupsAcrossSections(
  word: string,
  data: LocalCueData
): CueSynonymGroup | null {
  for (const section of data) {
    if (section.groups) {
      const group = findInGroups(word, section.groups);
      if (group) return group;
    }
  }
  return null;
}

/**
 * Find a word in words maps across all sections.
 */
function findInWordsAcrossSections(
  word: string,
  data: LocalCueData
): { key: string; entry: CueWordEntry } | null {
  for (const section of data) {
    if (section.words) {
      const found = findInWords(word, section.words);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Look up multiple words in the tips data.
 *
 * @param words - Array of words to look up
 * @param data - The tips file data
 * @returns Array of results (only for words that were found)
 */
export function lookupWords(
  words: string[],
  data: LocalCueData
): Map<number, LocalCueLookupResult> {
  const results = new Map<number, LocalCueLookupResult>();

  for (let i = 0; i < words.length; i++) {
    const result = lookupWord(words[i], data);
    if (result) {
      results.set(i, result);
    }
  }

  return results;
}

/**
 * Parse tips file content (JSON string) into LocalCueData.
 *
 * @param content - JSON string content of the tips file
 * @returns Parsed tips data
 * @throws Error if content is not valid JSON or not an array
 */
/**
 * Wrapper format for tips file (with metadata).
 */
interface TipsFileWrapper {
  domain?: string;
  version?: number;
  concepts: LocalCueData;
}

/**
 * Parse tips file content (JSON string) into LocalCueData.
 * Supports two formats:
 * 1. Plain array: [{id: "section", words: {...}}, ...]
 * 2. Object with concepts: {domain: "...", concepts: [{id: "section", words: {...}}, ...]}
 *
 * @param content - JSON string content of the tips file
 * @returns Parsed tips data (always returns the array of sections)
 * @throws Error if content is not valid JSON or wrong structure
 */
export function parseLocalCueFile(content: string): LocalCueData {
  const data = JSON.parse(content);

  // Format 1: Plain array
  if (Array.isArray(data)) {
    return data as LocalCueData;
  }

  // Format 2: Object with concepts array
  if (data && typeof data === 'object' && Array.isArray(data.concepts)) {
    return data.concepts as LocalCueData;
  }

  throw new Error('Tips file must be a JSON array or object with "concepts" array');
}

/**
 * Build a hash map for O(1) lookups.
 * Call once at startup, use map.get(word.toLowerCase()) for instant lookups.
 *
 * Uses two-pass approach for O(n) build time:
 * 1. First pass: build map with primary tips only
 * 2. Second pass: resolve altCueTips using the map (O(1) per lookup)
 *
 * @param data - Parsed tips data
 * @returns Map where key = lowercase word, value = lookup result
 */
export function buildLookupMap(data: LocalCueData): Map<string, LocalCueLookupResult> {
  const map = new Map<string, LocalCueLookupResult>();
  const pendingAltTips: Array<{ result: LocalCueLookupResult; alts: string[] }> = [];

  // Pass 1: Build map with primary entries (no altCueTips yet)
  for (const section of data) {
    // Handle groups (synonym groups)
    if (section.groups) {
      for (const group of section.groups) {
        const alternatives = [group.synonyms[0], ...(group.alts || [])];
        const altCueTips: Record<string, string> = {};
        altCueTips[group.synonyms[0]] = group.tip;

        const result: LocalCueLookupResult = {
          word: group.synonyms[0],
          cueTip: group.tip,
          alternatives,
          altCueTips,
          source: 'tips',
        };

        // Map ALL synonyms to this result
        for (const synonym of group.synonyms) {
          map.set(synonym.toLowerCase(), result);
        }

        // Queue altCueTips resolution for pass 2
        if (group.alts && group.alts.length > 0) {
          pendingAltTips.push({ result, alts: group.alts });
        }
      }
    }

    // Handle words map (old format)
    if (section.words) {
      for (const [key, entry] of Object.entries(section.words)) {
        const alternatives = [key, ...(entry.alts || [])];
        const altCueTips: Record<string, string> = {};
        altCueTips[key] = entry.tip;

        const result: LocalCueLookupResult = {
          word: key,
          cueTip: entry.tip,
          alternatives,
          altCueTips,
          source: 'tips',
        };

        map.set(key.toLowerCase(), result);

        // Queue altCueTips resolution for pass 2
        if (entry.alts && entry.alts.length > 0) {
          pendingAltTips.push({ result, alts: entry.alts });
        }
      }
    }
  }

  // Pass 2: Resolve altCueTips using the map (O(1) per lookup)
  for (const { result, alts } of pendingAltTips) {
    for (const alt of alts) {
      const altResult = map.get(alt.toLowerCase());
      if (altResult?.cueTip) {
        result.altCueTips![alt] = altResult.cueTip;
      }
    }
  }

  return map;
}

/**
 * Look up multiple words using a pre-built hash map.
 * Returns found words and indices of missing words (for LLM fallback).
 *
 * @param words - Array of words to look up
 * @param map - Pre-built lookup map from buildLookupMap()
 * @param options - Optional settings
 * @returns Object with found WordDefs and missing indices
 */
export function lookupMultiple(
  words: string[],
  map: Map<string, LocalCueLookupResult>,
  options?: { skipPattern?: RegExp; skipFn?: (word: string) => boolean }
): LookupMultipleResult {
  const found: WordDef[] = [];
  const missingIndices: number[] = [];
  const skipPattern = options?.skipPattern;
  const skipFn = options?.skipFn;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];

    // Skip words matching pattern (e.g., blanks "_")
    if (skipPattern && skipPattern.test(word)) {
      continue;
    }

    // Skip words rejected by custom function (e.g., cue-controls)
    if (skipFn && skipFn(word)) {
      missingIndices.push(i);
      continue;
    }

    const result = map.get(word.toLowerCase());
    if (result) {
      found.push({
        index: i,
        word: word,
        alts: result.alternatives,
        cueTip: result.cueTip,
        altCueTips: result.altCueTips,
        source: 'tips',
        linked: null,
        currentAltIndex: 0,
      });
    } else {
      missingIndices.push(i);
    }
  }

  return { found, missingIndices };
}

/**
 * Format lookup results as a complete WordDef array.
 * Includes all words - found ones have alts, unfound ones have alts: null.
 *
 * @param found - Array of found WordDefs from lookupMultiple()
 * @param allWords - Original array of all words
 * @returns Complete array of WordDefs for all positions
 */
export function formatAsWordDefs(
  found: WordDef[],
  allWords: string[]
): WordDef[] {
  const result: WordDef[] = [];

  for (let i = 0; i < allWords.length; i++) {
    const foundDef = found.find((f) => f.index === i);
    if (foundDef) {
      result.push(foundDef);
    } else {
      result.push({
        index: i,
        word: allWords[i],
        alts: null,
        linked: null,
      });
    }
  }

  return result;
}

/**
 * Merge new word definitions with existing ones.
 * New definitions fill in missing fields; existing non-null fields are preserved.
 *
 * @param existing - Existing WordDef array (may be empty)
 * @param newDefs - New WordDefs to merge in
 * @returns Merged array with all definitions
 */
export function mergeWordDefs(
  existing: WordDef[],
  newDefs: WordDef[]
): WordDef[] {
  // Clone existing to avoid mutation
  const result = existing.map((e) => ({ ...e }));

  for (const newDef of newDefs) {
    const existingDef = result.find((e) => e.index === newDef.index);

    if (existingDef) {
      // Merge: new fills in gaps, doesn't overwrite existing
      if (!existingDef.alts && newDef.alts) {
        existingDef.alts = newDef.alts;
      }
      if (!existingDef.cueTip && newDef.cueTip) {
        existingDef.cueTip = newDef.cueTip;
      }
      if (!existingDef.altCueTips && newDef.altCueTips) {
        existingDef.altCueTips = newDef.altCueTips;
      }
      if (!existingDef.source && newDef.source) {
        existingDef.source = newDef.source;
      }
    } else {
      // Add new definition
      result.push({ ...newDef });
    }
  }

  return result;
}

/**
 * Validate tips data structure.
 *
 * @param data - Data to validate
 * @returns Array of validation errors (empty if valid)
 */
export function validateLocalCueData(data: unknown): string[] {
  const errors: string[] = [];

  if (!Array.isArray(data)) {
    errors.push('Tips data must be an array');
    return errors;
  }

  for (let i = 0; i < data.length; i++) {
    const section = data[i] as LocalCueSection;

    if (!section.id || typeof section.id !== 'string') {
      errors.push(`Section ${i}: missing or invalid 'id'`);
    }

    if (section.words) {
      if (typeof section.words !== 'object') {
        errors.push(`Section ${i}: 'words' must be an object`);
      } else {
        for (const [key, entry] of Object.entries(section.words)) {
          if (!entry.tip || typeof entry.tip !== 'string') {
            errors.push(`Section ${i}, word '${key}': missing or invalid 'tip'`);
          }
          if (!Array.isArray(entry.alts)) {
            errors.push(`Section ${i}, word '${key}': 'alts' must be an array`);
          }
        }
      }
    }

    if (section.groups) {
      if (!Array.isArray(section.groups)) {
        errors.push(`Section ${i}: 'groups' must be an array`);
      } else {
        for (let j = 0; j < section.groups.length; j++) {
          const group = section.groups[j];
          if (!Array.isArray(group.synonyms) || group.synonyms.length === 0) {
            errors.push(`Section ${i}, group ${j}: 'synonyms' must be a non-empty array`);
          }
          if (!group.tip || typeof group.tip !== 'string') {
            errors.push(`Section ${i}, group ${j}: missing or invalid 'tip'`);
          }
          if (!Array.isArray(group.alts)) {
            errors.push(`Section ${i}, group ${j}: 'alts' must be an array`);
          }
        }
      }
    }
  }

  return errors;
}

/**
 * LocalCueSource - implements CueSource for tips file data.
 *
 * This source is initialized with pre-loaded tips data.
 * Loading from file/storage is handled by the platform adapter layer.
 */
export class LocalCueSource implements CueSource {
  readonly id: string;
  readonly priority: number;
  private data: LocalCueData;
  private domain?: string;

  /**
   * Create a new LocalCueSource.
   *
   * @param data - Pre-loaded tips data
   * @param options - Configuration options
   */
  constructor(
    data: LocalCueData,
    options: {
      id?: string;
      priority?: number;
      domain?: string;
    } = {}
  ) {
    this.data = data;
    this.id = options.id || 'tips';
    this.priority = options.priority ?? 100;
    this.domain = options.domain;
  }

  /**
   * Check if this source supports the given context.
   * Tips source always supports (it's a fallback).
   */
  supports(context: CueContext): boolean {
    // If domain is specified, only support matching domains
    if (this.domain && context.domain && this.domain !== context.domain) {
      return false;
    }
    return true;
  }

  /**
   * Get cues for the given context.
   */
  async getCues(context: CueContext): Promise<CueSourceResult> {
    const startTime = Date.now();
    const results: CueResult[] = [];

    try {
      const lookupResults = lookupWords(context.words, this.data);

      for (const [index, lookup] of lookupResults) {
        results.push({
          wordIndex: index,
          word: lookup.word,
          alternatives: lookup.alternatives,
          cueTip: lookup.cueTip,
          altCueTips: lookup.altCueTips,
          source: 'tips',
          priority: this.priority,
        });
      }

      return {
        results,
        timing: Date.now() - startTime,
      };
    } catch (error) {
      return {
        results: [],
        error: error instanceof Error ? error.message : String(error),
        timing: Date.now() - startTime,
      };
    }
  }

  /**
   * Update the tips data (e.g., after file watcher detects change).
   */
  updateData(data: LocalCueData): void {
    this.data = data;
  }

  /**
   * Get current tips data (for debugging/testing).
   */
  getData(): LocalCueData {
    return this.data;
  }
}
