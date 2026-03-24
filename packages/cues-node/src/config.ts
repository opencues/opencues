/**
 * cues-node/config.ts
 *
 * Node.js configuration adapter using environment variables.
 */

import { ConfigAdapter } from 'cues-core';

/**
 * Node.js config adapter using process.env.
 */
export class NodeConfigAdapter implements ConfigAdapter {
  private overrides: Record<string, string> = {};

  /**
   * Get a configuration value.
   *
   * @param key - Environment variable name
   * @returns Value or undefined
   */
  get(key: string): string | undefined {
    return this.overrides[key] ?? process.env[key];
  }

  /**
   * Get all configuration values.
   */
  getAll(): Record<string, string> {
    return {
      ...(process.env as Record<string, string>),
      ...this.overrides,
    };
  }

  /**
   * Set an override value (useful for testing).
   *
   * @param key - Key to set
   * @param value - Value to set
   */
  set(key: string, value: string): void {
    this.overrides[key] = value;
  }

  /**
   * Clear an override.
   *
   * @param key - Key to clear
   */
  clear(key: string): void {
    delete this.overrides[key];
  }

  /**
   * Clear all overrides.
   */
  clearAll(): void {
    this.overrides = {};
  }
}

/**
 * Get common config values used by cues system.
 */
export interface CuesConfig {
  groqApiKey?: string;
  geminiApiKey?: string;
  llmModel?: string;
  tipsFilePath?: string;
  debug?: boolean;
}

/**
 * Load cues configuration from environment.
 */
export function loadCuesConfig(adapter: ConfigAdapter): CuesConfig {
  return {
    groqApiKey: adapter.get('GROQ_API_KEY'),
    geminiApiKey: adapter.get('GEMINI_API_KEY'),
    llmModel: adapter.get('LLM_MODEL'),
    tipsFilePath: adapter.get('CUES_TIPS_PATH') ?? '~/.claude/claude-code-tips.json',
    debug: adapter.get('CUES_DEBUG') === 'true',
  };
}
