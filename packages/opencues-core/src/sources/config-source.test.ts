/**
 * Tests for ConfigSource — the generic config-driven CueSource.
 *
 * Focus: the defensive format-spec auto-append for parser: alternatives.
 * This contract is load-bearing — without it, a naive domain cue (a
 * vocabulary pack, anything a user authors without reading the
 * RoutedWordSourceGroup docs) causes the LLM to respond in prose,
 * breaking word highlights.
 *
 * Run with: node --test dist/sources/config-source.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { ConfigSource } from './config-source';
import { CueContext, HttpAdapter } from '../types';
import { SourceConfig } from '../cues-md';
import { getProvider } from '../llm-provider';

// Capturing adapter: records every prompt sent to the LLM so we can
// assert on what the LLM actually saw.
function mkCapturingAdapter(): { adapter: HttpAdapter; sent: string[] } {
  const sent: string[] = [];
  const adapter: HttpAdapter = {
    post: async (_url, body) => {
      try {
        const parsed = JSON.parse(body);
        const msg = parsed?.messages?.[0]?.content;
        if (typeof msg === 'string') sent.push(msg);
      } catch { /* ignore */ }
      // Canned response — shape doesn't matter for these assertions.
      return '{"choices":[{"message":{"content":"1:a,b,c"}}]}';
    },
  };
  return { adapter, sent };
}

function mkSource(cfg: Partial<SourceConfig>, adapter: HttpAdapter): ConfigSource {
  const full: SourceConfig = {
    name: 'test',
    promptText: cfg.promptText ?? 'Give alternatives.',
    parser: cfg.parser ?? 'alternatives',
    scope: cfg.scope ?? 'words',
    priority: 50,
    ...cfg,
  };
  return new ConfigSource({
    sourceConfig: full,
    httpAdapter: adapter,
    provider: getProvider('groq')!,
    endpoint: 'https://example.test',
    apiKey: 'k',
    model: 'm',
  });
}

const ctx: CueContext = { text: '1=happy', words: ['happy'] };

describe('ConfigSource: format-spec auto-append (parser: alternatives)', () => {
  it('appends the format spec when the prompt lacks one', async () => {
    // Realistic "naive domain cue" — describes WHAT to suggest but
    // doesn't constrain output shape. Before this guard, an LLM would
    // respond in prose/tables, breaking parseAlternatives.
    const { adapter, sent } = mkCapturingAdapter();
    const source = mkSource({
      promptText: 'Suggest alternatives that preserve the meaning.',
    }, adapter);
    await source.getCues(ctx);

    assert.strictEqual(sent.length, 1);
    assert.match(sent[0], /index:alternatives format/i,
      'getCues should auto-append INDEX:alternatives format spec');
    // Format spec must appear AFTER the base prompt (so it's the
    // last instruction the LLM sees before the input).
    const specIdx = sent[0].toLowerCase().indexOf('index:alternatives format');
    const baseIdx = sent[0].indexOf('Suggest alternatives');
    assert.ok(specIdx > baseIdx, 'format spec should come after base prompt');
  });

  it('does NOT re-append when the prompt already contains a format spec', async () => {
    // Cue author who remembered to write it themselves (common) —
    // auto-append would cause two reminders; detect and skip.
    const { adapter, sent } = mkCapturingAdapter();
    const source = mkSource({
      promptText: 'Suggest 3 alts.\nFormat: INDEX:alt1,alt2,alt3',
    }, adapter);
    await source.getCues(ctx);

    assert.strictEqual(sent.length, 1);
    const matches = sent[0].match(/index:alt/gi) ?? [];
    // 1 from the user's Format: line; guard should not add a second.
    assert.strictEqual(matches.length, 1,
      `expected 1 format-spec mention, got ${matches.length}`);
  });

  it('recognizes variant spellings (INDEX:alt, index: alt, Format: INDEX)', async () => {
    const variants = [
      'Respond with INDEX:alt1,alt2,alt3',
      'Output shape: index: alt,alt,alt',
      'Format: INDEX:foo,bar,baz',
    ];
    for (const v of variants) {
      const { adapter, sent } = mkCapturingAdapter();
      const source = mkSource({ promptText: v }, adapter);
      await source.getCues(ctx);
      const count = (sent[0].match(/index\s*:\s*alt/gi) ?? []).length;
      assert.strictEqual(count, 1, `variant "${v}" triggered a duplicate spec`);
    }
  });

  it('does not touch non-alternatives parsers (compute, answer, raw, math)', async () => {
    // Those parsers have their own output contracts (COMPUTE=, ANSWER=,
    // raw strings). Appending an INDEX:alt reminder would confuse the
    // LLM. Only the alternatives parser gets the guard.
    for (const parser of ['raw'] as const) {
      const { adapter, sent } = mkCapturingAdapter();
      const source = mkSource({
        promptText: 'Some prompt without a format spec.',
        parser,
      }, adapter);
      await source.getCues(ctx);
      assert.doesNotMatch(sent[0], /index:alternatives format/i,
        `parser=${parser} should NOT get the alternatives format spec auto-appended`);
    }
  });
});
