/**
 * opencues-core/discover.ts
 *
 * Folder-based config discovery. Scans cues/, blanks/, auditors/
 * directories for individual CUE.md / BLANK.md / AUDITOR.md files
 * and merges them into CuesMdConfig objects.
 *
 * Pure TypeScript — I/O adapters are injected, no direct filesystem access.
 */

import { CuesMdConfig, BlankConfig, AuditorConfig, parseSingleCueMd, parseSingleAuditorMd } from './cues-md';
import { inferHostCompat } from './host-compat';

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
  /** Current host name (e.g. 'claude-code'). When set, folder packs whose
   *  frontmatter `on-host:` / `not-on-host:` excludes this host are skipped
   *  at scan time so their cues/blanks/auditors never register on this host.
   *  Mirrors chrome's bundle-level `applySiteCompatFilter`. Omit to disable
   *  filtering (legacy callers + unit tests). */
  hostName?: string;
}

export interface DiscoveredConfigs {
  cuesConfig?: CuesMdConfig;
  blanksConfig?: CuesMdConfig;
  auditorsConfig?: CuesMdConfig;
  blankOverrides?: Record<string, BlankConfig>;
  auditorOverrides?: Record<string, AuditorConfig>;
  ignoreWords?: string[];
}

// ============================================================================
// Folder scanning
// ============================================================================

const CUE_FILENAME = 'CUE.md';
const BLANK_FILENAME = 'BLANK.md';
const AUDITOR_FILENAME = 'AUDITOR.md';

/**
 * Scan a directory for cue sources. Folder-only shape:
 *
 *   `<dirPath>/<name>/<filename>` where `<filename>` is `CUE.md` for
 *   cue dirs and `BLANK.md` for blank dirs. Source name = folder name.
 *
 * Returns an array of parsed CuesMdConfig, one per discovered source.
 */
function scanDir(
  dirPath: string,
  opts: DiscoverOptions,
  filename: string = CUE_FILENAME
): CuesMdConfig[] {
  const entries = opts.readDir(dirPath);
  if (!entries) return [];

  const results: CuesMdConfig[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const cuePath = dirPath + '/' + entry.name + '/' + filename;
    const configPath = dirPath + '/' + entry.name;
    const inferredName = entry.name;

    const content = opts.readFile(cuePath);
    if (!content) continue;

    const config = parseSingleCueMd(content, configPath, inferredName);

    // Host-compat filter — skip the whole folder when the current host
    // isn't in the entry's allow-list (on-host) or is in its deny-list
    // (not-on-host). Drops every contained source / blank / tip / auditor
    // before merge so they never reach the cueMap.
    if (opts.hostName && !isAllowedOnHost(config.frontmatter, opts.hostName)) {
      continue;
    }

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
 * Scan auditors/<name>/AUDITOR.md folders. Same folder-only shape as
 * cues/blanks; parsed with parseSingleAuditorMd which puts the auditor
 * under `auditors[<name>]`.
 */
function scanAuditorsDir(dirPath: string, opts: DiscoverOptions): CuesMdConfig[] {
  const entries = opts.readDir(dirPath);
  if (!entries) return [];

  const results: CuesMdConfig[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const filePath = dirPath + '/' + entry.name + '/' + AUDITOR_FILENAME;
    const folderPath = dirPath + '/' + entry.name;
    const inferredName = entry.name;

    const content = opts.readFile(filePath);
    if (!content) continue;

    const config = parseSingleAuditorMd(content, folderPath, inferredName);
    if (opts.hostName && !isAllowedOnHost(config.frontmatter, opts.hostName)) {
      continue;
    }
    if (!config.frontmatter.name) config.frontmatter.name = inferredName;
    results.push(config);
  }
  return results;
}

/**
 * Whether the given host satisfies an entry's frontmatter on-host / not-on-host
 * scoping. Mirrors chrome's site-filter at the file level — non-matching
 * folders are dropped before merge.
 */
function isAllowedOnHost(
  frontmatter: { onHost?: string[]; notOnHost?: string[] },
  hostName: string,
): boolean {
  // No on-host AND no not-on-host → universal, always allowed.
  if (!frontmatter.onHost?.length && !frontmatter.notOnHost?.length) return true;
  const compat = inferHostCompat({
    onHost: frontmatter.onHost,
    notOnHost: frontmatter.notOnHost,
  });
  return (compat.hosts as readonly string[]).includes(hostName);
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

    // Merge auditors
    if (config.auditors) {
      if (!result.auditors) result.auditors = {};
      Object.assign(result.auditors, config.auditors);
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
 * Discover folder-based configs by scanning cues/, blanks/ directories
 * inside `<basePath>` (e.g. `~/.cues/`).
 *
 * Each subdirectory with a CUE.md / BLANK.md is parsed as an individual
 * cue source. Returns discovered configs ready for merging with
 * project-level configs.
 */
export function discoverFolderConfigs(opts: DiscoverOptions): DiscoveredConfigs {
  const result: DiscoveredConfigs = {};
  const allIgnore: string[] = [];

  const cueConfigs = scanDir(opts.basePath + '/cues', opts);
  if (cueConfigs.length > 0) {
    const combined = combineCueConfigs(cueConfigs);
    result.cuesConfig = combined;
    if (combined.ignore) allIgnore.push(...combined.ignore);
  }

  // Scan blanks/ directory. Folder shape uses `BLANK.md` (uppercase per the open standard).
  const blankConfigs = scanDir(opts.basePath + '/blanks', opts, BLANK_FILENAME);
  if (blankConfigs.length > 0) {
    const combined = combineCueConfigs(blankConfigs);
    result.blanksConfig = combined;
    if (combined.ignore) allIgnore.push(...combined.ignore);
  }

  // Scan blanks/ directory for blank overrides (post-rename, the same
  // path scanned above for blanksConfig — folder BLANK.md files with
  // `type: blank` are funnelled into result.blankOverrides here).
  const blankFolderConfigs = scanDir(opts.basePath + '/blanks', opts, BLANK_FILENAME);
  if (blankFolderConfigs.length > 0) {
    const combined = combineCueConfigs(blankFolderConfigs);
    if (combined.blanks) {
      result.blankOverrides = combined.blanks;
    }
    if (combined.ignore) allIgnore.push(...combined.ignore);
  }

  // Scan auditors/<name>/AUDITOR.md.
  const auditorConfigs = scanAuditorsDir(opts.basePath + '/auditors', opts);
  if (auditorConfigs.length > 0) {
    const combined = combineCueConfigs(auditorConfigs);
    result.auditorsConfig = combined;
    if (combined.auditors) result.auditorOverrides = combined.auditors;
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

  // Merge auditors configs
  result.auditorsConfig = mergeOneCuesMdConfig(monolithic.auditorsConfig, folders.auditorsConfig);

  // Merge blank overrides
  if (monolithic.blankOverrides || folders.blankOverrides) {
    result.blankOverrides = {
      ...(monolithic.blankOverrides || {}),
      ...(folders.blankOverrides || {}),
    };
  }

  // Merge auditor overrides — folder layer wins on name collision.
  if (monolithic.auditorOverrides || folders.auditorOverrides) {
    result.auditorOverrides = {
      ...(monolithic.auditorOverrides || {}),
      ...(folders.auditorOverrides || {}),
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

  // Auditors: folder overwrites by key
  if (mono.auditors || folder.auditors) {
    result.auditors = {
      ...(mono.auditors || {}),
      ...(folder.auditors || {}),
    };
  }

  // Ignore: union
  if (mono.ignore || folder.ignore) {
    result.ignore = [...new Set([...(mono.ignore || []), ...(folder.ignore || [])])];
  }

  // disableAuditors: union (concat across layers — every layer's
  // disable list applies; never elided by a higher layer).
  if (mono.disableAuditors || folder.disableAuditors) {
    result.disableAuditors = [...new Set([
      ...(mono.disableAuditors || []),
      ...(folder.disableAuditors || []),
    ])];
  }

  return result;
}
