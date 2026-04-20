/**
 * opencues-core/sources/build-sources.ts
 *
 * Factory that creates CueSource[] from parsed .md configs.
 * Single entry point — replaces manual source construction in integrations.
 *
 * ## Two strategies for multi-source inputs
 *
 * **Words (combining)**: Domain prompts (grammar, legal, medical) are combined
 * into a single LLM call. Domains can overlap in the same input — "the contract
 * shall indemnify the diagnosis" needs grammar, legal, AND medical alternatives
 * for different words simultaneously. Combining produces one response covering
 * all words/domains in a single pass.
 *
 * **Blanks (classifying)**: Blank-fill modes (math, factual, grammar) are
 * mutually exclusive — an input is math OR factual OR grammar, never both.
 * ClassifiedSourceGroup picks one mode via fast heuristics or LLM classifier,
 * then routes to that single source.
 */

import { CueSource, HttpAdapter } from '../types';
import { CuesMdConfig, SourceConfig, ControlConfig } from '../cues-md';
import { ConfigSource } from './config-source';
import { ClassifiedSourceGroup } from './classified-source-group';
import { RoutedWordSourceGroup } from './routed-word-source-group';
import { ControlBlankSource } from './control-blank-source';

export interface BuildSourcesOptions {
  httpAdapter: HttpAdapter;
  endpoint: string;
  apiKey: string;
  defaultModel: string;
  /** Merged control configs (for control-bound blanks) */
  controls?: Record<string, ControlConfig>;
  /** I/O adapter: calls blankScript get to read current live control value (raw string).
   * May return synchronously or as a Promise — async implementations avoid blocking the event loop. */
  readControlState?: (controlName: string, matchedKeyword?: string, contextWords?: string[]) => string | null | Promise<string | null>;
}

/**
 * @deprecated Removed in favour of RoutedWordSourceGroup (per-word
 * routing instead of "combine all into one prompt"). The combine model
 * had two structural problems: (1) cross-contamination — a sloppy or
 * hijacking prompt poisoned all other sources; (2) it scaled poorly
 * past 5+ sources as the combined prompt grew and confused the LLM.
 *
 * Kept as a no-op export only so external callers don't fail to
 * import. New code should not use it.
 */
export function combineWordSources(srcs: SourceConfig[]): SourceConfig {
  // Trivial degenerate behaviour for any holdout caller — concat the
  // prompts, append the format spec, and return. Same shape the old
  // function emitted but no longer used by buildSourcesFromConfig.
  const parts = srcs.map(s => s.promptText ?? '');
  parts.push('\nOutput ONLY index:alternatives format (e.g. 1:alt1,alt2,alt3).');
  return {
    name: 'grammar',
    scope: 'words',
    parser: 'alternatives',
    priority: Math.max(...srcs.map(s => s.priority ?? 50)),
    promptText: parts.join('\n'),
  };
}

/**
 * Build CueSource[] from parsed cues.md and blanks.md configs.
 *
 * - cues.md word-scoped alternatives ### sections → one ConfigSource
 *   each, all wrapped in ONE RoutedWordSourceGroup. The group routes
 *   each highlighted word to one child source via match/keywords/
 *   priority/default and dispatches one LLM call per source group
 *   (parallel). See routed-word-source-group.ts for the full rules.
 * - cues.md other ### sections (non-default scope/parser) → individual
 *   ConfigSource instances (not routed; called directly by the resolver).
 * - blanks.md ### sections → ClassifiedSourceGroup (scope: blanks).
 *   - ### classifier → group's classifier prompt.
 *   - other ### sections → child ConfigSource instances.
 */
export function buildSourcesFromConfig(
  cuesConfig: CuesMdConfig | undefined,
  blanksConfig: CuesMdConfig | undefined,
  options: BuildSourcesOptions,
): CueSource[] {
  const sources: CueSource[] = [];

  // From cues.md: collect all word-scope alternatives sources into one
  // RoutedWordSourceGroup. Other sources (different scope/parser) stay
  // individual ConfigSource instances.
  if (cuesConfig?.promptConfig?.sources) {
    const wordAltSources: ConfigSource[] = [];

    for (const [, srcCfg] of Object.entries(cuesConfig.promptConfig.sources)) {
      if (srcCfg.enabled === false || !srcCfg.promptText) continue;
      const scope = srcCfg.scope ?? 'words';
      const parser = srcCfg.parser ?? 'alternatives';

      if (scope === 'words' && parser === 'alternatives') {
        wordAltSources.push(new ConfigSource({
          sourceConfig: { ...srcCfg, scope },
          ...options,
        }));
      } else {
        // Non-routable sources (different scope or parser) stay direct.
        sources.push(new ConfigSource({
          sourceConfig: { ...srcCfg, scope },
          ...options,
        }));
      }
    }

    if (wordAltSources.length > 0) {
      sources.push(new RoutedWordSourceGroup({ sources: wordAltSources }));
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

  // Control-bound blanks: controls with blankKeywords get a ControlBlankSource
  if (options.controls && options.readControlState) {
    const blankControls: Record<string, ControlConfig> = {};
    for (const [name, ctrl] of Object.entries(options.controls)) {
      if (ctrl.blankKeywords?.length) {
        blankControls[name] = ctrl;
      }
    }
    if (Object.keys(blankControls).length > 0) {
      sources.push(new ControlBlankSource({
        controls: blankControls,
        readState: options.readControlState,
      }));
    }
  }

  return sources;
}
