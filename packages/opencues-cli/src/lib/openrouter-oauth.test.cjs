// Tests for the OpenRouter PKCE flow. Everything network/browser is
// injected — the "browser" is a local fetch against the loopback
// server, the exchange is a stub. No test leaves the machine.
// Run: node --test src/lib/openrouter-oauth.test.cjs

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const {
  generatePkcePair,
  buildAuthUrl,
  parseCallbackCode,
  exchangeCode,
  runOauthFlow,
  AUTH_URL,
  EXCHANGE_URL,
} = require('./openrouter-oauth.cjs');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

describe('PKCE pair', () => {
  it('S256: challenge is the base64url sha256 of the verifier; fresh per call', () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    assert.notStrictEqual(a.verifier, b.verifier, 'verifier must be fresh per run');
    assert.match(a.verifier, /^[A-Za-z0-9_-]{40,}$/, 'base64url, no padding');
    const expected = crypto.createHash('sha256').update(a.verifier).digest('base64url');
    assert.strictEqual(a.challenge, expected);
  });
});

describe('auth URL', () => {
  it('carries callback_url + S256 challenge — never the verifier', () => {
    const { verifier, challenge } = generatePkcePair();
    const url = new URL(buildAuthUrl('http://127.0.0.1:39999/callback', challenge));
    assert.strictEqual(`${url.origin}${url.pathname}`, AUTH_URL);
    assert.strictEqual(url.searchParams.get('callback_url'), 'http://127.0.0.1:39999/callback');
    assert.strictEqual(url.searchParams.get('code_challenge'), challenge);
    assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(!url.toString().includes(verifier), 'the verifier must never leave the process before the exchange');
  });
});

describe('callback parsing', () => {
  it('extracts code; null for favicon probes / missing code / garbage', () => {
    assert.strictEqual(parseCallbackCode('/callback?code=abc123'), 'abc123');
    assert.strictEqual(parseCallbackCode('/callback'), null);
    assert.strictEqual(parseCallbackCode('/favicon.ico'), null);
    assert.strictEqual(parseCallbackCode('::::'), null);
  });
});

describe('code exchange', () => {
  it('POSTs code + verifier + S256 to the documented endpoint and returns body.key', async () => {
    const calls = [];
    const key = await exchangeCode({
      code: 'the-code',
      verifier: 'the-verifier',
      postJson: async (url, payload) => { calls.push({ url, payload }); return { key: 'sk-or-v1-test' }; },
    });
    assert.strictEqual(key, 'sk-or-v1-test');
    assert.deepStrictEqual(calls, [{
      url: EXCHANGE_URL,
      payload: { code: 'the-code', code_verifier: 'the-verifier', code_challenge_method: 'S256' },
    }]);
  });

  it('throws when the response carries no key field', async () => {
    await assert.rejects(
      exchangeCode({ code: 'c', verifier: 'v', postJson: async () => ({}) }),
      /no key field/,
    );
  });
});

describe('runOauthFlow — end to end against the real loopback server', () => {
  it('browser callback with a code → exchange → resolves the key; page never shows the key', async () => {
    let capturedAuthUrl = null;
    let callbackResponse = null;
    const key = await runOauthFlow({
      timeoutMs: 5000,
      onStatus: () => {},
      exchange: async ({ code, verifier }) => {
        assert.strictEqual(code, 'fake-code');
        assert.ok(verifier.length >= 40);
        return 'sk-or-v1-flow-test';
      },
      // The "browser": immediately hit the loopback callback with a code.
      openBrowser: (authUrl) => {
        capturedAuthUrl = authUrl;
        const cb = new URL(new URL(authUrl).searchParams.get('callback_url'));
        callbackResponse = httpGet(`${cb.origin}${cb.pathname}?code=fake-code`);
        return true;
      },
    });
    assert.strictEqual(key, 'sk-or-v1-flow-test');
    const parsed = new URL(capturedAuthUrl);
    assert.match(parsed.searchParams.get('callback_url'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/, 'loopback bind only');
    const { body: callbackBody } = await callbackResponse;
    assert.ok(callbackBody.includes('close this tab'));
    assert.ok(!callbackBody.includes('sk-or-v1'), 'callback page must never contain key material');
  });

  it('a code-less probe (favicon) does not settle the flow; timeout still fires', async () => {
    await assert.rejects(
      runOauthFlow({
        timeoutMs: 400,
        onStatus: () => {},
        exchange: async () => { throw new Error('exchange must not run without a code'); },
        openBrowser: (authUrl) => {
          const cb = new URL(new URL(authUrl).searchParams.get('callback_url'));
          httpGet(`${cb.origin}/favicon.ico`).catch(() => {});
          return true;
        },
      }),
      /timed out/,
    );
  });

  it('exchange failure rejects the flow (no silent hang)', async () => {
    await assert.rejects(
      runOauthFlow({
        timeoutMs: 5000,
        onStatus: () => {},
        exchange: async () => { throw new Error('HTTP 403 user not logged in'); },
        openBrowser: (authUrl) => {
          const cb = new URL(new URL(authUrl).searchParams.get('callback_url'));
          httpGet(`${cb.origin}${cb.pathname}?code=x`).catch(() => {});
          return true;
        },
      }),
      /403/,
    );
  });
});
