/**
 * Vitest entry point for the typing-simulation harness.
 *
 * Drives every scenario in `scenarios.ts` against a real AgentRewrite
 * + the configured mock LLM. Invariants run after every tick; any
 * violation fails the test with a full repro.
 *
 * As you discover bugs, add scenarios to scenarios.ts. Existing
 * invariants run against new scenarios automatically — that's the
 * leverage. When the LLM in production does something unexpected,
 * encode the misbehavior as a mock response, set up the typing
 * pattern, and the regression is pinned.
 */
import { describe, expect, it } from 'vitest';
import { simulate, reportResult } from './simulator';
import { SCENARIOS } from './scenarios';
import { fuzz } from './fuzz';

describe('AgentRewrite — typing-simulation harness (curated scenarios)', () => {
  for (const scenario of SCENARIOS) {
    it(`scenario: ${scenario.name} [${scenario.tags.join(', ')}]`, async () => {
      const result = await simulate(scenario.name, scenario.steps, {
        task: scenario.task,
        llm: scenario.llm,
        stopOnViolation: false,
        skipInvariants: scenario.skipInvariants,
      });
      if (!result.passed) {
        // eslint-disable-next-line no-console
        console.log(reportResult(result));
      }
      expect(result.violations).toEqual([]);
    });
  }
});

describe('AgentRewrite — property-based fuzzer', () => {
  it('fuzz: 30 seeds × every adversarial LLM produce no invariant violations', async () => {
    const report = await fuzz({ seeds: 30, scriptLength: 12 });
    if (report.violations.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`Fuzz found ${report.violations.length} violation(s):`);
      for (const v of report.violations.slice(0, 5)) {
        // eslint-disable-next-line no-console
        console.log(`\n--- seed=${v.seed} llm=${v.llmName} ---`);
        // eslint-disable-next-line no-console
        console.log(reportResult(v.result));
      }
    }
    expect(report.violations).toEqual([]);
  }, 60_000);
});
