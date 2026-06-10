/**
 * Tests for model-aliases — the `with <model>` per-call override
 * detector.
 *
 * Run with: node --test dist/model-aliases.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { detectModelOverride, applySubscriptionPreference, stripModelOverride } from './model-aliases';
import { _resetClaudeCliAvailabilityCacheForTesting } from './providers/claude-cli-daemon';

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

describe('applySubscriptionPreference', () => {
  // Each test resets the cache + uses an env-based shim. We don't mock
  // child_process — instead we toggle PATH so `which claude` reflects
  // the test's intent.
  let origPath: string | undefined;
  function withPath(value: string, fn: () => void) {
    origPath = process.env.PATH;
    process.env.PATH = value;
    _resetClaudeCliAvailabilityCacheForTesting();
    try { fn(); } finally {
      process.env.PATH = origPath;
      _resetClaudeCliAvailabilityCacheForTesting();
    }
  }

  it('null input → null output', () => {
    withPath('/usr/bin:/bin', () => {
      assert.strictEqual(applySubscriptionPreference(null), null);
    });
  });

  it('rewrites `with anthropic` to claude-code-cli when claude is on PATH', () => {
    // The real `claude` binary lives somewhere on this dev machine's PATH.
    withPath(process.env.PATH ?? '/usr/bin:/bin', () => {
      const override = detectModelOverride('summarize this with anthropic _');
      assert.ok(override);
      assert.strictEqual(override.provider, 'anthropic');
      const out = applySubscriptionPreference(override);
      assert.ok(out);
      // Either branch is acceptable depending on whether `claude` is
      // on PATH in the test env. We assert structural correctness:
      // if rewritten, provider becomes claude-code-cli; otherwise
      // the override is returned unchanged.
      if (out.provider === 'claude-code-cli') {
        assert.strictEqual(out.matchedToken, 'anthropic');
        assert.ok(out.model.length > 0, 'expected a default model assigned');
      } else {
        assert.strictEqual(out, override, 'CLI unavailable → unchanged');
      }
    });
  });

  it('leaves `with anthropic` unchanged when claude is NOT on PATH', () => {
    withPath('/nonexistent-dir', () => {
      const override = detectModelOverride('summarize this with anthropic _');
      assert.ok(override);
      const out = applySubscriptionPreference(override);
      assert.strictEqual(out, override);
      assert.strictEqual(out!.provider, 'anthropic');
    });
  });

  it('rewrites `with opus` to claude-code-cli when claude is on PATH (preserves model id)', () => {
    withPath(process.env.PATH ?? '/usr/bin:/bin', () => {
      const override = detectModelOverride('summarize this with opus _');
      assert.ok(override);
      assert.strictEqual(override.provider, 'anthropic');
      assert.strictEqual(override.model, 'claude-opus-4-7');
      const out = applySubscriptionPreference(override);
      assert.ok(out);
      if (out.provider === 'claude-code-cli') {
        assert.strictEqual(out.model, 'claude-opus-4-7', 'model string passes through to CLI');
      } else {
        // CLI not on this test runner's PATH — accept fall-through.
        assert.strictEqual(out, override);
      }
    });
  });

  it('rewrites `with fable` (full model id) to claude-code-cli when CLI available', () => {
    withPath(process.env.PATH ?? '/usr/bin:/bin', () => {
      const override = detectModelOverride('summarize this with fable _');
      assert.ok(override);
      assert.strictEqual(override.model, 'claude-fable-5');
      const out = applySubscriptionPreference(override);
      assert.ok(out);
      if (out.provider === 'claude-code-cli') {
        assert.strictEqual(out.model, 'claude-fable-5', 'CLI accepts full id; passes through');
      } else {
        assert.strictEqual(out, override);
      }
    });
  });

  it('rewrites `with claude` (generic alias) to claude-code-cli when CLI available', () => {
    withPath(process.env.PATH ?? '/usr/bin:/bin', () => {
      const override = detectModelOverride('summarize this with claude _');
      assert.ok(override);
      assert.strictEqual(override.provider, 'anthropic');
      const out = applySubscriptionPreference(override);
      assert.ok(out);
      if (out.provider === 'claude-code-cli') {
        // Model defaults to anthropic's default (claude-haiku-4-5-…)
        // which the CLI accepts as a full id.
        assert.ok(out.model.length > 0);
      } else {
        assert.strictEqual(out, override);
      }
    });
  });

  it('does NOT rewrite non-anthropic overrides', () => {
    withPath(process.env.PATH ?? '/usr/bin:/bin', () => {
      for (const token of ['cerebras', 'groq', 'openai', 'gemini', 'openrouter']) {
        const override = detectModelOverride(`do this with ${token} _`);
        assert.ok(override, `expected ${token} to match`);
        const out = applySubscriptionPreference(override);
        assert.strictEqual(out, override, `${token} should be unchanged`);
        assert.notStrictEqual(out!.provider, 'claude-code-cli');
      }
    });
  });

  it('mode: "off" skips the rewrite even when claude is available', () => {
    withPath(process.env.PATH ?? '/usr/bin:/bin', () => {
      for (const token of ['anthropic', 'claude', 'opus', 'sonnet', 'haiku', 'fable']) {
        const override = detectModelOverride(`do this with ${token} _`);
        assert.ok(override, `expected ${token} to match`);
        const out = applySubscriptionPreference(override, 'off');
        assert.strictEqual(out, override, `${token} with mode=off should be unchanged`);
        assert.strictEqual(out!.provider, 'anthropic', `${token} should stay on API`);
      }
    });
  });

  it('mode defaults to "prefer" when omitted', () => {
    withPath(process.env.PATH ?? '/usr/bin:/bin', () => {
      const override = detectModelOverride('do this with anthropic _');
      assert.ok(override);
      // Implicit (no second arg) and explicit 'prefer' must agree.
      const a = applySubscriptionPreference(override);
      const b = applySubscriptionPreference(override, 'prefer');
      assert.strictEqual(a?.provider, b?.provider);
      assert.strictEqual(a?.model, b?.model);
    });
  });

  it('mode: "only" rewrites EVEN WHEN claude is missing from PATH (billing safety)', () => {
    withPath('/nonexistent-dir', () => {
      // `only` skips the availability check — the dispatch will then
      // fail at spawn time, which is the intended billing-safety
      // behaviour (never silently fall through to the paid API).
      for (const token of ['anthropic', 'opus', 'sonnet', 'haiku', 'fable']) {
        const override = detectModelOverride(`do this with ${token} _`);
        assert.ok(override, `expected ${token} to match`);
        const out = applySubscriptionPreference(override, 'only');
        assert.ok(out);
        assert.strictEqual(out.provider, 'claude-code-cli',
          `${token} with mode=only should rewrite to claude-code-cli`);
      }
    });
  });

  it('mode: "only" still leaves non-anthropic overrides alone', () => {
    withPath('/nonexistent-dir', () => {
      for (const token of ['cerebras', 'groq', 'openai', 'gemini']) {
        const override = detectModelOverride(`do this with ${token} _`);
        assert.ok(override, `expected ${token} to match`);
        const out = applySubscriptionPreference(override, 'only');
        assert.strictEqual(out, override, `${token} should be unchanged under mode=only`);
        assert.notStrictEqual(out!.provider, 'claude-code-cli');
      }
    });
  });
});
