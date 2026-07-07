/**
 * Tests for pickAutoProvider's zero-key subscription-CLI rung.
 * Run: node --test dist/llm-provider.autofallback.test.js
 *
 * The rung: when NO auto-order env key is present, fall back to
 * claude-code-cli / openai-subscription iff the binary probe says the
 * CLI exists. Probes are injected here — no test shells out.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { pickAutoProvider, SUBSCRIPTION_AUTO_FALLBACK, SUBSCRIPTION_CLI_BINARIES } from './llm-provider';

const NONE = () => false;
const ALL = () => true;
const only = (id: string) => (candidate: string) => candidate === id;

describe('pickAutoProvider — subscription-CLI rung', () => {
  it('any env key wins: the rung is unreachable once a key exists', () => {
    // Adding a key must upgrade the route automatically, no config change.
    assert.strictEqual(pickAutoProvider({ GROQ_API_KEY: 'gsk' }, { isCliAvailable: ALL }), 'groq');
    assert.strictEqual(pickAutoProvider({ CEREBRAS_API_KEY: 'csk' }, { isCliAvailable: ALL }), 'cerebras');
  });

  it('zero keys + claude binary → claude-code-cli', () => {
    assert.strictEqual(pickAutoProvider({}, { isCliAvailable: only('claude-code-cli') }), 'claude-code-cli');
  });

  it('zero keys + only codex binary → openai-subscription', () => {
    assert.strictEqual(pickAutoProvider({}, { isCliAvailable: only('openai-subscription') }), 'openai-subscription');
  });

  it('both binaries → claude first (flagship-host pairing)', () => {
    assert.strictEqual(pickAutoProvider({}, { isCliAvailable: ALL }), 'claude-code-cli');
    assert.deepStrictEqual([...SUBSCRIPTION_AUTO_FALLBACK], ['claude-code-cli', 'openai-subscription']);
  });

  it('zero keys + no binaries → null (the documented silent no-LLM mode)', () => {
    assert.strictEqual(pickAutoProvider({}, { isCliAvailable: NONE }), null);
  });

  it('empty-string key values do not count as keys', () => {
    assert.strictEqual(
      pickAutoProvider({ GROQ_API_KEY: '' }, { isCliAvailable: only('claude-code-cli') }),
      'claude-code-cli',
    );
  });

  it('binary map covers every fallback provider', () => {
    for (const id of SUBSCRIPTION_AUTO_FALLBACK) {
      assert.ok(SUBSCRIPTION_CLI_BINARIES[id], `${id} missing from SUBSCRIPTION_CLI_BINARIES — the probe would look for a binary named "${id}"`);
    }
  });
});
