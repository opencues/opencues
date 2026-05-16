/**
 * Provider router for the transform-blank benchmark.
 *
 * Default: re-exports `chat` / `sysUser` / `MODEL` from `./groq-impl`
 * (Groq + gpt-oss-120b). Switch via OPENCUES_BENCH_PROVIDER:
 *
 *   gemini-flash-lite   → ./gemini       (Gemini 3.1 Flash Lite)
 *   cerebras-gpt-oss    → ./cerebras     (gpt-oss-120b on Cerebras)
 *   claude-haiku        → ./claude       (Claude Haiku 4.5)
 *   openai-nano         → ./openai       (gpt-5.4-nano)
 *
 * Same chat() signature, same workload — apples-to-apples model
 * comparison without touching the benchmark's other source files.
 */

import * as groqImpl from './groq-impl';
import * as geminiImpl from './gemini';
import * as cerebrasImpl from './cerebras';
import * as claudeImpl from './claude';
import * as openaiImpl from './openai';

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
export type { ChatMessage, ChatResult } from './groq-impl';
