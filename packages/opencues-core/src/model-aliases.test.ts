/**
 * Tests for model-aliases — the `with <model>` per-call override
 * detector.
 *
 * Run with: node --test dist/model-aliases.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { detectModelOverride, stripModelOverride } from './model-aliases';

describe('detectModelOverride: common aliases', () => {
  it('opus → anthropic/claude-opus-4-7', () => {
    const out = detectModelOverride('summarize this paragraph with opus _');
    assert.ok(out, 'expected a match');
    assert.strictEqual(out.provider, 'anthropic');
    assert.strictEqual(out.model, 'claude-opus-4-7');
    assert.strictEqual(out.matchedToken, 'opus');
  });

  it('haiku → anthropic/claude-haiku-4-5-...', () => {
    const out = detectModelOverride('make this funnier with haiku _');
    assert.ok(out);
    assert.strictEqual(out.provider, 'anthropic');
    assert.ok(out.model.includes('haiku'));
  });

  it('sonnet → anthropic/claude-sonnet-4-6', () => {
    const out = detectModelOverride('rewrite with sonnet _');
    assert.ok(out);
    assert.strictEqual(out.model, 'claude-sonnet-4-6');
  });

  it('cerebras → cerebras + default model', () => {
    const out = detectModelOverride('atomic number of oxygen with cerebras _');
    assert.ok(out);
    assert.strictEqual(out.provider, 'cerebras');
    assert.strictEqual(out.model, 'gpt-oss-120b');
  });

  it('nano → openai/gpt-5.4-nano', () => {
    const out = detectModelOverride('explain this with nano _');
    assert.ok(out);
    assert.strictEqual(out.provider, 'openai');
    assert.strictEqual(out.model, 'gpt-5.4-nano');
  });

  it('gpt-oss → cerebras/gpt-oss-120b (faster of the two providers serving it)', () => {
    const out = detectModelOverride('explain with gpt-oss _');
    assert.ok(out);
    assert.strictEqual(out.provider, 'cerebras');
    assert.strictEqual(out.model, 'gpt-oss-120b');
  });
});

describe('detectModelOverride: case + position', () => {
  it('case-insensitive on `with`', () => {
    assert.ok(detectModelOverride('summarize With opus _'));
    assert.ok(detectModelOverride('summarize WITH opus _'));
  });

  it('case-insensitive on the token', () => {
    const out = detectModelOverride('summarize with OPUS _');
    assert.ok(out);
    assert.strictEqual(out.provider, 'anthropic');
  });

  it('returns the LAST `with <model>` when several match — closer to the `_` is what the user is currently editing', () => {
    const out = detectModelOverride('write with sonnet then refine with opus _');
    assert.ok(out);
    assert.strictEqual(out.model, 'claude-opus-4-7');
  });

  it('match offsets cover the full `with <token>` span', () => {
    const text = 'summarize this with opus _';
    const out = detectModelOverride(text);
    assert.ok(out);
    assert.strictEqual(text.slice(out.matchStart, out.matchEnd), 'with opus');
  });
});

describe('detectModelOverride: negative cases', () => {
  it('no `with` → null', () => {
    assert.strictEqual(detectModelOverride('summarize this paragraph _'), null);
  });

  it('`with` + unknown token → null (does not fall back to any default)', () => {
    assert.strictEqual(detectModelOverride('play with fire _'), null);
    assert.strictEqual(detectModelOverride('with the cat _'), null);
  });

  it('`with` + number → null (token must start with letter)', () => {
    assert.strictEqual(detectModelOverride('compare with 5 _'), null);
  });

  it('`without` does NOT match (word-boundary on `with`)', () => {
    assert.strictEqual(detectModelOverride('without opus _'), null);
  });

  it('empty buffer → null', () => {
    assert.strictEqual(detectModelOverride(''), null);
  });

  it('only `_` → null', () => {
    assert.strictEqual(detectModelOverride('_'), null);
  });
});

describe('detectModelOverride: substring on knownModels', () => {
  it('`gpt-5` → openai (matches gpt-5.4-* family)', () => {
    const out = detectModelOverride('translate with gpt-5 _');
    assert.ok(out);
    assert.strictEqual(out.provider, 'openai');
    assert.ok(out.model.startsWith('gpt-5'));
  });

  it('full model name → exact provider', () => {
    const out = detectModelOverride('do this with claude-opus-4-7 _');
    assert.ok(out);
    assert.strictEqual(out.provider, 'anthropic');
    assert.strictEqual(out.model, 'claude-opus-4-7');
  });
});

describe('stripModelOverride', () => {
  it('removes `with opus` from middle of buffer + collapses double space', () => {
    const text = 'summarize this paragraph with opus _';
    const out = detectModelOverride(text);
    assert.ok(out);
    assert.strictEqual(stripModelOverride(text, out), 'summarize this paragraph _');
  });

  it('handles `with X` at the end of the buffer', () => {
    const text = 'summarize _ with opus';
    const out = detectModelOverride(text);
    assert.ok(out);
    assert.strictEqual(stripModelOverride(text, out), 'summarize _');
  });

  it('handles `with X` at the start', () => {
    const text = 'with opus summarize this _';
    const out = detectModelOverride(text);
    assert.ok(out);
    assert.strictEqual(stripModelOverride(text, out), 'summarize this _');
  });
});
