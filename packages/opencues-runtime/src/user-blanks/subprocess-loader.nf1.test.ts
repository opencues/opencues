// INFOSEC NF1 second-pass — the Bun-subprocess loader's ctx.llm secret
// guard scans a string-coerced body (`${system}\n${prompt}`). The IPC
// boundary (subprocess-runner.cjs) JSON.parses the blank's request with
// no shape validation, so a non-string `prompt`/`system` field must not
// be able to smuggle a secret past the scan by stringifying to
// "[object Object]" in the scan while serializing the real value into
// the wire body downstream. The handler coerces prompt/system to
// strings ONCE and forwards the coerced values, so the bytes the scan
// reads are exactly the bytes that reach the wire.
//
// Provider-independent by construction: with no bound secrets the
// hostname-resolution block is skipped (no @opencues/core / resolveLLM
// dependency), leaving just the coercion invariant under test.
import { describe, it, expect } from 'vitest';
import { buildCapabilityHandler } from './subprocess-loader';
import type { BlankCapabilities } from './types';
import type { LoaderOptions } from './node-loader';

describe('subprocess-loader ctx.llm — NF1 second-pass coercion', () => {
  function makeHandler() {
    let received: { prompt: unknown; system?: unknown } | undefined;
    const caps = { llm: 'groq' } as unknown as BlankCapabilities;
    const opts = {
      llm: async (_provider: string, req: { prompt: unknown; system?: unknown }) => {
        received = req;
        return 'ok';
      },
    } as unknown as LoaderOptions;
    const handler = buildCapabilityHandler(caps, opts);
    return { handler, getReceived: () => received };
  }

  it('coerces a non-string prompt to a string before forwarding (no object smuggle to the wire)', async () => {
    const { handler, getReceived } = makeHandler();
    // A malicious blank tries to hide a secret inside an object so the
    // string-coercion scan reads "[object Object]".
    await handler.llm!({ prompt: { leak: 'SUPERSECRETVALUE' } } as never);

    const received = getReceived()!;
    // The object never reaches the LLM adapter — it's coerced first, so
    // the secret value cannot ride the request body to the provider.
    expect(typeof received.prompt).toBe('string');
    expect(received.prompt).toBe('[object Object]');
    expect(String(received.prompt)).not.toContain('SUPERSECRETVALUE');
  });

  it('coerces a non-string system field the same way', async () => {
    const { handler, getReceived } = makeHandler();
    await handler.llm!({ prompt: 'hi', system: { leak: 'SUPERSECRETVALUE' } } as never);

    const received = getReceived()!;
    expect(typeof received.system).toBe('string');
    expect(String(received.system)).not.toContain('SUPERSECRETVALUE');
  });

  it('forwards a normal string prompt unchanged (happy path unaffected)', async () => {
    const { handler, getReceived } = makeHandler();
    await handler.llm!({ prompt: 'summarize this', system: 'you are helpful' } as never);

    const received = getReceived()!;
    expect(received.prompt).toBe('summarize this');
    expect(received.system).toBe('you are helpful');
  });
});
