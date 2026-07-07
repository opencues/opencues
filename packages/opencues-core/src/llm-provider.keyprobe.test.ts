/**
 * Registry contract for `keyProbe` — the single probe table behind
 * `opencues check-keys` and chrome's boot-time verifyLlmKeyAtBoot.
 * Run: node --test dist/llm-provider.keyprobe.test.js
 *
 * The drift this pins: a new env-keyed HTTP provider added WITHOUT a
 * keyProbe silently skips both surfaces — its key is never verified
 * anywhere, reproducing the hand-synced-table gap the field replaced.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { listProviders } from './llm-provider';

const all = listProviders();
const probeable = all.filter((p) => p.envKeyName && p.transport !== 'cli' && !p.optionalAuth);
const keyless = all.filter((p) => p.transport === 'cli' || p.optionalAuth);

describe('keyProbe registry contract', () => {
  it('every env-keyed HTTP provider declares a keyProbe', () => {
    for (const p of probeable) {
      assert.ok(
        p.keyProbe,
        `${p.id} has an envKeyName but no keyProbe — check-keys and chrome's boot probe will silently skip it`,
      );
    }
  });

  it('INFOSEC F8: the key rides in a header; probe URLs are https with no query string', () => {
    const MARKER = 'sk_probe_secret_marker';
    for (const p of probeable) {
      const probe = p.keyProbe!;
      assert.match(probe.url, /^https:\/\//, `${p.id}: probe must be https`);
      assert.ok(!probe.url.includes('?'), `${p.id}: no query params — keys must never be URL-embedded`);
      const headers = probe.headers(MARKER);
      assert.ok(
        Object.values(headers).some((v) => v.includes(MARKER)),
        `${p.id}: probe headers must carry the API key`,
      );
      assert.ok(probe.listField.length > 0, `${p.id}: listField must name the response array`);
    }
  });

  it('CLI-transport and optional-auth providers deliberately have no probe', () => {
    for (const p of keyless) {
      assert.ok(
        !p.keyProbe,
        `${p.id} is keyless-capable (${p.transport === 'cli' ? 'cli transport' : 'optionalAuth'}) — a keyProbe would false-flag a supported no-key state`,
      );
    }
  });
});
