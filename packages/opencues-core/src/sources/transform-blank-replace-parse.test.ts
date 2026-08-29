/**
 * TransformBlankSource × replace-parse-mode — the parallel detector's
 * source-level contract.
 *
 * Pins:
 *   - OFF (default): no detector call is dispatched — exactly one LLM
 *     call per trigger, result is the fused whole-buffer shape.
 *   - ON + verified detection: result carries metadata.transformTarget
 *     + transformInstruction and alternatives [text, value] — the
 *     resolver's bounded-splice inputs.
 *   - ON + detector THROWS: the fused result is untouched (the
 *     no-logical-landmines rule — a failed detector call must never
 *     affect the buffer or the fused path).
 *   - ON + unverifiable detection (target not in buffer): fused result.
 *   - ON + FILL classification: fused result (no divert).
 *
 * The mock adapter routes on the system prompt: the detector's system
 * starts with "You read a short text containing _ and classify".
 * Fixtures are synthetic per the repo fixture rule.
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import { TransformBlankSource } from './transform-blank-source';
import { getProvider } from '../llm-provider';
import type { HttpAdapter, CueContext } from '../types';

const DETECT_MARKER = 'You read a short text containing _ and classify';

interface MockOpts {
  detectResponse?: string;           // detector reply (4-line shape)
  detectThrows?: boolean;
}

function makeMockAdapter(opts: MockOpts = {}): { adapter: HttpAdapter; calls: () => { fused: number; detect: number } } {
  let fused = 0;
  let detect = 0;
  const adapter: HttpAdapter = {
    post: async (_url, body) => {
      const parsed = JSON.parse(body);
      const system: string = parsed.messages?.[0]?.content ?? '';
      if (system.startsWith(DETECT_MARKER)) {
        detect++;
        if (opts.detectThrows) throw new Error('synthetic detector failure');
        const response = opts.detectResponse ?? 'CLASS: FILL\nCOMMAND: NONE\nTARGET: NONE\nVALUE:';
        return JSON.stringify({ choices: [{ message: { content: response } }] });
      }
      fused++;
      const response = [
        'VERDICT: TRANSFORM',
        'INSTRUCTION: zap the word',
        'TARGET: ',
        'REWRITE: alpha ALT-FUSED beta',
      ].join('\n');
      return JSON.stringify({ choices: [{ message: { content: response } }] });
    },
  };
  return { adapter, calls: () => ({ fused, detect }) };
}

function mkSource(adapter: HttpAdapter, replaceParse: boolean): TransformBlankSource {
  return new TransformBlankSource({
    httpAdapter: adapter,
    provider: getProvider('cerebras')!,
    endpoint: 'https://api.cerebras.ai/v1/chat/completions',
    apiKey: 'x',
    model: 'gpt-oss-120b',
    replaceParse,
  });
}

function mkContext(): CueContext {
  return {
    text: 'alpha zephyr beta zap the word _',
    words: ['alpha', 'zephyr', 'beta', 'zap', 'the', 'word', '_'],
  };
}

const VERIFIED_DETECT = 'CLASS: REPLACE\nCOMMAND: zap the word _\nTARGET: zephyr\nVALUE: ALT-ONE';

describe('TransformBlankSource replace-parse-mode', () => {
  beforeEach(() => {
    TransformBlankSource.resetVariantPoolForTest();
  });

  it('OFF (default): no detector dispatch, fused result', async () => {
    const { adapter, calls } = makeMockAdapter({ detectResponse: VERIFIED_DETECT });
    const source = mkSource(adapter, false);
    const r = await source.getCues(mkContext());
    assert.strictEqual(calls().detect, 0, 'no detector call when off');
    assert.strictEqual(calls().fused, 1);
    assert.strictEqual(r.results[0].metadata?.transformTarget, undefined);
    assert.strictEqual(r.results[0].alternatives[1], 'alpha ALT-FUSED beta');
  });

  it('ON + verified REPLACE: bounded-splice result (transformTarget + instruction + value)', async () => {
    const { adapter, calls } = makeMockAdapter({ detectResponse: VERIFIED_DETECT });
    const source = mkSource(adapter, true);
    const r = await source.getCues(mkContext());
    assert.strictEqual(calls().detect, 1);
    assert.strictEqual(calls().fused, 1, 'fused still dispatched (parallel, not replaced)');
    const res = r.results[0];
    assert.strictEqual(res.metadata?.transformTarget, 'zephyr');
    assert.strictEqual(res.metadata?.transformInstruction, 'zap the word');
    assert.strictEqual(res.metadata?.pipelineMode, 'replace-splice');
    assert.deepStrictEqual(res.alternatives, ['alpha zephyr beta zap the word _', 'ALT-ONE']);
  });

  it('ON + detector throws: fused result unaffected (no-logical-landmines)', async () => {
    const { adapter, calls } = makeMockAdapter({ detectThrows: true });
    const source = mkSource(adapter, true);
    const r = await source.getCues(mkContext());
    assert.strictEqual(calls().detect, 1, 'detector was attempted');
    const res = r.results[0];
    assert.strictEqual(res.metadata?.transformTarget, undefined, 'no splice metadata from a failed detector');
    assert.strictEqual(res.alternatives[1], 'alpha ALT-FUSED beta', 'fused rewrite intact');
  });

  it('ON + unverifiable target (not a buffer substring): fused result', async () => {
    const { adapter } = makeMockAdapter({
      detectResponse: 'CLASS: REPLACE\nCOMMAND: zap the word _\nTARGET: quixotl\nVALUE: ALT-ONE',
    });
    const source = mkSource(adapter, true);
    const r = await source.getCues(mkContext());
    const res = r.results[0];
    assert.strictEqual(res.metadata?.transformTarget, undefined);
    assert.strictEqual(res.alternatives[1], 'alpha ALT-FUSED beta');
  });

  it('ON + FILL classification: fused result (no divert)', async () => {
    const { adapter, calls } = makeMockAdapter();  // default FILL reply
    const source = mkSource(adapter, true);
    const r = await source.getCues(mkContext());
    assert.strictEqual(calls().detect, 1);
    const res = r.results[0];
    assert.strictEqual(res.metadata?.transformTarget, undefined);
    assert.strictEqual(res.alternatives[1], 'alpha ALT-FUSED beta');
  });
});
