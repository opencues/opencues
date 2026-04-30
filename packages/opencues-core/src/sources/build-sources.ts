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
import { CuesMdConfig, SourceConfig, BlankConfig } from '../cues-md';
import { ConfigSource } from './config-source';
import { ClassifiedSourceGroup } from './classified-source-group';
import { RoutedWordSourceGroup } from './routed-word-source-group';
import { BlankSource } from './blank-source';
import { FluidBlankSource } from './fluid-blank-source';
import { SpellingSource } from './spelling-source';

export interface BuildSourcesOptions {
  httpAdapter: HttpAdapter;
  endpoint: string;
  apiKey: string;
  defaultModel: string;
  /** Merged control configs (for control-bound blanks) */
  controls?: Record<string, BlankConfig>;
  /** I/O adapter: calls blankScript get to read current live control value (raw string).
   * May return synchronously or as a Promise — async implementations avoid blocking the event loop. */
  readControlState?: (controlName: string, matchedKeyword?: string, contextWords?: string[]) => string | null | Promise<string | null>;
  /**
   * Enable the fluid-blank source — a 2-pass (P1 SEGMENT + P3 ANSWER) handler
   * that catches free-form lookup queries embedded in casual prose.
   * See fluid-blank-source.ts and tests/benchmarks/fluid-blank/BUILD-LOG.md.
   * Defaults to false; flip on per-integration.
   */
  enableFluidBlank?: boolean;
  /** Enable ClassifiedSourceGroup (the classifier-routed blank modes from
   * blanks.md: math/factual/translation/unit/color/http/timezone/roman/
   * grammar). Defaults to false — fluid-blank + spelling + control-bound
   * blanks cover most ground without the extra classifier LLM call.
   * Flip on via opencues.md `classified-blanks-mode: on`. */
  enableClassifiedBlanks?: boolean;
  /** Enable SpellingSource — word-scope spell-checker. Flags misspelled
   * words in plain text and offers corrections as cycling alternatives.
   * Priority 80 (above typical domain max ~75). Defaults to false; flip
   * on via opencues.md `spelling-mode: on`. */
  enableSpelling?: boolean;
  /** Enable RoutedWordSourceGroup (word-alts on plain text). When false,
   * NO word-alt LLM calls fire — words are not navigable as alternatives.
   * Domain blanks/controls/fluid-blank still work. Defaults to false;
   * flip on via opencues.md `word-alts-mode: on`. */
  enableWordAlts?: boolean;
  /** Within RoutedWordSourceGroup, include sources with NO `match:`/
   * `keywords:` (the catch-everything default like grammar). When false,
   * only domain sources fire — words not matching any domain stay
   * uncoloured. Defaults to false; flip on via opencues.md
   * `default-word-alts: on`. */
  enableDefaultWordAlts?: boolean;
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
  // Gate the entire word-alts block on enableWordAlts. Non-word-alt
  // sources (different scope/parser) still pass through — they're not
  // the "everything coloured" surface, so they obey their own enable
  // flag in cue.md frontmatter as before.
  if (cuesConfig?.promptConfig?.sources) {
    const wordAltSources: ConfigSource[] = [];

    for (const [, srcCfg] of Object.entries(cuesConfig.promptConfig.sources)) {
      if (srcCfg.enabled === false || !srcCfg.promptText) continue;
      const scope = srcCfg.scope ?? 'words';
      const parser = srcCfg.parser ?? 'alternatives';

      if (scope === 'words' && parser === 'alternatives') {
        if (!options.enableWordAlts) continue;
        // Default sources (NO match: AND NO keywords:) are the catch-
        // everything surface. Skip them when enableDefaultWordAlts=false.
        const isDefault = !srcCfg.match && !srcCfg.keywords;
        if (isDefault && !options.enableDefaultWordAlts) continue;
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

  // From blanks.md: build ClassifiedSourceGroup (opt-in).
  if (options.enableClassifiedBlanks && blanksConfig?.promptConfig?.sources) {
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

  // Control-bound blanks: controls with blankKeywords get a BlankSource
  if (options.controls && options.readControlState) {
    const blankControls: Record<string, BlankConfig> = {};
    for (const [name, ctrl] of Object.entries(options.controls)) {
      if (ctrl.blankKeywords?.length) {
        blankControls[name] = ctrl;
      }
    }
    if (Object.keys(blankControls).length > 0) {
      sources.push(new BlankSource({
        controls: blankControls,
        readState: options.readControlState,
      }));
    }
  }

  // Spelling: word-scope spell-checker. Flags misspelled words in plain
  // text and offers corrections as cycling alternatives. Priority 80 —
  // above domain word-alts (~75) so corrections beat synonyms on the
  // same wordIndex.
  if (options.enableSpelling) {
    sources.push(new SpellingSource({
      httpAdapter: options.httpAdapter,
      endpoint: options.endpoint,
      apiKey: options.apiKey,
      model: options.defaultModel,
    }));
  }

  // Fluid-blank: free-form lookup handler (P1 SEGMENT + P3 ANSWER).
  // Priority 50 — sits between the classifier-based modes (whose results
  // win on regex match) and grammar fallback. Catches inputs that don't
  // match any structured mode AND inputs the structured modes can't fully
  // handle (conversational shapes, ?-marker, ellipsis, etc.).
  if (options.enableFluidBlank) {
    // Collect blankKeywords from all declared controls so fluid-blank can
    // cede the slot to BlankFill when the input matches a control trigger.
    const allKeywords: string[] = [];
    if (options.controls) {
      for (const ctrl of Object.values(options.controls)) {
        if (ctrl.blankKeywords?.length) allKeywords.push(...ctrl.blankKeywords);
      }
    }
    sources.push(new FluidBlankSource({
      httpAdapter: options.httpAdapter,
      endpoint: options.endpoint,
      apiKey: options.apiKey,
      model: options.defaultModel,
      blankKeywords: allKeywords,
    }));
  }

  return sources;
}
