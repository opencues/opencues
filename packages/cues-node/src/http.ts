/**
 * cues-node/http.ts
 *
 * Node.js HTTP adapter using https module.
 */

import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { HttpAdapter } from 'cues-core';

/**
 * Configuration for NodeHttpAdapter.
 */
export interface NodeHttpAdapterConfig {
  /** Default timeout in ms */
  timeout?: number;

  /** Whether to allow self-signed certificates */
  rejectUnauthorized?: boolean;
}

/**
 * Node.js HTTP adapter using the https module.
 */
export class NodeHttpAdapter implements HttpAdapter {
  private config: NodeHttpAdapterConfig;

  constructor(config: NodeHttpAdapterConfig = {}) {
    this.config = {
      timeout: 30000,
      rejectUnauthorized: true,
      ...config,
    };
  }

  /**
   * Make a POST request.
   *
   * @param url - Request URL
   * @param body - Request body
   * @param headers - Request headers
   * @returns Response body as string
   */
  async post(
    url: string,
    body: string,
    headers: Record<string, string>
  ): Promise<string> {
    return this.request('POST', url, body, headers);
  }

  /**
   * Make a GET request.
   *
   * @param url - Request URL
   * @param headers - Request headers
   * @returns Response body as string
   */
  async get(url: string, headers: Record<string, string> = {}): Promise<string> {
    return this.request('GET', url, undefined, headers);
  }

  /**
   * Make an HTTP request.
   */
  private request(
    method: string,
    url: string,
    body?: string,
    headers: Record<string, string> = {}
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';

      const options: https.RequestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers: {
          ...headers,
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        },
        timeout: this.config.timeout,
        rejectUnauthorized: this.config.rejectUnauthorized,
      };

      const lib = isHttps ? https : http;

      const req = lib.request(options, (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8');

          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(responseBody);
          } else {
            reject(
              new Error(
                `HTTP ${res.statusCode}: ${res.statusMessage}\n${responseBody}`
              )
            );
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timeout after ${this.config.timeout}ms`));
      });

      if (body) {
        req.write(body);
      }

      req.end();
    });
  }
}

/**
 * Convenience function to create a configured HTTP adapter.
 */
export function createHttpAdapter(
  config?: NodeHttpAdapterConfig
): NodeHttpAdapter {
  return new NodeHttpAdapter(config);
}
