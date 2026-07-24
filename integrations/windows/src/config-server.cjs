'use strict';

// ─── Config server — the daemon's HTTP surface for the shared popup ──────
//
// Serves the SAME settings/keys UI the chrome extension uses (the popup
// component, refactored behind a host port), backed by the native config
// files every OpenCues host reads:
//
//   keys      → <cuesHome>/.env         (GROQ_API_KEY=… etc.)
//   settings  → <cuesHome>/OPENCUES.md  (llm-provider:, *-llm-model:, …)
//
// The popup's http adapter (integrations/chrome/src/adapters/
// http-config-adapter.ts) fetches these endpoints; chrome's adapter hits
// chrome.storage instead. One component, two backends.
//
// Bound to 127.0.0.1 only. Same-user localhost posture (like every
// desktop app's local settings server). `/api/keys` returns RAW key
// values for the same-origin popup's input pre-fill.
//
// SECURITY — this server is reachable by any process (and any web page)
// that can open an HTTP connection to loopback, so binding to 127.0.0.1
// is NOT sufficient on its own: a browser is a confused deputy any
// website can pilot into loopback. The ONLY legitimate client is the
// popup this very server serves (same-origin — see
// integrations/chrome/src/adapters/http-config-adapter.ts, all requests
// are same-origin relative). Therefore:
//   1. NO CORS headers are sent — a cross-origin page cannot read any
//      response (the browser's default same-origin policy blocks it).
//   2. The `Host` header must be a loopback name (defeats DNS-rebinding,
//      where evil.com resolves to 127.0.0.1 but the browser still sends
//      `Host: evil.com`).
//   3. Any request carrying a non-loopback `Origin` is refused (defeats
//      a cross-site fetch/POST regardless of CORS).
// Removing any of these re-opens drive-by API-key theft: a fixed,
// guessable port + wildcard CORS let any visited web page exfiltrate
// every LLM provider key. See docs/architecture/security-audit.md.

const http = require('http');
const fs = require('fs');
const path = require('path');

// Loopback hostnames the `Host` / `Origin` headers may name. A request
// naming anything else is not a genuine same-origin call to this server.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Host-header allow-list: loopback name only, and (when a port is given)
 *  it must be this server's port. Defeats DNS-rebinding. */
function hostHeaderIsLoopback(req, port) {
  const raw = String(req.headers.host || '');
  // Split host:port, tolerating the bracketed IPv6 form ([::1]:port).
  const m = raw.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!m) return false;
  if (!LOOPBACK_HOSTS.has(m[1].toLowerCase())) return false;
  if (m[2] && Number(m[2]) !== port) return false;
  return true;
}

/** Origin check: a same-origin GET omits Origin entirely (allowed); any
 *  Origin that IS present must be a loopback origin. A cross-site page's
 *  fetch always sends its own Origin, and an opaque origin sends the
 *  literal string "null" — both refused. */
function originIsLoopback(req) {
  const o = req.headers.origin;
  if (o === undefined) return true;   // same-origin GET / non-CORS request
  try { return LOOPBACK_HOSTS.has(new URL(o).hostname.toLowerCase()); }
  catch { return false; }             // "null" and any unparseable Origin
}

/** The single trust gate for every request. */
function isTrustedLocalRequest(req, port) {
  return hostHeaderIsLoopback(req, port) && originIsLoopback(req);
}

// Env-var name ↔ provider id. Mirrors popup PROVIDER_DEFAULTS + the CLI
// set-key providerMap. Kept in one place here for the server's read/write.
const PROVIDER_ENV = {
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};
const KEY_ENVS = Object.values(PROVIDER_ENV);

// ─── .env read/write (mirrors set-key.cjs) ───────────────────────────────
function readEnv(envPath) {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(envPath, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
function writeEnvKeys(envPath, keys) {
  let text = '';
  try { text = fs.readFileSync(envPath, 'utf8'); } catch { text = ''; }
  const lines = text.length ? text.split('\n') : [];
  for (const [name, valueRaw] of Object.entries(keys)) {
    // A key is one `NAME=value` line; strip CR/LF so a value can never
    // inject additional .env lines (defence-in-depth behind the trust gate).
    const value = String(valueRaw || '').replace(/[\r\n]+/g, '').trim();
    const idx = lines.findIndex((l) => new RegExp(`^\\s*${name}\\s*=`).test(l));
    if (!value) { if (idx >= 0) lines.splice(idx, 1); continue; }   // empty = delete
    const entry = `${name}=${value}`;
    if (idx >= 0) lines[idx] = entry; else lines.push(entry);
  }
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, lines.filter((l, i) => !(l === '' && i === lines.length - 1)).join('\n') + '\n', { mode: 0o600 });
}
function fingerprint(v) {
  if (!v) return '';
  return v.length > 12 ? `${v.slice(0, 8)}…${v.slice(-4)}` : `${v.length}-char short key`;
}

// ─── OPENCUES.md scalar read/write (mirrors opencues-md.cjs) ─────────────
function frontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : '';
}
function readScalar(mdPath, scalar) {
  let md = '';
  try { md = fs.readFileSync(mdPath, 'utf8'); } catch { return null; }
  const fm = frontmatter(md);
  const m = fm.match(new RegExp(`^${scalar}:\\s*(.*)$`, 'm'));
  return m ? m[1].trim() : null;
}
function writeScalar(mdPath, scalar, value) {
  let md = '';
  try { md = fs.readFileSync(mdPath, 'utf8'); } catch { md = ''; }
  if (!/^---\n[\s\S]*?\n---/.test(md)) {
    md = `---\n${scalar}: ${value}\n---\n${md}`;
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, md);
    return;
  }
  const line = new RegExp(`^(${scalar}:).*$`, 'm');
  if (line.test(md)) md = md.replace(line, `$1 ${value}`);
  else md = md.replace(/^---\n/, `---\n${scalar}: ${value}\n`);
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.writeFileSync(mdPath, md);
}

// Provider defaults (endpoint) so a provider switch fills apiUrl the way
// the popup expects. Endpoint only — models come from the popup's own
// PROVIDER_DEFAULTS (bench-validated list stays client-side).
const PROVIDER_ENDPOINT = {
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  cerebras: 'https://api.cerebras.ai/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
};

/**
 * Start the config HTTP server.
 * @param {object} opts
 * @param {string} opts.cuesHome    resolved config dir
 * @param {string} opts.bind        default 127.0.0.1
 * @param {number} opts.port        config port
 * @param {string} [opts.uiDir]     dir holding popup.{html,css,js}; when
 *                                  absent, only the /api is served
 * @param {() => object} opts.status  live status provider (connected, app, runtimeKeys)
 * @param {(l,m,d?)=>void} opts.log
 */
function startConfigServer(opts) {
  const cuesHome = opts.cuesHome;
  const envPath = path.join(cuesHome, '.env');
  const mdPath = path.join(cuesHome, 'OPENCUES.md');
  const log = opts.log || (() => {});

  function readConfig() {
    const env = readEnv(envPath);
    const keys = {};
    for (const envName of KEY_ENVS) {
      // process.env wins (a shell export), else the .env file — same
      // precedence buildBootApiKeys uses.
      const v = process.env[envName] || env[envName] || '';
      keys[envName] = fingerprint(v);
    }
    const provider = readScalar(mdPath, 'llm-provider') || '';
    const model = readScalar(mdPath, 'cues-llm-model')
      || readScalar(mdPath, 'blanks-llm-model') || '';
    const ttsRate = readScalar(mdPath, 'tts-rate');
    return {
      provider,
      model,
      apiUrl: provider && PROVIDER_ENDPOINT[provider] ? PROVIDER_ENDPOINT[provider] : '',
      keys,                                   // fingerprints only
      ttsRate: ttsRate ? Number(ttsRate) : 2,
      // chrome-only fields — returned as harmless defaults so the shared
      // popup renders without special-casing the host.
      targetSelector: '[contenteditable="true"]',
      deferToChromeHost: false,
      ttsEnabled: false,
      dimMix: 0.45,
    };
  }

  // A scalar is a SINGLE frontmatter line; a value carrying a newline
  // would inject extra scalars into OPENCUES.md. Strip CR/LF (and cap
  // length) so a write can only ever set the one intended scalar —
  // defence-in-depth behind the same-origin trust gate.
  const sanitizeScalar = (v) => String(v).replace(/[\r\n]+/g, ' ').trim().slice(0, 200);

  function writeConfig(body) {
    // Keys → .env (full values; empty deletes).
    if (body.keys && typeof body.keys === 'object') {
      const toWrite = {};
      for (const [name, val] of Object.entries(body.keys)) {
        if (KEY_ENVS.includes(name)) toWrite[name] = val;
      }
      if (Object.keys(toWrite).length) writeEnvKeys(envPath, toWrite);
    }
    // Settings → OPENCUES.md.
    if (typeof body.provider === 'string' && body.provider) {
      writeScalar(mdPath, 'llm-provider', sanitizeScalar(body.provider));
    }
    if (typeof body.model === 'string' && body.model) {
      // One model choice applies across every bucket, matching the
      // popup's single-model mental model.
      const model = sanitizeScalar(body.model);
      for (const s of ['cues-llm-model', 'blanks-llm-model', 'auditors-llm-model']) {
        writeScalar(mdPath, s, model);
      }
    }
    if (body.ttsRate != null && Number.isFinite(Number(body.ttsRate))) {
      writeScalar(mdPath, 'tts-rate', String(body.ttsRate));
    }
  }

  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];

    // Trust gate — refuse anything that isn't a genuine same-origin call
    // to this loopback server (see the SECURITY note at the top of this
    // file). No CORS headers are ever sent: the sole legitimate client is
    // the same-origin popup, so a cross-origin page is blocked by the
    // browser's default same-origin policy and, belt-and-braces, refused
    // here by Host/Origin. This is what stops drive-by API-key theft.
    if (!isTrustedLocalRequest(req, opts.port)) {
      log('warn', 'config-server refused non-local request', { host: req.headers.host, origin: req.headers.origin, url });
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden');
      return;
    }
    // Same-origin requests never trigger a CORS preflight, so any OPTIONS
    // that reaches us is cross-origin — refuse it (no CORS to grant).
    if (req.method === 'OPTIONS') { res.writeHead(403); res.end(); return; }

    try {
      if (url === '/api/config' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(readConfig()));
        return;
      }
      if (url === '/api/keys' && req.method === 'GET') {
        // REAL key values, for the popup's input pre-fill + client-side
        // provider probe. Reachable ONLY by the same-origin popup (trust
        // gate above) — no wider exposure than the ~/.cues/.env file the
        // user already owns. Mirrors what chrome.storage returns to the
        // chrome popup.
        const env = readEnv(envPath);
        const out = {};
        for (const envName of KEY_ENVS) {
          const v = process.env[envName] || env[envName];
          if (v) out[envName] = v;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
        return;
      }
      if (url === '/api/config' && req.method === 'POST') {
        let raw = '';
        req.on('data', (d) => { raw += d; if (raw.length > 1e6) req.destroy(); });
        req.on('end', () => {
          try {
            writeConfig(JSON.parse(raw || '{}'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, config: readConfig() }));
          } catch (err) {
            log('warn', 'config POST failed', err);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          }
        });
        return;
      }
      if (url === '/api/status' && req.method === 'GET') {
        const st = (opts.status && opts.status()) || {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...st, cuesHome }));
        return;
      }
      // Static popup assets.
      if (opts.uiDir && (req.method === 'GET')) {
        const rel = url === '/' ? 'popup.html' : url.replace(/^\/+/, '');
        const file = path.join(opts.uiDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
        if (file.startsWith(opts.uiDir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          const ext = path.extname(file).toLowerCase();
          const type = ext === '.html' ? 'text/html'
            : ext === '.css' ? 'text/css'
            : ext === '.js' ? 'text/javascript'
            : 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': type });
          res.end(fs.readFileSync(file));
          return;
        }
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
    } catch (err) {
      log('error', 'config-server handler threw', err);
      try { res.writeHead(500); res.end('error'); } catch {}
    }
  });

  server.on('error', (err) => log('warn', 'config-server error', err));
  server.listen(opts.port, opts.bind || '127.0.0.1', () => {
    log('info', 'config server listening', { bind: opts.bind || '127.0.0.1', port: opts.port, uiDir: opts.uiDir || '(api only)' });
  });
  return server;
}

module.exports = { startConfigServer, PROVIDER_ENV, KEY_ENVS };
