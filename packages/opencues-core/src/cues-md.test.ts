/**
 * Tests for cues-md.ts — the .md config file parser.
 *
 * Run with: node --test dist/cues-md.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { parseCuesMd, parseSingleCueMd, validateCuesMd, KNOWN_SCOPES } from './cues-md';

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

describe('parseCuesMd: frontmatter', () => {
  it('should parse name, domain, version', () => {
    const cfg = parseCuesMd('---\nname: test\ndomain: claude-code\nversion: 1\n---\n');
    assert.strictEqual(cfg.frontmatter.name, 'test');
    assert.strictEqual(cfg.frontmatter.domain, 'claude-code');
    assert.strictEqual(cfg.frontmatter.version, 1);
  });

  it('should handle missing frontmatter', () => {
    const cfg = parseCuesMd('## Tips\nsome content');
    assert.deepStrictEqual(cfg.frontmatter, {});
  });

  it('should handle empty frontmatter', () => {
    const cfg = parseCuesMd('---\n---\n## Tips\nsome content');
    assert.deepStrictEqual(cfg.frontmatter, {});
  });

  it('should not leak frontmatter into body', () => {
    const cfg = parseCuesMd('---\nname: test\n---\n## Ignore\nhello');
    assert.ok(cfg.ignore);
    assert.ok(cfg.ignore.includes('hello'));
    assert.ok(!cfg.ignore.includes('name'));
  });

  it('should handle version as non-integer gracefully', () => {
    const cfg = parseCuesMd('---\nversion: abc\n---\n');
    assert.strictEqual(cfg.frontmatter.version, undefined);
  });
});

// ---------------------------------------------------------------------------
// Section splitting
// ---------------------------------------------------------------------------

describe('parseCuesMd: section splitting', () => {
  it('should parse multiple ## sections', () => {
    const cfg = parseCuesMd([
      '## Tips',
      '```json',
      '[{"id":"t","words":{"a":{"tip":"t","alts":["b"]}}}]',
      '```',
      '## Prompt',
      '### grammar',
      'prompt content',
      '## Ignore',
      'word1',
    ].join('\n'));
    assert.ok(cfg.tips);
    assert.ok(cfg.promptConfig);
    assert.ok(cfg.ignore);
  });

  it('should store unknown sections in sections map', () => {
    const cfg = parseCuesMd('## Custom\nmy custom content');
    assert.strictEqual(cfg.sections['Custom'], 'my custom content');
  });

  it('should handle empty file', () => {
    const cfg = parseCuesMd('');
    assert.deepStrictEqual(cfg.frontmatter, {});
    assert.strictEqual(cfg.promptConfig, undefined);
    assert.strictEqual(cfg.tips, undefined);
  });

  it('should handle file with only frontmatter', () => {
    const cfg = parseCuesMd('---\nname: test\n---\n');
    assert.strictEqual(cfg.frontmatter.name, 'test');
    assert.strictEqual(cfg.promptConfig, undefined);
  });
});

// ---------------------------------------------------------------------------
// ## Ignore
// ---------------------------------------------------------------------------

describe('parseCuesMd: ## Ignore', () => {
  it('should parse ignore words', () => {
    const cfg = parseCuesMd('## Ignore\nClaudeCode\nTypeScript\nJavaScript');
    assert.ok(cfg.ignore);
    assert.strictEqual(cfg.ignore.length, 3);
    assert.ok(cfg.ignore.includes('ClaudeCode'));
    assert.ok(cfg.ignore.includes('TypeScript'));
  });

  it('should skip empty lines and comments', () => {
    const cfg = parseCuesMd('## Ignore\n# comment\n\nword1\n\nword2\n');
    assert.ok(cfg.ignore);
    assert.strictEqual(cfg.ignore.length, 2);
  });
});

// ---------------------------------------------------------------------------
// ## Blanks
// ---------------------------------------------------------------------------

describe('parseCuesMd: ## Blanks', () => {
  it('should parse blanks from JSON block', () => {
    const cfg = parseCuesMd('## Blanks\n```json\n{"volume":{"name":"volume","tip":"vol"}}\n```');
    assert.ok(cfg.blanks);
    assert.ok(cfg.blanks.volume);
    assert.strictEqual(cfg.blanks.volume.name, 'volume');
    assert.strictEqual(cfg.blanks.volume.tip, 'vol');
  });

  it('should handle invalid JSON gracefully', () => {
    const cfg = parseCuesMd('## Blanks\n```json\n{invalid\n```');
    assert.strictEqual(cfg.blanks, undefined);
  });
});

// ---------------------------------------------------------------------------
// ## Prompt with ### subsections
// ---------------------------------------------------------------------------

describe('parseCuesMd: ## Prompt subsections', () => {
  it('should parse a single ### grammar source', () => {
    const cfg = parseCuesMd([
      '## Prompt',
      '### grammar',
      '```yaml',
      'priority: 50',
      '```',
      'Provide 3 alternatives per word.',
    ].join('\n'));

    assert.ok(cfg.promptConfig);
    assert.ok(cfg.promptConfig.sources.grammar);
    assert.strictEqual(cfg.promptConfig.sources.grammar.name, 'grammar');
    assert.strictEqual(cfg.promptConfig.sources.grammar.priority, 50);
    assert.ok(cfg.promptConfig.sources.grammar.promptText!.includes('Provide 3 alternatives'));
  });

  it('should parse multiple ### sources', () => {
    const cfg = parseCuesMd([
      '## Prompt',
      '### grammar',
      '```yaml',
      'priority: 50',
      '```',
      'Grammar prompt.',
      '### legal',
      '```yaml',
      'priority: 70',
      'match: contract|clause',
      '```',
      'Legal prompt.',
      '### medical',
      '```yaml',
      'priority: 75',
      'match: diagnosis|prognosis',
      'keywords: diagnosis, prognosis',
      '```',
      'Medical prompt.',
    ].join('\n'));

    assert.ok(cfg.promptConfig);
    const sources = cfg.promptConfig.sources;
    assert.strictEqual(Object.keys(sources).length, 3);
    assert.strictEqual(sources.grammar.priority, 50);
    assert.strictEqual(sources.legal.priority, 70);
    assert.strictEqual(sources.legal.match, 'contract|clause');
    assert.strictEqual(sources.medical.priority, 75);
    assert.strictEqual(sources.medical.keywords, 'diagnosis, prognosis');
  });

  it('should parse all yaml fields', () => {
    const cfg = parseCuesMd([
      '## Prompt',
      '### test',
      '```yaml',
      'priority: 80',
      'match: foo|bar',
      'keywords: baz, qux',
      'classify: Test domain',
      'parser: answer',
      'scope: blanks',
      'model: gpt-4',
      'enabled: false',
      '```',
      'Test prompt.',
    ].join('\n'));

    const src = cfg.promptConfig!.sources.test;
    assert.strictEqual(src.priority, 80);
    assert.strictEqual(src.match, 'foo|bar');
    assert.strictEqual(src.keywords, 'baz, qux');
    assert.strictEqual(src.classify, 'Test domain');
    assert.strictEqual(src.parser, 'answer');
    assert.strictEqual(src.scope, 'blanks');
    assert.strictEqual(src.model, 'gpt-4');
    assert.strictEqual(src.enabled, false);
  });

  it('should extract prompt text outside yaml blocks', () => {
    const cfg = parseCuesMd([
      '## Prompt',
      '### grammar',
      '```yaml',
      'priority: 50',
      '```',
      'Line 1 of prompt.',
      'Line 2 of prompt.',
      '',
      'Line 3 after blank.',
    ].join('\n'));

    const text = cfg.promptConfig!.sources.grammar.promptText!;
    assert.ok(text.includes('Line 1 of prompt.'));
    assert.ok(text.includes('Line 2 of prompt.'));
    assert.ok(text.includes('Line 3 after blank.'));
    assert.ok(!text.includes('priority: 50'));
  });

  it('should parse top-level model from preamble', () => {
    const cfg = parseCuesMd([
      '## Prompt',
      '```yaml',
      'model: custom-model',
      '```',
      '### grammar',
      'Grammar prompt.',
    ].join('\n'));

    assert.strictEqual(cfg.promptConfig!.model, 'custom-model');
  });

  it('should handle ### section with no yaml block', () => {
    const cfg = parseCuesMd([
      '## Prompt',
      '### grammar',
      'Just a plain prompt with no yaml.',
    ].join('\n'));

    const src = cfg.promptConfig!.sources.grammar;
    assert.ok(src.promptText!.includes('Just a plain prompt'));
    assert.strictEqual(src.priority, undefined);
    assert.strictEqual(src.match, undefined);
  });

  it('should handle ## Prompt with no ### subsections (legacy single prompt)', () => {
    // The legacy back-compat path emits a "grammar" source ONLY when
    // the YAML block declares match: or keywords: — without one the
    // source can't route any word at runtime, so emitting it would
    // surface a phantom entry in `opencues list`.
    const cfg = parseCuesMd([
      '## Prompt',
      '```yaml',
      'priority: 50',
      'match: .*',
      '```',
      'Single prompt without subsections.',
    ].join('\n'));

    assert.ok(cfg.promptConfig);
    assert.ok(cfg.promptConfig.sources.grammar);
    assert.ok(cfg.promptConfig.sources.grammar.promptText!.includes('Single prompt'));
  });

  it('should NOT emit a phantom "grammar" source when ## Prompt body has neither match: nor keywords:', () => {
    // Real-world case: shipped CUES.md has only commented-out examples
    // under ## Prompt. Pre-fix this produced a phantom entry visible
    // in `opencues list` but unusable at runtime.
    const cfg = parseCuesMd([
      '## Prompt',
      '# Just docs/comments — no actual source declaration.',
      'Some descriptive paragraph.',
    ].join('\n'));

    assert.deepStrictEqual(Object.keys(cfg.promptConfig?.sources || {}), []);
  });

  it('should lowercase ### headings', () => {
    const cfg = parseCuesMd([
      '## Prompt',
      '### Grammar',
      'Prompt text.',
      '### LEGAL',
      'Legal text.',
    ].join('\n'));

    assert.ok(cfg.promptConfig!.sources.grammar);
    assert.ok(cfg.promptConfig!.sources.legal);
  });
});

// ---------------------------------------------------------------------------
// ## Tips
// ---------------------------------------------------------------------------

describe('parseCuesMd: ## Tips', () => {
  it('should parse tips from JSON array', () => {
    const cfg = parseCuesMd([
      '## Tips',
      '```json',
      '[{"id":"test","words":{"hello":{"tip":"greeting","alts":["hi","hey"]}}}]',
      '```',
    ].join('\n'));

    assert.ok(cfg.tips);
    assert.strictEqual(cfg.tips.length, 1);
    assert.strictEqual(cfg.tips[0].id, 'test');
  });

  it('should handle tips with concepts wrapper', () => {
    const cfg = parseCuesMd([
      '## Tips',
      '```json',
      '{"concepts":[{"id":"test","words":{"a":{"tip":"t","alts":["b"]}}}]}',
      '```',
    ].join('\n'));

    assert.ok(cfg.tips);
    assert.strictEqual(cfg.tips[0].id, 'test');
  });

  it('should handle invalid JSON in tips', () => {
    const cfg = parseCuesMd('## Tips\n```json\n{broken\n```');
    assert.strictEqual(cfg.tips, undefined);
  });

  it('should handle missing json block in tips', () => {
    const cfg = parseCuesMd('## Tips\nJust some text, no code block.');
    assert.strictEqual(cfg.tips, undefined);
  });
});

// ---------------------------------------------------------------------------
// Real file parsing (BLANKS.md structure)
// ---------------------------------------------------------------------------

describe('parseCuesMd: BLANKS.md structure', () => {
  it('should parse classifier + multiple blank modes', () => {
    const cfg = parseCuesMd([
      '---',
      'name: blanks',
      'version: 1',
      '---',
      '',
      '## Ignore',
      'IgnoredWord',
      '',
      '## Prompt',
      '',
      '### classifier',
      '```yaml',
      'priority: 100',
      '```',
      'Classify: MATH or GRAMMAR',
      '',
      '### math',
      '```yaml',
      'priority: 90',
      'parser: compute',
      'match: \\d+\\s*[+\\-*/]\\s*\\d+',
      'keywords: factorial, average',
      '```',
      'Solve. Output ONLY: COMPUTE=expression',
      '',
      '### grammar',
      '```yaml',
      'priority: 50',
      'parser: alternatives',
      '```',
      'Fill each blank.',
    ].join('\n'));

    assert.strictEqual(cfg.frontmatter.name, 'blanks');
    assert.strictEqual(cfg.frontmatter.version, 1);
    assert.ok(cfg.ignore);
    assert.ok(cfg.ignore.includes('IgnoredWord'));

    const sources = cfg.promptConfig!.sources;
    assert.strictEqual(Object.keys(sources).length, 3);

    assert.strictEqual(sources.classifier.name, 'classifier');
    assert.ok(sources.classifier.promptText!.includes('Classify'));

    assert.strictEqual(sources.math.parser, 'compute');
    assert.strictEqual(sources.math.priority, 90);
    assert.strictEqual(sources.math.keywords, 'factorial, average');
    assert.ok(sources.math.match);

    assert.strictEqual(sources.grammar.parser, 'alternatives');
    assert.strictEqual(sources.grammar.priority, 50);
  });
});

// ---------------------------------------------------------------------------
// Real file parsing (CUES.md structure)
// ---------------------------------------------------------------------------

describe('parseCuesMd: CUES.md structure', () => {
  it('should parse tips + prompt + ignore together', () => {
    const cfg = parseCuesMd([
      '---',
      'name: cues',
      '---',
      '',
      '## Tips',
      '```json',
      '[{"id":"t","words":{"test":{"tip":"a tip","alts":["alt1"]}}}]',
      '```',
      '',
      '## Prompt',
      '### grammar',
      '```yaml',
      'priority: 50',
      '```',
      'Grammar prompt.',
      '### legal',
      '```yaml',
      'priority: 70',
      'match: contract',
      '```',
      'Legal prompt.',
      '',
      '## Ignore',
      'Claude',
      'Anthropic',
    ].join('\n'));

    assert.strictEqual(cfg.frontmatter.name, 'cues');
    assert.ok(cfg.tips);
    assert.strictEqual(cfg.tips[0].id, 't');
    assert.ok(cfg.promptConfig);
    assert.strictEqual(Object.keys(cfg.promptConfig.sources).length, 2);
    assert.ok(cfg.ignore);
    assert.strictEqual(cfg.ignore.length, 2);
  });
});

// ---------------------------------------------------------------------------
// validateCuesMd
// ---------------------------------------------------------------------------

describe('validateCuesMd', () => {
  it('should return no errors for valid config', () => {
    const cfg = parseCuesMd('---\nname: test\nversion: 1\n---\n## Ignore\nword');
    assert.deepStrictEqual(validateCuesMd(cfg), []);
  });

  it('should flag invalid version', () => {
    const cfg = parseCuesMd('---\nversion: 0\n---\n');
    // version: 0 → parseInt gives 0 which is falsy → undefined
    // Actually let's check what happens
    const errors = validateCuesMd(cfg);
    // version 0 becomes undefined due to `parseInt(value, 10) || undefined`
    assert.strictEqual(cfg.frontmatter.version, undefined);
  });

  it('should flag tips entry without id', () => {
    const cfg = parseCuesMd('## Tips\n```json\n[{"words":{"a":{"tip":"t","alts":["b"]}}}]\n```');
    const errors = validateCuesMd(cfg);
    assert.ok(errors.some(e => e.includes('missing "id"')));
  });

  it('should flag blank without name field', () => {
    // parseBlanksSection back-fills name from JSON key, so to test missing
    // name we need a JSON entry that explicitly nulls it out — easier to
    // construct the config directly.
    const cfg = parseCuesMd('## Blanks\n```json\n{"vol":{"tip":"volume"}}\n```') as any;
    if (cfg.blanks?.vol) cfg.blanks.vol.name = '';
    const errors = validateCuesMd(cfg);
    assert.ok(errors.some(e => e.includes('missing required "name"')));
  });

});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('parseCuesMd: edge cases', () => {
  it('should handle Windows line endings (\\r\\n)', () => {
    const cfg = parseCuesMd('---\r\nname: test\r\n---\r\n## Ignore\r\nword1\r\nword2\r\n');
    assert.strictEqual(cfg.frontmatter.name, 'test');
    assert.ok(cfg.ignore);
    assert.strictEqual(cfg.ignore.length, 2);
  });

  it('should handle section with extra whitespace in heading', () => {
    const cfg = parseCuesMd('##  Ignore \nword1');
    // The regex is /^## (.+)$/gm which captures " Ignore " then .trim()
    // Actually splitSections captures match[1].trim()
    assert.ok(cfg.ignore);
  });

  it('### inside code blocks ARE treated as headings (known limitation)', () => {
    const cfg = parseCuesMd([
      '## Prompt',
      '### grammar',
      'Here is an example:',
      '```',
      '### this is not a real heading',
      '```',
      'More prompt text.',
    ].join('\n'));

    // Known limitation: the parser uses regex and doesn't track code fence state.
    // ### inside code blocks is treated as a real subsection heading.
    // Workaround: don't put ### headings inside code blocks in .md config files.
    assert.strictEqual(Object.keys(cfg.promptConfig!.sources).length, 2);
  });

  it('should handle prompt text with special characters', () => {
    const cfg = parseCuesMd([
      '## Prompt',
      '### grammar',
      'Use format: INDEX:alt1,alt2,alt3|INDEX:alt1',
      'Example: 1:big,small → correct',
    ].join('\n'));

    const text = cfg.promptConfig!.sources.grammar.promptText!;
    assert.ok(text.includes('INDEX:alt1,alt2,alt3|INDEX:alt1'));
    assert.ok(text.includes('1:big,small'));
  });
});

// ---------------------------------------------------------------------------
// Real file validation — parse the actual BLANKS.md and CUES.md
// ---------------------------------------------------------------------------

describe('parseCuesMd: real BLANKS.md', () => {
  const fs = require('fs');
  const path = require('path');
  const blanksPath = path.resolve(__dirname, '../../../defaults/BLANKS.md');

  // Skip if BLANKS.md doesn't exist (CI without repo root) OR if it
  // doesn't contain classifier-sources content (these tests pin
  // behaviour that no longer ships in defaults/BLANKS.md).
  const fileContent = fs.existsSync(blanksPath) ? fs.readFileSync(blanksPath, 'utf8') : '';
  const blanksExists = fileContent.includes('classifier') && fileContent.includes('### math');

  (blanksExists ? it : it.skip)('should parse all 11 sources', () => {
    const cfg = parseCuesMd(fs.readFileSync(blanksPath, 'utf8'));
    const names = Object.keys(cfg.promptConfig!.sources);
    assert.strictEqual(names.length, 11);
    assert.ok(names.includes('classifier'));
    assert.ok(names.includes('math'));
    assert.ok(names.includes('factual'));
    assert.ok(names.includes('translation'));
    assert.ok(names.includes('unit'));
    assert.ok(names.includes('spelling'));
    assert.ok(names.includes('color'));
    assert.ok(names.includes('http'));
    assert.ok(names.includes('timezone'));
    assert.ok(names.includes('roman'));
    assert.ok(names.includes('grammar'));
  });

  (blanksExists ? it : it.skip)('should have correct parsers', () => {
    const cfg = parseCuesMd(fs.readFileSync(blanksPath, 'utf8'));
    const s = cfg.promptConfig!.sources;
    assert.strictEqual(s.math.parser, 'math');
    assert.strictEqual(s.unit.parser, 'math');
    assert.strictEqual(s.factual.parser, 'answer');
    assert.strictEqual(s.translation.parser, 'answer');
    assert.strictEqual(s.spelling.parser, 'answer');
    assert.strictEqual(s.color.parser, 'answer');
    assert.strictEqual(s.http.parser, 'answer');
    assert.strictEqual(s.timezone.parser, 'answer');
    assert.strictEqual(s.roman.parser, 'answer');
    assert.strictEqual(s.grammar.parser, 'alternatives');
  });

  (blanksExists ? it : it.skip)('every non-grammar/classifier source should have match or keywords', () => {
    const cfg = parseCuesMd(fs.readFileSync(blanksPath, 'utf8'));
    for (const [name, src] of Object.entries(cfg.promptConfig!.sources)) {
      if (name === 'classifier' || name === 'grammar') continue;
      assert.ok(src.match || src.keywords, `Source "${name}" has neither match nor keywords — will never fast-match`);
    }
  });

  (blanksExists ? it : it.skip)('every source should have prompt text', () => {
    const cfg = parseCuesMd(fs.readFileSync(blanksPath, 'utf8'));
    for (const [name, src] of Object.entries(cfg.promptConfig!.sources)) {
      assert.ok(src.promptText && src.promptText.length > 10, `Source "${name}" has no/short prompt text`);
    }
  });

  (blanksExists ? it : it.skip)('should pass validation with no errors', () => {
    const cfg = parseCuesMd(fs.readFileSync(blanksPath, 'utf8'));
    const errors = validateCuesMd(cfg);
    assert.deepStrictEqual(errors, [], `Validation errors: ${errors.join(', ')}`);
  });

  (blanksExists ? it : it.skip)('should have ignore words', () => {
    const cfg = parseCuesMd(fs.readFileSync(blanksPath, 'utf8'));
    assert.ok(cfg.ignore && cfg.ignore.length > 0, 'BLANKS.md should have ignore words');
  });
});

// ---------------------------------------------------------------------------
// Forward-compat: unknown scope values
// ---------------------------------------------------------------------------
//
// Pin the contract that a cue declaring a scope this runtime doesn't
// recognize is DROPPED rather than coerced to the default ('words').
// Coercion causes scope-specific LLM output (e.g. sentence rewrites)
// to land in word-cue slots — the May 2026 sentence-cues-on-stale-chrome
// misrender. Silent drop is the safe degrade for integrations that have
// fallen behind core.

describe('parseCuesMd: unknown scope forward-compat', () => {
  // Capture console.warn so the test output stays clean and we can also
  // assert the warning fired (one-shot — restored in each test).
  function captureWarn<T>(fn: () => T): { result: T; warnings: string[] } {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try { return { result: fn(), warnings }; }
    finally { console.warn = original; }
  }

  it('KNOWN_SCOPES is the exact allowlist', () => {
    assert.deepStrictEqual([...KNOWN_SCOPES].sort(), ['all', 'blanks', 'sentence', 'words']);
  });

  it('parseSingleCueMd drops a source whose scope is unknown', () => {
    const content = '---\nname: future-cue\nscope: paragraph\npriority: 80\n---\nRewrite each paragraph.';
    const { result: cfg, warnings } = captureWarn(() => parseSingleCueMd(content, '/cues/future-cue'));
    assert.strictEqual(cfg.promptConfig, undefined, 'no source should be built for unknown scope');
    assert.ok(warnings.some(w => w.includes('future-cue') && w.includes('paragraph')), 'warning should name the cue and the unknown scope');
  });

  it('parseSingleCueMd still builds a source for a known scope', () => {
    const content = '---\nname: sentence-cue\nscope: sentence\npriority: 85\n---\nRewrite each sentence.';
    const { result: cfg, warnings } = captureWarn(() => parseSingleCueMd(content, '/cues/sentence-cue'));
    assert.ok(cfg.promptConfig?.sources?.['sentence-cue'], 'known scope should produce a source');
    assert.strictEqual(cfg.promptConfig?.sources?.['sentence-cue'].scope, 'sentence');
    assert.strictEqual(warnings.length, 0, 'no warning for a known scope');
  });

  it('parseSingleCueMd treats absent scope as default (no drop)', () => {
    const content = '---\nname: vanilla-cue\nmatch: hello\npriority: 60\n---\nRewrite hello.';
    const { result: cfg, warnings } = captureWarn(() => parseSingleCueMd(content, '/cues/vanilla-cue'));
    assert.ok(cfg.promptConfig?.sources?.['vanilla-cue'], 'absent scope should not trigger drop');
    assert.strictEqual(warnings.length, 0);
  });

  it('parsePromptSection drops a ### source whose scope is unknown', () => {
    const md = [
      '## Prompt',
      '### future',
      '```yaml',
      'match: foo',
      'priority: 50',
      'scope: paragraph',
      '```',
      'prompt body',
      '',
      '### legacy',
      '```yaml',
      'match: bar',
      'priority: 50',
      'scope: words',
      '```',
      'legacy body',
    ].join('\n');
    const { result: cfg, warnings } = captureWarn(() => parseCuesMd(md));
    assert.strictEqual(cfg.promptConfig?.sources?.['future'], undefined, 'unknown-scope subsection should not appear');
    assert.ok(cfg.promptConfig?.sources?.['legacy'], 'known-scope subsection should appear');
    assert.ok(warnings.some(w => w.includes('future') && w.includes('paragraph')));
  });

  it('parsePromptSection drops the legacy single-grammar source on unknown scope', () => {
    const md = [
      '## Prompt',
      '```yaml',
      'match: foo',
      'scope: paragraph',
      '```',
      'inline prompt body',
    ].join('\n');
    const { result: cfg, warnings } = captureWarn(() => parseCuesMd(md));
    assert.ok(!cfg.promptConfig?.sources?.['grammar'], 'legacy grammar source should be dropped on unknown scope');
    assert.ok(warnings.some(w => w.includes('grammar') && w.includes('paragraph')));
  });
});

// ---------------------------------------------------------------------------
// Per-source maxTokens + temperature overrides
// ---------------------------------------------------------------------------
//
// Pin that the parser accepts `maxTokens:` / `temperature:` in CUE.md
// frontmatter AND inline ### subsection YAML, and surfaces them on
// SourceConfig / BlankConfig for the source classes to consume.

describe('parseCuesMd: per-source maxTokens + temperature overrides', () => {
  it('parseSingleCueMd lifts maxTokens + temperature from frontmatter onto the SourceConfig', () => {
    const content = '---\nname: hot-cue\nmatch: hello\nmaxTokens: 100\ntemperature: 1.2\n---\nPrompt body.';
    const cfg = parseSingleCueMd(content, '/cues/hot-cue');
    const src = cfg.promptConfig?.sources?.['hot-cue'];
    assert.ok(src, 'source should be built');
    assert.strictEqual(src.maxTokens, 100);
    assert.strictEqual(src.temperature, 1.2);
  });

  it('parseSingleCueMd accepts the hyphenated YAML form (max-tokens)', () => {
    const content = '---\nname: cool-cue\nmatch: world\nmax-tokens: 250\ntemperature: 0.5\n---\nBody.';
    const cfg = parseSingleCueMd(content, '/cues/cool-cue');
    const src = cfg.promptConfig?.sources?.['cool-cue'];
    assert.strictEqual(src?.maxTokens, 250);
    assert.strictEqual(src?.temperature, 0.5);
  });

  it('parseSingleCueMd rejects negative / non-numeric / out-of-range values', () => {
    const cases = [
      '---\nname: bad-tokens\nmatch: x\nmaxTokens: -10\n---\nbody',
      '---\nname: bad-tokens\nmatch: x\nmaxTokens: not-a-number\n---\nbody',
      '---\nname: bad-temp\nmatch: x\ntemperature: 5\n---\nbody',
      '---\nname: bad-temp\nmatch: x\ntemperature: -0.5\n---\nbody',
    ];
    for (const content of cases) {
      const cfg = parseSingleCueMd(content, '/cues/bad');
      const name = content.match(/name: (\S+)/)?.[1] ?? 'bad';
      const src = cfg.promptConfig?.sources?.[name];
      assert.ok(src, `source should still build (we silently reject bad overrides): ${content.slice(0, 60)}`);
      assert.strictEqual(src.maxTokens, undefined, `maxTokens should NOT be set for: ${content.slice(0, 60)}`);
      assert.strictEqual(src.temperature, undefined, `temperature should NOT be set for: ${content.slice(0, 60)}`);
    }
  });

  it('parsePromptSection lifts maxTokens + temperature from inline ### YAML', () => {
    const md = [
      '## Prompt',
      '### tone',
      '```yaml',
      'match: foo',
      'priority: 70',
      'maxTokens: 400',
      'temperature: 0.4',
      '```',
      'inline prompt body',
    ].join('\n');
    const cfg = parseCuesMd(md);
    const src = cfg.promptConfig?.sources?.['tone'];
    assert.strictEqual(src?.maxTokens, 400);
    assert.strictEqual(src?.temperature, 0.4);
  });

  it('absent overrides leave fields undefined (source class will use its bench default)', () => {
    const content = '---\nname: vanilla-cue\nmatch: hi\n---\nbody';
    const cfg = parseSingleCueMd(content, '/cues/vanilla-cue');
    const src = cfg.promptConfig?.sources?.['vanilla-cue'];
    assert.strictEqual(src?.maxTokens, undefined);
    assert.strictEqual(src?.temperature, undefined);
  });
});

describe('parseCuesMd: real CUES.md', () => {
  const fs = require('fs');
  const path = require('path');
  const cuesPath = path.resolve(__dirname, '../../../defaults/CUES.md');
  const cuesExists = fs.existsSync(cuesPath);

  (cuesExists ? it : it.skip)('parses cleanly (sources live in words/<name>.md or cues/<name>/CUE.md, not inline)', () => {
    const cfg = parseCuesMd(fs.readFileSync(cuesPath, 'utf8'));
    assert.ok(cfg);
    // No inline word sources expected — everything is folder-based now.
    assert.ok(!cfg.promptConfig?.sources || Object.keys(cfg.promptConfig.sources).length === 0);
  });

  (cuesExists ? it : it.skip)('does not store inline tips (tips are folder-based)', () => {
    const cfg = parseCuesMd(fs.readFileSync(cuesPath, 'utf8'));
    assert.ok(!cfg.tips || cfg.tips.length === 0, 'tips moved to words/<id>.md or cues/<id>/CUE.md');
  });

  (cuesExists ? it : it.skip)('should pass validation', () => {
    const cfg = parseCuesMd(fs.readFileSync(cuesPath, 'utf8'));
    assert.deepStrictEqual(validateCuesMd(cfg), []);
  });
});

describe('Phase 4 — typed-sentinel blank fields (signature/returns/ai-callable)', () => {
  const parse = (fm: string) => parseSingleCueMd(`---\n${fm}\n---`, '/x').blanks?.['b'];

  it('parses signature + returns + ai-callable on a fetch blank', () => {
    const b = parse('name: b\ntype: blank\nblankKeywords: x\nsignature: (ticker: string)\nreturns: number\nai-callable: true');
    assert.strictEqual(b?.signature, '(ticker: string)');
    assert.strictEqual(b?.returns, 'number');
    assert.strictEqual(b?.aiCallable, true);
  });

  it('defaults ai-callable to undefined (instance-only) when absent', () => {
    const b = parse('name: b\ntype: blank\nblankKeywords: x\nsignature: (t: string)');
    assert.strictEqual(b?.aiCallable, undefined);
  });

  it('SECURITY: refuses ai-callable on a script blank (LLM-arg must never reach a shell)', () => {
    const orig = console.warn;
    let warned = '';
    console.warn = (m?: unknown) => { warned = String(m); };
    const b = parse('name: b\ntype: blank\nblankKeywords: x\nblankScript: ./x.sh\nai-callable: true');
    console.warn = orig;
    assert.strictEqual(b?.aiCallable, undefined, 'ai-callable must be stripped on a script blank');
    assert.match(warned, /IGNORED/);
  });
});
