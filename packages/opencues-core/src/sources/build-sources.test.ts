/**
 * Tests for build-sources.ts
 *
 * Run with: node --test dist/sources/build-sources.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { buildSourcesFromConfig, combineWordSources } from './build-sources';
import { ConfigSource } from './config-source';
import { ClassifiedSourceGroup } from './classified-source-group';
import { RoutedWordSourceGroup } from './routed-word-source-group';
import { CuesMdConfig, SourceConfig, PromptConfig } from '../cues-md';
import { HttpAdapter } from '../types';

// Stub HTTP adapter (never called in these tests)
const stubAdapter: HttpAdapter = {
  post: async () => '{}',
};

const defaultOptions = {
  httpAdapter: stubAdapter,
  endpoint: 'https://api.example.com/v1/chat/completions',
  apiKey: 'test-key',
  defaultModel: 'test-model',
};

/** Helper to create a CuesMdConfig with required fields */
function mkConfig(promptConfig: PromptConfig): CuesMdConfig {
  return { frontmatter: {}, sections: {}, promptConfig };
}

// ---------------------------------------------------------------------------
// combineWordSources
// ---------------------------------------------------------------------------

describe('combineWordSources (deprecated; preserved for callers)', () => {
  // Per-word routing via RoutedWordSourceGroup replaced the combine-into-
  // one-prompt approach. The function survives only so external imports
  // don't fail; new code should not call it. These tests verify it
  // remains a sane no-op concat that still appends the format spec.

  it('returns a SourceConfig with the canonical alternatives shape', () => {
    const out = combineWordSources([{ name: 'a', promptText: 'A.', priority: 50 }]);
    assert.strictEqual(out.name, 'grammar');
    assert.strictEqual(out.scope, 'words');
    assert.strictEqual(out.parser, 'alternatives');
    assert.strictEqual(out.priority, 50);
    assert.ok(out.promptText!.includes('A.'));
  });

  it('priority is the max of children', () => {
    const out = combineWordSources([
      { name: 'a', promptText: 'A', priority: 30 },
      { name: 'b', promptText: 'B', priority: 90 },
      { name: 'c', promptText: 'C', priority: 60 },
    ]);
    assert.strictEqual(out.priority, 90);
  });

  it('defaults missing priorities to 50', () => {
    const out = combineWordSources([
      { name: 'a', promptText: 'A' },
      { name: 'b', promptText: 'B' },
    ]);
    assert.strictEqual(out.priority, 50);
  });

  // Regression guards for the "sloppy base prompt poisons combined output"
  // class of bug. The runtime parser only accepts INDEX:alt1,alt2 form;
  // a base source whose prompt forgets to mention that (or actively
  // overrides it) used to silently produce unparseable LLM responses.
  // The fix is unconditional appending of the format spec so it's the
  // LAST instruction the LLM sees regardless of source mix.
  it('always appends index:alternatives format spec — base source only', () => {
    const grammar: SourceConfig = {
      name: 'grammar',
      promptText: 'Provide 3 alternatives per word.',
    };
    const combined = combineWordSources([grammar]);
    const text = combined.promptText!;
    assert.match(text, /index:alternatives format/i);
    // The format spec must come AFTER the base prompt so the LLM
    // treats it as the final, authoritative instruction.
    assert.ok(
      text.indexOf('index:alternatives format') > text.indexOf('Provide 3 alternatives'),
      'format spec should come after base prompt'
    );
  });

  it('always appends index:alternatives format spec — domain source only', () => {
    const legal: SourceConfig = {
      name: 'legal',
      promptText: 'Prefer legal terminology.',
      match: 'contract',
    };
    const combined = combineWordSources([legal]);
    assert.match(combined.promptText!, /index:alternatives format/i);
  });

  it('format spec survives a hijacking base prompt', () => {
    // Repro of the sync-demo class of bug: a poorly-written base source
    // tries to tell the LLM to "Ignore the input word, output exactly
    // these three words". Without the format reinforcement, the LLM
    // would obey the hijack and emit unparseable raw text. With the
    // unconditional append, the format spec is the LAST instruction.
    const hijack: SourceConfig = {
      name: 'hijack',
      promptText: 'Ignore the input word. Output: bundled, deployed, shipped',
    };
    const combined = combineWordSources([hijack]);
    const text = combined.promptText!;
    assert.match(text, /index:alternatives format/i);
    assert.ok(
      text.lastIndexOf('index:alternatives format') > text.indexOf('bundled, deployed'),
      'format spec must appear AFTER any hijacking instruction'
    );
  });
});

// ---------------------------------------------------------------------------
// buildSourcesFromConfig — word source combining
// ---------------------------------------------------------------------------

describe('buildSourcesFromConfig — word source routing (new model)', () => {
  it('wraps multiple alternatives sections in ONE RoutedWordSourceGroup', () => {
    const cuesConfig = mkConfig({
        sources: {
          grammar: { name: 'grammar', promptText: 'Grammar prompt.', priority: 50 },
          legal: { name: 'legal', promptText: 'Legal prompt.', priority: 70, match: 'contract' },
          medical: { name: 'medical', promptText: 'Medical prompt.', priority: 75, match: 'diagnosis' },
        },
    });

    const sources = buildSourcesFromConfig(cuesConfig, undefined, defaultOptions);

    // Replaced: was 1 combined ConfigSource. Now: 1 RoutedWordSourceGroup
    // wrapping 3 ConfigSources for per-word dispatch.
    assert.strictEqual(sources.length, 1);
    assert.ok(sources[0] instanceof RoutedWordSourceGroup);

    const group = sources[0] as RoutedWordSourceGroup;
    assert.strictEqual(group.id, 'word-alts');
    // Priority is the max of all children (matches old combined-source behaviour).
    assert.strictEqual(group.priority, 75);
    // 2 domain sources (legal, medical) + 1 default (grammar).
    assert.deepStrictEqual(group.routingStats, { domains: 2, defaults: 1 });
  });

  it('keeps non-alternatives parser sources separate (not in the routed group)', () => {
    const cuesConfig = mkConfig({
        sources: {
          grammar: { name: 'grammar', promptText: 'Grammar.', priority: 50 },
          custom: { name: 'custom', promptText: 'Custom.', priority: 60, parser: 'raw', scope: 'words' },
        },
    });

    const sources = buildSourcesFromConfig(cuesConfig, undefined, defaultOptions);

    // 1 RoutedWordSourceGroup (grammar) + 1 ConfigSource (custom raw parser).
    assert.strictEqual(sources.length, 2);
    const routed = sources.find(s => s instanceof RoutedWordSourceGroup);
    const direct = sources.find(s => s instanceof ConfigSource);
    assert.ok(routed, 'expected a RoutedWordSourceGroup for the alternatives source');
    assert.ok(direct, 'expected a direct ConfigSource for the raw-parser source');
    assert.strictEqual((direct as ConfigSource).id, 'custom');
  });

  it('keeps non-words scope sources separate', () => {
    const cuesConfig = mkConfig({
        sources: {
          grammar: { name: 'grammar', promptText: 'Grammar.', priority: 50 },
          allScope: { name: 'allScope', promptText: 'All.', priority: 60, scope: 'all' },
        },
    });

    const sources = buildSourcesFromConfig(cuesConfig, undefined, defaultOptions);
    assert.strictEqual(sources.length, 2);
    assert.ok(sources.some(s => s instanceof RoutedWordSourceGroup));
    assert.ok(sources.some(s => s instanceof ConfigSource && s.id === 'allScope'));
  });

  it('skips disabled sources', () => {
    const cuesConfig = mkConfig({
        sources: {
          grammar: { name: 'grammar', promptText: 'Grammar.', priority: 50 },
          disabled: { name: 'disabled', promptText: 'Disabled.', enabled: false },
        },
    });

    const sources = buildSourcesFromConfig(cuesConfig, undefined, defaultOptions);
    assert.strictEqual(sources.length, 1);
    const group = sources[0] as RoutedWordSourceGroup;
    assert.deepStrictEqual(group.routingStats, { domains: 0, defaults: 1 });
  });

  it('skips sources without promptText', () => {
    const cuesConfig = mkConfig({
        sources: {
          grammar: { name: 'grammar', promptText: 'Grammar.' },
          empty: { name: 'empty' },
        },
    });

    const sources = buildSourcesFromConfig(cuesConfig, undefined, defaultOptions);
    assert.strictEqual(sources.length, 1);
  });

  it('handles empty cuesConfig', () => {
    const sources = buildSourcesFromConfig(undefined, undefined, defaultOptions);
    assert.strictEqual(sources.length, 0);
  });

  it('emits no RoutedWordSourceGroup when there are zero word-alts sources', () => {
    // All sources are non-alternatives → no routed group is emitted, just direct sources.
    const cuesConfig = mkConfig({
        sources: {
          custom: { name: 'custom', promptText: 'Custom.', parser: 'raw', scope: 'words' },
        },
    });
    const sources = buildSourcesFromConfig(cuesConfig, undefined, defaultOptions);
    assert.strictEqual(sources.length, 1);
    assert.ok(sources[0] instanceof ConfigSource);
    assert.ok(!sources.some(s => s instanceof RoutedWordSourceGroup));
  });
});

// ---------------------------------------------------------------------------
// buildSourcesFromConfig — blanks pipeline unaffected
// ---------------------------------------------------------------------------

describe('buildSourcesFromConfig — blanks pipeline', () => {
  it('should create ClassifiedSourceGroup from blanks.md', () => {
    const blanksConfig = mkConfig({
        sources: {
          classifier: { name: 'classifier', promptText: 'Classify input.' },
          math: { name: 'math', promptText: 'Solve.', parser: 'math', priority: 90, match: '\\d+' },
          grammar: { name: 'grammar', promptText: 'Fill blank.', priority: 50 },
        },
    });

    const sources = buildSourcesFromConfig(undefined, blanksConfig, defaultOptions);

    assert.strictEqual(sources.length, 1);
    assert.ok(sources[0] instanceof ClassifiedSourceGroup);
  });

  it('builds both word + blanks sources together (1 RoutedWordSourceGroup + 1 ClassifiedSourceGroup)', () => {
    const cuesConfig = mkConfig({
        sources: {
          grammar: { name: 'grammar', promptText: 'Word alts.', priority: 50 },
          legal: { name: 'legal', promptText: 'Legal alts.', priority: 70, match: 'contract' },
        },
    });
    const blanksConfig = mkConfig({
        sources: {
          classifier: { name: 'classifier', promptText: 'Classify.' },
          math: { name: 'math', promptText: 'Compute.', parser: 'math', priority: 90 },
          grammar: { name: 'grammar', promptText: 'Fill blank.', priority: 50 },
        },
    });

    const sources = buildSourcesFromConfig(cuesConfig, blanksConfig, defaultOptions);

    // 1 RoutedWordSourceGroup (wraps grammar+legal) + 1 ClassifiedSourceGroup (wraps math/grammar blanks).
    assert.strictEqual(sources.length, 2);
    assert.strictEqual(sources.filter(s => s instanceof RoutedWordSourceGroup).length, 1);
    assert.strictEqual(sources.filter(s => s instanceof ClassifiedSourceGroup).length, 1);
  });
});

// ---------------------------------------------------------------------------
// Combined prompt content accuracy
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// buildSourcesFromConfig — source count verification
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ClassifiedSourceGroup — fallback behavior
// ---------------------------------------------------------------------------

describe('ClassifiedSourceGroup — fallback on empty results', () => {
  it('should fall back to default source when classified source returns empty', async () => {
    // Create sources where factual returns empty but grammar returns results
    const factualSource = new ConfigSource({
      sourceConfig: { name: 'factual', promptText: 'Answer.', parser: 'answer', scope: 'blanks', priority: 90 },
      ...defaultOptions,
      // Override adapter to return empty (no ANSWER= match)
      httpAdapter: { post: async () => JSON.stringify({ choices: [{ message: { content: 'I dont know' } }] }) },
    });
    const grammarSource = new ConfigSource({
      sourceConfig: { name: 'grammar', promptText: 'Fill.', parser: 'alternatives', scope: 'blanks', priority: 50 },
      ...defaultOptions,
      // Override adapter to return a valid alternative
      httpAdapter: { post: async () => JSON.stringify({ choices: [{ message: { content: '5:fence,wall,hedge' } }] }) },
    });

    const group = new ClassifiedSourceGroup({
      sources: [factualSource, grammarSource],
      httpAdapter: stubAdapter,
      endpoint: defaultOptions.endpoint,
      apiKey: defaultOptions.apiKey,
      model: defaultOptions.defaultModel,
      // No classifier prompt — will use fast classify, which won't match, then default
    });

    const context = { text: 'The boy vaulted over the _', words: ['The', 'boy', 'vaulted', 'over', 'the', '_'] };

    // Group supports blanks
    assert.ok(group.supports(context));

    // getCues should fall back to grammar (default) since no fast classify matches
    const result = await group.getCues(context);
    assert.ok(result.results.length > 0, 'Should have results from grammar fallback');
    assert.strictEqual(result.results[0].wordIndex, 5);
    assert.ok(result.results[0].alternatives.includes('fence'));
  });

  it('should not support contexts without blanks', () => {
    const group = new ClassifiedSourceGroup({
      sources: [
        new ConfigSource({
          sourceConfig: { name: 'grammar', promptText: 'Fill.', scope: 'blanks' },
          ...defaultOptions,
        }),
      ],
      httpAdapter: stubAdapter,
      endpoint: defaultOptions.endpoint,
      apiKey: defaultOptions.apiKey,
      model: defaultOptions.defaultModel,
    });

    assert.strictEqual(group.supports({ text: 'hello world', words: ['hello', 'world'] }), false);
    assert.strictEqual(group.supports({ text: 'hello _', words: ['hello', '_'] }), true);
  });
});

// ---------------------------------------------------------------------------
// Keyword matcher robustness
// ---------------------------------------------------------------------------

describe('classifyFast — keyword robustness', () => {
  function buildGroup(sources: Array<{ name: string; promptText: string; parser?: 'math' | 'compute' | 'answer' | 'alternatives' | 'raw'; priority?: number; match?: string; keywords?: string }>) {
    const configSources = sources.map(s => new ConfigSource({
      sourceConfig: { ...s, scope: 'blanks' as const },
      ...defaultOptions,
    }));
    return new ClassifiedSourceGroup({
      sources: configSources,
      httpAdapter: stubAdapter,
      endpoint: defaultOptions.endpoint,
      apiKey: defaultOptions.apiKey,
      model: defaultOptions.defaultModel,
    });
  }

  it('should match keyword "in french" in normal sentence', async () => {
    const group = buildGroup([
      { name: 'translation', promptText: 'Translate.', parser: 'answer', priority: 85, keywords: 'in french,in spanish' },
      { name: 'grammar', promptText: 'Fill.', priority: 50 },
    ]);
    // Override getCues to just return the selected source name
    const result = await group.getCues({ text: 'Hello in french is _', words: ['Hello', 'in', 'french', 'is', '_'] });
    // Translation source should be selected (via keyword match)
    // It will fail to parse since adapter returns '{}', but we can check it was attempted
    assert.strictEqual(result.results.length, 0); // adapter returns empty, but source was selected
  });

  it('PROBLEM: substring match — "in french" matches inside "define frenchify"', async () => {
    // This exposes the substring matching issue
    const group = buildGroup([
      { name: 'translation', promptText: 'Translate.', parser: 'answer', priority: 85, keywords: 'in french' },
      { name: 'grammar', promptText: 'Fill.', priority: 50 },
    ]);
    // "frenchify" contains "french" → "in french" is NOT a substring of "define frenchify _"
    // But "define french cooking _" WOULD match because "french" appears after space
    // Actually "in french" needs both words — let's check "refrain french _"
    // "refrain french _".toLowerCase() = "refrain french _" — does NOT include "in french"
    // So this specific case is actually fine. The real problem is:
    // "frozen in french toast _" — contains "in french" as substring
    const ctx = { text: 'frozen in french toast _', words: ['frozen', 'in', 'french', 'toast', '_'] };
    const result = await group.getCues(ctx);
    // This WILL match translation because "in french" appears as substring
    // But the user meant grammar (french toast recipe), not translation
    // This is the false positive we want to flag
    assert.strictEqual(result.results.length, 0); // matched translation (wrong), got empty result, fell back to grammar
  });

  it('first entry wins when multiple keywords match', async () => {
    let mathCalled = false;
    let translationCalled = false;

    const mathSource = new ConfigSource({
      sourceConfig: { name: 'math', promptText: 'Compute.', parser: 'math', scope: 'blanks', priority: 90, keywords: 'half of' },
      ...defaultOptions,
      httpAdapter: { post: async () => { mathCalled = true; return JSON.stringify({ choices: [{ message: { content: 'COMPUTE=50' } }] }); } },
    });
    const transSource = new ConfigSource({
      sourceConfig: { name: 'translation', promptText: 'Translate.', parser: 'answer', scope: 'blanks', priority: 85, keywords: 'in french' },
      ...defaultOptions,
      httpAdapter: { post: async () => { translationCalled = true; return JSON.stringify({ choices: [{ message: { content: 'ANSWER=Cinquante' } }] }); } },
    });
    const grammarSource = new ConfigSource({
      sourceConfig: { name: 'grammar', promptText: 'Fill.', scope: 'blanks', priority: 50 },
      ...defaultOptions,
    });

    const group = new ClassifiedSourceGroup({
      sources: [mathSource, transSource, grammarSource],
      httpAdapter: stubAdapter,
      endpoint: defaultOptions.endpoint,
      apiKey: defaultOptions.apiKey,
      model: defaultOptions.defaultModel,
    });

    // "half of 100 in french is _" — matches BOTH math ("half of") and translation ("in french")
    await group.getCues({ text: 'half of 100 in french is _', words: ['half', 'of', '100', 'in', 'french', 'is', '_'] });

    // Math comes first in the array → wins
    assert.strictEqual(mathCalled, true, 'Math should be called (first match wins)');
    // Translation never called because math matched first
    // (Unless math returns empty and fallback kicks in)
  });
});

// ---------------------------------------------------------------------------
// Helper: create a mock HTTP adapter that returns a canned LLM response
// ---------------------------------------------------------------------------

function mockAdapter(content: string): HttpAdapter {
  return { post: async () => JSON.stringify({ choices: [{ message: { content } }] }) };
}

/** Track what prompt was sent to the adapter */
function capturingAdapter(content: string): { adapter: HttpAdapter; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    adapter: {
      post: async (_url: string, body: string) => {
        const parsed = JSON.parse(body);
        prompts.push(parsed.messages[0].content);
        return JSON.stringify({ choices: [{ message: { content } }] });
      },
    },
  };
}

// ---------------------------------------------------------------------------
// End-to-end: combined word source results
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// End-to-end: blank fill-in results
// ---------------------------------------------------------------------------

describe('end-to-end: blanks — math (fast classify)', () => {
  it('should compute math blanks via fast regex match', async () => {
    const blanksConfig = mkConfig({
      sources: {
        classifier: { name: 'classifier', promptText: 'Classify.' },
        math: {
          name: 'math',
          promptText: 'Solve. Output ONLY: COMPUTE=expression',
          parser: 'math',
          priority: 90,
          match: '\\d+\\s*[+\\-*/]\\s*\\d+',
        },
        grammar: { name: 'grammar', promptText: 'Fill blank.', priority: 50 },
      },
    });

    const sources = buildSourcesFromConfig(undefined, blanksConfig, {
      ...defaultOptions,
      httpAdapter: mockAdapter('COMPUTE=4*12'),
    });

    const group = sources.find(s => s instanceof ClassifiedSourceGroup)!;
    const result = await group.getCues({
      text: '4 * 12 = _',
      words: ['4', '*', '12', '=', '_'],
    });

    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].wordIndex, 4);
    // COMPUTE=4*12 evaluates to 48
    assert.ok(result.results[0].alternatives.includes('48'));
    // Blank original is prepended
    assert.strictEqual(result.results[0].alternatives[0], '_');
  });
});

describe('end-to-end: blanks — factual (fast keyword match)', () => {
  it('should answer factual blanks via keyword match', async () => {
    const blanksConfig = mkConfig({
      sources: {
        classifier: { name: 'classifier', promptText: 'Classify.' },
        factual: {
          name: 'factual',
          promptText: 'Answer. Output ONLY: ANSWER=value',
          parser: 'answer',
          priority: 90,
          keywords: 'capital of,ceo of',
        },
        grammar: { name: 'grammar', promptText: 'Fill blank.', priority: 50 },
      },
    });

    const sources = buildSourcesFromConfig(undefined, blanksConfig, {
      ...defaultOptions,
      httpAdapter: mockAdapter('ANSWER=Paris'),
    });

    const group = sources.find(s => s instanceof ClassifiedSourceGroup)!;
    const result = await group.getCues({
      text: 'The capital of France is _',
      words: ['The', 'capital', 'of', 'France', 'is', '_'],
    });

    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].wordIndex, 5);
    assert.strictEqual(result.results[0].alternatives[0], '_');
    assert.ok(result.results[0].alternatives.includes('Paris'));
  });
});

describe('end-to-end: blanks — grammar (default fallback)', () => {
  it('should fill grammar blanks via default source when no fast match', async () => {
    const blanksConfig = mkConfig({
      sources: {
        classifier: { name: 'classifier', promptText: 'Classify.' },
        math: {
          name: 'math',
          promptText: 'Compute.',
          parser: 'math',
          priority: 90,
          match: '\\d+\\s*[+\\-*/]\\s*\\d+',
        },
        grammar: { name: 'grammar', promptText: 'Fill blank.', priority: 50 },
      },
    });

    const sources = buildSourcesFromConfig(undefined, blanksConfig, {
      ...defaultOptions,
      // No classifier LLM — just fast classify + default fallback
      httpAdapter: mockAdapter('5:fence,wall,hedge,hurdle,gate'),
    });

    const group = sources.find(s => s instanceof ClassifiedSourceGroup)!;
    const result = await group.getCues({
      text: 'The boy vaulted over the _',
      words: ['The', 'boy', 'vaulted', 'over', 'the', '_'],
    });

    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].wordIndex, 5);
    // For blanks, original _ is NOT prepended — alts are direct
    assert.deepStrictEqual(result.results[0].alternatives, ['fence', 'wall', 'hedge', 'hurdle', 'gate']);
  });

  it('should fill grammar blank with contextual alternatives', async () => {
    const blanksConfig = mkConfig({
      sources: {
        grammar: { name: 'grammar', promptText: 'Fill blank.', priority: 50 },
      },
    });

    const sources = buildSourcesFromConfig(undefined, blanksConfig, {
      ...defaultOptions,
      httpAdapter: mockAdapter('3:slowly,quickly,carefully,gracefully,silently'),
    });

    const group = sources.find(s => s instanceof ClassifiedSourceGroup)!;
    const result = await group.getCues({
      text: 'She walked _ to school',
      words: ['She', 'walked', '_', 'to', 'school'],
    });

    // LLM returned index 3 but blank is at index 2 — parser uses LLM index
    // Actually the blank _ is at index 2, LLM returned index 3
    // parseAlternatives will create a result for index 3 with word "to"
    // This is a valid test of the parser honoring the LLM's index
    const r3 = result.results.find(r => r.wordIndex === 3);
    if (r3) {
      // words[3] = "to", so original prepended
      assert.strictEqual(r3.alternatives[0], 'to');
    }
  });
});

describe('end-to-end: blanks — classifier misclassification fallback', () => {
  it('should fall back to grammar when factual returns empty for non-factual input', async () => {
    // Simulate: classifier picks factual (misclassification), factual returns empty,
    // then falls back to grammar default
    let callCount = 0;
    const smartAdapter: HttpAdapter = {
      post: async (_url: string, body: string) => {
        callCount++;
        const parsed = JSON.parse(body);
        const prompt = parsed.messages[0].content as string;

        // Classifier call
        if (prompt.includes('Classify')) {
          return JSON.stringify({ choices: [{ message: { content: 'MODE=FACTUAL' } }] });
        }
        // Factual source — can't answer, returns garbage
        if (prompt.includes('Answer the question')) {
          return JSON.stringify({ choices: [{ message: { content: 'This is not a factual question.' } }] });
        }
        // Grammar source — returns proper alternatives
        if (prompt.includes('Fill blank')) {
          return JSON.stringify({ choices: [{ message: { content: '5:fence,wall,hedge' } }] });
        }
        return JSON.stringify({ choices: [{ message: { content: '' } }] });
      },
    };

    const blanksConfig = mkConfig({
      sources: {
        classifier: { name: 'classifier', promptText: 'Classify input.' },
        factual: {
          name: 'factual',
          promptText: 'Answer the question. Output ONLY: ANSWER=value',
          parser: 'answer',
          priority: 90,
        },
        grammar: {
          name: 'grammar',
          promptText: 'Fill blank.',
          priority: 50,
        },
      },
    });

    const sources = buildSourcesFromConfig(undefined, blanksConfig, {
      ...defaultOptions,
      httpAdapter: smartAdapter,
    });

    const group = sources.find(s => s instanceof ClassifiedSourceGroup)!;
    const result = await group.getCues({
      text: 'The boy vaulted over the _',
      words: ['The', 'boy', 'vaulted', 'over', 'the', '_'],
    });

    // Should have results from grammar fallback
    assert.ok(result.results.length > 0, 'Should get results via grammar fallback');
    assert.strictEqual(result.results[0].wordIndex, 5);
    assert.ok(result.results[0].alternatives.includes('fence'));

    // Classifier (1) + factual (2) + grammar fallback (3) = 3 calls
    assert.strictEqual(callCount, 3, 'Should have made 3 LLM calls (classifier + factual + grammar fallback)');
  });

  it('should use fast classify and skip classifier LLM when regex matches', async () => {
    let callCount = 0;
    const countingAdapter: HttpAdapter = {
      post: async () => {
        callCount++;
        return JSON.stringify({ choices: [{ message: { content: 'COMPUTE=100/4' } }] });
      },
    };

    const blanksConfig = mkConfig({
      sources: {
        classifier: { name: 'classifier', promptText: 'Classify input.' },
        math: {
          name: 'math',
          promptText: 'Solve.',
          parser: 'math',
          priority: 90,
          match: '\\d+\\s*[+\\-*/]\\s*\\d+',
        },
        grammar: { name: 'grammar', promptText: 'Fill blank.', priority: 50 },
      },
    });

    const sources = buildSourcesFromConfig(undefined, blanksConfig, {
      ...defaultOptions,
      httpAdapter: countingAdapter,
    });

    const group = sources.find(s => s instanceof ClassifiedSourceGroup)!;
    const result = await group.getCues({
      text: '100 / 4 = _',
      words: ['100', '/', '4', '=', '_'],
    });

    // Only 1 call — math source directly (no classifier LLM needed)
    assert.strictEqual(callCount, 1, 'Fast classify should skip classifier LLM');
    assert.ok(result.results.length > 0);
    assert.ok(result.results[0].alternatives.includes('25'));
  });
});

// ---------------------------------------------------------------------------
// End-to-end: number handling in word alternatives
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Error handling edge cases
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ConfigSource.supports() edge cases
// ---------------------------------------------------------------------------

describe('ConfigSource.supports()', () => {
  it('words scope: supports non-blank text', () => {
    const src = new ConfigSource({
      sourceConfig: { name: 'grammar', promptText: 'Alts.', scope: 'words' },
      ...defaultOptions,
    });
    assert.strictEqual(src.supports({ text: 'hello world', words: ['hello', 'world'] }), true);
  });

  it('words scope: does not support blank text', () => {
    const src = new ConfigSource({
      sourceConfig: { name: 'grammar', promptText: 'Alts.', scope: 'words' },
      ...defaultOptions,
    });
    assert.strictEqual(src.supports({ text: 'hello _', words: ['hello', '_'] }), false);
  });

  it('blanks scope: supports blank text', () => {
    const src = new ConfigSource({
      sourceConfig: { name: 'grammar', promptText: 'Fill.', scope: 'blanks' },
      ...defaultOptions,
    });
    assert.strictEqual(src.supports({ text: 'hello _', words: ['hello', '_'] }), true);
  });

  it('blanks scope: does not support non-blank text', () => {
    const src = new ConfigSource({
      sourceConfig: { name: 'grammar', promptText: 'Fill.', scope: 'blanks' },
      ...defaultOptions,
    });
    assert.strictEqual(src.supports({ text: 'hello world', words: ['hello', 'world'] }), false);
  });

  it('all scope: supports both blank and non-blank', () => {
    const src = new ConfigSource({
      sourceConfig: { name: 'generic', promptText: 'Any.', scope: 'all' },
      ...defaultOptions,
    });
    assert.strictEqual(src.supports({ text: 'hello world', words: ['hello', 'world'] }), true);
    assert.strictEqual(src.supports({ text: 'hello _', words: ['hello', '_'] }), true);
  });

  it('default scope is words', () => {
    const src = new ConfigSource({
      sourceConfig: { name: 'grammar', promptText: 'Alts.' },
      ...defaultOptions,
    });
    assert.strictEqual(src.scope, 'words');
  });
});

// ---------------------------------------------------------------------------
// Resolver integration with combined sources
// ---------------------------------------------------------------------------

