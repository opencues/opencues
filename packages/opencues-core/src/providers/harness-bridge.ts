// Harness bridge — dispatch OpenCues' LLM calls through a HOST's own
// configured model instead of one of our providers.
//
// The motivating host is DeepSeek Harness, whose `ctx.llm.stream()` is a
// free-standing one-shot completion against whatever provider and model the
// user already configured there. Routing through it means:
//
//   - a user needs NO OpenCues API key to get cues and blanks;
//   - credentials stay in the host process and never reach a browser;
//   - the host's own retry policy, token metering and provider UI apply.
//
// The transport is deliberately the same `transport: 'cli'` seam
// `claude-code-cli` uses: a provider that owns its own dispatch and returns
// assistant text directly, bypassing buildRequest/parseResponse entirely.
// Nothing here knows what the host is; it knows only that someone
// registered a dispatch function.

import type { ChatRequest, ProviderAdapter } from '../llm-provider';

/**
 * What a host implements to serve this provider. Receives the neutral
 * `ChatRequest` and returns the assistant's text.
 *
 * Hosts are expected to drop any reasoning/thinking blocks and return only
 * the answer text: OpenCues splices this straight into the user's buffer,
 * so chain-of-thought arriving here lands in their document.
 */
export type HarnessDispatch = (req: ChatRequest) => Promise<string>;

/** Describes the host route currently serving the bridge, for diagnostics. */
export interface HarnessBridgeInfo {
  /** Human-readable host name, e.g. "DeepSeek Harness". */
  readonly host: string;
  /** The host-side provider route in use, e.g. "deepseek-official". */
  readonly provider?: string;
  /** The model in use, e.g. "deepseek-v4-flash". */
  readonly model?: string;
}

let dispatch: HarnessDispatch | null = null;
let info: HarnessBridgeInfo | null = null;

/**
 * Register the host's dispatch. Returns a disposer so a host that
 * re-configures (model switched, adapter reloaded) can swap cleanly rather
 * than leaving a stale closure bound.
 *
 * Registering twice replaces the previous binding: the last host to boot
 * owns the bridge, which matches how a host band re-registers on reload.
 */
export function registerHarnessDispatch(fn: HarnessDispatch, describe?: HarnessBridgeInfo): () => void {
  dispatch = fn;
  info = describe ?? null;
  const bound = fn;
  return () => {
    if (dispatch === bound) { dispatch = null; info = null; }
  };
}

/** True when a host has bound a dispatch. Surfaces in doctor / settings UI. */
export function isHarnessBridgeReady(): boolean {
  return dispatch !== null;
}

/** The route currently serving the bridge, or null when unbound. */
export function harnessBridgeInfo(): HarnessBridgeInfo | null {
  return info;
}

/**
 * The `harness` provider.
 *
 * Deliberately NOT in `useStrictJson`'s allowlist: a host bridge cannot
 * promise constrained decoding, so every source takes its existing
 * prompt-based JSON path, which is already exercised by the providers that
 * lack strict mode.
 *
 * `trainsOnInput` is left false. The prose-source guard exists to stop
 * OpenCues silently shipping a user's writing to a provider chosen for its
 * price; that reasoning does not transfer here, because the model serving
 * this bridge is the one the user already configured for their own agent
 * conversation. Their whole session goes to it. Surfacing which model is in
 * use belongs in the host's settings UI, not in a refusal here.
 */
export const HARNESS: ProviderAdapter = {
  id: 'harness',
  displayName: 'Host harness (uses the app\'s own model)',
  transport: 'cli',
  defaultEndpoint: '',  // unused for cli transport
  // The host owns model selection, so there is no meaningful default or
  // catalogue here. A blank model tells the host "use whatever you have
  // configured"; a concrete one is passed through verbatim.
  defaultModel: '',
  knownModels: [],
  envKeyName: '',  // no env var — the host owns credentials
  buildRequest() {
    throw new Error('harness: buildRequest is not used (transport is cli)');
  },
  parseResponse() {
    throw new Error('harness: parseResponse is not used (transport is cli)');
  },
  async invokeCli(req: ChatRequest): Promise<string> {
    const fn = dispatch;
    if (fn === null) {
      throw new Error(
        'harness provider selected but no host dispatch is registered — '
        + 'the host must call registerHarnessDispatch() at boot',
      );
    }
    return await fn(req);
  },
};
