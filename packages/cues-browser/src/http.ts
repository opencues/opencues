/**
 * cues-browser/http.ts
 *
 * Browser HTTP adapter using fetch.
 */

import { HttpAdapter } from 'cues-core';

/**
 * Configuration for BrowserHttpAdapter.
 */
export interface BrowserHttpAdapterConfig {
  /** Default timeout in ms */
  timeout?: number;

  /** Whether to include credentials */
  credentials?: RequestCredentials;
}

/**
 * Browser HTTP adapter using the Fetch API.
 */
export class BrowserHttpAdapter implements HttpAdapter {
  private config: BrowserHttpAdapterConfig;

  constructor(config: BrowserHttpAdapterConfig = {}) {
    this.config = {
      timeout: 30000,
      credentials: 'omit',
      ...config,
    };
  }

  /**
   * Make a POST request.
   */
  async post(
    url: string,
    body: string,
    headers: Record<string, string>
  ): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.config.timeout
    );

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
        credentials: this.config.credentials,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${response.statusText}\n${text}`);
      }

      return response.text();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Make a GET request.
   */
  async get(url: string, headers: Record<string, string> = {}): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.config.timeout
    );

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
        credentials: this.config.credentials,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${response.statusText}\n${text}`);
      }

      return response.text();
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Convenience function to create a configured HTTP adapter.
 */
export function createHttpAdapter(
  config?: BrowserHttpAdapterConfig
): BrowserHttpAdapter {
  return new BrowserHttpAdapter(config);
}
