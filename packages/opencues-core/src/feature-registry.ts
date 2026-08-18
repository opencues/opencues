import { BROWSER_HOSTS } from './host-compat';
import { getProvider } from './llm-provider';

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
// bugs during the May 2026 sentinels ship:
//
//   1. SENTINELS.md was added to the runtime + parser but NOT to host.cjs's  // LEGACY-NAME-ALLOW: historical narrative
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
 * footgun modes (e.g. `identity-context-mode: raw`, which inlines PII
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
   * OPENCUES.md scalar key, kebab-case. Example: 'identity-context-mode'.
   * Must match the key in OPENCUES.md and CUES.md frontmatter.
   */
  readonly scalar: string;

  /**
   * camelCase form for the OpenCuesState field. Example:
   * 'identityContextMode'. ConfigLoader uses this when parsing.
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
   * Section this setting belongs to in the `opencues config` browser — one
   * of `SETTINGS_GROUP_ORDER`. Colocated with the scalar so adding a feature
   * auto-places it; the CLI no longer keeps a separate section map. Unset →
   * the browser's "More" catch-all (a registry test asserts every menu scalar
   * has a group, so that never happens silently).
   */
  readonly group?: string;

  /**
   * Optional config file the feature reads from ~/.cues/.
   * Triggers seed-configs (if template) + chrome-host push (if pushedBy).
   */
  readonly prereqFile?: {
    /** Filename inside ~/.cues/, e.g. 'IDENTITY.md'. */
    readonly basename: string;
    /** Path under repo root for seed-configs to copy, e.g. 'defaults/IDENTITY.md'. */
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

  /**
   * Optional dynamic value computation. When set, the cycling menu
   * derives `values` from the current settings instead of the static
   * `values` array. Used for scalars whose valid range depends on
   * another scalar — e.g. `auditors-llm-model` enumerates the current
   * `auditors-llm-provider`'s knownModels.
   *
   * The static `values` array is still required (used as a fallback
   * + a TypeScript-discoverable list of "in principle valid" ids). The
   * dynamic provider is invoked at every cycling decision point so it
   * always reflects live settings.
   */
  readonly valuesProvider?: (settings: ReadonlyMap<string, string>) => readonly ValueSpec[];

  /**
   * Restrict this feature's settings-menu visibility to specific hosts.
   * When set, only the listed hosts show it in `opencues settings _`.
   * Omitted = universal (every host). Mirrors MenuTunableSpec.hostScope
   * — used for features that only DO something on one host (e.g. chrome's
   * `statusbar-position`, which positions the in-page floating bar the CLI
   * hosts don't have). The scalar is still a real FEATURE so the
   * fluid-config intent classifier can route to it on that host.
   */
  readonly hostScope?: readonly string[];
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
  // NOTES.md — the note collection blank's store (PROTOTYPE, issue
  // #210). In this list so chrome-host pushes disk edits into
  // chrome.storage; created on first `note add` (no seed template).
  'NOTES.md',
];

/**
 * Canonical filename for the user-level RUNTIME SETTINGS file —
 * lives at `~/.cues/OPENCUES.md` (or `$OPENCUES_HOME/OPENCUES.md`).
 * Carries all OPENCUES.md scalars (voice-mode, debug-mode,
 * word-cues-mode, llm-provider, etc.).
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
 * (IDENTITY.md and future). seed-configs iterates this; SKIP-if-exists is
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
 * Decorate a `*-llm-provider` scalar's `inherit` entry with what
 * inheriting RESOLVES TO right now. The menu is the moment of choice —
 * "inherit" is only a meaningful option when it names the inherited
 * provider (July 2026: "the inherit ask doesn't say what you're
 * inheriting"). Resolution mirrors the effective-routing walk's global
 * tier: the `llm-provider` scalar when set — named even when it's an
 * unknown id, so a typo'd global is visible at the menu instead of
 * discovered at dispatch — otherwise the auto-route over available API
 * keys, which the registry cannot see (no key bag here), so it is
 * named as auto-routing rather than guessed. Non-`inherit` entries
 * pass through untouched.
 */
function withInheritResolution(
  values: readonly ValueSpec[],
  settings: ReadonlyMap<string, string>,
): readonly ValueSpec[] {
  const raw = settings.get('llm-provider')?.trim().toLowerCase();
  const adapter = raw ? getProvider(raw) : null;
  const resolved = raw
    ? adapter
      ? `currently ${adapter.id}`
      : `llm-provider is "${raw}" — unknown provider, calls disabled`
    : 'unset — auto-routes from your available API keys';
  return values.map(v => v.id === 'inherit'
    ? { ...v, description: `Default — inherit the global llm-provider (${resolved})` }
    : v);
}

/**
 * Build the model-value list for a `*-llm-model` scalar from the
 * sibling provider's catalogue. Returns `default` followed by the
 * provider's `knownModels`. When the provider is unset / `inherit` /
 * unknown, falls back to the `globalFallback` provider (`llm-provider`)
 * and finally to a `default`-only list so the menu still works.
 */
function buildModelValues(
  bucketProvider: string | undefined,
  globalFallback: string | undefined,
): readonly ValueSpec[] {
  // `inherit` means "use llm-provider" — resolve to that for the menu.
  const id = bucketProvider && bucketProvider !== 'inherit' ? bucketProvider : globalFallback;
  const adapter = id ? getProvider(id) : null;
  const out: ValueSpec[] = [
    {
      id: 'default',
      description: adapter
        ? `Use ${adapter.id}'s default model (${adapter.defaultModel})`
        : 'Use the auto-routed provider\'s default model (no provider pinned — set llm-provider or an API key)',
    },
  ];
  const models = adapter?.knownModels ?? (adapter ? [adapter.defaultModel] : []);
  for (const m of models) {
    if (m === adapter?.defaultModel) {
      out.push({ id: m, description: `${m} (provider default)` });
    } else {
      out.push({ id: m, description: m });
    }
  }
  return out;
}

/**
 * Static value lists for the three `*-llm-provider` bucket scalars.
 * Hoisted so each feature can reference its list twice: as the static
 * `values` fallback AND inside its `valuesProvider`, where
 * `withInheritResolution` decorates the `inherit` entry with the live
 * resolution. cues/auditors are prose-bearing (no opencode-zen);
 * blanks exposes the free pool behind the user's `_` consent gate.
 */
const CUES_PROVIDER_VALUES: readonly ValueSpec[] = [
  { id: 'inherit',   description: 'Default — cues use the global llm-provider (auto-routed when unset)' },
  { id: 'cerebras',  description: 'Cerebras — fastest gpt-oss-120b host (recommended)' },
  { id: 'groq',      description: 'Groq — gpt-oss-120b, accuracy ceiling on long-form' },
  { id: 'gemini',    description: 'Gemini — stable across the matrix' },
  { id: 'anthropic', description: 'Anthropic — pricier, parity accuracy' },
  { id: 'openai',    description: 'OpenAI — gpt-5.4-mini default' },
  { id: 'openrouter', description: 'OpenRouter (multi-model router)', exposeInMenu: false },
  { id: 'claude-code-cli', description: 'claude-code-cli (subprocess)', exposeInMenu: false },
  { id: 'ollama',     description: 'Ollama (local) — private, free, needs a running Ollama server', exposeInMenu: false },
];
const AUDITORS_PROVIDER_VALUES: readonly ValueSpec[] = [
  { id: 'inherit',   description: 'Default — auditors use the global llm-provider (auto-routed when unset)' },
  { id: 'cerebras',  description: 'Cerebras — fastest gpt-oss-120b host (recommended)' },
  { id: 'groq',      description: 'Groq — gpt-oss-120b, accuracy ceiling on long-form' },
  { id: 'gemini',    description: 'Gemini — stable across the matrix' },
  { id: 'anthropic', description: 'Anthropic — pricier, parity accuracy' },
  { id: 'openai',    description: 'OpenAI — gpt-5.4-mini default' },
  { id: 'openrouter', description: 'OpenRouter (multi-model router)', exposeInMenu: false },
  { id: 'claude-code-cli', description: 'claude-code-cli (subprocess)', exposeInMenu: false },
  { id: 'ollama',     description: 'Ollama (local) — private, free, needs a running Ollama server', exposeInMenu: false },
];
const BLANKS_PROVIDER_VALUES: readonly ValueSpec[] = [
  { id: 'inherit',      description: 'Default — blanks use the global llm-provider' },
  { id: 'opencode-zen', description: 'OpenCode Zen free pool — pair with `blanks-llm-model: free` (provider trains on input)' },
  { id: 'cerebras',     description: 'Cerebras — fastest gpt-oss-120b host (recommended)' },
  { id: 'groq',         description: 'Groq — gpt-oss-120b, accuracy ceiling on long-form' },
  { id: 'gemini',       description: 'Gemini — stable across the matrix' },
  { id: 'anthropic',    description: 'Anthropic — pricier, parity accuracy' },
  { id: 'openai',       description: 'OpenAI — gpt-5.4-mini default' },
  { id: 'openrouter',   description: 'OpenRouter (multi-model router)', exposeInMenu: false },
  { id: 'claude-code-cli', description: 'claude-code-cli (subprocess)', exposeInMenu: false },
  { id: 'ollama',     description: 'Ollama (local) — private, free, needs a running Ollama server', exposeInMenu: false },
];

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
    scalar: 'word-cues-mode',
    group: 'Cues',
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
    group: 'Blanks',
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
    group: 'Cues',
    camelCase: 'fluidConfigMode',
    description: 'Semantic `_` → settings-change routing (LLM classifier over the FEATURES registry)',
    menuTip: 'Route `_` to a settings change when no keyword matched ("stop showing tips _" → tips-mode=off). Only routes to OPENCUES settings, never user blanks.',
    values: [
      { id: 'off', description: 'Disabled — `_` falls through to fluid-blank as a lookup' },
      { id: 'on',  description: 'Enabled (default) — one LLM call classifies the surrounding text against the FEATURES registry; on hit, the matched setting is applied' },
    ],
  },
  {
    scalar: 'undo-mode',
    group: 'Cues',
    camelCase: 'undoMode',
    description: 'Natural-language undo/redo of OpenCues changes ("undo _", "undo 3 _", "redo _")',
    menuTip: 'Revert what OpenCues did — fills, rewrites, settings writes, volume/brightness sets. Language-invariant (routed via the config-intent classifier); count supported ("undo 3 _").',
    values: [
      { id: 'on',  description: 'Enabled (default) — `undo _` / `redo _` revert OpenCues-applied changes from the session journal' },
      { id: 'off', description: 'Disabled — undo/redo verdicts cede; `_` falls through to the other blank sources' },
    ],
  },
  {
    scalar: 'integration-weave-mode',
    group: 'Blanks',
    camelCase: 'integrationWeaveMode',
    description: 'LLM contextual weaving of a blank\'s `integration:` exemplar (the value is swapped in AFTER the call — never sent to the provider)',
    menuTip: 'Let a blank with `integration-weave: true` weave its output into surrounding prose via one LLM call. The real value is substituted for a sentinel token after the response, so it never reaches the provider; falls back to the static `{value}` template on any failure.',
    values: [
      { id: 'off', description: 'Disabled (default) — `integration:` is a static `{value}` template, zero LLM' },
      { id: 'on',  description: 'Enabled — blanks declaring `integration-weave: true` weave their exemplar into context; the real value is spliced in deterministically post-response' },
    ],
  },
  {
    scalar: 'sentence-cues-mode',
    group: 'Cues',
    camelCase: 'sentenceCuesMode',
    description: 'Sentence-scope cues — whole-sentence alternatives via `scope: sentence` cue declarations',
    menuTip: 'Whole-sentence alternative rewrites (e.g. more-formal, which is allow-listed to LinkedIn + web email). Highlights span the sentence; sentence-scope wins over overlapping word-cues. ON by default; each cue self-scopes via on-site / on-field, so nothing fires on casual surfaces it opts out of.',
    values: [
      { id: 'on',  description: 'Default — sentence cues fire on prose buffers (subject to each cue\'s own on-site/on-field scoping), suppressing word-cues for words inside the sentence span' },
      { id: 'off', description: 'Disabled — every `scope: sentence` cue is filtered at build time' },
    ],
  },
  {
    scalar: 'contradiction-cues-mode',
    group: 'Cues',
    camelCase: 'contradictionCuesMode',
    description: 'Deterministic fact-check cues — flags a stale/wrong claim you typed against the buffer + clock (weekday-date mismatch, split-the-bill math)',
    menuTip: 'Catch your own mistakes as you type: "Thursday the 24th" when the 24th is a Friday; "$120 among 4, $25 each" when it\'s $30. An LLM parses each sentence into a claim; the runtime computes the correction from data (clock, arithmetic, world-data) — so a cue can\'t hallucinate a false contradiction. ON by default; passive (never edits your buffer).',
    values: [
      { id: 'on',  description: 'Default — contradiction cues fire on prose (weekday-date, split-the-bill, and data-wired tiers)' },
      { id: 'off', description: 'Disabled — no contradiction fact-checking' },
    ],
  },
  {
    scalar: 'session-contradiction-mode',
    group: 'Cues',
    camelCase: 'sessionContradictionMode',
    description: 'Watchlist contradiction cues — flags a draft that goes against a decision you made earlier in this coding session (stack, constraints, memory/compaction, scope). A background producer distils the session transcript into a commitments watchlist; a fast model checks each draft against it. Works on hosts with a session transcript (Claude Code, OpenCode, Gemini CLI).',
    menuTip: 'Catch yourself contradicting the session: you agreed "runtime is Bun, not Node" earlier, then type "switch this to node". Two-stage — a slow producer builds the watchlist from the session transcript, a fast model matches your draft against it. LLM-authored advisory (passive; Ctrl+Alt+↑ applies the reconciled rewrite). ON by default, and inert without a session transcript — Claude Code, OpenCode, Gemini CLI and the DeepSeek Harness have one; chrome and shell do not, so it costs them nothing.',
    values: [
      { id: 'on',  description: 'Default — a fast model flags a draft that contradicts an earlier session decision' },
      { id: 'off', description: 'Disabled — no session-commitment matching, and no transcript distillation' },
    ],
  },
  {
    scalar: 'ask-cues-mode',
    group: 'Cues',
    camelCase: 'askCuesMode',
    description: 'AskUserQuestion cues — attaches an inline question with cyclable options to the sentence under your cursor, populated by the well-known AskUserQuestion tool prompt. The question is the tip; each option is a cycle alternative (options that carry a concrete rewrite edit the sentence; advisory ones just inform).',
    menuTip: 'Turn the sentence you\'re on into a question with options: "Substantiate the speed claim with data or qualify it?" → cycle "Add data" / "Qualify claim". Reuses the cue/cycling UI; the AskUserQuestion tool prompt populates it. Ambient (fires on the sentence at your cursor). One LLM call per new sentence (cached). OFF by default — benchmarking measured roughly one shown question in three as genuinely useful, and that is not a default-worthy hit rate; turn it on if the trade reads differently to you.',
    values: [
      { id: 'off', description: 'Disabled (default) — no tool-prompt question cues' },
      { id: 'on',  description: 'Enabled — the sentence at your cursor gets an AskUserQuestion-shaped cue when there is a question worth asking' },
    ],
  },
  {
    scalar: 'inline-cues-mode',
    group: 'Cues',
    camelCase: 'inlineCuesMode',
    description: 'Where passive cue advisories (sentence-cue / contradiction cue tips) appear — inline near the text or in the secondary display',
    menuTip: 'inline (default): a passive cue reveals its advisory as gray inline text when your caret enters the flagged span (Error-Lens style), on hosts that can paint it. secondary: the advisory stays in the status line. Hosts with no paint surface fall back to secondary automatically.',
    values: [
      { id: 'inline',    description: 'Default — reveal the advisory inline (gray) on cursor-in-span, degrading to the secondary display where inline paint is unavailable' },
      { id: 'secondary', description: 'Advisory shows only in the secondary display (status line)' },
    ],
  },
  {
    scalar: 'blank-trigger-mode',
    group: 'Blanks',
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
    group: 'Voice & navigation',
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
    group: 'Voice & navigation',
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
    group: 'Voice & navigation',
    camelCase: 'cursorNavigate',
    description: 'Auto-highlight word under cursor',
    menuTip: 'Auto-highlight word at cursor',
    values: [
      { id: 'inactive', description: 'Manual navigation only' },
      { id: 'active',   description: 'Highlight follows cursor to navigable words' },
    ],
  },
  {
    scalar: 'nav-keymap',
    group: 'Voice & navigation',
    camelCase: 'navKeymap',
    description: 'Modifier combo for word navigation + alternative cycling. `auto` resolves to ctrl-alt on every host. Chrome hard-pins ctrl-alt (ctrl-shift+arrow extends browser text selection). On macOS Terminal.app, enable "Use Option as Meta key" so Ctrl+Option+arrow survives as Meta-prefixed CSI — adapters coalesce it into the runtime\'s `alt`.',
    menuTip: 'Modifier combo for word nav (Left/Right) + alt cycling (Up/Down). `auto` → ctrl-alt everywhere. macOS Terminal.app users: enable "Use Option as Meta key" in profile settings.',
    values: [
      { id: 'auto',       description: 'Default — ctrl-alt on every host' },
      { id: 'ctrl-alt',   description: 'Ctrl+Alt+Arrow (Ctrl+Option+Arrow on macOS, needs Option-as-Meta in Terminal.app)' },
      { id: 'ctrl-shift', description: 'Ctrl+Shift+Arrow — manual override for terminals that forward ctrl-shift but not ctrl-alt. Chrome always uses ctrl-alt to avoid clobbering browser text selection' },
    ],
  },
  {
    scalar: 'debug-mode',
    group: 'Diagnostics',
    camelCase: 'debugMode',
    description: 'Verbose runtime logging (every cue/blank decision)',
    menuTip: 'Enable debug logging output',
    values: [
      { id: 'off', description: 'Debug logging suppressed' },
      { id: 'on',  description: 'Debug output emitted to console' },
    ],
  },
  {
    scalar: 'max-thinking',
    group: 'Agent & thinking',
    camelCase: 'maxThinking',
    description: 'How hard reasoning-capable models think. Each model has a bench-tuned ceiling (cerebras → medium, gpt-oss / gpt-5 → low); `on` uses that ceiling, `off` drops to a reduced level (cerebras → low, others → none) for faster, cheaper output. See packages/opencues-core/src/model-thinking.ts.',
    menuTip: 'Trade reasoning depth for speed. `on` lets each model think up to its ceiling; `off` minimises thinking for snappier blanks/cues.',
    values: [
      { id: 'on',  description: 'Default — each model reasons up to its ceiling (cerebras medium, gpt-oss/gpt-5 low)' },
      { id: 'off', description: 'Faster — each model drops to its reduced level (cerebras low, gpt-oss/gpt-5 none)' },
    ],
  },

  // ── Provider routing ─────────────────────────────────────────────
  //
  // Three buckets, one knob each. Surfaces map to buckets as follows:
  //   - cues:     word-cues, sentence-cues
  //   - auditors: auditors, agent-rewrite (prose-bearing background agents)
  //   - blanks:   fluid-blank, transform-blank, fluid-config, keyword blanks
  //
  // Both cues + auditors are prose-bearing — the resolver's trainsOnInput
  // guard refuses to wire them through opencode-zen (or any future
  // training-pool provider). Only `blanks-llm-provider` exposes the free
  // pool in its menu. Per-aspect overrides (`word-cues-provider`,
  // `fluid-blank-provider`, `auditor-provider`, `agent-provider`, …) stay
  // file-edit only and are NOT registered here — keeping the menu small
  // is the point of the three-bucket simplification.
  {
    scalar: 'cues-llm-provider',
    group: 'LLM routing',
    camelCase: 'cuesLlmProvider',
    description: 'LLM provider for cue sources (word-cues, sentence-cues). Inherits llm-provider by default.',
    menuTip: 'Pick the provider for cue sources (word-cues, sentence-cues). Refuses training-pool providers (opencode-zen) — prose surface.',
    values: CUES_PROVIDER_VALUES,
    // Live settings decorate `inherit` with what it resolves to right
    // now — see withInheritResolution. Static `values` stay as the
    // settings-less fallback.
    valuesProvider: (settings) => withInheritResolution(CUES_PROVIDER_VALUES, settings),
  },
  {
    scalar: 'auditors-llm-provider',
    group: 'LLM routing',
    camelCase: 'auditorsLlmProvider',
    description: 'LLM provider for auditor sources + agent-rewrite. Inherits llm-provider by default.',
    menuTip: 'Pick the provider for auditors + agent-rewrite (background prose rewriters). Refuses training-pool providers (opencode-zen).',
    values: AUDITORS_PROVIDER_VALUES,
    valuesProvider: (settings) => withInheritResolution(AUDITORS_PROVIDER_VALUES, settings),
  },
  {
    scalar: 'blanks-llm-provider',
    group: 'LLM routing',
    camelCase: 'blanksLlmProvider',
    description: 'LLM provider for blank-class sources (fluid-blank, transform-blank, fluid-config, keyword blanks). Inherits llm-provider by default.',
    menuTip: 'Pick the provider for blanks (the opt-in `_` surface). `opencode-zen` + `blanks-llm-model: free` routes blanks through OpenCode Zen\'s free pool (no API key; provider trains on blank inputs).',
    values: BLANKS_PROVIDER_VALUES,
    valuesProvider: (settings) => withInheritResolution(BLANKS_PROVIDER_VALUES, settings),
  },

  // ── Provider routing — model selection ───────────────────────────
  //
  // Each bucket has a paired model scalar whose valid values DEPEND ON
  // the sibling provider scalar. The valuesProvider callback enumerates
  // the current provider's `knownModels` so cycling Up/Down through
  // `auditors-llm-model` walks the models valid for whatever
  // `auditors-llm-provider` is currently set to.
  //
  // `default` is the first entry (so cycling lands there after a
  // provider change resets the pair). It means "use the provider's
  // defaultModel" — the resolver treats this as if the scalar were
  // absent. Concrete model ids appear AFTER default so the menu walks
  // default → model1 → model2 → … → default.
  {
    scalar: 'cues-llm-model',
    group: 'LLM routing',
    camelCase: 'cuesLlmModel',
    description: 'LLM model for the cues bucket. Valid values depend on `cues-llm-provider`.',
    menuTip: 'Pick the model for cues. Menu walks the current cues-llm-provider\'s known models.',
    values: [
      { id: 'default', description: 'Use the provider\'s default model' },
    ],
    valuesProvider: (settings) => buildModelValues(settings.get('cues-llm-provider'), settings.get('llm-provider')),
  },
  {
    scalar: 'auditors-llm-model',
    group: 'LLM routing',
    camelCase: 'auditorsLlmModel',
    description: 'LLM model for the auditors + agent-rewrite bucket. Valid values depend on `auditors-llm-provider`.',
    menuTip: 'Pick the model for auditors. Menu walks the current auditors-llm-provider\'s known models.',
    values: [
      { id: 'default', description: 'Use the provider\'s default model' },
    ],
    valuesProvider: (settings) => buildModelValues(settings.get('auditors-llm-provider'), settings.get('llm-provider')),
  },
  {
    scalar: 'blanks-llm-model',
    group: 'LLM routing',
    camelCase: 'blanksLlmModel',
    description: 'LLM model for the blanks bucket. Valid values depend on `blanks-llm-provider`.',
    menuTip: 'Pick the model for blanks. Menu walks the current blanks-llm-provider\'s known models.',
    values: [
      { id: 'default', description: 'Use the provider\'s default model' },
      { id: 'free', description: 'OpenCode Zen free pool (only valid when blanks-llm-provider is opencode-zen)' },
    ],
    valuesProvider: (settings) => buildModelValues(settings.get('blanks-llm-provider'), settings.get('llm-provider')),
  },

  // ── Context injection ────────────────────────────────────────────
  {
    scalar: 'ambient-context-mode',
    group: 'Context & identity',
    camelCase: 'ambientContextMode',
    description: 'Field label/placeholder/page-title sent with fluid-blank lookups (chrome only)',
    menuTip: 'Share focused-field label/placeholder/page-title with fluid-blank for disambiguation. Sensitive fields excluded. Chrome only.',
    values: [
      { id: 'off', description: 'Disabled (default) — host returns null; ambient block never built' },
      { id: 'on',  description: 'Enabled — ambient block injected into fluid-blank prompt' },
    ],
  },
  {
    // Renamed June 2026 from `sentinels-mode` → `identity-context-mode`  // LEGACY-NAME-ALLOW: historical narrative
    // to disambiguate from blank-context and ambient-context (now all
    // three are explicit "context" sources). No runtime back-compat
    // read — `opencues seed-configs` self-heals the legacy scalar.
    scalar: 'identity-context-mode',
    group: 'Context & identity',
    camelCase: 'identityContextMode',
    description: 'Personal identity data injected into fluid-blank as context tokens',
    menuTip: 'Inject ~/.cues/IDENTITY.md fields (first name, email, etc.) as identity-context tokens into fluid-blank for personalised lookups.',
    values: [
      { id: 'off',  description: 'Disabled — IDENTITY.md never read' },
      { id: 'safe', description: 'Tokens-only catalog (default) sent to LLM; post-processor substitutes values after response. PII stays on the host.' },
      // `raw` mode (catalog values inlined into the prompt — PII
      // reaches the LLM provider) is implementation-complete but
      // intentionally NOT cycleable from the menu — flipping it should
      // be a deliberate file edit, not a one-keystroke toggle. Phase 2
      // will revisit exposure alongside per-pack capability disclosure.
      { id: 'raw',  description: 'Catalog values inlined into prompt; PII reaches the LLM provider', exposeInMenu: false },
    ],
    prereqFile: {
      // ConfigLoader reads IDENTITY.md only — `opencues seed-configs`
      // self-heals the legacy USER.md / SENTINELS.md filenames into  // LEGACY-NAME-ALLOW: migration reference
      // IDENTITY.md on install. No runtime fallback.
      basename: 'IDENTITY.md',
      template: 'defaults/IDENTITY.md',
      mustHavePopulatedFields: true,
    },
    pushedBy: ['chrome-host'],
  },
  {
    // Grammar used to render identity-/blank-context sentinel tokens to
    // the LLM and to parse them back. `bare` (default) is the flat
    // [TOKEN] form every existing user is on — byte-identical behaviour.
    // `typed` switches to the parameterized + nested + field-access
    // grammar (bench-validated: parameterized +14pp cross-provider,
    // param-fill +47pp, nested composition 100% through depth 3). The
    // runtime engine + its evidence: packages/opencues-core/src/typed-sentinel.ts,
    // docs/architecture/typed-sentinel-language.md.
    scalar: 'sentinel-language',
    group: 'Context & identity',
    camelCase: 'sentinelLanguage',
    description: 'Grammar for rendering + resolving identity-/blank-context sentinel tokens',
    menuTip: 'Bare = flat [TOKEN] (default). Typed = parameterized + nested signatures ([STOCK PRICE(ticker=NVDA)], [WEATHER TEMP(city=[WORK CITY])]) — higher accuracy on parameter-bearing lookups.',
    values: [
      { id: 'bare',  description: 'Flat [TOKEN] form (default) — every existing catalog renders + resolves unchanged' },
      { id: 'typed', description: 'Typed/parameterized/nested signatures; runtime parses + resolves the richer grammar with validate-and-degrade' },
    ],
  },
  {
    scalar: 'blank-context-mode',
    group: 'Context & identity',
    camelCase: 'blankContextMode',
    description: 'Blanks expose their current values as ambient tokens for fluid-blank',
    menuTip: 'Expose context-eligible blanks (stocks, weather, crypto, …) as ambient tokens fluid-blank can reach without typing the keyword. See docs/features/blank-as-context.md.',
    values: [
      { id: 'off',  description: 'Disabled — blanks only fire on the keyword-trigger path' },
      { id: 'safe', description: 'Tokens-only catalog (default); post-processor substitutes live values after response. Bench-validated at 100% on Cerebras + Groq.' },
      // Same exposure rule as identity-context — raw is implemented but
      // kept off the menu. Requires identity-context-mode: raw too
      // (mode-gate composition pinned in docs/architecture/blank-as-context.md).
      { id: 'raw',  description: 'Live values inlined into the prompt; values reach the LLM provider', exposeInMenu: false },
    ],
  },
  {
    scalar: 'calendar-context-mode',
    group: 'Context & identity',
    camelCase: 'calendarContextMode',
    description: 'Ingest a bounded calendar snapshot so fluid-blank can answer availability/scheduling questions',
    menuTip: 'Let fluid-blank reason over your upcoming calendar — `am i free thursday _` answers from an ingested (bounded, periodic) calendar-feed snapshot. Titles + locations are dehydrated tokens the runtime hydrates locally; only anonymized busy-interval times reach the LLM. ON by default, but INERT until you add a feed with `opencues calendar add` — adding a calendar is the opt-in. See docs/architecture/calendar-context.md.',
    values: [
      { id: 'on',  description: 'Enabled (default) — ingest a bounded calendar snapshot; titles + locations dehydrated to tokens hydrated locally, only busy-interval times sent. Inert until you add a feed.' },
      { id: 'off', description: 'Disabled — no calendar ingestion even if a feed is configured' },
    ],
    // The shared calendar snapshot, produced OpenCues-side by `opencues
    // calendar sync`. No `template` (it's generated, not seeded). `pushedBy`
    // makes the chrome-host + `opencues sync chrome` carry it into the bundle
    // so the chrome extension consumes the same file native hosts read directly.
    prereqFile: { basename: 'calendar.json' },
    pushedBy: ['chrome-host'],
  },
  {
    scalar: 'statusbar-position',
    group: 'Appearance',
    camelCase: 'statusbarPosition',
    hostScope: ['chrome'],
    description: 'Where the chrome in-page status bar (tips, cycling, kata coach) sits. Chrome-only — the CLI hosts render into their own footer/statusline. A real FEATURE (not a MENU_TUNABLE) so the fluid-config intent classifier can route to it, e.g. `move the status bar to the top _`.',
    menuTip: 'Where the floating status bar sits on the page (chrome only).',
    values: [
      { id: 'bottom', description: 'Default — full-width band along the bottom' },
      { id: 'top',    description: 'Full-width band along the top' },
      { id: 'right',  description: 'Compact panel in the bottom-right corner' },
    ],
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
  /** Section in the `opencues config` browser — one of `SETTINGS_GROUP_ORDER`. */
  readonly group?: string;
  /** Cyclable values. First entry is the recommended default for the menu's initial render. */
  readonly values: readonly ValueSpec[];
  /**
   * Host scope. When set, the tunable only appears in the cycling menu
   * for the listed hosts. Use for host-specific knobs whose effect
   * only exists on certain hosts (e.g. chrome's dim-mix — terminal
   * hosts use ANSI dim escapes, not a per-channel mix). Omit for
   * host-universal tunables.
   */
  readonly hostScope?: readonly string[];
}

export const MENU_TUNABLES: readonly MenuTunableSpec[] = [
  {
    scalar: 'agent-debounce-ms',
    group: 'Agent & thinking',
    menuTip: 'Pause after last keystroke before AgentRewrite fires (ms). Misparse → 1000.',
    // Default first (matches the shipped OPENCUES.md + the consumer fallback).
    values: [
      { id: '1000', description: 'Default — balanced' },
      { id: '150',  description: 'Twitchy — fires almost immediately; great with cached rewrites, costly on cache misses' },
      { id: '250',  description: 'Snappy — fires before most users finish a word; noticeably more responsive than the default' },
      { id: '500',  description: 'Aggressive — fires shortly after each pause' },
      { id: '2000', description: 'Relaxed — only fires after a clear stop' },
    ],
  },
  {
    scalar: 'blank-context-prewarm-ms',
    group: 'Diagnostics',
    menuTip: 'Background refresh interval for the blank-context cache. Eliminates the ~200ms HTTP fan-out tax on the first `_` after launch by refreshing stocks/weather/crypto/HN in the background. `off` reverts to legacy lazy refresh.',
    // Default first (consumer fallback is 35000 when the scalar is absent).
    values: [
      { id: '35000',  description: 'Default — 35s; comfortably inside the 60s TTL so user-triggered calls always hit warm cache' },
      { id: 'off',    description: 'Disabled — cache refreshes lazily on prompt-build (legacy behaviour). Use on rate-limited keys.' },
      { id: '15000',  description: 'Aggressive — 15s; cache always fresh, ~40 HTTP calls/min to upstream sources' },
      { id: '60000',  description: 'Conservative — 60s; cache may refresh once on the first call after a long pause' },
      { id: '120000', description: 'Minimal — 120s; only suitable when context tokens change rarely' },
    ],
  },
  {
    scalar: 'max-concurrent-auditors',
    group: 'Agent & thinking',
    menuTip: 'Cap on parallel auditor calls per tick. 0 = uncapped. Bound LLM cost when many auditors are active.',
    values: [
      { id: '0', description: 'Uncapped — all enabled auditors fire each tick' },
      { id: '3', description: 'Bounded — top-3 priority-desc only' },
      { id: '5', description: 'Bounded — top-5 priority-desc only' },
    ],
  },
  {
    scalar: 'blank-loading-animation',
    group: 'Appearance',
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
    group: 'Appearance',
    menuTip: 'Per-frame duration in ms. Lower = snappier, higher = each colour stays visible longer.',
    // Default first (matches the shipped OPENCUES.md `blank-loading-interval-ms: 150`).
    values: [
      { id: '150', description: 'Snappy (default) — 150ms per frame' },
      { id: '75',  description: 'Rapid — 75ms per frame, blurs into motion' },
      { id: '300', description: 'Slow — 300ms per frame, each colour holds twice as long' },
    ],
  },
  {
    scalar: 'dim-mix',
    group: 'Appearance',
    menuTip: 'How far the dim (unfocused) colour is mixed toward the page background. 0 = identical to host text colour; 100 = fully blended (invisible).',
    // Every BROWSER host, not chrome specifically: the setting exists
    // because the dim colour is mixed toward a *page* background, which is
    // true of any host rendering into a DOM. `statusbar-position` below
    // stays chrome-only on purpose — that one is about a surface chrome
    // draws, not about being in a browser.
    hostScope: BROWSER_HOSTS,
    // Default first (chrome's derive-colours default is dimMix 0.45).
    values: [
      { id: '45',  description: 'Default — moderate fade' },
      { id: '0',   description: 'Off — no dim; cue + non-cue words render identically' },
      { id: '25',  description: 'Subtle — barely faded' },
      { id: '65',  description: 'Strong — clearly faded' },
      { id: '85',  description: 'Heavy — nearly invisible non-cue text' },
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
export function getMenuDefinitions(
  hostName?: string,
  settings?: ReadonlyMap<string, string>,
): Map<string, {
  readonly tip?: string;
  readonly group?: string;
  readonly valueOrder: readonly string[];
  readonly valueTips: ReadonlyMap<string, string>;
}> {
  const out = new Map<string, { tip?: string; group?: string; valueOrder: readonly string[]; valueTips: ReadonlyMap<string, string> }>();

  // Features first (in declaration order), then tunables. Match the
  // original OPENCUES.md ordering so the menu's first-setting probe
  // returns the same first scalar.
  const emptySettings: ReadonlyMap<string, string> = new Map();
  for (const f of FEATURES) {
    // Host-scope filter — when hostScope is set, only include the feature
    // if the current host matches. Omitted hostScope = universal. Mirrors
    // the MENU_TUNABLES loop below.
    if (f.hostScope && hostName && !f.hostScope.includes(hostName)) continue;
    // Dynamic values take precedence when valuesProvider is present —
    // used by `*-llm-model` scalars whose valid range depends on the
    // sibling provider scalar's current value.
    const dynamic = f.valuesProvider ? f.valuesProvider(settings ?? emptySettings) : null;
    const source = dynamic ?? f.values;
    const cyclable = source.filter(v => v.exposeInMenu !== false);
    if (cyclable.length === 0) continue;
    const tips = new Map<string, string>();
    for (const v of cyclable) tips.set(v.id, v.description);
    out.set(f.scalar, {
      tip: f.menuTip ?? f.description,
      group: f.group,
      valueOrder: cyclable.map(v => v.id),
      valueTips: tips,
    });
  }
  for (const t of MENU_TUNABLES) {
    // Host-scope filter — when hostScope is set, only include the
    // tunable if the current host matches one of the listed names.
    // Omitted hostScope = universal (every host sees it).
    if (t.hostScope && hostName && !t.hostScope.includes(hostName)) continue;
    const tips = new Map<string, string>();
    for (const v of t.values) tips.set(v.id, v.description);
    out.set(t.scalar, {
      tip: t.menuTip,
      group: t.group,
      valueOrder: t.values.map(v => v.id),
      valueTips: tips,
    });
  }
  return out;
}

/**
 * Section display order for the `opencues config` browser. Each FEATURE /
 * MENU_TUNABLE declares its `group:`; this array orders the sections. A group
 * not listed here is appended after (alphabetically) — but every current
 * group IS listed, pinned by a registry test.
 */
export const SETTINGS_GROUP_ORDER: readonly string[] = [
  'Cues',
  'Blanks',
  'Context & identity',
  'Agent & thinking',
  'Voice & navigation',
  'LLM routing',
  'Appearance',
  'Diagnostics',
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
