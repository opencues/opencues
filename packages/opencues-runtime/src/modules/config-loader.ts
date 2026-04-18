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
  discoverFolderConfigs,
  mergeConfigs,
  parseLocalCueFile,
  parseCuesMd,
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
/** A single named setting in the nested `settings:` block of opencues.md. */
export interface OpenCuesSettingDef {
  /** Setting-level tip (selector tip in the statusline). */
  readonly tip?: string;
  /** Allowed values for this setting, in declaration order. */
  readonly valueOrder: readonly string[];
  /** Per-value tip (satellite tip in the statusline). */
  readonly valueTips: ReadonlyMap<string, string>;
}

export interface OpenCuesState {
  readonly voiceMode: 'active' | 'inactive';
  readonly debugMode: 'on' | 'off';
  readonly tipsMode: 'on' | 'off';
  readonly cursorNavigate: 'active' | 'inactive';
  /** Raw key→value of every top-level scalar in the frontmatter. */
  readonly settings: ReadonlyMap<string, string>;
  /**
   * Parsed nested `settings:` block — the source of truth for selector/
   * satellite cycling (Step 35). Empty when opencues.md has no settings
   * block. Setting names appear in declaration order so cycling matches
   * the document.
   */
  readonly definitions: ReadonlyMap<string, OpenCuesSettingDef>;
}

const DEFAULT_OPENCUES_STATE: OpenCuesState = {
  voiceMode: 'active',
  debugMode: 'off',
  tipsMode: 'on',
  cursorNavigate: 'inactive',
  settings: new Map(),
  definitions: new Map(),
};

/**
 * Parse opencues.md's frontmatter — top-level scalars (current values)
 * AND the nested `settings:` block (definitions for selector/satellite
 * cycling).
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
    if (line.startsWith(' ') || line.startsWith('\t')) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9_\- ]*?):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const rawValue = m[2].trim();
    if (rawValue === '') continue;
    settings.set(key, rawValue);
  }
  const get = (k: string, def: string): string => settings.get(k) ?? def;
  const voiceMode = get('voice-mode', 'active') === 'inactive' ? 'inactive' : 'active';
  const debugMode = get('debug-mode', 'off') === 'on' ? 'on' : 'off';
  const tipsMode = get('tips-mode', 'on') === 'off' ? 'off' : 'on';
  const cursorNavigate = get('cursor-navigate', 'inactive') === 'active' ? 'active' : 'inactive';
  const definitions = parseSettingsBlock(lines);
  return { voiceMode, debugMode, tipsMode, cursorNavigate, settings, definitions };
}

/**
 * Walk the indented `settings:` block and pull out each setting's tip +
 * declared values. Indent semantics: 2 spaces = setting name, 4 spaces =
 * tip / `values:`, 6 spaces = a value entry. Tolerant of blank lines;
 * stops at the next top-level (zero-indent) key.
 */
function parseSettingsBlock(lines: readonly string[]): Map<string, OpenCuesSettingDef> {
  const out = new Map<string, OpenCuesSettingDef>();
  let inBlock = false;
  let currentSetting: string | null = null;
  let currentTip: string | undefined;
  let currentValueOrder: string[] = [];
  let currentValueTips = new Map<string, string>();
  let inValues = false;

  const commit = (): void => {
    if (currentSetting && (currentValueOrder.length > 0 || currentTip)) {
      out.set(currentSetting, {
        tip: currentTip,
        valueOrder: currentValueOrder,
        valueTips: currentValueTips,
      });
    }
    currentSetting = null;
    currentTip = undefined;
    currentValueOrder = [];
    currentValueTips = new Map();
    inValues = false;
  };

  for (const raw of lines) {
    if (!raw) continue;
    if (!inBlock) {
      if (/^settings:\s*$/.test(raw)) inBlock = true;
      continue;
    }
    // A zero-indent line ends the block.
    if (!raw.startsWith(' ') && !raw.startsWith('\t')) {
      commit();
      break;
    }
    const indent = raw.match(/^(\s*)/)?.[1].length ?? 0;
    const trimmed = raw.trim();
    if (indent === 2 && trimmed.endsWith(':')) {
      // New setting name.
      commit();
      currentSetting = trimmed.slice(0, -1).trim();
      continue;
    }
    if (indent === 4) {
      const m = trimmed.match(/^([A-Za-z][A-Za-z0-9_\- ]*?):\s*(.*)$/);
      if (!m) continue;
      const key = m[1].trim();
      const value = m[2].trim();
      if (key === 'tip') currentTip = value;
      else if (key === 'values') inValues = true;
      continue;
    }
    if (indent === 6 && inValues) {
      const m = trimmed.match(/^([A-Za-z0-9][A-Za-z0-9_\- ]*?):\s*(.*)$/);
      if (!m) continue;
      const valueName = m[1].trim();
      currentValueOrder.push(valueName);
      currentValueTips.set(valueName, m[2].trim());
    }
  }
  commit();
  return out;
}

export interface LoadedConfig {
  readonly cueMap: ReadonlyMap<string, LocalCueLookupResult>;
  readonly opencuesState: OpenCuesState;
  readonly cuesConfig: CuesMdConfig | null;
  readonly controlsConfig: CuesMdConfig | null;
  readonly blanksConfig: CuesMdConfig | null;
  readonly folderConfigs: DiscoveredConfigs | null;
  /** cwd cues.md + folder cues/* merged. The resolver consumes this. */
  readonly mergedCuesConfig: CuesMdConfig | null;
  /** cwd blanks.md + folder blanks/* merged. The resolver consumes this. */
  readonly mergedBlanksConfig: CuesMdConfig | null;
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
    mergedCuesConfig: null,
    mergedBlanksConfig: null,
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
  get mergedCuesConfig(): CuesMdConfig | null { return this._config.mergedCuesConfig; }
  get mergedBlanksConfig(): CuesMdConfig | null { return this._config.mergedBlanksConfig; }
  get navigableWords(): ReadonlySet<string> { return this._config.navigableWords; }
  get controlsByWord(): ReadonlyMap<string, ControlEntry> { return this._config.controlsByWord; }

  /** Unique controls by name (lowercased). Sourced from folderConfigs +
   *  controlsConfig. Useful when a consumer wants to iterate each control
   *  once (BlankFill, etc.) rather than per-word. */
  get controls(): ReadonlyMap<string, ControlConfig> {
    const out = new Map<string, ControlConfig>();
    for (const entry of this._config.controlsByWord.values()) {
      out.set(entry.name, entry.control);
    }
    return out;
  }
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

  /**
   * Phase G.b/I.8 — apply an opencues.md scalar change in-memory before
   * the next file-based hot-reload runs. The selector/satellite cycle
   * spawns `script set <key> <value>` async (writes to disk), but TTS
   * and Statusline read opencuesState immediately on the next render.
   * Without this, TTS would speak using the stale voiceMode for the
   * ~2s gap between cycle + reload.
   */
  applyOpenCuesScalar(key: string, value: string): void {
    const cur = this._config.opencuesState;
    const newSettings = new Map(cur.settings);
    newSettings.set(key, value);
    const get = (k: string, fallback: string): string => newSettings.get(k) ?? fallback;
    const next = {
      voiceMode: (get('voice-mode', 'active') === 'inactive' ? 'inactive' : 'active') as 'inactive' | 'active',
      debugMode: (get('debug-mode', 'off') === 'on' ? 'on' : 'off') as 'on' | 'off',
      tipsMode: (get('tips-mode', 'on') === 'off' ? 'off' : 'on') as 'off' | 'on',
      cursorNavigate: (get('cursor-navigate', 'inactive') === 'active' ? 'active' : 'inactive') as 'active' | 'inactive',
      settings: newSettings as ReadonlyMap<string, string>,
      definitions: cur.definitions,
    };
    this._config = { ...this._config, opencuesState: next };
  }

  /**
   * Case-insensitive lookup. Falls back to controlsByWord when the word
   * isn't a tip-having entry but IS a control or blankKeyword — synthesises
   * a LocalCueLookupResult from the control's `tip` / `blankTip` so the
   * statusline shows e.g. "system volume control" when the user highlights
   * `volume`. The control side wasn't in cueMap because controls.md and
   * folder cue.md don't go through the tips JSON path.
   */
  lookup(word: string): LocalCueLookupResult | null {
    const lc = word.toLowerCase();
    const fromTips = this._config.cueMap.get(lc);
    if (fromTips) return fromTips;
    const ctrl = this._config.controlsByWord.get(lc);
    if (!ctrl) return null;
    const c = ctrl.control as unknown as {
      tip?: string;
      blankTip?: string;
      speak?: boolean;
    };
    const tipText = (typeof c.tip === 'string' && c.tip)
      || (typeof c.blankTip === 'string' && c.blankTip)
      || '';
    if (!tipText) return null;
    return {
      word: lc,
      cueTip: tipText,
      alternatives: [lc],
      source: 'tips',
      ...(typeof c.speak === 'boolean' ? { speak: c.speak } : {}),
    };
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

    // Merged cues/blanks: cwd .md + folder-discovered LLM sources unioned via
    // cues-core's mergeConfigs. Resolver consumes these so it can see prompts
    // from both layers in one CueResolver build.
    const mergedDiscovered = folderConfigs
      ? mergeConfigs(
          { cuesConfig: cuesConfig ?? undefined, blanksConfig: blanksConfig ?? undefined },
          folderConfigs,
        )
      : { cuesConfig: cuesConfig ?? undefined, blanksConfig: blanksConfig ?? undefined };
    const mergedCuesConfig = mergedDiscovered.cuesConfig ?? null;
    const mergedBlanksConfig = mergedDiscovered.blanksConfig ?? null;

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
      mergedCuesConfig,
      mergedBlanksConfig,
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
    // cues-core's discoverFolderConfigs takes sync readFile/readDir callbacks.
    // We pre-walk async (via adapter) and feed it through caches.
    if (!this.adapter.readDir) return null;
    const fileCache = new Map<string, string | null>();
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
          fileCache.set(full, content);
        }
      }
    };

    for (const sub of ['cues', 'controls', 'blanks']) {
      await prewalk(`${cwd}/${sub}`, 0);
    }

    try {
      return discoverFolderConfigs({
        basePath: cwd,
        readFile: (path: string) => fileCache.has(path) ? fileCache.get(path) ?? null : null,
        readDir: (path: string) => dirCache.has(path) ? (dirCache.get(path) ?? null) as CoreDirEntry[] | null : null,
      });
    } catch (err) {
      this.adapter.log('warn', 'ConfigLoader: folder discovery failed', err);
      return null;
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

