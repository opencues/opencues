// ConfigLoader — reads CUES.md/BLANKS.md + folder-based cue/blank dirs.
//
// Loads (across $OPENCUES_HOME → <cwd>/.cues → ~/.cues):
//   - CUES.md / BLANKS.md  (frontmatter parsed by @opencues/core).
//     Tips live inside CUES.md's `## Tips` JSON block — there is no
//     separate tips.json file any more.
//   - ~/.cues/OPENCUES.md (user-level only — system settings owned
//     by the runtime; project-level overrides are intentionally not
//     read because settings apply across every integration)
//   - cues/<name>/ and blanks/<name>/ folders (per-folder CUE.md / BLANK.md via
//     @opencues/core's discoverFolderConfigs)
//
// Exposes:
//   - cueMap     — primary lookup, built from CUES.md ## Tips (project
//                  wins on word conflicts via mergeConfigs)
//   - cuesConfig / blanksConfig — frontmatter parses
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
  parseCuesMd,
  parseCuesMaster,
  parseBlanksMaster,
  parseAuditorsMaster,
  parseSentinelsMd,
  getMenuDefinitions,
  type LocalCueLookupResult,
  type CuesMdConfig,
  type BlankConfig,
  type DiscoveredConfigs,
  type DirEntry as CoreDirEntry,
} from '@opencues/core';

export interface ConfigLoaderOptions {
  /** Hot-reload debounce in ms. Defaults to 2000 (matches v1). */
  readonly reloadDebounceMs?: number;
  /**
   * Background-poll interval in ms. The poll calls `maybeReload`
   * (gated by `reloadDebounceMs`), so OPENCUES.md edits propagate
   * even when the user isn't typing in the host. Default 5000.
   * Set to 0 / negative to disable (keystroke-only mode — pre-June-2026
   * behaviour, useful for tests that don't want a background timer).
   */
  readonly backgroundPollMs?: number;
  /**
   * Directories searched for `words/*` and `blanks/*` folders, in
   * priority order. Earlier entries win on name conflicts.
   *
   * Convention (host-agnostic, mirrors `.editorconfig` / `.npmrc`):
   *   - project-level: `<cwd>/.cues`
   *   - user-level:    `~/.cues`
   *
   * When unset, falls back to `[adapter.cwd]` for backwards compat.
   *
   * Missing directories are silently skipped — a user with no
   * `~/.cues` and no `.cues` in their cwd just gets bake-time
   * defaults (chrome) or empty config (CC/OC) and the runtime degrades
   * gracefully.
   */
  readonly configSearchPaths?: readonly string[];
  /**
   * Path to the user-level runtime config file (`OPENCUES.md`,
   * formerly `.opencuesrc`). Read once on load; parsed by
   * `parseOpenCuesMd` for top-level scalars + the nested `settings:`
   * block. When unset, opencuesState is the runtime defaults.
   */
  readonly settingsFile?: string;
}

/**
 * Parsed top-level state from OPENCUES.md frontmatter.
 *
 * v1 used these as global gates:
 *   - voiceMode='inactive'  → silence TTS
 *   - tipsMode='off'        → hide tips in statusline
 *   - debugMode='on'        → enable extra logging
 *   - cursorNavigate='active' → auto-highlight word under cursor
 */
/** A single named setting in the nested `settings:` block of OPENCUES.md. */
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
  /**
   * Whether the host adapter is permitted to share AmbientContext —
   * the field's label/placeholder/aria/title/page-url — with
   * FluidBlankSource for lookup disambiguation. OFF BY DEFAULT.
   *
   * Off: HostAdapter.getAmbientContext() returns null. The core never
   * sees the ambient block; nothing about the surrounding page leaves
   * the host.
   *
   * On: ambient metadata for the focused field is sanitized and
   * forwarded to the fluid-blank prompt (only — no other source
   * receives it). Sensitive fields (password / CC / OTP) still get
   * null even when on.
   *
   * See docs/architecture/ambient-context.md for the threat model.
   */
  readonly ambientContextMode: 'on' | 'off';
  /**
   * Whether `~/.cues/SENTINELS.md` field data (first name, email, etc.) is
   * forwarded to FluidBlankSource as sentinel tokens for prompt
   * personalization.
   *
   * - `off` (default): SENTINELS.md is not read. CueContext.sentinels stays
   *   undefined. No personal data reaches any prompt.
   * - `safe`: catalog of TOKENs + descriptions injected into the
   *   prompt. LLM emits tokens; a post-processor substitutes real
   *   values AFTER the response. PII never reaches the LLM provider.
   * - `raw`: catalog includes actual VALUES inline. PII reaches the
   *   provider. Use only when register/tone fidelity matters more
   *   than provider-log privacy.
   *
   * See docs/architecture/sentinels.md (when added) for the threat
   * model. Phase 1 wires only fluid-blank; other pipelines stay
   * sentinel-free.
   */
  readonly sentinelsMode: 'off' | 'safe' | 'raw';
  /**
   * Controls when `_` fires its blank.
   *
   * - `immediate` (default): blank fires the instant `_` is inserted.
   *   Current behaviour since OpenCues v0.1.
   * - `spaced`: blank fires only when the trigger ends with `_` + space.
   *   Lets users type markdown italic (`_italic_`) without the first
   *   `_` immediately substituting. Costs one extra keystroke (the
   *   space) for users who DO want to trigger a blank.
   */
  readonly blankTriggerMode: 'immediate' | 'spaced';
  /**
   * Modifier combo used for word navigation (Left/Right) and
   * alternative cycling (Up/Down).
   *
   * - `auto` (default): `ctrl-alt` on every host. macOS Terminal.app
   *   used to be a `ctrl-shift` exception, but `cat -v` testing (June
   *   2026) showed Ctrl+Option+arrow survives Terminal.app as Meta-
   *   prefixed CSI with Option-as-Meta on; *Ctrl+Shift+arrow* is the
   *   combo Terminal.app actually strips. Adapters coalesce option/
   *   meta into `alt`, so the default works there too.
   * - `ctrl-alt`: classic Ctrl+Alt+arrow / Ctrl+Option+arrow. Default
   *   on every terminal host.
   * - `ctrl-shift`: Ctrl+Shift+arrow. Available as a manual override
   *   for users on terminals that forward it but not Ctrl+Alt — chrome
   *   hard-pins to ctrl-alt regardless of the scalar (ctrl-shift+arrow
   *   extends browser text selection — hijacking it would steal a
   *   primary shortcut).
   *
   * Hot-reloads. The handlers gate per-keystroke on the resolved
   * combo so no restart is needed after editing OPENCUES.md.
   */
  readonly navKeymap: 'auto' | 'ctrl-alt' | 'ctrl-shift';
  /**
   * Per-bucket LLM provider overrides — the three-bucket simplification.
   * Each bucket carves the LLM surface into one of three trust classes:
   *
   *   - `cuesLlmProvider`     — word-cues, sentence-cues (prose-bearing)
   *   - `auditorsLlmProvider` — auditors, agent-rewrite (prose-bearing)
   *   - `blanksLlmProvider`   — fluid-blank, transform-blank, fluid-config,
   *                             keyword blanks (user-opt-in `_` surface)
   *
   * Each defaults to `'inherit'` — falls through to the global
   * `llm-provider` scalar at the resolver. Concrete provider ids
   * (`cerebras`, `groq`, …) override per bucket. Only `blanksLlmProvider`
   * accepts `opencode-zen` (the free pool with `trainsOnInput: true`);
   * the prose buckets get refused at source-build time via the existing
   * trainsOnInput guard in build-sources.ts.
   *
   * Per-aspect overrides (`word-cues-provider`, `fluid-blank-provider`,
   * `auditor-provider`, etc.) remain in OPENCUES.md as file-edit-only
   * advanced overrides — they still win over the bucket scalars, which
   * win over the global `llm-provider`. Keeping per-aspect off the menu
   * is the point of the three-bucket simplification.
   *
   * Stored as raw scalar strings (not typed unions) because the set of
   * valid provider ids is owned by `@opencues/core`'s ProviderId union —
   * pinning the union here would force config-loader to import core and
   * create a circular structural dependency.
   */
  readonly cuesLlmProvider: string;
  readonly auditorsLlmProvider: string;
  readonly blanksLlmProvider: string;
  /** Raw key→value of every top-level scalar in the frontmatter. */
  readonly settings: ReadonlyMap<string, string>;
  /**
   * Parsed nested `settings:` block — the source of truth for selector/
   * satellite cycling. Empty when OPENCUES.md has no settings
   * block. Setting names appear in declaration order so cycling matches
   * the document.
   */
  readonly definitions: ReadonlyMap<string, OpenCuesSettingDef>;
}

// Exported so the feature-registry-alignment test can reflect on its
// field names — the test pins OpenCuesState keys against the FEATURES
// registry to catch drift. Don't import this constant from runtime
// modules; use ConfigLoader.opencuesState instead.
export const DEFAULT_OPENCUES_STATE: OpenCuesState = {
  voiceMode: 'active',
  debugMode: 'off',
  tipsMode: 'on',
  cursorNavigate: 'inactive',
  ambientContextMode: 'off',
  sentinelsMode: 'off',
  blankTriggerMode: 'immediate',
  navKeymap: 'auto',
  cuesLlmProvider: 'inherit',
  auditorsLlmProvider: 'inherit',
  blanksLlmProvider: 'inherit',
  settings: new Map(),
  definitions: new Map(),
};

/**
 * Allow-list of provider ids accepted by the bucket scalars
 * (`cues-llm-provider`, `auditors-llm-provider`, `blanks-llm-provider`).
 * `inherit` falls through to the global `llm-provider` at the resolver;
 * concrete ids match `@opencues/core`'s ProviderId union.
 *
 * Unknown values get rewritten to `inherit` — silently picking an
 * invalid provider would disable every source in the bucket without
 * a diagnostic; falling back keeps the user in a working state and
 * surfaces the typo only through `opencues doctor`.
 */
const VALID_BUCKET_PROVIDERS = new Set([
  'inherit',
  'groq', 'openrouter', 'gemini', 'openai', 'openai-subscription',
  'anthropic', 'cerebras', 'claude-cli', 'opencode-zen',
]);

function bucketProvider(raw: string): string {
  return VALID_BUCKET_PROVIDERS.has(raw) ? raw : 'inherit';
}

/**
 * Parse the runtime config file. Format: markdown with YAML frontmatter
 * between `---` ... `---` fences. Body is documentation.
 *
 * Exported for unit testing.
 */
export function parseOpenCuesMd(content: string): OpenCuesState {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch || !fmMatch[1].trim()) return DEFAULT_OPENCUES_STATE;
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
  const ambientContextMode = get('ambient-context-mode', 'off') === 'on' ? 'on' : 'off';
  // Sentinel-mode scalar — current name is `sentinels-mode`; back-compat
  // fallback to legacy `user-context-mode` (renamed May 2026). seed-configs
  // self-heal rewrites legacy → new in OPENCUES.md on next `opencues
  // install` so the fallback fades within a release cycle.
  const sentinelsRaw = get('sentinels-mode', get('user-context-mode', 'off')).toLowerCase();
  const sentinelsMode: 'off' | 'safe' | 'raw' =
    sentinelsRaw === 'safe' ? 'safe'
    : sentinelsRaw === 'raw' ? 'raw'
    : 'off';
  const blankTriggerMode: 'immediate' | 'spaced' =
    get('blank-trigger-mode', 'immediate').toLowerCase() === 'spaced' ? 'spaced' : 'immediate';
  const navKeymapRaw = get('nav-keymap', 'auto').toLowerCase();
  const navKeymap: 'auto' | 'ctrl-alt' | 'ctrl-shift' =
    navKeymapRaw === 'ctrl-alt' ? 'ctrl-alt'
    : navKeymapRaw === 'ctrl-shift' ? 'ctrl-shift'
    : 'auto';
  // Bucket scalars — `inherit` (default) or any concrete provider id.
  // Unknown values fall back to `inherit` rather than silently picking
  // an invalid provider — protects users from typos that would
  // otherwise silently disable all sources in that bucket. The
  // opencode-zen free pool is opt-in via `blanks-llm-provider:
  // opencode-zen` + `blanks-llm-model: free`; the trainsOnInput guard
  // in build-sources.ts refuses prose buckets (cues/auditors) routed
  // to opencode-zen regardless of how the scalar got there.
  //
  // Back-compat (one release cycle): the legacy `blank-llm-provider`
  // (singular) is read if `blanks-llm-provider` is absent. The
  // seed-configs self-heal rewrites legacy → new in OPENCUES.md so
  // this fallback fades naturally as users run `opencues install`.
  const cuesLlmProvider = bucketProvider(get('cues-llm-provider', 'inherit').toLowerCase());
  const auditorsLlmProvider = bucketProvider(get('auditors-llm-provider', 'inherit').toLowerCase());
  const blanksLlmProviderRaw = settings.has('blanks-llm-provider')
    ? get('blanks-llm-provider', 'inherit')
    : get('blank-llm-provider', 'inherit'); // legacy fallback
  const blanksLlmProvider = bucketProvider(blanksLlmProviderRaw.toLowerCase());
  // Menu definitions: registry-derived by default, with optional
  // file-level overrides. The @opencues/core FEATURES + MENU_TUNABLES
  // registry is the single source of truth; defaults/OPENCUES.md ships
  // EMPTY (no `settings:` block) and the registry provides every
  // cyclable setting. Advanced users who want different tips or value
  // order can ship their own `settings:` block in ~/.cues/OPENCUES.md
  // and the parser merges it on top — file entries WIN per scalar
  // (whole-setting replacement, not field-level merge).
  //
  // Tests keep shipping mock `settings:` blocks; they get the
  // file-driven definitions, identical to the pre-refactor behaviour.
  const definitions = mergeDefinitions(getMenuDefinitions(), parseSettingsBlock(lines));
  return { voiceMode, debugMode, tipsMode, cursorNavigate, ambientContextMode, sentinelsMode, blankTriggerMode, navKeymap, cuesLlmProvider, auditorsLlmProvider, blanksLlmProvider, settings, definitions };
}

/**
 * Pick file-parsed `settings:` definitions OR registry defaults.
 * All-or-nothing semantics: if the file ships ANY settings block,
 * that block is authoritative (full menu replacement, registry
 * ignored). Empty/missing block → registry default.
 *
 * Rationale: the registry covers the shipping default set; users
 * who want a custom menu (different order, different tips, hidden
 * settings) ship their own complete block and get full control.
 * A per-scalar merge would surprise users with registry-default
 * settings appearing they hadn't asked for.
 */
function mergeDefinitions(
  registryDefs: Map<string, OpenCuesSettingDef>,
  fileDefs: Map<string, OpenCuesSettingDef>,
): Map<string, OpenCuesSettingDef> {
  return fileDefs.size > 0 ? fileDefs : registryDefs;
}

/**
 * Walk the indented `settings:` block and pull out each setting's tip +
 * declared values. Indent semantics: 2 spaces = setting name, 4 spaces =
 * tip / `values:`, 6 spaces = a value entry. Tolerant of blank lines;
 * stops at the next top-level (zero-indent) key.
 *
 * Registry-first since the May 2026 simplification: this parser is
 * now used only as an OVERLAY on top of `getMenuDefinitions()`. New
 * default-shipped OPENCUES.md files have no `settings:` block at all
 * and the registry provides every cyclable setting. Existing users
 * who kept their old file get a per-scalar override behaviour (file
 * wins) — see `mergeDefinitions` above.
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
    if (!raw.startsWith(' ') && !raw.startsWith('\t')) {
      commit();
      break;
    }
    const indent = raw.match(/^(\s*)/)?.[1].length ?? 0;
    const trimmed = raw.trim();
    if (indent === 2 && trimmed.endsWith(':')) {
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
      const m = trimmed.match(/^"?([A-Za-z0-9][A-Za-z0-9_\- ]*?)"?:\s*(.*)$/);
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
  readonly blanksConfig: CuesMdConfig | null;
  readonly folderConfigs: DiscoveredConfigs | null;
  /** cwd CUES.md + folder cues/* merged. The resolver consumes this. */
  readonly mergedCuesConfig: CuesMdConfig | null;
  /** cwd BLANKS.md + folder blanks/* merged. The resolver consumes this. */
  readonly mergedBlanksConfig: CuesMdConfig | null;
  /**
   * Parsed sentinels from `<settingsFile-dir>/SENTINELS.md`. Always
   * populated (parser returns an empty Sentinels when the file is
   * missing or has no frontmatter). The resolver consults
   * `opencuesState.sentinelsMode` to decide whether to pass this
   * through to FluidBlankSource — when mode is `off` the data still
   * lives here but never reaches any prompt.
   *
   * Mirror of @opencues/core's Sentinels shape, kept structural to
   * avoid an import cycle.
   */
  readonly sentinels: {
    readonly fields: readonly { readonly key: string; readonly token: string; readonly value: string; readonly description: string }[];
    readonly catalog: ReadonlyMap<string, string>;
  };
  /**
   * All words known to be navigable, lowercased. Union of:
   *   - cueMap keys (tip-having words)
   *   - blank names from folder discovery (`blanks/X/BLANK.md` → "X")
   *   - blankKeywords from each blank (synonyms that trigger the same blank)
   *
   * Navigation's filter uses this. Bigger than cueMap because blanks
   * declared in folders aren't necessarily mirrored in the tips JSON.
   */
  readonly navigableWords: ReadonlySet<string>;
  /**
   * Word → blank map for fast blank lookup during cycling.
   * Includes both the blank's own name (lowercased) AND every blankKeywords
   * synonym → same BlankEntry.
   */
  readonly blanksByWord: ReadonlyMap<string, BlankEntry>;
}

export interface BlankEntry {
  readonly name: string;
  readonly blank: BlankConfig;
}

export class ConfigLoader {
  private _config: LoadedConfig = {
    cueMap: new Map(),
    opencuesState: DEFAULT_OPENCUES_STATE,
    cuesConfig: null,
    blanksConfig: null,
    folderConfigs: null,
    mergedCuesConfig: null,
    mergedBlanksConfig: null,
    navigableWords: new Set(),
    blanksByWord: new Map(),
    sentinels: { fields: [], catalog: new Map() },
  };
  private _loaded = false;
  private _lastLoadAt = 0;
  private _loadInFlight: Promise<void> | null = null;
  private _unsubText: Unsubscribe | null = null;
  // Background-poll handle. Created in `subscribe()` if setInterval
  // exists and `backgroundPollMs > 0`. `ReturnType<typeof setInterval>`
  // is `Timeout` in Node and `number` in browser — typing both as
  // `unknown` keeps the union out of the field's type without losing
  // the not-null discriminator.
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  // Race guard: when applyOpenCuesScalar fires (cycling a satellite
  // updates an OPENCUES.md scalar in-memory), the host's blankInvoke
  // also kicks off an ASYNC file write. Cycling.ts then calls setText
  // which fires onTextChange → maybeReload, and if maybeReload reads
  // the file BEFORE the async write lands, the in-memory update is
  // overwritten by the stale file content. _suppressReloadUntil delays
  // the next reload long enough for the write to settle.
  private _suppressReloadUntil = 0;

  constructor(
    private adapter: HostAdapter,
    private options: ConfigLoaderOptions = {},
  ) {}

  // ─── Read accessors ────────────────────────────────────────────────────

  /** Primary cue map (case-insensitive, `word.toLowerCase()` keys). */
  get cueMap(): ReadonlyMap<string, LocalCueLookupResult> { return this._config.cueMap; }
  get opencuesState(): OpenCuesState { return this._config.opencuesState; }
  get cuesConfig(): CuesMdConfig | null { return this._config.cuesConfig; }
  get blanksConfig(): CuesMdConfig | null { return this._config.blanksConfig; }
  get folderConfigs(): DiscoveredConfigs | null { return this._config.folderConfigs; }
  get mergedCuesConfig(): CuesMdConfig | null { return this._config.mergedCuesConfig; }
  get mergedBlanksConfig(): CuesMdConfig | null { return this._config.mergedBlanksConfig; }
  get navigableWords(): ReadonlySet<string> { return this._config.navigableWords; }
  get blanksByWord(): ReadonlyMap<string, BlankEntry> { return this._config.blanksByWord; }
  /** Parsed `~/.cues/SENTINELS.md`. Always populated; the runtime gate on
   *  `opencuesState.sentinelsMode` decides whether it ever leaves
   *  the ConfigLoader. See `LoadedConfig.sentinels`. */
  get sentinels(): LoadedConfig['sentinels'] { return this._config.sentinels; }

  /** Unique blanks by name (lowercased).
   *  Sourced from folderConfigs + blanksConfig. Useful when a consumer
   *  wants to iterate each blank once (BlankFill, etc.) rather than
   *  per-word. */
  get blanks(): ReadonlyMap<string, BlankConfig> {
    const out = new Map<string, BlankConfig>();
    for (const entry of this._config.blanksByWord.values()) {
      out.set(entry.name, entry.blank);
    }
    return out;
  }

  /**
   * Compose enabled auditor prompts in priority-descending order.
   *
   * Sorts by `priority:` descending, alphabetical-by-name for ties.
   * Skips `enabled: false` and any name in the merged disableAuditors
   * list (the union of every layer's `AUDITORS.md` `disable: [...]`).
   *
   * Returned entries carry their `priority:` so the caller (AgentRewrite)
   * can run isolated mode — one LLM call per auditor, results diff-merged
   * by priority. See spec/auditor-spec.md § Composition. Priority defaults
   * to 50 when the AUDITOR.md frontmatter omits the field.
   */
  composeAuditorPrompts(): Array<{ name: string; promptText: string; priority: number }> {
    const folder = this._config.folderConfigs;
    const auditors = folder?.auditorOverrides ?? {};
    const disableSet = new Set(folder?.auditorsConfig?.disableAuditors ?? []);
    const entries = Object.entries(auditors).filter(([name, a]) => {
      if (a.enabled === false) return false;
      if (disableSet.has(name)) return false;
      return true;
    });
    entries.sort(([nameA, a], [nameB, b]) => {
      const pa = a.priority ?? 50;
      const pb = b.priority ?? 50;
      if (pa !== pb) return pb - pa; // desc
      return nameA.localeCompare(nameB);
    });
    return entries.map(([name, a]) => ({
      name,
      promptText: a.promptText,
      priority: a.priority ?? 50,
    }));
  }

  /**
   * Look up a blank by a word — checks the blank's own name AND
   * blankKeywords synonyms. Returns null if no match.
   */
  lookupBlank(word: string): BlankEntry | null {
    return this._config.blanksByWord.get(word.toLowerCase().replace(/[\u200B\u200C]/g, '')) ?? null;
  }

  get loaded(): boolean { return this._loaded; }
  get config(): LoadedConfig { return this._config; }

  /**
   * Apply an OPENCUES.md scalar change in-memory before
   * the next file-based hot-reload runs. The selector/satellite cycle
   * spawns `script set <key> <value>` async (writes to disk), but TTS
   * and Statusline read opencuesState immediately on the next render.
   * Without this, TTS would speak using the stale voiceMode for the
   * ~2s gap between cycle + reload.
   */
  applyOpenCuesScalar(key: string, value: string): void {
    // Suppress the next ~2.5s of reloads. The cycling path that called
    // us is about to call setText → onTextChange → maybeReload, and
    // the in-flight blankInvoke set hasn't landed yet. Without this
    // guard the reload reads stale file content and reverts our
    // in-memory update (visible as "voice-mode flips back to active
    // immediately").
    this._suppressReloadUntil = Date.now() + 2500;
    const cur = this._config.opencuesState;
    const newSettings = new Map(cur.settings);
    newSettings.set(key, value);
    const get = (k: string, fallback: string): string => newSettings.get(k) ?? fallback;
    const next = {
      voiceMode: (get('voice-mode', 'active') === 'inactive' ? 'inactive' : 'active') as 'inactive' | 'active',
      debugMode: (get('debug-mode', 'off') === 'on' ? 'on' : 'off') as 'on' | 'off',
      tipsMode: (get('tips-mode', 'on') === 'off' ? 'off' : 'on') as 'off' | 'on',
      cursorNavigate: (get('cursor-navigate', 'inactive') === 'active' ? 'active' : 'inactive') as 'active' | 'inactive',
      ambientContextMode: (get('ambient-context-mode', 'off') === 'on' ? 'on' : 'off') as 'on' | 'off',
      sentinelsMode: ((): 'off' | 'safe' | 'raw' => {
        // Back-compat: fall through to legacy `user-context-mode` key.
        const v = get('sentinels-mode', get('user-context-mode', 'off')).toLowerCase();
        return v === 'safe' ? 'safe' : v === 'raw' ? 'raw' : 'off';
      })(),
      blankTriggerMode: (get('blank-trigger-mode', 'immediate').toLowerCase() === 'spaced' ? 'spaced' : 'immediate') as 'immediate' | 'spaced',
      navKeymap: ((): 'auto' | 'ctrl-alt' | 'ctrl-shift' => {
        const v = get('nav-keymap', 'auto').toLowerCase();
        return v === 'ctrl-alt' ? 'ctrl-alt' : v === 'ctrl-shift' ? 'ctrl-shift' : 'auto';
      })(),
      cuesLlmProvider: bucketProvider(get('cues-llm-provider', 'inherit').toLowerCase()),
      auditorsLlmProvider: bucketProvider(get('auditors-llm-provider', 'inherit').toLowerCase()),
      blanksLlmProvider: bucketProvider(
        // Back-compat: prefer the new `blanks-llm-provider` key, fall back
        // to legacy `blank-llm-provider` (singular). seed-configs's
        // self-heal rewrites old → new on the next `opencues install` run.
        (newSettings.has('blanks-llm-provider')
          ? get('blanks-llm-provider', 'inherit')
          : get('blank-llm-provider', 'inherit')
        ).toLowerCase(),
      ),
      settings: newSettings as ReadonlyMap<string, string>,
      definitions: cur.definitions,
    };
    this._config = { ...this._config, opencuesState: next };
  }

  /**
   * Case-insensitive lookup. Falls back to blanksByWord when the word
   * isn't a tip-having entry but IS a blank or blankKeyword — synthesises
   * a LocalCueLookupResult from the blank's `tip` / `blankTip` so the
   * statusline shows e.g. "system volume" when the user highlights
   * `volume`. The blank side wasn't in cueMap because BLANKS.md and
   * folder CUE.md / BLANK.md don't go through the tips JSON path.
   */
  lookup(word: string): LocalCueLookupResult | null {
    const lc = word.toLowerCase();
    const fromTips = this._config.cueMap.get(lc);
    if (fromTips) return fromTips;
    const ent = this._config.blanksByWord.get(lc);
    if (!ent) return null;
    const c = ent.blank as unknown as {
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

  /**
   * Hot-reload is driven by TWO signals:
   *   1. **Keystroke** — `adapter.onTextChange` fires `maybeReload` so
   *      a user typing in the host picks up an OPENCUES.md edit on
   *      the very next character. The fast path; no extra timers.
   *   2. **Background poll** — a 5s setInterval also fires
   *      `maybeReload` so users who edit OPENCUES.md and then DON'T
   *      type (switch to the host, observe state, etc.) still see
   *      the new config within 5s. Closes the "I changed the file but
   *      nothing happened until I typed" surprise that bit us June 2026.
   *
   * Both paths funnel through the same debounce window (`reloadDebounceMs`,
   * default 2s) so the file-read load is at most once per 2s regardless
   * of how many signals fire. The poll's overhead is one filesystem
   * stat every 5s — negligible.
   */
  subscribe(): void {
    this._unsubText = this.adapter.onTextChange(() => {
      void this.maybeReload();
    });
    // Background poll. Skipped when (a) setInterval isn't available
    // (some test environments) OR (b) the option is explicitly
    // <=0 (opt-out for tests / hosts that want pure keystroke-driven
    // reload).
    const pollMs = this.options.backgroundPollMs ?? 5000;
    if (pollMs > 0 && typeof setInterval === 'function') {
      this._pollTimer = setInterval(() => {
        void this.maybeReload();
      }, pollMs);
      // Don't keep Node alive just for this timer — host-level disposal
      // owns the lifecycle. `unref` is Node-only; chrome timers don't
      // have it (no-op there).
      const t = this._pollTimer as unknown as { unref?: () => void };
      if (typeof t?.unref === 'function') t.unref();
    }
  }

  unsubscribe(): void {
    if (this._unsubText) { this._unsubText(); this._unsubText = null; }
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  /** Reload only if debounce window elapsed. */
  async maybeReload(): Promise<void> {
    // Race guard set by applyOpenCuesScalar — see comment on
    // _suppressReloadUntil. Lets the in-flight blankInvoke set's
    // async file write complete before we read the file back.
    if (Date.now() < this._suppressReloadUntil) return;
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
    // Search paths in priority order — project first, user-level fallback.
    // Falls back to [adapter.cwd] when configSearchPaths isn't set so old
    // adapter bands keep working unchanged.
    const searchPaths = this.options.configSearchPaths ?? [this.adapter.cwd];

    // System settings live in the user-level `OPENCUES.md` (markdown
    // with frontmatter, system-wide, runtime-owned schema). Read
    // separately from the cue library — settings are tool config,
    // sources are the standard's data.
    const settingsContent = this.options.settingsFile
      ? await this._safeReadFile(this.options.settingsFile)
      : null;

    // User context lives in `SENTINELS.md` alongside OPENCUES.md (so the
    // user-level `~/.cues/` directory holds both). Global only by
    // design — user data is user data; per-project overlays make no
    // sense. Always read when settingsFile is set; the runtime gate
    // (`sentinels-mode`) decides whether the parsed data ever
    // reaches a prompt.
    const userMdPath = this.options.settingsFile
      ? this.options.settingsFile.replace(/[^/]+$/, 'SENTINELS.md')
      : null;
    const userMdContent = userMdPath
      ? await this._safeReadFile(userMdPath)
      : null;
    const sentinels = parseSentinelsMd(userMdContent);
    // Diagnostic: one line per load so the failure mode is greppable
    // ("no path" / "missing" / "empty" / "N fields"). Trace why
    // sentinels isn't firing without having to bisect chrome.storage.
    const userMdState = !userMdPath ? 'no settingsFile (no path derivable)'
      : userMdContent === null ? `missing at ${userMdPath}`
      : sentinels.fields.length === 0 ? `read but parsed 0 fields from ${userMdPath} (${userMdContent.length} bytes)`
      : `${sentinels.fields.length} fields from ${userMdPath}`;
    this.adapter.log('info', `ConfigLoader: SENTINELS.md → ${userMdState}`);

    // Per-search-path master file reads. Master files declare the
    // surface as a whole — project metadata, ignore[], disable[]. Each
    // search path contributes one CUES.md, one BLANKS.md, one
    // AUDITORS.md; all are optional and may be null.
    const allReads = await Promise.all([
      ...searchPaths.flatMap(p => [
        this._safeReadFile(`${p}/CUES.md`),
        this._safeReadFile(`${p}/BLANKS.md`),
        this._safeReadFile(`${p}/AUDITORS.md`),
      ]),
    ]);
    const perPath = searchPaths.map((_searchPath, i) => ({
      cuesMd: allReads[i * 3],
      blanksMd: allReads[i * 3 + 1],
      auditorsMd: allReads[i * 3 + 2],
    }));

    // Per-path .md parses. Project (index 0) is highest priority; user
    // (index 1+) is fallback. We fold from LOW to HIGH so the high-priority
    // path is the second arg of the final mergeConfigs call (which makes
    // it win on name conflicts — see discover.ts mergeOneCuesMdConfig).
    const cuesConfig = this._mergeConfigsAcrossPaths(
      perPath.map(p => this._safeParseCuesMd(p.cuesMd, 'CUES.md')),
    );

    // cueMap is built below after folder configs are merged in — tips
    // live in folder CUE.md files (cues/<id>/CUE.md with type:tips).
    const cueMap = new Map<string, LocalCueLookupResult>();
    const blanksConfig = this._mergeConfigsAcrossPaths(
      perPath.map(p => this._safeParseCuesMd(p.blanksMd, 'BLANKS.md')),
    );

    // System settings — parsed from `OPENCUES.md` (or legacy
    // `.opencuesrc` / CUES.md frontmatter during a migration window).
    const opencuesState = settingsContent !== null
      ? parseOpenCuesMd(settingsContent)
      : DEFAULT_OPENCUES_STATE;

    // Folder discovery: walk each search path, then merge with project-
    // precedence (same fold-low-to-high rule as .md configs).
    let folderConfigs: DiscoveredConfigs | null = null;
    if (this.adapter.readDir) {
      const perPathFolders: DiscoveredConfigs[] = [];
      for (const p of searchPaths) {
        const fc = await this._discoverFolders(p);
        if (fc) perPathFolders.push(fc);
      }
      // Fold reverse so higher-priority paths overlay lower-priority.
      for (let i = perPathFolders.length - 1; i >= 0; i--) {
        folderConfigs = folderConfigs
          ? mergeConfigs(folderConfigs, perPathFolders[i])
          : perPathFolders[i];
      }
    }

    // Merge `disable:` lists from each surface's master file across
    // every search-path layer. Master files are read above
    // (perPath.cuesMd / blanksMd / auditorsMd); the lists from each
    // layer UNION (concat-and-dedupe), then attach to the relevant
    // merged surface config so the runtime can subtract them when
    // building sources.
    const cueDisableUnion = new Set<string>();
    const blankDisableUnion = new Set<string>();
    const auditorDisableUnion = new Set<string>();
    for (const p of perPath) {
      if (p.cuesMd) {
        try {
          for (const name of parseCuesMaster(p.cuesMd).disableCues ?? []) cueDisableUnion.add(name);
        } catch { /* defensive */ }
      }
      if (p.blanksMd) {
        try {
          for (const name of parseBlanksMaster(p.blanksMd).disableBlanks ?? []) blankDisableUnion.add(name);
        } catch { /* defensive */ }
      }
      if (p.auditorsMd) {
        try {
          for (const name of parseAuditorsMaster(p.auditorsMd).disableAuditors ?? []) auditorDisableUnion.add(name);
        } catch { /* defensive */ }
      }
    }
    if (cueDisableUnion.size > 0 || blankDisableUnion.size > 0 || auditorDisableUnion.size > 0) {
      if (!folderConfigs) folderConfigs = {};
    }
    if (cueDisableUnion.size > 0) {
      const existing = folderConfigs!.cuesConfig ?? { frontmatter: {}, sections: {} };
      folderConfigs!.cuesConfig = {
        ...existing,
        disableCues: [...new Set([...(existing.disableCues ?? []), ...cueDisableUnion])],
      };
    }
    if (blankDisableUnion.size > 0) {
      const existing = folderConfigs!.blanksConfig ?? { frontmatter: {}, sections: {} };
      folderConfigs!.blanksConfig = {
        ...existing,
        disableBlanks: [...new Set([...(existing.disableBlanks ?? []), ...blankDisableUnion])],
      };
    }
    if (auditorDisableUnion.size > 0) {
      const existing = folderConfigs!.auditorsConfig ?? { frontmatter: {}, sections: {} };
      folderConfigs!.auditorsConfig = {
        ...existing,
        disableAuditors: [...new Set([...(existing.disableAuditors ?? []), ...auditorDisableUnion])],
      };
    }

    // Merge .md configs with folder configs via opencues-core's mergeConfigs
    // (folders win — same as before).
    const mergedDiscovered = folderConfigs
      ? mergeConfigs(
          { cuesConfig: cuesConfig ?? undefined, blanksConfig: blanksConfig ?? undefined },
          folderConfigs,
        )
      : { cuesConfig: cuesConfig ?? undefined, blanksConfig: blanksConfig ?? undefined };
    const mergedCuesConfig = mergedDiscovered.cuesConfig ?? null;
    const mergedBlanksConfig = mergedDiscovered.blanksConfig ?? null;

    // Build cueMap from the merged config's tips. Folder-based tips
    // (cues/<id>/CUE.md with type:tips) flow through here. The legacy
    // `## Tips` JSON in master CUES.md still works during migration.
    if (mergedCuesConfig?.tips && mergedCuesConfig.tips.length > 0) {
      try {
        for (const [k, v] of buildLookupMap(mergedCuesConfig.tips)) cueMap.set(k, v);
      } catch (err) {
        this.adapter.log('error', 'ConfigLoader: tips buildLookupMap failed', err);
      }
    }

    // Build the navigable-words set + blanksByWord map from cueMap
    // keys, folder blanks, and BLANKS.md frontmatter.
    const navigableWords = new Set<string>();
    const blanksByWord = new Map<string, BlankEntry>();
    for (const k of cueMap.keys()) navigableWords.add(k);

    const addBlank = (name: string, blank: BlankConfig): void => {
      if (blank.enabled === false) return;
      const lcName = name.toLowerCase();
      navigableWords.add(lcName);
      blanksByWord.set(lcName, { name: lcName, blank });
      // Each blankKeyword maps to the same blank entry.
      const bk = blank.blankKeywords;
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
        blanksByWord.set(syn, { name: lcName, blank });
      }
    };
    for (const [name, blk] of Object.entries(folderConfigs?.blankOverrides ?? {})) {
      addBlank(name, blk as BlankConfig);
    }
    for (const [name, blk] of Object.entries(blanksConfig?.blanks ?? {})) {
      addBlank(name, blk as BlankConfig);
    }

    this._config = {
      cueMap,
      opencuesState,
      cuesConfig,
      blanksConfig,
      folderConfigs,
      mergedCuesConfig,
      mergedBlanksConfig,
      navigableWords,
      blanksByWord,
      sentinels,
    };
    this.adapter.log('debug', `ConfigLoader: loaded ${cueMap.size} cue entries, opencuesState=${JSON.stringify({
      voiceMode: opencuesState.voiceMode,
      tipsMode: opencuesState.tipsMode,
      debugMode: opencuesState.debugMode,
      cursorNavigate: opencuesState.cursorNavigate,
    })}`);
    // INFO-level reload signal — visible without debug-mode being on.
    // First load is treated specially (counts as initial boot, not a
    // user-perceptible hot-reload). Subsequent loads — triggered by
    // user edits to ~/.cues/*.md — emit a tail-visible "reloaded" line
    // so the user knows their save took effect, without needing to
    // turn on verbose debug logging.
    if (this._loaded) {
      this.adapter.log('info', `ConfigLoader: reloaded (${cueMap.size} cue entries, ${blanksByWord.size} blanks)`);
    }
    this.adapter.emitEvent?.('config.reloaded', {
      cueEntries: cueMap.size,
      blankCount: blanksByWord.size,
      voiceMode: opencuesState.voiceMode,
      tipsMode: opencuesState.tipsMode,
      debugMode: opencuesState.debugMode,
      cursorNavigate: opencuesState.cursorNavigate,
    });
  }

  /**
   * Fold an array of CuesMdConfig (one per search path, in priority order
   * with index 0 = highest) into a single merged config. The highest-priority
   * config wins on name conflicts.
   *
   * Implementation note: opencues-core's `mergeConfigs(a, b)` makes `b` win.
   * To make project (index 0) win we fold from low-priority (last index)
   * to high-priority (index 0), so project ends up as the final `b`.
   */
  private _mergeConfigsAcrossPaths(configs: readonly (CuesMdConfig | null)[]): CuesMdConfig | null {
    let result: CuesMdConfig | null = null;
    for (let i = configs.length - 1; i >= 0; i--) {
      const c = configs[i];
      if (!c) continue;
      if (!result) { result = c; continue; }
      // Wrap each as DiscoveredConfigs so we can reuse mergeConfigs's
      // existing per-section merge rules.
      const merged = mergeConfigs({ cuesConfig: result }, { cuesConfig: c });
      result = merged.cuesConfig ?? result;
    }
    return result;
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
    // opencues-core's discoverFolderConfigs takes sync readFile/readDir callbacks.
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
        } else if (e.name.endsWith('.md')) {
          // Cache any .md file: the new flat layout has <name>.md at
          // <base>/{words,blanks}/, while the legacy folder layout had
          // <base>/cues/<name>/CUE.md or <base>/blanks/<name>/BLANK.md. Both shapes flow
          // through discoverFolderConfigs's scanDir.
          const content = await this._safeReadFile(full);
          fileCache.set(full, content);
        }
      }
    };

    // Walk every scope dir. Missing dirs are no-ops via prewalk's null check.
    for (const sub of ['cues', 'blanks', 'auditors']) {
      await prewalk(`${cwd}/${sub}`, 0);
    }

    try {
      return discoverFolderConfigs({
        basePath: cwd,
        readFile: (path: string) => fileCache.has(path) ? fileCache.get(path) ?? null : null,
        readDir: (path: string) => dirCache.has(path) ? (dirCache.get(path) ?? null) as CoreDirEntry[] | null : null,
        // Drop folder packs whose frontmatter excludes the running host.
        // Mirrors chrome's bundle-level on-site filter so the same on-host:
        // declaration works uniformly across native hosts + chrome.
        hostName: this.adapter.hostName,
      });
    } catch (err) {
      this.adapter.log('warn', 'ConfigLoader: folder discovery failed', err);
      return null;
    }
  }
}


