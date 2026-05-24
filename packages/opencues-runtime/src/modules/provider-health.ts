// ProviderHealth — classification + bus for LLM-provider failures.
//
// LLM call failures used to surface as silent no-ops (sources caught the
// throw and returned `{results:[], error}`; nothing rendered to the user).
// In May 2026 the agentic harness found a Cerebras account that had been
// out of credits for weeks while every cue source quietly returned
// nothing — fluid-blank looked "broken" but the actual failure was 402.
//
// This module owns the failure taxonomy + a tiny event bus the status
// line subscribes to. Sources / providers call `classifyProviderError`
// with whatever signal they have (HTTP status + body, or a thrown
// Error), get back a `ProviderHealthEvent` or null, and forward
// non-null events into `ProviderHealth.report`.
//
// The taxonomy is intentionally small (five kinds) — it's a UX-budget
// constraint, not a debugging surface. A status line that shows seven
// different failure modes is the same as no status line.

export type ProviderHealthKind =
  | 'auth'           // 401/403 — bad or missing key. Sticky.
  | 'quota'          // 402 / insufficient_quota / out of credit. Sticky.
  | 'rate-limit'     // 429 transient. Auto-clears.
  | 'outage'         // 5xx, network error, empty body. Auto-clears on next success.
  | 'model-missing'; // 404 / "model not supported". Sticky (config issue).

/**
 * A single classified failure event. The status line renders sticky
 * events until the underlying condition clears (next successful call
 * for outage / rate-limit; explicit config-edit for auth / quota /
 * model-missing — those don't clear themselves).
 */
export interface ProviderHealthEvent {
  readonly kind: ProviderHealthKind;
  /** Short, human-readable. Fits in a status line. */
  readonly message: string;
  /**
   * Sticky events survive until clear() is called explicitly (config
   * fix). Non-sticky events auto-clear after `transientTtlMs` (default
   * 10s) on their own.
   */
  readonly sticky: boolean;
  readonly provider?: string;
  readonly model?: string;
  /** Epoch ms. Set by the ProviderHealth bus, not by callers. */
  readonly at: number;
}

export interface ClassifyInput {
  /** HTTP status if available. Many call sites only have the body. */
  readonly status?: number;
  /** Response body or error message. The bulk of classification lives here. */
  readonly body?: string;
  /**
   * A thrown Error (from the provider or HTTP adapter). Its `.message`
   * is searched as a fallback for the body regexes. Most useful for
   * network errors (ECONNREFUSED etc.) where there's no HTTP response.
   */
  readonly cause?: unknown;
  readonly provider?: string;
  readonly model?: string;
}

/**
 * Classify a failure signal. Returns null when the input looks healthy
 * (no error indicators found) — callers should treat null as "report
 * nothing, the call succeeded".
 *
 * Precedence rules:
 *   1. Quota signals win over rate-limit (402 / insufficient_quota are
 *      more specific than a generic 429 — recovery requires a config
 *      change, not a wait).
 *   2. Auth status (401/403) wins over body-text classification — if
 *      the server says auth failed, body content is secondary.
 *   3. Model-missing requires both a 404 status AND a body hint OR
 *      explicit text like "model X is not supported" — bare 404 from
 *      a network proxy isn't a model-missing event.
 */
export function classifyProviderError(input: ClassifyInput): ProviderHealthEvent | null {
  const status = input.status;
  const body = (input.body ?? '').toString();
  const causeMsg = input.cause instanceof Error ? input.cause.message : '';
  const combined = body || causeMsg;
  const lower = combined.toLowerCase();

  // 2xx with no body indicator = healthy.
  if (status !== undefined && status >= 200 && status < 300 && !combined) return null;

  // Network errors come through as Error instances with no HTTP status.
  const isNetworkErr = !status && /econnrefused|enotfound|etimedout|econnreset|network|fetch failed/i.test(causeMsg);
  if (isNetworkErr) {
    return mk('outage', `network: ${shorten(causeMsg)}`, false, input);
  }

  // 1. Quota — most specific, check first.
  if (status === 402 || /\b402\b|payment[_ -]?required|insufficient[_ -]?(?:quota|credit|balance)|out[_ -]?of[_ -]?credit/i.test(combined)) {
    return mk('quota', 'out of credits / payment required', true, input);
  }

  // 2. Auth.
  if (status === 401 || status === 403) {
    const detail = status === 403 ? 'forbidden — key lacks access' : 'bad / missing API key';
    return mk('auth', detail, true, input);
  }
  if (!status && /unauthorized|invalid[_ -]?api[_ -]?key|authentication[_ -]?(?:failed|error)|invalid token/i.test(lower)) {
    return mk('auth', 'bad / missing API key', true, input);
  }

  // 3. Model-missing — sticky config issue.
  if (status === 404 && /model/i.test(combined)) {
    return mk('model-missing', `model unavailable: ${input.model ?? '?'}`, true, input);
  }
  if (/model\s+\S+\s+is\s+not\s+supported|unknown\s+model|model\s+not\s+found/i.test(lower)) {
    return mk('model-missing', `model unavailable: ${input.model ?? '?'}`, true, input);
  }

  // 4. Rate-limit (transient).
  if (status === 429 || /\b429\b|too[_ -]?many[_ -]?requests|rate[_ -]?limit/i.test(combined)) {
    return mk('rate-limit', 'rate-limited', false, input);
  }

  // 5. Outage — 5xx, transient body markers, empty body where one was expected.
  if (status !== undefined && status >= 500 && status < 600) {
    return mk('outage', `provider ${status}`, false, input);
  }
  if (/server[_ -]?error|service[_ -]?unavailable|overloaded|timeout|queue[_ -]?(?:exceeded|full)/i.test(lower)) {
    return mk('outage', 'provider unavailable', false, input);
  }
  if (status === undefined && !combined) return null;
  if (combined.trim() === '' && status === undefined) return null;

  // Unknown failure shape — treat as outage with the raw message so the
  // user at least sees SOMETHING rather than a silent dead-cue.
  if (combined) {
    return mk('outage', shorten(combined), false, input);
  }
  return null;
}

function mk(
  kind: ProviderHealthKind,
  message: string,
  sticky: boolean,
  input: ClassifyInput,
): ProviderHealthEvent {
  return {
    kind,
    message,
    sticky,
    provider: input.provider,
    model: input.model,
    at: 0, // overwritten by ProviderHealth.report — callers shouldn't trust this
  };
}

function shorten(s: string): string {
  const trimmed = s.trim().replace(/\s+/g, ' ');
  return trimmed.length > 120 ? trimmed.slice(0, 117) + '...' : trimmed;
}

export interface ProviderHealthOptions {
  /** ms a non-sticky event lingers before auto-clearing. Default 10_000. */
  readonly transientTtlMs?: number;
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

/**
 * Tiny pub-sub for the latest provider-health event. The status line
 * subscribes; sources / the resolver call `report`. Only the most recent
 * event is retained — this is a UX surface, not an audit log.
 *
 * Sticky events stay until `clear()` or until a fresh non-sticky event
 * arrives of the same kind that the caller treats as resolution.
 * Non-sticky events auto-clear after `transientTtlMs`.
 */
export class ProviderHealth {
  private _current: ProviderHealthEvent | null = null;
  private _clearTimer: ReturnType<typeof setTimeout> | null = null;
  private _subs = new Set<(ev: ProviderHealthEvent | null) => void>();
  private readonly _ttl: number;
  private readonly _now: () => number;

  constructor(opts: ProviderHealthOptions = {}) {
    this._ttl = opts.transientTtlMs ?? 10_000;
    this._now = opts.now ?? (() => Date.now());
  }

  current(): ProviderHealthEvent | null {
    return this._current;
  }

  /**
   * Push a new event. Always overwrites the previous current — even
   * sticky → non-sticky transitions. Callers decide policy by what
   * they classify in the first place.
   */
  report(ev: ProviderHealthEvent): void {
    const stamped: ProviderHealthEvent = { ...ev, at: this._now() };
    this._current = stamped;
    this._armAutoClear(stamped);
    this._notify();
  }

  /** Explicit clear (sticky events; "I fixed it"). */
  clear(): void {
    if (this._clearTimer) { clearTimeout(this._clearTimer); this._clearTimer = null; }
    if (this._current === null) return;
    this._current = null;
    this._notify();
  }

  /**
   * Convenience: classify + report in one call. Returns the classified
   * event (or null if the input looked healthy). Callers writing
   * defensive error paths can ignore the return.
   */
  reportFrom(input: ClassifyInput): ProviderHealthEvent | null {
    const ev = classifyProviderError(input);
    if (ev) this.report(ev);
    return ev;
  }

  /** Subscribe to current-event changes. Returns an unsubscribe fn. */
  subscribe(fn: (ev: ProviderHealthEvent | null) => void): () => void {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  private _armAutoClear(ev: ProviderHealthEvent): void {
    if (this._clearTimer) { clearTimeout(this._clearTimer); this._clearTimer = null; }
    if (ev.sticky) return;
    this._clearTimer = setTimeout(() => {
      // Only clear if this is still the current event (a newer report
      // would have overwritten + re-armed).
      if (this._current && this._current.at === ev.at) {
        this._current = null;
        this._clearTimer = null;
        this._notify();
      }
    }, this._ttl);
  }

  private _notify(): void {
    for (const fn of this._subs) {
      try { fn(this._current); } catch { /* swallow — one bad subscriber shouldn't take the others down */ }
    }
  }
}
