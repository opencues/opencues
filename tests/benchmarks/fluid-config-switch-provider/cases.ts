/**
 * Cases for the fluid-config switch-provider bench.
 *
 * The classifier now supports THREE intents (see config-intent-source.ts's
 * SYSTEM_PROMPT):
 *
 *   - SETTING  — flip an OPENCUES.md scalar  (covered by ../fluid-config/)
 *   - PROVIDER — switch a bucket's LLM provider (and optionally model)
 *   - NONE     — anything else
 *
 * This suite covers the PROVIDER intent + the new bucket-routing
 * paths it opens up + the trust-class guard. Setting and lookup paths
 * are sanity-checked here too (regression coverage — they must still
 * route correctly after the prompt rewrite).
 *
 * Six buckets:
 *
 *   - hit-provider-only      — clean provider switch, no model named
 *   - hit-provider-and-model — provider + specific model from knownModels
 *   - hit-model-implies-provider — model name only; LLM should infer provider
 *   - reject-trains-on-input — opencode-zen routed to cues/auditors (guard)
 *   - reject-unknown         — model/provider the registry doesn't know
 *   - regression-setting     — INTENT A setting changes still work
 *   - regression-none        — pure lookups + provider-mentions that aren't switches
 */

import type { BucketScope } from '../../../packages/opencues-core/src/sources/config-intent-source';

export interface ExpectedProviderHit {
  readonly kind: 'provider';
  readonly scope: BucketScope;
  readonly provider: string;
  /** null = classifier may emit any model (or empty), don't pin one. */
  readonly model: string | null;
  /** When the LLM picks an ambiguous-but-valid alternative, count it as a hit. */
  readonly providerAlternates?: readonly string[];
  readonly modelAlternates?: readonly string[];
}
export interface ExpectedSettingHit {
  readonly kind: 'setting';
  readonly setting: string;
  readonly value: string;
}
export interface ExpectedNone {
  readonly kind: 'none';
}
export type Expected = ExpectedProviderHit | ExpectedSettingHit | ExpectedNone;

export interface SwitchProviderCase {
  readonly id: string;
  readonly category:
    | 'hit-provider-only'
    | 'hit-provider-and-model'
    | 'hit-model-implies-provider'
    | 'reject-trains-on-input'
    | 'reject-unknown'
    | 'regression-setting'
    | 'regression-none';
  readonly input: string;
  readonly expected: Expected;
}

export const CASES: SwitchProviderCase[] = [
  // ── hit-provider-only ───────────────────────────────────────────────

  { id: 'po-cues-anthropic',
    category: 'hit-provider-only',
    input: 'use anthropic for cues _',
    expected: { kind: 'provider', scope: 'cues', provider: 'anthropic', model: null } },

  { id: 'po-blanks-cerebras',
    category: 'hit-provider-only',
    input: 'switch the blanks brain to cerebras _',
    expected: { kind: 'provider', scope: 'blanks', provider: 'cerebras', model: null } },

  { id: 'po-auditors-groq',
    category: 'hit-provider-only',
    input: 'route auditors through groq _',
    expected: { kind: 'provider', scope: 'auditors', provider: 'groq', model: null } },

  { id: 'po-cues-gemini',
    category: 'hit-provider-only',
    input: 'make cues use gemini _',
    expected: { kind: 'provider', scope: 'cues', provider: 'gemini', model: null } },

  { id: 'po-everything-default-blanks',
    category: 'hit-provider-only',
    // "everything" / "globally" / bare phrases default to the blanks
    // bucket — the user-opt-in `_` surface is the most likely target
    // for a bucket-less provider switch.
    input: 'route everything to gemini _',
    expected: { kind: 'provider', scope: 'blanks', provider: 'gemini', model: null } },

  { id: 'po-bare-switch-to-anthropic',
    category: 'hit-provider-only',
    input: 'switch to anthropic _',
    expected: { kind: 'provider', scope: 'blanks', provider: 'anthropic', model: null } },

  { id: 'po-bare-use-cerebras',
    category: 'hit-provider-only',
    input: 'use cerebras _',
    expected: { kind: 'provider', scope: 'blanks', provider: 'cerebras', model: null } },

  { id: 'po-bare-switch-to-gemini',
    category: 'hit-provider-only',
    input: 'switch to gemini _',
    expected: { kind: 'provider', scope: 'blanks', provider: 'gemini', model: null } },

  { id: 'po-blanks-fluid-keyword',
    category: 'hit-provider-only',
    input: 'use openai for the fluid-blank stuff _',
    expected: { kind: 'provider', scope: 'blanks', provider: 'openai', model: null } },

  { id: 'po-auditors-agent-keyword',
    category: 'hit-provider-only',
    input: 'switch the agent to anthropic _',
    expected: { kind: 'provider', scope: 'auditors', provider: 'anthropic', model: null } },

  // ── hit-provider-and-model ──────────────────────────────────────────

  { id: 'pm-anthropic-opus-auditors',
    category: 'hit-provider-and-model',
    input: 'use claude opus for auditors _',
    expected: { kind: 'provider', scope: 'auditors', provider: 'anthropic', model: 'claude-opus-4-7' } },

  { id: 'pm-openai-5.4-cues',
    category: 'hit-provider-and-model',
    input: 'use openai gpt-5.4 for cues _',
    expected: { kind: 'provider', scope: 'cues', provider: 'openai', model: 'gpt-5.4' } },

  { id: 'pm-cerebras-gpt-oss-blanks',
    category: 'hit-provider-and-model',
    input: 'route blanks to cerebras gpt-oss-120b _',
    expected: { kind: 'provider', scope: 'blanks', provider: 'cerebras', model: 'gpt-oss-120b' } },

  { id: 'pm-gemini-pro-cues',
    category: 'hit-provider-and-model',
    input: 'use gemini pro for cues _',
    expected: { kind: 'provider', scope: 'cues', provider: 'gemini', model: 'gemini-3.1-pro' } },

  { id: 'pm-anthropic-sonnet-auditors',
    category: 'hit-provider-and-model',
    input: 'switch auditors to claude sonnet _',
    expected: { kind: 'provider', scope: 'auditors', provider: 'anthropic', model: 'claude-sonnet-4-6' } },

  // ── hit-model-implies-provider ──────────────────────────────────────
  //
  // User names a model only — classifier should infer the provider
  // from the catalogue.

  { id: 'mi-opus-auditors',
    category: 'hit-model-implies-provider',
    input: 'use opus for the auditors _',
    expected: { kind: 'provider', scope: 'auditors', provider: 'anthropic', model: 'claude-opus-4-7',
                providerAlternates: ['claude-cli'], modelAlternates: ['opus'] } },

  { id: 'mi-gpt54-cues',
    category: 'hit-model-implies-provider',
    input: 'use gpt-5.4 for cues _',
    expected: { kind: 'provider', scope: 'cues', provider: 'openai', model: 'gpt-5.4',
                providerAlternates: ['openai-subscription'] } },

  { id: 'mi-haiku-cues',
    category: 'hit-model-implies-provider',
    // "haiku" alone is ambiguous (anthropic full name vs claude-cli
    // alias). Adding "claude" disambiguates per the prompt examples.
    input: 'use claude haiku for cues _',
    expected: { kind: 'provider', scope: 'cues', provider: 'anthropic', model: 'claude-haiku-4-5-20251001',
                providerAlternates: ['claude-cli'], modelAlternates: ['haiku'] } },

  { id: 'mi-gemini-flash-blanks',
    category: 'hit-model-implies-provider',
    input: 'use gemini-3.1-flash for blanks _',
    expected: { kind: 'provider', scope: 'blanks', provider: 'gemini', model: 'gemini-3.1-flash' } },

  // ── reject-trains-on-input ──────────────────────────────────────────
  //
  // opencode-zen is the only trainsOnInput provider today. Prompt
  // documents it as blanks-only; validator enforces it structurally.
  // Bench failure here would mean we'd silently route prose to a
  // training pool — security bug.

  { id: 'rt-zen-cues',
    category: 'reject-trains-on-input',
    input: 'use opencode-zen for cues _',
    expected: { kind: 'none' } },

  { id: 'rt-zen-auditors',
    category: 'reject-trains-on-input',
    input: 'route the auditors through the free pool _',
    expected: { kind: 'none' } },

  { id: 'rt-zen-blanks-ok',
    category: 'hit-provider-only',  // intentionally a hit — opencode-zen on blanks IS allowed
    input: 'use opencode-zen for blanks _',
    expected: { kind: 'provider', scope: 'blanks', provider: 'opencode-zen', model: null,
                modelAlternates: ['free', 'big-pickle'] } },

  // ── reject-unknown ──────────────────────────────────────────────────

  { id: 'ru-fake-provider',
    category: 'reject-unknown',
    input: 'use chatgpt-deluxe for cues _',
    expected: { kind: 'none' } },

  { id: 'ru-fake-model-graceful',
    // Graceful degrade: when the model is unrecognised but the
    // provider IS known, the classifier may emit the provider switch
    // without a model. Validator passes (provider-only is valid);
    // user gets the provider's defaultModel. This is "safe outcome";
    // we accept it. The strict-NONE behaviour is also fine — both
    // outcomes are non-security-critical.
    category: 'hit-provider-only',
    input: 'use anthropic claude-sonnet-9-9 for cues _',
    expected: { kind: 'provider', scope: 'cues', provider: 'anthropic', model: null } },

  { id: 'ru-vague-model',
    category: 'reject-unknown',
    input: 'use the best model for cues _',
    expected: { kind: 'none' } },

  // ── regression-setting ──────────────────────────────────────────────
  //
  // The new prompt has THREE intents. Make sure setting-changes still
  // route correctly and don't get hijacked by the provider intent.

  { id: 'rs-debug-on',
    category: 'regression-setting',
    input: 'enable debug logging _',
    expected: { kind: 'setting', setting: 'debug-mode', value: 'on' } },

  { id: 'rs-voice-off',
    category: 'regression-setting',
    input: 'stop reading the tips out loud _',
    expected: { kind: 'setting', setting: 'voice-mode', value: 'inactive' } },

  { id: 'rs-tips-off',
    category: 'regression-setting',
    input: 'hide the tip popups _',
    expected: { kind: 'setting', setting: 'tips-mode', value: 'off' } },

  { id: 'rs-ambient-on',
    category: 'regression-setting',
    input: 'let the model know which website I am on _',
    expected: { kind: 'setting', setting: 'ambient-context-mode', value: 'on' } },

  // ── regression-none ─────────────────────────────────────────────────

  { id: 'rn-lookup',
    category: 'regression-none',
    input: 'capital of france _',
    expected: { kind: 'none' } },

  { id: 'rn-user-blank',
    category: 'regression-none',
    input: 'make it louder _',
    expected: { kind: 'none' } },

  { id: 'rn-mentions-provider-but-not-switch',
    category: 'regression-none',
    // Mentions a provider name but in a Q&A context, not a switch.
    input: 'what is anthropic _',
    expected: { kind: 'none' } },

  { id: 'rn-ambiguous-pronoun',
    category: 'regression-none',
    input: 'switch it to the other one _',
    expected: { kind: 'none' } },
];
