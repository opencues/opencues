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
     */
    async post(url, body, headers) {
        const https = require('https');
        const u = new URL(url);

        // Apply provider-specific overrides to the request body
        const overrides = this.providerOverrides[u.hostname];
        if (overrides) {
            try {
                const parsed = JSON.parse(body);
                Object.assign(parsed, overrides);
                body = JSON.stringify(parsed);
            } catch (_) {}
        }

        return new Promise((resolve, reject) => {
            try {
                const req = https.request({
                    hostname: u.hostname,
                    path: u.pathname + u.search,
                    method: 'POST',
                    headers,
                    agent: this.agent,
                    timeout: this.config.timeout || DEFAULT_TIMEOUT_MS,
                }, (res) => {
                    let data = '';
                    res.on('data', (chunk) => { data += chunk; });
                    res.on('end', () => { resolve(data); });
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
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
