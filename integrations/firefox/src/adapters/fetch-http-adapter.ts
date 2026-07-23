import type { HttpAdapter } from '@opencues/core';
import { log } from '../opencues-bootstrap';

interface ProxiedFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
  /** SW-side raw fetch duration (ms), for the latency-split instrumentation. */
  fetchMs?: number;
}

/**
 * Browser fetch()-based HTTP adapter for opencues-core.
 * Replaces NodeHttpAdapter for Chrome extension use.
 *
 * POST routes through the background service worker via
 * `browser.runtime.sendMessage`. Reason: cross-origin POSTs from a
 * content script with `Authorization: Bearer ...` headers trigger a
 * CORS preflight (`OPTIONS` round-trip, ~100-300ms RTT per call).
 * Service worker fetches don't need preflight when the host is
 * declared in `host_permissions`. One IPC hop (~5ms) replaces one
 * preflight round-trip; cumulative win across the 3-pass
 * transform-blank pipeline is ~300-900ms. The service worker also
 * reuses TCP+TLS connections across consecutive calls (Chrome's
 * built-in connection pool), saving per-call TLS-handshake cost on
 * calls 2+ in the same pipeline. See `background.ts`.
 *
 * GET stays on direct fetch — it's used by simple-request blanks
 * (HN/Finnhub/Open-Meteo) that allow CORS without preflight (no
 * Authorization header, simple request mode).
 */
export class FetchHttpAdapter implements HttpAdapter {
  async post(
    url: string,
    body: string,
    headers: Record<string, string>,
    options?: { signal?: AbortSignal },
  ): Promise<string> {
    const signal = options?.signal;
    // Pre-aborted signal: reject before the round-trip starts.
    if (signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }

    // Per-call prompt-tail log. Gated behind `debug-mode: on` per the
    // chrome integration's logging policy (CLAUDE.md → "Debug logging"
    // section). The string printed is the user's own buffer + ambient
    // block — same data the user has on screen — but firing it on
    // every keystroke pollutes screen-share / support-session devtools
    // logs, so default to quiet.
    try {
      const parsed = JSON.parse(body);
      const content = parsed.messages?.[0]?.content || '';
      const lastLine = content.split('\n').filter((l: string) => l.trim()).pop() || '';
      log.debug('[OpenCues] LLM prompt tail:', lastLine.slice(0, 200));
    } catch { /* ignore */ }

    // Race the SW round-trip against the abort signal. If the signal
    // trips during the in-flight call, we reject with AbortError
    // immediately so the caller can drop its result. The SW request
    // itself runs to completion (Chrome's native-messaging port has
    // no per-message abort yet) — its response is silently discarded
    // by the SW-side requestId tracker. v1 saves runtime work but
    // not provider $$$ for chrome; full SW plumbing is a follow-up.
    // Instrumentation: time the whole content-script → SW → fetch → back
    // round-trip so we can split it into SW-fetch vs IPC + (cold) SW-wake.
    const rtStart = Date.now();
    // Firefox's browser.runtime.sendMessage type takes no result generic
    // (unlike @types/chrome), so cast the Promise result explicitly.
    const fetchP = browser.runtime.sendMessage({
      type: 'opencues:fetch',
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    }) as Promise<ProxiedFetchResponse>;
    const response = signal
      ? await Promise.race<ProxiedFetchResponse>([
          fetchP,
          new Promise<ProxiedFetchResponse>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            }, { once: true });
          }),
        ])
      : await fetchP;
    // Latency split (debug-mode only): total round-trip vs the SW's raw fetch.
    // The gap ≈ IPC hops + a COLD service-worker wake-up (MV3 kills the SW
    // after ~30s idle; the first call after that pays the wake cost). A big gap
    // with a small fetchMs points at SW-wake, not the model or network.
    const roundTripMs = Date.now() - rtStart;
    const swFetchMs = response?.fetchMs;
    if (typeof swFetchMs === 'number') {
      log.debug(`[opencues] LLM latency split: round-trip ${roundTripMs}ms = SW-fetch ${swFetchMs}ms + IPC/SW-wake ${roundTripMs - swFetchMs}ms`);
    } else {
      log.debug(`[opencues] LLM latency: round-trip ${roundTripMs}ms (no SW fetch timing)`);
    }

    if (!response || !response.ok) {
      const status = response?.status ?? 0;
      const statusText = response?.statusText ?? 'sendMessage failed';
      const body = (response?.text ?? '').slice(0, 200);
      // Surface loudly — the resolver above catches and silently
      // suppresses, so without this the user has no signal that an
      // LLM call (cue/blank/transform) failed. Common cause: stale
      // GROQ_API_KEY. Boot-time `verifyLlmKeyAtBoot` catches the
      // already-bad case; this catches the "valid at boot, expired
      // mid-session" case.
      console.error(
        `[opencues] LLM call failed — HTTP ${status} ${statusText} from ${url}. ` +
        (body ? `Server said: ${body}` : 'No response body.'),
      );
      throw new Error(`HTTP ${status}: ${statusText}`);
    }
    const text = response.text;

    // Per-call raw-response log. Same gating as the prompt-tail log
    // above — `debug-mode: on` only, to keep production devtools clean.
    try {
      const data = JSON.parse(text);
      const raw = data.choices?.[0]?.message?.content || '';
      // Suppress the log when content is empty — happens when the
      // model emitted only reasoning tokens, or the response was
      // truncated mid-stream. Otherwise the log line is just noise:
      // `[OpenCues] LLM raw response: ` with no body.
      if (raw.trim().length > 0) {
        log.debug('[OpenCues] LLM raw response:', raw);
      }

      // Normalize space-separated INDEX:alts to pipe-separated
      // Some models return "1:a,b 2:c,d" instead of "1:a,b|2:c,d"
      // Insert | before space-separated INDEX: patterns so opencues-core's parser handles them
      if (raw && /\d+\s*[:=]/.test(raw)) {
        const normalized = raw.replace(/\s+(\d+\s*[:=])/g, '|$1');
        if (normalized !== raw) {
          data.choices[0].message.content = normalized;
          return JSON.stringify(data);
        }
      }
    } catch { /* ignore */ }

    return text;
  }

  async get(url: string, headers?: Record<string, string>): Promise<string> {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.text();
  }
}
