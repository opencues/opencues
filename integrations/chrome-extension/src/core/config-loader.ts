import {
  parseCuesMd,
  parseSingleCueMd,
  buildLookupMap,
  parseLocalCueFile,
  validateLocalCueData,
  type CuesMdConfig,
} from 'cues-core';
import type { StoredConfig } from '../types';

/** Parsed opencues.md settings */
export interface OpenCuesState {
  /** Setting name → array of values (selector alts) */
  settings: Record<string, string[]>;
  /** Setting name → current value */
  current: Record<string, string>;
  /** Setting name → tip text (selector tip) */
  tips: Record<string, string>;
  /** Setting name → { value → tip text } (satellite tips) */
  satTips: Record<string, Record<string, string>>;
}

export interface ParsedConfig {
  cuesMd: CuesMdConfig;
  blanksMd: CuesMdConfig | null;
  tipsMap: Map<string, any>;
  apiKey: string;
  apiUrl: string;
  model: string;
  openCues: OpenCuesState;
}

/**
 * Parse opencues.md content using a line-by-line walker.
 * MUST NOT use regex for frontmatter — regex escape interactions cause silent failures.
 * Ported from dynamicHighlight.ts lines 169-215.
 */
export function parseOpenCuesMd(content: string): OpenCuesState {
  const settings: Record<string, string[]> = {};
  const current: Record<string, string> = {};
  const tips: Record<string, string> = {};
  const satTips: Record<string, Record<string, string>> = {};

  if (!content) return { settings, current, tips, satTips };

  const lines = content.split(/\r?\n/);
  let inFm = false;
  let inSet = false;
  let curSetKey: string | null = null;
  let inValues = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Toggle frontmatter on --- fence
    if (trimmed === '---') { inFm = !inFm; continue; }
    if (!inFm) continue; // Only parse inside --- markers

    const isIndented = line.length > 0 && (line[0] === ' ' || line[0] === '\t');

    if (trimmed === 'settings:') { inSet = true; curSetKey = null; inValues = false; continue; }
    // Exit settings block on non-indented line
    if (inSet && trimmed && !isIndented) { inSet = false; curSetKey = null; inValues = false; }

    if (inSet && trimmed) {
      const ci = trimmed.indexOf(':');
      if (ci > 0) {
        const sk = trimmed.slice(0, ci).trim();
        const sv = trimmed.slice(ci + 1).trim();

        if (sk === 'tip' && sv && curSetKey) {
          // Selector tip
          tips[curSetKey] = sv;
        } else if (sk === 'values' && curSetKey) {
          // Values sub-block opener
          inValues = true;
        } else if (inValues && curSetKey && sv) {
          // Value entry inside values: block
          if (!settings[curSetKey]) settings[curSetKey] = [];
          settings[curSetKey].push(sk);
          if (!satTips[curSetKey]) satTips[curSetKey] = {};
          satTips[curSetKey][sk] = sv;
        } else if (!sv) {
          // Setting name (key with no value after colon)
          curSetKey = sk;
          inValues = false;
        }
      }
    } else if (trimmed && !isIndented) {
      // Top-level key:value → current values
      const ci = trimmed.indexOf(':');
      if (ci > 0) {
        const ck = trimmed.slice(0, ci).trim();
        const cv = trimmed.slice(ci + 1).trim();
        if (cv && ck !== 'settings') current[ck] = cv;
      }
    }
  }

  return { settings, current, tips, satTips };
}

/**
 * Parse raw config strings into cues-core structures.
 * Called when config is loaded or changes.
 */
export function parseConfig(stored: StoredConfig): ParsedConfig {
  // Parse cues.md content
  let cuesMd: CuesMdConfig;
  try {
    cuesMd = parseCuesMd(stored.cuesMd || '');
  } catch {
    cuesMd = parseCuesMd('');
  }

  // Merge folder-based cue configs (baked in at build time from cues/ directory)
  // Each folder's cue.md adds a source to cuesMd.promptConfig.sources
  try {
    const folders = __DEFAULT_CUE_FOLDERS__;
    if (folders && Object.keys(folders).length > 0) {
      if (!cuesMd.promptConfig) cuesMd.promptConfig = { sources: {} };
      if (!cuesMd.promptConfig.sources) cuesMd.promptConfig.sources = {};
      for (const [name, content] of Object.entries(folders)) {
        // Skip if already defined in main cues.md
        if (cuesMd.promptConfig.sources[name]) continue;
        try {
          const folderCfg = parseSingleCueMd(content);
          if (folderCfg.promptConfig?.sources) {
            // parseSingleCueMd returns the source under the name key
            const srcKey = Object.keys(folderCfg.promptConfig.sources)[0] || name;
            cuesMd.promptConfig.sources[srcKey] = folderCfg.promptConfig.sources[srcKey];
          }
        } catch { /* skip bad folder config */ }
      }
      console.log('[OpenCues] Merged folder sources:', Object.keys(cuesMd.promptConfig.sources));
    }
  } catch (e) {
    console.warn('[OpenCues] Failed to merge folder configs:', e);
  }

  // Merge folder-based control configs (baked in at build time from controls/ directory)
  // Each folder's cue.md adds a control to cuesMd.controls (used for step patterns, etc.)
  try {
    const controlFolders = __DEFAULT_CONTROL_FOLDERS__;
    if (controlFolders && Object.keys(controlFolders).length > 0) {
      if (!cuesMd.controls) cuesMd.controls = {};
      for (const [name, content] of Object.entries(controlFolders)) {
        if (cuesMd.controls[name]) continue; // don't overwrite existing
        try {
          const folderCfg = parseSingleCueMd(content);
          if (folderCfg.controls) {
            const ctrlKey = Object.keys(folderCfg.controls)[0] || name;
            cuesMd.controls[ctrlKey] = folderCfg.controls[ctrlKey];
          }
        } catch { /* skip bad control config */ }
      }
      console.log('[OpenCues] Merged control folders:', Object.keys(cuesMd.controls));
    }
  } catch (e) {
    console.warn('[OpenCues] Failed to merge control configs:', e);
  }

  // Parse blanks.md content
  let blanksMd: CuesMdConfig | null = null;
  try {
    if (stored.blanksMd) {
      blanksMd = parseCuesMd(stored.blanksMd);
    }
  } catch { /* empty on failure */ }

  // Build tips lookup map from cues.md inline tips (## Tips block)
  let tipsMap = new Map<string, any>();
  try {
    // Primary: tips inline in cues.md (the standard approach)
    if (cuesMd?.tips) {
      tipsMap = buildLookupMap(cuesMd.tips);
    }
    // Optional: extra tips from separate JSON (overrides cues.md tips)
    if (stored.tipsJson) {
      const tipsData = parseLocalCueFile(stored.tipsJson);
      const errors = validateLocalCueData(tipsData);
      if (errors.length > 0) {
        console.warn('OpenCues: tips JSON validation warnings:', errors);
      }
      const extraTips = buildLookupMap(tipsData);
      extraTips.forEach((v, k) => tipsMap.set(k, v));
    }
  } catch { /* empty on failure */ }

  // Parse opencues.md content
  const openCues = parseOpenCuesMd(stored.opencuesMd || '');

  return {
    cuesMd,
    blanksMd,
    tipsMap,
    apiKey: stored.apiKey || '',
    apiUrl: stored.apiUrl || 'https://api.groq.com/openai/v1/chat/completions',
    model: stored.model || 'openai/gpt-oss-120b',
    openCues,
  };
}
