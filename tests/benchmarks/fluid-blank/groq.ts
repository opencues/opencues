/**
 * Provider router for the fluid-blank benchmark. Same shape as
 * transform-blank/groq.ts — five providers behind one chat() interface,
 * selected via OPENCUES_BENCH_PROVIDER:
 *
 *   gemini-flash-lite   → ./gemini        (Gemini 3.1 Flash Lite)
 *   cerebras-gpt-oss    → ./cerebras      (gpt-oss-120b on Cerebras)
 *   claude-haiku        → ./claude        (Claude Haiku 4.5)
 *   openai-nano         → ./openai        (gpt-5.4-nano)
 *   opencode-zen        → ./opencode-zen  (free pool — model via OPENCUES_OPENCODE_ZEN_MODEL)
 *   deepseek-flash      → ./deepseek      (deepseek-v4-flash)
 *   groq-qwen38         → ./groq-qwen38   (Groq preview, qwen/qwen3.8-27b)
 *   (unset / anything)  → ./groq-impl     (Groq + gpt-oss-120b, default)
 */

import * as groqImpl from './groq-impl';
import * as geminiImpl from './gemini';
import * as cerebrasImpl from './cerebras';
import * as claudeImpl from './claude';
import * as openaiImpl from './openai';
import * as opencodeZenImpl from './opencode-zen';
import * as deepseekImpl from './deepseek';
import * as groqQwen38Impl from './groq-qwen38';

function pickImpl() {
  switch (process.env.OPENCUES_BENCH_PROVIDER) {
    case 'gemini-flash-lite': return geminiImpl;
    case 'cerebras-gpt-oss':  return cerebrasImpl;
    case 'claude-haiku':      return claudeImpl;
    case 'openai-nano':       return openaiImpl;
    case 'opencode-zen':      return opencodeZenImpl;
    case 'deepseek-flash':    return deepseekImpl;
    case 'groq-qwen38':       return groqQwen38Impl;
    default:                  return groqImpl;
  }
}
const impl = pickImpl();

export const chat = impl.chat;
export const sysUser = impl.sysUser;
export const MODEL = impl.MODEL;
export type { ChatMessage, ChatResult } from './groq-impl';
