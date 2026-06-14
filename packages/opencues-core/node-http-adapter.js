"use strict";
/**
 * @opencues/core/node-http-adapter
 *
 * Built-in Node.js HTTP adapter with keep-alive and provider-specific config.
 * Eliminates the need for callers to build their own httpAdapter.
 *
 * WHY THIS LIVES AT THE PACKAGE ROOT (not src/, not dist/):
 *
 * Hand-written CommonJS. tsc doesn't see it, so it never lands in dist/
 * via the normal build path. Consumers import it as
 * `@opencues/core/node-http-adapter` — Node resolves that to this file at
 * the package root via the standard bare-specifier walk.
 *
 * Every integration's setup.sh explicitly copies this file when assembling
 * the in-fork @opencues/core install (see oc/REPAIR.md § LF-7 for the
 * incident that established the pattern). The chrome bundle replaces it
 * with a throwing stub at esbuild time (src/stubs/node-http-adapter-stub.ts)
 * because the browser has no Node https module.
 *
 * Don't move this to src/ + compile via tsc — the bare-specifier import
 * path is load-bearing across resolver.ts, agent-rewrite.ts, and four
 * integrations. Re-pathing means a coordinated change across all of them.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NodeHttpAdapter = void 0;

/**
 * Node.js HTTP adapter with HTTPS keep-alive and optional provider config.
 */
// Default timeout for a single LLM HTTP call. 30s was the original
// default (June 2025); reduced to 15s in June 2026 after opencode-zen
// free pool silent-hang regressions left users staring at `_` for
// 30+ seconds with no log. 15s is still generous — every shipping
// provider returns a real response well under 5s for typical
// blank-sized prompts. Tighter values risked false-positive
// timeouts on cold-start latency from slower providers; 15s leaves
// 3x headroom over the slowest observed legitimate response.
// Override via `new NodeHttpAdapter({ timeout: ms })` for batch /
// long-running calls (none in the runtime today; benches set their
// own).
const DEFAULT_TIMEOUT_MS = 15000;

// Hosts where the adapter unconditionally gzips request bodies and adds
// `Content-Encoding: gzip`. Bench evidence (June 2026, N=20 per cell):
// FUSED_SYSTEM-bearing payloads shrink 86KB → 27KB (-68%), saving
// -100ms median + -179ms p95 on TransformBlank. Word-cue + AgentRewrite
// payloads are small (1-3KB) but their p95 still tightens by -150 to
// -332ms. Median impact on small payloads is noise (±10ms); p95 wins
// alone justify ungated application. Chrome's FetchHttpAdapter doesn't
// gzip (browser fetch can't auto-encode the request body cleanly).
// See docs/architecture/cerebras.md § "Payload optimization (gzip)".
const GZIP_REQUEST_HOSTS = new Set([
    'api.cerebras.ai',
]);

class NodeHttpAdapter {
    constructor(config = {}) {
        this.config = config;
        const https = require('https');
        this.agent = new https.Agent({
            keepAlive: true,
            maxSockets: config.maxSockets || 2,
            timeout: config.timeout || DEFAULT_TIMEOUT_MS,
        });
        // Provider-specific overrides (e.g., Groq reasoning_effort)
        this.providerOverrides = config.providerOverrides || {};
    }

    /**
     * Warm the connection pool by making a lightweight GET request.
     * Call this at startup for faster first real request.
     */
    warmup(url, headers = {}) {
        const https = require('https');
        try {
            const u = new URL(url);
            const req = https.request({
                hostname: u.hostname,
                path: u.pathname || '/',
                method: 'GET',
                agent: this.agent,
                headers,
            }, (res) => { res.resume(); });
            req.on('error', () => {});
            req.end();
        } catch (_) {}
    }

    /**
     * Make a POST request with keep-alive and provider overrides.
     *
     * `options.signal` (AbortSignal) — when triggered, the in-flight
     * request is destroyed and the promise rejects with an AbortError-
     * shaped error. Used by the resolver to cancel stale LLM calls
     * when a newer keystroke supersedes the in-flight one.
     */
    async post(url, body, headers, options) {
        const https = require('https');
        const u = new URL(url);
        const signal = options && options.signal;

        // Pre-aborted signal: reject immediately without touching the network.
        if (signal && signal.aborted) {
            const err = new Error('aborted');
            err.name = 'AbortError';
            return Promise.reject(err);
        }

        // Apply provider-specific overrides to the request body
        const overrides = this.providerOverrides[u.hostname];
        if (overrides) {
            try {
                const parsed = JSON.parse(body);
                Object.assign(parsed, overrides);
                body = JSON.stringify(parsed);
            } catch (_) {}
        }

        // Gzip request body for hosts that accept Content-Encoding: gzip
        // (cerebras today). Saves wire bytes on FUSED_SYSTEM-bearing
        // payloads + tightens p95 across every cerebras source. Header
        // injection is non-mutating on the caller's headers object.
        let wireHeaders = headers;
        if (GZIP_REQUEST_HOSTS.has(u.hostname)) {
            try {
                const zlib = require('zlib');
                const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
                body = zlib.gzipSync(buf);
                wireHeaders = Object.assign({}, headers, { 'Content-Encoding': 'gzip', 'Content-Length': body.length });
            } catch (_) {
                // zlib failure (shouldn't happen on node) — fall through
                // with the plain body. Cerebras decompression layer is
                // optional, so this won't break the call.
            }
        }

        return new Promise((resolve, reject) => {
            try {
                const req = https.request({
                    hostname: u.hostname,
                    path: u.pathname + u.search,
                    method: 'POST',
                    headers: wireHeaders,
                    agent: this.agent,
                    timeout: this.config.timeout || DEFAULT_TIMEOUT_MS,
                }, (res) => {
                    let data = '';
                    res.on('data', (chunk) => { data += chunk; });
                    res.on('end', () => { resolve(data); });
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                // Wire signal AFTER req is created so destroy() targets
                // the right object. The listener is one-shot — once
                // aborted, the request is gone.
                let onAbort = null;
                if (signal) {
                    onAbort = () => {
                        const err = new Error('aborted');
                        err.name = 'AbortError';
                        try { req.destroy(err); } catch (_) {}
                        reject(err);
                    };
                    signal.addEventListener('abort', onAbort, { once: true });
                    // Detach the listener once the request settles so we
                    // don't leak handlers when the resolve-generation's
                    // controller is held past this request's lifetime.
                    const detach = () => signal.removeEventListener('abort', onAbort);
                    req.on('close', detach);
                }
                req.write(body);
                req.end();
            } catch (e) {
                reject(e);
            }
        });
    }

    /**
     * Destroy the agent and close all connections.
     */
    destroy() {
        if (this.agent) {
            this.agent.destroy();
        }
    }
}

exports.NodeHttpAdapter = NodeHttpAdapter;
