/**
 * codex-responses-client — direct HTTPS to OpenAI's Responses API
 * using the OAuth token stored by the `codex` CLI.
 *
 * Why this exists (and why we don't use codex mcp-server anymore):
 *
 * Going via `codex mcp-server` forced every request through codex's
 * full agentic preamble — ~18K tokens of mandatory shell/edit/plan/
 * apply_patch/browser_use tool definitions baked into the binary,
 * with no flag to strip them. Warm latency floor: ~1.4s.
 *
 * The same auth token that codex uses also opens the underlying
 * Responses endpoint directly — `https://chatgpt.com/backend-api/
 * codex/responses`. We send the SAME OAuth bearer + ChatGPT-Account-Id
 * + originator headers codex sends, but with our own minimal
 * `instructions` (system prompt) and `input` (user prompt). No tool
 * preamble.
 *
 * Bench (May 2026, gpt-5.4-mini, short prompts, 6 runs):
 *   - via codex mcp-server:  median 1396ms, min 1258ms
 *   - via direct responses:  median 631ms,  min 527ms
 *
 * That's a 2.2× speedup, and faster than claude-cli (Haiku) at 840ms.
 *
 * Auth handling:
 *
 *   - Read `~/.codex/auth.json` on every call (codex itself refreshes
 *     it in-place; reading fresh means we always have the latest
 *     access_token without our own refresh state).
 *   - account_id is exposed directly at `tokens.account_id`; no JWT
 *     decode needed.
 *   - On 401 we emit a clear "run `codex login`" error rather than
 *     attempting refresh ourselves — refreshing in two processes
 *     concurrently would race on the auth.json write.
 *
 * Compatibility — pattern used by Zed (#56811), opencode plugin
 * (numman-ali/opencode-openai-codex-auth), and litellm. OAuth-token
 * reuse via the codex client_id is the documented "personal,
 * local-use" pattern. Don't run this as a hosted service.
 *
 * Browser safety: fs / https are lazy-required inside default helpers
 * so chrome bundles can include this module without bundler errors;
 * chrome will never reach the runtime path (no fs access).
 */

const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';

/** Required headers on every responses request. `originator` and the
 *  beta flag mirror what the codex CLI itself sends (verified against
 *  codex 0.133). */
const STATIC_HEADERS = {
  'OpenAI-Beta': 'responses=experimental',
  'originator': 'codex_cli_rs',
  'Content-Type': 'application/json',
  'Accept': 'text/event-stream',
};

/** Shape of the file codex writes to `~/.codex/auth.json`. */
export interface CodexAuthFile {
  auth_mode: 'chatgpt' | 'apikey';
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id: string;
  };
  last_refresh?: string;
}

/** Injectable file reader — defaults to fs.readFile. */
export type ReadAuthFn = () => Promise<CodexAuthFile>;

/** Injectable fetch — defaults to global fetch (Node 18+). */
export type FetchFn = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{
  ok: boolean;
  status: number;
  body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}>;

const defaultReadAuth: ReadAuthFn = async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = (eval('require') as NodeRequire)('fs/promises');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = (eval('require') as NodeRequire)('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = (eval('require') as NodeRequire)('path');
  const authPath = path.join(os.homedir(), '.codex', 'auth.json');
  const raw = await fs.readFile(authPath, 'utf8');
  return JSON.parse(raw);
};

const defaultFetch: FetchFn = (globalThis as { fetch?: FetchFn }).fetch ?? (() => {
  throw new Error('global fetch is not available — Node 18+ required, or pass a fetch implementation');
});

export interface InvokeResponsesOptions {
  /** Model name. Subscription tier accepts: gpt-5.4-mini (default,
   *  fastest), gpt-5.4 (smarter, ~2× slower), gpt-5.5 (newest, slower
   *  still), gpt-5.3-codex (rare use cases). All other names 400 with
   *  "not supported when using Codex with a ChatGPT account". */
  model: string;
  /** System prompt — sent as `instructions`. Optional but recommended;
   *  short values (a few sentences) keep input tokens minimal. */
  systemPrompt: string;
  /** The user's prompt — sent as the `input` array's single user item. */
  userPrompt: string;
  /** Injectable for tests. */
  readAuth?: ReadAuthFn;
  fetch?: FetchFn;
  /** Optional logger; defaults to silent. */
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
  /** Max ms to wait for the request to complete. Defaults to 60s. */
  timeoutMs?: number;
}

/**
 * Invoke the Responses API and return the final assistant text.
 * Reads auth.json fresh (so any background `codex login` refresh is
 * picked up) and streams the SSE response.
 */
export async function invokeCodexResponses(opts: InvokeResponsesOptions): Promise<string> {
  const readAuth = opts.readAuth ?? defaultReadAuth;
  const fetch = opts.fetch ?? defaultFetch;
  const log = opts.log ?? (() => { /* silent */ });
  const timeoutMs = opts.timeoutMs ?? 60_000;

  const auth = await readAuth();
  if (auth.auth_mode !== 'chatgpt' || !auth.tokens) {
    throw new Error(
      'codex-cli: auth.json is not in ChatGPT-subscription mode. ' +
      'Run `codex login` and sign in with your ChatGPT account.',
    );
  }
  const { access_token, account_id } = auth.tokens;
  if (!access_token || !account_id) {
    throw new Error('codex-cli: auth.json missing access_token or account_id — run `codex login`');
  }

  const body = JSON.stringify({
    model: opts.model,
    instructions: opts.systemPrompt,
    input: [{ role: 'user', content: [{ type: 'input_text', text: opts.userPrompt }] }],
    // store: false means the call is stateless server-side — no
    // conversation history saved. Faster on warm calls than
    // chained `previous_response_id` (verified by bench).
    store: false,
    stream: true,
  });

  log('debug', `codex-responses: POST model=${opts.model} promptLen=${opts.userPrompt.length}`);

  // Race the request against the timeout.
  const timer = new Promise<never>((_resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`codex-cli: timeout after ${timeoutMs}ms`)), timeoutMs);
    if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref();
  });
  const work = doRequest({ access_token, account_id, body, fetch, log });
  return Promise.race([work, timer]);
}

async function doRequest(opts: {
  access_token: string;
  account_id: string;
  body: string;
  fetch: FetchFn;
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
}): Promise<string> {
  const res = await opts.fetch(RESPONSES_URL, {
    method: 'POST',
    headers: {
      ...STATIC_HEADERS,
      'Authorization': `Bearer ${opts.access_token}`,
      'ChatGPT-Account-Id': opts.account_id,
    },
    body: opts.body,
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401) {
      throw new Error(
        `codex-cli: 401 from ChatGPT backend — your codex auth has expired or is invalid. ` +
        `Run \`codex login\` to re-authenticate. Body: ${text.slice(0, 200)}`,
      );
    }
    if (res.status === 400) {
      // Most common 400: model not allowed on subscription tier.
      throw new Error(`codex-cli: 400 — ${text.slice(0, 200)}`);
    }
    throw new Error(`codex-cli: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
  if (!res.body) {
    throw new Error('codex-cli: response body was empty (no SSE stream)');
  }
  return parseSseTextDeltas(res.body, opts.log);
}

/**
 * Parse the SSE event stream and accumulate the final assistant text.
 *
 * The Responses API emits a fixed sequence of events:
 *   response.created          - request acknowledged
 *   response.in_progress      - model is generating
 *   response.output_item.added
 *   response.content_part.added
 *   response.output_text.delta  ← incremental text chunks
 *   response.output_text.done
 *   response.content_part.done
 *   response.output_item.done
 *   response.completed        - terminal
 *
 * We accumulate `delta` strings from `response.output_text.delta` and
 * return when the stream ends (the `done` event of the final reader
 * read). Unknown event types are ignored — this lets us pick up new
 * event types added by future API versions without crashing.
 */
async function parseSseTextDeltas(
  body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void,
): Promise<string> {
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let sawCompleted = false;

  const readNext = await sseChunkReader(body);
  while (true) {
    const chunk = await readNext();
    if (chunk === null) break;
    buf += decoder.decode(chunk, { stream: true });
    let nlnl: number;
    while ((nlnl = buf.indexOf('\n\n')) >= 0) {
      const event = buf.slice(0, nlnl);
      buf = buf.slice(nlnl + 2);
      let eventName = 'message';
      const dataLines: string[] = [];
      for (const line of event.split('\n')) {
        if (line.startsWith('event: ')) eventName = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
      }
      if (dataLines.length === 0) continue;
      let parsed: { delta?: unknown; response?: { error?: { message?: string } } };
      try { parsed = JSON.parse(dataLines.join('\n')); }
      catch { continue; }
      if (eventName === 'response.output_text.delta' && typeof parsed.delta === 'string') {
        text += parsed.delta;
      } else if (eventName === 'response.completed') {
        sawCompleted = true;
      } else if (eventName === 'response.failed' || eventName === 'response.error') {
        const msg = parsed.response?.error?.message ?? JSON.stringify(parsed).slice(0, 200);
        throw new Error(`codex-cli: response failed — ${msg}`);
      }
    }
  }
  if (!sawCompleted && text.length === 0) {
    log('warn', 'codex-responses: stream ended without response.completed event and no text emitted');
  }
  return text;
}

/**
 * Wrap either a Web ReadableStream or an async-iterable so callers
 * can read chunks via a uniform `() => Promise<Uint8Array | null>`
 * interface. Node 18+'s global fetch returns a Web ReadableStream;
 * test fakes find it easier to construct async iterables.
 */
async function sseChunkReader(
  body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): Promise<() => Promise<Uint8Array | null>> {
  // ReadableStream has a `.getReader()` method; async iterables don't.
  if (typeof (body as ReadableStream<Uint8Array>).getReader === 'function') {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    return async () => {
      const { done, value } = await reader.read();
      if (done) return null;
      return value ?? null;
    };
  }
  const iter = (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  return async () => {
    const { done, value } = await iter.next();
    if (done) return null;
    return value ?? null;
  };
}

/** Combine system+user messages from a ChatRequest into the shape the
 *  Responses API expects. Same helper exported for symmetry with the
 *  old daemon path. */
export function splitMessagesForResponses(
  messages: ReadonlyArray<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): { systemPrompt: string; userPrompt: string } {
  const sys: string[] = [];
  const usr: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') sys.push(m.content);
    else usr.push(m.content);
  }
  return {
    systemPrompt: sys.join('\n\n').trim(),
    userPrompt: usr.join('\n\n').trim(),
  };
}
