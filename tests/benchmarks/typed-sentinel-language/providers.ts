/**
 * Provider router for this bench. Same shape as the other benches
 * (groq.ts), but only the providers this bench needs (cerebras, claude,
 * gemini, groq, openai) and bench-local.
 *
 * Select via `--provider <id>` on the CLI, or by `OPENCUES_BENCH_PROVIDER`
 * env (mirrors the rest of the suite).
 */

import * as cerebras from '../fluid-blank/cerebras';
import * as groq from '../fluid-blank/groq-impl';
import * as claude from '../fluid-blank/claude';
import * as gemini from '../fluid-blank/gemini';
import * as openai from '../fluid-blank/openai';

export type ProviderId = 'cerebras' | 'groq' | 'claude' | 'gemini' | 'openai';

export interface ProviderAdapter {
  id: ProviderId;
  modelLabel: string;
  chat: (messages: any[], opts?: { temperature?: number; maxTokens?: number; seed?: number }) => Promise<{ text: string; latencyMs: number }>;
  sysUser: (system: string, user: string) => any[];
}

export function pickProvider(id: ProviderId): ProviderAdapter {
  switch (id) {
    case 'cerebras':
      return { id, modelLabel: cerebras.MODEL, chat: cerebras.chat, sysUser: cerebras.sysUser };
    case 'groq':
      return { id, modelLabel: groq.MODEL, chat: groq.chat, sysUser: groq.sysUser };
    case 'claude':
      return { id, modelLabel: claude.MODEL, chat: claude.chat, sysUser: claude.sysUser };
    case 'gemini':
      return { id, modelLabel: gemini.MODEL, chat: gemini.chat, sysUser: gemini.sysUser };
    case 'openai':
      return { id, modelLabel: openai.MODEL, chat: openai.chat, sysUser: openai.sysUser };
  }
}
