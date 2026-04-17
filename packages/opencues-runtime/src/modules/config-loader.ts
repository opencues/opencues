// ConfigLoader — Phase A.
//
// Loads:
//   - tips JSON                           (~/.claude/claude-code-tips.json)
//   - cwd cues.md / controls.md / blanks.md  (frontmatter parsed by cues-core)
//   - cwd opencues.md                    (top-level YAML state — voice-mode, tips-mode, etc.)
//   - cwd cues/* and controls/* folders  (per-folder cue.md via cues-core's discoverFolderConfigs)
//
// Exposes:
//   - cueMap     — primary lookup (tips JSON + folder cues merged)
//   - cuesConfig / controlsConfig / blanksConfig — frontmatter parses
//   - opencuesState — voiceMode, tipsMode, debugMode, cursorNavigate, raw settings
//
// Hot-reload: subscribes onTextChange and re-runs load() if more than the
// debounce window has elapsed since the previous load. Mirrors v1's 2s
// hot-reload cadence.

import type { HostAdapter, Unsubscribe } from '../adapter';
import {
  buildLookupMap,
  parseLocalCueFile,
  parseCuesMd,
  parseSingleCueMd,
  type LocalCueLookupResult,
  type CuesMdConfig,
  type ControlConfig,
  type DiscoveredConfigs,
  type DirEntry as CoreDirEntry,
} from 'cues-core';

/** Pattern that matches words eligible for step-arithmetic cycling. */
export interface StepPattern {
  readonly regex: RegExp;
  readonly control: ControlConfig;
  readonly controlName: string;
}

export interface ConfigLoaderOptions {
  /** Absolute path to the tips JSON. */
  readonly tipsPath: string;
  /** Hot-reload debounce in ms. Defaults to 2000 (matches v1). */
  readonly reloadDebounceMs?: number;
}

/**
 * Parsed top-level state from opencues.md frontmatter.
 *
 * v1 used these as global gates:
 *   - voiceMode='inactive'  → silence TTS
 *   - tipsMode='off'        → hide tips in statusline
 *   - debugMode='on'        → enable extra logging
 *   - cursorNavigate='active' → auto-highlight word under cursor
 */
export interface OpenCuesState {
  readonly voiceMode: 'active' | 'inactive';
  readonly debugMode: 'on' | 'off';
  readonly tipsMode: 'on' | 'off';
  readonly cursorNavigate: 'active' | 'inactive';
  /** Raw key→value of every top-level scalar in the frontmatter. */
  readonly settings: ReadonlyMap<string, string>;
}

const DEFAULT_OPENCUES_STATE: OpenCuesState = {
  voiceMode: 'active',
  debugMode: 'off',
  tipsMode: 'on',
  cursorNavigate: 'inactive',
  settings: new Map(),
};

/**
 * Parse opencues.md's top-level YAML frontmatter into a flat map of scalars.
 * Stops descending when it hits the nested `settings:` block (which is
 * documentation, not state).
 *
 * Exported for unit testing.
 */
export function parseOpenCuesMd(content: string): OpenCuesState {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return DEFAULT_OPENCUES_STATE;
  const lines = fmMatch[1].split('\n');
  const settings = new Map<string, string>();
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    // Stop at indented lines (nested) — we only care about top-level scalars.
    if (line.startsWith(' ') || line.startsWith('\t')) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9_\- ]*?):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const rawValue = m[2].trim();
    // Empty value = nested block on next lines (e.g. `settings:`).
    // Skip — we only collect scalars.
    if (rawValue === '') continue;
    settings.set(key, rawValue);
  }
  const get = (k: string, def: string): string => settings.get(k) ?? def;
  const voiceMode = get('voice-mode', 'active') === 'inactive' ? 'inactive' : 'active';
  const debugMode = get('debug-mode', 'off') === 'on' ? 'on' : 'off';
  const tipsMode = get('tips-mode', 'on') === 'off' ? 'off' : 'on';
  const cursorNavigate = get('cursor-navigate', 'inactive') === 'active' ? 'active' : 'inactive';
  return { voiceMode, debugMode, tipsMode, cursorNavigate, settings };
}

export interface LoadedConfig {
  readonly cueMap: ReadonlyMap<string, LocalCueLookupResult>;
  readonly opencuesState: OpenCuesState;
  readonly cuesConfig: CuesMdConfig | null;
  readonly controlsConfig: CuesMdConfig | null;
  readonly blanksConfig: CuesMdConfig | null;
  readonly folderConfigs: DiscoveredConfigs | null;
  /**
   * All words known to be navigable, lowercased. Union of:
   *   - cueMap keys (tip-having words)
   *   - control names from folder discovery (`controls/X/cue.md` → "X")
   *   - blankKeywords from each control (synonyms that trigger the same control)
   *
   * Navigation's filter uses this. Bigger than cueMap because controls
   * declared in folders aren't necessarily mirrored in the tips JSON.
   */
  readonly navigableWords: ReadonlySet<string>;
  /**
   * Word → control map for fast control lookup during cycling.
   * Includes both the control's own name (lowercased) AND every blankKeywords
   * synonym → same Control entry.
   */
  readonly controlsByWord: ReadonlyMap<string, ControlEntry>;
  /**
   * Step-arithmetic patterns. Words matching any regex here cycle by step.
   * Built per-control from `stepSuffixes` + `step`.
   */
  readonly stepPatterns: readonly StepPattern[];
}

export interface ControlEntry {
  readonly name: string;
  readonly control: ControlConfig;
}

export class ConfigLoader {
  private _config: LoadedConfig = {
    cueMap: new Map(),
    opencuesState: DEFAULT_OPENCUES_STATE,
    cuesConfig: null,
    controlsConfig: null,
    blanksConfig: null,
    folderConfigs: null,
    navigableWords: new Set(),
    controlsByWord: new Map(),
    stepPatterns: [],
  };
  private _loaded = false;
  private _lastLoadAt = 0;
  private _loadInFlight: Promise<void> | null = null;
  private _unsubText: Unsubscribe | null = null;

  constructor(
    private adapter: HostAdapter,
    private options: ConfigLoaderOptions,
  ) {}

  // ─── Read accessors ────────────────────────────────────────────────────

  /** Primary cue map (case-insensitive, `word.toLowerCase()` keys). */
  get cueMap(): ReadonlyMap<string, LocalCueLookupResult> { return this._config.cueMap; }
  get opencuesState(): OpenCuesState { return this._config.opencuesState; }
  get cuesConfig(): CuesMdConfig | null { return this._config.cuesConfig; }
  get controlsConfig(): CuesMdConfig | null { return this._config.controlsConfig; }
  get blanksConfig(): CuesMdConfig | null { return this._config.blanksConfig; }
  get folderConfigs(): DiscoveredConfigs | null { return this._config.folderConfigs; }
  get navigableWords(): ReadonlySet<string> { return this._config.navigableWords; }
  get controlsByWord(): ReadonlyMap<string, ControlEntry> { return this._config.controlsByWord; }
  get stepPatterns(): readonly StepPattern[] { return this._config.stepPatterns; }

  /**
   * Look up a control by a word — checks the control's own name AND
   * blankKeywords synonyms. Returns null if no match.
   */
  lookupControl(word: string): ControlEntry | null {
    return this._config.controlsByWord.get(word.toLowerCase().replace(/[\u200B\u200C]/g, '')) ?? null;
  }

  /**
   * Match a word against any registered step-pattern. Returns the matching
   * pattern + the regex match (so callers can see what the captured numeric
   * portion is) or null.
   */
  matchStepPattern(word: string): { pattern: StepPattern; match: RegExpMatchArray } | null {
    const w = word.replace(/[\u200B\u200C]/g, '');
    for (const p of this._config.stepPatterns) {
      const m = w.match(p.regex);
      if (m) return { pattern: p, match: m };
    }
    return null;
  }
  get loaded(): boolean { return this._loaded; }
  get config(): LoadedConfig { return this._config; }

  /** Case-insensitive lookup. */
  lookup(word: string): LocalCueLookupResult | null {
    return this._config.cueMap.get(word.toLowerCase()) ?? null;
  }

  // ─── Hot-reload subscription ───────────────────────────────────────────

  subscribe(): void {
    this._unsubText = this.adapter.onTextChange(() => {
      void this.maybeReload();
    });
  }

  unsubscribe(): void {
    if (this._unsubText) { this._unsubText(); this._unsubText = null; }
  }

  /** Reload only if debounce window elapsed. */
  async maybeReload(): Promise<void> {
    const debounce = this.options.reloadDebounceMs ?? 2000;
    if (Date.now() - this._lastLoadAt < debounce) return;
    await this.load();
  }

  /**
   * Read everything fresh and rebuild the config. Coalesces concurrent calls.
   */
  async load(): Promise<void> {
    if (this._loadInFlight) return this._loadInFlight;
    this._loadInFlight = this._loadOnce().finally(() => {
      this._loadInFlight = null;
      this._lastLoadAt = Date.now();
      this._loaded = true;
    });
    return this._loadInFlight;
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private async _loadOnce(): Promise<void> {
    const cwd = this.adapter.cwd;

    // Fan out the I/O. None of these depend on each other.
    const [tips, cuesMd, controlsMd, blanksMd, opencuesMd] = await Promise.all([
      this._safeReadFile(this.options.tipsPath),
      this._safeReadFile(`${cwd}/cues.md`),
      this._safeReadFile(`${cwd}/controls.md`),
      this._safeReadFile(`${cwd}/blanks.md`),
      this._safeReadFile(`${cwd}/opencues.md`),
    ]);

    // Tips JSON → primary cueMap.
    const cueMap = new Map<string, LocalCueLookupResult>();
    if (tips !== null) {
      try {
        const data = parseLocalCueFile(tips);
        for (const [k, v] of buildLookupMap(data)) cueMap.set(k, v);
      } catch (err) {
        this.adapter.log('error', 'ConfigLoader: tips JSON parse failed', err);
      }
    }

    // Frontmatter parses.
    const cuesConfig = this._safeParseCuesMd(cuesMd, 'cues.md');
    const controlsConfig = this._safeParseCuesMd(controlsMd, 'controls.md');
    const blanksConfig = this._safeParseCuesMd(blanksMd, 'blanks.md');

    // opencues.md state.
    const opencuesState = opencuesMd !== null ? parseOpenCuesMd(opencuesMd) : DEFAULT_OPENCUES_STATE;

    // Folder discovery for cues/* and controls/*. Async-walk; if readDir is
    // missing, skip gracefully.
    let folderConfigs: DiscoveredConfigs | null = null;
    if (this.adapter.readDir) {
      folderConfigs = await this._discoverFolders(cwd);
    }

    // TODO Phase B+: merge folderConfigs.cuesConfig into cueMap (folder cues
    // become navigable via the same lookup). Not done yet because folder
    // configs use the LLM resolver shape, not the static-tip shape.

    // Build the navigable-words set + controlsByWord map + stepPatterns
    // from cueMap keys, folder controls, and controls.md frontmatter.
    const navigableWords = new Set<string>();
    const controlsByWord = new Map<string, ControlEntry>();
    const stepPatterns: StepPattern[] = [];
    for (const k of cueMap.keys()) navigableWords.add(k);

    const addControl = (name: string, control: ControlConfig): void => {
      const lcName = name.toLowerCase();
      navigableWords.add(lcName);
      controlsByWord.set(lcName, { name: lcName, control });
      // Each blankKeyword maps to the same control entry.
      const bk = control.blankKeywords;
      const synonyms: string[] = [];
      if (typeof bk === 'string') {
        for (const k of (bk as string).split(',')) {
          const t = k.trim().toLowerCase();
          if (t) synonyms.push(t);
        }
      } else if (Array.isArray(bk)) {
        for (const k of bk) {
          const t = String(k).trim().toLowerCase();
          if (t) synonyms.push(t);
        }
      }
      for (const syn of synonyms) {
        navigableWords.add(syn);
        controlsByWord.set(syn, { name: lcName, control });
      }
      // Step-arithmetic pattern: build regex from stepSuffixes.
      if (control.step !== undefined) {
        const suffixes = (control.stepSuffixes && control.stepSuffixes.length > 0)
          ? control.stepSuffixes.map(s => escapeRegex(s)).join('|')
          : '';
        const suffixGroup = suffixes ? `(?:${suffixes})` : '';
        const regex = suffixes
          ? new RegExp(`^(-?\\d+(?:\\.\\d+)?)${suffixGroup}$`, 'i')
          : new RegExp(`^(-?\\d+(?:\\.\\d+)?)$`);
        stepPatterns.push({ regex, control, controlName: lcName });
      }
    };
    for (const [name, ctrl] of Object.entries(folderConfigs?.controlOverrides ?? {})) {
      addControl(name, ctrl as ControlConfig);
    }
    for (const [name, ctrl] of Object.entries(controlsConfig?.controls ?? {})) {
      addControl(name, ctrl as ControlConfig);
    }

    this._config = {
      cueMap,
      opencuesState,
      cuesConfig,
      controlsConfig,
      blanksConfig,
      folderConfigs,
      navigableWords,
      controlsByWord,
      stepPatterns,
    };
    this.adapter.log('info', `ConfigLoader: loaded ${cueMap.size} cue entries, opencuesState=${JSON.stringify({
      voiceMode: opencuesState.voiceMode,
      tipsMode: opencuesState.tipsMode,
      debugMode: opencuesState.debugMode,
    })}`);
  }

  private async _safeReadFile(path: string): Promise<string | null> {
    if (!this.adapter.capabilities.includes('file-read')) return null;
    try { return await this.adapter.readFile(path); } catch (err) {
      this.adapter.log('warn', `ConfigLoader: readFile threw for ${path}`, err);
      return null;
    }
  }

  private _safeParseCuesMd(content: string | null, label: string): CuesMdConfig | null {
    if (content === null) return null;
    try { return parseCuesMd(content); } catch (err) {
      this.adapter.log('warn', `ConfigLoader: ${label} parse failed`, err);
      return null;
    }
  }

  private async _discoverFolders(cwd: string): Promise<DiscoveredConfigs | null> {
    // cues-core's discoverFolderConfigs takes sync read fns. Pre-walk async
    // and feed it via a lookup table.
    if (!this.adapter.readDir) return null;
    const cache = new Map<string, string | null>();
    const dirCache = new Map<string, readonly CoreDirEntry[] | null>();

    const prewalk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 3) return;
      const entries = await this.adapter.readDir!(dir);
      dirCache.set(dir, entries);
      if (!entries) return;
      for (const e of entries) {
        const full = `${dir}/${e.name}`;
        if (e.isDirectory) {
          await prewalk(full, depth + 1);
        } else if (e.name === 'cue.md') {
          const content = await this._safeReadFile(full);
          cache.set(full, content);
        }
      }
    };

    for (const sub of ['cues', 'controls', 'blanks']) {
      await prewalk(`${cwd}/${sub}`, 0);
    }

    // Use cues-core directly with sync wrappers backed by the cache. cues-core's
    // parseSingleCueMd does the per-folder parsing.
    try {
      const folderConfigs = collectFolderConfigs(cwd, cache, dirCache);
      return folderConfigs;
    } catch (err) {
      this.adapter.log('warn', 'ConfigLoader: folder discovery failed', err);
      return null;
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Collect parsed CuesMdConfigs from every cue.md found under cwd/cues|controls|blanks.
 * Sync — assumes the file/dir caches are pre-populated.
 */
function collectFolderConfigs(
  cwd: string,
  fileCache: Map<string, string | null>,
  dirCache: Map<string, readonly CoreDirEntry[] | null>,
): DiscoveredConfigs {
  const cuesConfig: CuesMdConfig | null = null;
  const blanksConfig: CuesMdConfig | null = null;
  const controlOverrides: Record<string, ReturnType<typeof parseSingleCueMd>['controls'] extends infer U ? U extends Record<string, infer V> ? V : never : never> = {};
  const ignoreWords: string[] = [];

  for (const [path, content] of fileCache.entries()) {
    if (content === null || !path.endsWith('/cue.md')) continue;
    const relativeFolder = path.replace(cwd + '/', '').replace(/\/cue\.md$/, '');
    try {
      const parsed = parseSingleCueMd(content, relativeFolder);
      if (parsed.controls) {
        for (const [k, v] of Object.entries(parsed.controls)) controlOverrides[k] = v;
      }
      if (parsed.ignore) ignoreWords.push(...parsed.ignore);
    } catch {
      // Skip unparseable cue.md
    }
  }
  void dirCache; // currently only used for prewalk; kept for future merge logic

  return {
    cuesConfig: cuesConfig ?? undefined,
    blanksConfig: blanksConfig ?? undefined,
    controlOverrides: Object.keys(controlOverrides).length > 0 ? controlOverrides : undefined,
    ignoreWords: ignoreWords.length > 0 ? ignoreWords : undefined,
  };
}
