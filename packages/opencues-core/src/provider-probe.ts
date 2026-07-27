// provider-probe — "is the provider I'm about to switch TO actually
// reachable?" A pre-switch liveness check so a mode/provider change never
// lands on something that can't answer (Ollama not running, a missing key,
// a model the provider rejects). The caller (ConfigIntentSource's provider
// verdict) runs this BEFORE writing the scalar and, on failure, keeps the
// current provider and surfaces the reason inline — exactly like every
// other blank-triggered LLM error (classifyLlmError → formatErrorAsSubstitute).
//
// It pings the TARGET provider directly: getProvider(id) → its default
// endpoint + the key from the bag → a minimal completion. No resolveLLM
// override/feature/global cascade — the provider is already decided by the
// verdict, so there's nothing to resolve; we just reach it.

import {
  getProvider,
  dispatchChat,
  defaultCliAvailable,
  type HttpAdapterShape,
} from './llm-provider';
import { classifyLlmError, type FluidBlankErrorReason } from './sources/fluid-blank-source';

export interface ProviderProbeResult {
  readonly ok: boolean;
  /** Classified failure reason — reuses the same taxonomy every inline LLM
   *  error uses, so the caller can render it via `formatErrorAsSubstitute`. */
  readonly reason?: FluidBlankErrorReason;
  /** The underlying error — its message names the concrete cause
   *  (e.g. "fetch failed … localhost:11434" for a down Ollama), which the
   *  inline substitute surfaces. */
  readonly err?: Error;
}

export interface ProviderProbeOptions {
  /** Multi-provider key bag (env-var-named, e.g. `CEREBRAS_API_KEY`). */
  readonly apiKeys: Readonly<Record<string, string | undefined>>;
  readonly httpAdapter: HttpAdapterShape;
  /** Endpoint override; falls back to the provider's `defaultEndpoint`. */
  readonly endpoint?: string;
  readonly signal?: AbortSignal;
  /** Ping deadline. A DOWN provider (connection refused) fails fast well
   *  under this; the cap only bites a reachable-but-slow provider (e.g. a
   *  cold Ollama model load). */
  readonly timeoutMs?: number;
  /** Injectable for tests; defaults to the PATH probe used by auto-routing. */
  readonly isCliAvailable?: (id: string) => boolean;
}

export const PROVIDER_PROBE_TIMEOUT_MS = 6000;

/**
 * Ping `providerId` (+ `model`, or the provider's default) and report
 * whether it's usable right now.
 *
 * - CLI-transport providers (`claude-code-cli`, `openai-subscription`):
 *   reachability = the CLI binary is on PATH. No network.
 * - Key-based providers with no key in the bag: fast-fail (no network).
 * - Otherwise: a minimal `maxTokens: 1` completion. Success → ok. A
 *   `rate-limit` (429) is treated as REACHABLE — the provider/key/model are
 *   all valid, it's just throttling, so it shouldn't block a switch. Any
 *   other error → not ok, with the classified reason.
 */
export async function probeProviderReachable(
  providerId: string,
  model: string | null,
  opts: ProviderProbeOptions,
): Promise<ProviderProbeResult> {
  const provider = getProvider(providerId);
  if (!provider) {
    return { ok: false, reason: 'bad-request', err: new Error(`unknown provider '${providerId}'`) };
  }

  // CLI-transport providers — reachability is "binary installed + on PATH".
  if (provider.transport === 'cli') {
    const available = (opts.isCliAvailable ?? defaultCliAvailable)(providerId);
    return available
      ? { ok: true }
      : { ok: false, reason: 'network', err: new Error(`${providerId} CLI not found on PATH — install it, then switch again`) };
  }

  // Key-REQUIRED providers with no key present — fail before any network
  // hop. Skipped for `optionalAuth` providers (Ollama runs keyless; a key
  // is only sent if the user fronts it with an auth proxy), which must
  // still be pinged for real reachability.
  const key = provider.envKeyName ? opts.apiKeys[provider.envKeyName] : undefined;
  if (provider.envKeyName && !key && !provider.optionalAuth) {
    return {
      ok: false,
      reason: 'invalid-api-key',
      err: new Error(`no ${provider.envKeyName} set — add it to ~/.cues/.env (or your shell env), then switch again`),
    };
  }

  const effectiveModel = model ?? provider.defaultModel;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? PROVIDER_PROBE_TIMEOUT_MS);
  const onOuterAbort = (): void => ctl.abort();
  opts.signal?.addEventListener('abort', onOuterAbort);
  try {
    await dispatchChat(
      provider,
      opts.httpAdapter,
      {
        model: effectiveModel,
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 1,
        temperature: 0,
      },
      { apiKey: key ?? '', endpoint: opts.endpoint, signal: ctl.signal, noRateLimitRetry: true },
    );
    return { ok: true };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const reason = classifyLlmError(err) ?? 'network';
    // Throttling means the provider/key/model are VALID — don't block a
    // switch on a transient 429.
    if (reason === 'rate-limit') return { ok: true };
    return { ok: false, reason, err };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
}
