/**
 * opencues-core/sources/blank-intent-source.ts
 *
 * BlankIntent — the LLM invocation GATE for script-backed blanks
 * (volume, brightness, weather, stocks, crypto, dictionary, countries,
 * hackernews, any `blankScript:` / `impl:` entry).
 *
 * ## What it is (and is NOT)
 *
 * This is NOT a `CueSource`. It emits no cues. It is a single-purpose
 * classifier the runtime's `BlankFill` module consults BEFORE running a
 * keyword-matched blank's script. Given the live buffer + the catalog of
 * in-scope blanks, it answers ONE question: is this `_` a genuine
 * INVOCATION of the matched tool, or is the keyword just prose (CEDE)?
 *
 * ## Why it exists
 *
 * Today a registered keyword within `blankProximity` words of `_`
 * UNCONDITIONALLY runs the blank's script — so `the weather was lovely
 * today _` fires a weather fetch (over-fire), while a wide proximity
 * window is needed to catch real invocations like `what is the weather
 * in london _`. One distance knob can't give both precision and recall.
 * BlankIntent keeps the keyword as the deterministic CONSENT atom ("the
 * user typed the tool's keyword → it MAY run") and puts an LLM behind it
 * for PRECISION ("SHOULD it run, and how"). See
 * docs/architecture/blank-intent.md.
 *
 * ## Trust boundary (the load-bearing safety design)
 *
 * v1 is Tier B for every gated blank: the classifier may only REFINE an
 * invocation the user already signalled by typing the tool's keyword — it
 * can never SUMMON a fetch/exec the user didn't name. `BlankFill` only
 * calls this gate for a slot whose keyword already matched, so the
 * keyword-consent precondition is structural. The gate then confirms
 * invoke/cede for THAT tool; a verdict naming a different tool, an
 * unknown tool, or an out-of-enum action is rejected (`validateVerdict`)
 * and treated as CEDE. This preserves the invariant from
 * fluid-config.md / ambient-context.md: no LLM-output → side-effect
 * channel for injectable buffer content beyond what the user's own
 * keystrokes authorised.
 *
 * ## Graceful degradation
 *
 * On no-key / LLM error / timeout / unparseable output the gate returns
 * `'invoke'` — i.e. falls back to today's proximity behaviour. The gate
 * is a strict UPGRADE, never a hard dependency: local blanks
 * (volume/brightness) keep working offline; a flaky network never
 * silently disables a tool the user explicitly summoned.
 *
 * ## Catalog provenance / injection surface
 *
 * The catalog is generated from each in-scope blank's frontmatter using
 * ONLY runtime-owned, bounded fields — `name` (sanitized), `keywords`
 * (the already-validated `blankKeywords` token list), and a fixed action
 * enum the runtime owns (`get`/`set`/`step`). NO author free-text (`tip:`)
 * reaches the model. The catalog-trust bench
 * (tests/benchmarks/blank-intent/catalog-trust.ts) showed this minimal
 * descriptor is sufficient (9/9 third-party blanks incl. opaque acronyms),
 * so withholding free-text costs nothing measurable while removing the
 * cross-blank prompt-injection surface entirely. First-party free-text
 * enrichment is a deferred follow-up, not a v1 requirement.
 *
 * ## Prompt provenance
 *
 * SYSTEM_PROMPT is promoted from the PoC at
 * tests/benchmarks/blank-intent/run.ts (which benched 100% precision +
 * recall on cerebras/groq/gemini). The prod bench
 * (tests/benchmarks/blank-intent/prod.ts) drives THIS source so there's
 * no bench-local copy to drift — the transform-blank prod.ts lesson.
 */

import { HttpAdapter } from '../types';
import { BlankConfig } from '../cues-md';
import { describeLLMCall, dispatchChat, type ProviderAdapter } from '../llm-provider';
import { classifyLlmError } from './fluid-blank-source';

// ============================================================================
// Catalog — generated from in-scope blank frontmatter (bounded fields only)
// ============================================================================

export interface CatalogEntry {
  readonly name: string;
  readonly keywords: readonly string[];
  readonly actions: readonly ('get' | 'set' | 'step')[];
}

export interface BlankCatalog {
  readonly text: string;
  readonly names: ReadonlySet<string>;
}

/**
 * A blank is gated by BlankIntent iff it is keyword-bound and is NOT a
 * pure list blank (stepValues). This matches exactly what `BlankFill.
 * maybeRunScripts` dispatches: list blanks are handled synchronously in
 * `onUnderscoreKey` (skipped at the top of maybeRunScripts), and
 * everything else with a keyword runs a script / impl / built-in-by-
 * convention class via the script-or-blankInvoke path — i.e. the
 * exec/fetch tier the gate exists to gate.
 *
 * NOTE: we deliberately do NOT require `blankScript || impl`. The shipped
 * fetch blanks (weather, stocks, crypto, dictionary, countries,
 * hackernews) OMIT `impl:` — the runtime resolves them by convention to
 * `<PascalCase(name)>Blank` in its built-in registry. Requiring an
 * explicit impl/script field would silently exclude every built-in fetch
 * blank from the catalog, and the classifier would then CEDE all of them
 * (unknown tool) — suppressing real invocations. Keyword + not-a-list is
 * the correct, drift-proof predicate.
 */
export function isGatedBlank(blk: BlankConfig): boolean {
  const hasKeywords = !!blk.blankKeywords && blk.blankKeywords.length > 0;
  const isListBlank = Array.isArray(blk.stepValues) && blk.stepValues.length > 0;
  return hasKeywords && !isListBlank && blk.enabled !== false;
}

/** Sanitize a tool name for the prompt: lowercase, [a-z0-9-] only,
 *  single line, length-capped. A hostile/careless frontmatter name can't
 *  carry a newline-delimited instruction payload into the catalog. */
function sanitizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 48);
}

/** Infer the action enum from frontmatter shape. Every gated blank
 *  supports `get`; a `blankStep` (cycleable numeric like volume /
 *  brightness) also exposes `set` + `step`. The enum is runtime-owned —
 *  never author-supplied — so it can't carry an injection payload. */
function inferActions(blk: BlankConfig): ('get' | 'set' | 'step')[] {
  if (blk.blankStep !== undefined && blk.blankStep !== null) {
    return ['get', 'set', 'step'];
  }
  return ['get'];
}

/**
 * Build the in-scope blank-tool catalog from the registered blanks.
 * Deterministic (sorted by name) so the same blank set yields a
 * byte-identical system message — keeping cerebras's prefix cache warm.
 */
export function buildCatalog(blanks: Record<string, BlankConfig>): BlankCatalog {
  const entries: CatalogEntry[] = [];
  for (const blk of Object.values(blanks)) {
    if (!isGatedBlank(blk)) continue;
    const name = sanitizeName(blk.name);
    if (!name) continue;
    const keywords = (blk.blankKeywords ?? []).map(k => k.toLowerCase());
    entries.push({ name, keywords, actions: inferActions(blk) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const lines = entries.map(e =>
    `- ${e.name} — keywords: ${e.keywords.join(', ')}. actions: ${e.actions.join(' | ')}.`,
  );
  const text = entries.length > 0
    ? `Available blank-tools (and ONLY these):\n${lines.join('\n')}`
    : 'Available blank-tools (and ONLY these):\n(none)';

  return { text, names: new Set(entries.map(e => e.name)) };
}

// ============================================================================
// System prompt — promoted from tests/benchmarks/blank-intent/run.ts (PoC)
// ============================================================================
//
// The catalog is injected per-call (deterministic per blank set). The
// rules + output format + few-shot examples are static; the examples
// reference the shipped tool names (volume / weather / stocks / …) as
// illustrations — the rules generalise to any catalog entry.

const SYSTEM_RULES = `You are a BLANK-TOOL INVOCATION CLASSIFIER for the OpenCues runtime.

You read a short input ending in _ and decide whether the user is INVOKING one of the blank-tools below, or whether the _ is just prose / a free-form lookup that should fall through to the general answer engine.`;

const SYSTEM_FORMAT = `Output exactly four labelled lines:
VERDICT: INVOKE | CEDE
BLANK: <tool name from the list, or empty>
ACTION: get | set | step | empty
VALUE: <the captured argument, or empty>

The input may be in any language.

INVOKE when the input is a genuine INVOCATION — the user wants this tool's data or action right now:
  - "volume 70 _" → INVOKE volume set 70
  - "volume _" → INVOKE volume get
  - "set the volume to seventy _" → INVOKE volume set 70
  - "turn the brightness up _" → INVOKE brightness step up
  - "weather in tokyo _" / "what's the weather in tokyo _" → INVOKE weather get tokyo
  - "aapl _" / "apple stock price _" / "how much is apple stock _" → INVOKE stocks get aapl
  - "btc _" / "price of bitcoin _" → INVOKE crypto get btc
  - "define serendipity _" / "what does ephemeral mean _" → INVOKE dictionary get <word>
  - "capital of france _" / "population of japan _" → INVOKE countries get "<facet> <country>"
  - "hackernews _" / "top hn _" → INVOKE hackernews get

CEDE when the keyword appears but the user is NOT invoking the tool:
  - prose that merely mentions the word: "the volume was great _", "i turned the volume down earlier _", "the weather was lovely today _", "tesla stock crashed this year _", "bitcoin is interesting _"
  - a meta/opinion/discussion, not a request for the live value: "is apple stock a good buy _", "should i define my terms better _"
  - anything not matching a listed tool, or too ambiguous to pick exactly one.

Rules:
  - Pick AT MOST ONE tool. If unsure between a tool and prose, CEDE.
  - For SET, VALUE is the number (normalise words → digits: "seventy" → 70). For step, VALUE is up/down.
  - For weather/stocks/crypto/dictionary, VALUE is the entity (place/ticker/coin/word). For countries, VALUE is "<facet> <country>" e.g. "capital france".
  - When VERDICT is CEDE, BLANK / ACTION / VALUE are empty.`;

/** Compose the full system prompt for a given catalog. */
export function buildSystemPrompt(catalogText: string): string {
  return `${SYSTEM_RULES}\n\n${catalogText}\n\n${SYSTEM_FORMAT}`;
}

// ============================================================================
// Verdict + parsing + validation
// ============================================================================

export interface BlankIntentVerdict {
  readonly verdict: 'invoke' | 'cede';
  readonly blank: string | null;
  readonly action: 'get' | 'set' | 'step' | null;
  readonly value: string | null;
}

const CEDE: BlankIntentVerdict = { verdict: 'cede', blank: null, action: null, value: null };

/** Tolerant label parse — mirrors parseConfigIntentOutput. Any
 *  ambiguity collapses to CEDE (the safe default). */
export function parseBlankIntentOutput(raw: string): BlankIntentVerdict {
  const g = (label: string): string =>
    (raw.match(new RegExp(`^${label}:[ \\t]*(.*?)[ \\t]*$`, 'im'))?.[1] ?? '').trim();
  const verdictRaw = g('VERDICT').toUpperCase();
  if (verdictRaw !== 'INVOKE') return CEDE;
  const blank = g('BLANK').toLowerCase() || null;
  const actionRaw = g('ACTION').toLowerCase();
  const action = (actionRaw === 'get' || actionRaw === 'set' || actionRaw === 'step')
    ? actionRaw
    : null;
  const value = g('VALUE') || null;
  if (!blank) return CEDE;
  return { verdict: 'invoke', blank, action, value };
}

/**
 * Validate an INVOKE verdict against the runtime's own catalog + the
 * tool the user's keyword actually summoned. Defence in depth — the
 * runtime never runs a tool it can't tie back to user-typed consent,
 * even if a (possibly injected) catalog entry steered the classifier.
 *
 *   - The named blank must be in the catalog.
 *   - The named blank must be `expectedBlank` (the slot whose keyword
 *     the user typed). The LLM may only REFINE that invocation, never
 *     redirect it to a different tool. (Tier B consent invariant.)
 *
 * Returns true iff the verdict may execute. CEDE verdicts always pass
 * (the caller cedes anyway).
 */
export function validateVerdict(
  verdict: BlankIntentVerdict,
  catalog: BlankCatalog,
  expectedBlank: string,
): boolean {
  if (verdict.verdict === 'cede') return true;
  if (!verdict.blank) return false;
  if (!catalog.names.has(verdict.blank)) return false;
  if (verdict.blank !== sanitizeName(expectedBlank)) return false;
  return true;
}

// ============================================================================
// Classifier
// ============================================================================

export type BlankIntentEvent =
  | { type: 'started'; textLen: number; blank: string; llm: string }
  | { type: 'completed'; verdict: BlankIntentVerdict; ran: boolean; latencyMs: number }
  | { type: 'degraded'; reason: string; latencyMs: number };

export interface BlankIntentClassifierConfig {
  httpAdapter: HttpAdapter;
  provider: ProviderAdapter;
  endpoint: string;
  apiKey: string;
  model: string;
  /** Classifier output is tiny — 4 short lines. Default 128. */
  maxTokens?: number;
  /** Classifier must be deterministic. Default 0. */
  temperature?: number;
  log?: (msg: string) => void;
  onEvent?: (event: BlankIntentEvent) => void;
}

export class BlankIntentClassifier {
  readonly id = 'blank-intent';

  private httpAdapter: HttpAdapter;
  private provider: ProviderAdapter;
  private endpoint: string;
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;
  private log: (msg: string) => void;
  private emit: (event: BlankIntentEvent) => void;

  /**
   * Per-input cache of raw LLM responses. The gate fires on every
   * keystroke that produces a keyword-matched slot, and `maybeRunScripts`
   * can re-fire several times in a burst (text-change re-scan, double
   * dispatch). Caching the raw response keeps a burst to one wire call.
   * Static module-level so it survives chrome's resolver rebuild churn —
   * same shape as ConfigIntentSource._variantPool.
   */
  private static _cache = new Map<string, string>();
  private static readonly CACHE_CAP = 64;

  constructor(config: BlankIntentClassifierConfig) {
    this.httpAdapter = config.httpAdapter;
    this.provider = config.provider;
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 128;
    this.temperature = config.temperature ?? 0;
    this.log = config.log ?? (() => { /* silent */ });
    this.emit = config.onEvent ?? (() => { /* silent */ });
  }

  /**
   * The gate. Returns the verdict for whether `expectedBlank` (the tool
   * the user's keyword summoned) should run on this buffer.
   *
   * NEVER throws — any failure degrades to INVOKE (today's behaviour) so
   * a flaky classifier can't silently disable a user-summoned tool.
   */
  async classify(
    text: string,
    expectedBlank: string,
    blanks: Record<string, BlankConfig>,
    signal?: AbortSignal,
  ): Promise<BlankIntentVerdict> {
    const t0 = Date.now();
    const expected = sanitizeName(expectedBlank);
    let verdict: BlankIntentVerdict;
    try {
      verdict = await this._rawVerdict(text, blanks, signal);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const reason = classifyLlmError(err) ?? 'llm-error';
      this.log(`BlankIntent: LLM failed (${err.message}) — DEGRADING to invoke (blank=${expectedBlank})`);
      this.emit({ type: 'degraded', reason: String(reason), latencyMs: Date.now() - t0 });
      // Degrade to today's behaviour: run the script the user summoned.
      return { verdict: 'invoke', blank: expected, action: 'get', value: null };
    }

    // Consent gate (Tier B): the LLM may only REFINE the invocation the
    // user signalled by typing THIS tool's keyword — never redirect to a
    // different tool. A verdict naming any other (or no) tool cedes.
    if (verdict.verdict === 'invoke' && verdict.blank === expected) {
      this.log(`BlankIntent: INVOKE ${verdict.blank} ${verdict.action ?? 'get'}${verdict.value ? ' ' + verdict.value : ''} (${Date.now() - t0}ms)`);
      this.emit({ type: 'completed', verdict, ran: true, latencyMs: Date.now() - t0 });
      return verdict;
    }
    this.log(`BlankIntent: CEDE for "${text}" (blank=${expectedBlank}, raw verdict=${verdict.verdict}/${verdict.blank ?? '-'})`);
    this.emit({ type: 'completed', verdict: CEDE, ran: false, latencyMs: Date.now() - t0 });
    return CEDE;
  }

  /**
   * Raw classification — the underlying verdict the model picked,
   * validated only for catalog MEMBERSHIP (not the expected-tool consent
   * check `classify` adds). Returns CEDE for a genuine cede, an unknown
   * tool, or unparseable output. On an LLM ERROR it returns CEDE too (an
   * error is "no invocation" for measurement purposes) — the gate's
   * degrade-to-invoke lives in `classify`, which calls `_rawVerdict`
   * directly so it can tell an error apart from a real cede. Exposed for
   * the prod bench (tests/benchmarks/blank-intent/prod.ts) so it measures
   * the real classifier's blank/action/value extraction.
   */
  async classifyRaw(
    text: string,
    blanks: Record<string, BlankConfig>,
    signal?: AbortSignal,
  ): Promise<BlankIntentVerdict> {
    try {
      return await this._rawVerdict(text, blanks, signal);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.log(`BlankIntent: classifyRaw LLM failed (${err.message}) — counting as cede`);
      return CEDE;
    }
  }

  /**
   * Dispatch + parse + catalog-membership validate. THROWS on LLM error
   * (callers decide how to degrade). Caches the raw response so a burst /
   * repeat trigger is one wire call.
   */
  private async _rawVerdict(
    text: string,
    blanks: Record<string, BlankConfig>,
    signal?: AbortSignal,
  ): Promise<BlankIntentVerdict> {
    const catalog = buildCatalog(blanks);
    const system = buildSystemPrompt(catalog.text);
    const llmDesc = describeLLMCall(this.provider, this.model, undefined, {
      maxTokens: this.maxTokens, temperature: this.temperature,
    });
    this.emit({ type: 'started', textLen: text.length, blank: '', llm: llmDesc });

    const cacheKey = [text, this.provider.id, this.model, catalog.text].join('\x1f');
    let raw: string;
    const cached = BlankIntentClassifier._cache.get(cacheKey);
    if (cached !== undefined) {
      raw = cached;
      this.log(`BlankIntent: cache HIT for "${text}"`);
    } else {
      raw = await this.callLLM(system, `INPUT: ${text}`, signal);
      this._recordResponse(cacheKey, raw);
    }

    const verdict = parseBlankIntentOutput(raw);
    // Catalog-membership only — the per-tool consent check is in classify.
    if (verdict.verdict === 'invoke' && verdict.blank && catalog.names.has(verdict.blank)) {
      return verdict;
    }
    return CEDE;
  }

  private async callLLM(system: string, user: string, signal?: AbortSignal): Promise<string> {
    return dispatchChat(
      this.provider,
      this.httpAdapter,
      {
        model: this.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        maxTokens: this.maxTokens,
        temperature: this.temperature,
        seed: 42,
        // Tiny structured output — 'low' reasoning is plenty and keeps the
        // gate off the interactive critical path. Mirrors ConfigIntent /
        // FluidBlank's 'low' floor.
        reasoningEffort: 'low',
      },
      {
        apiKey: this.apiKey,
        endpoint: this.endpoint,
        signal,
        onUsage: (u) => {
          if (u.cachedTokens > 0 || u.cacheHitRate > 0) {
            this.log(`BlankIntent: usage prompt=${u.promptTokens} cached=${u.cachedTokens} (${(u.cacheHitRate * 100).toFixed(1)}%)`);
          }
        },
      },
    );
  }

  private _recordResponse(key: string, response: string): void {
    const cache = BlankIntentClassifier._cache;
    if (cache.has(key)) cache.delete(key);
    cache.set(key, response);
    while (cache.size > BlankIntentClassifier.CACHE_CAP) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  static resetCacheForTest(): void {
    BlankIntentClassifier._cache.clear();
  }
}
