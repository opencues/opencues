/**
 * Effective LLM routing — the shared bucket → global → auto precedence
 * walk behind every "what's my model?" surface.
 *
 * Three consumer classes, one truth:
 *   - **dispatch** — build-sources.ts `resolveFor` (cues/blanks buckets)
 *     and boot-common's buildAgentLLMResolver / buildKataLLMResolver
 *     (auditors bucket) collapse the bucket tier via `collapseBucketTier`
 *     before handing off to `resolveLLM`.
 *   - **display** — `resolveEffectiveRouting`: doctor's LLM-routing
 *     section, the `model` built-in blank ("what's my model _"), and the
 *     `opencues models` CLI command.
 *
 * History (July 2026): before this module, doctor reimplemented the walk
 * in CJS and drifted from dispatch on three counts — it showed the
 * global `llm-model` leaking into a bucket pinned to another provider
 * (dispatch unpairs it), it showed a bucket model as live while the
 * bucket provider was `inherit` (dispatch silently ignored the scalar
 * the config menu had just written — fixed, see `collapseBucketTier`),
 * and the auditors dispatch path shipped literal `default` sentinels as
 * model names. Sharing this walk makes that drift class structurally
 * impossible. See docs/architecture/llm-routing.md.
 */
import {
  PROVIDER_IDS,
  defaultCliAvailable,
  getProvider,
  pickAutoProvider,
  resolveLLMTuple,
  type ProviderAdapter,
} from './llm-provider';

export type LlmBucket = 'cues' | 'auditors' | 'blanks';

export const LLM_BUCKETS: readonly LlmBucket[] = ['cues', 'auditors', 'blanks'];

/**
 * Translate a `*-llm-model` scalar's raw value into a model id or
 * undefined. The literal `default` (the first cycleable value in the
 * `*-llm-model` FEATURES entries) means "fall through to the provider's
 * defaultModel"; `inherit` and empty are read the same way — all three
 * are semantically "scalar absent". Single shared definition: the
 * runtime resolver, doctor, and every display surface must agree on
 * what counts as a sentinel or the displayed model lies about the
 * dispatched one.
 */
export function normalizeModelScalar(raw: string | undefined | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const t = raw.trim();
  if (t === '') return undefined;
  const lc = t.toLowerCase();
  if (lc === 'default' || lc === 'inherit') return undefined;
  return t;
}

/**
 * Translate a `*-llm-provider` bucket scalar into a concrete provider id
 * or undefined. Mirrors config-loader's `bucketProvider()` gate: only
 * exact known provider ids count — `inherit`, empty, and anything
 * unrecognised collapse the bucket (dispatch falls through to the
 * global tier). Legacy provider ALIASES are deliberately not accepted
 * here because config-loader doesn't accept them at the bucket tier
 * either; accepting them only in the display walk would make the
 * display disagree with dispatch.
 */
export function normalizeBucketProviderScalar(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const lc = raw.trim().toLowerCase();
  if (!lc || lc === 'inherit') return undefined;
  return (PROVIDER_IDS as readonly string[]).includes(lc) ? lc : undefined;
}

export interface CollapseBucketTierOptions {
  /** Raw `<bucket>-llm-provider` scalar (sentinels handled inside). */
  readonly bucketProvider?: string | null;
  /** Raw `<bucket>-llm-model` scalar (sentinels handled inside). */
  readonly bucketModel?: string | null;
  /** Raw global `llm-provider` scalar. */
  readonly globalProvider?: string | null;
  /** Raw global `llm-model` scalar (sentinels handled inside). */
  readonly globalModel?: string | null;
}

export interface CollapsedBucketTier {
  /** Value to pass as `resolveLLM`'s `globalProvider`. */
  readonly globalProvider: string | undefined;
  /** Value to pass as `resolveLLM`'s `globalModel`. */
  readonly globalModel: string | undefined;
  /** True when the bucket scalar pinned a concrete provider. */
  readonly bucketPinned: boolean;
}

/**
 * Collapse the bucket tier onto `resolveLLM`'s global tier. Pairing
 * rules:
 *
 *   - Bucket provider concrete → the bucket model rides with it and the
 *     global `llm-model` NEVER leaks in. A stale global model would
 *     otherwise pair with a provider it was never chosen for (e.g.
 *     `llm-model: openai/gpt-oss-120b` from a groq era leaking into a
 *     bucket pinned to opencode-zen).
 *   - Bucket provider inherit/unset → the inherited global provider is
 *     used, and the bucket model still WINS over the global model when
 *     set. The config menu offers `<bucket>-llm-model` cycling against
 *     the inherited provider's knownModels and writes the scalar;
 *     dispatch ignoring it made the user's menu pick silently inert
 *     (July 2026 bug). A bucket model is more specific than a global
 *     model in every honest reading of the scalar names.
 */
export function collapseBucketTier(opts: CollapseBucketTierOptions): CollapsedBucketTier {
  const bucketProvider = normalizeBucketProviderScalar(opts.bucketProvider);
  const bucketModel = normalizeModelScalar(opts.bucketModel);
  const globalModel = normalizeModelScalar(opts.globalModel);
  const globalProvider = opts.globalProvider?.trim() || undefined;
  if (bucketProvider) {
    return { globalProvider: bucketProvider, globalModel: bucketModel, bucketPinned: true };
  }
  return { globalProvider, globalModel: bucketModel ?? globalModel, bucketPinned: false };
}

export type EffectiveProviderSource =
  | 'bucket'              // `<bucket>-llm-provider` pinned it
  | 'global'              // global `llm-provider` scalar
  | 'auto-key'            // first env key in PROVIDER_AUTO_ORDER
  | 'auto-subscription'   // zero keys, subscription-CLI binary on PATH
  | 'none';               // nothing set, no keys, no subscription binary

export type EffectiveModelSource =
  | 'bucket'              // `<bucket>-llm-model` scalar
  | 'global'              // global `llm-model` scalar
  | 'provider-default';   // the resolved provider's defaultModel

export interface EffectiveBucketRouting {
  readonly bucket: LlmBucket;
  /** Canonical provider id, or null when nothing routes / id unknown. */
  readonly providerId: string | null;
  readonly provider: ProviderAdapter | null;
  /** Canonicalized model dispatch would use, or null when no provider. */
  readonly model: string | null;
  readonly providerSource: EffectiveProviderSource;
  readonly modelSource: EffectiveModelSource | null;
  /**
   * Can this route actually dispatch? env-key providers: key present in
   * the bag. CLI-transport: binary on PATH. optionalAuth (opencode-zen):
   * always true. False = the route is configured but inert (the
   * "configured provider, missing key" silent-no-op class).
   */
  readonly keyPresent: boolean;
  /**
   * True when a prose-bearing bucket (cues/auditors) is routed to a
   * provider whose ToS allows training on inputs. Dispatch policy
   * refuses these routes (build-sources' trainsOnInput guard); display
   * surfaces should flag rather than pretend the route works.
   */
  readonly trainsOnInputBlocked: boolean;
  /**
   * Set when the bucket scalar held a value that is neither a known
   * provider id nor `inherit` — dispatch treats it as inherit
   * (config-loader's bucketProvider gate); surfaced so doctor can warn
   * about the typo instead of silently displaying the fallthrough.
   */
  readonly ignoredBucketProviderScalar?: string;
}

export interface EffectiveRouting {
  readonly cues: EffectiveBucketRouting;
  readonly auditors: EffectiveBucketRouting;
  readonly blanks: EffectiveBucketRouting;
}

export interface ResolveEffectiveRoutingOptions {
  /** Scalar reader over OPENCUES.md frontmatter (undefined = absent). */
  readonly scalars: (name: string) => string | undefined;
  /** API-key bag keyed by env-var name (the boot bag / buildBootApiKeys). */
  readonly apiKeys: Readonly<Record<string, string | undefined>>;
  /** Override the subscription-CLI binary probe (tests / browser). */
  readonly isCliAvailable?: (providerId: string) => boolean;
}

/**
 * Resolve the effective (provider, model) per bucket exactly as dispatch
 * would — same collapse (`collapseBucketTier`), same tier walk + model
 * canonicalization (`resolveLLMTuple`). Bucket-level truth only:
 * per-source frontmatter (`provider:` in a CUE.md/BLANK.md) and
 * per-feature scalars (`word-cues-provider:`, `agent-provider:`, …) win
 * above the bucket at dispatch time and are deliberately not folded in
 * here — they're file-edit-only power-user overrides, and every
 * consumer of this walk documents the same caveat.
 */
export function resolveEffectiveRouting(opts: ResolveEffectiveRoutingOptions): EffectiveRouting {
  const get = opts.scalars;
  const globalProvider = get('llm-provider');
  const globalModel = get('llm-model');

  const bucketRow = (bucket: LlmBucket): EffectiveBucketRouting => {
    // Legacy singular `blank-llm-*` back-compat mirrors config-loader
    // (plural wins when present) and resolver.ts's model read.
    const rawProvider = get(`${bucket}-llm-provider`)
      ?? (bucket === 'blanks' ? get('blank-llm-provider') : undefined);
    const rawModel = get(`${bucket}-llm-model`)
      ?? (bucket === 'blanks' ? get('blank-llm-model') : undefined);

    const collapsed = collapseBucketTier({
      bucketProvider: rawProvider,
      bucketModel: rawModel,
      globalProvider,
      globalModel,
    });
    const bucketModel = normalizeModelScalar(rawModel);

    const rawProviderLc = rawProvider?.trim().toLowerCase();
    const ignoredBucketProviderScalar =
      rawProviderLc && rawProviderLc !== 'inherit' && !collapsed.bucketPinned
        ? rawProvider!.trim()
        : undefined;

    let providerSource: EffectiveProviderSource;
    let autoPicked: string | null = null;
    if (collapsed.bucketPinned) {
      providerSource = 'bucket';
    } else if (collapsed.globalProvider) {
      providerSource = 'global';
    } else {
      autoPicked = pickAutoProvider(opts.apiKeys, { isCliAvailable: opts.isCliAvailable });
      if (!autoPicked) {
        return {
          bucket, providerId: null, provider: null, model: null,
          providerSource: 'none', modelSource: null,
          keyPresent: false, trainsOnInputBlocked: false,
          ...(ignoredBucketProviderScalar ? { ignoredBucketProviderScalar } : {}),
        };
      }
      providerSource = getProvider(autoPicked)?.transport === 'cli' ? 'auto-subscription' : 'auto-key';
    }

    // Same walk dispatch runs: the collapsed pair rides the global tier
    // (auto-picked provider slots in as if global — tier semantics are
    // identical because only one tier is populated).
    const tuple = resolveLLMTuple({
      globalProvider: collapsed.globalProvider ?? autoPicked,
      globalModel: collapsed.globalModel,
      apiKeys: opts.apiKeys,
    });
    if (!tuple) {
      // Unknown GLOBAL provider id (bucket typos already collapsed to
      // inherit above, matching config-loader) — dispatch returns null
      // for every call on this route.
      return {
        bucket,
        providerId: (collapsed.globalProvider ?? autoPicked ?? '').toLowerCase() || null,
        provider: null, model: null,
        providerSource, modelSource: null,
        keyPresent: false, trainsOnInputBlocked: false,
        ...(ignoredBucketProviderScalar ? { ignoredBucketProviderScalar } : {}),
      };
    }

    const modelSource: EffectiveModelSource =
      bucketModel !== undefined
        ? 'bucket'
        : (!collapsed.bucketPinned && normalizeModelScalar(globalModel) !== undefined)
          ? 'global'
          : 'provider-default';

    const keyPresent = tuple.provider.transport === 'cli'
      ? (opts.isCliAvailable ?? defaultCliAvailable)(tuple.providerId)
      : (tuple.provider.optionalAuth ? true : !!opts.apiKeys[tuple.provider.envKeyName]);

    return {
      bucket,
      providerId: tuple.providerId,
      provider: tuple.provider,
      model: tuple.model,
      providerSource,
      modelSource,
      keyPresent,
      trainsOnInputBlocked: bucket !== 'blanks' && !!tuple.provider.trainsOnInput,
      ...(ignoredBucketProviderScalar ? { ignoredBucketProviderScalar } : {}),
    };
  };

  return {
    cues: bucketRow('cues'),
    auditors: bucketRow('auditors'),
    blanks: bucketRow('blanks'),
  };
}
