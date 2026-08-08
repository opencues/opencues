/**
 * Provider router for next-prompt-cues bench. Imports groq-impl as
 * the default (judge always goes through groq-impl directly to keep
 * judging stable across provider sweeps — see CLAUDE.md).
 *
 * Select a different inference provider by setting
 * `OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss | gemini-flash-lite |
 * claude-haiku | openai-nano` (same env-var as fluid-blank).
 */

import * as groqImpl from '../fluid-blank/groq-impl';
import * as cerebrasImpl from '../fluid-blank/cerebras';
import * as geminiImpl from '../fluid-blank/gemini';
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
