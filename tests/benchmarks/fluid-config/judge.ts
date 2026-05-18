/**
 * Deterministic judge for the fluid-config classifier.
 *
 * No LLM call — outputs are bounded (kebab-case scalar from a closed
 * registry + enum value). String equality is the right gate. This
 * avoids judge rate-limit issues during parallel sweeps AND removes
 * any possibility of judge bias.
 *
 * Verdict taxonomy is finer than PASS/FAIL because the asymmetry
 * matters: routing a REJECT to a setting is much worse than missing
 * a HIT. The runner uses these verdicts to compute separate
 * precision (reject correctness) and recall (hit correctness) numbers.
 */

import type { FluidConfigCase } from './cases';
import type { FusedConfigResult } from './fused';

export type Verdict =
  | 'TP'             // hit case, routed to correct setting + acceptable value
  | 'WRONG_SETTING'  // hit case, routed to a setting but the wrong one
  | 'WRONG_VALUE'    // hit case, right setting but unacceptable value
  | 'FN'             // hit case, mis-classified as NONE (recoverable — fluid-blank still answers)
  | 'TN'             // reject case, correctly classified as NONE
  | 'FP';            // reject case, mis-routed to SOME setting (the worst outcome)

export interface JudgeResult {
  verdict: Verdict;
  /** True if user-facing behaviour is "correct enough" — TP or TN. */
  pass: boolean;
  rationale: string;
}

export function judge(c: FluidConfigCase, actual: FusedConfigResult): JudgeResult {
  const isReject = c.expected.setting === null;

  if (isReject) {
    if (actual.setting === null) {
      return { verdict: 'TN', pass: true, rationale: 'correctly rejected' };
    }
    return {
      verdict: 'FP',
      pass: false,
      rationale: `false-positive: routed reject to setting=${actual.setting} value=${actual.value ?? '(empty)'}`,
    };
  }

  if (actual.setting === null) {
    return {
      verdict: 'FN',
      pass: false,
      rationale: `false-negative: hit case rejected; expected setting=${c.expected.setting} value=${c.expected.value}`,
    };
  }

  if (actual.setting !== c.expected.setting) {
    return {
      verdict: 'WRONG_SETTING',
      pass: false,
      rationale: `wrong setting: got ${actual.setting}, expected ${c.expected.setting}`,
    };
  }

  const acceptableValues = [c.expected.value, ...(c.expected.valueAlternates ?? [])];
  if (actual.value === null || !acceptableValues.includes(actual.value)) {
    return {
      verdict: 'WRONG_VALUE',
      pass: false,
      rationale: `right setting (${actual.setting}) but wrong value: got ${actual.value ?? '(empty)'}, expected one of [${acceptableValues.join(', ')}]`,
    };
  }

  return { verdict: 'TP', pass: true, rationale: 'correct setting + value' };
}
