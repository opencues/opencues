/**
 * cues-core/sources/build-sources.ts
 *
 * Factory that creates CueSource[] from parsed .md configs.
 * Single entry point — replaces manual source construction in integrations.
 */

import { CueSource, HttpAdapter } from '../types';
import { CuesMdConfig } from '../cues-md';
import { ConfigSource } from './config-source';
import { ClassifiedSourceGroup } from './classified-source-group';

export interface BuildSourcesOptions {
  httpAdapter: HttpAdapter;
  endpoint: string;
  apiKey: string;
  defaultModel: string;
}

/**
 * Build CueSource[] from parsed cues.md and blanks.md configs.
 *
 * - cues.md ### sections → ConfigSource instances (scope: words)
 * - blanks.md ### sections → ClassifiedSourceGroup (scope: blanks)
 *   - ### classifier → group's classifier prompt
 *   - other ### sections → child ConfigSource instances
 */
export function buildSourcesFromConfig(
  cuesConfig: CuesMdConfig | undefined,
  blanksConfig: CuesMdConfig | undefined,
  options: BuildSourcesOptions,
): CueSource[] {
  const sources: CueSource[] = [];

  // From cues.md: each ### section becomes a words-scoped ConfigSource
  if (cuesConfig?.promptConfig?.sources) {
    for (const [, srcCfg] of Object.entries(cuesConfig.promptConfig.sources)) {
      if (srcCfg.enabled === false || !srcCfg.promptText) continue;
      sources.push(new ConfigSource({
        sourceConfig: { ...srcCfg, scope: srcCfg.scope ?? 'words' },
        ...options,
      }));
    }
  }

  // From blanks.md: build ClassifiedSourceGroup
  if (blanksConfig?.promptConfig?.sources) {
    const blankSources: ConfigSource[] = [];
    let classifierPrompt: string | undefined;

    for (const [name, srcCfg] of Object.entries(blanksConfig.promptConfig.sources)) {
      if (name === 'classifier') {
        classifierPrompt = srcCfg.promptText;
        continue;
      }
      if (srcCfg.enabled === false || !srcCfg.promptText) continue;
      blankSources.push(new ConfigSource({
        sourceConfig: { ...srcCfg, scope: srcCfg.scope ?? 'blanks' },
        ...options,
      }));
    }

    if (blankSources.length > 0) {
      sources.push(new ClassifiedSourceGroup({
        id: 'blanks',
        classifierPrompt,
        sources: blankSources,
        httpAdapter: options.httpAdapter,
        endpoint: options.endpoint,
        apiKey: options.apiKey,
        model: blanksConfig.promptConfig.model ?? options.defaultModel,
      }));
    }
  }

  return sources;
}
