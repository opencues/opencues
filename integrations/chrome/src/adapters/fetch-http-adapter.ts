import type { HttpAdapter } from '@opencues/core';
import { log } from '../opencues-bootstrap';

interface ProxiedFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
}

/**
 * Browser fetch()-based HTTP adapter for opencues-core.
 * Replaces NodeHttpAdapter for Chrome extension use.
 *
 * POST routes through the background service worker via
 * `chrome.runtime.sendMessage`. Reason: cross-origin POSTs from a
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
  async post(url: string, body: string, headers: Record<string, string>): Promise<string> {
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

    const response = await chrome.runtime.sendMessage<unknown, ProxiedFetchResponse>({
      type: 'opencues:fetch',
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
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
