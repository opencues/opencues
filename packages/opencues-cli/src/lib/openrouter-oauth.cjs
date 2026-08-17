// lib/openrouter-oauth.cjs — one-click OpenRouter key via OAuth PKCE.
//
// Flow (https://openrouter.ai/docs — OAuth PKCE):
//   1. Start a loopback HTTP server on 127.0.0.1:<ephemeral>.
//   2. Open https://openrouter.ai/auth?callback_url=...&code_challenge=
//      <base64url(sha256(verifier))>&code_challenge_method=S256 in the
//      user's browser.
//   3. User clicks Authorize; OpenRouter redirects to the loopback with
//      ?code=... .
//   4. POST https://openrouter.ai/api/v1/auth/keys
//      { code, code_verifier, code_challenge_method } → { key }.
//   5. Caller stores the key via set-key's writeKey (~/.cues/.env, 0600).
//
// Security posture:
//   - S256 only (never `plain`); fresh 32-byte verifier per run.
//   - Loopback bind is 127.0.0.1 (never 0.0.0.0) — nothing off-machine
//     can reach the callback.
//   - The key rides the exchange RESPONSE over HTTPS; it never appears
//     in a URL, a log line, or the callback response page.
//   - Single-shot: first callback settles the flow; the server closes.
//   - Hard timeout (default 5 min) so an abandoned browser tab can't
//     hang the CLI forever.
//
// Every step is exported + injectable so tests drive the whole flow
// hermetically (fake browser hits the loopback; fake exchange returns a
// canned key). Only runOauthFlow's defaults touch the real network.

'use strict';

const crypto = require('node:crypto');
const { isWsl } = require('./is-wsl.cjs');
const http = require('node:http');
const https = require('node:https');
const { spawn } = require('node:child_process');

const AUTH_URL = 'https://openrouter.ai/auth';
const EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';

/** Fresh PKCE pair: 32-byte base64url verifier + S256 challenge. */
function generatePkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** The browser URL for step 2. */
function buildAuthUrl(callbackUrl, challenge) {
  const u = new URL(AUTH_URL);
  u.searchParams.set('callback_url', callbackUrl);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

/** Extract `code` from the loopback request URL, or null. */
function parseCallbackCode(requestUrl) {
  try {
    const u = new URL(requestUrl, 'http://127.0.0.1');
    return u.searchParams.get('code') || null;
  } catch {
    return null;
  }
}

/** Step 4 — exchange the code for a key. Returns the key string.
 *  `postJson` is injectable for tests; the default does a real HTTPS POST. */
async function exchangeCode({ code, verifier, postJson = defaultPostJson }) {
  const body = await postJson(EXCHANGE_URL, {
    code,
    code_verifier: verifier,
    code_challenge_method: 'S256',
  });
  const key = body && typeof body.key === 'string' ? body.key : null;
  if (!key) throw new Error('OpenRouter exchange succeeded but returned no key field');
  return key;
}

function defaultPostJson(url, payload) {
  return new Promise((resolvePromise, reject) => {
    const data = JSON.stringify(payload);
    const req = https.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'user-agent': 'opencues-cli' },
    }, (res) => {
      let bodyText = '';
      res.on('data', (c) => { bodyText += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          // 403 = not logged in / bad verifier; 400 = challenge-method
          // mismatch (per the docs' error table). Truncate the body —
          // never echo anything that could carry a key.
          return reject(new Error(`OpenRouter exchange failed: HTTP ${res.statusCode} ${String(bodyText).slice(0, 120)}`));
        }
        try { resolvePromise(JSON.parse(bodyText)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

/** Best-effort browser opener. Linux/macOS/WSL; returns true if a
 *  launcher was spawned (NOT a guarantee the browser rendered — the
 *  caller always prints the URL as the manual fallback). */
function openInBrowser(url, spawnImpl = spawn) {
  const candidates = [];
  const onWsl = process.platform === 'linux' && isWsl();
  if (onWsl) {
    candidates.push(['wslview', [url]]);
    candidates.push(['powershell.exe', ['-NoProfile', '-Command', `Start-Process '${url.replace(/'/g, "''")}'`]]);
  } else if (process.platform === 'darwin') {
    candidates.push(['open', [url]]);
  } else {
    candidates.push(['xdg-open', [url]]);
  }
  for (const [cmd, args] of candidates) {
    try {
      const child = spawnImpl(cmd, args, { stdio: 'ignore', detached: true });
      child.on?.('error', () => {});
      child.unref?.();
      return true;
    } catch { /* try next launcher */ }
  }
  return false;
}

/** Tiny HTML shown in the browser tab after the callback lands. No key
 *  material — the key travels only in the exchange response. */
function callbackPage(ok) {
  const msg = ok
    ? 'OpenCues: OpenRouter connected — your key is stored. You can close this tab.'
    : 'OpenCues: authorization was not completed (no code received). Close this tab and re-run opencues set-key openrouter --oauth.';
  return `<!doctype html><meta charset="utf-8"><title>OpenCues</title><body style="font-family:system-ui;margin:4rem auto;max-width:34rem"><p>${msg}</p></body>`;
}

/**
 * Orchestrate the whole flow. Returns the API key string.
 * Injectables (all optional): `openBrowser(url)`, `exchange({code,verifier})`,
 * `onStatus(line)` for progress output, `timeoutMs` (default 300 000).
 */
function runOauthFlow({
  openBrowser = openInBrowser,
  exchange = (args) => exchangeCode(args),
  onStatus = () => {},
  timeoutMs = 300_000,
} = {}) {
  return new Promise((resolvePromise, reject) => {
    const { verifier, challenge } = generatePkcePair();
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Destroy any lingering keep-alive sockets BEFORE close(). Otherwise
      // server.close() only stops accepting new connections and waits for the
      // browser's kept-alive callback socket to end on its own — that open
      // socket keeps the Node event loop alive, so the CLI process never exits
      // back to the shell after a successful auth (the reported hang).
      server.closeAllConnections?.();
      server.close();
      fn(value);
    };

    const server = http.createServer((req, res) => {
      const code = parseCallbackCode(req.url || '');
      // `connection: close` so the browser tears the socket down after this
      // one response instead of holding it keep-alive — belt to closeAllConnections'
      // braces (and covers Node < 18.2 where closeAllConnections is absent).
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'connection': 'close' });
      res.end(callbackPage(!!code));
      if (!code) return; // favicon probes etc. — keep waiting
      onStatus('authorization received — exchanging for an API key…');
      exchange({ code, verifier })
        .then((key) => finish(resolvePromise, key))
        .catch((err) => finish(reject, err));
    });

    // 127.0.0.1 explicitly — never a wildcard bind.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const callbackUrl = `http://127.0.0.1:${port}/callback`;
      const authUrl = buildAuthUrl(callbackUrl, challenge);
      const opened = openBrowser(authUrl);
      onStatus(opened
        ? 'browser opened — approve the request on openrouter.ai'
        : 'could not open a browser automatically');
      onStatus(`if nothing opened, visit:\n  ${authUrl}`);
    });
    server.on('error', (err) => finish(reject, err));

    const timer = setTimeout(
      () => finish(reject, new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser authorization`)),
      timeoutMs,
    );
  });
}

module.exports = {
  generatePkcePair,
  buildAuthUrl,
  parseCallbackCode,
  exchangeCode,
  openInBrowser,
  runOauthFlow,
  AUTH_URL,
  EXCHANGE_URL,
};
