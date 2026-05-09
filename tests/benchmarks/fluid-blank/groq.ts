/**
 * Provider router for the fluid-blank benchmark.
 *
 * Default: re-exports `chat` / `sysUser` / `MODEL` from `./groq-impl`
 * (the original Groq + gpt-oss-120b client). Set the env var
 *
 *   OPENCUES_BENCH_PROVIDER=gemini-flash-lite
 *
 * to swap to `./gemini` (Gemini 3.1 Flash Lite). Same chat() signature,
 * same workload — apples-to-apples model comparison without touching
 * the benchmark's other source files.
 */

import * as groqImpl from './groq-impl';
import * as geminiImpl from './gemini';

const impl = process.env.OPENCUES_BENCH_PROVIDER === 'gemini-flash-lite'
  ? geminiImpl
  : groqImpl;

export const chat = impl.chat;
export const sysUser = impl.sysUser;
export const MODEL = impl.MODEL;
export type { ChatMessage, ChatResult } from './groq-impl';
