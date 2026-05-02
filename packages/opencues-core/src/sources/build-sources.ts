/**
 * opencues-core/sources/build-sources.ts
 *
 * Factory that creates CueSource[] from parsed .md configs.
 * Single entry point — replaces manual source construction in integrations.
 *
 * ## How sources are assembled
 *
 * **Word cues (per-word routing)**: Domain prompts (legal, medical, …) live
 * as `### alternatives` sections in `cues.md` (or folder-based
 * `cues/<name>/cue.md`). They get wrapped in ONE RoutedWordSourceGroup that
 * dispatches each highlighted word to one source via match/keywords.
 *
 * **Blanks (`_`-gated)**: Two paths:
 *   - Keyword-bound blanks (`blankKeywords:` in a folder cue.md) flow through
 *     BlankSource — fast, deterministic, no LLM needed.
 *   - Free-form lookups go through FluidBlankSource (P1 SEGMENT + P3 ANSWER
 *     LLM pipeline). It cedes when a keyword-bound blank would claim the slot.
 */

import { CueSource, HttpAdapter } from '../types';
import { CuesMdConfig, SourceConfig, BlankConfig } from '../cues-md';
import { ConfigSource } from './config-source';
import { RoutedWordSourceGroup } from './routed-word-source-group';
import { BlankSource } from './blank-source';
import { FluidBlankSource } from './fluid-blank-source';
import { SpellingSource } from './spelling-source';

export interface BuildSourcesOptions {
  httpAdapter: HttpAdapter;
  endpoint: string;
  apiKey: string;
  defaultModel: string;
  /** Merged blank configs */
  blanks?: Record<string, BlankConfig>;
  /** I/O adapter: calls blankScript get to read current live blank value (raw string).
   * May return synchronously or as a Promise — async implementations avoid blocking the event loop. */
  readBlankState?: (blankName: string, matchedKeyword?: string, contextWords?: string[]) => string | null | Promise<string | null>;
  /**
   * Enable the fluid-blank source — a 2-pass (P1 SEGMENT + P3 ANSWER) handler
   * that catches free-form lookup queries embedded in casual prose.
   * See fluid-blank-source.ts and tests/benchmarks/fluid-blank/BUILD-LOG.md.
   * Defaults to false; flip on per-integration.
   */
  enableFluidBlank?: boolean;
  /** Enable SpellingSource — word-scope spell-checker. Flags misspelled
   * words in plain text and offers corrections as cycling alternatives.
   * Priority 80 (above typical domain max ~75). Defaults to false; flip
   * on via opencues.md `spelling-mode: on`. */
  enableSpelling?: boolean;
  /** Enable RoutedWordSourceGroup (word-cues on plain text). When false,
   * NO word-cue LLM calls fire — words are not navigable as alternatives.
   * Domain blanks/fluid-blank still work. Defaults to false;
   * flip on via opencues.md `word-cues-mode: on`. */
  enableWordCues?: boolean;
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
 *   priority and dispatches one LLM call per source group (parallel).
 *   See routed-word-source-group.ts for the full rules.
 * - cues.md other ### sections (non-default scope/parser) → individual
 *   ConfigSource instances (not routed; called directly by the resolver).
 * - blanks: keyword-bound entries → BlankSource. Free-form `_` →
 *   FluidBlankSource (opt-in via `fluid-blank-mode: on`).
 */
export function buildSourcesFromConfig(
  cuesConfig: CuesMdConfig | undefined,
  _blanksConfig: CuesMdConfig | undefined,
  options: BuildSourcesOptions,
): CueSource[] {
  const sources: CueSource[] = [];

  // From cues.md: collect all word-scope alternatives sources into one
  // RoutedWordSourceGroup. Other sources (different scope/parser) stay
  // individual ConfigSource instances.
  // Gate the entire word-cue block on enableWordCues. Non-word-cue
  // sources (different scope/parser) still pass through — they're not
  // the per-word surface, so they obey their own enable flag in cue.md
  // frontmatter as before.
  if (cuesConfig?.promptConfig?.sources) {
    const wordCueSources: ConfigSource[] = [];

    for (const [, srcCfg] of Object.entries(cuesConfig.promptConfig.sources)) {
      if (srcCfg.enabled === false || !srcCfg.promptText) continue;
      const scope = srcCfg.scope ?? 'words';
      const parser = srcCfg.parser ?? 'alternatives';

      if (scope === 'words' && parser === 'alternatives') {
        if (!options.enableWordCues) continue;
        // Every word-cue source must declare what it cares about via
        // match: or keywords:. Catch-all "default" sources were removed —
        // an explicit `match: .*` is required if the user really wants
        // a fall-through cue.
        if (!srcCfg.match && !srcCfg.keywords) continue;
        wordCueSources.push(new ConfigSource({
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

    if (wordCueSources.length > 0) {
      sources.push(new RoutedWordSourceGroup({ sources: wordCueSources }));
    }
  }

  // Keyword-bound blanks: blanks with blankKeywords get a BlankSource
  if (options.blanks && options.readBlankState) {
    const keywordBlanks: Record<string, BlankConfig> = {};
    for (const [name, blk] of Object.entries(options.blanks)) {
      if (blk.blankKeywords?.length) {
        keywordBlanks[name] = blk;
      }
    }
    if (Object.keys(keywordBlanks).length > 0) {
      sources.push(new BlankSource({
        blanks: keywordBlanks,
        readState: options.readBlankState,
      }));
    }
  }

  // Spelling: word-scope spell-checker. Flags misspelled words in plain
  // text and offers corrections as cycling alternatives. Priority 80 —
  // above domain word-cues (~75) so corrections beat synonyms on the
  // same wordIndex.
  if (options.enableSpelling) {
    sources.push(new SpellingSource({
      httpAdapter: options.httpAdapter,
      endpoint: options.endpoint,
      apiKey: options.apiKey,
      model: options.defaultModel,
    }));
  }

  // Fluid-blank: free-form `_` lookup handler (P1 SEGMENT + P3 ANSWER).
  // Cedes to keyword-bound BlankSource when a registered blank would
  // claim the slot (keyword within blankProximity of the `_`).
  if (options.enableFluidBlank) {
    sources.push(new FluidBlankSource({
      httpAdapter: options.httpAdapter,
      endpoint: options.endpoint,
      apiKey: options.apiKey,
      model: options.defaultModel,
      blanks: options.blanks ?? {},
    }));
  }

  return sources;
}
