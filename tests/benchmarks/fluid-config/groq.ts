/**
 * Provider router for the fluid-config benchmark. Mirrors the
 * fluid-blank/groq.ts shape exactly — same five providers, same env
 * switch, same per-provider model overrides:
 *
 *   gemini-flash-lite   → ../fluid-blank/gemini       (Gemini 3.1 Flash Lite)
 *   cerebras-gpt-oss    → ../fluid-blank/cerebras     (gpt-oss-120b on Cerebras)
 *   claude-haiku        → ../fluid-blank/claude       (Claude Haiku 4.5)
 *   openai-nano         → ../fluid-blank/openai       (gpt-5.4-nano)
 *   (unset / anything)  → ../fluid-blank/groq-impl    (Groq + gpt-oss-120b, default)
 *
 * Re-uses fluid-blank's adapters instead of duplicating them — keeps
 * cross-bench provider behaviour consistent and means a fix to one
 * adapter (e.g. a rate-limit tolerance tweak) fixes both pipelines.
 */

import * as groqImpl from '../fluid-blank/groq-impl';
import * as geminiImpl from '../fluid-blank/gemini';
import * as cerebrasImpl from '../fluid-blank/cerebras';
import * as claudeImpl from '../fluid-blank/claude';
import * as openaiImpl from '../fluid-blank/openai';

function pickImpl() {
  switch (process.env.OPENCUES_BENCH_PROVIDER) {
    case 'gemini-flash-lite': return geminiImpl;
    case 'cerebras-gpt-oss':  return cerebrasImpl;
    case 'claude-haiku':      return claudeImpl;
    case 'openai-nano':       return openaiImpl;
    default:                  return groqImpl;
  }
}
const impl = pickImpl();

export const chat = impl.chat;
export const sysUser = impl.sysUser;
export const MODEL = impl.MODEL;
export type { ChatMessage, ChatResult } from '../fluid-blank/groq-impl';
