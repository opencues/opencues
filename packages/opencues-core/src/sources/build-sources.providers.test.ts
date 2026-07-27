/**
 * Multi-provider routing tests for buildSourcesFromConfig.
 *
 * Pin: when the user picks different providers per feature in CUES.md,
 * each LLM call site sends the wire format of its OWN provider.
 *   - word-cues  → openrouter (OpenAI-shape, openrouter URL)
 *   - fluid-blank → gemini    (gemini URL, contents/parts body)
 *   - spelling    → openai    (api.openai.com URL)
 *   - transform-blank → groq  (api.groq.com URL)
 * Each source's first POST is captured and the URL/body checked.
 *
 * Run with: node --test dist/sources/build-sources.providers.test.js
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { buildSourcesFromConfig } from './build-sources';
import type { CuesMdConfig } from '../cues-md';
import type { CueSource, HttpAdapter } from '../types';

interface CapturedCall { url: string; body: string; headers: Record<string, string> }

function captureAdapter(): { adapter: HttpAdapter; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const adapter: HttpAdapter = {
    post: async (url, body, headers) => {
      calls.push({ url, body, headers });
      // Return a plausible response for whichever shape the provider expects.
      // Tests don't care about the data — just the request shape.
      // Default to OpenAI shape; gemini-keyed URLs get gemini-shape.
      if (url.includes('generativelanguage.googleapis.com')) {
        return JSON.stringify({ candidates: [{ content: { parts: [{ text: '0:a' }] } }] });
      }
      return JSON.stringify({ choices: [{ message: { content: '0:a' } }] });
    },
  };
  return { adapter, calls };
}

const apiKeys = {
  GROQ_API_KEY: 'groq_k',
  OPENROUTER_API_KEY: 'or_k',
  GEMINI_API_KEY: 'gem_k',
  OPENAI_API_KEY: 'oai_k',
};

describe('buildSourcesFromConfig — per-feature provider routing', () => {
  it('word-cues uses openrouter when wordCuesProvider is set', async () => {
    const { adapter, calls } = captureAdapter();
    const config: CuesMdConfig = {
      frontmatter: {},
      sections: {},
      promptConfig: {
        sources: {
          grammar: { name: 'grammar', promptText: 'G.', priority: 50, match: '.*' },
        },
      },
    };
    const sources = buildSourcesFromConfig(config, undefined, {
      httpAdapter: adapter,
      apiKeys,
      wordCues: { provider: 'openrouter', model: 'deepseek/deepseek-chat-v3.1:free' },
      enableWordCues: true,
    });
    assert.ok(sources.length > 0, 'expected at least one source');
    await sources[0].getCues({ text: 'hi', words: ['hi'] });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.strictEqual(calls[0].headers.Authorization, 'Bearer or_k');
    assert.match(calls[0].headers['HTTP-Referer'], /opencues\.dev/);
    const body = JSON.parse(calls[0].body);
    assert.strictEqual(body.model, 'deepseek/deepseek-chat-v3.1:free');
  });

  it('fluid-blank uses gemini when fluidBlankProvider is set', async () => {
    const { adapter, calls } = captureAdapter();
    const sources = buildSourcesFromConfig(undefined, undefined, {
      httpAdapter: adapter,
      apiKeys,
      fluidBlank: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
      enableFluidBlank: true,
    });
    const fluid = sources.find((s: CueSource) => s.id === 'fluid-blank');
    assert.ok(fluid, 'expected a fluid-blank source');
    await fluid!.getCues({ text: 'capital of france _', words: ['capital', 'of', 'france', '_'] });
    assert.ok(calls.length > 0);
    assert.match(calls[0].url, /generativelanguage\.googleapis\.com/);
    assert.match(calls[0].url, /models\/gemini-3\.1-flash-lite:generateContent$/);
    // INFOSEC F8: API key in header, not URL.
    assert.ok(!calls[0].url.includes('key='), 'F8: URL must not contain ?key=');
    assert.ok(!calls[0].url.includes('gem_k'), 'F8: URL must not contain the API key');
    assert.strictEqual(calls[0].headers['x-goog-api-key'], 'gem_k');
    const body = JSON.parse(calls[0].body);
    assert.ok(body.contents, 'expected gemini-shaped body with `contents`');
    assert.ok(body.systemInstruction, 'expected systemInstruction (gemini-shape)');
  });

  it('spelling cue (config-driven) uses openai when wordCuesProvider is set', async () => {
    // Spelling is now a regular word-scope ConfigSource (see
    // defaults/cues/spelling.md). It inherits per-cue / `word-cues-*`
    // provider routing — no dedicated `spelling-provider` setting.
    const { adapter, calls } = captureAdapter();
    const config: CuesMdConfig = {
      frontmatter: {}, sections: {},
      promptConfig: {
        sources: {
          spelling: { name: 'spelling', match: '.*', priority: 80, promptText: 'spell-check this' },
        },
      },
    };
    const sources = buildSourcesFromConfig(config, undefined, {
      httpAdapter: adapter,
      apiKeys,
      wordCues: { provider: 'openai', model: 'gpt-4o-mini' },
      enableWordCues: true,
    });
    assert.ok(sources.length > 0, 'expected the spelling cue to be registered');
    await sources[0].getCues({ text: 'helo wrold', words: ['helo', 'wrold'] });
    assert.ok(calls.length > 0);
    assert.strictEqual(calls[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.strictEqual(calls[0].headers.Authorization, 'Bearer oai_k');
    const body = JSON.parse(calls[0].body);
    assert.strictEqual(body.model, 'gpt-4o-mini');
  });

  it('different sources can use different providers in one build', async () => {
    const { adapter, calls } = captureAdapter();
    const config: CuesMdConfig = {
      frontmatter: {}, sections: {},
      promptConfig: {
        sources: {
          // Per-cue provider override on this one cue; everything else inherits wordCues feature default.
          plain: {
            name: 'plain', match: '.*', priority: 70, promptText: 'M.',
            provider: 'openrouter', model: 'deepseek/deepseek-chat-v3.1:free',
          },
        },
      },
    };
    const sources = buildSourcesFromConfig(config, undefined, {
      httpAdapter: adapter,
      apiKeys,
      globalProvider: 'groq',
      globalModel: 'openai/gpt-oss-120b',
      fluidBlank: { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
      enableFluidBlank: true,
      enableWordCues: true,
    });
    const fluid = sources.find((s: CueSource) => s.id === 'fluid-blank')!;
    const wordSource = sources.find((s: CueSource) => s.id !== 'fluid-blank')!;
    await Promise.all([
      fluid.getCues({ text: 'capital of france _', words: ['capital', 'of', 'france', '_'] }),
      wordSource.getCues({ text: 'aspirin', words: ['aspirin'] }),
    ]);
    const urls = calls.map((c) => c.url).sort();
    assert.ok(urls.some((u) => u.includes('generativelanguage.googleapis.com')), 'expected a gemini URL');
    assert.ok(urls.some((u) => u.includes('openrouter.ai')), 'expected an openrouter URL');
  });

  it('missing API key for resolved provider drops the source (with log)', async () => {
    const logs: string[] = [];
    const { adapter } = captureAdapter();
    const sources = buildSourcesFromConfig(undefined, undefined, {
      httpAdapter: adapter,
      apiKeys: { GROQ_API_KEY: 'groq_k' },                     // no OPENROUTER_API_KEY
      fluidBlank: { provider: 'openrouter', model: 'deepseek/x' },
      enableFluidBlank: true,
      log: (m) => { logs.push(m); },
    });
    assert.strictEqual(sources.length, 0);
    assert.ok(logs.some((l) => l.includes('fluid-blank') && l.includes('OPENROUTER_API_KEY')));
  });

  it('per-cue frontmatter provider overrides the per-feature default', async () => {
    const { adapter, calls } = captureAdapter();
    const config: CuesMdConfig = {
      frontmatter: {},
      sections: {},
      promptConfig: {
        sources: {
          // Gemini override at the per-cue level — outranks word-cues feature default.
          'plain': {
            name: 'plain',
            promptText: 'M.',
            match: '.*',
            priority: 60,
            provider: 'gemini',
            model: 'gemini-3.1-flash-lite',
          },
        },
      },
    };
    const sources = buildSourcesFromConfig(config, undefined, {
      httpAdapter: adapter,
      apiKeys,
      wordCues: { provider: 'openrouter', model: 'deepseek/deepseek-chat-v3.1:free' },
      enableWordCues: true,
    });
    assert.ok(sources.length > 0);
    await sources[0].getCues({ text: 'aspirin', words: ['aspirin'] });
    assert.match(calls[0].url, /generativelanguage\.googleapis\.com/, 'per-cue override should pin gemini');
  });
});

describe('buildSourcesFromConfig — bucket-tier collapse (shared with effective-routing)', () => {
  const GRAMMAR_CONFIG: CuesMdConfig = {
    frontmatter: {},
    sections: {},
    promptConfig: {
      sources: {
        grammar: { name: 'grammar', promptText: 'G.', priority: 50, match: '.*' },
      },
    },
  };

  it('Case A: pinned bucket does NOT inherit the global llm-model', async () => {
    const { adapter, calls } = captureAdapter();
    const sources = buildSourcesFromConfig(GRAMMAR_CONFIG, undefined, {
      httpAdapter: adapter,
      apiKeys: { ...apiKeys, CEREBRAS_API_KEY: 'cb_k' },
      globalProvider: 'groq',
      globalModel: 'llama-groq-only-model',
      cuesBucketProvider: 'cerebras',
      enableWordCues: true,
    });
    await sources[0].getCues({ text: 'hi', words: ['hi'] });
    const body = JSON.parse(calls[0].body);
    // The stale global model must not leak into the pinned bucket —
    // cerebras dispatches with its own default.
    assert.strictEqual(body.model, 'gpt-oss-120b');
    assert.match(calls[0].url, /cerebras/);
  });

  it('Case B: bucket model on an inherited provider is honored (menu-pick fix)', async () => {
    const { adapter, calls } = captureAdapter();
    const sources = buildSourcesFromConfig(GRAMMAR_CONFIG, undefined, {
      httpAdapter: adapter,
      apiKeys,
      globalProvider: 'groq',
      cuesBucketModel: 'openai/gpt-oss-20b', // written by the config menu with cues-llm-provider: inherit
      enableWordCues: true,
    });
    await sources[0].getCues({ text: 'hi', words: ['hi'] });
    const body = JSON.parse(calls[0].body);
    assert.strictEqual(body.model, 'openai/gpt-oss-20b', 'bucket model must not be silently inert');
    assert.match(calls[0].url, /api\.groq\.com/);
  });

  it('bucket model sentinels (default/inherit) fall through to the provider default', async () => {
    const { adapter, calls } = captureAdapter();
    const sources = buildSourcesFromConfig(GRAMMAR_CONFIG, undefined, {
      httpAdapter: adapter,
      apiKeys: { ...apiKeys, CEREBRAS_API_KEY: 'cb_k' },
      cuesBucketProvider: 'cerebras',
      cuesBucketModel: 'default',
      enableWordCues: true,
    });
    await sources[0].getCues({ text: 'hi', words: ['hi'] });
    const body = JSON.parse(calls[0].body);
    assert.strictEqual(body.model, 'gpt-oss-120b', 'literal "default" must never ship as a model name');
  });
});

