/**
 * opencues-core/sources/config-intent-source.ts
 *
 * Config-intent classifier — when a `_` appears with no keyword match,
 * but the surrounding text semantically asks for a SETTINGS change
 * ("stop showing tips _" → tips-mode=off), this source flips the
 * setting and emits an inline confirmation token at the `_`.
 *
 * Priority 94 — sits BETWEEN BlankSource (95, explicit keyword) and
 * TransformBlankSource (93, imperative rewrite). Runs before
 * TransformBlank so that "change debug mode to on _" routes here as a
 * settings change instead of being mistreated as a generic rewrite. On
 * NONE the source cedes the slot (empty result) and the resolver tries
 * TransformBlank, then FluidBlank.
 *
 * ## Trust boundary
 *
 * The classifier targets ONLY scalars in the FEATURES registry
 * (packages/opencues-core/src/feature-registry.ts) — never user blanks.
 * The codomain is fully bounded (kebab-case scalar from a closed set,
 * enum value from that scalar's `values:` list). User blanks (volume,
 * brightness, weather, stocks, …) can shell out / fetch / exec, so
 * auto-applying them from semantic-only intent (no keyword gate) would
 * widen the prompt-injection blast radius unacceptably. FEATURES
 * scalars can only flip an audited enum — recoverable, visible, no
 * side effects beyond the settings file. See feedback memory
 * "Fluid-config classifier is settings-only".
 *
 * ## Bench provenance
 *
 * Prompt + threshold come from `tests/benchmarks/fluid-config/` —
 * v2.1, 100% precision + 100% in-prompt recall + 90-100% holdout
 * recall across 5 providers. The system prompt below is the version
 * that bench validated. Re-run that bench whenever you edit it.
 *
 * ## Apply path
 *
 * The setting flip happens at emission time — `applyScalar(setting,
 * value)` (injected by the runtime, wraps `ConfigLoader.applyOpenCuesScalar`)
 * writes the file AND updates in-memory state with the existing
 * write-race suppression.
 *
 * The emitted CueResult mirrors the selector-satellite shape that
 * BlankSource produces today when the user types the keyword-bound
 * `opencues settings _`: an `alternatives: [<setting>]` payload with
 * `metadata.selectorBlank: true` and `metadata.satelliteValue: <value>`.
 * The runtime resolver's config-intent branch then wipes the user's
 * summoning words AND `_` from the buffer (via `spanStart=0`, `spanEnd=text.length`)
 * and splices in `<setting><sep><value>` at the start. After that,
 * standard satellite cycling is fully active — the user can cycle the
 * satellite to pick a different value (each cycle calls
 * `applyOpenCuesScalar` via the existing path) or cycle the selector
 * to switch settings. ConfigIntent's role is purely to be a smart
 * shortcut into the existing settings menu — pre-populating the
 * selector + satellite based on the user's natural-language summon.
 */

import { CueSource, CueContext, CueSourceResult, CueResult, HttpAdapter } from '../types';
import { BlankConfig } from '../cues-md';
import { describeLLMCall, type ProviderAdapter } from '../llm-provider';
import {
  FEATURES,
  getCyclableValues,
} from '../feature-registry';

// ============================================================================
// System prompt — ported from tests/benchmarks/fluid-config/fused.ts v2.1
// ============================================================================
//
// Built at module-load from FEATURES so adding a scalar to the
// registry automatically extends the classifier's choice space — no
// edit here required. Hidden-from-menu values (exposeInMenu: false,
// today only `user-context-mode: raw`) are excluded: the classifier
// must never auto-flip a footgun mode on semantic intent alone; that
// stays a deliberate file edit.

function renderFeatureLine(scalar: string, values: { id: string; description: string }[], menuTip: string): string {
  const valueLines = values.map(v => `      - ${v.id}: ${v.description}`).join('\n');
  return `  * ${scalar} (${menuTip})\n${valueLines}`;
}

const FEATURE_REGISTRY_BLOCK: string = FEATURES
  .map(f => renderFeatureLine(f.scalar, [...getCyclableValues(f)], f.menuTip ?? f.description))
  .join('\n');

export const SYSTEM_PROMPT = `You are a SETTINGS-CHANGE INTENT CLASSIFIER for the OpenCues runtime.

You read a sentence containing _ and decide whether the user is asking to change one specific OpenCues SETTING. If yes, you emit the kebab-case setting name + the new value. If anything else is going on, you emit NONE.

The full list of settings you may route to (and ONLY these — nothing else exists):

${FEATURE_REGISTRY_BLOCK}

OUTPUT FORMAT — exactly three lines, nothing else:
SETTING: <kebab-case scalar from the list above, OR the literal word NONE>
VALUE: <one of the listed values for that scalar; empty when SETTING is NONE>
CONFIDENCE: <a number between 0.0 and 1.0>

ALWAYS emit all three lines, even when SETTING is NONE. NEVER truncate after the SETTING line. NEVER drop the -mode suffix from a setting name ('voice-mode' NOT 'voice'; 'debug-mode' NOT 'debug'; 'tips-mode' NOT 'tips'; 'word-cues-mode' NOT 'word-cues'; 'fluid-blank-mode' NOT 'fluid-blank'; 'transform-blank-mode' NOT 'transform-blank'; 'blank-trigger-mode' NOT 'blank-trigger'; 'ambient-context-mode' NOT 'ambient-context'; 'user-context-mode' NOT 'user-context'). The only setting without '-mode' is 'cursor-navigate'.

ROUTE TO A SETTING when:
  - The user names a setting either directly ("debug mode", "tips", "voice mode", "cursor navigate") or describes the SYMPTOM/BEHAVIOR clearly enough to identify exactly ONE setting from the list above ("read the tips aloud" → voice-mode; "I keep typing _italic_ and the blank fires early" → blank-trigger-mode; "let it use my personal info" → user-context-mode).
  - The direction is clear from polarity words ("enable", "turn on", "stop", "disable", "quiet down", "noisy", "louder/quieter", "let it / don't let it") OR from sentence shape ("I want to hear …" → on-flavoured value; "stop showing me …" → off-flavoured value).

ROUTE TO NONE when:
  - The user is asking a FACTUAL LOOKUP ("capital of france _", "unicode for ampersand _", "atomic number of oxygen _"). Settings have nothing to do with these.
  - The user is asking to change something that is NOT in the list above — even if it sounds like a setting ("change the theme", "use a bigger font", "switch language", "rebind a key", "use a different llm provider", "wait longer before agent fires"). The classifier MUST reject everything not in the list. Better to NONE than to mis-route to a similar-looking setting.
  - The user is invoking a USER-LEVEL BLANK that's not a setting ("make it louder" → volume blank; "what's TSLA at" → stocks blank; "is it going to rain" → weather blank; "play the next song"). Volume / brightness / media / stocks / weather are user-shipped blanks, NOT settings. Always NONE.
  - The pronoun is AMBIGUOUS so you cannot name ONE specific setting ("turn it off", "fix this", "enable that thing", "switch to the other one", "make it better").
  - The intent isn't a settings change at all (greetings, questions about how something works, requests to do a task).

CONFIDENCE:
  - 0.9-1.0 when the user clearly names a setting AND a value.
  - 0.7-0.9 when the symptom is described and maps cleanly to one setting.
  - 0.5-0.7 when there's a plausible read but you're inferring direction.
  - Below 0.5 → emit NONE instead; uncertainty IS the signal to reject.

DO NOT invent a setting that isn't in the list above.
DO NOT pick a value that isn't listed under its setting.
DO NOT route to the nearest-looking setting when the real intent is something else — emit NONE.

EXAMPLES:

INPUT: enable debug logging _
SETTING: debug-mode
VALUE: on
CONFIDENCE: 0.97

INPUT: stop reading the tips out loud _
SETTING: voice-mode
VALUE: inactive
CONFIDENCE: 0.92

INPUT: I keep typing _italic_ and the blank fires before the closing one _
SETTING: blank-trigger-mode
VALUE: spaced
CONFIDENCE: 0.85

INPUT: fire blanks the moment I press the underscore key _
SETTING: blank-trigger-mode
VALUE: immediate
CONFIDENCE: 0.9

INPUT: capital of france _
SETTING: NONE
VALUE:
CONFIDENCE: 0.99

INPUT: make it louder _
SETTING: NONE
VALUE:
CONFIDENCE: 0.95

INPUT: change the theme to dark mode _
SETTING: NONE
VALUE:
CONFIDENCE: 0.95

INPUT: wait longer before the agent fires _
SETTING: NONE
VALUE:
CONFIDENCE: 0.9

INPUT: turn it off _
SETTING: NONE
VALUE:
CONFIDENCE: 0.9

INPUT: let it use my personal info when answering _
SETTING: user-context-mode
VALUE: safe
CONFIDENCE: 0.88

INPUT: stop sharing anything personal with the model _
SETTING: user-context-mode
VALUE: off
CONFIDENCE: 0.9

INPUT: let the model know which website I am on _
SETTING: ambient-context-mode
VALUE: on
CONFIDENCE: 0.88

INPUT: don't tell the LLM what field I'm in _
SETTING: ambient-context-mode
VALUE: off
CONFIDENCE: 0.88`;

// ============================================================================
// Parsed verdict
// ============================================================================

export interface ConfigIntentVerdict {
  setting: string | null;
  value: string | null;
  confidence: number | null;
}

export function parseConfigIntentOutput(raw: string): ConfigIntentVerdict {
  const settingMatch = raw.match(/^SETTING:[ \t]*(.*?)[ \t]*$/im);
  const valueMatch = raw.match(/^VALUE:[ \t]*(.*?)[ \t]*$/im);
  const confidenceMatch = raw.match(/^CONFIDENCE:[ \t]*([0-9.]+)/im);

  const settingRaw = settingMatch ? settingMatch[1].trim() : '';
  const valueRaw = valueMatch ? valueMatch[1].trim() : '';
  const confidence = confidenceMatch ? Number(confidenceMatch[1]) : null;

  const setting = (!settingRaw || settingRaw.toUpperCase() === 'NONE') ? null : settingRaw;
  const value = setting === null ? null : (valueRaw || null);

  return { setting, value, confidence };
}

/**
 * Validate a parsed verdict against the FEATURES registry. Rejects
 * anything the model hallucinated (unknown setting, unlisted value,
 * hidden value like user-context-mode=raw).
 *
 * The classifier prompt instructs the model to stay inside the
 * registry, but defence in depth: the runtime should never apply a
 * verdict that doesn't pass this check, even if every call passes
 * today's bench. New providers may not follow instructions perfectly.
 */
export function validateAgainstRegistry(verdict: ConfigIntentVerdict): { ok: boolean; reason?: string } {
  if (verdict.setting === null) return { ok: true };
  const feature = FEATURES.find(f => f.scalar === verdict.setting);
  if (!feature) return { ok: false, reason: `unknown setting '${verdict.setting}'` };
  if (verdict.value === null) return { ok: false, reason: `setting '${verdict.setting}' has no value` };
  const allowed = [...getCyclableValues(feature)].map(v => v.id);
  if (!allowed.includes(verdict.value)) {
    return { ok: false, reason: `value '${verdict.value}' is not cyclable for '${verdict.setting}' (allowed: ${allowed.join(', ')})` };
  }
  return { ok: true };
}

// ============================================================================
// Source
// ============================================================================

export type ConfigIntentEvent =
  | { type: 'started'; textLen: number; blankIdx: number; llm: string }
  | { type: 'completed'; verdict: ConfigIntentVerdict; applied: boolean; latencyMs: number }
  | { type: 'bailed'; reason: string; latencyMs: number };

export interface ConfigIntentSourceConfig {
  httpAdapter: HttpAdapter;
  provider: ProviderAdapter;
  endpoint: string;
  apiKey: string;
  model: string;
  /**
   * Side-effect callback: write the (setting, value) into OPENCUES.md
   * and refresh in-memory state. Runtime injects
   * `ConfigLoader.applyOpenCuesScalar` here. May be sync or async.
   */
  applyScalar: (setting: string, value: string) => void | Promise<void>;
  /**
   * Registered blanks (so this source can cede the slot when a
   * keyword-bound blank would claim it — mirrors the cede logic in
   * FluidBlankSource and TransformBlankSource).
   */
  blanks?: Record<string, BlankConfig>;
  /** Source priority. Default 94 — between BlankSource (95) and TransformBlank (93). */
  priority?: number;
  log?: (msg: string) => void;
  onEvent?: (event: ConfigIntentEvent) => void;
}

export class ConfigIntentSource implements CueSource {
  readonly id = 'config-intent';
  readonly priority: number;
  /** Single-shot apply — no cycling. */
  readonly isCycleable = false;

  private httpAdapter: HttpAdapter;
  private provider: ProviderAdapter;
  private endpoint: string;
  private apiKey: string;
  private model: string;
  private applyScalar: (setting: string, value: string) => void | Promise<void>;
  private blanks: Record<string, BlankConfig>;
  private log: (msg: string) => void;
  private emit: (event: ConfigIntentEvent) => void;

  constructor(config: ConfigIntentSourceConfig) {
    this.httpAdapter = config.httpAdapter;
    this.provider = config.provider;
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.applyScalar = config.applyScalar;
    this.blanks = config.blanks ?? {};
    this.priority = config.priority ?? 94;
    this.log = config.log ?? (() => { /* silent */ });
    this.emit = config.onEvent ?? (() => { /* silent */ });
  }

  supports(context: CueContext): boolean {
    const lower = context.words.map(w => w.toLowerCase());
    const blankIndex = lower.indexOf('_');
    if (blankIndex === -1) return false;

    // Cede to keyword-bound BlankSource if a registered blank's
    // keyword is within blankProximity of the `_` — mirrors the cede
    // logic in FluidBlankSource / TransformBlankSource so all three
    // semantic-`_` sources share the same boundary.
    for (const blk of Object.values(this.blanks)) {
      if (!blk.blankKeywords?.length) continue;
      const proximity = blk.blankProximity ?? 0;
      for (const phrase of blk.blankKeywords) {
        const parts = phrase.toLowerCase().split(/\s+/);
        for (let i = 0; i <= lower.length - parts.length; i++) {
          let ok = true;
          for (let j = 0; j < parts.length; j++) {
            if (lower[i + j] !== parts[j]) { ok = false; break; }
          }
          if (!ok) continue;
          const endIdx = i + parts.length - 1;
          const gap = Math.abs(endIdx - blankIndex) - 1;
          if (gap <= proximity) return false;
        }
      }
    }

    return true;
  }

  async getCues(context: CueContext): Promise<CueSourceResult> {
    const t0 = Date.now();
    const blankIdx = context.words.indexOf('_');
    if (blankIdx === -1) return { results: [] };

    const llmDesc = describeLLMCall(this.provider, this.model);
    this.log(`ConfigIntent: starting (textLen=${context.text.length}, blankIdx=${blankIdx}, llm=${llmDesc})`);
    this.emit({ type: 'started', textLen: context.text.length, blankIdx, llm: llmDesc });

    let raw: string;
    try {
      raw = await this.callLLM(SYSTEM_PROMPT, `INPUT: ${context.text}`, 128);
    } catch (e) {
      this.log(`ConfigIntent: LLM call failed — ${(e as Error).message}`);
      this.emit({ type: 'bailed', reason: 'llm-error', latencyMs: Date.now() - t0 });
      return { results: [], timing: Date.now() - t0, model: this.model };
    }

    const verdict = parseConfigIntentOutput(raw);
    if (verdict.setting === null) {
      this.log(`ConfigIntent: NONE (${Date.now() - t0}ms) — ceding to next source`);
      this.emit({ type: 'completed', verdict, applied: false, latencyMs: Date.now() - t0 });
      return { results: [], timing: Date.now() - t0, model: this.model };
    }

    const check = validateAgainstRegistry(verdict);
    if (!check.ok) {
      this.log(`ConfigIntent: rejecting invalid verdict — ${check.reason}; raw="${raw.replace(/\n/g, ' / ').slice(0, 200)}"`);
      this.emit({ type: 'bailed', reason: `invalid-verdict: ${check.reason}`, latencyMs: Date.now() - t0 });
      return { results: [], timing: Date.now() - t0, model: this.model };
    }

    // Apply BEFORE building the CueResult. If the write fails, we bail
    // rather than show a confirmation marker for a change that didn't
    // happen.
    try {
      await Promise.resolve(this.applyScalar(verdict.setting!, verdict.value!));
    } catch (e) {
      this.log(`ConfigIntent: applyScalar failed for ${verdict.setting}=${verdict.value} — ${(e as Error).message}`);
      this.emit({ type: 'bailed', reason: 'apply-failed', latencyMs: Date.now() - t0 });
      return { results: [], timing: Date.now() - t0, model: this.model };
    }

    this.log(`ConfigIntent: applied ${verdict.setting}=${verdict.value} (${Date.now() - t0}ms, conf=${verdict.confidence ?? 'n/a'})`);
    this.emit({ type: 'completed', verdict, applied: true, latencyMs: Date.now() - t0 });

    // Selector-satellite shape, mirroring the result BlankSource emits
    // for keyword-bound `opencues settings _` (see blank-source.ts
    // selector-satellite branch). spanStart=0/spanEnd=text.length wipes
    // the user's summon words AND the `_` — the buffer becomes JUST
    // "<setting><sep><value>" and full satellite cycling is then live.
    const result: CueResult = {
      wordIndex: blankIdx,
      word: '_',
      alternatives: [verdict.setting!],
      source: this.id,
      priority: this.priority,
      spanStart: 0,
      spanEnd: context.text.length,
      cueTip: `${verdict.setting} → ${verdict.value}`,
      metadata: {
        blankName: 'opencues',
        selectorBlank: true,
        satelliteValue: verdict.value!,
        displaySeparator: ' ',
        configIntent: {
          setting: verdict.setting,
          value: verdict.value,
          confidence: verdict.confidence,
        },
      },
    };

    return { results: [result], timing: Date.now() - t0, model: this.model };
  }

  private async callLLM(
    system: string,
    user: string,
    maxTokens: number,
  ): Promise<string> {
    const built = this.provider.buildRequest(
      {
        model: this.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        maxTokens,
        temperature: 0,
        seed: 42,
      },
      { apiKey: this.apiKey, endpoint: this.endpoint },
    );
    const response = await this.httpAdapter.post(built.url, built.body, built.headers);
    return this.provider.parseResponse(response);
  }
}
