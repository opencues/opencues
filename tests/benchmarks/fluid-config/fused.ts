/**
 * FUSED fluid-config classifier — bench adapter over the PRODUCTION
 * prompt + parser.
 *
 * HISTORY (July 2026): this file used to carry its OWN copy of the
 * system prompt — the v2.1 settings-only classifier. Production's
 * `SYSTEM_PROMPT` in `config-intent-source.ts` then grew the PROVIDER
 * intent (three-bucket llm-routing) and nobody re-pointed the bench,
 * so every number in EXPERIMENTS.md was validating a prompt that no
 * longer shipped — the exact drift class transform-blank's archive/
 * README documents (bench-local prompts drift; drive the production
 * artifact instead). This rewrite makes the bench import the shipping
 * prompt + parser directly: a prompt edit is now benched by
 * construction, and a bench pass means the SHIPPED classifier passes.
 *
 * The judge/runner contract (`FusedConfigResult`) is preserved.
 * PROVIDER verdicts — which the settings-focused suites never expect —
 * are mapped to a synthetic `provider:<scope>` setting so a reject
 * case that misroutes to a provider switch is counted as the FP it is,
 * and a hit case counts as WRONG_SETTING.
 */

import { chat, sysUser } from './groq';
import {
  SYSTEM_PROMPT,
  parseConfigIntentOutput,
} from '../../../packages/opencues-core/src/sources/config-intent-source';

export interface FusedConfigResult {
  setting: string | null;
  value: string | null;
  confidence: number | null;
  raw: string;
  latencyMs: number;
}

export async function runFused(input: string): Promise<FusedConfigResult> {
  const r = await chat(sysUser(SYSTEM_PROMPT, `INPUT: ${input}`), { maxTokens: 128 });
  const v = parseConfigIntentOutput(r.text);
  if (v.kind === 'setting') {
    return { setting: v.setting, value: v.value, confidence: v.confidence ?? null, raw: r.text, latencyMs: r.latencyMs };
  }
  if (v.kind === 'provider') {
    return {
      setting: `provider:${v.scope}`,
      value: v.model ? `${v.provider}/${v.model}` : v.provider,
      confidence: v.confidence ?? null,
      raw: r.text,
      latencyMs: r.latencyMs,
    };
  }
  return { setting: null, value: null, confidence: v.confidence ?? null, raw: r.text, latencyMs: r.latencyMs };
}
