// Single source of truth for OpenCues' optional features + the config
// files each one reads.
//
// THE PROBLEM THIS SOLVES
//
// The set of optional features (scalar names, defaults, prerequisite
// config files, which host script must push them) used to be encoded
// separately in FOUR sites:
//
//   - packages/opencues-runtime/src/modules/config-loader.ts (parsing)
//   - integrations/chrome/host/host.cjs                      (file-push list)
//   - packages/opencues-cli/src/commands/doctor.cjs          (diagnostics)
//   - packages/opencues-cli/src/commands/seed-configs.cjs    (templates)
//
// Adding a feature required editing all four. We hit two real drift
// bugs during the May 2026 user-context ship:
//
//   1. USER.md was added to the runtime + parser but NOT to host.cjs's
//      file-push list. Chrome silently never received it. The feature
//      looked "shipped" but was inert.
//   2. doctor's hardcoded feature-wiring list stayed valid only as long
//      as someone remembered to update it. Drift would produce a
//      "false green" — doctor reports ok while the feature is broken.
//
// THE FIX
//
// This module is the only place that knows what features exist. Every
// site iterates over FEATURES + CORE_CONFIG_FILES instead of hardcoding
// its own copy. Adding a feature = one PR appending to FEATURES; no
// other site can drift.
//
// HOW TO ADD A FEATURE
//
// 1. Append a FeatureSpec to FEATURES below.
// 2. If the feature reads a config file, set prereqFile.
// 3. If chrome needs the file pushed into chrome.storage, add 'chrome-host'
//    to pushedBy.
// 4. If the feature requires a non-empty file to function, set
//    prereqFile.mustHavePopulatedFields — doctor will then warn when
//    the scalar is enabled but the file is empty.
// 5. If the file ships a starter template, set prereqFile.template
//    (path relative to repo root) — seed-configs will copy it.
//
// That's the whole checklist. No edits to host.cjs, doctor.cjs, or
// seed-configs.cjs are required for the install-boundary plumbing.
// (config-loader.ts still needs to parse the scalar into a typed
// OpenCuesState field for TypeScript consumers — see the linked test
// for the drift-prevention assertion there.)

/**
 * One valid value for a feature or menu tunable. Carries its own
 * description (used in the cycling-menu satellite tip) + a flag
 * controlling whether the value appears in the user-visible cycling
 * menu at all.
 *
 * Hiding a value from the menu does NOT make it invalid — the parser
 * still accepts it when set by direct file edit. The flag exists so
 * footgun modes (e.g. `user-context-mode: raw`, which inlines PII
 * into LLM prompts) can't be flipped by a single keystroke.
 */
export interface ValueSpec {
  /** The literal value as it appears in OPENCUES.md frontmatter. */
  readonly id: string;
  /** Per-value tip shown in the satellite when this value is selected. */
  readonly description: string;
  /** Default true. Set false to keep the value parser-valid but absent from the cycling menu. */
  readonly exposeInMenu?: boolean;
}

/**
 * A single optional feature exposed via an OPENCUES.md scalar.
 *
 * Features that aren't gated on a scalar (always-on services like
 * the resolver itself) don't belong here — they aren't "optional".
 */
export interface FeatureSpec {
  /**
   * OPENCUES.md scalar key, kebab-case. Example: 'user-context-mode'.
   * Must match the key in OPENCUES.md and CUES.md frontmatter.
   */
  readonly scalar: string;

  /**
   * camelCase form for the OpenCuesState field. Example:
   * 'userContextMode'. ConfigLoader uses this when parsing.
   */
  readonly camelCase: string;

  /**
   * Valid scalar values, each carrying its own description + menu-
   * exposure flag. First entry is treated as the default. Replaces
   * the OPENCUES.md `settings:` block that used to duplicate this
   * info — the registry is now the single source of truth for the
   * selector-satellite cycling menu.
   *
   * Example:
   *   values: [
   *     { id: 'off',  description: 'Disabled (default)' },
   *     { id: 'safe', description: 'Tokens-only catalog' },
   *     { id: 'raw',  description: 'Inline values', exposeInMenu: false },
   *   ]
   *
   * Use exposeInMenu: false for values that are intentionally hidden
   * from cycling (e.g. footgun modes that should require a deliberate
   * file edit). They remain VALID values (parser accepts them); they
   * just don't show up when the user cycles `opencues settings _`.
   */
  readonly values: readonly ValueSpec[];

  /**
   * One-line description for doctor's feature wiring section + dev
   * docs. NOT the menu tip — use `menuTip` for that (typically a more
   * user-facing rewording).
   */
  readonly description: string;

  /**
   * Optional menu-specific tip shown when the user is cycling THIS
   * setting in `opencues settings _`. Defaults to `description` when
   * omitted. Provide a separate string when the menu deserves a
   * shorter / more action-oriented phrasing than the dev description.
   */
  readonly menuTip?: string;

  /**
   * Optional config file the feature reads from ~/.cues/.
   * Triggers seed-configs (if template) + chrome-host push (if pushedBy).
   */
  readonly prereqFile?: {
    /** Filename inside ~/.cues/, e.g. 'USER.md'. */
    readonly basename: string;
    /** Path under repo root for seed-configs to copy, e.g. 'defaults/USER.md'. */
    readonly template?: string;
    /**
     * When true, the feature is silently inert if the file exists but
     * has no populated frontmatter fields. Doctor warns when the
     * scalar is set but the file is empty.
     */
    readonly mustHavePopulatedFields?: boolean;
  };

  /**
   * Host scripts that must push prereqFile so the file reaches every
   * runtime. Native hosts (CC / OC / gemini-cli) read the filesystem
   * directly — only chrome needs the explicit push list.
   */
  readonly pushedBy?: readonly 'chrome-host'[];
}

/**
 * Config files that are always read by every runtime + pushed by
 * every host. Not gated on any scalar. Order is irrelevant.
 *
 * Adding to this list is a runtime-fundamental change — most new
 * config files belong in FEATURES with a prereqFile instead.
 */
export const CORE_CONFIG_FILES: readonly string[] = [
  'OPENCUES.md',
  'CUES.md',
  'AUDITORS.md',
];

/**
 * Canonical filename for the user-level RUNTIME SETTINGS file —
 * lives at `~/.cues/OPENCUES.md` (or `$OPENCUES_HOME/OPENCUES.md`).
 * Carries all OPENCUES.md scalars (voice-mode, debug-mode,
 * fluid-blank-mode, llm-provider, etc.).
 *
 * NOT to be confused with `CUES.md` — that's the cue master
 * config (cue source declarations, project metadata, optional
 * tips/ignore lists). The two files have different schemas and
 * different lifecycles; they happen to share a similar name.
 *
 * Single source of truth — every CLI command, host bootstrap, and
 * documentation reference should derive from here rather than
 * hardcoding the filename. A previous (aborted) migration plan
 * intended to merge OPENCUES.md into CUES.md; that migration
 * never landed, so CLAUDE.md and some old comments still say
 * "settings live in CUES.md" — those are wrong.
 */
export const CORE_SETTINGS_FILE = 'OPENCUES.md';

/**
 * Map of core-file basename → repo-relative template path, for
 * files that ship a seed template the user can edit. Iterated by
 * seed-configs alongside the per-feature templates. Files without
 * a template (e.g. CUES.md, which is built up from cues/<name>/CUE.md)
 * just aren't keyed here.
 */
export const CORE_TEMPLATES: Readonly<Record<string, string>> = {
  'AUDITORS.md': 'defaults/AUDITORS.md',
  // OPENCUES.md is handled by seed-configs's own healing logic, not
  // this template map (it has its own 0-byte self-heal pass).
};

/**
 * Information needed to seed a config file (basename + template
 * source). Returned by `seedableOptionalFiles()`.
 */
export interface SeedableFile {
  readonly basename: string;
  readonly template: string;
  readonly mustHavePopulatedFields?: boolean;
}

/**
 * All optional config files that ship a starter template — core files
 * with templates (AUDITORS.md) plus every feature with prereqFile.template
 * (USER.md and future). seed-configs iterates this; SKIP-if-exists is
 * applied uniformly. Adding a new templated file = add to CORE_TEMPLATES
 * OR add a feature with prereqFile.template. seed-configs needs no edit.
 */
export function seedableOptionalFiles(): SeedableFile[] {
  return [
    ...Object.entries(CORE_TEMPLATES).map(([basename, template]) => ({
      basename, template,
    })),
    ...FEATURES.flatMap(f => f.prereqFile?.template ? [{
      basename: f.prereqFile.basename,
      template: f.prereqFile.template,
      mustHavePopulatedFields: f.prereqFile.mustHavePopulatedFields,
    }] : []),
  ];
}

/**
 * Every optional feature OpenCues exposes via an OPENCUES.md scalar.
 *
 * Order matters only for the selector-satellite menu and doctor's
 * feature-wiring section (rendered in this order). Grouped by surface:
 * surface-availability first, then context-injection, then misc.
 */
export const FEATURES: readonly FeatureSpec[] = [
  // ── Surface availability ─────────────────────────────────────────
  {
    scalar: 'fluid-blank-mode',
    camelCase: 'fluidBlankMode',
    description: 'Free-form `_` lookups (LLM pipeline)',
    menuTip: 'Free-form `_` lookups (P1+P3 LLM pipeline)',
    values: [
      { id: 'on',  description: 'Enabled — `_` next to a lookup phrase auto-substitutes the answer' },
      { id: 'off', description: 'Disabled — fluid-blank ignored' },
    ],
  },
  {
    scalar: 'word-cues-mode',
    camelCase: 'wordCuesMode',
    description: 'LLM word alternatives surfaced on plain text',
    menuTip: 'Per-word cues (RoutedWordSourceGroup) on plain text — domain alternatives, synonyms',
    values: [
      { id: 'on',  description: 'Enabled — words matching a cue source\'s match/keywords get cycled alternatives' },
      { id: 'off', description: 'Disabled — no word-cue LLM calls fire' },
    ],
  },
  {
    scalar: 'transform-blank-mode',
    camelCase: 'transformBlankMode',
    description: 'Imperative `_` slots + agent-task lifecycle (`agentically X _`, `add task X _`)',
    menuTip: 'Imperative `_` slots + agent-task lifecycle (`agentically X _`, `add task X _`, `stop task _`)',
    values: [
      { id: 'on',  description: 'Enabled — `_` reaches transform-blank\'s classifier; agent tasks can be armed' },
      { id: 'off', description: 'Disabled — `_` skips classification; `agentically X _` falls through to fluid-blank as a lookup' },
    ],
  },
  {
    scalar: 'fluid-config-mode',
    camelCase: 'fluidConfigMode',
    description: 'Semantic `_` → settings-change routing (LLM classifier over the FEATURES registry)',
    menuTip: 'Route `_` to a settings change when no keyword matched ("stop showing tips _" → tips-mode=off). Only routes to OPENCUES settings, never user blanks.',
    values: [
      { id: 'off', description: 'Disabled (default) — `_` falls through to fluid-blank as a lookup' },
      { id: 'on',  description: 'Enabled — one LLM call classifies the surrounding text against the FEATURES registry; on hit, the matched setting is applied' },
    ],
  },
  {
    scalar: 'sentence-cues-mode',
    camelCase: 'sentenceCuesMode',
    description: 'Sentence-scope cues — whole-sentence alternatives via `scope: sentence` cue declarations',
    menuTip: 'Whole-sentence alternative rewrites (e.g. more-formal). Highlights span the sentence; sentence-scope wins over overlapping word-cues.',
    values: [
      { id: 'off', description: 'Disabled (default) — every `scope: sentence` cue is filtered at build time' },
      { id: 'on',  description: 'Enabled — sentence cues fire on prose buffers, suppressing any word-cues for words inside the sentence span' },
    ],
  },
  {
    scalar: 'blank-trigger-mode',
    camelCase: 'blankTriggerMode',
    description: 'When `_` fires its blank — immediately on insertion vs only after a space follows',
    menuTip: 'Defer blank firing until `_` is followed by a space (lets you type markdown `_italic_` without the first `_` triggering)',
    values: [
      { id: 'immediate', description: 'Default — `_` triggers its blank the moment you type it' },
      { id: 'spaced',    description: 'Markdown-friendly — `_` only triggers after you type a following space; bare `_…_` stays inert' },
    ],
  },
  {
    scalar: 'tips-mode',
    camelCase: 'tipsMode',
    description: 'Static tip groups from defaults/cues/*/CUE.md',
    menuTip: 'Toggles tip display',
    values: [
      { id: 'on',  description: 'All tips shown' },
      { id: 'off', description: 'Tips hidden' },
    ],
  },
  {
    scalar: 'voice-mode',
    camelCase: 'voiceMode',
    description: 'TTS for highlighted words',
    menuTip: 'Gates TTS globally',
    values: [
      { id: 'active',   description: 'TTS reads tips aloud on navigation' },
      { id: 'inactive', description: 'TTS is silenced' },
    ],
  },
  {
    scalar: 'cursor-navigate',
    camelCase: 'cursorNavigate',
    description: 'Auto-highlight word under cursor',
    menuTip: 'Auto-highlight word at cursor',
    values: [
      { id: 'inactive', description: 'Manual navigation only' },
      { id: 'active',   description: 'Highlight follows cursor to navigable words' },
    ],
  },
  {
    scalar: 'debug-mode',
    camelCase: 'debugMode',
    description: 'Verbose runtime logging (every cue/blank decision)',
    menuTip: 'Enable debug logging output',
    values: [
      { id: 'off', description: 'Debug logging suppressed' },
      { id: 'on',  description: 'Debug output emitted to console' },
    ],
  },

  // ── Provider routing ─────────────────────────────────────────────
  {
    scalar: 'blank-llm-provider',
    camelCase: 'blankLlmProvider',
    description: 'LLM provider used for blank-class sources (FluidBlank / TransformBlank / ConfigIntent / keyword blanks). Inherits llm-provider by default.',
    menuTip: 'Pick a separate provider for blanks (the opt-in `_` surface). `free` routes blanks through OpenCode Zen\'s free model pool — no API key, but the provider trains on data. Cues + auditors are unaffected by this setting.',
    values: [
      { id: 'inherit', description: 'Default — blanks use the same provider as llm-provider' },
      { id: 'free',    description: 'OpenCode Zen free pool (no API key required; providers train on blank inputs). Cues + auditors never use this.' },
      // The seven concrete provider ids stay parser-valid but are hidden
      // from the menu — picking a specific paid provider per-surface is
      // an advanced override better edited in OPENCUES.md directly. The
      // menu's job is the inherit-vs-free split.
      { id: 'groq',         description: 'Pin blanks to Groq',         exposeInMenu: false },
      { id: 'openrouter',   description: 'Pin blanks to OpenRouter',   exposeInMenu: false },
      { id: 'gemini',       description: 'Pin blanks to Gemini',       exposeInMenu: false },
      { id: 'openai',       description: 'Pin blanks to OpenAI',       exposeInMenu: false },
      { id: 'anthropic',    description: 'Pin blanks to Anthropic',    exposeInMenu: false },
      { id: 'cerebras',     description: 'Pin blanks to Cerebras',     exposeInMenu: false },
      { id: 'claude-cli',   description: 'Pin blanks to claude-cli',   exposeInMenu: false },
      { id: 'opencode-zen', description: 'Pin blanks to opencode-zen', exposeInMenu: false },
    ],
  },

  // ── Context injection ────────────────────────────────────────────
  {
    scalar: 'ambient-context-mode',
    camelCase: 'ambientContextMode',
    description: 'Field label/placeholder/page-title sent with fluid-blank lookups (chrome only)',
    menuTip: 'Share focused-field label/placeholder/page-title with fluid-blank for disambiguation. Sensitive fields excluded. Chrome only.',
    values: [
      { id: 'off', description: 'Disabled (default) — host returns null; ambient block never built' },
      { id: 'on',  description: 'Enabled — ambient block injected into fluid-blank prompt' },
    ],
  },
  {
    scalar: 'user-context-mode',
    camelCase: 'userContextMode',
    description: 'Personal data injected into fluid-blank as sentinel tokens',
    menuTip: 'Inject ~/.cues/USER.md fields (first name, email, etc.) as sentinel tokens into fluid-blank for personalised lookups.',
    values: [
      { id: 'off',  description: 'Disabled (default) — USER.md never read' },
      { id: 'safe', description: 'Tokens-only catalog sent to LLM; post-processor substitutes values after response. PII stays on the host.' },
      // `raw` mode (catalog values inlined into the prompt — PII
      // reaches the LLM provider) is implementation-complete but
      // intentionally NOT cycleable from the menu — flipping it should
      // be a deliberate file edit, not a one-keystroke toggle. Phase 2
      // will revisit exposure alongside per-pack capability disclosure.
      { id: 'raw',  description: 'Catalog values inlined into prompt; PII reaches the LLM provider', exposeInMenu: false },
    ],
    prereqFile: {
      basename: 'USER.md',
      template: 'defaults/USER.md',
      mustHavePopulatedFields: true,
    },
    pushedBy: ['chrome-host'],
  },
];

/**
 * Non-feature menu tunables — numeric or enum settings that appear in
 * the cycling menu but aren't OpenCues "features" in the capability
 * sense (no prereq file, no scalar-as-surface-gate). Same ValueSpec
 * shape so they slot into the same menu-derivation pipeline.
 */
export interface MenuTunableSpec {
  /** OPENCUES.md scalar key, kebab-case. */
  readonly scalar: string;
  /** Menu tip shown when cycling this setting. */
  readonly menuTip: string;
  /** Cyclable values. First entry is the recommended default for the menu's initial render. */
  readonly values: readonly ValueSpec[];
}

export const MENU_TUNABLES: readonly MenuTunableSpec[] = [
  {
    scalar: 'agent-debounce-ms',
    menuTip: 'Pause after last keystroke before AgentRewrite fires (ms). Misparse → 1000.',
    values: [
      { id: '150',  description: 'Twitchy — fires almost immediately; great with cached rewrites, costly on cache misses' },
      { id: '250',  description: 'Snappy — fires before most users finish a word; noticeably more responsive than the default' },
      { id: '500',  description: 'Aggressive — fires shortly after each pause' },
      { id: '1000', description: 'Default — balanced' },
      { id: '2000', description: 'Relaxed — only fires after a clear stop' },
    ],
  },
  {
    scalar: 'max-concurrent-auditors',
    menuTip: 'Cap on parallel auditor calls per tick. 0 = uncapped. Bound LLM cost when many auditors are active.',
    values: [
      { id: '0', description: 'Uncapped — all enabled auditors fire each tick' },
      { id: '3', description: 'Bounded — top-3 priority-desc only' },
      { id: '5', description: 'Bounded — top-5 priority-desc only' },
    ],
  },
  {
    scalar: 'blank-loading-animation',
    menuTip: 'Glyph progression shown at `_` while its source resolves. Stays in one column; restores to `_` on complete.',
    values: [
      { id: 'bounce',         description: '`_` `-` `‾` `-` — vertical pulse, returns to `_` (default)' },
      { id: 'braille-rotate', description: '`_` once, then loops `⠁ ⠈ ⠐ ⠠ ⠄ ⠂` clockwise' },
      { id: 'flipper',        description: '`_` `\\` `|` `/` — a mark flipping through orientations' },
      { id: 'custom',         description: 'Use the user-defined frames from `blank-loading-frames`' },
      { id: 'off',            description: 'No animation — `_` stays static until substitution' },
    ],
  },
  {
    scalar: 'blank-loading-interval-ms',
    menuTip: 'Per-frame duration in ms. Lower = snappier, higher = each colour stays visible longer.',
    values: [
      { id: '75',  description: 'Rapid — 75ms per frame, blurs into motion' },
      { id: '150', description: 'Snappy (default) — 150ms per frame' },
      { id: '300', description: 'Slow — 300ms per frame, each colour holds twice as long' },
    ],
  },
];

// ──────────────────────────────────────────────────────────────────────
// Helpers for consumers transitioning from `values: string[]` to
// `values: ValueSpec[]`. Use these instead of `f.values[0]` etc.

/** The default value (first entry's id) for a feature or tunable. */
export function getDefaultValue(spec: { values: readonly ValueSpec[] }): string {
  return spec.values[0]?.id ?? '';
}

/** All value ids (for tests / display lists). */
export function getValueIds(spec: { values: readonly ValueSpec[] }): readonly string[] {
  return spec.values.map(v => v.id);
}

/** Only the values that should appear in the cycling menu (exposeInMenu !== false). */
export function getCyclableValues(spec: { values: readonly ValueSpec[] }): readonly ValueSpec[] {
  return spec.values.filter(v => v.exposeInMenu !== false);
}

/**
 * Build the menu-definitions map for the selector-satellite cycling
 * UI. Combines FEATURES + MENU_TUNABLES, applying exposeInMenu
 * filtering. Replaces the parseSettingsBlock() call in config-loader
 * — the registry IS the menu schema now.
 *
 * Returned shape mirrors the legacy OpenCuesSettingDef so consumers
 * (Cycling.ts, OpenCuesSettingsBlank) don't need to change.
 */
export function getMenuDefinitions(): Map<string, {
  readonly tip?: string;
  readonly valueOrder: readonly string[];
  readonly valueTips: ReadonlyMap<string, string>;
}> {
  const out = new Map<string, { tip?: string; valueOrder: readonly string[]; valueTips: ReadonlyMap<string, string> }>();

  // Features first (in declaration order), then tunables. Match the
  // original OPENCUES.md ordering so the menu's first-setting probe
  // returns the same first scalar.
  for (const f of FEATURES) {
    const cyclable = getCyclableValues(f);
    if (cyclable.length === 0) continue;
    const tips = new Map<string, string>();
    for (const v of cyclable) tips.set(v.id, v.description);
    out.set(f.scalar, {
      tip: f.menuTip ?? f.description,
      valueOrder: cyclable.map(v => v.id),
      valueTips: tips,
    });
  }
  for (const t of MENU_TUNABLES) {
    const tips = new Map<string, string>();
    for (const v of t.values) tips.set(v.id, v.description);
    out.set(t.scalar, {
      tip: t.menuTip,
      valueOrder: t.values.map(v => v.id),
      valueTips: tips,
    });
  }
  return out;
}

/**
 * Look up a feature by scalar name. Returns undefined for unknown
 * scalars (callers should treat as "this isn't a feature we know
 * about — leave the value as-is").
 */
export function findFeature(scalar: string): FeatureSpec | undefined {
  return FEATURES.find(f => f.scalar === scalar);
}

/**
 * Chrome-host's complete config-file push list. Combines the
 * always-on core files with every feature-gated file that declares
 * `pushedBy: ['chrome-host']`. host.cjs imports this so adding a
 * pushed-by-host feature requires zero changes outside this registry.
 */
export function chromeHostFileList(): readonly string[] {
  return [
    ...CORE_CONFIG_FILES,
    ...FEATURES.flatMap(f =>
      f.prereqFile && f.pushedBy?.includes('chrome-host')
        ? [f.prereqFile.basename]
        : []
    ),
  ];
}

/**
 * Every config file (basename, not absolute path) that any feature or
 * the runtime itself might read from ~/.cues/. Useful for diagnostics
 * + future bulk-validation passes.
 */
export function allConfigFileBasenames(): readonly string[] {
  return [
    ...CORE_CONFIG_FILES,
    ...FEATURES.flatMap(f => f.prereqFile ? [f.prereqFile.basename] : []),
  ];
}
