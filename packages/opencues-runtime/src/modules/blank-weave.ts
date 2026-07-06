// blank-weave.ts — LLM contextual weaving for a blank's `integration:` exemplar.
//
// THE INVARIANT: the LLM never sees the blank's real value. It receives the
// exemplar with `{value}` replaced by a sentinel TOKEN and weaves connective
// "fluff" around that token to fit the surrounding prose. The runtime swaps the
// real value in for the token AFTER the response (the swap happens in the
// CALLER, `BlankFill`, so the value never even reaches this module). This buys
// two properties the static `{value}` template can't:
//   1. Privacy — the value (stock price, weather, anything personal) never
//      reaches the provider's logs.
//   2. Integrity — the LLM can't hallucinate, reformat, or drop the value; the
//      runtime splices it deterministically.
//
// Gated by `integration-weave-mode: on` (off by default) + per-blank
// `integration-weave: true`. On ANY failure (no key, dispatch error, the token
// got mangled, an empty answer) the weaver returns null and the caller falls
// back to the static `{value}` substitution — a weave can never destroy or
// corrupt the buffer (the "no logical landmines" rule).

import { resolveLLM, dispatchChat, getDehydrator, postProcessContext } from '@opencues/core';
import type { ResolvedLLM, HttpAdapterShape, ChatRequest } from '@opencues/core';
import type { ConfigLoader } from './config-loader';

/** The placeholder the LLM weaves around. Distinctive (paired guillemets +
 *  uppercase) so it survives tokenization and is trivial to locate + swap.
 *  Exported so the caller swaps the real value in for it post-response. */
export const WEAVE_VALUE_TOKEN = '⟦VALUE⟧';

/** Stable session-level system prompt — kept constant so cerebras prefix-caches
 *  it (per CLAUDE.md § Cerebras). Per-call binding (context + placeholder) rides
 *  the USER message. */
export const FUSED_WEAVE_SYSTEM = `You weave a value placeholder into surrounding prose.

You receive PRIOR TEXT (the user's buffer up to an insertion point) and a PLACEHOLDER PHRASE containing the literal token ${WEAVE_VALUE_TOKEN}. Rewrite ONLY the placeholder phrase so it reads as a natural continuation of the prior text — add connective words, fix tense/articles/spacing, match the register and tone.

HARD RULES:
- Keep the token ${WEAVE_VALUE_TOKEN} EXACTLY as written, exactly once. Never translate it, reformat it, wrap it in quotes, or guess what it stands for — you do not know its value and must not invent one.
- Output ONLY the rewritten phrase. No prior text, no surrounding quotes, no explanation, no trailing punctuation you weren't given.
- Stay additive — you are slotting a value into the flow, not answering a question and not editing the prior text.
- If the prior text is empty or unrelated, lightly polish the placeholder phrase on its own.`;

export interface WeaveRequest {
  /** The blank's `integration:` exemplar, e.g. `"it's currently {value}"`. MUST
   *  contain `{value}` (the swap slot) — without it there's nothing to anchor
   *  the value, and the weaver returns null. */
  readonly exemplar: string;
  /** Buffer text BEFORE the command region the value lands in. With anchored
   *  shapes the command leads its line, so the natural context is the prior
   *  buffer (earlier lines/sentences), not same-line text. */
  readonly priorContext: string;
  readonly signal?: AbortSignal;
}

/** Returns the woven phrase STILL CONTAINING {@link WEAVE_VALUE_TOKEN} (the
 *  caller swaps the real value in), or null to signal "fall back to static". */
export type BlankWeaver = (req: WeaveRequest) => Promise<string | null>;

/**
 * Build a weaver bound to the blanks LLM bucket. Re-resolves the
 * provider/model AND re-reads the API keys on every call so OPENCUES.md
 * hot-reload + chrome's async post-boot key delivery both propagate without a
 * restart (mirrors `buildAgentLLMResolver`). `httpAdapter` is injected by the
 * boot layer (chrome passes its fetch-based adapter); when omitted, native
 * hosts lazily fall back to NodeHttpAdapter — the same pattern the Resolver
 * uses, kept browser-safe by the guarded require.
 */
export function buildBlankWeaver(
  configLoader: ConfigLoader,
  getApiKeys: () => Readonly<Record<string, string | undefined>>,
  httpAdapter: HttpAdapterShape | undefined,
  log?: (level: 'info' | 'debug', msg: string) => void,
): BlankWeaver {
  let http: HttpAdapterShape | null = httpAdapter ?? null;
  const resolveHttp = (): HttpAdapterShape | null => {
    if (http) return http;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('@opencues/core/node-http-adapter'); // BROWSER-SAFE-ALLOW: native-host fallback only — chrome always injects host.httpAdapter
      http = new mod.NodeHttpAdapter({ maxSockets: 2, timeout: 30000 }) as HttpAdapterShape;
      return http;
    } catch {
      return null;
    }
  };

  return async (req: WeaveRequest): Promise<string | null> => {
    if (!req.exemplar.includes('{value}')) {
      log?.('debug', 'blank-weave: exemplar has no {value} slot — static fallback');
      return null;
    }
    const httpAdapterResolved = resolveHttp();
    if (!httpAdapterResolved) {
      log?.('info', 'blank-weave: no http adapter available — static fallback');
      return null;
    }
    const apiKeys = getApiKeys();
    // {value} → sentinel token. The real value is NOT involved here.
    const placeholder = req.exemplar.replace(/\{value\}/g, WEAVE_VALUE_TOKEN);

    // Resolve the blanks-bucket LLM (per-feature blank-provider override wins,
    // then the blanks bucket, then global). Mirrors build-sources' precedence.
    const s = configLoader.opencuesState.settings;
    const bucket = configLoader.opencuesState.blanksLlmProvider;
    const bucketProvider = bucket === 'inherit' ? undefined : bucket;
    const bucketModel = bucketProvider ? s.get('blanks-llm-model') : undefined;
    let resolved: ResolvedLLM | null = null;
    try {
      resolved = resolveLLM({
        featureProvider: s.get('blank-provider') ?? null,
        featureModel: s.get('blank-model') ?? null,
        endpointOverride: s.get('blank-endpoint') ?? s.get('blanks-llm-endpoint') ?? s.get('llm-endpoint') ?? null,
        globalProvider: bucketProvider ?? s.get('llm-provider') ?? null,
        globalModel: (bucketProvider ? (bucketModel ?? undefined) : s.get('llm-model')) ?? null,
        apiKeys,
      });
    } catch (e) {
      log?.('info', `blank-weave: resolveLLM threw — ${(e as Error)?.message ?? e}; static fallback`);
      return null;
    }
    if (!resolved) {
      log?.('info', 'blank-weave: no LLM resolved (missing API key for the blanks bucket?) — static fallback');
      return null;
    }

    // DEHYDRATION (outbound PII scrub) — PRIOR TEXT is surrounding
    // buffer content; in identity-context `safe` mode, catalog values in
    // it ship as [TOKEN]s. The woven output is hydrated back below.
    // (The ⟦VALUE⟧ weave token is not bracket-shaped, so hydration
    // never touches it.)
    const idMode = configLoader.opencuesState.identityContextMode;
    const idCatalog = configLoader.identity?.catalog;
    const dehydrator = idMode === 'safe' && idCatalog && idCatalog.size > 0
      ? getDehydrator(idCatalog, (m) => log?.('info', `blank-weave: ${m}`))
      : null;
    const priorOriginal = req.priorContext.trim();
    const dPrior = priorOriginal ? dehydrator?.dehydrate(priorOriginal) : undefined;
    const outboundPrior = dPrior?.changed ? dPrior.text : priorOriginal;
    if (dPrior?.changed) {
      log?.('debug', `blank-weave: dehydrated ${dPrior.spans.length} value(s) → tokens (outbound PII scrub)`);
    }

    const chatReq: ChatRequest = {
      model: resolved.model,
      messages: [
        { role: 'system', content: FUSED_WEAVE_SYSTEM },
        { role: 'user', content: `PRIOR TEXT:\n${outboundPrior || '(none)'}\n\nPLACEHOLDER PHRASE:\n${placeholder}` },
      ],
      temperature: 0,
    };

    let out: string;
    try {
      out = await dispatchChat(resolved.provider, httpAdapterResolved, chatReq, {
        apiKey: resolved.apiKey,
        endpoint: resolved.endpoint,
        signal: req.signal,
        maxThinking: s.get('max-thinking') !== 'off',
      });
    } catch (e) {
      log?.('info', `blank-weave: dispatch failed — ${(e as Error)?.message ?? e}; static fallback`);
      return null;
    }

    // The token MUST survive exactly once. If the model dropped, duplicated, or
    // mangled it, we can't safely splice the value — fall back to static.
    let woven = out.trim().replace(/^["'`]|["'`]$/g, '');
    // HYDRATION — restore values for any [TOKEN] the model echoed from
    // the dehydrated PRIOR TEXT. Failure keeps the raw woven text
    // (visible token beats a leak; the token-survival check below still
    // guards the splice).
    if (dehydrator && idCatalog) {
      try {
        woven = postProcessContext(woven, {
          catalog: idCatalog,
          originalBody: priorOriginal, // TRUE pre-dehydration text
          preserveUnknown: true,
          introducedTokens: dPrior?.introduced,
        }).output;
      } catch { /* keep raw woven */ }
    }
    const tokenCount = woven.split(WEAVE_VALUE_TOKEN).length - 1;
    if (tokenCount !== 1) {
      log?.('info', `blank-weave: token survived ${tokenCount}× (need exactly 1) — static fallback`);
      return null;
    }
    if (!woven || woven === WEAVE_VALUE_TOKEN) {
      // No connective fluff added (bare token) → nothing gained over static.
      log?.('debug', 'blank-weave: response added no connective text — static fallback');
      return null;
    }
    return woven;
  };
}
