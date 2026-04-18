// Fetch-based HttpAdapter for cues-core's Resolver.
//
// Works on every host that has globalThis.fetch — Node 18+ ships it
// natively, browsers have always had it. Replaces the per-host adapters
// (chrome's FetchHttpAdapter, opencode's NodeHttpAdapter wrapper) with
// one shared implementation.
//
// Hosts that need a different transport (Node http2, fetch with custom
// agents, mock for tests) can still implement HttpAdapter themselves.

import type { HttpAdapter } from 'cues-core';

export class FetchHttpAdapter implements HttpAdapter {
  async post(url: string, body: string, headers: Record<string, string>): Promise<string> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.text();
  }

  async get(url: string, headers?: Record<string, string>): Promise<string> {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.text();
  }
}
