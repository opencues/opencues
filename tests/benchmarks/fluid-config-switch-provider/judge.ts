/**
 * Deterministic judge for the fluid-config switch-provider bench.
 *
 * No LLM call — the verdict shape is bounded (kind ∈ {setting,
 * provider, none}; scope ∈ {cues, auditors, blanks}; provider ∈
 * ProviderId; model ∈ knownModels). Equality is the right gate.
 *
 * Verdict taxonomy matches the runner's bucket layout:
 *
 *   TP-PROVIDER    — provider hit, right scope+provider, model matches
 *                    (when expected model is non-null) OR expected model
 *                    is null and any model (or none) is accepted
 *   TP-SETTING     — setting hit (regression coverage)
 *   TN             — reject case correctly classified as NONE
 *   WRONG-KIND     — got setting when expected provider, etc.
 *   WRONG-SCOPE    — provider intent, right provider, wrong bucket
 *   WRONG-PROVIDER — provider intent, right scope, wrong provider
 *   WRONG-MODEL    — provider intent, right scope+provider, wrong model
 *   FP             — reject case mis-classified as a hit (worst outcome)
 *   FN             — hit case rejected as NONE (recoverable)
 */

import type { SwitchProviderCase, Expected } from './cases';

export type Verdict =
  | 'TP-PROVIDER'
  | 'TP-SETTING'
  | 'TN'
  | 'WRONG-KIND'
  | 'WRONG-SCOPE'
  | 'WRONG-PROVIDER'
  | 'WRONG-MODEL'
  | 'FP'
  | 'FN';

export interface JudgeResult {
  readonly verdict: Verdict;
  readonly pass: boolean;
  readonly rationale: string;
}

/** Loose verdict shape — what the runner extracts from the LLM call. */
export interface ActualVerdict {
  readonly kind: 'setting' | 'provider' | 'none';
  readonly setting?: string;
  readonly value?: string;
  readonly scope?: string;
  readonly provider?: string;
  readonly model?: string | null;
}

export function judge(c: SwitchProviderCase, actual: ActualVerdict): JudgeResult {
  const exp: Expected = c.expected;

  if (exp.kind === 'none') {
    if (actual.kind === 'none') return { verdict: 'TN', pass: true, rationale: 'correctly rejected' };
    return { verdict: 'FP', pass: false, rationale: `false-positive: routed reject to ${describeActual(actual)}` };
  }

  if (actual.kind === 'none') {
    return { verdict: 'FN', pass: false, rationale: `false-negative: hit case rejected; expected ${describeExpected(exp)}` };
  }

  if (exp.kind !== actual.kind) {
    return { verdict: 'WRONG-KIND', pass: false, rationale: `expected kind=${exp.kind}, got ${actual.kind} (${describeActual(actual)})` };
  }

  if (exp.kind === 'setting' && actual.kind === 'setting') {
    if (actual.setting !== exp.setting) {
      return { verdict: 'WRONG-PROVIDER', pass: false, rationale: `wrong setting: got ${actual.setting}, expected ${exp.setting}` };
    }
    if (actual.value !== exp.value) {
      return { verdict: 'WRONG-MODEL', pass: false, rationale: `right setting (${actual.setting}) wrong value: got ${actual.value ?? '(empty)'}, expected ${exp.value}` };
    }
    return { verdict: 'TP-SETTING', pass: true, rationale: 'correct setting + value' };
  }

  // both kinds === 'provider'
  if (exp.kind === 'provider' && actual.kind === 'provider') {
    if (actual.scope !== exp.scope) {
      return { verdict: 'WRONG-SCOPE', pass: false, rationale: `wrong scope: got ${actual.scope}, expected ${exp.scope}` };
    }
    const providerOk = actual.provider === exp.provider || (exp.providerAlternates ?? []).includes(actual.provider ?? '');
    if (!providerOk) {
      return { verdict: 'WRONG-PROVIDER', pass: false, rationale: `wrong provider: got ${actual.provider}, expected ${exp.provider}${exp.providerAlternates ? ` (or one of ${exp.providerAlternates.join(', ')})` : ''}` };
    }
    if (exp.model !== null) {
      const allowedModels = [exp.model, ...(exp.modelAlternates ?? [])];
      if (!actual.model || !allowedModels.includes(actual.model)) {
        return { verdict: 'WRONG-MODEL', pass: false, rationale: `wrong model: got ${actual.model ?? '(empty)'}, expected one of [${allowedModels.join(', ')}]` };
      }
    } else if (actual.model && exp.modelAlternates && !exp.modelAlternates.includes(actual.model)) {
      // expected.model === null. Any model (or none) is acceptable,
      // unless modelAlternates is set and the actual doesn't match.
      return { verdict: 'WRONG-MODEL', pass: false, rationale: `expected no specific model OR one of [${exp.modelAlternates.join(', ')}], got ${actual.model}` };
    }
    return { verdict: 'TP-PROVIDER', pass: true, rationale: `correct scope+provider${actual.model ? ' + model' : ''}` };
  }

  return { verdict: 'WRONG-KIND', pass: false, rationale: 'unreachable' };
}

function describeExpected(e: Expected): string {
  if (e.kind === 'none') return 'NONE';
  if (e.kind === 'setting') return `setting=${e.setting} value=${e.value}`;
  return `provider scope=${e.scope} provider=${e.provider} model=${e.model ?? '(any)'}`;
}

function describeActual(a: ActualVerdict): string {
  if (a.kind === 'none') return 'NONE';
  if (a.kind === 'setting') return `setting=${a.setting} value=${a.value}`;
  return `provider scope=${a.scope} provider=${a.provider} model=${a.model ?? '(empty)'}`;
}
