/**
 * cues-core/discover.ts
 *
 * Folder-based config discovery. Scans cues/, blanks/, controls/ directories
 * for individual cue.md files and merges them into CuesMdConfig objects.
 *
 * Pure TypeScript — I/O adapters are injected, no direct filesystem access.
 */

import { CuesMdConfig, ControlConfig, parseSingleCueMd } from './cues-md';

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
  controlOverrides?: Record<string, ControlConfig>;
  ignoreWords?: string[];
}

// ============================================================================
// Folder scanning
// ============================================================================

const CUE_FILENAME = 'cue.md';

/**
 * Scan a directory for subdirectories containing cue.md files.
 * Returns an array of parsed CuesMdConfig, one per discovered cue.md.
 */
function scanDir(
  dirPath: string,
  opts: DiscoverOptions
): CuesMdConfig[] {
  const entries = opts.readDir(dirPath);
  if (!entries) return [];

  const results: CuesMdConfig[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory) continue;

    const cuePath = dirPath + '/' + entry.name + '/' + CUE_FILENAME;
    const content = opts.readFile(cuePath);
    if (!content) continue;

    const folderPath = dirPath + '/' + entry.name;
    const config = parseSingleCueMd(content, folderPath);

    // Default the name to the folder name if not set in frontmatter
    if (!config.frontmatter.name) {
      config.frontmatter.name = entry.name;
      // Also update the source name if it was 'unknown'
      if (config.promptConfig?.sources['unknown']) {
        const source = config.promptConfig.sources['unknown'];
        source.name = entry.name;
        config.promptConfig.sources[entry.name] = source;
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

    // Merge controls
    if (config.controls) {
      if (!result.controls) result.controls = {};
      Object.assign(result.controls, config.controls);
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
 * Discover folder-based configs by scanning cues/, blanks/, controls/ directories.
 *
 * Each subdirectory containing a cue.md file is parsed as an individual cue.
 * Returns discovered configs ready for merging with monolithic file configs.
 */
export function discoverFolderConfigs(opts: DiscoverOptions): DiscoveredConfigs {
  const result: DiscoveredConfigs = {};
  const allIgnore: string[] = [];

  // Scan cues/ directory
  const cueConfigs = scanDir(opts.basePath + '/cues', opts);
  if (cueConfigs.length > 0) {
    const combined = combineCueConfigs(cueConfigs);
    result.cuesConfig = combined;
    if (combined.ignore) allIgnore.push(...combined.ignore);
  }

  // Scan blanks/ directory
  const blankConfigs = scanDir(opts.basePath + '/blanks', opts);
  if (blankConfigs.length > 0) {
    const combined = combineCueConfigs(blankConfigs);
    result.blanksConfig = combined;
    if (combined.ignore) allIgnore.push(...combined.ignore);
  }

  // Scan controls/ directory
  const controlConfigs = scanDir(opts.basePath + '/controls', opts);
  if (controlConfigs.length > 0) {
    const combined = combineCueConfigs(controlConfigs);
    if (combined.controls) {
      result.controlOverrides = combined.controls;
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
 * - controls: folder entries overwrite monolithic by key
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

  // Merge control overrides
  if (monolithic.controlOverrides || folders.controlOverrides) {
    result.controlOverrides = {
      ...(monolithic.controlOverrides || {}),
      ...(folders.controlOverrides || {}),
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

  // Controls: folder overwrites by key
  if (mono.controls || folder.controls) {
    result.controls = {
      ...(mono.controls || {}),
      ...(folder.controls || {}),
    };
  }

  // Ignore: union
  if (mono.ignore || folder.ignore) {
    result.ignore = [...new Set([...(mono.ignore || []), ...(folder.ignore || [])])];
  }

  return result;
}
