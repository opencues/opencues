/**
 * opencues-core/sources/tips-file.ts
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
/** @deprecated the static word lookup left with spec 0.12 — the shape is kept for the runtime's blank-tip lookup and the dsh bundle */
export interface LocalCueLookupResult {
  word: string;
  cueTip: string;
  alternatives: string[];
  altCueTips?: Record<string, string>;
  speak?: boolean;
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
      });
    }
  }

  return result;
}

/**
 * Options for mergeWordDefs.
 */
export interface MergeWordDefsOptions {
  /**
   * When true, merge alternatives from both existing and new defs (deduplicated).
   * New alts come first, then unique old alts.
   * When false (default), new fills gaps only — existing alts are preserved.
   */
  mergeAlts?: boolean;

  /**
   * When mergeAlts is true, filter old alts that are strict prefixes of the current word.
   * Prevents stale partial-word alts from persisting after the word is completed.
   * The current words array (split text) is needed for this check.
   */
  currentWords?: string[];

  /**
   * Skip merging into existing entries with this source (e.g., 'tips' to protect curated data).
   */
  protectSource?: string;

  /**
   * Skip merging into entries where existing has metadata.blankName but new doesn't.
   * Prevents LLM results from overwriting blank positions.
   */
  protectBlankName?: boolean;
}

/**
 * Merge new word definitions with existing ones.
 * New definitions fill in missing fields; existing non-null fields are preserved.
 *
 * With options.mergeAlts=true, alternatives are combined (new first, then unique old).
 *
 * @param existing - Existing WordDef array (may be empty)
 * @param newDefs - New WordDefs to merge in
 * @param options - Merge options
 * @returns Merged array with all definitions
 */
export function mergeWordDefs(
  existing: WordDef[],
  newDefs: WordDef[],
  options?: MergeWordDefsOptions,
): WordDef[] {
  // Clone existing to avoid mutation
  const result = existing.map((e) => ({ ...e }));

  for (const newDef of newDefs) {
    const existingDef = result.find((e) => e.index === newDef.index);

    if (existingDef) {
      // Skip protected sources (e.g., tips are curated)
      if (options?.protectSource && existingDef.source === options.protectSource) {
        continue;
      }
      // Skip blank-name guard (LLM shouldn't overwrite blank)
      if (options?.protectBlankName &&
          existingDef.metadata?.blankName &&
          !newDef.metadata?.blankName) {
        continue;
      }

      if (options?.mergeAlts && existingDef.alts && newDef.alts) {
        // Merge alts: new first, then unique old (deduplicated)
        const merged = [...newDef.alts];
        for (const oa of existingDef.alts) {
          if (merged.includes(oa)) continue;
          // Filter stale prefix alts
          if (options.currentWords) {
            const cur = options.currentWords[newDef.index];
            if (cur && oa.length < cur.length && cur.startsWith(oa)) continue;
          }
          merged.push(oa);
        }
        existingDef.alts = merged;
        // Preserve currentAltIndex: match current word or keep existing
        if (options.currentWords) {
          const cur = options.currentWords[newDef.index];
          const curIdx = cur ? merged.indexOf(cur) : -1;
          existingDef.currentAltIndex = curIdx >= 0 ? curIdx : (existingDef.currentAltIndex ?? 0);
        }
      } else {
        // Gap-fill: new fills missing fields only
        if (!existingDef.alts && newDef.alts) {
          existingDef.alts = newDef.alts;
        }
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
      if (!existingDef.metadata && newDef.metadata) {
        existingDef.metadata = newDef.metadata;
      }
      if (newDef.speak && !existingDef.speak) {
        existingDef.speak = newDef.speak;
      }
    } else {
      // Add new definition
      const clone = { ...newDef };
      // Set currentAltIndex to match current word if possible
      if (options?.currentWords && clone.alts) {
        const cur = options.currentWords[clone.index];
        const curIdx = cur ? clone.alts.indexOf(cur) : -1;
        clone.currentAltIndex = curIdx >= 0 ? curIdx : 0;
      }
      result.push(clone);
    }
  }

  return result;
}

/**
 * Clean alternatives: strip trailing punctuation and deduplicate.
 * Useful for post-processing LLM-generated alternatives.
 *
 * @param alts - Raw alternatives from LLM
 * @returns Cleaned and deduplicated alternatives
 */
export function cleanAlternatives(alts: string[]): string[] {
  const result: string[] = [];
  for (const a of alts) {
    const clean = a.replace(/[.;:!?]+$/, '').trim();
    if (clean && !result.includes(clean)) result.push(clean);
  }
  return result;
}

/**
 * Convert CueResult[] (from resolver) to WordDef[] (for integration use).
 * Applies alt cleaning (punctuation strip + dedupe) and field mapping.
 *
 * @param results - CueResult array from resolver.resolve()
 * @param options - Conversion options
 * @returns WordDef array ready for merging/cycling
 */
export function convertCueResultsToWordDefs(
  results: CueResult[],
  options?: { minAlts?: number },
): WordDef[] {
  const minAlts = options?.minAlts ?? 2;
  const defs: WordDef[] = [];

  for (const r of results) {
    if (!r.alternatives) continue;
    // Blanks (those with a blankName attribution) are retained
    // regardless of alt count — a single-alt result is the auto-populate
    // value, not a cycle list, and its metadata (blankName, blankStep,
    // blankScript, etc.) is load-bearing downstream.
    const isBlank = !!(r.metadata && (r.metadata as { blankName?: unknown }).blankName);
    if (!isBlank && r.alternatives.length < minAlts) continue;

    const alts = cleanAlternatives(r.alternatives);
    if (alts.length === 0) continue;

    const wdef: WordDef = {
      index: r.wordIndex,
      word: r.word,
      alts,
      currentAltIndex: 0,
      source: (r.source || 'llm') as WordDef['source'],
    };
    if (r.cueTip) wdef.cueTip = r.cueTip;
    if (r.altCueTips) wdef.altCueTips = r.altCueTips;
    if (r.metadata) wdef.metadata = r.metadata;
    defs.push(wdef);
  }

  return defs;
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

