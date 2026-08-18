/**
 * Provider router for the sentence-cues benchmark.
 *
 * Re-uses the fluid-blank adapters (groq-impl / cerebras / gemini /
 * claude / openai) for identical OPENCUES_BENCH_PROVIDER semantics
 * across benches. Same env-var switch, same per-provider model
 * overrides.
 */

import * as groqImpl from '../fluid-blank/groq-impl';
import * as geminiImpl from '../fluid-blank/gemini';
import * as cerebrasImpl from '../fluid-blank/cerebras';
import * as claudeImpl from '../fluid-blank/claude';
import * as openaiImpl from '../fluid-blank/openai';
import * as deepseekImpl from '../fluid-blank/deepseek';

function pickImpl() {
  switch (process.env.OPENCUES_BENCH_PROVIDER) {
    case 'gemini-flash-lite': return geminiImpl;
    case 'cerebras-gpt-oss':  return cerebrasImpl;
    case 'claude-haiku':      return claudeImpl;
    case 'openai-nano':       return openaiImpl;
    case 'deepseek-flash':    return deepseekImpl;
    default:                  return groqImpl;
  }
}
const impl = pickImpl();

export const chat = impl.chat;
export const sysUser = impl.sysUser;
export const MODEL = impl.MODEL;
export type { ChatMessage, ChatResult } from '../fluid-blank/groq-impl';
