// Integration-pass scenario tests — verify BlankFill awaits the
// injected runner when a blank declares `integrate: true`, AND that
// the polished value is what lands in the buffer.
//
// We use a stepValues-backed blank so the substitute resolves
// synchronously inside BlankFill (no host-side LLM dispatch needed
// for the blank fill itself). The INTEGRATION runner is a stub —
// asserts on the request it received + returns a polished string.
//
// Pinned contract (from PR6 of the dehydration plan):
//   - When `runIntegration` is NOT wired, blank.integrate: true is a
//     no-op. Raw value lands. Today-bit-identical fallback.
//   - When wired AND blank.integrate is true, the runner is called
//     with the substituted value + ±300-char surrounding prose +
//     the blank's integrate-hint, and its `polished` field replaces
//     the raw value in the buffer.
//   - When wired AND blank.integrate is FALSE (or unset), the runner
//     is NOT called.
//   - When the runner throws, BlankFill logs + falls back to the raw
//     value (never crashes the splice).
//   - When the runner returns reason='skipped-*' / 'rejected-*' (its
//     `polished` field will be the raw substitute in those cases),
//     the buffer gets the raw value — semantics flow naturally.

import { describe, it, expect } from 'vitest';
import { BlankFill, type IntegrationPassRunner } from './blank-fill';
import { ConfigLoader } from './config-loader';
import { MockAdapter, wrapTipsAsCuesMd } from '../../testing/mock-adapter';
import { SpanFillState } from '../state/span-fill';
import type { IntegrationRequest, IntegrationResult } from '@opencues/core';

const TIPS = wrapTipsAsCuesMd({ concepts: [] });

// Blank goes through the ASYNC applyAsyncFill path (via blank-invoke),
// because the integration gate sits there. stepValues blanks resolve
// synchronously in onUnderscoreKey and bypass the gate — that's by
// design: stepValues are deterministic categorical values that don't
// benefit from polish. Real production blanks that opt-in to integrate
// (stocks/weather/crypto) are blank-invoke-backed, matching this shape.
// blankScript declaration is required by the BlankFill gate even though
// the test never spawns — the gate at maybeRunScripts checks "blankScript
// OR blank-invoke capability". MockAdapter's default caps don't include
// blank-invoke, so we satisfy the gate via blankScript; the stubbed
// blankInvoke still intercepts before any spawn would fire (matching the
// pattern in blank-fill.test.ts).
const INTEGRATE_BLANK = `---
type: blank
name: mock-stock
blankKeywords: nvda
blankProximity: 0
blankClearKeywords: true
blankScript: ./never-spawned.sh
sandbox: strict
integrate: true
integrate-hint: "stock price — match prose conventions"
---
`;

const NON_INTEGRATE_BLANK = `---
type: blank
name: mock-stock
blankKeywords: nvda
blankProximity: 0
blankClearKeywords: true
blankScript: ./never-spawned.sh
sandbox: strict
integrate: false
---
`;

async function setupFill(blankMd: string, runner?: IntegrationPassRunner) {
  const adapter = new MockAdapter({
    cwd: '/proj',
    files: {
      '/mock/CUES.md': TIPS,
      '/proj/blanks/mock-stock/BLANK.md': blankMd,
    },
  });
  // Stub the blank-invoke get-action to return the raw price.
  adapter.stubBlankInvoke('mock-stock:get', '$254.00');
  const loader = new ConfigLoader(adapter);
  await loader.load();
  const spanFill = new SpanFillState();
  const bf = new BlankFill(adapter, loader, spanFill, undefined, undefined, undefined, undefined, runner);
  bf.subscribe();
  return { adapter, loader, bf, spanFill };
}

/** Wait enough microtasks/timer ticks for the blank-invoke + integration
 *  call chain to settle. The chain is: text-change → maybeRunScripts →
 *  blankInvoke.result (Promise) → applyAsyncFill (now async via void
 *  _applyAsyncFillImpl) → integration runner → splice. Three setTimeout
 *  ticks covers it on every host. */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
}

describe('BlankFill integration pass — runner injection + gating', () => {
  it('no-op when runner is not wired (today-bit-identical fallback)', async () => {
    const { adapter } = await setupFill(INTEGRATE_BLANK, undefined);
    // Surrounding prose includes a $ so format-hint would fire if the
    // runner were wired. With no runner, the gate is a no-op.
    adapter.pushText('AAPL is at $200, nvda _');
    await flushAsync();
    expect(adapter.getText()).toContain('$254.00');
  });

  it('does NOT call runner when blank.integrate is false', async () => {
    let calls = 0;
    const runner: IntegrationPassRunner = async () => {
      calls++;
      return { polished: '$254', llmCalled: true, accepted: true, reason: 'polished' };
    };
    const { adapter } = await setupFill(NON_INTEGRATE_BLANK, runner);
    adapter.pushText('AAPL is at $200, nvda _');
    await flushAsync();
    expect(calls).toBe(0);
    expect(adapter.getText()).toContain('$254.00'); // raw, no polish
  });

  it('calls runner with the right shape and uses polished value', async () => {
    const received: IntegrationRequest[] = [];
    const runner: IntegrationPassRunner = async (req) => {
      received.push(req);
      return { polished: '$254', llmCalled: true, accepted: true, reason: 'polished' };
    };
    const { adapter } = await setupFill(INTEGRATE_BLANK, runner);
    adapter.pushText('AAPL is at $200, nvda _');
    await flushAsync();

    expect(received.length).toBe(1);
    expect(received[0].substituted).toBe('$254.00');
    expect(received[0].hint).toBe('stock price — match prose conventions');
    // Surrounding prose: AAPL line is in contextBefore.
    expect(received[0].contextBefore).toContain('AAPL is at $200');

    // Polished value (not raw) lands in the buffer.
    expect(adapter.getText()).toContain('$254');
    expect(adapter.getText()).not.toContain('$254.00');
  });

  it('falls back to raw substitute when the runner throws', async () => {
    const runner: IntegrationPassRunner = async () => {
      throw new Error('runner exploded');
    };
    const { adapter } = await setupFill(INTEGRATE_BLANK, runner);
    adapter.pushText('AAPL is at $200, nvda _');
    await flushAsync();
    expect(adapter.getText()).toContain('$254.00');
  });

  it('respects runner-side rejection (polished field = raw substitute)', async () => {
    const runner: IntegrationPassRunner = async (req) => {
      // Runner internally rejected — its `polished` field is the raw
      // input. Mirrors what runIntegrationPass does on validation
      // failure. BlankFill just consumes `result.polished`.
      return {
        polished: req.substituted,
        llmCalled: true,
        accepted: false,
        reason: 'rejected-numeric-drift',
      };
    };
    const { adapter } = await setupFill(INTEGRATE_BLANK, runner);
    adapter.pushText('AAPL is at $200, nvda _');
    await flushAsync();
    expect(adapter.getText()).toContain('$254.00');
  });

  it('setIntegrationRunner(undefined) disables the gate', async () => {
    const runner: IntegrationPassRunner = async () => ({
      polished: '$POLISHED', llmCalled: true, accepted: true, reason: 'polished',
    });
    const { adapter, bf } = await setupFill(INTEGRATE_BLANK, runner);

    adapter.pushText('AAPL is at $200, nvda _');
    await flushAsync();
    expect(adapter.getText()).toContain('$POLISHED');

    bf.setIntegrationRunner(undefined);
    // Reset buffer + re-trigger so the cache-key/text differ.
    adapter.pushText('AAPL is at $200, nvda _ again');
    await flushAsync();
    expect(adapter.getText()).toContain('$254.00');
    // Polished marker is gone (or at least the new fire produced raw).
    expect(adapter.getText().split('$254.00').length).toBeGreaterThanOrEqual(2);
  });
});
