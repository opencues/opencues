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
   * Valid scalar values; first entry is treated as the default.
   * Example: ['off', 'safe', 'raw'] — first is off-by-default.
   */
  readonly values: readonly string[];

  /**
   * One-line description for doctor's feature wiring section + the
   * selector-satellite settings menu tip.
   */
  readonly description: string;

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
    values: ['on', 'off'],
    description: 'Free-form `_` lookups (LLM pipeline)',
  },
  {
    scalar: 'word-cues-mode',
    camelCase: 'wordCuesMode',
    values: ['on', 'off'],
    description: 'LLM word alternatives surfaced on plain text',
  },
  {
    scalar: 'transform-blank-mode',
    camelCase: 'transformBlankMode',
    values: ['on', 'off'],
    description: 'Imperative `_` slots + agent-task lifecycle (`agentically X _`, `add task X _`)',
  },
  {
    scalar: 'tips-mode',
    camelCase: 'tipsMode',
    values: ['on', 'off'],
    description: 'Static tip groups from defaults/cues/*/CUE.md',
  },
  {
    scalar: 'voice-mode',
    camelCase: 'voiceMode',
    values: ['inactive', 'active'],
    description: 'TTS for highlighted words',
  },
  {
    scalar: 'cursor-navigate',
    camelCase: 'cursorNavigate',
    values: ['inactive', 'active'],
    description: 'Auto-highlight word under cursor',
  },
  {
    scalar: 'debug-mode',
    camelCase: 'debugMode',
    values: ['off', 'on'],
    description: 'Verbose runtime logging (every cue/blank decision)',
  },

  // ── Context injection ────────────────────────────────────────────
  {
    scalar: 'ambient-context-mode',
    camelCase: 'ambientContextMode',
    values: ['off', 'on'],
    description: 'Field label/placeholder/page-title sent with fluid-blank lookups (chrome only)',
  },
  {
    scalar: 'user-context-mode',
    camelCase: 'userContextMode',
    values: ['off', 'safe', 'raw'],
    description: 'Personal data injected into fluid-blank as sentinel tokens',
    prereqFile: {
      basename: 'USER.md',
      template: 'defaults/USER.md',
      mustHavePopulatedFields: true,
    },
    pushedBy: ['chrome-host'],
  },
];

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
