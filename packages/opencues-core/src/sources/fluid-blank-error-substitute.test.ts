// FluidBlankSource — user-actionable LLM failures emit an in-buffer
// substitute via formatErrorAsSubstitute. LLM-internal issues
// (no-span, no-answer, malformed JSON) stay silent.
//
// Pins the contract that motivated the May 2026 "no silent failures"
// pass: every error path the user CAN do something about (bad key,
// 404 endpoint, network down, rate-limit) shows a message in their
// buffer. Transient or model-internal issues don't bother the user.

import { describe, expect, it } from 'vitest';
import { FluidBlankSource, type FluidBlankErrorReason } from './fluid-blank-source';
import type { HttpAdapter } from '../types';
import type { ProviderAdapter } from '../llm-provider';

// Minimal provider stub — FluidBlankSource only needs `id` + the
// callLLM hook into dispatchChat, which we short-circuit via the
// httpAdapter throwing. Body/parser methods are never called.
const STUB_PROVIDER = {
  id: 'cerebras',
  displayName: 'Cerebras',
  defaultEndpoint: 'https://api.cerebras.ai/v1/chat/completions',
  defaultModel: 'gpt-oss-120b',
  envKeyName: 'CEREBRAS_API_KEY',
  buildRequest: (req: { model: string }, ctx: { apiKey: string; endpoint: string }) => ({
    url: ctx.endpoint,
    body: JSON.stringify({ model: req.model }),
    headers: { Authorization: `Bearer ${ctx.apiKey}` },
  }),
  parseResponse: () => ({ content: '' }),
} as unknown as ProviderAdapter;

function makeFluid(opts: {
  formatErrorAsSubstitute?: (reason: FluidBlankErrorReason, err?: Error) => string;
  throwError?: Error;
}): FluidBlankSource {
  const httpAdapter: HttpAdapter = {
    post: async () => {
      if (opts.throwError) throw opts.throwError;
      return '{"choices":[{"message":{"content":""}}]}';
    },
  };
  return new FluidBlankSource({
    httpAdapter,
    provider: STUB_PROVIDER,
    endpoint: 'https://api.cerebras.ai/v1/chat/completions',
    apiKey: 'csk-test',
    model: 'gpt-oss-120b',
    formatErrorAsSubstitute: opts.formatErrorAsSubstitute,
  });
}

const SAMPLE_CONTEXT = {
  text: 'what is the capital of France _',
  words: ['what', 'is', 'the', 'capital', 'of', 'France', '_'],
};

describe('FluidBlankSource — user-actionable error substitution', () => {
  it('401 → substitutes _ with the host-supplied "invalid-api-key" message', async () => {
    let observedReason: FluidBlankErrorReason | undefined;
    const fluid = makeFluid({
      throwError: new Error('HTTP 401: Unauthorized'),
      formatErrorAsSubstitute: (reason) => {
        observedReason = reason;
        return '[OpenCues: API key rejected — open the extension popup and re-enter it]';
      },
    });
    const result = await fluid.getCues(SAMPLE_CONTEXT);
    expect(observedReason).toBe('invalid-api-key');
    expect(result.results.length).toBe(1);
    expect(result.results[0].alternatives[0]).toBe('_'); // cycle back dismisses
    expect(result.results[0].alternatives[1]).toContain('API key rejected');
  });

  it('403 → also classified as invalid-api-key', async () => {
    let observedReason: FluidBlankErrorReason | undefined;
    const fluid = makeFluid({
      throwError: new Error('HTTP 403: Forbidden'),
      formatErrorAsSubstitute: (reason) => { observedReason = reason; return '[bad key]'; },
    });
    const result = await fluid.getCues(SAMPLE_CONTEXT);
    expect(observedReason).toBe('invalid-api-key');
    expect(result.results.length).toBe(1);
  });

  it('404 → substitutes with the "endpoint-not-found" message', async () => {
    let observedReason: FluidBlankErrorReason | undefined;
    const fluid = makeFluid({
      throwError: new Error('HTTP 404: Not Found at https://wrong-endpoint.example/v1/chat/completions'),
      formatErrorAsSubstitute: (reason) => {
        observedReason = reason;
        return '[OpenCues: provider endpoint returned 404 — check the API URL]';
      },
    });
    const result = await fluid.getCues(SAMPLE_CONTEXT);
    expect(observedReason).toBe('endpoint-not-found');
    expect(result.results[0].alternatives[1]).toContain('check the API URL');
  });

  it('Cerebras model_not_found (no HTTP status in message) → "model-not-found" substitute', async () => {
    // The EXACT message Cerebras throws when an `openai/`-namespaced
    // model name is sent to it (it serves the same weights bare). This
    // string carries NO "404"/status number, so before the model-not-found
    // matcher it fell through classifyHttpError to the silent default —
    // the user only saw it in /tmp/opencues.log, never inline. Pins the
    // regression: model-mismatch must surface inline like 401/404 do.
    let observedReason: FluidBlankErrorReason | undefined;
    const fluid = makeFluid({
      throwError: new Error(
        'provider error: Model openai/gpt-oss-120b does not exist or you do not have access to it. (code=model_not_found, type=not_found_error)',
      ),
      formatErrorAsSubstitute: (reason) => {
        observedReason = reason;
        return '[OpenCues: model not available for the chosen provider — make llm-model: and llm-provider: a valid pair]';
      },
    });
    const result = await fluid.getCues(SAMPLE_CONTEXT);
    expect(observedReason).toBe('model-not-found');
    expect(result.results.length).toBe(1);
    expect(result.results[0].alternatives[0]).toBe('_'); // cycle back dismisses
    expect(result.results[0].alternatives[1]).toContain('model not available');
    expect((result.results[0].metadata as { fluidBlankErrorReason?: string }).fluidBlankErrorReason).toBe('model-not-found');
  });

  it('404 that names the model → "model-not-found" (not endpoint), checked before the 404 branch', async () => {
    let observedReason: FluidBlankErrorReason | undefined;
    const fluid = makeFluid({
      throwError: new Error('HTTP 404: model `gpt-oss-120b` does not exist'),
      formatErrorAsSubstitute: (reason) => { observedReason = reason; return '[model]'; },
    });
    await fluid.getCues(SAMPLE_CONTEXT);
    expect(observedReason).toBe('model-not-found');
  });

  it('Cerebras out-of-credits (402, no status number, textual billing error) → "insufficient-credits"', async () => {
    // Once self-healing lands a VALID model, the next real failure to
    // surface is billing. Cerebras throws this with NO "402" substring,
    // so the matcher keys on the textual payment/quota error.
    let observedReason: FluidBlankErrorReason | undefined;
    const fluid = makeFluid({
      throwError: new Error(
        'provider error: Payment required to access this resource. Visit your billing tab. (code=payment_required, type=payment_required_error)',
      ),
      formatErrorAsSubstitute: (reason) => {
        observedReason = reason;
        return '[OpenCues: provider rejected the request — out of credits / quota]';
      },
    });
    const result = await fluid.getCues(SAMPLE_CONTEXT);
    expect(observedReason).toBe('insufficient-credits');
    expect(result.results.length).toBe(1);
    expect(result.results[0].alternatives[1]).toContain('out of credits');
  });

  it('insufficient_quota textual error → "insufficient-credits"', async () => {
    let observedReason: FluidBlankErrorReason | undefined;
    const fluid = makeFluid({
      throwError: new Error('provider error: You exceeded your current quota (insufficient_quota)'),
      formatErrorAsSubstitute: (reason) => { observedReason = reason; return '[credits]'; },
    });
    await fluid.getCues(SAMPLE_CONTEXT);
    expect(observedReason).toBe('insufficient-credits');
  });

  it('429 → "rate-limit" substitute', async () => {
    let observedReason: FluidBlankErrorReason | undefined;
    const fluid = makeFluid({
      throwError: new Error('HTTP 429: Too Many Requests'),
      formatErrorAsSubstitute: (reason) => { observedReason = reason; return '[ratelimit]'; },
    });
    const result = await fluid.getCues(SAMPLE_CONTEXT);
    expect(observedReason).toBe('rate-limit');
    expect(result.results.length).toBe(1);
  });

  it('Network unreachable → "network" substitute', async () => {
    let observedReason: FluidBlankErrorReason | undefined;
    const fluid = makeFluid({
      throwError: new Error('Failed to fetch'),
      formatErrorAsSubstitute: (reason) => { observedReason = reason; return '[network down]'; },
    });
    const result = await fluid.getCues(SAMPLE_CONTEXT);
    expect(observedReason).toBe('network');
    expect(result.results[0].alternatives[1]).toBe('[network down]');
  });

  it('ECONNREFUSED → also classified as network', async () => {
    const reasons: FluidBlankErrorReason[] = [];
    const fluid = makeFluid({
      throwError: new Error('connect ECONNREFUSED 127.0.0.1:8080'),
      formatErrorAsSubstitute: (reason) => { reasons.push(reason); return '[net]'; },
    });
    await fluid.getCues(SAMPLE_CONTEXT);
    expect(reasons).toEqual(['network']);
  });

  it('500 (server error) → NO substitute (silent, retry on next change)', async () => {
    let invoked = false;
    const fluid = makeFluid({
      throwError: new Error('HTTP 500: Internal Server Error'),
      formatErrorAsSubstitute: () => { invoked = true; return '[never]'; },
    });
    const result = await fluid.getCues(SAMPLE_CONTEXT);
    expect(invoked).toBe(false);
    expect(result.results.length).toBe(0);
  });

  it('Unknown generic error → NO substitute', async () => {
    let invoked = false;
    const fluid = makeFluid({
      throwError: new Error('something weird happened'),
      formatErrorAsSubstitute: () => { invoked = true; return '[never]'; },
    });
    const result = await fluid.getCues(SAMPLE_CONTEXT);
    expect(invoked).toBe(false);
    expect(result.results.length).toBe(0);
  });

  it('Host with no formatErrorAsSubstitute → silent (back-compat default)', async () => {
    const fluid = makeFluid({
      throwError: new Error('HTTP 401: Unauthorized'),
      // No formatter — back-compat: silent failure preserved.
    });
    const result = await fluid.getCues(SAMPLE_CONTEXT);
    expect(result.results.length).toBe(0);
  });

  it('Formatter returns empty string → silent (opt-out per-reason)', async () => {
    const fluid = makeFluid({
      throwError: new Error('HTTP 401: Unauthorized'),
      formatErrorAsSubstitute: () => '', // host says "suppress this one"
    });
    const result = await fluid.getCues(SAMPLE_CONTEXT);
    expect(result.results.length).toBe(0);
  });

  it('Substitute always offers _ as alternatives[0] so user can cycle back to bare blank', async () => {
    const fluid = makeFluid({
      throwError: new Error('HTTP 401'),
      formatErrorAsSubstitute: () => '[err]',
    });
    const result = await fluid.getCues(SAMPLE_CONTEXT);
    expect(result.results[0].alternatives[0]).toBe('_');
    expect(result.results[0].alternatives).toHaveLength(2);
  });
});
