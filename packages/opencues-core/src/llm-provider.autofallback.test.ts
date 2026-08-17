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
import {
  defaultCliAvailable,
  listProviders,
  pickAutoProvider,
  SUBSCRIPTION_AUTO_FALLBACK,
  SUBSCRIPTION_CLI_BINARIES,
  subscriptionCliBinary,
} from './llm-provider';

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

/**
 * `transport: 'cli'` says only "this provider owns its dispatch". It does
 * NOT say "a binary of the same name is on PATH" — `harness` is bound
 * in-process by the running host. The two were conflated by an
 * `?? providerId` fallback that read as accommodating and behaved as a
 * landmine: doctor probed for a `harness` executable, found none, and
 * told the user to install one.
 */
describe('subscriptionCliBinary — binary-backed vs host-bound', () => {
  it('answers null for a CLI-transport provider with no binary', () => {
    assert.strictEqual(subscriptionCliBinary('harness'), null);
    assert.strictEqual(subscriptionCliBinary('claude-code-cli'), 'claude');
  });

  it('never invents a binary name from the provider id', () => {
    // The whole bug in one assertion: any unmapped id must answer null
    // rather than echoing itself back as an executable to go look for.
    assert.strictEqual(subscriptionCliBinary('some-future-provider'), null);
  });

  it('defaultCliAvailable is false for a host-bound provider, whatever PATH holds', () => {
    // Not "false because the binary is missing" — false because the
    // question is about the host process, and PATH cannot answer it.
    assert.strictEqual(defaultCliAvailable('harness'), false);
  });

  it('every CLI-transport provider is either mapped to a binary or host-bound', () => {
    // Guards the third state: a binary-backed provider that nobody added
    // to the map would silently become "host-bound, nothing to install".
    const HOST_BOUND = new Set(['harness']);
    for (const p of listProviders().filter(p => p.transport === 'cli')) {
      const bin = subscriptionCliBinary(p.id);
      assert.ok(
        bin || HOST_BOUND.has(p.id),
        `${p.id} is CLI-transport with no binary and is not declared host-bound — add it to SUBSCRIPTION_CLI_BINARIES, or to HOST_BOUND here if its dispatch really is bound in-process`,
      );
    }
  });
});
