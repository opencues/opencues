/**
 * opencues-core/discover.ts
 *
 * Folder-based config discovery. Scans cues/, blanks/ directories
 * for individual cue.md files and merges them into CuesMdConfig objects.
 *
 * Pure TypeScript — I/O adapters are injected, no direct filesystem access.
 */

import { CuesMdConfig, BlankConfig, parseSingleCueMd } from './cues-md';

// ============================================================================
// Types
// ============================================================================

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface DiscoverOptions {
  /** Base directory to scan (e.g., process.cwd()) */
  basePath: string;
  /** Read a file's contents. Returns null if file doesn't exist or can't be read. */
  readFile: (path: string) => string | null;
  /** List directory entries. Returns null if directory doesn't exist. */
  readDir: (path: string) => DirEntry[] | null;
}

export interface DiscoveredConfigs {
  cuesConfig?: CuesMdConfig;
  blanksConfig?: CuesMdConfig;
  blankOverrides?: Record<string, BlankConfig>;
  ignoreWords?: string[];
}

// ============================================================================
// Folder scanning
// ============================================================================

const CUE_FILENAME = 'cue.md';

/**
 * Scan a directory for cue sources. Two shapes accepted:
 *
 *   - Flat: `<dirPath>/<name>.md` — source name = filename minus `.md`.
 *   - Folder: `<dirPath>/<name>/cue.md` — source name = folder name.
 *
 * Returns an array of parsed CuesMdConfig, one per discovered source.
 */
function scanDir(
  dirPath: string,
  opts: DiscoverOptions
): CuesMdConfig[] {
  const entries = opts.readDir(dirPath);
  if (!entries) return [];

  const results: CuesMdConfig[] = [];

  for (const entry of entries) {
    let cuePath: string;
    let configPath: string;
    let inferredName: string;

    if (entry.isDirectory) {
      // Folder shape: <dir>/<name>/cue.md
      cuePath = dirPath + '/' + entry.name + '/' + CUE_FILENAME;
      configPath = dirPath + '/' + entry.name;
      inferredName = entry.name;
    } else if (entry.name.endsWith('.md')) {
      // Flat shape: <dir>/<name>.md
      cuePath = dirPath + '/' + entry.name;
      configPath = dirPath;
      inferredName = entry.name.slice(0, -3); // strip .md
    } else {
      continue;
    }

    const content = opts.readFile(cuePath);
    if (!content) continue;

    const config = parseSingleCueMd(content, configPath, inferredName);

    // Default frontmatter.name when not set; rename the source key
    // from 'unknown' if needed (parser uses 'unknown' as the
    // fallback source name when neither frontmatter nor nameOverride
    // are set — but with nameOverride passed above, this is only
    // reached if BOTH are missing, which shouldn't happen).
    if (!config.frontmatter.name) {
      config.frontmatter.name = inferredName;
      if (config.promptConfig?.sources['unknown']) {
        const source = config.promptConfig.sources['unknown'];
        source.name = inferredName;
        config.promptConfig.sources[inferredName] = source;
        delete config.promptConfig.sources['unknown'];
      }
    }

    results.push(config);
  }

  return results;
}

/**
 * Merge multiple single-cue configs into one CuesMdConfig.
 */
function combineCueConfigs(configs: CuesMdConfig[]): CuesMdConfig {
  const result: CuesMdConfig = { frontmatter: {}, sections: {} };

  for (const config of configs) {
    // Merge tips
    if (config.tips) {
      if (!result.tips) result.tips = [];
      result.tips.push(...config.tips);
    }

    // Merge prompt sources
    if (config.promptConfig) {
      if (!result.promptConfig) result.promptConfig = { sources: {} };
      for (const [name, source] of Object.entries(config.promptConfig.sources)) {
        result.promptConfig.sources[name] = source;
      }
    }

    // Merge blanks
    if (config.blanks) {
      if (!result.blanks) result.blanks = {};
      Object.assign(result.blanks, config.blanks);
    }

    // Merge ignore
    if (config.ignore) {
      if (!result.ignore) result.ignore = [];
      result.ignore.push(...config.ignore);
    }
  }

  return result;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Discover folder-based configs by scanning words/, blanks/ directories
 * inside `<basePath>` (e.g. `~/.cues/`).
 *
 * Each .md file (flat) or subdirectory with a cue.md (folder) is parsed
 * as an individual cue source. Returns discovered configs ready for
 * merging with project-level configs.
 *
 * Legacy support: if `<basePath>/cues/` exists (the old subdir name
 * before the words/blanks scope split), it's scanned too. seed-configs
 * migrates this away on the first run.
 */
export function discoverFolderConfigs(opts: DiscoverOptions): DiscoveredConfigs {
  const result: DiscoveredConfigs = {};
  const allIgnore: string[] = [];

  // Scan words/ directory (post-migration name).
  const wordConfigs = scanDir(opts.basePath + '/words', opts);
  // Legacy: scan cues/ directory (pre-migration name) too. Sources
  // discovered there are word-cues (the legacy layout split LLM cues
  // from blanks; `cues/` held both static + LLM word-cues).
  const legacyCueConfigs = scanDir(opts.basePath + '/cues', opts);
  const allWordConfigs = [...wordConfigs, ...legacyCueConfigs];
  if (allWordConfigs.length > 0) {
    const combined = combineCueConfigs(allWordConfigs);
    result.cuesConfig = combined;
    if (combined.ignore) allIgnore.push(...combined.ignore);
  }

  // Scan blanks/ directory.
  const blankConfigs = scanDir(opts.basePath + '/blanks', opts);
  if (blankConfigs.length > 0) {
    const combined = combineCueConfigs(blankConfigs);
    result.blanksConfig = combined;
    if (combined.ignore) allIgnore.push(...combined.ignore);
  }

  // Scan blanks/ directory for blank overrides (post-rename, the same
  // path scanned above for blanksConfig — folder cue.md files with
  // `type: blank` are funnelled into result.blankOverrides here).
  const blankFolderConfigs = scanDir(opts.basePath + '/blanks', opts);
  if (blankFolderConfigs.length > 0) {
    const combined = combineCueConfigs(blankFolderConfigs);
    if (combined.blanks) {
      result.blankOverrides = combined.blanks;
    }
    if (combined.ignore) allIgnore.push(...combined.ignore);
  }

  if (allIgnore.length > 0) {
    result.ignoreWords = allIgnore;
  }

  return result;
}

/**
 * Merge folder-discovered configs into monolithic configs.
 * Folder configs take precedence on name conflicts.
 *
 * - promptConfig.sources: folder entries overwrite monolithic by name
 * - tips: concatenated (folder appended after monolithic)
 * - blanks: folder entries overwrite monolithic by key
 * - ignoreWords: union of both lists
 */
export function mergeConfigs(
  monolithic: DiscoveredConfigs,
  folders: DiscoveredConfigs
): DiscoveredConfigs {
  const result: DiscoveredConfigs = {};

  // Merge cues configs
  result.cuesConfig = mergeOneCuesMdConfig(monolithic.cuesConfig, folders.cuesConfig);

  // Merge blanks configs
  result.blanksConfig = mergeOneCuesMdConfig(monolithic.blanksConfig, folders.blanksConfig);

  // Merge blank overrides
  if (monolithic.blankOverrides || folders.blankOverrides) {
    result.blankOverrides = {
      ...(monolithic.blankOverrides || {}),
      ...(folders.blankOverrides || {}),
    };
  }

  // Merge ignore words (union)
  const ignoreSet = new Set([
    ...(monolithic.ignoreWords || []),
    ...(folders.ignoreWords || []),
  ]);
  if (ignoreSet.size > 0) {
    result.ignoreWords = Array.from(ignoreSet);
  }

  return result;
}

function mergeOneCuesMdConfig(
  mono: CuesMdConfig | undefined,
  folder: CuesMdConfig | undefined
): CuesMdConfig | undefined {
  if (!mono && !folder) return undefined;
  if (!mono) return folder;
  if (!folder) return mono;

  const result: CuesMdConfig = {
    frontmatter: mono.frontmatter,
    sections: { ...mono.sections },
  };

  // Tips: concatenate
  if (mono.tips || folder.tips) {
    result.tips = [...(mono.tips || []), ...(folder.tips || [])];
  }

  // Prompt sources: folder overwrites by name
  if (mono.promptConfig || folder.promptConfig) {
    result.promptConfig = {
      model: folder.promptConfig?.model || mono.promptConfig?.model,
      provider: folder.promptConfig?.provider || mono.promptConfig?.provider,
      sources: {
        ...(mono.promptConfig?.sources || {}),
        ...(folder.promptConfig?.sources || {}),
      },
    };
  }

  // Blanks: folder overwrites by key
  if (mono.blanks || folder.blanks) {
    result.blanks = {
      ...(mono.blanks || {}),
      ...(folder.blanks || {}),
    };
  }

  // Ignore: union
  if (mono.ignore || folder.ignore) {
    result.ignore = [...new Set([...(mono.ignore || []), ...(folder.ignore || [])])];
  }

  return result;
}
