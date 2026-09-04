// ModelBlank — "what's my model?" / "list models" over the shared
// effective-routing walk. The heavy precedence testing lives in
// @opencues/core's effective-routing.test.ts (ladder matrix +
// dispatch-equivalence grid); these tests pin the BLANK's contract:
// mode selection by keyword, bucket filter by context word, alt
// composition, and the named (never silent) degraded states.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  setCliAvailabilityForTests,
  resetCliAvailabilityCacheForTests,
} from '@opencues/core';
import { ModelBlank } from './model';

// The zero-key auto-route falls through to the subscription-CLI rung
// (binary probe). Seed the probe cache so tests model a machine with
// no `claude`/`codex` on PATH regardless of the dev box.
beforeEach(() => {
  setCliAvailabilityForTests('claude-code-cli', false);
  setCliAvailabilityForTests('openai-subscription', false);
});
afterEach(() => resetCliAvailabilityCacheForTests());

function makeBlank(
  frontmatter: string,
  apiKeys: Record<string, string | undefined> = {},
): ModelBlank {
  const content = frontmatter.trim() === ''
    ? 'no frontmatter here'
    : `---\n${frontmatter.trim()}\n---\n\nbody\n`;
  return new ModelBlank({
    readSettingsFile: async () => content,
    getApiKeys: () => apiKeys,
  });
}

describe('ModelBlank — current model', () => {
  it('all buckets agree → single provider · model as the primary alt', async () => {
    const blank = makeBlank('llm-provider: cerebras', { CEREBRAS_API_KEY: 'k' });
    const alts = (await blank.get('model')).split('\n');
    expect(alts[0]).toBe('cerebras · gpt-oss-120b');
    expect(alts[1]).toBe(
      'cues: cerebras · gpt-oss-120b | auditors: cerebras · gpt-oss-120b | blanks: cerebras · gpt-oss-120b',
    );
    expect(alts[2]).toBe('source: provider from llm-provider · model from provider default');
  });

  it('buckets differ → blanks-bucket primary with a differ tag', async () => {
    const blank = makeBlank(
      'llm-provider: cerebras\ncues-llm-provider: groq',
      { CEREBRAS_API_KEY: 'k', GROQ_API_KEY: 'k' },
    );
    const alts = (await blank.get('model')).split('\n');
    expect(alts[0]).toBe('cerebras · gpt-oss-120b (blanks bucket — buckets differ)');
    expect(alts[1]).toContain('cues: groq · openai/gpt-oss-120b');
  });

  it('auto-routed from an env key with nothing configured', async () => {
    const blank = makeBlank('', { CEREBRAS_API_KEY: 'k' });
    const alts = (await blank.get('model')).split('\n');
    expect(alts[0]).toBe('cerebras · gpt-oss-120b');
    expect(alts[2]).toBe('source: provider from auto (env key) · model from provider default');
  });

  it('nothing configured, no keys → named zero-state, single alt', async () => {
    const blank = makeBlank('');
    const out = await blank.get('model');
    expect(out).toBe(
      'no LLM configured — add a key (opencues set-key) or set llm-provider: in ~/.cues/OPENCUES.md',
    );
  });

  it('configured provider with a missing key is flagged, never silent', async () => {
    const blank = makeBlank('llm-provider: gemini');
    const alts = (await blank.get('model')).split('\n');
    expect(alts[0]).toBe('gemini · gemini-3.5-flash-lite (key missing)');
  });

  it('unknown global provider id is named', async () => {
    const blank = makeBlank('llm-provider: nopeai', { CEREBRAS_API_KEY: 'k' });
    const alts = (await blank.get('model')).split('\n');
    // All three buckets resolve to the same dead route, so no differ tag.
    expect(alts[0]).toBe('nopeai (unknown provider — calls disabled)');
  });

  it('menu-written bucket model on an inherited provider is reported (Case B)', async () => {
    const blank = makeBlank(
      'llm-provider: cerebras\nblanks-llm-model: gemma-4-31b',
      { CEREBRAS_API_KEY: 'k' },
    );
    const alts = (await blank.get('model')).split('\n');
    expect(alts[0]).toBe('cerebras · gemma-4-31b (blanks bucket — buckets differ)');
    expect(alts[2]).toBe('source: provider from llm-provider · model from blanks-llm-model');
  });
});

describe('ModelBlank — bucket filter via context', () => {
  it('"model for cues _" answers the cues bucket only', async () => {
    const blank = makeBlank(
      'cues-llm-provider: groq\nllm-provider: cerebras',
      { GROQ_API_KEY: 'k', CEREBRAS_API_KEY: 'k' },
    );
    const alts = (await blank.get('model', ['cues'])).split('\n');
    expect(alts[0]).toBe('cues: groq · openai/gpt-oss-120b');
    expect(alts[1]).toBe('source: provider from cues-llm-provider · model from provider default');
    expect(alts.length).toBe(2);
  });
});

describe('ModelBlank — list models', () => {
  it('keyword "models" lists the current provider first with the active model starred', async () => {
    const blank = makeBlank('llm-provider: cerebras', { CEREBRAS_API_KEY: 'k' });
    const lines = (await blank.get('models')).split('\n');
    expect(lines[0]).toBe('cerebras (current): gpt-oss-120b*, zai-glm-4.7, gemma-4-31b, qwen-3.8-27b');
    // Keyless env-key providers land after usable ones and are tagged.
    const gemini = lines.find((l) => l.startsWith('gemini'));
    expect(gemini).toContain('(no key)');
    const idx = (p: string): number => lines.findIndex((l) => l.startsWith(p));
    expect(idx('cerebras')).toBeLessThan(idx('gemini'));
  });

  it('key-set providers are tagged and sorted above keyless ones', async () => {
    const blank = makeBlank('llm-provider: cerebras', {
      CEREBRAS_API_KEY: 'k',
      GROQ_API_KEY: 'k',
    });
    const lines = (await blank.get('models')).split('\n');
    const groq = lines.find((l) => l.startsWith('groq'));
    expect(groq).toContain('(key set)');
    const idx = (p: string): number => lines.findIndex((l) => l.startsWith(p));
    expect(idx('groq')).toBeLessThan(idx('openai '));
  });
});

describe('ModelBlank — contract', () => {
  it('is read-only and named model', () => {
    const blank = makeBlank('');
    expect(blank.readOnly).toBe(true);
    expect(blank.name).toBe('model');
  });

  it('re-reads OPENCUES.md on every invocation (settings hot-reload)', async () => {
    let content = '---\nllm-provider: cerebras\n---\n';
    const blank = new ModelBlank({
      readSettingsFile: async () => content,
      getApiKeys: () => ({ CEREBRAS_API_KEY: 'k', GROQ_API_KEY: 'k' }),
    });
    expect((await blank.get('model')).split('\n')[0]).toBe('cerebras · gpt-oss-120b');
    content = '---\nllm-provider: groq\n---\n';
    expect((await blank.get('model')).split('\n')[0]).toBe('groq · openai/gpt-oss-120b');
  });
});
