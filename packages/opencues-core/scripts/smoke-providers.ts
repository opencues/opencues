/**
 * Live provider smoke test.
 *
 * Hits each built-in provider's real API with a tiny "say hi"-style
 * prompt and reports whether the wire path round-trips cleanly:
 *   - URL + auth header reach the host
 *   - the host accepts our body shape
 *   - parseResponse extracts non-empty text
 *
 * Skips providers whose env key isn't set. A failure here means the
 * provider adapter (or the user's key) needs attention; success means
 * AgentRewrite + cues + blanks can use that provider end-to-end.
 *
 * Usage:
 *   pnpm exec ts-node scripts/smoke-providers.ts
 *   # or, after build:
 *   node packages/opencues-core/dist/scripts/smoke-providers.js
 */
/* eslint-disable no-console */
import * as https from 'node:https';
import { URL } from 'node:url';
import {
  PROVIDER_IDS,
  getProvider,
  buildProviderRequest,
  parseProviderResponse,
  type ProviderId,
} from '../src/llm-provider';

interface Result {
  id: ProviderId;
  /** ok = full round-trip; throttled = 429 (wire OK, host throttled);
   *  skip = no key; fail = real misconfiguration. */
  status: 'ok' | 'throttled' | 'skip' | 'fail';
  detail: string;
  ms?: number;
}

class HttpError extends Error {
  constructor(public statusCode: number, public bodyText: string) {
    super(`HTTP ${statusCode}: ${bodyText.slice(0, 200)}`);
  }
}

function postJson(url: string, body: string, headers: Record<string, string>, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body).toString() },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode && res.statusCode >= 400) {
            reject(new HttpError(res.statusCode, text));
          } else {
            resolve(text);
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.write(body);
    req.end();
  });
}

async function smokeOne(id: ProviderId): Promise<Result> {
  const provider = getProvider(id)!;
  const apiKey = process.env[provider.envKeyName];
  if (!apiKey) {
    return { id, status: 'skip', detail: `${provider.envKeyName} not set` };
  }
  const start = Date.now();
  try {
    const built = buildProviderRequest(
      id,
      {
        model: provider.defaultModel,
        messages: [
          { role: 'system', content: 'You answer with a single short word.' },
          { role: 'user', content: 'Reply with the single word: pong' },
        ],
        // Reasoning models (Groq's gpt-oss-*, Cerebras's gpt-oss-120b)
        // burn tokens on internal reasoning before any visible output,
        // so a small max_tokens leaves nothing for `content`. Match
        // production: 256 + reasoning_effort: 'low'.
        maxTokens: 256,
        temperature: 0,
        reasoningEffort: 'low',
      },
      { apiKey },
    );
    const raw = await postJson(built.url, built.body, built.headers);
    const text = parseProviderResponse(id, raw).trim();
    const ms = Date.now() - start;
    if (!text) {
      return { id, status: 'fail', detail: 'empty response (parser found no text)', ms };
    }
    const oneLine = text.replace(/\s+/g, ' ');
    return { id, status: 'ok', detail: `${provider.defaultModel} → ${JSON.stringify(oneLine.slice(0, 60))}`, ms };
  } catch (err) {
    const ms = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    // 401 / 402 / 403 / 429 = the wire reached the host correctly; the
    // host then refused on auth, billing, or rate-limit grounds. Not a
    // wiring bug — distinguish from real misconfigurations (400 bad
    // shape, 404 wrong URL/model, 5xx server error).
    const wireOkMatch = msg.match(/^HTTP (401|402|403|429)/);
    if (wireOkMatch) {
      const code = wireOkMatch[1];
      const label = code === '429' ? 'rate-limited' : code === '402' ? 'billing/quota' : 'auth';
      return { id, status: 'throttled', detail: `${code} ${label} (wire OK)`, ms };
    }
    return { id, status: 'fail', detail: msg, ms };
  }
}

async function main(): Promise<void> {
  console.log('OpenCues provider smoke test');
  console.log('────────────────────────────');
  const results = await Promise.all(PROVIDER_IDS.map(smokeOne));
  for (const r of results) {
    const icon =
      r.status === 'ok' ? '✓' :
      r.status === 'throttled' ? '~' :
      r.status === 'skip' ? '·' : '✗';
    const ms = r.ms !== undefined ? ` (${r.ms}ms)` : '';
    console.log(`  ${icon} ${r.id.padEnd(11)}${ms.padEnd(9)} ${r.detail}`);
  }
  const failed = results.filter((r) => r.status === 'fail').length;
  const ok = results.filter((r) => r.status === 'ok').length;
  const throttled = results.filter((r) => r.status === 'throttled').length;
  const skipped = results.filter((r) => r.status === 'skip').length;
  console.log('');
  console.log(`Summary: ${ok} ok, ${throttled} throttled (wire OK), ${failed} failed, ${skipped} skipped (key missing)`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('smoke runner crashed:', err);
  process.exit(2);
});
